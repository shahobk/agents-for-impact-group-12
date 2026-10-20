"""FastAPI service for deterministic surplus-recipient matching."""

from __future__ import annotations

from datetime import datetime
import logging
from pathlib import Path
from typing import Any, Literal, Mapping

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .agent import (
    MatcherUnavailableError,
    check_fda_food_recalls,
    google_search_food_and_pantry_info,
    list_surplus_postings,
    lookup_shelf_life,
    match_surplus_offer,
    onboard_new_pantry,
    root_agent,
    run_metro_equity_audit,
)
from .config import settings

logger = logging.getLogger(__name__)


class MatchRequest(BaseModel):
    """Validated coordinator input for a single surplus offer."""

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
        """Accept small client variations while keeping one canonical contract."""
        if not isinstance(value, Mapping):
            return value
        data = dict(value)
        if "quantity_pallets" not in data:
            data["quantity_pallets"] = data.get(
                "quantity", data.get("pallet_estimate")
            )
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

        # The UI retains a human-readable pickup label for display, while the
        # deterministic matcher uses the validated coordinates.
        data.pop("pickup_location", None)
        return data

    @field_validator("pickup_deadline")
    @classmethod
    def deadline_requires_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("pickup_deadline must include a timezone offset")
        return value


class MatchResponse(BaseModel):
    """Stable envelope around matcher-specific evidence fields."""

    model_config = ConfigDict(extra="forbid")

    selected: dict[str, Any] | None = None
    fallbacks: list[dict[str, Any]] = Field(default_factory=list)
    rejections: list[dict[str, Any]] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    outreach: str | None = None


def _normalize_response(result: Mapping[str, Any]) -> dict[str, Any]:
    """Keep the public API stable as matcher internals evolve."""
    data = dict(result)
    selected = data.get("selected", data.get("best", data.get("match")))
    fallbacks = data.get("fallbacks", data.get("alternatives", [])) or []
    rejections = data.get("rejections", data.get("rejected", [])) or []
    warnings = data.get("warnings", []) or []
    outreach = data.get("outreach", data.get("outreach_message"))
    return {
        "selected": selected,
        "fallbacks": fallbacks,
        "rejections": rejections,
        "warnings": [str(item) for item in warnings],
        "outreach": outreach,
    }


app = FastAPI(
    title="Atlanta Grocery Rescue API",
    version="1.0.0",
    description="Semantic candidate retrieval followed by deterministic eligibility checks.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_allow_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.get("/healthz", tags=["operations"])
async def health() -> dict[str, Any]:
    """Liveness endpoint that never requires model or Google credentials."""
    return {
        "status": "ok",
        "service": settings.app_name,
        "adk_available": root_agent is not None,
        "bigquery_mcp_enabled": settings.enable_bigquery_mcp,
    }


@app.post("/api/match", response_model=MatchResponse, tags=["matching"])
async def create_match(request: MatchRequest) -> dict[str, Any]:
    """Return an auditable match brief for one food-surplus offer."""
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
        raise HTTPException(
            status_code=503,
            detail="The matching service is temporarily unavailable.",
        ) from exc


    except (TypeError, ValueError) as exc:
        logger.warning("Matcher rejected a validated request: %s", exc)
        raise HTTPException(
            status_code=422,
            detail="The offer could not be evaluated with the supplied fields.",
        ) from exc
    except Exception as exc:
        logger.exception("Unexpected matcher failure")
        raise HTTPException(
            status_code=503,
            detail="The matching service is temporarily unavailable.",
        ) from exc


@app.get("/api/postings", tags=["matching"])
async def get_postings(track: str = "") -> dict[str, Any]:
    """List surplus food postings from BigQuery (`a4i_food.surplus_postings`) or local fallback."""
    return list_surplus_postings(track=track)


@app.get("/api/equity-audit", tags=["equity"])
async def get_equity_audit(volunteer_driver_available: bool = True) -> dict[str, Any]:
    """Run the 10-posting Metro Equity Outcome Audit comparing the broker to Metro and Naive baselines."""
    return run_metro_equity_audit(volunteer_driver_available=volunteer_driver_available)


@app.get("/api/shelf-life", tags=["safety"])
async def get_shelf_life(
    food_query: str,
    storage_state: str = "refrigerated",
    donor_hours_available: float = 24.0,
    is_sealed: bool = True,
    elapsed_hours: float = 0.0,
) -> dict[str, Any]:
    """Compute USDA FoodKeeper biological shelf life and binding clock constraint."""
    return lookup_shelf_life(
        food_item=food_query,
        storage_state=storage_state,
        donor_hours_available=donor_hours_available,
        is_sealed=is_sealed,
        elapsed_hours=elapsed_hours,
    )


@app.get("/api/recalls", tags=["safety"])
async def get_fda_recalls(food_item: str, state: str = "GA") -> dict[str, Any]:
    """Check the live openFDA Food Enforcement API for ongoing recalls."""
    return check_fda_food_recalls(food_item=food_item, state=state)


class OnboardPantryRequest(BaseModel):
    """Conversational or form-based intake for a new community recipient."""

    name: str = Field(min_length=2, max_length=200)
    street: str = Field(min_length=2, max_length=200)
    city: str = "Atlanta"
    zip_code: str = "30310"
    cold_storage: str = "walk-in"
    frozen_storage: bool = False
    loading_dock: bool = False
    refrigerated_transport: bool = False
    max_pallets: int = 2
    pickup_window_hours: int = 4
    weekly_households: int = 350
    populations_served: str = "Low-income families, seniors, and children"
    service_days: str = "Monday, Tuesday, Wednesday, Thursday, Friday"
    profile_description: str = (
        "Neighborhood pantry with commercial walk-in cooler serving families in Southwest Atlanta."
    )
    latitude: float = 33.7250
    longitude: float = -84.4170


@app.get("/api/google-search", tags=["safety"])
async def get_google_search_info(query: str) -> dict[str, Any]:
    """Search Google (via Gemini Google Search Grounding) for unlisted food safety or pantry info."""
    return google_search_food_and_pantry_info(query=query)


@app.post("/api/onboard", tags=["intake"])
async def create_pantry_onboarding(request: OnboardPantryRequest) -> dict[str, Any]:
    """Onboard a new community pantry into BigQuery (`recipients` + `recipient_embeddings` via AI.EMBED)."""
    return onboard_new_pantry(
        name=request.name,
        street=request.street,
        city=request.city,
        zip_code=request.zip_code,
        cold_storage=request.cold_storage,
        frozen_storage=request.frozen_storage,
        loading_dock=request.loading_dock,
        refrigerated_transport=request.refrigerated_transport,
        max_pallets=request.max_pallets,
        pickup_window_hours=request.pickup_window_hours,
        weekly_households=request.weekly_households,
        populations_served=request.populations_served,
        service_days=request.service_days,
        profile_description=request.profile_description,
        latitude=request.latitude,
        longitude=request.longitude,
    )


# Keep the demo deployable as one Cloud Run service. API routes are registered
# first so the catch-all static mount cannot shadow /api/match or /healthz.
frontend_dir = Path(__file__).resolve().parents[1] / "frontend"
if frontend_dir.is_dir():
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
