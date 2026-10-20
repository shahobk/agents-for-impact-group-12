from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor

import pytest

from agent.auth import AuthorizationError, TokenAuthority
from agent.locations import RouteEstimator
from agent.repository import InMemoryWorkflowRepository
from agent.tasks import InMemoryTaskScheduler
from agent.workflow import WorkflowError, WorkflowService


NOW = datetime(2026, 10, 20, 16, 0, tzinfo=timezone.utc)


def workflow(*, hold_minutes=10, response_minutes=10):
    repo = InMemoryWorkflowRepository()
    scheduler = InMemoryTaskScheduler()
    service = WorkflowService(
        repo,
        TokenAuthority("test-pepper", "ops-token"),
        scheduler,
        matcher=None,
        demo_mode=True,
        demo_fallback=True,
        hold_minutes=hold_minutes,
        response_window_minutes=response_minutes,
    )
    return service, repo, scheduler


def offer_payload(*, deadline=None, quantity=1.0, transport="recipient_pickup", radius=None):
    payload = {
        "description": "ten crates of refrigerated spinach",
        "quantity_original": "10 crates",
        "quantity_pallets": quantity,
        "storage_state": "refrigerated",
        "pickup_deadline": (deadline or NOW + timedelta(hours=6)).isoformat(),
        "donor_latitude": 33.749,
        "donor_longitude": -84.388,
        "pickup_address": "Atlanta grocery demo",
        "location_source": "corrected_pin",
        "transport_mode": transport,
    }
    if radius is not None:
        payload["donor_delivery_radius_km"] = radius
    return payload


def create(service, key="offer-1", **kwargs):
    return asyncio.run(
        service.create_offer(offer_payload(**kwargs), idempotency_key=key, now=NOW)
    )


def test_create_fans_out_three_and_persists_only_token_hashes():
    service, repo, scheduler = workflow()
    created = create(service)
    state = repo.snapshot()

    assert created["status"] == "notified"
    assert created["notifications_count"] == 3
    assert len(state["notifications"]) == 3
    assert all(
        "10 crates of 10 crates" not in notification["message"]
        for notification in state["notifications"].values()
    )
    assert len(created["recipient_access"]) == 6
    assert created["status_token"] not in str(state)
    assert all(task.startswith("expire-wave-") for task in scheduler.tasks)
    assert state["offers"][created["offer_id"]]["foodkeeper_advisory"]["label"].startswith("Advisory")


def test_create_command_replay_is_stable_and_conflict_is_rejected():
    service, repo, _ = workflow()
    first = create(service, "same-key")
    second = create(service, "same-key")
    assert second["offer_id"] == first["offer_id"]
    assert second["status_token"] == first["status_token"]
    assert len(repo.snapshot()["offers"]) == 1

    with pytest.raises(WorkflowError, match="different request"):
        create(service, "same-key", quantity=2)


def test_create_replay_does_not_rerun_matcher_and_persists_safe_evidence():
    calls = 0

    async def matcher(**_kwargs):
        nonlocal calls
        calls += 1
        return {
            "selected": {
                "recipient_id": "proof-recipient",
                "name": "Proof Pantry",
                "max_pallets": 5,
                "cold_storage": True,
                "latitude": 33.75,
                "longitude": -84.39,
                "distance_miles": 1.1,
            },
            "fallbacks": [],
            "rejections": [],
            "warnings": [],
            "retrieval_evidence": {
                "provider": "bigquery",
                "job_id": "safe-job-id",
                "query_label": "pantry_relay_match",
                "vector_search": True,
                "use_brute_force": True,
                "secret": "must-not-persist",
            },
        }

    repo = InMemoryWorkflowRepository()
    service = WorkflowService(
        repo,
        TokenAuthority("test-pepper", "ops-token"),
        InMemoryTaskScheduler(),
        matcher=matcher,
        demo_mode=True,
        demo_fallback=False,
    )
    first = create(service, "matcher-replay")
    second = create(service, "matcher-replay")

    assert first["offer_id"] == second["offer_id"]
    assert calls == 1
    evidence = repo.snapshot()["offers"][first["offer_id"]]["match_evidence"]
    assert evidence == {
        "provider": "bigquery",
        "job_id": "safe-job-id",
        "query_label": "pantry_relay_match",
        "vector_search": True,
        "use_brute_force": True,
    }


def test_workflow_enriches_at_most_three_eligible_candidates_with_route_evidence():
    route_calls = []

    async def matcher(**_kwargs):
        candidates = [
            {
                "recipient_id": f"route-{index}",
                "name": f"Route Pantry {index}",
                "max_pallets": 5,
                "cold_storage": True,
                "latitude": 33.75 + index * 0.01,
                "longitude": -84.39 - index * 0.01,
                "distance_miles": 1.0,
            }
            for index in range(4)
        ]
        return {
            "selected": candidates[0],
            "fallbacks": candidates[1:],
            "rejections": [],
            "warnings": [],
        }

    async def route_provider(origin_lat, origin_lon, destination_lat, destination_lon):
        route_calls.append((origin_lat, origin_lon, destination_lat, destination_lon))
        return {
            # The authoritative route exposes a donor-delivery contradiction.
            "distance_miles": 999,
            "estimated_minutes": 40,
            "traffic_aware": True,
            "safety_override": True,
        }

    repo = InMemoryWorkflowRepository()
    service = WorkflowService(
        repo,
        TokenAuthority("test-pepper", "ops-token"),
        InMemoryTaskScheduler(),
        matcher=matcher,
        route_estimator=RouteEstimator(route_provider),
        demo_mode=True,
        demo_fallback=False,
    )
    created = create(
        service,
        "routes-live",
        transport="donor_delivery",
        radius=5,
    )
    offer = repo.snapshot()["offers"][created["offer_id"]]
    candidates = sorted(
        offer["candidates"].values(),
        key=lambda candidate: candidate["rank"],
    )

    assert len(route_calls) == 3
    assert [candidate["recipient_id"] for candidate in candidates] == ["route-3"]
    route_rejections = [
        candidate
        for candidate in offer["rejections"]
        if "route_exceeds_donor_delivery_radius" in candidate.get("reasons", [])
    ]
    assert len(route_rejections) == 3
    assert all(
        candidate["travel"] == {
            "distance_miles": 999.0,
            "estimated_minutes": 40,
            "distance_source": "google_routes",
            "traffic_aware": True,
            "safety_override": False,
        }
        for candidate in route_rejections
    )
    assert candidates[0]["travel"]["distance_source"] == "haversine_fallback"
    assert candidates[0]["travel"]["safety_override"] is False


def test_workflow_records_haversine_route_evidence_when_provider_fails():
    async def matcher(**_kwargs):
        return {
            "selected": {
                "recipient_id": "route-fallback",
                "name": "Fallback Pantry",
                "max_pallets": 5,
                "cold_storage": True,
                "latitude": 33.76,
                "longitude": -84.37,
                "distance_miles": 1.5,
            },
            "fallbacks": [],
            "rejections": [],
            "warnings": [],
        }

    async def route_provider(*_coordinates):
        raise TimeoutError("routes unavailable")

    repo = InMemoryWorkflowRepository()
    service = WorkflowService(
        repo,
        TokenAuthority("test-pepper", "ops-token"),
        InMemoryTaskScheduler(),
        matcher=matcher,
        route_estimator=RouteEstimator(route_provider),
        demo_mode=True,
        demo_fallback=False,
    )
    created = create(service, "routes-fallback")
    candidate = next(
        iter(repo.snapshot()["offers"][created["offer_id"]]["candidates"].values())
    )

    assert candidate["eligible"] is True
    assert candidate["travel"]["distance_source"] == "haversine_fallback"
    assert candidate["travel"]["traffic_aware"] is False
    assert candidate["travel"]["safety_override"] is False


def test_route_reconciliation_rejects_trip_outside_recipient_service_horizon():
    async def matcher(**_kwargs):
        return {
            "selected": {
                "recipient_id": "short-window",
                "name": "Short Window Pantry",
                "max_pallets": 5,
                "cold_storage": True,
                "pickup_window_hours": 1,
                "latitude": 33.76,
                "longitude": -84.37,
                "distance_miles": 1.5,
            },
            "fallbacks": [],
            "rejections": [],
            "warnings": [],
        }

    async def route_provider(*_coordinates):
        return {
            "distance_miles": 1.5,
            "estimated_minutes": 120,
            "traffic_aware": True,
        }

    repo = InMemoryWorkflowRepository()
    service = WorkflowService(
        repo,
        TokenAuthority("test-pepper", "ops-token"),
        InMemoryTaskScheduler(),
        matcher=matcher,
        route_estimator=RouteEstimator(route_provider),
        demo_mode=True,
        demo_fallback=False,
    )

    created = create(service, "route-service-horizon")
    offer = repo.snapshot()["offers"][created["offer_id"]]

    assert created["status"] == "no_match"
    assert offer["candidates"] == {}
    assert offer["rejections"][0]["reasons"] == [
        "route_cannot_meet_recipient_service_horizon"
    ]


def test_transport_resolution_rechecks_handling_and_recipient_service_horizon():
    service, repo, _ = workflow()
    created = create(
        service,
        "transport-service-horizon",
        transport="transportation_needed",
    )

    def install_late_route_evidence(state):
        offer = state["offers"][created["offer_id"]]
        for candidate in offer["candidates"].values():
            candidate["pickup_window_hours"] = 1
            candidate["travel"]["estimated_minutes"] = 120

    repo.transact(install_late_route_evidence)
    resolved = service.ops_action(
        created["offer_id"],
        "resolve-transport",
        {"transport_mode": "recipient_pickup"},
        idempotency_key="resolve-service-horizon",
        now=NOW,
    )
    offer = repo.snapshot()["offers"][created["offer_id"]]

    assert resolved["status"] == "no_match"
    assert offer["candidates"] == {}
    assert offer["rejections"]
    assert all(
        "route_cannot_meet_recipient_service_horizon" in rejection["reasons"]
        for rejection in offer["rejections"]
    )


def test_concurrent_first_accept_wins_without_duplicate_capacity():
    service, repo, _ = workflow()
    created = create(service)
    offer_id = created["offer_id"]
    contenders = created["recipient_access"][:2]

    def claim(item):
        try:
            return service.claim(
                offer_id,
                item["token"],
                {},
                idempotency_key=f"claim-{item['recipient_id']}",
                now=NOW + timedelta(minutes=1),
            )
        except WorkflowError as exc:
            return exc.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(claim, contenders))

    assert sum(isinstance(result, dict) for result in results) == 1
    assert "offer_currently_held" in results
    state = repo.snapshot()
    assert sum(1 for r in state["reservations"].values() if r["status"] == "active") == 1
    assert sum(r["reserved_pallets"] for r in state["recipients"].values()) == 1


def test_two_offers_cannot_overbook_same_recipient():
    service, repo, _ = workflow()
    first = create(service, "first", quantity=5)
    second = create(service, "second", quantity=5)
    rid = first["recipient_access"][0]["recipient_id"]
    first_token = first["recipient_access"][0]["token"]
    second_token = second["recipient_access"][0]["token"]
    assert second["recipient_access"][0]["recipient_id"] == rid
    assert second_token != first_token

    service.claim(first["offer_id"], first_token, {}, idempotency_key="claim-first", now=NOW)
    with pytest.raises(WorkflowError) as error:
        service.claim(second["offer_id"], second_token, {}, idempotency_key="claim-second", now=NOW)
    assert error.value.code == "capacity_unavailable"
    assert repo.snapshot()["recipients"][rid]["reserved_pallets"] == 5

    with pytest.raises(AuthorizationError) as scoped:
        service.claim(
            second["offer_id"],
            first_token,
            {},
            idempotency_key="cross-offer-token",
            now=NOW,
        )
    assert scoped.value.code == "offer_scope_mismatch"
    with pytest.raises(AuthorizationError) as completion_scope:
        service.complete(
            second["offer_id"],
            first_token,
            {},
            idempotency_key="cross-offer-complete",
            now=NOW,
        )
    assert completion_scope.value.code == "offer_scope_mismatch"


def test_hold_deadline_clamp_stale_task_and_lazy_expiry():
    service, repo, _ = workflow(hold_minutes=60)
    deadline = NOW + timedelta(minutes=40)
    created = create(service, deadline=deadline)
    recipient = created["recipient_access"][0]
    held = service.claim(created["offer_id"], recipient["token"], {}, idempotency_key="hold", now=NOW)
    assert held["reservation"]["expires_at"] == deadline.isoformat()

    stale = service.advance_offer_if_due(
        created["offer_id"],
        kind="reservation",
        lease_version=99,
        now=deadline + timedelta(seconds=1),
    )
    assert stale["advanced"] is False
    assert repo.snapshot()["offers"][created["offer_id"]]["status"] == "reserved"

    advanced = service.advance_offer_if_due(
        created["offer_id"],
        kind="reservation",
        lease_version=1,
        now=deadline + timedelta(seconds=1),
    )
    assert advanced["status"] == "expired"
    state = repo.snapshot()
    assert state["offers"][created["offer_id"]]["candidates"][recipient["recipient_id"]]["response"] == "hold_expired"
    assert state["recipients"][recipient["recipient_id"]]["reserved_pallets"] == 0


def test_silent_wave_times_out_and_promotes_once():
    service, repo, scheduler = workflow(response_minutes=10)
    created = create(service)
    offer_id = created["offer_id"]
    first = repo.snapshot()["offers"][offer_id]
    due = datetime.fromisoformat(first["wave_expires_at"])
    version = first["wave_version"]

    result = service.advance_offer_if_due(offer_id, kind="wave", wave_version=version, now=due)
    assert result["advanced"] is True
    state = repo.snapshot()
    assert state["offers"][offer_id]["wave_version"] == version + 1
    assert len(state["notifications"]) == 6
    assert sum(c["response"] == "timed_out" for c in state["offers"][offer_id]["candidates"].values()) == 3

    stale = service.advance_offer_if_due(offer_id, kind="wave", wave_version=version, now=due)
    assert stale["advanced"] is False
    assert len(repo.snapshot()["notifications"]) == 6
    assert len(scheduler.tasks) == 2


def test_confirm_requires_valid_handoff_then_complete_counts_impact_and_releases_capacity():
    service, repo, _ = workflow()
    created = create(service)
    winner = created["recipient_access"][0]
    held = service.claim(created["offer_id"], winner["token"], {}, idempotency_key="claim", now=NOW)
    with pytest.raises(WorkflowError) as error:
        service.confirm(
            held["reservation"]["reservation_id"],
            winner["token"],
            {"expected_handoff_time": (NOW - timedelta(minutes=1)).isoformat(), "contact_name": "A", "contact_phone": "404"},
            idempotency_key="bad-confirm",
            now=NOW,
        )
    assert error.value.code == "invalid_handoff_time"

    confirmed = service.confirm(
        held["reservation"]["reservation_id"],
        winner["token"],
        {"expected_handoff_time": (NOW + timedelta(hours=1)).isoformat(), "contact_name": "Alex", "contact_phone": "404-555-0100"},
        idempotency_key="confirm",
        now=NOW,
    )
    assert confirmed["status"] == "confirmed"
    completed = service.complete(created["offer_id"], winner["token"], {"actual_quantity_pallets": 0.8}, idempotency_key="complete", now=NOW)
    assert completed == {"offer_id": created["offer_id"], "status": "completed", "completed_quantity_pallets": 0.8, "estimated": False}
    assert repo.snapshot()["recipients"][winner["recipient_id"]]["reserved_pallets"] == 0
    assert service.ops_offers()["impact"] == {
        "completed_offers": 1,
        "completed_quantity_pallets": 0.8,
        "actual_quantity_pallets": 0.8,
        "estimated_quantity_pallets": 0.0,
    }


def test_recipient_exact_location_hidden_until_valid_claim_and_refresh_can_confirm():
    service, _, _ = workflow()
    created = create(service)
    winner, loser = created["recipient_access"][:2]
    before = service.inbox(winner["token"], now=NOW)
    assert before["notifications"][0]["offer"]["donor_location"] is None
    held = service.claim(created["offer_id"], winner["token"], {}, idempotency_key="claim", now=NOW)
    after = service.inbox(winner["token"], now=NOW)
    assert after["notifications"][0]["offer"]["donor_location"]["latitude"] == 33.749
    assert after["notifications"][0]["reservation"]["reservation_id"] == held["reservation"]["reservation_id"]
    assert service.inbox(loser["token"], now=NOW)["notifications"][0]["offer"]["donor_location"] is None


def test_needs_transport_blocks_fanout_until_safe_resolution_and_radius_is_capped():
    service, repo, _ = workflow()
    created = create(service, transport="transportation_needed")
    assert created["status"] == "needs_transport"
    assert created["notifications_count"] == 0
    resolved = service.ops_action(
        created["offer_id"],
        "resolve-transport",
        {"transport_mode": "recipient_pickup"},
        idempotency_key="resolve",
        now=NOW,
    )
    assert resolved["status"] == "notified"
    assert len(repo.snapshot()["notifications"]) == 3

    with pytest.raises(WorkflowError) as error:
        create(service, "bad-radius", transport="donor_delivery", radius=5.1)
    assert error.value.code == "delivery_radius_exceeded"


def test_transport_resolution_refilters_candidates_before_notifications():
    service, repo, _ = workflow()
    created = create(service, "transport-refilter", transport="transportation_needed")
    resolved = service.ops_action(
        created["offer_id"],
        "resolve-transport",
        {"transport_mode": "donor_delivery", "donor_delivery_radius_km": 1},
        idempotency_key="resolve-one-km",
        now=NOW,
    )

    assert resolved["status"] == "no_match"
    offer = repo.snapshot()["offers"][created["offer_id"]]
    assert offer["candidates"] == {}
    assert all(
        "route_exceeds_donor_delivery_radius" in rejection["reasons"]
        for rejection in offer["rejections"]
    )
    assert repo.snapshot()["notifications"] == {}


def test_eligible_candidates_survive_for_real_second_wave():
    async def matcher(**_kwargs):
        candidates = [
            {
                "recipient_id": f"wave-{index}",
                "name": f"Wave Pantry {index}",
                "max_pallets": 5,
                "cold_storage": True,
                "latitude": 33.75 + index * 0.002,
                "longitude": -84.39,
                "distance_miles": 1 + index * 0.1,
                "rank": index + 1,
            }
            for index in range(6)
        ]
        return {
            "selected": candidates[0],
            "fallbacks": candidates[1:3],
            "eligible_candidates": candidates,
            "rejections": [],
            "warnings": [],
        }

    repo = InMemoryWorkflowRepository()
    service = WorkflowService(
        repo,
        TokenAuthority("test-pepper", "ops-token"),
        InMemoryTaskScheduler(),
        matcher=matcher,
        demo_mode=True,
        demo_fallback=False,
    )
    created = create(service, "real-waves")
    offer = repo.snapshot()["offers"][created["offer_id"]]
    assert len(offer["candidates"]) == 6
    assert all("travel" in candidate for candidate in offer["candidates"].values())
    assert len(repo.snapshot()["notifications"]) == 3

    due = datetime.fromisoformat(offer["wave_expires_at"])
    service.advance_offer_if_due(
        created["offer_id"],
        kind="wave",
        wave_version=offer["wave_version"],
        now=due,
    )
    assert len(repo.snapshot()["notifications"]) == 6


def test_cancel_hides_donor_location_and_terminal_states_cannot_be_rewritten():
    service, _, _ = workflow()
    created = create(service, "cancel-location")
    winner = created["recipient_access"][0]
    service.claim(
        created["offer_id"], winner["token"], {}, idempotency_key="hold", now=NOW
    )
    assert service.inbox(winner["token"], now=NOW)["notifications"][0]["offer"]["donor_location"]

    service.ops_action(
        created["offer_id"],
        "cancel",
        {"reason": "Donor withdrew"},
        idempotency_key="cancel",
        now=NOW,
    )
    after = service.inbox(winner["token"], now=NOW)["notifications"][0]
    assert after["offer"]["donor_location"] is None
    assert after["offer"]["map"]["donor"] is None
    with pytest.raises(WorkflowError) as terminal:
        service.ops_action(
            created["offer_id"],
            "fail",
            {"reason": "rewrite"},
            idempotency_key="rewrite-terminal",
            now=NOW,
        )
    assert terminal.value.code == "invalid_transition"


def test_all_offer_location_sources_are_bounded_to_atlanta():
    service, repo, _ = workflow()
    outside = offer_payload()
    outside.update(
        {
            "donor_latitude": 40.7128,
            "donor_longitude": -74.006,
            "location_source": "gps",
        }
    )
    with pytest.raises(WorkflowError) as error:
        asyncio.run(
            service.create_offer(outside, idempotency_key="outside", now=NOW)
        )
    assert error.value.code == "outside_atlanta_service_area"
    assert repo.snapshot()["offers"] == {}


def test_coordinator_failure_releases_capacity_and_replay_is_idempotent():
    service, repo, _ = workflow()
    created = create(service, "fail-release")
    winner = created["recipient_access"][0]
    held = service.claim(
        created["offer_id"],
        winner["token"],
        {},
        idempotency_key="held-before-failure",
        now=NOW,
    )

    first = service.ops_action(
        created["offer_id"],
        "fail",
        {"reason": "Cold storage became unavailable"},
        idempotency_key="fail-once",
        now=NOW,
    )
    second = service.ops_action(
        created["offer_id"],
        "fail",
        {"reason": "Cold storage became unavailable"},
        idempotency_key="fail-once",
        now=NOW,
    )

    assert first == second == {"offer_id": created["offer_id"], "status": "failed"}
    state = repo.snapshot()
    assert state["recipients"][winner["recipient_id"]]["reserved_pallets"] == 0
    assert state["reservations"][held["reservation"]["reservation_id"]]["capacity_released"] is True
    assert state["offers"][created["offer_id"]]["candidates"][winner["recipient_id"]]["response"] == "invalidated"


def test_coordinator_promote_replay_does_not_duplicate_notifications():
    service, repo, _ = workflow()
    created = create(service, "promote-replay")
    first = service.ops_action(
        created["offer_id"],
        "promote",
        {"reason": "Demo acceleration"},
        idempotency_key="promote-once",
        now=NOW,
    )
    count = len(repo.snapshot()["notifications"])
    second = service.ops_action(
        created["offer_id"],
        "promote",
        {"reason": "Demo acceleration"},
        idempotency_key="promote-once",
        now=NOW,
    )

    assert first == second
    assert count == 6
    assert len(repo.snapshot()["notifications"]) == count

