"""Deterministic Pantry Relay offer, reservation, and wave state machine."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import uuid
from typing import Any

from .auth import AuthorizationError, TokenAuthority, parse_time, utc_now
from .foodkeeper import lookup_foodkeeper
from .locations import RouteEstimator, haversine_route, within_atlanta_service_area
from .repository import WorkflowRepository
from .tasks import TaskScheduler


TERMINAL_STATUSES = {"completed", "failed", "expired", "cancelled", "no_match"}
ROUTE_HANDLING_BUFFER_MINUTES = 30.0
CANDIDATE_RESPONSES = {
    "pending",
    "declined",
    "holding",
    "hold_expired",
    "timed_out",
    "won",
    "invalidated",
}


class WorkflowError(RuntimeError):
    def __init__(self, code: str, message: str, *, status_code: int = 400, **details: Any):
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.details = details


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _canonical_hash(value: Mapping[str, Any]) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _stable_id(prefix: str, value: str) -> str:
    return f"{prefix}_{uuid.uuid5(uuid.NAMESPACE_URL, value).hex[:20]}"


def _demo_candidates() -> list[dict[str, Any]]:
    names = [
        ("maple-street", "Maple Street Produce Alliance", 1.7, 8, 0.84),
        ("peachtree", "Peachtree Community Pantry", 2.2, 6, 0.79),
        ("westside", "Westside Neighborhood Fridge", 2.8, 4, 0.91),
        ("south-atlanta", "South Atlanta Family Pantry", 3.4, 5, 0.88),
        ("edgewood", "Edgewood Mutual Aid Pantry", 3.9, 3, 0.76),
        ("vine-city", "Vine City Food Cooperative", 4.4, 7, 0.94),
    ]
    result = []
    for rank, (recipient_id, name, distance, capacity, need) in enumerate(names, 1):
        result.append(
            {
                "recipient_id": recipient_id,
                "name": name,
                "eligible": True,
                "rank": rank,
                "distance_miles": distance,
                "max_pallets": capacity,
                "capacity_margin_pallets": capacity - 1,
                "cold_storage": "walk-in",
                "refrigerated_transport": True,
                "pickup_window_hours": 12,
                "selection_reason": (
                    f"Eligible cold-chain recipient {distance:.1f} miles away with known capacity."
                ),
                "reasons": [],
                "warnings": [
                    "Recipient capabilities are generated demo attributes; confirm live capacity."
                ],
                "need_score": need,
                "tract_need_evidence": {
                    "source": "approximate_nearest_tract_demo",
                    "score": need,
                    "label": "Approximate nearest-tract need context",
                },
                "latitude": 33.749 + rank * 0.006,
                "longitude": -84.388 - rank * 0.005,
            }
        )
    return result


class WorkflowService:
    def __init__(
        self,
        repository: WorkflowRepository,
        token_authority: TokenAuthority,
        scheduler: TaskScheduler,
        *,
        matcher: Callable[..., Awaitable[dict[str, Any]]] | None = None,
        route_estimator: RouteEstimator | None = None,
        demo_mode: bool = True,
        demo_fallback: bool = True,
        hold_minutes: int = 10,
        response_window_minutes: int = 10,
    ) -> None:
        self.repository = repository
        self.tokens = token_authority
        self.scheduler = scheduler
        self.matcher = matcher
        self.route_estimator = route_estimator or RouteEstimator()
        self.demo_mode = demo_mode
        self.demo_fallback = demo_fallback
        self.hold_minutes = hold_minutes
        self.response_window_minutes = response_window_minutes

    def _receipt_key(self, actor: str, operation: str, idempotency_key: str) -> str:
        if not idempotency_key or len(idempotency_key) > 200:
            raise WorkflowError(
                "invalid_idempotency_key", "A non-empty idempotency key is required."
            )
        return f"{actor}:{operation}:{idempotency_key}"

    def _replay(
        self, state: dict[str, Any], receipt_id: str, request: Mapping[str, Any]
    ) -> dict[str, Any] | None:
        receipt = state["command_receipts"].get(receipt_id)
        if not receipt:
            return None
        if receipt["request_hash"] != _canonical_hash(request):
            raise WorkflowError(
                "idempotency_key_reused",
                "The idempotency key was already used with a different request.",
                status_code=409,
            )
        return dict(receipt["result"])

    def _save_receipt(
        self,
        state: dict[str, Any],
        receipt_id: str,
        request: Mapping[str, Any],
        result: Mapping[str, Any],
        now: datetime,
    ) -> None:
        # Raw access tokens are regenerated from the receipt key and are never
        # persisted in the receipt or logs.
        safe_result = dict(result)
        safe_result.pop("status_token", None)
        safe_result.pop("recipient_access", None)
        safe_result.pop("_tasks", None)
        state["command_receipts"][receipt_id] = {
            "request_hash": _canonical_hash(request),
            "completed": True,
            "result": safe_result,
            "created_at": _iso(now),
        }

    def _event(
        self,
        state: dict[str, Any],
        offer_id: str,
        event_type: str,
        actor_type: str,
        actor_id: str,
        text: str,
        now: datetime,
    ) -> None:
        events = state["events"].setdefault(offer_id, [])
        events.append(
            {
                "event_id": f"{offer_id}:{len(events) + 1:04d}",
                "type": event_type,
                "actor_type": actor_type,
                "actor_id": actor_id,
                "timestamp": _iso(now),
                "text": text,
            }
        )

    async def _candidates(
        self, payload: Mapping[str, Any], now: datetime
    ) -> tuple[
        list[dict[str, Any]],
        list[dict[str, Any]],
        list[str],
        dict[str, Any],
        dict[str, Any] | None,
    ]:
        if self.matcher:
            try:
                result = await self.matcher(
                    description=payload["description"],
                    quantity_pallets=payload["quantity_pallets"],
                    storage_state=payload["storage_state"],
                    pickup_deadline=payload["pickup_deadline"],
                    donor_latitude=payload["donor_latitude"],
                    donor_longitude=payload["donor_longitude"],
                    split_allowed=False,
                    transport_mode=(
                        "recipient_pickup"
                        if payload.get("transport_mode") == "transportation_needed"
                        else payload.get("transport_mode")
                    ),
                    donor_delivery_radius_km=payload.get("donor_delivery_radius_km"),
                )
                supplied_eligible = result.get("eligible_candidates")
                if isinstance(supplied_eligible, list):
                    eligible = [
                        dict(item)
                        for item in supplied_eligible
                        if isinstance(item, Mapping)
                    ]
                else:
                    eligible = [
                        dict(item)
                        for item in [result.get("selected"), *result.get("fallbacks", [])]
                        if isinstance(item, Mapping)
                    ]
                for rank, item in enumerate(eligible, 1):
                    item.setdefault("rank", rank)
                    item.setdefault("eligible", True)
                    if item.get("need_evidence") and not item.get("tract_need_evidence"):
                        item["tract_need_evidence"] = item["need_evidence"]
                route_rejections = await self._enrich_route_evidence(
                    eligible, payload, now
                )
                raw_evidence = result.get("retrieval_evidence") or {}
                if not isinstance(raw_evidence, Mapping):
                    raw_evidence = {}
                evidence = {
                    key: raw_evidence.get(key)
                    for key in (
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
                    )
                    if raw_evidence.get(key) is not None
                }
                raw_trace = result.get("_agent_trace") or {}
                agent_trace = None
                if isinstance(raw_trace, Mapping):
                    agent_trace = {
                        "runner": str(raw_trace.get("runner") or "")[:120],
                        "session_id": str(raw_trace.get("session_id") or "")[:200],
                        "root_agent_observed": bool(
                            raw_trace.get("root_agent_observed", False)
                        ),
                        "tool_name": (
                            "match_surplus_offer"
                            if raw_trace.get("tool_name") == "match_surplus_offer"
                            else "unknown"
                        ),
                        "status": (
                            "succeeded"
                            if raw_trace.get("status") == "succeeded"
                            else "error"
                        ),
                        "latency_ms": raw_trace.get("latency_ms"),
                        "elapsed_ms": raw_trace.get("elapsed_ms"),
                        "completed_at": raw_trace.get("completed_at"),
                        # Use the independently allowlisted matcher evidence so
                        # the trace and persisted match proof are correlated.
                        "retrieval_evidence": dict(evidence),
                    }
                return (
                    eligible,
                    [*list(result.get("rejections", [])), *route_rejections],
                    list(result.get("warnings", [])),
                    evidence,
                    agent_trace,
                )
            except Exception as exc:
                if not self.demo_fallback:
                    raise WorkflowError(
                        "matcher_unavailable",
                        "The ADK matching workflow is temporarily unavailable.",
                        status_code=503,
                    ) from exc
        if self.demo_fallback:
            candidates = _demo_candidates()
            route_rejections = await self._enrich_route_evidence(
                candidates, payload, now
            )
            return (
                candidates,
                route_rejections,
                [
                    "Local deterministic demo candidates were used because cloud matching was unavailable."
                ],
                {
                    "provider": "deterministic_demo_fallback",
                    "vector_search": False,
                },
                None,
            )
        raise WorkflowError("matcher_unavailable", "The matcher is unavailable.", status_code=503)

    async def _enrich_route_evidence(
        self,
        candidates: list[dict[str, Any]],
        payload: Mapping[str, Any],
        now: datetime,
    ) -> list[dict[str, Any]]:
        """Reject route contradictions without ever resurrecting rejected rows."""
        routable = [
            candidate
            for candidate in candidates
            if candidate.get("latitude") is not None
            and candidate.get("longitude") is not None
        ]

        async def enrich(
            candidate: dict[str, Any], use_provider: bool,
        ) -> tuple[dict[str, Any], list[str]]:
            coordinates = (
                float(payload["donor_latitude"]),
                float(payload["donor_longitude"]),
                float(candidate["latitude"]),
                float(candidate["longitude"]),
            )
            evidence = (
                await self.route_estimator.estimate(*coordinates)
                if use_provider
                else haversine_route(*coordinates)
            )
            candidate["travel"] = {
                **dict(candidate.get("travel") or {}),
                **evidence,
            }
            reasons: list[str] = []
            minutes = float(evidence.get("estimated_minutes") or 0)
            reasons.extend(
                self._route_time_rejections(
                    candidate,
                    route_minutes=minutes,
                    now=now,
                    deadline=parse_time(str(payload["pickup_deadline"])),
                    service_window_started_at=now,
                )
            )
            if payload.get("transport_mode") == "donor_delivery":
                radius_km = float(payload.get("donor_delivery_radius_km") or 5)
                route_km = float(evidence.get("distance_miles") or 0) * 1.609344
                if route_km > radius_km:
                    reasons.append("route_exceeds_donor_delivery_radius")
            return candidate, reasons

        evaluated = await asyncio.gather(
            *(
                enrich(candidate, index < 3)
                for index, candidate in enumerate(routable)
            )
        )
        rejected: list[dict[str, Any]] = []
        rejected_ids: set[int] = set()
        for candidate, reasons in evaluated:
            if reasons:
                candidate.update({"eligible": False, "reasons": reasons})
                rejected.append(dict(candidate))
                rejected_ids.add(id(candidate))
        if rejected_ids:
            candidates[:] = [
                candidate for candidate in candidates if id(candidate) not in rejected_ids
            ]
        for rank, candidate in enumerate(candidates, 1):
            candidate["rank"] = rank
        return rejected

    @staticmethod
    def _route_time_rejections(
        candidate: Mapping[str, Any],
        *,
        route_minutes: float,
        now: datetime,
        deadline: datetime,
        service_window_started_at: datetime,
    ) -> list[str]:
        """Reconcile route evidence with both deterministic time authorities.

        The matcher reserves 30 minutes for handling and treats a recipient's
        pickup window as an availability horizon beginning when matching
        started. Route-provider output may only make that earlier decision
        stricter, so the same margins are checked again before notification.
        """
        if route_minutes <= 0:
            return ["route_cannot_meet_donor_deadline"]

        expected_handoff = now + timedelta(
            minutes=route_minutes + ROUTE_HANDLING_BUFFER_MINUTES
        )
        reasons: list[str] = []
        if expected_handoff > deadline:
            reasons.append("route_cannot_meet_donor_deadline")

        pickup_window = candidate.get("pickup_window_hours")
        if pickup_window is None:
            clock = candidate.get("clock")
            if isinstance(clock, Mapping):
                pickup_window = clock.get("recipient_pickup_window_hours")
        if pickup_window is not None:
            try:
                recipient_horizon = service_window_started_at + timedelta(
                    hours=float(pickup_window)
                )
            except (TypeError, ValueError, OverflowError):
                reasons.append("route_recipient_service_horizon_invalid")
            else:
                if expected_handoff > recipient_horizon:
                    reasons.append("route_cannot_meet_recipient_service_horizon")
        return reasons

    def _validate_offer(self, payload: Mapping[str, Any], now: datetime) -> dict[str, Any]:
        required = [
            "description",
            "quantity_pallets",
            "storage_state",
            "pickup_deadline",
            "donor_latitude",
            "donor_longitude",
        ]
        missing = [name for name in required if payload.get(name) in {None, ""}]
        if missing:
            raise WorkflowError("missing_fields", f"Missing required fields: {', '.join(missing)}")
        deadline = parse_time(str(payload["pickup_deadline"]))
        if deadline <= now:
            raise WorkflowError("deadline_elapsed", "The pickup deadline must be in the future.")
        quantity = float(payload["quantity_pallets"])
        if not 0 < quantity <= 1000:
            raise WorkflowError("invalid_quantity", "quantity_pallets must be greater than zero.")
        storage = str(payload["storage_state"]).lower()
        if storage not in {"ambient", "refrigerated", "frozen"}:
            raise WorkflowError("invalid_storage_state", "Unsupported storage state.")
        lat, lon = float(payload["donor_latitude"]), float(payload["donor_longitude"])
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise WorkflowError("invalid_location", "Invalid donor coordinates.")
        if not within_atlanta_service_area(lat, lon):
            raise WorkflowError(
                "outside_atlanta_service_area",
                "Donor coordinates must be within the Atlanta service area.",
            )
        transport = str(payload.get("transport_mode", "recipient_pickup"))
        if transport not in {"recipient_pickup", "donor_delivery", "transportation_needed"}:
            raise WorkflowError("invalid_transport_mode", "Unsupported transport mode.")
        radius = payload.get("donor_delivery_radius_km")
        if transport == "donor_delivery":
            radius = float(radius or 5)
            if not 0 < radius <= 5:
                raise WorkflowError(
                    "delivery_radius_exceeded", "Donor delivery radius must be at most 5 km."
                )
        return {
            **dict(payload),
            "description": str(payload["description"]).strip(),
            "quantity_pallets": quantity,
            "quantity_original": str(payload.get("quantity_original") or f"{quantity:g} pallet equivalents"),
            "storage_state": storage,
            "pickup_deadline": _iso(deadline),
            "donor_latitude": lat,
            "donor_longitude": lon,
            "location_source": str(payload.get("location_source", "corrected_pin")),
            "transport_mode": transport,
            "donor_delivery_radius_km": radius,
        }

    async def create_offer(
        self,
        payload: Mapping[str, Any],
        *,
        idempotency_key: str,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        at = now or utc_now()
        clean = self._validate_offer(payload, at)
        receipt_id = self._receipt_key("public-donor", "create-offer", idempotency_key)
        offer_id = _stable_id("offer", receipt_id)
        existing = self.repository.snapshot()
        replay = self._replay(existing, receipt_id, clean)
        if replay:
            result = self._create_response_tokens(
                existing, offer_id, receipt_id, replay, at
            )
            result.pop("_tasks", None)
            result["status_url"] = result["status_url"].replace(
                "{status_token}", result["status_token"]
            )
            return result

        candidates, rejections, match_warnings, match_evidence, agent_trace = (
            await self._candidates(clean, at)
        )

        def operation(state: dict[str, Any]) -> dict[str, Any]:
            replay = self._replay(state, receipt_id, clean)
            if replay:
                return self._create_response_tokens(state, offer_id, receipt_id, replay, at)
            filtered: list[dict[str, Any]] = []
            persisted_rejections = list(rejections)
            for item in candidates:
                candidate = dict(item)
                rid = str(candidate.get("recipient_id") or _stable_id("recipient", str(candidate.get("name"))))
                candidate["recipient_id"] = rid
                max_capacity = float(candidate.get("max_pallets") or candidate.get("capacity", {}).get("max_pallets") or clean["quantity_pallets"])
                recipient = state["recipients"].setdefault(
                    rid,
                    {
                        "recipient_id": rid,
                        "name": candidate.get("name") or rid,
                        "capacity_pallets": max_capacity,
                        "reserved_pallets": 0.0,
                        "cold_storage": candidate.get("cold_storage"),
                        "latitude": candidate.get("latitude"),
                        "longitude": candidate.get("longitude"),
                        "generated_operational_attributes": True,
                        "updated_at": _iso(at),
                    },
                )
                available = float(recipient["capacity_pallets"]) - float(recipient["reserved_pallets"])
                reason = None
                if available < clean["quantity_pallets"]:
                    reason = "known_reserved_capacity_insufficient"
                if clean["transport_mode"] == "donor_delivery":
                    max_miles = float(clean["donor_delivery_radius_km"]) * 0.621371
                    if candidate.get("distance_miles") is None or float(candidate["distance_miles"]) > max_miles:
                        reason = "donor_delivery_route_exceeds_radius"
                if reason:
                    candidate.update({"eligible": False, "reasons": [reason]})
                    persisted_rejections.append(candidate)
                    continue
                candidate.update(
                    {
                        "offer_id": offer_id,
                        "rank": int(candidate.get("rank") or len(filtered) + 1),
                        "eligible": True,
                        "wave": None,
                        "notification_status": "not_sent",
                        "response": "pending",
                    }
                )
                filtered.append(candidate)

            status = "matching"
            offer = {
                "offer_id": offer_id,
                "status": status,
                "created_at": _iso(at),
                "updated_at": _iso(at),
                "deadline": clean["pickup_deadline"],
                "description_original": clean["description"],
                "description_structured": clean["description"],
                "quantity_original": clean["quantity_original"],
                "quantity_pallets": clean["quantity_pallets"],
                "storage_state": clean["storage_state"],
                "pickup_address": clean.get("pickup_address", ""),
                "pickup_geopoint": {"latitude": clean["donor_latitude"], "longitude": clean["donor_longitude"]},
                "location_source": clean["location_source"],
                "transport_mode": clean["transport_mode"],
                "donor_delivery_radius_km": clean.get("donor_delivery_radius_km"),
                "selected_recipient_id": None,
                "active_reservation_id": None,
                "reservation_expires_at": None,
                "lease_version": 0,
                "current_wave": 0,
                "wave_version": 0,
                "wave_started_at": None,
                "wave_expires_at": None,
                "candidates": {c["recipient_id"]: c for c in filtered},
                "rejections": persisted_rejections,
                "warnings": match_warnings,
                "match_evidence": match_evidence,
                "agent_trace": agent_trace,
                "scheduler_warnings": [],
                "foodkeeper_advisory": lookup_foodkeeper(
                    clean["description"], clean["storage_state"]
                ),
            }
            state["offers"][offer_id] = offer
            self._event(state, offer_id, "offer_submitted", "donor", "anonymous", "Offer submitted for deterministic matching.", at)
            if clean["transport_mode"] == "transportation_needed":
                offer["status"] = "needs_transport"
                self._event(state, offer_id, "transport_needed", "system", "workflow", "A safe transport arrangement is required before notification.", at)
                tasks: list[dict[str, Any]] = []
            else:
                tasks = self._open_next_wave(state, offer, at)
            response = {
                "offer_id": offer_id,
                "status": offer["status"],
                "status_url": f"/?role=status#token={{status_token}}",
                "notifications_count": sum(1 for c in filtered if c["notification_status"] == "sent"),
                "_tasks": tasks,
            }
            self._save_receipt(state, receipt_id, clean, response, at)
            return self._create_response_tokens(state, offer_id, receipt_id, response, at)

        result = self.repository.transact(operation)
        self._schedule_descriptors(result.pop("_tasks", []), offer_id)
        result["status_url"] = result["status_url"].replace("{status_token}", result["status_token"])
        return result

    def _create_response_tokens(
        self,
        state: dict[str, Any],
        offer_id: str,
        receipt_id: str,
        response: Mapping[str, Any],
        now: datetime,
    ) -> dict[str, Any]:
        result = dict(response)
        result["status_token"] = self.tokens.issue_deterministic(
            state,
            token_key=f"{receipt_id}:donor",
            actor_type="donor",
            actor_id=offer_id,
            offer_id=offer_id,
            actions=["offer:status", "offer:complete"],
            now=now,
        )
        offer = state["offers"][offer_id]
        offer["donor_status_token_hash"] = self.tokens.digest(result["status_token"])
        if self.demo_mode:
            access = []
            for rid, candidate in sorted(offer["candidates"].items(), key=lambda row: row[1]["rank"]):
                raw = self.tokens.issue_deterministic(
                    state,
                    token_key=f"demo-recipient:{offer_id}:{rid}",
                    actor_type="recipient",
                    actor_id=rid,
                    offer_id=offer_id,
                    actions=["recipient:inbox", "offer:claim", "offer:decline", "reservation:confirm", "offer:complete"],
                    now=now,
                )
                access.append({"recipient_id": rid, "name": candidate.get("name", rid), "token": raw, "role_url": f"/?role=recipient#token={raw}"})
            result["recipient_access"] = access
        return result

    def _open_next_wave(self, state: dict[str, Any], offer: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
        if offer.get("active_reservation_id"):
            return []
        unnotified = [c for c in offer["candidates"].values() if c["notification_status"] == "not_sent"]
        unnotified.sort(key=lambda c: (c["rank"], c["recipient_id"]))
        wave = unnotified[:3]
        if not wave:
            offer["status"] = "no_match"
            offer["updated_at"] = _iso(now)
            self._event(state, offer["offer_id"], "no_match", "system", "workflow", "No additional eligible recipient candidates remain.", now)
            return []
        offer["current_wave"] += 1
        offer["wave_version"] += 1
        offer["wave_started_at"] = _iso(now)
        expires = min(now + timedelta(minutes=self.response_window_minutes), parse_time(offer["deadline"]))
        offer["wave_expires_at"] = _iso(expires)
        offer["status"] = "notified"
        offer["updated_at"] = _iso(now)
        for candidate in wave:
            candidate["wave"] = offer["current_wave"]
            candidate["notification_status"] = "sent"
            candidate["notified_at"] = _iso(now)
            notification_id = f"{offer['offer_id']}:{offer['wave_version']}:{candidate['recipient_id']}"
            state["notifications"].setdefault(
                notification_id,
                {
                    "notification_id": notification_id,
                    "offer_id": offer["offer_id"],
                    "recipient_id": candidate["recipient_id"],
                    "title": "Refrigerated food rescue available" if offer["storage_state"] != "ambient" else "Food rescue available",
                    # The donor's description often already contains the quantity
                    # (for example, "10 crates of spinach"). Keep the notification
                    # sentence natural and show normalized quantity separately.
                    "message": f"{offer['description_structured']} needs a response before the deadline.",
                    "created_at": _iso(now),
                    "deadline": offer["deadline"],
                    "simulated": True,
                    "read": False,
                },
            )
        self._event(state, offer["offer_id"], "wave_notified", "system", "workflow", f"Notified {len(wave)} pre-approved recipients in simulated wave {offer['current_wave']}.", now)
        return [{"task_name": f"expire-wave-{offer['offer_id']}-{offer['wave_version']}", "run_at": offer["wave_expires_at"], "payload": {"offer_id": offer["offer_id"], "kind": "wave", "wave_version": offer["wave_version"]}}]

    def _schedule_descriptors(self, descriptors: list[dict[str, Any]], offer_id: str) -> None:
        for descriptor in descriptors:
            try:
                self.scheduler.schedule(**descriptor)
            except Exception as exc:
                def warning(state: dict[str, Any]) -> None:
                    offer = state["offers"].get(offer_id)
                    if offer:
                        offer["scheduler_warnings"].append("Expiration task enqueue failed; lazy expiry remains active.")
                self.repository.transact(warning)

    def _release_capacity(self, state: dict[str, Any], reservation: dict[str, Any], now: datetime) -> None:
        if reservation.get("capacity_released"):
            return
        recipient = state["recipients"][reservation["recipient_id"]]
        recipient["reserved_pallets"] = max(0.0, float(recipient["reserved_pallets"]) - float(reservation["quantity_pallets"]))
        recipient["updated_at"] = _iso(now)
        reservation["capacity_released"] = True

    def _advance_state(
        self,
        state: dict[str, Any],
        offer: dict[str, Any],
        now: datetime,
        *,
        expected_kind: str | None = None,
        expected_lease_version: int | None = None,
        expected_wave_version: int | None = None,
        force: bool = False,
    ) -> tuple[bool, list[dict[str, Any]]]:
        if offer["status"] in TERMINAL_STATUSES or offer["status"] == "confirmed":
            return False, []
        if expected_kind == "reservation" and expected_lease_version != offer["lease_version"]:
            return False, []
        if expected_kind == "wave" and expected_wave_version != offer["wave_version"]:
            return False, []
        deadline = parse_time(offer["deadline"])
        tasks: list[dict[str, Any]] = []
        changed = False
        reservation_id = offer.get("active_reservation_id")
        if reservation_id:
            reservation = state["reservations"][reservation_id]
            due = parse_time(reservation["expires_at"]) <= now
            if reservation["status"] == "active" and (due or (force and expected_kind != "wave")):
                reservation["status"] = "expired"
                reservation["expired_at"] = _iso(now)
                self._release_capacity(state, reservation, now)
                holder = offer["candidates"][reservation["recipient_id"]]
                holder["response"] = "hold_expired"
                holder["responded_at"] = _iso(now)
                offer["active_reservation_id"] = None
                offer["reservation_expires_at"] = None
                offer["selected_recipient_id"] = None
                offer["status"] = "notified"
                self._event(state, offer["offer_id"], "reservation_expired", "system", "workflow", "The temporary hold expired and reserved capacity was released.", now)
                changed = True
        if now >= deadline:
            for candidate in offer["candidates"].values():
                if candidate["response"] == "pending":
                    candidate["response"] = "timed_out"
                    candidate["responded_at"] = _iso(now)
            offer["status"] = "expired"
            offer["updated_at"] = _iso(now)
            if not changed:
                self._event(state, offer["offer_id"], "offer_expired", "system", "workflow", "The donor-confirmed pickup deadline passed.", now)
            return True, []
        if offer.get("active_reservation_id"):
            return changed, tasks
        current = [c for c in offer["candidates"].values() if c.get("wave") == offer["current_wave"]]
        all_answered = bool(current) and all(c["response"] != "pending" for c in current)
        wave_due = bool(offer.get("wave_expires_at")) and parse_time(offer["wave_expires_at"]) <= now
        if force or wave_due or all_answered:
            for candidate in current:
                if candidate["response"] == "pending":
                    candidate["response"] = "timed_out"
                    candidate["responded_at"] = _iso(now)
            tasks.extend(self._open_next_wave(state, offer, now))
            changed = True
        return changed, tasks

    def advance_offer_if_due(
        self,
        offer_id: str,
        *,
        kind: str | None = None,
        lease_version: int | None = None,
        wave_version: int | None = None,
        force: bool = False,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        at = now or utc_now()
        def operation(state: dict[str, Any]) -> dict[str, Any]:
            offer = state["offers"].get(offer_id)
            if not offer:
                raise WorkflowError("offer_not_found", "Offer not found.", status_code=404)
            changed, tasks = self._advance_state(state, offer, at, expected_kind=kind, expected_lease_version=lease_version, expected_wave_version=wave_version, force=force)
            return {"offer_id": offer_id, "status": offer["status"], "advanced": changed, "_tasks": tasks}
        result = self.repository.transact(operation)
        self._schedule_descriptors(result.pop("_tasks", []), offer_id)
        return result

    def _demo_recipient_access(self, offer: Mapping[str, Any]) -> list[dict[str, Any]]:
        if not self.demo_mode:
            return []
        access: list[dict[str, Any]] = []
        candidates = sorted(
            offer["candidates"].values(),
            key=lambda candidate: (candidate["rank"], candidate["recipient_id"]),
        )
        for candidate in candidates:
            rid = candidate["recipient_id"]
            raw = self.tokens.derive_deterministic(
                f"demo-recipient:{offer['offer_id']}:{rid}"
            )
            access.append(
                {
                    "recipient_id": rid,
                    "name": candidate.get("name", rid),
                    "token": raw,
                    "role_url": f"/?role=recipient#token={raw}",
                    "wave": candidate.get("wave"),
                    "notification_status": candidate.get("notification_status"),
                }
            )
        return access

    def _map_projection(
        self,
        state: Mapping[str, Any],
        offer: Mapping[str, Any],
        *,
        viewer: str,
        actor_id: str,
    ) -> dict[str, Any]:
        donor_visible = viewer in {"donor", "coordinator"} or (
            viewer == "recipient"
            and self._recipient_has_location_access(state, offer, actor_id)
        )
        donor = None
        if donor_visible:
            reviewed_address = offer.get("location_source") == "address"
            donor = {
                **offer["pickup_geopoint"],
                "address": offer.get("pickup_address", ""),
                "label": "Reviewed donor pickup location",
                "precision": (
                    "reviewed_address_candidate"
                    if reviewed_address
                    else "reviewed_exact"
                ),
            }
        markers: list[dict[str, Any]] = []
        for candidate in sorted(
            offer["candidates"].values(), key=lambda item: item["rank"]
        ):
            recipient = state["recipients"].get(candidate["recipient_id"], {})
            latitude = candidate.get("latitude", recipient.get("latitude"))
            longitude = candidate.get("longitude", recipient.get("longitude"))
            if latitude is None or longitude is None:
                continue
            travel = candidate.get("travel") or {}
            transport = candidate.get("transport") or {}
            markers.append(
                {
                    "recipient_id": candidate["recipient_id"],
                    "name": candidate.get("name", candidate["recipient_id"]),
                    "latitude": latitude,
                    "longitude": longitude,
                    "precision": "approximate_zip_centroid",
                    "distance_miles": travel.get(
                        "distance_miles", candidate.get("distance_miles")
                    ),
                    "estimated_minutes": travel.get("estimated_minutes"),
                    "route_source": travel.get(
                        "distance_source",
                        transport.get(
                            "distance_source",
                            "haversine_from_approximate_zip_centroid",
                        ),
                    ),
                    "traffic_aware": bool(travel.get("traffic_aware", False)),
                    "safety_override": False,
                    "selected": offer.get("selected_recipient_id")
                    == candidate["recipient_id"],
                    "response": candidate.get("response"),
                }
            )
        return {
            "donor": donor,
            "recipients": markers,
            "tracking": False,
            "limitations": [
                "Recipient markers are approximate ZIP centroids.",
                "Route values are estimates, not live traffic or GPS tracking.",
            ],
        }

    def _recipient_has_location_access(
        self,
        state: Mapping[str, Any],
        offer: Mapping[str, Any],
        recipient_id: str,
    ) -> bool:
        if offer.get("selected_recipient_id") != recipient_id:
            return False
        reservation_id = offer.get("active_reservation_id")
        reservation = state["reservations"].get(reservation_id) if reservation_id else None
        if not reservation or reservation.get("recipient_id") != recipient_id:
            return False
        status = offer.get("status")
        if status == "reserved":
            return reservation.get("status") == "active"
        if status == "confirmed":
            return reservation.get("status") == "confirmed"
        if status == "completed":
            return (
                reservation.get("status") == "released"
                and reservation.get("release_reason") == "completed"
            )
        return False

    def status(self, raw_token: str, *, now: datetime | None = None) -> dict[str, Any]:
        at = now or utc_now()
        snapshot = self.repository.snapshot()
        token = self.tokens.authenticate(snapshot, raw_token, action="offer:status", now=at)
        offer_id = token["offer_id"]
        self.advance_offer_if_due(offer_id, now=at)
        state = self.repository.snapshot()
        offer = state["offers"][offer_id]
        result = self._offer_projection(
            state, offer, viewer="donor", actor_id=offer_id
        )
        if self.demo_mode:
            # These raw tokens are regenerated only after donor authorization;
            # they remain absent from persistence, logs, public summaries, and
            # coordinator responses.
            result["demo_recipient_access"] = self._demo_recipient_access(offer)
        return result

    def inbox(self, raw_token: str, *, now: datetime | None = None) -> dict[str, Any]:
        at = now or utc_now()
        state = self.repository.snapshot()
        token = self.tokens.authenticate(state, raw_token, action="recipient:inbox", now=at)
        rid = token["actor_id"]
        scoped_offer_id = token.get("offer_id")
        relevant = [
            n
            for n in state["notifications"].values()
            if n["recipient_id"] == rid
            and (scoped_offer_id is None or n["offer_id"] == scoped_offer_id)
        ]
        for note in relevant:
            self.advance_offer_if_due(note["offer_id"], now=at)
        state = self.repository.snapshot()
        notes = []
        for note in sorted(
            (
                n
                for n in state["notifications"].values()
                if n["recipient_id"] == rid
                and (scoped_offer_id is None or n["offer_id"] == scoped_offer_id)
            ),
            key=lambda n: n["created_at"],
            reverse=True,
        ):
            offer = state["offers"][note["offer_id"]]
            candidate = offer["candidates"][rid]
            donor_location = None
            if self._recipient_has_location_access(state, offer, rid):
                donor_location = {"address": offer["pickup_address"], **offer["pickup_geopoint"]}
            notes.append({**note, "response": candidate["response"], "offer": {"description": offer["description_structured"], "quantity_original": offer["quantity_original"], "quantity_pallets": offer["quantity_pallets"], "storage_state": offer["storage_state"], "transport_mode": offer["transport_mode"], "distance_miles": candidate.get("distance_miles"), "deadline": offer["deadline"], "status": offer["status"], "donor_location": donor_location, "map": self._map_projection(state, offer, viewer="recipient", actor_id=rid)}})
            if offer.get("selected_recipient_id") == rid and offer.get("active_reservation_id"):
                notes[-1]["reservation"] = state["reservations"].get(offer["active_reservation_id"])
        return {"recipient": state["recipients"].get(rid, {"recipient_id": rid, "name": rid}), "notifications": notes}

    def _offer_projection(self, state: dict[str, Any], offer: dict[str, Any], *, viewer: str, actor_id: str) -> dict[str, Any]:
        public = {key: value for key, value in offer.items() if key not in {"candidates", "donor_status_token_hash"}}
        if viewer == "recipient" and offer.get("selected_recipient_id") != actor_id:
            public.pop("pickup_geopoint", None)
            public.pop("pickup_address", None)
        reservation = state["reservations"].get(offer.get("active_reservation_id"))
        return {"offer": public, "events": list(state["events"].get(offer["offer_id"], [])), "candidates": sorted(offer["candidates"].values(), key=lambda c: c["rank"]), "reservation": reservation, "map": self._map_projection(state, offer, viewer=viewer, actor_id=actor_id)}

    def claim(self, offer_id: str, raw_token: str, request: Mapping[str, Any], *, idempotency_key: str, now: datetime | None = None) -> dict[str, Any]:
        at = now or utc_now()
        def operation(state: dict[str, Any]) -> dict[str, Any]:
            token = self.tokens.authenticate(state, raw_token, action="offer:claim", offer_id=offer_id, now=at)
            rid = token["actor_id"]
            receipt_id = self._receipt_key(f"recipient:{rid}", f"claim:{offer_id}", idempotency_key)
            replay = self._replay(state, receipt_id, request)
            if replay:
                return replay
            offer = state["offers"].get(offer_id)
            if not offer:
                raise WorkflowError("offer_not_found", "Offer not found.", status_code=404)
            self._advance_state(state, offer, at)
            candidate = offer["candidates"].get(rid)
            if not candidate or not candidate["eligible"] or candidate.get("wave") != offer["current_wave"]:
                raise WorkflowError("candidate_not_eligible", "Recipient is not eligible in the current wave.", status_code=403)
            if candidate["response"] != "pending":
                raise WorkflowError("candidate_response_closed", "This action is no longer valid.", status_code=409)
            if offer.get("active_reservation_id"):
                raise WorkflowError("offer_currently_held", "Another recipient currently holds this offer.", status_code=409, hold_expires_at=offer["reservation_expires_at"])
            if offer["status"] not in {"notified"} or at >= parse_time(offer["deadline"]):
                raise WorkflowError("offer_not_claimable", "The offer is not claimable.", status_code=409)
            recipient = state["recipients"][rid]
            available = float(recipient["capacity_pallets"]) - float(recipient["reserved_pallets"])
            if available < offer["quantity_pallets"]:
                raise WorkflowError("capacity_unavailable", "Known recipient capacity is no longer available.", status_code=409)
            offer["lease_version"] += 1
            reservation_id = _stable_id("reservation", f"{offer_id}:{offer['lease_version']}:{rid}")
            expires = min(at + timedelta(minutes=self.hold_minutes), parse_time(offer["deadline"]))
            reservation = {"reservation_id": reservation_id, "offer_id": offer_id, "recipient_id": rid, "status": "active", "created_at": _iso(at), "expires_at": _iso(expires), "lease_version": offer["lease_version"], "quantity_pallets": offer["quantity_pallets"], "capacity_released": False}
            state["reservations"][reservation_id] = reservation
            recipient["reserved_pallets"] = float(recipient["reserved_pallets"]) + offer["quantity_pallets"]
            recipient["updated_at"] = _iso(at)
            candidate["response"] = "holding"
            candidate["responded_at"] = _iso(at)
            offer.update({"status": "reserved", "active_reservation_id": reservation_id, "reservation_expires_at": _iso(expires), "selected_recipient_id": rid, "updated_at": _iso(at)})
            self._event(state, offer_id, "offer_held", "recipient", rid, "A qualified recipient placed a temporary hold.", at)
            result = {"offer_id": offer_id, "status": "reserved", "reservation": reservation, "_tasks": [{"task_name": f"expire-reservation-{offer_id}-{offer['lease_version']}", "run_at": _iso(expires), "payload": {"offer_id": offer_id, "reservation_id": reservation_id, "kind": "reservation", "lease_version": offer["lease_version"]}}]}
            self._save_receipt(state, receipt_id, request, result, at)
            return result
        result = self.repository.transact(operation)
        self._schedule_descriptors(result.pop("_tasks", []), offer_id)
        return result

    def decline(self, offer_id: str, raw_token: str, request: Mapping[str, Any], *, idempotency_key: str, now: datetime | None = None) -> dict[str, Any]:
        at = now or utc_now()
        def operation(state: dict[str, Any]) -> dict[str, Any]:
            token = self.tokens.authenticate(state, raw_token, action="offer:decline", offer_id=offer_id, now=at)
            rid = token["actor_id"]
            receipt_id = self._receipt_key(f"recipient:{rid}", f"decline:{offer_id}", idempotency_key)
            replay = self._replay(state, receipt_id, request)
            if replay:
                return replay
            offer = state["offers"].get(offer_id)
            if not offer:
                raise WorkflowError("offer_not_found", "Offer not found.", status_code=404)
            self._advance_state(state, offer, at)
            candidate = offer["candidates"].get(rid)
            if not candidate or candidate["response"] != "pending":
                raise WorkflowError("candidate_response_closed", "This response is no longer pending.", status_code=409)
            candidate.update({"response": "declined", "responded_at": _iso(at), "decline_reason": str(request.get("reason", ""))[:500]})
            self._event(state, offer_id, "candidate_declined", "recipient", rid, "A notified recipient declined the offer.", at)
            _, tasks = self._advance_state(state, offer, at)
            result = {"offer_id": offer_id, "status": offer["status"], "response": "declined", "_tasks": tasks}
            self._save_receipt(state, receipt_id, request, result, at)
            return result
        result = self.repository.transact(operation)
        self._schedule_descriptors(result.pop("_tasks", []), offer_id)
        return result

    def confirm(self, reservation_id: str, raw_token: str, request: Mapping[str, Any], *, idempotency_key: str, now: datetime | None = None) -> dict[str, Any]:
        at = now or utc_now()
        def operation(state: dict[str, Any]) -> dict[str, Any]:
            reservation = state["reservations"].get(reservation_id)
            if not reservation:
                raise WorkflowError("reservation_not_found", "Reservation not found.", status_code=404)
            token = self.tokens.authenticate(state, raw_token, action="reservation:confirm", offer_id=reservation["offer_id"], now=at)
            rid = token["actor_id"]
            if rid != reservation["recipient_id"]:
                raise AuthorizationError("reservation_scope_mismatch", "Reservation belongs to another recipient.", status_code=403)
            receipt_id = self._receipt_key(f"recipient:{rid}", f"confirm:{reservation_id}", idempotency_key)
            replay = self._replay(state, receipt_id, request)
            if replay:
                return replay
            offer = state["offers"][reservation["offer_id"]]
            self._advance_state(state, offer, at)
            if reservation["status"] != "active" or offer.get("active_reservation_id") != reservation_id:
                raise WorkflowError("reservation_expired", "The reservation is no longer active.", status_code=409)
            try:
                handoff = parse_time(str(request["expected_handoff_time"]))
            except (KeyError, ValueError):
                raise WorkflowError("invalid_handoff_time", "A timezone-aware expected_handoff_time is required.")
            if not at < handoff <= parse_time(offer["deadline"]):
                raise WorkflowError("invalid_handoff_time", "Expected handoff must be after now and no later than the deadline.")
            if offer["transport_mode"] == "transportation_needed":
                raise WorkflowError("transport_unresolved", "Safe transport must be resolved before confirmation.", status_code=409)
            reservation.update({"status": "confirmed", "confirmed_at": _iso(at), "confirmation_details": {"expected_handoff_time": _iso(handoff), "contact_name": str(request.get("contact_name", ""))[:200], "contact_phone": str(request.get("contact_phone", ""))[:80], "transport_mode": request.get("transport_mode", offer["transport_mode"])}})
            offer.update({"status": "confirmed", "updated_at": _iso(at)})
            for candidate in offer["candidates"].values():
                if candidate["recipient_id"] == rid:
                    candidate["response"] = "won"
                elif candidate["response"] == "pending":
                    candidate["response"] = "invalidated"
                    candidate["responded_at"] = _iso(at)
            self._event(state, offer["offer_id"], "handoff_confirmed", "recipient", rid, "The recipient confirmed capacity, contact, and handoff time.", at)
            result = {"offer_id": offer["offer_id"], "status": "confirmed", "reservation": reservation}
            self._save_receipt(state, receipt_id, request, result, at)
            return result
        return self.repository.transact(operation)

    def complete(self, offer_id: str, raw_token: str, request: Mapping[str, Any], *, idempotency_key: str, now: datetime | None = None) -> dict[str, Any]:
        at = now or utc_now()
        def operation(state: dict[str, Any]) -> dict[str, Any]:
            token = None
            for action in ("offer:complete",):
                token = self.tokens.authenticate(state, raw_token, action=action, offer_id=offer_id, now=at)
            actor = f"{token['actor_type']}:{token['actor_id']}"
            receipt_id = self._receipt_key(actor, f"complete:{offer_id}", idempotency_key)
            replay = self._replay(state, receipt_id, request)
            if replay:
                return replay
            offer = state["offers"].get(offer_id)
            if not offer:
                raise WorkflowError("offer_not_found", "Offer not found.", status_code=404)
            if offer["status"] != "confirmed":
                raise WorkflowError("offer_not_confirmed", "Only a confirmed offer can be completed.", status_code=409)
            reservation = state["reservations"][offer["active_reservation_id"]]
            if token["actor_type"] == "recipient" and (
                token["actor_id"] != offer.get("selected_recipient_id")
                or token["actor_id"] != reservation.get("recipient_id")
            ):
                raise AuthorizationError(
                    "winner_scope_mismatch",
                    "Only the selected recipient may complete this offer.",
                    status_code=403,
                )
            self._release_capacity(state, reservation, at)
            reservation["status"] = "released"
            reservation["release_reason"] = "completed"
            actual = request.get("actual_quantity_pallets")
            if actual is not None and not 0 < float(actual) <= offer["quantity_pallets"] * 2:
                raise WorkflowError("invalid_actual_quantity", "Invalid completed quantity.")
            offer.update({"status": "completed", "completed_at": _iso(at), "completed_quantity": float(actual) if actual is not None else offer["quantity_pallets"], "completed_quantity_estimated": actual is None, "completion_note": str(request.get("note", ""))[:1000], "updated_at": _iso(at)})
            self._event(state, offer_id, "handoff_completed", token["actor_type"], token["actor_id"], "The food handoff was marked complete.", at)
            result = {"offer_id": offer_id, "status": "completed", "completed_quantity_pallets": offer["completed_quantity"], "estimated": offer["completed_quantity_estimated"]}
            self._save_receipt(state, receipt_id, request, result, at)
            return result
        return self.repository.transact(operation)

    def _summary(self, state: Mapping[str, Any]) -> dict[str, Any]:
        offers = list(state["offers"].values())
        completed = [offer for offer in offers if offer["status"] == "completed"]
        completed_quantity = sum(
            float(offer.get("completed_quantity") or 0) for offer in completed
        )
        actual_quantity = sum(
            float(offer.get("completed_quantity") or 0)
            for offer in completed
            if not offer.get("completed_quantity_estimated", False)
        )
        estimated_quantity = completed_quantity - actual_quantity
        activity = {
            "as_of": _iso(utc_now()),
            "data_scope": "this_demo_environment",
            "authoritative_workflow_snapshot": True,
            "external_live_capacity": False,
            "total_offers": len(offers),
            "active_offers": sum(
                offer["status"] not in TERMINAL_STATUSES for offer in offers
            ),
            "waiting_offers": sum(offer["status"] == "notified" for offer in offers),
            "active_holds": sum(offer["status"] == "reserved" for offer in offers),
            "confirmed_handoffs": sum(
                offer["status"] == "confirmed" for offer in offers
            ),
            "needs_transport": sum(
                offer["status"] == "needs_transport" for offer in offers
            ),
            "no_match": sum(offer["status"] == "no_match" for offer in offers),
            "simulated_notifications_created": len(state["notifications"]),
        }
        impact = {
            "completed_offers": len(completed),
            "completed_quantity_pallets": completed_quantity,
            "actual_quantity_pallets": actual_quantity,
            "estimated_quantity_pallets": estimated_quantity,
        }
        return {"activity": activity, "impact": impact}

    def public_summary(self) -> dict[str, Any]:
        summary = self._summary(self.repository.snapshot())
        return {
            **summary,
            "labels": {
                "notifications": "Simulated in-app delivery",
                "recipient_operations": "Generated profiles; live confirmation required",
                "locations": "Recipient points are approximate ZIP centroids",
                "impact": "Only completed workflow offers are counted",
            },
        }

    def ops_offers(self) -> dict[str, Any]:
        state = self.repository.snapshot()
        offers = []
        for offer in sorted(state["offers"].values(), key=lambda item: item["created_at"], reverse=True):
            offers.append(self._offer_projection(state, offer, viewer="coordinator", actor_id="coordinator"))
        return {"offers": offers, **self._summary(state)}

    def ops_action(self, offer_id: str, action: str, request: Mapping[str, Any], *, idempotency_key: str, now: datetime | None = None) -> dict[str, Any]:
        at = now or utc_now()
        receipt_id = self._receipt_key("coordinator", f"{action}:{offer_id}", idempotency_key)
        if action in {"expire", "promote"}:
            def advance_operation(state: dict[str, Any]) -> dict[str, Any]:
                replay = self._replay(state, receipt_id, request)
                if replay:
                    return replay
                offer = state["offers"].get(offer_id)
                if not offer:
                    raise WorkflowError(
                        "offer_not_found", "Offer not found.", status_code=404
                    )
                if action == "promote" and offer.get("active_reservation_id"):
                    raise WorkflowError(
                        "active_reservation",
                        "A wave cannot be promoted while a reservation is active.",
                        status_code=409,
                    )
                changed, tasks = self._advance_state(
                    state, offer, at, force=True
                )
                result = {
                    "offer_id": offer_id,
                    "status": offer["status"],
                    "advanced": changed,
                    "_tasks": tasks,
                }
                self._save_receipt(state, receipt_id, request, result, at)
                return result

            advanced = self.repository.transact(advance_operation)
            self._schedule_descriptors(advanced.pop("_tasks", []), offer_id)
            return advanced
        def operation(state: dict[str, Any]) -> dict[str, Any]:
            replay = self._replay(state, receipt_id, request)
            if replay:
                return replay
            offer = state["offers"].get(offer_id)
            if not offer:
                raise WorkflowError("offer_not_found", "Offer not found.", status_code=404)
            if action in {"cancel", "fail"}:
                if offer["status"] in TERMINAL_STATUSES:
                    raise WorkflowError("invalid_transition", "Offer cannot transition from its current state.", status_code=409)
                if offer.get("active_reservation_id"):
                    reservation = state["reservations"][offer["active_reservation_id"]]
                    self._release_capacity(state, reservation, at)
                    reservation.update({"status": "released", "release_reason": action})
                offer.update({"status": "cancelled" if action == "cancel" else "failed", "outcome_reason": str(request.get("reason", ""))[:500], "active_reservation_id": None, "reservation_expires_at": None, "selected_recipient_id": None, "updated_at": _iso(at)})
                for candidate in offer["candidates"].values():
                    if candidate["response"] in {"pending", "holding", "won"}:
                        candidate["response"] = "invalidated"
                self._event(state, offer_id, f"offer_{offer['status']}", "coordinator", "demo-coordinator", f"Coordinator marked the offer {offer['status']}.", at)
            elif action == "resolve-transport":
                if offer["status"] != "needs_transport":
                    raise WorkflowError("invalid_transition", "Offer does not need transport resolution.", status_code=409)
                mode = request.get("transport_mode")
                if mode not in {"recipient_pickup", "donor_delivery"}:
                    raise WorkflowError("invalid_transport_mode", "A concrete transport mode is required.")
                radius = request.get("donor_delivery_radius_km", 5)
                if mode == "donor_delivery" and not 0 < float(radius) <= 5:
                    raise WorkflowError("delivery_radius_exceeded", "Donor delivery radius must be at most 5 km.")
                offer["transport_mode"] = mode
                offer["donor_delivery_radius_km"] = float(radius) if mode == "donor_delivery" else None
                rejected_ids: list[str] = []
                for rid, candidate in offer["candidates"].items():
                    travel = candidate.get("travel") or {}
                    known_distances = [
                        float(value)
                        for value in (
                            travel.get("distance_miles"),
                            candidate.get("distance_miles"),
                        )
                        if value is not None
                    ]
                    distance_miles = max(known_distances) if known_distances else None
                    estimated_minutes = travel.get("estimated_minutes")
                    reasons: list[str] = []
                    if estimated_minutes is not None:
                        reasons.extend(
                            self._route_time_rejections(
                                candidate,
                                route_minutes=float(estimated_minutes),
                                now=at,
                                deadline=parse_time(offer["deadline"]),
                                service_window_started_at=parse_time(
                                    offer["created_at"]
                                ),
                            )
                        )
                    if mode == "donor_delivery":
                        if distance_miles is None or float(distance_miles) * 1.609344 > float(radius):
                            reasons.append("route_exceeds_donor_delivery_radius")
                    if reasons:
                        rejected = dict(candidate)
                        rejected.update({"eligible": False, "reasons": reasons})
                        offer["rejections"].append(rejected)
                        rejected_ids.append(rid)
                for rid in rejected_ids:
                    del offer["candidates"][rid]
                for rank, candidate in enumerate(
                    sorted(
                        offer["candidates"].values(),
                        key=lambda item: (item["rank"], item["recipient_id"]),
                    ),
                    1,
                ):
                    candidate["rank"] = rank
                self._open_next_wave(state, offer, at)
            else:
                raise WorkflowError("unsupported_action", "Unsupported coordinator action.", status_code=404)
            result = {"offer_id": offer_id, "status": offer["status"]}
            self._save_receipt(state, receipt_id, request, result, at)
            return result
        return self.repository.transact(operation)

    def equity_audit(self) -> dict[str, Any]:
        state = self.repository.snapshot()
        postings = []
        for offer in list(sorted(state["offers"].values(), key=lambda o: o["created_at"], reverse=True))[:10]:
            candidates = sorted(offer["candidates"].values(), key=lambda c: c["rank"])
            selected = next((c for c in candidates if c["response"] == "won"), candidates[0] if candidates else None)
            postings.append({"offer_id": offer["offer_id"], "status": offer["status"], "recipient_id": selected.get("recipient_id") if selected else None, "need_evidence": selected.get("tract_need_evidence", {"source": "weekly_households_fallback", "label": "Demographic tract evidence unavailable"}) if selected else None})
        return {"postings": postings, "count": len(postings), "limitations": ["Recipient points are approximate ZIP centroids.", "Operational attributes are generated and require live confirmation."]}

