from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor

import pytest

from agent.auth import TokenAuthority
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
    token = first["recipient_access"][0]["token"]
    assert second["recipient_access"][0]["recipient_id"] == rid

    service.claim(first["offer_id"], token, {}, idempotency_key="claim-first", now=NOW)
    with pytest.raises(WorkflowError) as error:
        service.claim(second["offer_id"], token, {}, idempotency_key="claim-second", now=NOW)
    assert error.value.code == "capacity_unavailable"
    assert repo.snapshot()["recipients"][rid]["reserved_pallets"] == 5


def test_hold_deadline_clamp_stale_task_and_lazy_expiry():
    service, repo, _ = workflow(hold_minutes=10)
    deadline = NOW + timedelta(minutes=5)
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
    assert service.ops_offers()["impact"] == {"completed_offers": 1, "completed_quantity_pallets": 0.8}


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

