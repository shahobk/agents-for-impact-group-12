import json
from pathlib import Path

import pytest

from agent.matcher import TOP_K, match_surplus


CASES = json.loads(
    (Path(__file__).parent / "fixtures" / "matcher_cases.json").read_text()
)
NOW = "2026-10-19T09:00:00Z"  # Monday
DONOR = {"donor_latitude": 33.750, "donor_longitude": -84.390}


def provider_for(case):
    def provider(posting_text, *, top_k):
        assert top_k == TOP_K
        assert posting_text
        return CASES[case]

    return provider


def request(text, storage, hours, quantity=1):
    return {
        "posting_text": text,
        "storage_state": storage,
        "quantity_pallets": quantity,
        "requested_at": NOW,
        "hours_remaining": hours,
        **DONOR,
    }


def all_recommendations(result):
    return [result["best"], *result["fallbacks"]]


def rejection(result, recipient_id):
    return next(item for item in result["rejections"] if item["recipient_id"] == recipient_id)


def test_spinach_rejects_decoy_and_contradiction_then_uses_need_tiebreak():
    result = match_surplus(
        request("10 crates of spinach, needs cold storage", "refrigerated", 6),
        provider_for("spinach"),
    )

    assert result["no_match"] is False
    assert result["best"]["name"] == "Maple Street Produce Alliance"
    assert "need tie-break" in result["best"]["selection_reason"]
    # The recipient's window is an availability horizon. A 12-hour horizon
    # covers a 6-hour donor deadline; it is not 12 hours of response delay.
    assert result["best"]["pickup_window_hours"] == 12
    assert result["best"]["clock"]["effective_window_hours"] == 6
    assert result["best"]["time_margin_hours"] > 0
    assert len(result["fallbacks"]) == 2
    assert all(match["cold_storage"] != "none" for match in all_recommendations(result))

    greenline = rejection(result, "greenline")
    assert any("storage_incompatible" in reason for reason in greenline["reasons"])
    harborview = rejection(result, "harborview")
    assert any("manual_review_required" in reason for reason in harborview["reasons"])
    assert any("profile_flag_contradiction" in warning for warning in harborview["warnings"])


def test_dairy_requires_refrigerated_pickup_transport_and_returns_three():
    result = match_surplus(
        request("60 gallons of milk and yogurt", "refrigerated", 8, quantity=2),
        provider_for("dairy"),
    )

    assert len(all_recommendations(result)) == 3
    assert all(match["refrigerated_transport"] for match in all_recommendations(result))
    no_reefer = rejection(result, "no-reefer")
    assert "transport_incompatible:refrigerated_pickup_required" in no_reefer["reasons"]


def test_bread_applies_capacity_and_service_day_checks():
    result = match_surplus(
        request("200 loaves of day-old bread and pastries", "ambient", 24),
        provider_for("bread"),
    )

    assert len(all_recommendations(result)) == 3
    assert any("capacity_insufficient" in r for r in rejection(result, "too-small")["reasons"])
    assert "service_day_unavailable_before_deadline" in rejection(result, "closed")["reasons"]
    assert all(match["capacity_margin_pallets"] >= 0 for match in all_recommendations(result))


def test_prepared_food_returns_clear_no_match_when_every_candidate_is_unsafe():
    result = match_surplus(
        request("prepared sandwiches and salads, must move tonight", "refrigerated", 4),
        provider_for("prepared"),
    )

    assert result["no_match"] is True
    assert result["best"] is None
    assert result["fallbacks"] == []
    assert result["eligible_count"] == 0
    assert len(result["rejections"]) == 3
    assert "No operationally eligible recipient" in result["message"]


def test_invalid_request_fails_before_provider_call():
    with pytest.raises(ValueError, match="quantity_pallets"):
        match_surplus(
            request("bread", "ambient", 4, quantity=0),
            lambda *_args, **_kwargs: pytest.fail("provider should not run"),
        )
