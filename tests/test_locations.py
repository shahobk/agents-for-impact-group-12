from __future__ import annotations

import asyncio

import pytest

from agent.locations import (
    LocationError,
    LocationService,
    RouteEstimator,
    haversine_route,
)


def test_named_demo_anchor_is_the_only_credential_free_address_fallback():
    service = LocationService()
    result = asyncio.run(service.geocode("Atlanta demo grocery"))

    assert result == {
        "formatted_address": "Atlanta Demo Grocery, Atlanta, GA",
        "latitude": 33.749,
        "longitude": -84.388,
        "source": "demo_fallback",
        "precision": "named_demo_anchor",
    }
    with pytest.raises(LocationError) as unavailable:
        asyncio.run(service.geocode("123 Unverified Street"))
    assert unavailable.value.status_code == 503


def test_google_candidate_is_normalized_and_strictly_bounded_to_atlanta():
    async def good_provider(_address):
        return {
            "formatted_address": "10 Peachtree St, Atlanta, GA 30303",
            "latitude": 33.752,
            "longitude": -84.391,
            "precision": "ROOFTOP",
            "ignored": "not exposed",
        }

    result = asyncio.run(LocationService(good_provider).geocode("10 Peachtree St"))
    assert result == {
        "formatted_address": "10 Peachtree St, Atlanta, GA 30303",
        "latitude": 33.752,
        "longitude": -84.391,
        "source": "google_geocoding",
        "precision": "rooftop",
    }

    async def outside_provider(_address):
        return {
            "formatted_address": "New York, NY",
            "latitude": 40.7128,
            "longitude": -74.006,
        }

    with pytest.raises(LocationError) as outside:
        asyncio.run(LocationService(outside_provider).geocode("10 Main Street"))
    assert outside.value.code == "outside_atlanta_service_area"


def test_provider_failure_only_falls_back_for_named_demo_anchor():
    async def unavailable(_address):
        raise TimeoutError("bounded timeout")

    demo = asyncio.run(LocationService(unavailable).geocode("Atlanta demo grocery"))
    assert demo["source"] == "demo_fallback"
    with pytest.raises(LocationError) as failure:
        asyncio.run(LocationService(unavailable).geocode("10 Peachtree St"))
    assert failure.value.code == "geocoding_unavailable"


def test_routes_adapter_uses_labeled_haversine_fallback_without_override():
    fallback = haversine_route(33.749, -84.388, 33.76, -84.37)
    assert fallback["distance_miles"] > 0
    assert fallback["distance_source"] == "haversine_fallback"
    assert fallback["traffic_aware"] is False
    assert fallback["safety_override"] is False

    async def failing_provider(*_coordinates):
        raise TimeoutError("route timeout")

    result = asyncio.run(
        RouteEstimator(failing_provider).estimate(33.749, -84.388, 33.76, -84.37)
    )
    assert result == fallback


def test_routes_adapter_normalizes_google_evidence_but_never_overrides_safety():
    async def provider(*_coordinates):
        return {
            "distance_miles": 2.125,
            "estimated_minutes": 11.6,
            "traffic_aware": True,
            "safety_override": True,
        }

    result = asyncio.run(
        RouteEstimator(provider).estimate(33.749, -84.388, 33.76, -84.37)
    )
    assert result == {
        "distance_miles": 2.12,
        "estimated_minutes": 12,
        "distance_source": "google_routes",
        "traffic_aware": True,
        "safety_override": False,
    }
