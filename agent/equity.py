"""Transparent ten-posting outcome audit for matcher equity evidence."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os
import re
from statistics import fmean
from typing import Any, Iterable, Mapping

from .matcher import build_bigquery_candidate_provider, match_surplus


def summarize_equity_audit(
    posting_results: Iterable[Mapping[str, Any]],
    *,
    expected_postings: int = 10,
) -> dict[str, Any]:
    """Summarize selected-recipient tract evidence without inferring protected traits."""

    postings = [dict(item) for item in posting_results]
    selected = [item for item in postings if item.get("selected_recipient_id")]
    tract_evidenced = [item for item in selected if item.get("tract_geo_id")]
    poverty = [
        float(item["poverty_rate"])
        for item in tract_evidenced
        if item.get("poverty_rate") is not None
    ]
    no_vehicle = [
        float(item["no_vehicle_rate"])
        for item in tract_evidenced
        if item.get("no_vehicle_rate") is not None
    ]
    return {
        "status": "complete" if len(postings) == expected_postings else "incomplete",
        "expected_postings": expected_postings,
        "posting_count": len(postings),
        "matched_postings": len(selected),
        "no_match_postings": len(postings) - len(selected),
        "tract_evidence_count": len(tract_evidenced),
        "weekly_households_fallback_count": sum(
            item.get("need_evidence_source") == "weekly_households_fallback"
            for item in selected
        ),
        "selected_mean_poverty_rate": round(fmean(poverty), 4) if poverty else None,
        "selected_mean_no_vehicle_rate": (
            round(fmean(no_vehicle), 4) if no_vehicle else None
        ),
        "postings": postings,
        "limitations": [
            "Recipient positions are approximate ZIP centroids; nearest tracts are approximate.",
            "Operational recipient capabilities and profile prose are generated.",
            "This audits matcher selections, not completed handoffs or live recipient capacity.",
            "Race and ethnicity are not matching inputs and are not inferred by this audit.",
        ],
    }


def run_bigquery_equity_audit(
    *,
    project_id: str | None = None,
    dataset: str | None = None,
    donor_latitude: float = 33.749,
    donor_longitude: float = -84.388,
    quantity_pallets: float = 1.0,
    requested_at: datetime | None = None,
    client: Any | None = None,
) -> dict[str, Any]:
    """Run the deterministic matcher over the ten published sample postings.

    The corpus does not include donor coordinates or normalized quantities, so
    this audit uses one documented Atlanta anchor and one pallet for every
    posting. Those generated assumptions are reported in the result.
    """

    project = project_id or os.getenv("BQ_PROJECT_ID") or os.getenv("GOOGLE_CLOUD_PROJECT")
    dataset_name = dataset or os.getenv("BQ_DATASET", "a4i_food")
    if not project or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", project):
        raise ValueError("A valid BigQuery project ID is required")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", dataset_name):
        raise ValueError("A valid BigQuery dataset name is required")
    if client is None:
        from google.cloud import bigquery

        client = bigquery.Client(project=project)
    else:
        from google.cloud import bigquery

    source_sql = f"""
    SELECT posting_id, posting_text, storage_state, hours_remaining
    FROM `{project}.{dataset_name}.surplus_postings`
    ORDER BY posting_id
    LIMIT 10
    """
    source_config = bigquery.QueryJobConfig(
        labels={"workload": "pantry_relay_equity_audit"}
    )
    source_job = client.query(source_sql, job_config=source_config)
    postings = [dict(row.items()) for row in source_job.result()]
    provider = build_bigquery_candidate_provider(
        project_id=project,
        dataset=dataset_name,
        client=client,
    )
    now = requested_at or datetime.now(timezone.utc)
    records: list[dict[str, Any]] = []
    vector_job_ids: list[str] = []
    for posting in postings:
        hours = max(0.25, float(posting.get("hours_remaining") or 0))
        result = match_surplus(
            {
                "posting_text": posting["posting_text"],
                "quantity_pallets": quantity_pallets,
                "storage_state": posting["storage_state"],
                "requested_at": now,
                "pickup_deadline": now + timedelta(hours=hours),
                "donor_latitude": donor_latitude,
                "donor_longitude": donor_longitude,
                "transport_mode": "recipient_pickup",
            },
            provider,
        )
        selected = result.get("selected") or {}
        need = selected.get("need_evidence") or {}
        job_id = (result.get("retrieval_evidence") or {}).get("job_id")
        if job_id:
            vector_job_ids.append(str(job_id))
        records.append(
            {
                "posting_id": posting["posting_id"],
                "selected_recipient_id": selected.get("recipient_id"),
                "no_match": result.get("no_match", True),
                "eligible_count": result.get("eligible_count", 0),
                "tract_geo_id": need.get("tract_geo_id"),
                "poverty_rate": need.get("poverty_rate"),
                "no_vehicle_rate": need.get("no_vehicle_rate"),
                "need_score": need.get("score"),
                "need_evidence_source": need.get("source"),
            }
        )
    audit = summarize_equity_audit(records, expected_postings=10)
    audit.update(
        {
            "source_job_id": getattr(source_job, "job_id", None),
            "vector_job_ids": vector_job_ids,
            "generated_assumptions": {
                "donor_location": {
                    "latitude": donor_latitude,
                    "longitude": donor_longitude,
                    "label": "Atlanta demo anchor; not supplied by sample postings",
                },
                "quantity_pallets": quantity_pallets,
                "quantity_label": "standardized because sample postings lack normalized quantity",
            },
        }
    )
    return audit


__all__ = ["run_bigquery_equity_audit", "summarize_equity_audit"]
