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


def test_shelf_life_endpoint_and_open_vs_sealed_infant_formula() -> None:
    open_resp = client.get(
        "/api/shelf-life",
        params={
            "food_query": "infant formula",
            "storage_state": "pantry",
            "donor_hours_available": 24.0,
            "is_sealed": False,
        },
    )
    assert open_resp.status_code == 200
    open_data = open_resp.json()
    assert open_data["hours_remaining"] == 1.0
    assert open_data["urgency_tier"].startswith("CRITICAL")

    sealed_resp = client.get(
        "/api/shelf-life",
        params={
            "food_query": "infant formula",
            "storage_state": "pantry",
            "donor_hours_available": 24.0,
            "is_sealed": True,
        },
    )
    assert sealed_resp.status_code == 200
    sealed_data = sealed_resp.json()
    assert sealed_data["hours_remaining"] == 24.0
    assert sealed_data["urgency_tier"].startswith("STANDARD")


def test_postings_endpoint_returns_surplus_postings() -> None:
    response = client.get("/api/postings")

    assert response.status_code == 200
    data = response.json()
    assert data["count"] >= 1
    assert isinstance(data["postings"], list)


def test_unlisted_food_item_uses_smart_fallback(monkeypatch) -> None:
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "your-gcp-project-id")
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    # 1. Prepared dish not in foodkeeper.json -> 2h room temp limit
    resp_prepared = client.get(
        "/api/shelf-life",
        params={
            "food_query": "catered trays of biryani",
            "storage_state": "pantry",
            "donor_hours_available": 12.0,
        },
    )
    assert resp_prepared.status_code == 200
    prep_data = resp_prepared.json()
    assert prep_data["source_method"] == "fda_food_code_prepared_fallback"
    assert prep_data["shelf_life_hours"] == 2.0
    assert prep_data["hours_remaining"] == 2.0

    # 2. Non-food essential -> no biological spoilage, uses donor window
    resp_non_food = client.get(
        "/api/shelf-life",
        params={
            "food_query": "diapers and wipes",
            "storage_state": "pantry",
            "donor_hours_available": 48.0,
        },
    )
    assert resp_non_food.status_code == 200
    nf_data = resp_non_food.json()
    assert nf_data["source_method"] == "non_food_essential_rule"
    assert nf_data["shelf_life_hours"] is None
    assert nf_data["hours_remaining"] == 48.0



def test_real_matcher_output_includes_full_agent_reply_and_judge_evidence(monkeypatch) -> None:
    def fake_provider(payload):
        return {
            "best": {
                "recipient_id": "rec_101",
                "name": "Maple Street Produce Alliance",
                "address": "100 Maple St SW, Atlanta, GA, 30314",
                "distance_miles": 2.1,
                "travel": {"distance_miles": 2.1, "estimated_minutes": 5},
                "cold_storage": "walk-in",
                "frozen_storage": False,
                "refrigerated_transport": True,
                "loading_dock": False,
                "max_pallets": 3.0,
                "capacity_margin_pallets": 2.0,
                "time_margin_hours": 4.5,
                "need_score": 0.48,
                "tract_geo_id": "13121008500",
                "tract_median_income": 32400.0,
                "tract_poverty_rate": 0.34,
                "tract_no_vehicle_rate": 0.21,
                "tract_assistance_rate": 0.28,
                "weekly_households": 450,
                "populations_served": "Low-income families and seniors",
                "selection_reason": "Eligible with 4.5 hours margin.",
            },
            "fallbacks": [],
            "rejections": [],
            "warnings": [],
        }

    monkeypatch.setattr(agent_module, "_load_matcher", lambda: fake_provider)
    monkeypatch.setattr(
        agent_module,
        "check_fda_food_recalls",
        lambda food_item, state="GA": {
            "safety_clearance_status": "CLEAR_TO_ROUTE",
            "active_recalls_found": 0,
            "broker_action": "No active FDA recalls found.",
            "state_filter": state,
        },
    )

    import asyncio

    result = asyncio.run(
        agent_module.match_surplus_offer(
            description="10 crates of fresh spinach",
            quantity_pallets=1.0,
            storage_state="refrigerated",
            pickup_deadline="2026-10-20T20:00:00-04:00",
            donor_latitude=33.749,
            donor_longitude=-84.388,
        )
    )

    selected = result["selected"]
    assert selected["name"] == "Maple Street Produce Alliance"
    assert "shelf_life" in selected
    assert "fda_recall" in selected
    assert "equity_profile" in selected
    assert "FULL AGENT MATCH BRIEF" in selected["agent_full_reply"]
    assert selected["equity_profile"]["tract_median_income"] == 32400.0


def test_opened_infant_formula_triggers_hard_safety_guardrail(monkeypatch) -> None:
    def fake_provider(payload):
        return {
            "best": {
                "recipient_id": "rec_202",
                "name": "Midtown Family Pantry",
                "distance_miles": 1.8,
            },
            "fallbacks": [],
            "rejections": [],
            "warnings": [],
        }

    monkeypatch.setattr(agent_module, "_load_matcher", lambda: fake_provider)
    monkeypatch.setattr(
        agent_module,
        "check_fda_food_recalls",
        lambda food_item, state="GA": {
            "safety_clearance_status": "CLEAR_TO_ROUTE",
            "active_recalls_found": 0,
            "broker_action": "No active FDA recalls found.",
        },
    )

    import asyncio

    result = asyncio.run(
        agent_module.match_surplus_offer(
            description="12 opened canisters of infant formula powder",
            quantity_pallets=0.5,
            storage_state="ambient",
            pickup_deadline="2026-10-20T20:00:00-04:00",
            donor_latitude=33.749,
            donor_longitude=-84.388,
        )
    )

    assert result["selected"] is None
    assert any("SAFETY_GUARDRAIL_BLOCKED" in w for w in result["warnings"])
    assert result["rejections"][0]["_offer_brief"]["safety_blocked_reason"]
