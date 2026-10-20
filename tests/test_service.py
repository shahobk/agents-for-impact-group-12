from __future__ import annotations

from fastapi.testclient import TestClient

from agent import agent as agent_module
from agent import service


client = TestClient(service.app)


def valid_offer() -> dict[str, object]:
    return {
        "description": "10 crates of fresh spinach",
        "quantity_pallets": 1.0,
        "storage_state": "refrigerated",
        "pickup_deadline": "2026-10-20T20:00:00-04:00",
        "donor_latitude": 33.749,
        "donor_longitude": -84.388,
        "split_allowed": False,
    }


def test_health_does_not_require_cloud_credentials() -> None:
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert client.get("/healthz/").status_code == 200


def test_match_returns_stable_envelope(monkeypatch) -> None:
    received = {}

    async def fake_matcher(**kwargs):
        received.update(kwargs)
        return {
            "selected": {"name": "Peachtree Pantry", "distance_miles": 2.4},
            "fallbacks": [{"name": "Second Helpings"}],
            "rejections": [{"name": "Greenline", "reason": "no refrigeration"}],
            "warnings": ["Confirm live availability."],
            "outreach": "Can you receive 10 crates of spinach today?",
            "internal_debug_field": "not exposed",
        }

    monkeypatch.setattr(service, "match_surplus_offer", fake_matcher)
    response = client.post("/api/match", json=valid_offer())

    assert response.status_code == 200
    assert response.json() == {
        "selected": {"name": "Peachtree Pantry", "distance_miles": 2.4},
        "fallbacks": [{"name": "Second Helpings"}],
        "rejections": [{"name": "Greenline", "reason": "no refrigeration"}],
        "warnings": ["Confirm live availability."],
        "outreach": "Can you receive 10 crates of spinach today?",
    }
    assert received["storage_state"] == "refrigerated"
    assert received["pickup_deadline"].endswith("-04:00")


def test_match_accepts_quantity_and_nested_coordinate_aliases(monkeypatch) -> None:
    async def fake_matcher(**kwargs):
        return {"selected": None}

    monkeypatch.setattr(service, "match_surplus_offer", fake_matcher)
    offer = valid_offer()
    offer["quantity"] = offer.pop("quantity_pallets")
    offer["donor_coordinates"] = {
        "latitude": offer.pop("donor_latitude"),
        "longitude": offer.pop("donor_longitude"),
    }

    response = client.post("/api/match", json=offer)

    assert response.status_code == 200
    assert response.json()["selected"] is None


def test_match_accepts_frontend_compatibility_fields(monkeypatch) -> None:
    async def fake_matcher(**kwargs):
        return {"selected": None}

    monkeypatch.setattr(service, "match_surplus_offer", fake_matcher)
    offer = valid_offer()
    offer.update(
        {
            "quantity": offer["quantity_pallets"],
            "pallet_estimate": offer["quantity_pallets"],
            "pickup_location": "Downtown Atlanta grocery store",
            "donor_lat": offer["donor_latitude"],
            "donor_lon": offer["donor_longitude"],
        }
    )

    response = client.post("/api/match", json=offer)

    assert response.status_code == 200


def test_match_rejects_naive_deadline() -> None:
    offer = valid_offer()
    offer["pickup_deadline"] = "2026-10-20T20:00:00"

    response = client.post("/api/match", json=offer)

    assert response.status_code == 422


def test_match_rejects_invalid_storage_state() -> None:
    offer = valid_offer()
    offer["storage_state"] = "chilled-ish"

    response = client.post("/api/match", json=offer)

    assert response.status_code == 422


def test_matcher_failure_is_safe(monkeypatch) -> None:
    async def failing_matcher(**kwargs):
        raise RuntimeError("secret warehouse detail")

    monkeypatch.setattr(service, "match_surplus_offer", failing_matcher)
    response = client.post("/api/match", json=valid_offer())

    assert response.status_code == 503
    assert response.json() == {
        "detail": "The matching service is temporarily unavailable."
    }
    assert "secret warehouse detail" not in response.text


def test_adk_tool_maps_matcher_contract_and_drafts_outreach(monkeypatch) -> None:
    def fake_provider(payload):
        assert payload["posting_text"] == "10 crates of fresh spinach"
        return {
            "best": {"name": "Peachtree Pantry"},
            "fallbacks": [],
            "rejections": [],
            "warnings": [],
        }

    monkeypatch.setattr(agent_module, "_load_matcher", lambda: fake_provider)

    import asyncio

    result = asyncio.run(
        agent_module.match_surplus_offer(
            description="10 crates of fresh spinach",
            quantity_pallets=1,
            storage_state="refrigerated",
            pickup_deadline="2026-10-20T20:00:00-04:00",
            donor_latitude=33.749,
            donor_longitude=-84.388,
        )
    )

    assert result["selected"]["name"] == "Peachtree Pantry"
    assert "Peachtree Pantry" in result["outreach"]
