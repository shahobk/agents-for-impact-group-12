"""FastAPI service for Pantry Relay matching and rescue workflow."""

from __future__ import annotations

import asyncio
import copy
from datetime import datetime, timedelta, timezone
import logging
from pathlib import Path
import re
import secrets
import threading
import time
from typing import Any, Literal, Mapping
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .agent import MatcherUnavailableError, match_surplus_offer, root_agent
from .auth import AuthorizationError, TokenAuthority
from .config import settings
from .equity import run_bigquery_equity_audit
from .intake import (
    IntakeError,
    IntakeInterpreter,
    build_gemini_photo_provider,
)
from .locations import (
    LocationError,
    LocationService,
    RouteEstimator,
    build_google_geocoder,
    build_google_routes_provider,
    within_atlanta_service_area,
)
from .repository import FirestoreWorkflowRepository, InMemoryWorkflowRepository
from .proof import check_agent_dependencies
from .runtime import AgentRuntimeUnavailable, match_offer_via_root_agent, run_root_agent
from .tasks import CloudTasksScheduler, InMemoryTaskScheduler, TaskOidcVerifier
from .workflow import WorkflowError, WorkflowService

logger = logging.getLogger(__name__)


class MatchRequest(BaseModel):
    """Validated coordinator input for the compatibility matcher endpoint."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    description: str = Field(min_length=3, max_length=4_000)
    quantity_pallets: float = Field(gt=0, le=1_000)
    storage_state: Literal["ambient", "refrigerated", "frozen"]
    pickup_deadline: datetime
    donor_latitude: float = Field(ge=-90, le=90)
    donor_longitude: float = Field(ge=-180, le=180)
    split_allowed: bool = False

    @model_validator(mode="before")
    @classmethod
    def accept_documented_input_aliases(cls, value: Any) -> Any:
        if not isinstance(value, Mapping):
            return value
        data = dict(value)
        if "quantity_pallets" not in data:
            data["quantity_pallets"] = data.get("quantity", data.get("pallet_estimate"))
        data.pop("quantity", None)
        data.pop("pallet_estimate", None)
        coordinates = data.pop("donor_coordinates", None)
        if isinstance(coordinates, Mapping):
            data.setdefault("donor_latitude", coordinates.get("latitude"))
            data.setdefault("donor_longitude", coordinates.get("longitude"))
        if "donor_latitude" not in data and "donor_lat" in data:
            data["donor_latitude"] = data["donor_lat"]
        if "donor_longitude" not in data and "donor_lon" in data:
            data["donor_longitude"] = data["donor_lon"]
        data.pop("donor_lat", None)
        data.pop("donor_lon", None)
        data.pop("pickup_location", None)
        return data

    @field_validator("pickup_deadline")
    @classmethod
    def deadline_requires_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("pickup_deadline must include a timezone offset")
        return value

    @model_validator(mode="after")
    def atlanta_service_area(self) -> "MatchRequest":
        if not within_atlanta_service_area(
            self.donor_latitude, self.donor_longitude
        ):
            raise ValueError("donor coordinates must be within the Atlanta service area")
        return self


class MatchResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    selected: dict[str, Any] | None = None
    fallbacks: list[dict[str, Any]] = Field(default_factory=list)
    rejections: list[dict[str, Any]] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    outreach: str | None = None


class OfferCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    description: str = Field(min_length=3, max_length=4_000)
    quantity_original: str | None = Field(default=None, max_length=300)
    quantity_pallets: float = Field(gt=0, le=1_000)
    storage_state: Literal["ambient", "refrigerated", "frozen"]
    pickup_deadline: datetime
    donor_latitude: float = Field(ge=-90, le=90)
    donor_longitude: float = Field(ge=-180, le=180)
    pickup_address: str = Field(default="", max_length=500)
    location_source: Literal["gps", "address", "corrected_pin"] = "corrected_pin"
    transport_mode: Literal["recipient_pickup", "donor_delivery", "transportation_needed"] = "recipient_pickup"
    donor_delivery_radius_km: float | None = Field(default=None, gt=0, le=5)

    @field_validator("pickup_deadline")
    @classmethod
    def timezone_required(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("pickup_deadline must include a timezone offset")
        return value

    @model_validator(mode="after")
    def atlanta_service_area(self) -> "OfferCreateRequest":
        if not within_atlanta_service_area(
            self.donor_latitude, self.donor_longitude
        ):
            raise ValueError("donor coordinates must be within the Atlanta service area")
        return self


class DeclineRequest(BaseModel):
    reason: str = Field(default="", max_length=500)


class ConfirmRequest(BaseModel):
    expected_handoff_time: datetime
    contact_name: str = Field(min_length=1, max_length=200)
    contact_phone: str = Field(min_length=3, max_length=80)
    transport_mode: Literal["recipient_pickup", "donor_delivery"] | None = None

    @field_validator("expected_handoff_time")
    @classmethod
    def timezone_required(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("expected_handoff_time must include a timezone offset")
        return value


class CompleteRequest(BaseModel):
    actual_quantity_pallets: float | None = Field(default=None, gt=0)
    note: str = Field(default="", max_length=1_000)


class OpsActionRequest(BaseModel):
    reason: str = Field(default="", max_length=500)
    transport_mode: Literal["recipient_pickup", "donor_delivery"] | None = None
    donor_delivery_radius_km: float | None = Field(default=None, gt=0, le=5)


class AdvanceTaskRequest(BaseModel):
    offer_id: str
    kind: Literal["reservation", "wave", "noop"]
    reservation_id: str | None = None
    lease_version: int | None = None
    wave_version: int | None = None


class AgentRunRequest(BaseModel):
    prompt: str = Field(min_length=3, max_length=8_000)


class IntakePhotoRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    mime_type: str = Field(min_length=3, max_length=100)
    data_base64: str = Field(min_length=4, max_length=8_000_000)


class IntakeExtractRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    text: str = Field(default="", max_length=4_000)
    transcript: str = Field(default="", max_length=4_000)
    photo: IntakePhotoRequest | None = None
    now: datetime | None = None

    @field_validator("now")
    @classmethod
    def now_requires_timezone(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("now must include a timezone offset")
        return value


class GeocodeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    address: str = Field(min_length=3, max_length=500)


def _normalize_response(result: Mapping[str, Any]) -> dict[str, Any]:
    data = dict(result)
    return {
        "selected": data.get("selected", data.get("best", data.get("match"))),
        "fallbacks": data.get("fallbacks", data.get("alternatives", [])) or [],
        "rejections": data.get("rejections", data.get("rejected", [])) or [],
        "warnings": [str(item) for item in (data.get("warnings", []) or [])],
        "outreach": data.get("outreach", data.get("outreach_message")),
    }


def _build_repository() -> Any:
    if settings.repository_backend == "firestore":
        return FirestoreWorkflowRepository(
            project=settings.google_cloud_project,
            database=settings.firestore_database,
            collection=settings.firestore_state_collection,
        )
    return InMemoryWorkflowRepository()


def _build_scheduler() -> Any:
    required = (
        settings.google_cloud_project,
        settings.cloud_tasks_callback_url,
        settings.cloud_tasks_service_account,
        settings.task_oidc_audience,
    )
    if settings.repository_backend == "firestore" and all(required):
        return CloudTasksScheduler(
            project=settings.google_cloud_project or "",
            location=settings.cloud_tasks_location,
            queue=settings.cloud_tasks_queue,
            callback_url=settings.cloud_tasks_callback_url or "",
            service_account_email=settings.cloud_tasks_service_account or "",
            audience=settings.task_oidc_audience or "",
        )
    return InMemoryTaskScheduler()


repository = _build_repository()
scheduler = _build_scheduler()
token_authority = TokenAuthority(settings.token_pepper, settings.coordinator_token)
route_provider = (
    build_google_routes_provider(
        project=settings.google_cloud_project,
        timeout_seconds=settings.maps_timeout_seconds,
    )
    if settings.enable_google_routes
    else None
)
workflow = WorkflowService(
    repository,
    token_authority,
    scheduler,
    # Offer creation must traverse root_agent -> match_surplus_offer through an
    # ADK Runner. The direct matcher remains the compatibility /api/match path.
    matcher=match_offer_via_root_agent if settings.workflow_matcher_enabled else None,
    route_estimator=RouteEstimator(route_provider),
    demo_mode=settings.demo_mode,
    demo_fallback=settings.workflow_demo_fallback,
    hold_minutes=settings.hold_minutes,
    response_window_minutes=settings.response_window_minutes,
)
task_verifier = TaskOidcVerifier(
    settings.task_oidc_audience,
    settings.cloud_tasks_service_account,
    settings.task_local_secret,
)
photo_provider = (
    build_gemini_photo_provider(
        project=settings.google_cloud_project,
        location=settings.cloud_tasks_location,
        model=settings.photo_intake_model,
    )
    if settings.enable_photo_intake
    else None
)
intake_interpreter = IntakeInterpreter(
    photo_provider=photo_provider,
    max_photo_bytes=settings.max_photo_bytes,
)
geocode_provider = (
    build_google_geocoder(
        project=settings.google_cloud_project,
        timeout_seconds=settings.maps_timeout_seconds,
    )
    if settings.enable_google_geocoding
    else None
)
location_service = LocationService(geocode_provider)


class TokenBucketRateLimiter:
    def __init__(self, *, capacity: int = 30, refill_per_second: float = 0.5) -> None:
        self.capacity = float(capacity)
        self.refill_per_second = refill_per_second
        self._buckets: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, *, now: float | None = None) -> bool:
        at = time.monotonic() if now is None else now
        with self._lock:
            tokens, updated = self._buckets.get(key, (self.capacity, at))
            tokens = min(
                self.capacity,
                tokens + max(0.0, at - updated) * self.refill_per_second,
            )
            allowed = tokens >= 1
            self._buckets[key] = (tokens - 1 if allowed else tokens, at)
            return allowed


paid_rate_limiter = TokenBucketRateLimiter()
_PAID_PUBLIC_PATHS = {
    "/api/intake/extract",
    "/api/locations/geocode",
    "/api/match",
    "/api/offers",
}
_MAX_PUBLIC_REQUEST_BYTES = 8_500_000
_REQUEST_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_equity_cache: dict[str, Any] = {}
_equity_cache_lock = asyncio.Lock()
_EQUITY_CACHE_SECONDS = 30 * 60
_DEMO_SESSION_COOKIE = "pantry_relay_demo_session"


app = FastAPI(
    title="Pantry Relay API",
    version="2.0.0",
    description="Atlanta grocery rescue matching and atomic handoff workflow.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_allow_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Idempotency-Key", "X-Request-ID"],
    expose_headers=["X-Request-ID"],
)


def _harden_response(response: Response, request_id: str) -> Response:
    """Apply browser-facing security policy consistently, including errors."""
    response.headers["X-Request-ID"] = request_id
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
        "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    )
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = (
        "geolocation=(self), microphone=(self), camera=()"
    )
    return response


@app.middleware("http")
async def request_safety_middleware(request: Request, call_next):
    supplied = request.headers.get("X-Request-ID", "")
    request_id = supplied if _REQUEST_ID.fullmatch(supplied) else uuid4().hex
    request.state.request_id = request_id
    started = time.monotonic()
    if request.method == "POST" and request.url.path in _PAID_PUBLIC_PATHS:
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > _MAX_PUBLIC_REQUEST_BYTES:
                    response = JSONResponse(
                        status_code=413,
                        content={"detail": {"code": "request_too_large", "message": "Request body is too large."}},
                    )
                    return _harden_response(response, request_id)
            except ValueError:
                response = JSONResponse(
                    status_code=400,
                    content={"detail": {"code": "invalid_content_length", "message": "Invalid Content-Length header."}},
                )
                return _harden_response(response, request_id)
        client_key = request.client.host if request.client else "unknown"
        if not paid_rate_limiter.allow(client_key):
            response = JSONResponse(
                status_code=429,
                content={"detail": {"code": "rate_limited", "message": "Too many paid-operation requests. Try again shortly."}},
                headers={"Retry-After": "2"},
            )
            return _harden_response(response, request_id)
    response = await call_next(request)
    _harden_response(response, request_id)
    logger.info(
        "request_complete",
        extra={
            "request_id": request_id,
            "http_method": request.method,
            "http_path": request.url.path,
            "status_code": response.status_code,
            "latency_ms": round((time.monotonic() - started) * 1000),
        },
    )
    return response


@app.exception_handler(WorkflowError)
async def workflow_error_handler(_request: Request, exc: WorkflowError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": {"code": exc.code, "message": str(exc), **exc.details}})


@app.exception_handler(AuthorizationError)
async def authorization_error_handler(_request: Request, exc: AuthorizationError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": {"code": exc.code, "message": str(exc)}}, headers={"WWW-Authenticate": "Bearer"})


@app.exception_handler(IntakeError)
async def intake_error_handler(_request: Request, exc: IntakeError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": {"code": exc.code, "message": str(exc)}},
    )


@app.exception_handler(LocationError)
async def location_error_handler(_request: Request, exc: LocationError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": {"code": exc.code, "message": str(exc)}},
    )


def _bearer(authorization: str | None) -> str | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    return authorization.split(None, 1)[1]


def _authenticate_coordinator_request(
    request: Request, authorization: str | None
) -> dict[str, str]:
    """Accept an explicit bearer, or a demo-only same-origin session cookie."""
    bearer = _bearer(authorization)
    if bearer:
        return token_authority.authenticate_coordinator(bearer)
    if not settings.demo_mode:
        return token_authority.authenticate_coordinator(None)

    session = request.cookies.get(_DEMO_SESSION_COOKIE)
    actor = token_authority.authenticate_coordinator_session(session)
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        origin = request.headers.get("origin")
        host = request.headers.get("host", "").lower()
        parsed = urlsplit(origin) if origin else None
        if (
            parsed is None
            or parsed.scheme not in {"http", "https"}
            or parsed.netloc.lower() != host
        ):
            raise AuthorizationError(
                "demo_session_origin_mismatch",
                "Demo coordinator actions require a same-origin request.",
                status_code=403,
            )
    return actor


def _idempotency(value: str | None) -> str:
    return value or secrets.token_urlsafe(18)


def _safe_equity_result(value: Mapping[str, Any]) -> dict[str, Any]:
    posting_keys = {
        "posting_id",
        "selected_recipient_id",
        "no_match",
        "eligible_count",
        "tract_geo_id",
        "poverty_rate",
        "no_vehicle_rate",
        "need_score",
        "need_evidence_source",
    }
    retrieval_keys = {
        "provider",
        "job_id",
        "location",
        "query_label",
        "job_labels",
        "sql_fingerprint_sha256",
        "vector_search",
        "use_brute_force",
        "top_k",
        "result_count",
        "total_bytes_processed",
    }
    postings = []
    for item in value.get("postings", []) if isinstance(value.get("postings"), list) else []:
        if not isinstance(item, Mapping):
            continue
        safe = {key: item.get(key) for key in posting_keys if key in item}
        evidence = item.get("retrieval_evidence")
        if isinstance(evidence, Mapping):
            safe["retrieval_evidence"] = {
                key: evidence.get(key) for key in retrieval_keys if key in evidence
            }
        postings.append(safe)
    summary_keys = {
        "status",
        "expected_postings",
        "posting_count",
        "matched_postings",
        "no_match_postings",
        "tract_evidence_count",
        "weekly_households_fallback_count",
        "selected_mean_poverty_rate",
        "selected_mean_no_vehicle_rate",
        "source_job_id",
        "vector_job_ids",
        "generated_assumptions",
        "limitations",
    }
    safe_result = {key: copy.deepcopy(value.get(key)) for key in summary_keys if key in value}
    safe_result["postings"] = postings
    proof = value.get("ten_match_proof")
    if isinstance(proof, Mapping):
        proof_keys = {
            "ok",
            "expected_matches",
            "match_execution_count",
            "vector_job_count",
            "unique_vector_job_count",
            "all_results_recorded",
            "all_jobs_labeled",
            "all_jobs_brute_force_vector_search",
            "job_ids",
        }
        safe_result["ten_match_proof"] = {
            key: copy.deepcopy(proof.get(key)) for key in proof_keys if key in proof
        }
    return safe_result


async def _get_equity_audit() -> dict[str, Any]:
    now = time.monotonic()
    cached_at = _equity_cache.get("cached_at")
    if cached_at is not None and now - float(cached_at) < _EQUITY_CACHE_SECONDS:
        result = copy.deepcopy(_equity_cache["result"])
        result["execution"] = {
            "source": "cache",
            "generated_at": _equity_cache["generated_at"],
            "served_at": datetime.now(timezone.utc).isoformat(),
            "cache_ttl_seconds": _EQUITY_CACHE_SECONDS,
        }
        return result
    async with _equity_cache_lock:
        now = time.monotonic()
        cached_at = _equity_cache.get("cached_at")
        if cached_at is not None and now - float(cached_at) < _EQUITY_CACHE_SECONDS:
            result = copy.deepcopy(_equity_cache["result"])
            result["execution"] = {
                "source": "cache",
                "generated_at": _equity_cache["generated_at"],
                "served_at": datetime.now(timezone.utc).isoformat(),
                "cache_ttl_seconds": _EQUITY_CACHE_SECONDS,
            }
            return result
        try:
            raw = await asyncio.to_thread(
                run_bigquery_equity_audit,
                project_id=settings.google_cloud_project,
            )
        except Exception as exc:
            logger.warning("equity_audit_failed error_type=%s", type(exc).__name__)
            raise HTTPException(
                status_code=503,
                detail="The live BigQuery equity audit is temporarily unavailable.",
            ) from exc
        generated_at = datetime.now(timezone.utc).isoformat()
        safe = _safe_equity_result(raw)
        _equity_cache.update(
            {"cached_at": time.monotonic(), "generated_at": generated_at, "result": safe}
        )
        result = copy.deepcopy(safe)
        result["execution"] = {
            "source": "live_bigquery",
            "generated_at": generated_at,
            "served_at": datetime.now(timezone.utc).isoformat(),
            "cache_ttl_seconds": _EQUITY_CACHE_SECONDS,
        }
        return result


@app.get("/healthz", tags=["operations"])
@app.get("/healthz/", include_in_schema=False)
async def health() -> dict[str, Any]:
    return {"status": "ok", "service": settings.app_name, "adk_available": root_agent is not None, "bigquery_mcp_enabled": settings.enable_bigquery_mcp}


@app.post("/api/demo/session", tags=["operations"])
async def create_demo_session(request: Request, response: Response) -> dict[str, Any]:
    """Create the demo coordinator session without exposing any shared secret."""
    if not settings.demo_mode:
        raise HTTPException(status_code=404, detail="Demo sessions are disabled.")
    ttl_seconds = settings.demo_session_ttl_seconds
    session = token_authority.issue_coordinator_session(
        ttl=timedelta(seconds=ttl_seconds)
    )
    response.set_cookie(
        key=_DEMO_SESSION_COOKIE,
        value=session,
        max_age=ttl_seconds,
        httponly=True,
        secure=settings.repository_backend == "firestore"
        or request.url.scheme == "https",
        samesite="strict",
        path="/api/ops",
    )
    response.headers["Cache-Control"] = "no-store"
    return {
        "role": "coordinator",
        "expires_in_seconds": ttl_seconds,
    }


@app.get("/readyz", tags=["operations"])
async def readiness(authorization: str | None = Header(default=None)) -> JSONResponse:
    token_authority.authenticate_coordinator(_bearer(authorization))
    dependencies: dict[str, Any] = {
        "repository": {"ok": False, "backend": settings.repository_backend},
        "scheduler": {"ok": False, "backend": type(scheduler).__name__},
        "adk": {"ok": root_agent is not None},
        "bigquery_mcp": {"ok": bool(settings.enable_bigquery_mcp and root_agent is not None), "enabled": settings.enable_bigquery_mcp, "note": "Managed MCP smoke evidence is recorded separately from readiness configuration."},
        "photo_intake": {
            "enabled": settings.enable_photo_intake,
            "ok": not settings.enable_photo_intake or photo_provider is not None,
            "probe": "provider_configuration_only",
            "external_verified": False,
            "note": "No paid model call is made by readiness.",
        },
        "geocoding": {
            "enabled": settings.enable_google_geocoding,
            "ok": not settings.enable_google_geocoding or geocode_provider is not None,
            "probe": "provider_configuration_only",
            "external_verified": False,
            "note": "No paid geocoding call is made by readiness.",
        },
        "routes": {
            "enabled": settings.enable_google_routes,
            "ok": not settings.enable_google_routes or route_provider is not None,
            "probe": "provider_configuration_only",
            "external_verified": False,
            "note": "No paid route call is made by readiness.",
        },
    }
    try:
        dependencies["repository"]["ok"] = bool(repository.ping())
    except Exception:
        dependencies["repository"]["error"] = "dependency_check_failed"
    try:
        dependencies["scheduler"]["ok"] = bool(scheduler.ping())
    except Exception as exc:
        logger.exception("Cloud Tasks readiness check failed")
        dependencies["scheduler"]["error"] = "dependency_check_failed"
        dependencies["scheduler"]["error_type"] = type(exc).__name__
    required_ok = (
        dependencies["repository"]["ok"]
        and dependencies["scheduler"]["ok"]
        and dependencies["photo_intake"]["ok"]
        and dependencies["geocoding"]["ok"]
        and dependencies["routes"]["ok"]
    )
    if settings.repository_backend == "firestore":
        agent_dependencies = await check_agent_dependencies()
        dependencies["agent_dependencies"] = agent_dependencies["checks"]
        required_ok = required_ok and agent_dependencies["status"] == "ready"
    else:
        dependencies["agent_dependencies"] = {
            "skipped": True,
            "reason": "credential_free_local_mode",
        }
    return JSONResponse(status_code=200 if required_ok else 503, content={"status": "ready" if required_ok else "not_ready", "dependencies": dependencies})


@app.post("/api/agent/run", tags=["agent"])
async def run_agent(request: AgentRunRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    token_authority.authenticate_coordinator(_bearer(authorization))
    try:
        return await run_root_agent(request.prompt)
    except AgentRuntimeUnavailable as exc:
        raise HTTPException(status_code=503, detail="The ADK runtime is unavailable.") from exc


@app.post("/api/match", response_model=MatchResponse, tags=["matching"])
async def create_match(request: MatchRequest) -> dict[str, Any]:
    try:
        result = await match_surplus_offer(
            description=request.description,
            quantity_pallets=request.quantity_pallets,
            storage_state=request.storage_state,
            pickup_deadline=request.pickup_deadline.isoformat(),
            donor_latitude=request.donor_latitude,
            donor_longitude=request.donor_longitude,
            split_allowed=request.split_allowed,
        )
        return _normalize_response(result)
    except MatcherUnavailableError as exc:
        logger.warning("Matcher unavailable: %s", exc)
        raise HTTPException(status_code=503, detail="The matching service is temporarily unavailable.") from exc
    except (TypeError, ValueError) as exc:
        logger.warning("Matcher rejected a validated request: %s", exc)
        raise HTTPException(status_code=422, detail="The offer could not be evaluated with the supplied fields.") from exc
    except Exception as exc:
        logger.exception("Unexpected matcher failure")
        raise HTTPException(status_code=503, detail="The matching service is temporarily unavailable.") from exc


@app.post("/api/intake/extract", tags=["intake"])
async def extract_intake(request: IntakeExtractRequest) -> dict[str, Any]:
    """Return editable suggestions; this endpoint never creates an offer."""
    photo = request.photo
    return await intake_interpreter.extract(
        text=request.text,
        transcript=request.transcript,
        photo_mime_type=photo.mime_type if photo else None,
        photo_base64=photo.data_base64 if photo else None,
        now=request.now,
    )


@app.post("/api/locations/geocode", tags=["locations"])
async def geocode_location(request: GeocodeRequest) -> dict[str, Any]:
    """Return a single Atlanta-biased candidate for explicit donor review."""
    return await location_service.geocode(request.address)


@app.post("/api/offers", status_code=201, tags=["workflow"])
async def create_offer(request: OfferCreateRequest, x_idempotency_key: str | None = Header(default=None)) -> dict[str, Any]:
    return await workflow.create_offer(request.model_dump(mode="json"), idempotency_key=_idempotency(x_idempotency_key))


@app.get("/api/offers/status", tags=["workflow"])
async def offer_status(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    return workflow.status(_bearer(authorization) or "")


@app.get("/api/recipients/notifications", tags=["workflow"])
async def recipient_notifications(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    return workflow.inbox(_bearer(authorization) or "")


@app.get("/api/public/summary", tags=["workflow"])
async def public_summary() -> dict[str, Any]:
    """Return aggregate demo metrics without identities, locations, or tokens."""
    return workflow.public_summary()


@app.post("/api/offers/{offer_id}/claim", tags=["workflow"])
async def claim_offer(offer_id: str, request: dict[str, Any] | None = None, authorization: str | None = Header(default=None), x_idempotency_key: str | None = Header(default=None)) -> dict[str, Any]:
    return workflow.claim(offer_id, _bearer(authorization) or "", request or {}, idempotency_key=_idempotency(x_idempotency_key))


@app.post("/api/offers/{offer_id}/decline", tags=["workflow"])
async def decline_offer(offer_id: str, request: DeclineRequest, authorization: str | None = Header(default=None), x_idempotency_key: str | None = Header(default=None)) -> dict[str, Any]:
    return workflow.decline(offer_id, _bearer(authorization) or "", request.model_dump(), idempotency_key=_idempotency(x_idempotency_key))


@app.post("/api/reservations/{reservation_id}/confirm", tags=["workflow"])
async def confirm_reservation(reservation_id: str, request: ConfirmRequest, authorization: str | None = Header(default=None), x_idempotency_key: str | None = Header(default=None)) -> dict[str, Any]:
    return workflow.confirm(reservation_id, _bearer(authorization) or "", request.model_dump(mode="json"), idempotency_key=_idempotency(x_idempotency_key))


@app.post("/api/offers/{offer_id}/complete", tags=["workflow"])
async def complete_offer(offer_id: str, request: CompleteRequest, authorization: str | None = Header(default=None), x_idempotency_key: str | None = Header(default=None)) -> dict[str, Any]:
    return workflow.complete(offer_id, _bearer(authorization) or "", request.model_dump(), idempotency_key=_idempotency(x_idempotency_key))


@app.post("/internal/tasks/advance-offer", tags=["internal"])
async def advance_offer_task(request: AdvanceTaskRequest, authorization: str | None = Header(default=None), x_task_secret: str | None = Header(default=None)) -> dict[str, Any]:
    task_verifier.verify(authorization, local_secret_header=x_task_secret)
    if request.kind == "noop":
        return {"accepted": True, "kind": "noop"}
    return workflow.advance_offer_if_due(request.offer_id, kind=request.kind, lease_version=request.lease_version, wave_version=request.wave_version)


@app.get("/api/ops/offers", tags=["operations"])
async def ops_offers(request: Request, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _authenticate_coordinator_request(request, authorization)
    return workflow.ops_offers()


@app.get("/api/ops/equity-audit", tags=["operations"])
async def equity_audit(request: Request, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _authenticate_coordinator_request(request, authorization)
    return await _get_equity_audit()


@app.post("/api/ops/ask", tags=["operations"])
async def ops_ask(body: AgentRunRequest, request: Request, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _authenticate_coordinator_request(request, authorization)
    try:
        return await run_root_agent(body.prompt, user_id="pantry-relay-coordinator")
    except AgentRuntimeUnavailable as exc:
        raise HTTPException(status_code=503, detail="The ADK runtime is unavailable.") from exc


@app.post("/api/ops/offers/{offer_id}/{action}", tags=["operations"])
async def ops_offer_action(offer_id: str, action: str, body: OpsActionRequest, request: Request, authorization: str | None = Header(default=None), x_idempotency_key: str | None = Header(default=None)) -> dict[str, Any]:
    _authenticate_coordinator_request(request, authorization)
    return workflow.ops_action(offer_id, action, body.model_dump(exclude_none=True), idempotency_key=_idempotency(x_idempotency_key))


frontend_dir = Path(__file__).resolve().parents[1] / "frontend"
if frontend_dir.is_dir():
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
