from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
import pytest

from agent.auth import TokenAuthority
from agent.repository import InMemoryWorkflowRepository
from agent.tasks import InMemoryTaskScheduler, TaskOidcVerifier
from agent.workflow import WorkflowService
from agent import service


@pytest.fixture()
def api(monkeypatch):
    repo = InMemoryWorkflowRepository()
    scheduler = InMemoryTaskScheduler()
    authority = TokenAuthority("api-test-pepper", "ops-token")
    workflow = WorkflowService(
        repo,
        authority,
        scheduler,
        matcher=None,
        demo_mode=True,
        demo_fallback=True,
    )
    monkeypatch.setattr(service, "repository", repo)
    monkeypatch.setattr(service, "scheduler", scheduler)
    monkeypatch.setattr(service, "token_authority", authority)
    monkeypatch.setattr(service, "workflow", workflow)
    monkeypatch.setattr(
        service,
        "task_verifier",
        TaskOidcVerifier(None, None, local_secret="task-secret"),
    )
    return TestClient(service.app), repo, scheduler


def payload():
    return {
        "description": "ten crates of refrigerated spinach",
        "quantity_original": "10 crates",
        "quantity_pallets": 1,
        "storage_state": "refrigerated",
        "pickup_deadline": (datetime.now(timezone.utc) + timedelta(hours=6)).isoformat(),
        "donor_latitude": 33.749,
        "donor_longitude": -84.388,
        "pickup_address": "Atlanta demo grocery",
        "location_source": "address",
        "transport_mode": "recipient_pickup",
    }


def test_ready_is_protected_and_dependency_aware(api):
    client, _, _ = api
    assert client.get("/readyz").status_code == 401
    response = client.get("/readyz", headers={"Authorization": "Bearer ops-token"})
    assert response.status_code == 200
    assert response.json()["dependencies"]["repository"]["ok"] is True


def test_full_http_offer_hold_confirm_complete_and_role_authorization(api):
    client, _, _ = api
    created_response = client.post("/api/offers", json=payload(), headers={"X-Idempotency-Key": "api-create"})
    assert created_response.status_code == 201
    created = created_response.json()
    donor_headers = {"Authorization": f"Bearer {created['status_token']}"}
    winner = created["recipient_access"][0]
    loser = created["recipient_access"][1]
    winner_headers = {"Authorization": f"Bearer {winner['token']}", "X-Idempotency-Key": "winner-claim"}

    status = client.get("/api/offers/status", headers=donor_headers)
    assert status.status_code == 200
    assert status.json()["offer"]["status"] == "notified"
    assert client.get("/api/offers/status", headers={"Authorization": f"Bearer {winner['token']}"}).status_code == 403

    inbox = client.get("/api/recipients/notifications", headers={"Authorization": f"Bearer {winner['token']}"})
    assert len(inbox.json()["notifications"]) == 1
    assert inbox.json()["notifications"][0]["offer"]["donor_location"] is None

    held = client.post(f"/api/offers/{created['offer_id']}/claim", json={}, headers=winner_headers)
    assert held.status_code == 200
    reservation_id = held.json()["reservation"]["reservation_id"]
    lost = client.post(
        f"/api/offers/{created['offer_id']}/claim",
        json={},
        headers={"Authorization": f"Bearer {loser['token']}", "X-Idempotency-Key": "loser-claim"},
    )
    assert lost.status_code == 409
    assert lost.json()["detail"]["code"] == "offer_currently_held"

    refreshed = client.get("/api/recipients/notifications", headers={"Authorization": f"Bearer {winner['token']}"}).json()
    assert refreshed["notifications"][0]["reservation"]["reservation_id"] == reservation_id
    assert refreshed["notifications"][0]["offer"]["donor_location"]["address"] == "Atlanta demo grocery"

    confirmed = client.post(
        f"/api/reservations/{reservation_id}/confirm",
        json={"expected_handoff_time": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(), "contact_name": "Alex", "contact_phone": "404-555-0100"},
        headers={"Authorization": f"Bearer {winner['token']}", "X-Idempotency-Key": "confirm"},
    )
    assert confirmed.status_code == 200
    completed = client.post(
        f"/api/offers/{created['offer_id']}/complete",
        json={"actual_quantity_pallets": 0.9, "note": "Collected"},
        headers={**donor_headers, "X-Idempotency-Key": "complete"},
    )
    assert completed.status_code == 200
    assert completed.json()["status"] == "completed"
    ops = client.get("/api/ops/offers", headers={"Authorization": "Bearer ops-token"})
    assert ops.json()["impact"] == {"completed_offers": 1, "completed_quantity_pallets": 0.9}


def test_task_endpoint_rejects_anonymous_and_accepts_configured_local_test_secret(api):
    client, repo, scheduler = api
    noop = client.post(
        "/internal/tasks/advance-offer",
        json={"offer_id": "readiness-probe", "kind": "noop"},
        headers={"X-Task-Secret": "task-secret"},
    )
    assert noop.status_code == 200
    assert noop.json() == {"accepted": True, "kind": "noop"}

    created = client.post("/api/offers", json=payload(), headers={"X-Idempotency-Key": "task-offer"}).json()
    state = repo.snapshot()["offers"][created["offer_id"]]
    task_body = {"offer_id": created["offer_id"], "kind": "wave", "wave_version": state["wave_version"]}
    assert client.post("/internal/tasks/advance-offer", json=task_body).status_code == 401
    response = client.post("/internal/tasks/advance-offer", json=task_body, headers={"X-Task-Secret": "task-secret"})
    assert response.status_code == 200
    assert response.json()["advanced"] is False  # task is authenticated but not due
    assert len(scheduler.tasks) == 1

