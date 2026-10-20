"""Typed inputs and outputs for the deterministic surplus matcher.

The public matcher accepts mappings as well as these dataclasses.  Keeping the
models dependency-free makes the matching rules runnable in tests and demos
without Google Cloud credentials.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
import math
from typing import Any, Mapping


def _utc_datetime(value: Any, *, field_name: str) -> datetime:
    if isinstance(value, datetime):
        result = value
    elif isinstance(value, str):
        try:
            result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError(f"{field_name} must be an ISO-8601 datetime") from exc
    else:
        raise ValueError(f"{field_name} must be a datetime or ISO-8601 string")
    if result.tzinfo is None:
        result = result.replace(tzinfo=timezone.utc)
    return result.astimezone(timezone.utc)


def _optional_float(value: Any) -> float | None:
    return None if value is None else float(value)


def _rounded_or_none(value: float, digits: int = 2) -> float | None:
    return round(value, digits) if math.isfinite(value) else None


@dataclass(frozen=True)
class MatchRequest:
    posting_text: str
    quantity_pallets: float
    storage_state: str
    pickup_deadline: datetime
    donor_latitude: float
    donor_longitude: float
    requested_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    donor_delivery_available: bool = False
    transport_mode: str = "recipient_pickup"
    donor_delivery_radius_km: float | None = None
    split_allowed: bool = False
    average_speed_mph: float = 25.0
    handling_buffer_hours: float = 0.5

    @classmethod
    def from_value(cls, value: "MatchRequest | Mapping[str, Any]") -> "MatchRequest":
        if isinstance(value, cls):
            return value
        if not isinstance(value, Mapping):
            raise TypeError("request must be a MatchRequest or mapping")

        requested_at = _utc_datetime(
            value.get("requested_at", datetime.now(timezone.utc)),
            field_name="requested_at",
        )
        deadline_value = value.get("pickup_deadline")
        if deadline_value is None:
            hours = value.get("hours_remaining", value.get("pickup_deadline_hours"))
            if hours is None:
                raise ValueError("pickup_deadline or hours_remaining is required")
            deadline = requested_at + timedelta(hours=float(hours))
        else:
            deadline = _utc_datetime(deadline_value, field_name="pickup_deadline")

        legacy_delivery = bool(value.get("donor_delivery_available", False))
        transport_mode = str(
            value.get(
                "transport_mode",
                "donor_delivery" if legacy_delivery else "recipient_pickup",
            )
        ).strip().lower()
        radius_value = value.get("donor_delivery_radius_km")
        # Preserve the original donor_delivery_available=True contract. Its
        # implicit operating radius was the release-one five kilometre limit.
        if transport_mode == "donor_delivery" and radius_value is None:
            radius_value = 5.0

        request = cls(
            posting_text=str(value.get("posting_text", "")).strip(),
            quantity_pallets=float(value.get("quantity_pallets", 0)),
            storage_state=str(value.get("storage_state", "")).strip().lower(),
            pickup_deadline=deadline,
            donor_latitude=float(value["donor_latitude"]),
            donor_longitude=float(value["donor_longitude"]),
            requested_at=requested_at,
            donor_delivery_available=transport_mode == "donor_delivery",
            transport_mode=transport_mode,
            donor_delivery_radius_km=_optional_float(radius_value),
            split_allowed=bool(value.get("split_allowed", False)),
            average_speed_mph=float(value.get("average_speed_mph", 25.0)),
            handling_buffer_hours=float(value.get("handling_buffer_hours", 0.5)),
        )
        request.validate()
        return request

    def validate(self) -> None:
        if not self.posting_text:
            raise ValueError("posting_text is required")
        if self.quantity_pallets <= 0:
            raise ValueError("quantity_pallets must be greater than zero")
        if self.storage_state not in {"ambient", "pantry", "refrigerated", "frozen"}:
            raise ValueError("storage_state must be ambient, pantry, refrigerated, or frozen")
        if self.pickup_deadline <= self.requested_at:
            raise ValueError("pickup_deadline must be after requested_at")
        if not -90 <= self.donor_latitude <= 90:
            raise ValueError("donor_latitude must be between -90 and 90")
        if not -180 <= self.donor_longitude <= 180:
            raise ValueError("donor_longitude must be between -180 and 180")
        if self.average_speed_mph <= 0:
            raise ValueError("average_speed_mph must be greater than zero")
        if self.handling_buffer_hours < 0:
            raise ValueError("handling_buffer_hours cannot be negative")
        if self.transport_mode not in {
            "recipient_pickup",
            "donor_delivery",
            "transportation_needed",
        }:
            raise ValueError(
                "transport_mode must be recipient_pickup, donor_delivery, or "
                "transportation_needed"
            )
        if self.transport_mode == "donor_delivery" and not (
            self.donor_delivery_radius_km is not None
            and 0 < self.donor_delivery_radius_km <= 5
        ):
            raise ValueError(
                "donor_delivery_radius_km must be greater than zero and at most 5"
            )

    @property
    def hours_remaining(self) -> float:
        return (self.pickup_deadline - self.requested_at).total_seconds() / 3600


@dataclass(frozen=True)
class RecipientCandidate:
    recipient_id: str
    name: str
    profile_text: str
    cold_storage: str
    frozen_storage: bool
    refrigerated_transport: bool
    max_pallets: float
    pickup_window_hours: float | None
    service_days: str
    latitude: float | None
    longitude: float | None
    semantic_distance: float
    street: str = ""
    city: str = ""
    state: str = ""
    zip_code: str = ""
    weekly_households: int | None = None
    need_score: float | None = None
    transport_available: bool | None = None
    populations_served: str = ""
    archetype: str = ""
    profile_source: str = ""
    tract_geo_id: str | None = None
    tract_poverty_rate: float | None = None
    tract_no_vehicle_rate: float | None = None
    tract_assistance_rate: float | None = None
    need_evidence_source: str | None = None

    @classmethod
    def from_value(
        cls, value: "RecipientCandidate | Mapping[str, Any]"
    ) -> "RecipientCandidate":
        if isinstance(value, cls):
            return value
        if not isinstance(value, Mapping):
            raise TypeError("candidate must be a RecipientCandidate or mapping")

        # BigQuery Row behaves like a mapping after dict(row); accepting common
        # aliases keeps offline fixtures and the warehouse provider identical.
        return cls(
            recipient_id=str(value.get("recipient_id", "")),
            name=str(value.get("name", "")),
            profile_text=str(value.get("profile_text", "")),
            cold_storage=str(value.get("cold_storage", "none")).lower(),
            frozen_storage=bool(value.get("frozen_storage", False)),
            refrigerated_transport=bool(value.get("refrigerated_transport", False)),
            max_pallets=float(value.get("max_pallets", 0) or 0),
            pickup_window_hours=_optional_float(value.get("pickup_window_hours")),
            service_days=str(value.get("service_days", "")),
            latitude=_optional_float(value.get("latitude")),
            longitude=_optional_float(value.get("longitude")),
            semantic_distance=float(value.get("semantic_distance", value.get("distance", 1.0))),
            street=str(value.get("street", "") or ""),
            city=str(value.get("city", "") or ""),
            state=str(value.get("state", "") or ""),
            zip_code=str(value.get("zip_code", "") or ""),
            weekly_households=(
                None if value.get("weekly_households") is None
                else int(value["weekly_households"])
            ),
            need_score=_optional_float(value.get("need_score")),
            transport_available=(
                None if value.get("transport_available") is None
                else bool(value["transport_available"])
            ),
            populations_served=str(value.get("populations_served", "") or ""),
            archetype=str(value.get("archetype", "") or ""),
            profile_source=str(value.get("profile_source", "") or ""),
            tract_geo_id=(
                None if value.get("tract_geo_id") is None else str(value["tract_geo_id"])
            ),
            tract_poverty_rate=_optional_float(value.get("tract_poverty_rate")),
            tract_no_vehicle_rate=_optional_float(value.get("tract_no_vehicle_rate")),
            tract_assistance_rate=_optional_float(value.get("tract_assistance_rate")),
            need_evidence_source=(
                None
                if value.get("need_evidence_source") is None
                else str(value["need_evidence_source"])
            ),
        )


@dataclass(frozen=True)
class CandidateEvaluation:
    recipient_id: str
    name: str
    eligible: bool
    reasons: tuple[str, ...]
    warnings: tuple[str, ...]
    distance_miles: float
    travel_time_hours: float
    time_margin_hours: float
    capacity_margin_pallets: float
    semantic_distance: float
    need_score: float
    candidate: RecipientCandidate = field(repr=False)

    def to_dict(self, *, include_candidate: bool = False) -> dict[str, Any]:
        result: dict[str, Any] = {
            "recipient_id": self.recipient_id,
            "name": self.name,
            "eligible": self.eligible,
            "reasons": list(self.reasons),
            "warnings": list(self.warnings),
            "distance_miles": _rounded_or_none(self.distance_miles),
            "travel_time_hours": _rounded_or_none(self.travel_time_hours),
            "time_margin_hours": _rounded_or_none(self.time_margin_hours),
            "capacity_margin_pallets": _rounded_or_none(self.capacity_margin_pallets),
            "semantic_distance": self.semantic_distance,
            "need_score": self.need_score,
        }
        if include_candidate:
            result["candidate"] = asdict(self.candidate)
        return result
