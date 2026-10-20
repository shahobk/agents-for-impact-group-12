"""Server-side Atlanta geocoding and route evidence with bounded fallbacks."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
import math
import re
from typing import Any
from urllib.parse import quote

import httpx


ATLANTA_CENTER = (33.7490, -84.3880)
ATLANTA_BOUNDS = {
    "min_latitude": 33.45,
    "max_latitude": 34.15,
    "min_longitude": -84.85,
    "max_longitude": -83.95,
}
DEMO_ANCHORS = {
    "atlanta demo grocery": {
        "formatted_address": "Atlanta Demo Grocery, Atlanta, GA",
        "latitude": 33.749,
        "longitude": -84.388,
        "source": "demo_fallback",
        "precision": "named_demo_anchor",
    }
}

GeocodeProvider = Callable[[str], Awaitable[Mapping[str, Any]]]
RouteProvider = Callable[[float, float, float, float], Awaitable[Mapping[str, Any]]]


class LocationError(ValueError):
    def __init__(self, code: str, message: str, *, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _normalized_address(address: str) -> str:
    return " ".join(address.lower().strip().rstrip(".,").split())


def within_atlanta_service_area(latitude: float, longitude: float) -> bool:
    return (
        ATLANTA_BOUNDS["min_latitude"] <= latitude <= ATLANTA_BOUNDS["max_latitude"]
        and ATLANTA_BOUNDS["min_longitude"] <= longitude <= ATLANTA_BOUNDS["max_longitude"]
    )


class LocationService:
    """Resolve an address to one reviewable point without persisting it."""

    def __init__(self, provider: GeocodeProvider | None = None) -> None:
        self.provider = provider

    async def geocode(self, address: str) -> dict[str, Any]:
        cleaned = " ".join(address.split()).strip()
        if len(cleaned) < 3:
            raise LocationError("invalid_address", "Enter a complete street address.")
        anchor = DEMO_ANCHORS.get(_normalized_address(cleaned))
        if self.provider is not None:
            try:
                candidate = dict(await self.provider(cleaned))
                latitude = float(candidate["latitude"])
                longitude = float(candidate["longitude"])
                if not within_atlanta_service_area(latitude, longitude):
                    raise LocationError(
                        "outside_atlanta_service_area",
                        "The resolved address is outside the Atlanta demo service area.",
                    )
                formatted = str(candidate.get("formatted_address") or cleaned).strip()
                return {
                    "formatted_address": formatted[:500],
                    "latitude": latitude,
                    "longitude": longitude,
                    "source": "google_geocoding",
                    "precision": str(candidate.get("precision") or "address").lower(),
                }
            except LocationError:
                if anchor is not None:
                    return dict(anchor)
                raise
            except Exception as exc:
                if anchor is None:
                    raise LocationError(
                        "geocoding_unavailable",
                        "Address lookup is temporarily unavailable. Use GPS or place a map pin.",
                        status_code=503,
                    ) from exc
        if anchor is not None:
            return dict(anchor)
        raise LocationError(
            "geocoding_unavailable",
            "Address lookup is unavailable for this address. Use GPS or place a map pin.",
            status_code=503,
        )


class _BoundedSession:
    """Create a requests session whose credential refresh cannot choose a long timeout."""

    @staticmethod
    def create(timeout_seconds: float):
        import requests

        class Session(requests.Session):
            def request(self, method, url, **kwargs):  # type: ignore[no-untyped-def]
                configured = kwargs.get("timeout", timeout_seconds)
                try:
                    kwargs["timeout"] = min(float(configured), timeout_seconds)
                except (TypeError, ValueError):
                    kwargs["timeout"] = timeout_seconds
                return super().request(method, url, **kwargs)

        return Session()


async def _adc_access_token(
    *, project: str | None, scope: str, timeout_seconds: float
) -> tuple[str, str]:
    def load() -> tuple[str, str]:
        import google.auth
        from google.auth.transport.requests import Request as GoogleAuthRequest

        credentials, default_project = google.auth.default(scopes=[scope])
        if not credentials.valid or not credentials.token:
            with _BoundedSession.create(timeout_seconds) as session:
                credentials.refresh(GoogleAuthRequest(session=session))
        billing_project = project or default_project
        if not credentials.token or not billing_project:
            raise RuntimeError("ADC token or quota project is unavailable")
        return credentials.token, billing_project

    return await asyncio.wait_for(asyncio.to_thread(load), timeout=timeout_seconds + 0.5)


def build_google_geocoder(
    *, project: str | None, timeout_seconds: float = 3.0
) -> GeocodeProvider | None:
    if not project:
        return None

    async def provider(address: str) -> Mapping[str, Any]:
        token, quota_project = await _adc_access_token(
            project=project,
            scope="https://www.googleapis.com/auth/maps-platform.geocode.address",
            timeout_seconds=timeout_seconds,
        )
        query = address if "atlanta" in address.lower() else f"{address}, Atlanta, GA"
        url = f"https://geocode.googleapis.com/v4/geocode/address/{quote(query, safe='')}"
        params = {
            "regionCode": "us",
            "languageCode": "en",
            "locationBias.rectangle.low.latitude": str(
                ATLANTA_BOUNDS["min_latitude"]
            ),
            "locationBias.rectangle.low.longitude": str(
                ATLANTA_BOUNDS["min_longitude"]
            ),
            "locationBias.rectangle.high.latitude": str(
                ATLANTA_BOUNDS["max_latitude"]
            ),
            "locationBias.rectangle.high.longitude": str(
                ATLANTA_BOUNDS["max_longitude"]
            ),
        }
        headers = {
            "Authorization": f"Bearer {token}",
            "X-Goog-User-Project": quota_project,
            "X-Goog-FieldMask": "results.formattedAddress,results.location,results.granularity",
        }
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.get(url, params=params, headers=headers)
            response.raise_for_status()
            payload = response.json()
        results = payload.get("results") or []
        if not results:
            raise LocationError("address_not_found", "No Atlanta address match was found.", status_code=404)
        first = results[0]
        location = first.get("location") or {}
        return {
            "formatted_address": first.get("formattedAddress") or address,
            "latitude": location["latitude"],
            "longitude": location["longitude"],
            "precision": first.get("granularity") or "address",
        }

    return provider


def haversine_route(
    origin_latitude: float,
    origin_longitude: float,
    destination_latitude: float,
    destination_longitude: float,
) -> dict[str, Any]:
    """Return clearly labeled straight-line evidence, never a safety override."""
    radius_miles = 3958.7613
    lat1, lat2 = math.radians(origin_latitude), math.radians(destination_latitude)
    delta_lat = math.radians(destination_latitude - origin_latitude)
    delta_lon = math.radians(destination_longitude - origin_longitude)
    a = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    )
    miles = 2 * radius_miles * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return {
        "distance_miles": round(miles, 2),
        "estimated_minutes": max(1, round(miles / 20 * 60)),
        "distance_source": "haversine_fallback",
        "traffic_aware": False,
        "safety_override": False,
    }


class RouteEstimator:
    def __init__(self, provider: RouteProvider | None = None) -> None:
        self.provider = provider

    async def estimate(
        self,
        origin_latitude: float,
        origin_longitude: float,
        destination_latitude: float,
        destination_longitude: float,
    ) -> dict[str, Any]:
        fallback = haversine_route(
            origin_latitude,
            origin_longitude,
            destination_latitude,
            destination_longitude,
        )
        if self.provider is None:
            return fallback
        try:
            result = dict(
                await self.provider(
                    origin_latitude,
                    origin_longitude,
                    destination_latitude,
                    destination_longitude,
                )
            )
            distance = float(result["distance_miles"])
            minutes = float(result["estimated_minutes"])
            if not math.isfinite(distance) or not math.isfinite(minutes) or distance < 0 or minutes <= 0:
                return fallback
            return {
                "distance_miles": round(distance, 2),
                "estimated_minutes": round(minutes),
                "distance_source": "google_routes",
                "traffic_aware": bool(result.get("traffic_aware", True)),
                "safety_override": False,
            }
        except Exception:
            return fallback


def build_google_routes_provider(
    *, project: str | None, timeout_seconds: float = 3.0
) -> RouteProvider | None:
    if not project:
        return None

    async def provider(
        origin_latitude: float,
        origin_longitude: float,
        destination_latitude: float,
        destination_longitude: float,
    ) -> Mapping[str, Any]:
        token, quota_project = await _adc_access_token(
            project=project,
            scope="https://www.googleapis.com/auth/cloud-platform",
            timeout_seconds=timeout_seconds,
        )
        body = {
            "origin": {"location": {"latLng": {"latitude": origin_latitude, "longitude": origin_longitude}}},
            "destination": {"location": {"latLng": {"latitude": destination_latitude, "longitude": destination_longitude}}},
            "travelMode": "DRIVE",
            "routingPreference": "TRAFFIC_AWARE",
        }
        headers = {
            "Authorization": f"Bearer {token}",
            "X-Goog-User-Project": quota_project,
            "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
        }
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(
                "https://routes.googleapis.com/directions/v2:computeRoutes",
                json=body,
                headers=headers,
            )
            response.raise_for_status()
            payload = response.json()
        routes = payload.get("routes") or []
        if not routes:
            raise RuntimeError("No route returned")
        route = routes[0]
        duration = str(route.get("duration") or "").rstrip("s")
        seconds_match = re.fullmatch(r"\d+(?:\.\d+)?", duration)
        if not seconds_match:
            raise RuntimeError("Invalid route duration")
        return {
            "distance_miles": float(route["distanceMeters"]) / 1609.344,
            "estimated_minutes": float(duration) / 60,
            "traffic_aware": True,
        }

    return provider


__all__ = [
    "LocationError",
    "LocationService",
    "RouteEstimator",
    "build_google_geocoder",
    "build_google_routes_provider",
    "haversine_route",
    "within_atlanta_service_area",
]
