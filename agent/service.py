"""FastAPI service for Pantry Relay matching and rescue workflow."""

from __future__ import annotations

from datetime import datetime
import logging
from pathlib import Path
import secrets
from typing import Any, Literal, Mapping

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .agent import MatcherUnavailableError, match_surplus_offer, root_agent
from .auth import AuthorizationError, TokenAuthority
from .config import settings
from .repository import FirestoreWorkflowRepository, InMemoryWorkflowRepository
from .proof import check_agent_dependencies
from .runtime import AgentRuntimeUnavailable, run_root_agent
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
workflow = WorkflowService(
    repository,
    token_authority,
    scheduler,
    matcher=match_surplus_offer if settings.workflow_matcher_enabled else None,
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
    allow_headers=["Content-Type", "Authorization", "X-Idempotency-Key"],
)


@app.exception_handler(WorkflowError)
async def workflow_error_handler(_request: Request, exc: WorkflowError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": {"code": exc.code, "message": str(exc), **exc.details}})


@app.exception_handler(AuthorizationError)
async def authorization_error_handler(_request: Request, exc: AuthorizationError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": {"code": exc.code, "message": str(exc)}}, headers={"WWW-Authenticate": "Bearer"})


def _bearer(authorization: str | None) -> str | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    return authorization.split(None, 1)[1]


def _idempotency(value: str | None) -> str:
    return value or secrets.token_urlsafe(18)


@app.get("/healthz", tags=["operations"])
@app.get("/healthz/", include_in_schema=False)
async def health() -> dict[str, Any]:
    return {"status": "ok", "service": settings.app_name, "adk_available": root_agent is not None, "bigquery_mcp_enabled": settings.enable_bigquery_mcp}


@app.get("/readyz", tags=["operations"])
async def readiness(authorization: str | None = Header(default=None)) -> JSONResponse:
    token_authority.authenticate_coordinator(_bearer(authorization))
    dependencies: dict[str, Any] = {
        "repository": {"ok": False, "backend": settings.repository_backend},
        "scheduler": {"ok": False, "backend": type(scheduler).__name__},
        "adk": {"ok": root_agent is not None},
        "bigquery_mcp": {"ok": bool(settings.enable_bigquery_mcp and root_agent is not None), "enabled": settings.enable_bigquery_mcp, "note": "Managed MCP smoke evidence is recorded separately from readiness configuration."},
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
    required_ok = dependencies["repository"]["ok"] and dependencies["scheduler"]["ok"]
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


@app.post("/api/offers", status_code=201, tags=["workflow"])
async def create_offer(request: OfferCreateRequest, x_idempotency_key: str | None = Header(default=None)) -> dict[str, Any]:
    return await workflow.create_offer(request.model_dump(mode="json"), idempotency_key=_idempotency(x_idempotency_key))


@app.get("/api/offers/status", tags=["workflow"])
async def offer_status(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    return workflow.status(_bearer(authorization) or "")


@app.get("/api/recipients/notifications", tags=["workflow"])
async def recipient_notifications(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    return workflow.inbox(_bearer(authorization) or "")


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
async def ops_offers(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    token_authority.authenticate_coordinator(_bearer(authorization))
    return workflow.ops_offers()


@app.get("/api/ops/equity-audit", tags=["operations"])
async def equity_audit(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    token_authority.authenticate_coordinator(_bearer(authorization))
    return workflow.equity_audit()


@app.post("/api/ops/ask", tags=["operations"])
async def ops_ask(request: AgentRunRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    token_authority.authenticate_coordinator(_bearer(authorization))
    try:
        return await run_root_agent(request.prompt, user_id="pantry-relay-coordinator")
    except AgentRuntimeUnavailable as exc:
        raise HTTPException(status_code=503, detail="The ADK runtime is unavailable.") from exc


@app.post("/api/ops/offers/{offer_id}/{action}", tags=["operations"])
async def ops_offer_action(offer_id: str, action: str, request: OpsActionRequest, authorization: str | None = Header(default=None), x_idempotency_key: str | None = Header(default=None)) -> dict[str, Any]:
    token_authority.authenticate_coordinator(_bearer(authorization))
    return workflow.ops_action(offer_id, action, request.model_dump(exclude_none=True), idempotency_key=_idempotency(x_idempotency_key))


frontend_dir = Path(__file__).resolve().parents[1] / "frontend"
if frontend_dir.is_dir():
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
