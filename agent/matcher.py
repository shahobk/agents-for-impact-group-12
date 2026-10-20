"""Semantic candidate retrieval followed by auditable deterministic matching.

BigQuery vector search deliberately supplies candidates only.  Every returned
recommendation passes storage, capacity, transport, service-day, pickup-window,
and travel-margin checks here before deterministic ranking.
"""

from __future__ import annotations

import calendar
import math
import os
import re
from collections.abc import Iterable, Mapping
from datetime import date, datetime, timedelta
from typing import Any, Protocol

try:  # Supports both ``import agent.matcher`` and direct local execution.
    from .models import CandidateEvaluation, MatchRequest, RecipientCandidate
except ImportError:  # pragma: no cover - convenience for ``python agent/matcher.py``
    from models import CandidateEvaluation, MatchRequest, RecipientCandidate


TOP_K = 30
_COLD_STORAGE = {"walk-in", "commercial", "medical", "vehicle"}
_WEEKDAYS = {name.lower(): index for index, name in enumerate(calendar.day_name)}


class CandidateProvider(Protocol):
    def __call__(
        self, posting_text: str, *, top_k: int = TOP_K
    ) -> Iterable[RecipientCandidate | Mapping[str, Any]]: ...


class MatcherConfigurationError(RuntimeError):
    """The default online candidate provider is not configured."""


def haversine_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return great-circle distance in miles between two coordinates."""

    radius_miles = 3958.7613
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )
    return radius_miles * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _service_dates(service_days: str, start: datetime, end: datetime) -> list[date]:
    """Expand the corpus' weekday/ordinal phrases over a short pickup interval."""

    text = service_days.strip().lower()
    if not text:
        return []
    weekdays = {index for name, index in _WEEKDAYS.items() if name in text}
    ordinals: set[int] = set()
    if "first" in text:
        ordinals.add(1)
    if "second" in text:
        ordinals.add(2)
    if "third" in text:
        ordinals.add(3)
    if "fourth" in text:
        ordinals.add(4)

    dates: list[date] = []
    cursor = start.date()
    while cursor <= end.date():
        if cursor.weekday() in weekdays:
            if not ordinals or ((cursor.day - 1) // 7 + 1) in ordinals:
                dates.append(cursor)
        cursor += timedelta(days=1)
    return dates


def _profile_flag_warnings(candidate: RecipientCandidate) -> list[str]:
    text = candidate.profile_text.lower()
    warnings: list[str] = []
    affirmative_cold = re.search(
        r"walk-in|cooler|reach-in|reefer|chilled|cold chain capacity|"
        r"refrigerated (?:storage|van|bays)",
        text,
    )
    cold_denial = re.search(
        r"no refrigeration|no cold storage|dry storage only|"
        r"single shelf in a shared cupboard",
        text,
    )
    freezer_denial = re.search(r"no freezer|without (?:a )?freezer", text)

    if candidate.cold_storage == "none" and affirmative_cold:
        warnings.append("profile_flag_contradiction:cold_storage_none_but_text_claims_cold")
    if candidate.cold_storage in _COLD_STORAGE and cold_denial:
        warnings.append("profile_flag_contradiction:cold_storage_flag_but_text_denies_cold")
    if candidate.frozen_storage and freezer_denial:
        warnings.append("profile_flag_contradiction:frozen_flag_but_text_denies_freezer")
    if candidate.cold_storage == "walk-in" and re.search(
        r"household (?:refrigerator|fridge)|domestic|residential-scale", text
    ):
        warnings.append("profile_flag_contradiction:walk_in_flag_but_text_describes_domestic")
    return warnings


def _evaluate(request: MatchRequest, candidate: RecipientCandidate) -> CandidateEvaluation:
    reasons: list[str] = []
    warnings = _profile_flag_warnings(candidate)
    storage_state = "ambient" if request.storage_state == "pantry" else request.storage_state

    if warnings:
        # Generated capability data can be wrong. Contradictions require a human
        # verification call and may never silently become a recommendation.
        reasons.append("manual_review_required:profile_flag_contradiction")

    if storage_state == "refrigerated" and candidate.cold_storage not in _COLD_STORAGE:
        reasons.append("storage_incompatible:commercial_refrigeration_required")
    elif storage_state == "frozen" and (
        not candidate.frozen_storage or candidate.cold_storage not in _COLD_STORAGE
    ):
        reasons.append("storage_incompatible:frozen_storage_required")

    capacity_margin = candidate.max_pallets - request.quantity_pallets
    if capacity_margin < 0:
        reasons.append(
            f"capacity_insufficient:needs_{request.quantity_pallets:g}_pallets_"
            f"but_max_is_{candidate.max_pallets:g}"
        )

    if not request.donor_delivery_available:
        if candidate.transport_available is False:
            reasons.append("transport_unavailable:recipient_cannot_collect")
        elif storage_state in {"refrigerated", "frozen"} and not candidate.refrigerated_transport:
            reasons.append("transport_incompatible:refrigerated_pickup_required")
        elif storage_state == "ambient" and candidate.transport_available is None:
            warnings.append("general_transport_not_structured:confirm_pickup_vehicle")

    if candidate.latitude is None or candidate.longitude is None:
        reasons.append("location_missing:cannot_estimate_travel")
        distance = math.inf
        travel_time = math.inf
    else:
        distance = haversine_miles(
            request.donor_latitude,
            request.donor_longitude,
            candidate.latitude,
            candidate.longitude,
        )
        travel_time = distance / request.average_speed_mph
    if candidate.pickup_window_hours is None:
        reasons.append("pickup_window_unknown")
        pickup_window_hours = math.inf
    else:
        pickup_window_hours = candidate.pickup_window_hours
    # pickup_window_hours is the recipient's availability horizon, not time
    # already consumed. The trip must fit inside both that horizon and the
    # donor's deadline. Subtracting the whole window from the deadline would
    # make a longer (more flexible) window perversely worse and would exclude
    # the corpus' planted 12-hour produce tie from the 6-hour spinach case.
    effective_window_hours = min(request.hours_remaining, pickup_window_hours)
    time_margin = (
        effective_window_hours - travel_time - request.handling_buffer_hours
    )
    if time_margin < 0 and math.isfinite(time_margin):
        reasons.append(f"travel_time_margin_negative:{time_margin:.2f}_hours")

    if not _service_dates(candidate.service_days, request.requested_at, request.pickup_deadline):
        reasons.append("service_day_unavailable_before_deadline")

    # Providers may supply an equity/need score in [0, 1]. Without one, weekly
    # households is an explicit demand proxy, squashed to the same scale.
    need_score = (
        max(0.0, min(1.0, candidate.need_score))
        if candidate.need_score is not None
        else (candidate.weekly_households or 0) / ((candidate.weekly_households or 0) + 500)
    )
    return CandidateEvaluation(
        recipient_id=candidate.recipient_id,
        name=candidate.name,
        eligible=not reasons,
        reasons=tuple(reasons),
        warnings=tuple(warnings),
        distance_miles=distance,
        travel_time_hours=travel_time,
        time_margin_hours=time_margin,
        capacity_margin_pallets=capacity_margin,
        semantic_distance=candidate.semantic_distance,
        need_score=need_score,
        candidate=candidate,
    )


def _ranking_key(evaluation: CandidateEvaluation) -> tuple[Any, ...]:
    # Feasibility margin first, then locality, useful spare capacity, and the
    # explicit need tie-break. Semantic distance and ID make exact ties stable.
    return (
        -evaluation.time_margin_hours,
        evaluation.distance_miles,
        -evaluation.capacity_margin_pallets,
        -evaluation.need_score,
        evaluation.semantic_distance,
        evaluation.recipient_id,
    )


def _operationally_tied(left: CandidateEvaluation, right: CandidateEvaluation) -> bool:
    return (
        math.isclose(left.time_margin_hours, right.time_margin_hours, abs_tol=0.01)
        and math.isclose(left.distance_miles, right.distance_miles, abs_tol=0.01)
        and math.isclose(
            left.capacity_margin_pallets,
            right.capacity_margin_pallets,
            abs_tol=0.01,
        )
    )


def _address(candidate: RecipientCandidate) -> str:
    locality = ", ".join(part for part in (candidate.city, candidate.state) if part)
    return ", ".join(part for part in (candidate.street, locality, candidate.zip_code) if part)


def _recommendation(evaluation: CandidateEvaluation, request: MatchRequest) -> dict[str, Any]:
    candidate = evaluation.candidate
    result = evaluation.to_dict()
    result.update(
        {
            "address": _address(candidate),
            "cold_storage": candidate.cold_storage,
            "frozen_storage": candidate.frozen_storage,
            "refrigerated_transport": candidate.refrigerated_transport,
            "max_pallets": candidate.max_pallets,
            "pickup_window_hours": candidate.pickup_window_hours,
            "service_days": candidate.service_days,
            "profile_text": candidate.profile_text,
            "populations_served": candidate.populations_served,
            "selection_reason": (
                f"Eligible with {evaluation.time_margin_hours:.1f} hours of travel/handling "
                f"margin, {evaluation.distance_miles:.1f} miles away, and "
                f"{evaluation.capacity_margin_pallets:.1f} pallets of spare capacity."
            ),
            "capacity": {
                "offered_pallets": request.quantity_pallets,
                "max_pallets": candidate.max_pallets,
                "margin_pallets": round(evaluation.capacity_margin_pallets, 2),
            },
            "travel": {
                "distance_miles": round(evaluation.distance_miles, 2),
                "estimated_minutes": round(evaluation.travel_time_hours * 60),
            },
            "clock": {
                "deadline": request.pickup_deadline.isoformat(),
                "hours_remaining": round(request.hours_remaining, 2),
                "recipient_pickup_window_hours": candidate.pickup_window_hours,
                "effective_window_hours": round(
                    min(request.hours_remaining, candidate.pickup_window_hours), 2
                ),
                "estimated_travel_minutes": round(evaluation.travel_time_hours * 60),
                "remaining_margin_hours": round(evaluation.time_margin_hours, 2),
            },
        }
    )
    return result


def _call_provider(
    provider: CandidateProvider, request: MatchRequest
) -> Iterable[RecipientCandidate | Mapping[str, Any]]:
    return provider(request.posting_text, top_k=TOP_K)


def match_surplus(
    request: MatchRequest | Mapping[str, Any],
    candidate_provider: CandidateProvider | None = None,
) -> dict[str, Any]:
    """Return one safe match, up to two fallbacks, and audited rejections.

    An injected provider makes this function deterministic and credential-free
    offline.  Without one, the environment-configured BigQuery provider runs the
    required top-30 brute-force vector search.
    """

    parsed = MatchRequest.from_value(request)
    parsed.validate()
    provider = candidate_provider or build_bigquery_candidate_provider()
    raw_candidates = list(_call_provider(provider, parsed))[:TOP_K]
    candidates = [RecipientCandidate.from_value(item) for item in raw_candidates]
    evaluations = [_evaluate(parsed, candidate) for candidate in candidates]
    eligible = sorted((item for item in evaluations if item.eligible), key=_ranking_key)
    rejected = [item for item in evaluations if not item.eligible]

    recommendations = [_recommendation(item, parsed) for item in eligible[:3]]
    if len(eligible) >= 2 and _operationally_tied(eligible[0], eligible[1]):
        recommendations[0]["selection_reason"] += (
            f" Operationally tied with {eligible[1].name}; selected using the explicit "
            f"need tie-break ({eligible[0].need_score:.2f} vs "
            f"{eligible[1].need_score:.2f})."
        )
    no_match = not recommendations
    best = recommendations[0] if recommendations else None
    result_warnings = list(
        dict.fromkeys(
            f"{item.name}: {warning}"
            for item in evaluations
            for warning in item.warnings
        )
    )
    if parsed.split_allowed:
        result_warnings.append(
            "split_allowed_is_not_used:every_recommendation_must_hold_the_full_offer"
        )
    outreach = None
    if best:
        action = "receive" if parsed.donor_delivery_available else "collect"
        outreach = (
            f"Hello {best['name']}, we have {parsed.posting_text} "
            f"({parsed.quantity_pallets:g} pallet equivalent(s)) requiring "
            f"{parsed.storage_state} handling. Can you {action} it by "
            f"{parsed.pickup_deadline.isoformat()}? Please confirm current capacity "
            "and availability."
        )
    return {
        "query": parsed.posting_text,
        "candidate_count": len(candidates),
        "eligible_count": len(eligible),
        "best": best,
        "selected": best,
        "fallbacks": recommendations[1:3],
        "rejections": [item.to_dict() for item in rejected],
        "no_match": no_match,
        "outreach": outreach,
        "message": (
            "No operationally eligible recipient was found in the top 30 semantic candidates."
            if no_match
            else f"Found {len(eligible)} eligible recipient(s); returning the best "
            f"{len(recommendations)}."
        ),
        "warnings": result_warnings,
    }


def build_bigquery_candidate_provider(
    *,
    project_id: str | None = None,
    dataset: str | None = None,
    client: Any | None = None,
) -> CandidateProvider:
    """Create a provider backed by BigQuery's brute-force VECTOR_SEARCH.

    Configuration uses ``GOOGLE_CLOUD_PROJECT`` (or ``BQ_PROJECT_ID``) and
    ``BQ_DATASET`` (default ``a4i_food``). Importing this module remains offline
    safe; google-cloud-bigquery is loaded only when this factory is called.
    """

    project = project_id or os.getenv("BQ_PROJECT_ID") or os.getenv("GOOGLE_CLOUD_PROJECT")
    dataset_name = dataset or os.getenv("BQ_DATASET", "a4i_food")
    if not project:
        raise MatcherConfigurationError(
            "Set GOOGLE_CLOUD_PROJECT/BQ_PROJECT_ID or inject candidate_provider for offline use."
        )
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", project):
        raise MatcherConfigurationError("Invalid BigQuery project ID")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", dataset_name):
        raise MatcherConfigurationError("Invalid BigQuery dataset name")

    try:
        from google.cloud import bigquery
    except ImportError as exc:  # pragma: no cover - depends on deployment extras
        raise MatcherConfigurationError(
            "google-cloud-bigquery is required for the default provider; "
            "inject candidate_provider to run offline."
        ) from exc

    bq_client = client or bigquery.Client(project=project)
    table_id = f"{project}.{dataset_name}.recipient_embeddings"
    sql = f"""
    SELECT
      CAST(base.recipient_id AS STRING) AS recipient_id,
      base.name,
      base.street,
      base.city,
      base.state,
      base.zip_code,
      base.ein,
      base.ntee_code,
      base.archetype,
      base.archetype_label,
      base.cold_storage,
      base.frozen_storage,
      base.loading_dock,
      base.refrigerated_transport,
      base.max_pallets,
      base.pickup_window_hours,
      base.weekly_households,
      base.reported_income,
      base.populations_served,
      base.service_days,
      base.profile_text,
      base.profile_source,
      base.latitude,
      base.longitude,
      distance AS semantic_distance
    FROM VECTOR_SEARCH(
      TABLE `{table_id}`,
      'embedding',
      (SELECT AI.EMBED(@posting_text, endpoint => 'gemini-embedding-2').result AS embedding),
      top_k => 30,
      distance_type => 'COSINE',
      options => '{{"use_brute_force":true}}'
    )
    ORDER BY semantic_distance
    LIMIT 30
    """

    def provider(posting_text: str, *, top_k: int = TOP_K) -> Iterable[Mapping[str, Any]]:
        del top_k  # SQL intentionally fixes the audited candidate set at 30.
        config = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("posting_text", "STRING", posting_text)
            ]
        )
        return [dict(row.items()) for row in bq_client.query(sql, job_config=config).result()]

    return provider


__all__ = [
    "CandidateProvider",
    "MatcherConfigurationError",
    "TOP_K",
    "build_bigquery_candidate_provider",
    "haversine_miles",
    "match_surplus",
]
