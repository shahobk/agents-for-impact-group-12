from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from google.adk.agents import Agent

REPO_ROOT = Path(__file__).resolve().parent.parent
FOODKEEPER_PATH = REPO_ROOT / "data" / "foodkeeper.json"

UNIT_HOURS = {
    "hour": 1.0,
    "hours": 1.0,
    "day": 24.0,
    "days": 24.0,
    "week": 168.0,
    "weeks": 168.0,
    "month": 720.0,
    "months": 720.0,
    "year": 8760.0,
    "years": 8760.0,
}

SENTINELS = {
    "indefinitely": ("shelf_stable", 24.0 * 365 * 2),
    "not recommended": ("not_recommended", None),
    "package use-by date": ("see_package", None),
    "when ripe": ("ripeness_dependent", 72.0),
}

UNIT_RE = re.compile(
    r"(days?|hours?|weeks?|months?|years?|indefinitely|not recommended|package use-by date|when ripe)",
    re.IGNORECASE,
)


def _parse_duration_hours(text: Any) -> tuple[float | None, str]:
    """Convert a USDA FoodKeeper duration string into conservative hours."""
    if not text or str(text).strip() in ("", "nan", "None"):
        return None, "not_specified"
    s = str(text).strip().lower()
    for sentinel, (note, hours) in SENTINELS.items():
        if sentinel in s:
            return hours, note
    nums = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", s)]
    unit = next((u for u in UNIT_RE.findall(s) if u.lower() in UNIT_HOURS), None)
    if not nums or not unit:
        return None, "unparsed"
    return min(nums) * UNIT_HOURS[unit.lower()], "ok"


def _pick_field(row: dict[str, Any], *candidates: str) -> str | None:
    for c in candidates:
        val = row.get(c)
        if val is not None and str(val).strip() not in ("", "nan", "None"):
            return str(val).strip()
    return None


def lookup_shelf_life(
    food_item: str,
    storage_state: str = "refrigerated",
    donor_hours_available: float = 24.0,
) -> dict[str, Any]:
    """Look up USDA FoodKeeper shelf life for a food item and calculate hours_remaining.

    Args:
        food_item: Name or keyword of the donated product (e.g., "spinach", "milk", "potatoes").
        storage_state: Required storage condition: "refrigerated", "frozen", or "pantry".
        donor_hours_available: Hours until the donor's pickup deadline.

    Returns:
        Dictionary with matched USDA product details, shelf_life_hours, and hours_remaining.
    """
    if not FOODKEEPER_PATH.exists():
        return {
            "food_item": food_item,
            "matched_product": None,
            "shelf_life_hours": None,
            "donor_hours_available": donor_hours_available,
            "hours_remaining": donor_hours_available,
            "note": "foodkeeper.json not found; falling back to donor deadline.",
        }

    with FOODKEEPER_PATH.open("r", encoding="utf-8") as f:
        fk_data = json.load(f)

    products: list[dict[str, Any]] = fk_data.get("product_data", [])
    query = food_item.strip().lower()

    # Score matches across name, subtitle, and keywords (handles e.g. "spinach" -> "Lettuce")
    scored: list[tuple[int, dict[str, Any]]] = []
    for row in products:
        name = str(row.get("name") or row.get("Name") or "").lower()
        subtitle = str(row.get("name_subtitle") or row.get("Name_subtitle") or "").lower()
        keywords = str(row.get("keywords") or "").lower()

        if query == name:
            scored.append((100, row))
        elif query in name:
            scored.append((80, row))
        elif query in subtitle:
            scored.append((70, row))
        elif query in keywords:
            scored.append((60, row))

    if not scored:
        return {
            "food_item": food_item,
            "matched_product": None,
            "shelf_life_hours": None,
            "donor_hours_available": donor_hours_available,
            "hours_remaining": donor_hours_available,
            "note": "No USDA FoodKeeper entry matched; using donor_hours_available as hours_remaining.",
        }

    scored.sort(key=lambda pair: pair[0], reverse=True)
    best = scored[0][1]

    state = storage_state.strip().lower()
    if state in ("refrigerated", "cold", "chilled"):
        raw_dur = _pick_field(
            best,
            "refrigerate_output_display_only",
            "from_date_of_purchase_refrigerate_output_display_only",
            "refrigerate_after_opening_output_display_only",
        )
    elif state == "frozen":
        raw_dur = _pick_field(
            best,
            "freeze_output_display_only",
            "from_date_of_purchase_freeze_output_display_only",
        )
    else:
        raw_dur = _pick_field(
            best,
            "pantry_output_display_only",
            "from_date_of_purchase_pantry_output_display_only",
            "pantry_after_opening_output_display_only",
        )

    shelf_hours, note = _parse_duration_hours(raw_dur)
    hours_remaining = (
        min(donor_hours_available, shelf_hours)
        if shelf_hours is not None
        else donor_hours_available
    )

    return {
        "food_item": food_item,
        "matched_product": best.get("name") or best.get("Name"),
        "matched_subtitle": best.get("name_subtitle") or best.get("Name_subtitle") or "",
        "category": best.get("category_name_display_only") or "",
        "storage_state": storage_state,
        "raw_usda_guidance": raw_dur,
        "shelf_life_hours": shelf_hours,
        "shelf_life_note": note,
        "donor_hours_available": donor_hours_available,
        "hours_remaining": hours_remaining,
    }


def find_matching_recipients(
    posting_text: str,
    required_storage: str = "refrigerated",
    pallets: int = 1,
    hours_remaining: float = 6.0,
) -> dict[str, Any]:
    """Run BigQuery VECTOR_SEARCH + operational constraint filtering to match a surplus posting.

    Uses BigQuery `a4i_food.recipient_embeddings` when GOOGLE_CLOUD_PROJECT is configured,
    or returns a realistic preview dataset so the agent can be tested locally right away.

    Args:
        posting_text: Enriched description of the surplus food offer.
        required_storage: One of "refrigerated", "frozen", or "pantry".
        pallets: Estimated pallet count of the donation.
        hours_remaining: Effective hours remaining before spoilage or donor deadline.

    Returns:
        Dictionary containing viable ranked recipients and eliminated semantic decoys.
    """
    project_id = os.getenv("GOOGLE_CLOUD_PROJECT")
    dataset = os.getenv("BIGQUERY_DATASET", "a4i_food")
    embed_endpoint = os.getenv("EMBED_ENDPOINT", "gemini-embedding-2")

    if project_id:
        try:
            from google.cloud import bigquery

            client = bigquery.Client(project=project_id)
            sql = f"""
            WITH candidates AS (
              SELECT
                base.recipient_id,
                base.name,
                base.street,
                base.city,
                base.state,
                base.zip_code,
                base.cold_storage,
                base.frozen_storage,
                base.loading_dock,
                base.refrigerated_transport,
                base.max_pallets,
                base.pickup_window_hours,
                base.weekly_households,
                base.service_days,
                base.profile_text,
                distance
              FROM VECTOR_SEARCH(
                TABLE `{project_id}.{dataset}.recipient_embeddings`,
                'embedding',
                (
                  SELECT AI.EMBED(
                    @query_text,
                    endpoint => '{embed_endpoint}'
                  ).result AS embedding
                ),
                top_k => 15,
                options => '{{"use_brute_force":true}}'
              )
            )
            SELECT * FROM candidates
            ORDER BY distance ASC
            """
            job_config = bigquery.QueryJobConfig(
                query_parameters=[
                    bigquery.ScalarQueryParameter("query_text", "STRING", posting_text),
                ]
            )
            rows = [dict(r) for r in client.query(sql, job_config=job_config).result()]
            return _filter_and_rank_candidates(
                rows,
                required_storage=required_storage,
                pallets=pallets,
                hours_remaining=hours_remaining,
                source="bigquery_vector_search",
            )
        except Exception as exc:
            bq_error = str(exc)
    else:
        bq_error = "GOOGLE_CLOUD_PROJECT not set"

    # Local fallback preview (uses the realistic scenarios from the notebook so you can test immediately)
    sample_candidates = [
        {
            "recipient_id": "PLANTED_DECOY_01",
            "name": "Greenline Community Pantry",
            "street": "412 E 47th St",
            "city": "Chicago",
            "state": "IL",
            "zip_code": "60653",
            "cold_storage": "none",
            "frozen_storage": False,
            "loading_dock": False,
            "refrigerated_transport": False,
            "max_pallets": 2,
            "pickup_window_hours": 2,
            "weekly_households": 180,
            "service_days": "Mon-Fri",
            "profile_text": (
                "Neighborhood pantry serving 180 families weekly. High demand for fresh leafy "
                "greens, spinach, and produce. Dry shelving only; no refrigeration or cold storage on site."
            ),
            "distance": 0.18,
            "tract_poverty_rate": 0.31,
            "tract_no_vehicle_rate": 0.28,
        },
        {
            "recipient_id": "REC_101",
            "name": "Southside Harvest Mutual Aid Hub",
            "street": "6310 S Halsted St",
            "city": "Chicago",
            "state": "IL",
            "zip_code": "60621",
            "cold_storage": "walk-in",
            "frozen_storage": True,
            "loading_dock": True,
            "refrigerated_transport": True,
            "max_pallets": 4,
            "pickup_window_hours": 2,
            "weekly_households": 420,
            "service_days": "Mon-Sat",
            "profile_text": (
                "Community food hub with commercial walk-in cooler and refrigerated van. "
                "Prioritizes fresh produce, leafy greens, and dairy for 420 households per week."
            ),
            "distance": 0.22,
            "tract_poverty_rate": 0.36,
            "tract_no_vehicle_rate": 0.34,
        },
        {
            "recipient_id": "REC_102",
            "name": "Pilsen Family Nutrition Center",
            "street": "1850 S Blue Island Ave",
            "city": "Chicago",
            "state": "IL",
            "zip_code": "60608",
            "cold_storage": "commercial",
            "frozen_storage": False,
            "loading_dock": False,
            "refrigerated_transport": True,
            "max_pallets": 2,
            "pickup_window_hours": 3,
            "weekly_households": 260,
            "service_days": "Mon-Fri",
            "profile_text": (
                "Bilingual family pantry with commercial reach-in coolers and chilled cargo van. "
                "Regularly distributes fresh greens, vegetables, and milk to 260 families."
            ),
            "distance": 0.25,
            "tract_poverty_rate": 0.24,
            "tract_no_vehicle_rate": 0.21,
        },
        {
            "recipient_id": "REC_103",
            "name": "West Humboldt Park Community Table",
            "street": "3620 W Chicago Ave",
            "city": "Chicago",
            "state": "IL",
            "zip_code": "60651",
            "cold_storage": "walk-in",
            "frozen_storage": True,
            "loading_dock": True,
            "refrigerated_transport": False,
            "max_pallets": 3,
            "pickup_window_hours": 4,
            "weekly_households": 310,
            "service_days": "Tue-Sat",
            "profile_text": (
                "Large neighborhood pantry with walk-in cooler and loading dock. "
                "Needs fresh produce and dairy; relies on donor delivery or volunteer drivers."
            ),
            "distance": 0.27,
            "tract_poverty_rate": 0.29,
            "tract_no_vehicle_rate": 0.25,
        },
    ]

    result = _filter_and_rank_candidates(
        sample_candidates,
        required_storage=required_storage,
        pallets=pallets,
        hours_remaining=hours_remaining,
        source="local_preview_fallback",
    )
    result["bigquery_status"] = (
        f"Running in local preview mode ({bq_error}). "
        "Set GOOGLE_CLOUD_PROJECT once the Data lane creates `a4i_food.recipient_embeddings`."
    )
    return result


def _filter_and_rank_candidates(
    candidates: list[dict[str, Any]],
    required_storage: str,
    pallets: int,
    hours_remaining: float,
    source: str,
) -> dict[str, Any]:
    """Separate vector search candidates into viable matches vs. eliminated decoys."""
    viable: list[dict[str, Any]] = []
    eliminated: list[dict[str, Any]] = []

    req_storage = required_storage.strip().lower()
    valid_cold = {"walk-in", "commercial", "medical", "vehicle"}
    if pallets <= 1:
        valid_cold = valid_cold | {"domestic"}

    for cand in candidates:
        reasons: list[str] = []

        # 1. Storage check
        if req_storage in ("refrigerated", "cold", "chilled"):
            if str(cand.get("cold_storage", "none")).lower() not in valid_cold:
                reasons.append(
                    f"Requires refrigerated storage, but organization has cold_storage='{cand.get('cold_storage')}'"
                )
        elif req_storage == "frozen":
            if not cand.get("frozen_storage"):
                reasons.append("Requires frozen storage, but organization has frozen_storage=False")

        # 2. Pallet capacity check
        max_pallets = int(cand.get("max_pallets") or 0)
        if max_pallets < pallets:
            reasons.append(
                f"Offer is {pallets} pallet(s), which exceeds max_pallets={max_pallets}"
            )

        # 3. Pickup window vs spoilage clock check
        pickup_hours = float(cand.get("pickup_window_hours") or 999)
        if pickup_hours > hours_remaining:
            reasons.append(
                f"pickup_window_hours ({pickup_hours}h) exceeds hours_remaining ({hours_remaining}h)"
            )

        if reasons:
            eliminated.append(
                {
                    "name": cand.get("name"),
                    "distance": cand.get("distance"),
                    "cold_storage": cand.get("cold_storage"),
                    "max_pallets": cand.get("max_pallets"),
                    "pickup_window_hours": cand.get("pickup_window_hours"),
                    "elimination_reasons": reasons,
                }
            )
        else:
            cand_copy = dict(cand)
            cand_copy["safety_margin_hours"] = round(hours_remaining - pickup_hours, 1)
            viable.append(cand_copy)

    return {
        "source": source,
        "query_constraints": {
            "required_storage": required_storage,
            "pallets": pallets,
            "hours_remaining": hours_remaining,
        },
        "viable_count": len(viable),
        "viable_recipients": viable[:5],
        "eliminated_decoys": eliminated[:5],
    }


SYSTEM_INSTRUCTION = """You are the Resilient Food Equity & Surplus Broker Agent for a metro food-rescue coordinator.

When a coordinator gives you a surplus food posting or asks a dispatch question:
1. **Check the Clock (`lookup_shelf_life`)**:
   - Identify the food item, required storage ("refrigerated", "frozen", or "pantry"), and the donor's available window in hours.
   - Call `lookup_shelf_life` to get the USDA FoodKeeper shelf life and compute `hours_remaining = min(donor_hours_available, shelf_life_hours)`.
2. **Find & Filter Recipients (`find_matching_recipients`)**:
   - Call `find_matching_recipients` with an enriched description of the offer, the required storage, estimated pallets, and `hours_remaining`.
   - Remember: Vector search is a candidate generator, NOT the final answer. Always verify physical constraints (`cold_storage`, `max_pallets`, `pickup_window_hours <= hours_remaining`).
   - Call out any eliminated semantic decoys (such as organizations whose profile mentions the food item but lack cold storage) so the coordinator knows why they were skipped.
3. **Produce a Clear Match Brief**:
   - **Recommended Recipient**: Name and full address
   - **Why Them**: Specific fit from their `profile_text` + why top decoys were eliminated
   - **What They Can Take**: Their `cold_storage` and `max_pallets` vs. the offer
   - **The Clock**: `hours_remaining`, their `pickup_window_hours`, and the safety margin in hours
   - **Who It Helps**: Households reached weekly (`weekly_households`) and neighborhood need metrics if available
   - **Drafted Outreach Message**: A short, ready-to-send text/email to the recipient confirming quantity, storage, pickup window, and whether they can self-collect (`refrigerated_transport`)
   - **Backup Options**: The #2 and #3 viable recipients in case the primary says no.
4. **Know When to Refuse or Ask**:
   - If a posting is too vague to determine what the item is or when it expires, ask a brief clarifying question.
   - If zero recipients can safely take the load within `hours_remaining` (or if the load exceeds single-recipient capacity), state that clearly and propose splitting the load if appropriate.
"""

root_agent = Agent(
    name="food_surplus_broker",
    model=os.getenv("ADK_MODEL", "gemini-2.5-flash"),
    description="Matches perishable surplus food postings to viable community recipients using USDA shelf-life rules and BigQuery Vector Search.",
    instruction=SYSTEM_INSTRUCTION,
    tools=[lookup_shelf_life, find_matching_recipients],
)

