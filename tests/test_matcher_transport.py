from __future__ import annotations

import pytest

from agent.matcher import TOP_K, build_bigquery_candidate_provider, match_surplus


NOW = "2026-10-19T09:00:00Z"  # Monday


def _candidate(*, longitude: float = -84.39) -> dict[str, object]:
    return {
        "recipient_id": "recipient-1",
        "name": "Neighborhood Pantry",
        "profile_text": "Fresh produce pantry with commercial cooler capacity.",
        "cold_storage": "commercial",
        "frozen_storage": False,
        "refrigerated_transport": False,
        "transport_available": False,
        "max_pallets": 3,
        "pickup_window_hours": 8,
        "service_days": "Monday Tuesday Wednesday Thursday Friday",
        "latitude": 33.75,
        "longitude": longitude,
        "semantic_distance": 0.1,
        "weekly_households": 250,
    }


def _request(**overrides: object) -> dict[str, object]:
    request: dict[str, object] = {
        "posting_text": "ten crates of refrigerated spinach",
        "storage_state": "refrigerated",
        "quantity_pallets": 1,
        "requested_at": NOW,
        "hours_remaining": 6,
        "donor_latitude": 33.75,
        "donor_longitude": -84.39,
    }
    request.update(overrides)
    return request


def _provider(candidate: dict[str, object]):
    def provide(_posting_text: str, *, top_k: int):
        assert top_k == TOP_K
        return [candidate]

    return provide


def test_donor_delivery_is_limited_to_five_kilometres() -> None:
    result = match_surplus(
        _request(transport_mode="donor_delivery", donor_delivery_radius_km=5),
        _provider(_candidate()),
    )

    assert result["best"]["recipient_id"] == "recipient-1"
    assert result["best"]["transport"]["maximum_donor_delivery_radius_km"] == 5
    assert result["best"]["transport"]["distance_source"].startswith("haversine")

    too_far = match_surplus(
        _request(transport_mode="donor_delivery", donor_delivery_radius_km=5),
        _provider(_candidate(longitude=-84.30)),
    )
    assert too_far["no_match"] is True
    assert any(
        reason.startswith("donor_delivery_radius_exceeded")
        for reason in too_far["rejections"][0]["reasons"]
    )


def test_donor_delivery_radius_over_five_is_rejected() -> None:
    with pytest.raises(ValueError, match="at most 5"):
        match_surplus(
            _request(transport_mode="donor_delivery", donor_delivery_radius_km=5.01),
            _provider(_candidate()),
        )


def test_legacy_delivery_boolean_defaults_to_five_kilometres() -> None:
    result = match_surplus(
        _request(donor_delivery_available=True),
        _provider(_candidate()),
    )
    assert result["best"]["transport"]["mode"] == "donor_delivery"
    assert result["best"]["transport"]["donor_delivery_radius_km"] == 5


def test_transportation_needed_cannot_silently_qualify() -> None:
    result = match_surplus(
        _request(transport_mode="transportation_needed"),
        _provider(_candidate()),
    )
    assert result["needs_transport"] is True
    assert result["no_match"] is True
    assert "transportation_needed:safe_arrangement_required" in result["rejections"][0][
        "reasons"
    ]


class _Row(dict):
    pass


class _Job:
    job_id = "job-vector-123"
    location = "US"
    labels = {
        "workload": "pantry_relay_vector_search",
        "sql_fingerprint": "0123456789abcdef",
    }
    total_bytes_processed = 12345

    def result(self):
        return [_Row(_candidate())]


class _Client:
    def __init__(self) -> None:
        self.sql = ""
        self.config = None

    def query(self, sql, *, job_config):
        self.sql = sql
        self.config = job_config
        return _Job()


def test_bigquery_provider_returns_correlated_vector_job_evidence() -> None:
    client = _Client()
    provider = build_bigquery_candidate_provider(project_id="test-project", client=client)

    batch = provider("spinach", top_k=TOP_K)

    assert len(batch) == 1
    evidence = batch.retrieval_evidence
    assert evidence["job_id"] == "job-vector-123"
    assert evidence["query_label"] == "pantry_relay_vector_search"
    assert len(evidence["sql_fingerprint_sha256"]) == 64
    assert evidence["vector_search"] is True
    assert evidence["use_brute_force"] is True
    assert "VECTOR_SEARCH(" in client.sql
    assert 'options => \'{"use_brute_force":true}\'' in client.sql
    assert client.config.labels["workload"] == "pantry_relay_vector_search"

