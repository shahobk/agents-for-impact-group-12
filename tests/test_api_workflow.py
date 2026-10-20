from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
import pytest

from agent.auth import TokenAuthority
from agent.intake import IntakeInterpreter
from agent.locations import LocationService
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
        "intake_interpreter",
        IntakeInterpreter(photo_provider=None, max_photo_bytes=1024),
    )
    monkeypatch.setattr(service, "location_service", LocationService())
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
    assert response.json()["dependencies"]["photo_intake"]["probe"] == "provider_configuration_only"
    assert response.json()["dependencies"]["geocoding"]["ok"] is True
    assert response.json()["dependencies"]["routes"]["ok"] is True


def test_browser_security_headers_are_applied_to_success_and_error(api):
    client, _, _ = api
    for response in (client.get("/healthz"), client.get("/readyz")):
        assert response.headers["x-frame-options"] == "DENY"
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["referrer-policy"] == "no-referrer"
        assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
        assert response.headers["strict-transport-security"].startswith("max-age=")
        assert "geolocation=(self)" in response.headers["permissions-policy"]


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
    assert ops.json()["impact"] == {
        "completed_offers": 1,
        "completed_quantity_pallets": 0.9,
        "actual_quantity_pallets": 0.9,
        "estimated_quantity_pallets": 0.0,
    }


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


def test_review_first_intake_does_not_create_or_retain_an_offer(api):
    client, repo, _ = api
    response = client.post(
        "/api/intake/extract",
        json={
            "text": "ten crates of refrigerated spinach within six hours for pickup",
            "now": "2026-10-20T16:00:00Z",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["draft"]["quantity_pallets"] == 1.0
    assert body["draft"]["pickup_deadline"] == "2026-10-20T22:00:00+00:00"
    assert body["retained"] is False
    assert body["review_required"] is True
    assert repo.snapshot()["offers"] == {}


def test_transient_photo_is_validated_and_not_echoed(api):
    client, repo, _ = api
    encoded = base64.b64encode(b"\x89PNG\r\n\x1a\ntransient").decode()
    response = client.post(
        "/api/intake/extract",
        json={
            "text": "refrigerated spinach",
            "photo": {"mime_type": "image/png", "data_base64": encoded},
        },
    )

    assert response.status_code == 200
    assert response.json()["retained"] is False
    assert encoded not in response.text
    assert repo.snapshot()["offers"] == {}
    invalid = client.post(
        "/api/intake/extract",
        json={
            "photo": {
                "mime_type": "image/svg+xml",
                "data_base64": base64.b64encode(b"<svg/>").decode(),
            }
        },
    )
    assert invalid.status_code == 415
    assert invalid.json()["detail"]["code"] == "unsupported_photo_type"


def test_public_summary_and_map_projection_are_sanitized(api):
    client, repo, _ = api
    created = client.post(
        "/api/offers", json=payload(), headers={"X-Idempotency-Key": "public-map"}
    ).json()
    summary = client.get("/api/public/summary")

    assert summary.status_code == 200
    assert summary.json()["activity"]["total_offers"] == 1
    assert summary.json()["activity"]["simulated_notifications_created"] == 3
    assert "pickup" not in summary.text.lower()
    assert created["status_token"] not in summary.text

    donor = client.get(
        "/api/offers/status",
        headers={"Authorization": f"Bearer {created['status_token']}"},
    ).json()
    assert donor["map"]["donor"]["precision"] == "reviewed_address_candidate"
    assert donor["map"]["tracking"] is False
    assert donor["demo_recipient_access"][0]["token"] == created["recipient_access"][0]["token"]
    assert created["recipient_access"][0]["token"] not in str(repo.snapshot())


def test_address_geocoding_returns_reviewable_demo_anchor_without_persistence(api):
    client, repo, _ = api
    response = client.post(
        "/api/locations/geocode", json={"address": "Atlanta demo grocery"}
    )

    assert response.status_code == 200
    assert response.json() == {
        "formatted_address": "Atlanta Demo Grocery, Atlanta, GA",
        "latitude": 33.749,
        "longitude": -84.388,
        "source": "demo_fallback",
        "precision": "named_demo_anchor",
    }
    assert repo.snapshot()["offers"] == {}

    unavailable = client.post(
        "/api/locations/geocode", json={"address": "123 Unverified Street"}
    )
    assert unavailable.status_code == 503
    assert unavailable.json()["detail"]["code"] == "geocoding_unavailable"


def test_request_id_rate_limit_and_request_size_controls(api, monkeypatch):
    client, _, _ = api
    monkeypatch.setattr(
        service,
        "paid_rate_limiter",
        service.TokenBucketRateLimiter(capacity=1, refill_per_second=0),
    )
    first = client.post(
        "/api/locations/geocode",
        json={"address": "Atlanta demo grocery"},
        headers={"X-Request-ID": "browser-proof-123"},
    )
    assert first.status_code == 200
    assert first.headers["X-Request-ID"] == "browser-proof-123"

    limited = client.post(
        "/api/locations/geocode", json={"address": "Atlanta demo grocery"}
    )
    assert limited.status_code == 429
    assert limited.json()["detail"]["code"] == "rate_limited"
    assert limited.headers["X-Request-ID"]

    monkeypatch.setattr(
        service,
        "paid_rate_limiter",
        service.TokenBucketRateLimiter(capacity=5, refill_per_second=0),
    )
    oversized = client.post(
        "/api/intake/extract",
        content=b"x" * (service._MAX_PUBLIC_REQUEST_BYTES + 1),
        headers={"Content-Type": "application/json"},
    )
    assert oversized.status_code == 413
    assert oversized.json()["detail"]["code"] == "request_too_large"


def test_invalid_request_id_is_replaced_without_echoing_untrusted_value(api):
    client, _, _ = api
    response = client.get("/healthz", headers={"X-Request-ID": "bad id with spaces"})
    assert response.status_code == 200
    assert response.headers["X-Request-ID"] != "bad id with spaces"
    assert len(response.headers["X-Request-ID"]) == 32


def test_equity_audit_is_protected_sanitized_and_cached(api, monkeypatch):
    client, _, _ = api
    calls = 0

    def audit(**_kwargs):
        nonlocal calls
        calls += 1
        return {
            "status": "complete",
            "expected_postings": 10,
            "posting_count": 10,
            "matched_postings": 10,
            "no_match_postings": 0,
            "tract_evidence_count": 10,
            "weekly_households_fallback_count": 0,
            "postings": [
                {
                    "posting_id": 1,
                    "selected_recipient_id": "recipient-1",
                    "no_match": False,
                    "eligible_count": 3,
                    "retrieval_evidence": {
                        "job_id": "job-1",
                        "vector_search": True,
                        "use_brute_force": True,
                        "raw_query": "must-not-expose",
                    },
                    "private": "must-not-expose",
                }
            ],
            "ten_match_proof": {
                "ok": True,
                "match_execution_count": 10,
                "job_ids": ["job-1"],
                "private": "must-not-expose",
            },
            "source_job_id": "source-job",
            "vector_job_ids": ["job-1"],
            "limitations": ["Approximate ZIP centroids"],
        }

    monkeypatch.setattr(service, "run_bigquery_equity_audit", audit)
    service._equity_cache.clear()
    assert client.get("/api/ops/equity-audit").status_code == 401
    first = client.get(
        "/api/ops/equity-audit", headers={"Authorization": "Bearer ops-token"}
    )
    second = client.get(
        "/api/ops/equity-audit", headers={"Authorization": "Bearer ops-token"}
    )

    assert first.status_code == second.status_code == 200
    assert calls == 1
    assert first.json()["execution"]["source"] == "live_bigquery"
    assert second.json()["execution"]["source"] == "cache"
    assert first.json()["ten_match_proof"]["ok"] is True
    assert first.json()["postings"][0]["retrieval_evidence"]["job_id"] == "job-1"
    assert "must-not-expose" not in first.text


def test_direct_match_rejects_coordinates_outside_atlanta_before_provider(api):
    client, _, _ = api
    response = client.post(
        "/api/match",
        json={
            "description": "spinach",
            "quantity_pallets": 1,
            "storage_state": "refrigerated",
            "pickup_deadline": (datetime.now(timezone.utc) + timedelta(hours=6)).isoformat(),
            "donor_latitude": 40.7128,
            "donor_longitude": -74.006,
        },
    )
    assert response.status_code == 422

