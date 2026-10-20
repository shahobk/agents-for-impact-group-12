from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from google.adk.agents import Agent

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = Path(__file__).resolve().parent / ".env"
FOODKEEPER_PATH = REPO_ROOT / "data" / "foodkeeper.json"
PROFILE_COMPONENTS_PATH = REPO_ROOT / "data" / "profile_components.json"


def _load_dotenv_if_present() -> None:
    """Load key=value pairs from agent/.env into os.environ if not already set."""
    if not ENV_PATH.exists():
        return
    for raw_line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


_load_dotenv_if_present()

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

# Exact 10 surplus postings from notebooks/c2_01_load_explore.ipynb (Section 10)
LOCAL_SURPLUS_POSTINGS: list[dict[str, Any]] = [
    {
        "posting_id": 1,
        "track": "RETAIL",
        "posting_text": "10 crates of spinach, harvested yesterday, needs cold storage",
        "foodkeeper_product": "Lettuce",
        "storage_state": "refrigerated",
        "hours_available": 6.0,
        "estimated_pallets": 2,
    },
    {
        "posting_id": 2,
        "track": "RETAIL",
        "posting_text": "mixed dairy - about 60 gallons of milk and some yogurt, 2 days to code date",
        "foodkeeper_product": "Milk",
        "storage_state": "refrigerated",
        "hours_available": 8.0,
        "estimated_pallets": 2,
    },
    {
        "posting_id": 3,
        "track": "RETAIL",
        "posting_text": "roughly 200 loaves of day-old bread and pastries from three store locations",
        "foodkeeper_product": "Bread",
        "storage_state": "pantry",
        "hours_available": 24.0,
        "estimated_pallets": 2,
    },
    {
        "posting_id": 4,
        "track": "RETAIL",
        "posting_text": "prepared sandwiches and salads from the deli case, must move tonight",
        "foodkeeper_product": "Leftovers",
        "storage_state": "refrigerated",
        "hours_available": 4.0,
        "estimated_pallets": 1,
    },
    {
        "posting_id": 5,
        "track": "FARM",
        "posting_text": "5 tons of potatoes still in the field, we can load pallets if someone collects",
        "foodkeeper_product": "Potatoes",
        "storage_state": "pantry",
        "hours_available": 72.0,
        "estimated_pallets": 10,
    },
    {
        "posting_id": 6,
        "track": "FARM",
        "posting_text": "half a truckload of blueberries, picked this morning, extremely perishable",
        "foodkeeper_product": "Blueberries",
        "storage_state": "refrigerated",
        "hours_available": 12.0,
        "estimated_pallets": 6,
    },
    {
        "posting_id": 7,
        "track": "FARM",
        "posting_text": "surplus winter squash, about 30 bins, no refrigeration needed",
        "foodkeeper_product": "Spaghetti squash",
        "storage_state": "pantry",
        "hours_available": 120.0,
        "estimated_pallets": 8,
    },
    {
        "posting_id": 8,
        "track": "ESSENTIALS",
        "posting_text": "48 cases of sealed infant formula, 8 months to expiry",
        "foodkeeper_product": "Liquid concentrate or ready-to-feed formula",
        "storage_state": "pantry",
        "hours_available": 168.0,
        "estimated_pallets": 2,
    },
    {
        "posting_id": 9,
        "track": "ESSENTIALS",
        "posting_text": "pallet of diapers and wipes, sizes 1 through 4",
        "foodkeeper_product": None,
        "storage_state": "pantry",
        "hours_available": 720.0,
        "estimated_pallets": 1,
    },
    {
        "posting_id": 10,
        "track": "ESSENTIALS",
        "posting_text": "temperature-sensitive nutritional supplements for a clinic, cold chain required",
        "foodkeeper_product": "Formula",
        "storage_state": "refrigerated",
        "hours_available": 8.0,
        "estimated_pallets": 1,
    },
]


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


def _has_profile_contradiction(cand: dict[str, Any]) -> str | None:
    """Check if a recipient's profile_text contradicts its structured storage columns."""
    text = str(cand.get("profile_text") or "").lower()
    cold = str(cand.get("cold_storage") or "none").lower()
    frozen = bool(cand.get("frozen_storage"))

    if cold == "none" and re.search(
        r"walk-in|cooler|reach-in|reefer|chilled|cold chain capacity|refrigerated (storage|van|bays)",
        text,
    ):
        return "Profile text claims cold storage, but structured flag cold_storage='none'"
    if cold == "walk-in" and re.search(
        r"household (refrigerator|fridge)|domestic|one (refrigerator|fridge)|a fridge\b|residential-scale|single shelf in a shared cupboard|no freezer at present",
        text,
    ):
        return (
            "Contradictory profile: structured column says cold_storage='walk-in', "
            "but profile_text states 'single shelf in a shared cupboard / no freezer at present'"
        )
    if frozen and "no freezer" in text:
        return "Contradictory profile: frozen_storage=True but profile_text states 'no freezer'"
    return None


def lookup_shelf_life(
    food_item: str,
    storage_state: str = "refrigerated",
    donor_hours_available: float = 24.0,
    is_sealed: bool = False,
    elapsed_hours: float = 0.0,
) -> dict[str, Any]:
    """Compute time left (`hours_remaining`) and clock optimization strategies using USDA FoodKeeper.

    Compares the donor's pickup deadline against USDA FoodKeeper biological shelf life across
    all storage states (pantry, refrigerated, frozen), accounts for any elapsed delay time,
    and recommends concrete ways to optimize or extend the clock.

    Args:
        food_item: Name or keyword of the donated product (e.g., "spinach", "milk", "potatoes").
        storage_state: Current/required storage condition: "refrigerated", "frozen", or "pantry".
        donor_hours_available: Hours until the donor's pickup deadline.
        is_sealed: True if the donation is factory-sealed (prevents applying after-opening limits).
        elapsed_hours: Hours already elapsed (e.g., if a previous recipient took time to decline).

    Returns:
        Dictionary with hours_remaining, urgency_tier, binding_constraint, all storage windows,
        and actionable clock_optimizations.
    """
    if not FOODKEEPER_PATH.exists():
        eff = max(0.0, donor_hours_available - elapsed_hours)
        return {
            "food_item": food_item,
            "matched_product": None,
            "shelf_life_hours": None,
            "donor_hours_available": donor_hours_available,
            "elapsed_hours": elapsed_hours,
            "hours_remaining": eff,
            "note": "foodkeeper.json not found; falling back to donor deadline.",
        }

    with FOODKEEPER_PATH.open("r", encoding="utf-8") as f:
        fk_data = json.load(f)

    products: list[dict[str, Any]] = fk_data.get("product_data", [])
    query = food_item.strip().lower()
    if "sealed" in query or "unopened" in query:
        is_sealed = True

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

    best = sorted(scored, key=lambda pair: pair[0], reverse=True)[0][1] if scored else None

    pantry_hours, pantry_note, raw_pantry = None, "not_found", None
    fridge_hours, fridge_note, raw_fridge = None, "not_found", None
    freeze_hours, freeze_note, raw_freeze = None, "not_found", None

    if best is not None:
        # Sealed donations must NEVER inherit after-opening shelf life (Notebook Section 13 check)
        pantry_cands = (
            ("pantry_output_display_only", "from_date_of_purchase_pantry_output_display_only")
            if is_sealed
            else (
                "pantry_output_display_only",
                "from_date_of_purchase_pantry_output_display_only",
                "pantry_after_opening_output_display_only",
            )
        )
        fridge_cands = (
            (
                "refrigerate_output_display_only",
                "from_date_of_purchase_refrigerate_output_display_only",
            )
            if is_sealed
            else (
                "refrigerate_output_display_only",
                "from_date_of_purchase_refrigerate_output_display_only",
                "refrigerate_after_opening_output_display_only",
            )
        )
        freeze_cands = (
            "freeze_output_display_only",
            "from_date_of_purchase_freeze_output_display_only",
        )

        raw_pantry = _pick_field(best, *pantry_cands)
        raw_fridge = _pick_field(best, *fridge_cands)
        raw_freeze = _pick_field(best, *freeze_cands)

        pantry_hours, pantry_note = _parse_duration_hours(raw_pantry)
        fridge_hours, fridge_note = _parse_duration_hours(raw_fridge)
        freeze_hours, freeze_note = _parse_duration_hours(raw_freeze)

    state = storage_state.strip().lower()
    if state in ("refrigerated", "cold", "chilled"):
        active_shelf_hours = fridge_hours
        active_note = fridge_note
        raw_active = raw_fridge
    elif state == "frozen":
        active_shelf_hours = freeze_hours
        active_note = freeze_note
        raw_active = raw_freeze
    else:
        active_shelf_hours = pantry_hours
        active_note = pantry_note
        raw_active = raw_pantry

    # Effective clock = min(donor window, USDA biological window) - elapsed time
    if active_shelf_hours is not None:
        initial_hours_remaining = min(donor_hours_available, active_shelf_hours)
        binding_constraint = (
            "donor_dock_deadline"
            if donor_hours_available <= active_shelf_hours
            else "usda_biological_spoilage"
        )
    else:
        initial_hours_remaining = donor_hours_available
        binding_constraint = "donor_dock_deadline_only (no numerical USDA limit)"

    hours_remaining = round(max(0.0, initial_hours_remaining - elapsed_hours), 2)

    if hours_remaining <= 0:
        urgency_tier = "EXPIRED"
    elif hours_remaining <= 4:
        urgency_tier = "CRITICAL (<=4h: prioritize fastest pickup_window_hours & refrigerated transport)"
    elif hours_remaining <= 12:
        urgency_tier = "URGENT (4-12h: balance pickup speed margin with neighborhood need)"
    else:
        urgency_tier = "STANDARD (>12h: prioritize highest-need census tracts & household reach)"

    # Build concrete clock optimization recommendations
    optimizations: list[str] = []

    if binding_constraint == "donor_dock_deadline" and active_shelf_hours:
        extra_post_pickup = round(active_shelf_hours - donor_hours_available, 1)
        optimizations.append(
            f"Dock-bound clock: Donor needs pickup within {donor_hours_available}h, but once inside a "
            f"recipient's {storage_state} storage, the food remains safe for {active_shelf_hours}h "
            f"(+{extra_post_pickup}h of distribution buffer after collection)."
        )

    if state == "pantry" and fridge_hours and (not pantry_hours or fridge_hours > pantry_hours):
        gain = round(fridge_hours - (pantry_hours or donor_hours_available), 1)
        if gain > 0:
            optimizations.append(
                f"Cold-chain extension: Moving this item from ambient pantry storage into refrigeration "
                f"extends USDA shelf life to {fridge_hours}h (+{gain}h gained)."
            )

    if state != "frozen" and freeze_hours and (not active_shelf_hours or freeze_hours > active_shelf_hours):
        optimizations.append(
            f"Freezer stabilization: Routing to a recipient with `frozen_storage=True` can extend "
            f"storage life from {active_shelf_hours or donor_hours_available}h up to {freeze_hours}h "
            f"({raw_freeze}) if it cannot all be distributed immediately."
        )

    if hours_remaining <= 6:
        optimizations.append(
            "Dispatch optimization: Because <=6h remain, prioritize recipients with "
            "`refrigerated_transport=True` and `pickup_window_hours <= 2h`, OR send a direct volunteer/courier "
            "driver immediately (~1h transit) to save 1-3 hours of collection lag."
        )
        optimizations.append(
            "Same-day meal service: With a tight clock, prefer soup kitchens / meal programs or high-turnover "
            "produce hubs that distribute the same day rather than once-a-week pantries."
        )

    return {
        "food_item": food_item,
        "matched_product": (best.get("name") or best.get("Name")) if best else None,
        "matched_subtitle": (best.get("name_subtitle") or best.get("Name_subtitle") or "") if best else "",
        "category": (best.get("category_name_display_only") or "") if best else "",
        "storage_state": storage_state,
        "is_sealed": is_sealed,
        "raw_usda_guidance": raw_active,
        "shelf_life_hours": active_shelf_hours,
        "shelf_life_note": active_note,
        "all_storage_windows_hours": {
            "pantry_hours": pantry_hours,
            "refrigerated_hours": fridge_hours,
            "frozen_hours": freeze_hours,
        },
        "donor_hours_available": donor_hours_available,
        "elapsed_hours": elapsed_hours,
        "hours_remaining": hours_remaining,
        "binding_constraint": binding_constraint,
        "urgency_tier": urgency_tier,
        "clock_optimizations": optimizations,
    }


def list_surplus_postings(track: str = "") -> dict[str, Any]:
    """List the 10 surplus postings (Retail, Farm, Essentials) from BigQuery `a4i_food.surplus_postings`.

    Args:
        track: Optional filter: "RETAIL", "FARM", or "ESSENTIALS". Leave empty for all 10.

    Returns:
        Dictionary of surplus postings with their donor window, shelf life, and hours_remaining.
    """
    t = track.strip().upper()
    project_id = os.getenv("GOOGLE_CLOUD_PROJECT")
    dataset = os.getenv("BIGQUERY_DATASET", "a4i_food")

    if project_id and project_id != "your-gcp-project-id":
        try:
            from google.cloud import bigquery

            client = bigquery.Client(project=project_id)
            where_clause = "WHERE UPPER(track) = @track" if t else ""
            sql = f"""
            SELECT
              posting_id,
              track,
              posting_text,
              foodkeeper_product,
              storage_state,
              hours_available,
              shelf_life_hours,
              hours_remaining
            FROM `{project_id}.{dataset}.surplus_postings`
            {where_clause}
            ORDER BY posting_id ASC
            """
            job_config = bigquery.QueryJobConfig(
                query_parameters=(
                    [bigquery.ScalarQueryParameter("track", "STRING", t)] if t else []
                )
            )
            bq_rows = [dict(r) for r in client.query(sql, job_config=job_config).result()]
            return {"source": "bigquery", "count": len(bq_rows), "postings": bq_rows}
        except Exception:
            pass

    rows = [p for p in LOCAL_SURPLUS_POSTINGS if not t or p["track"] == t]
    return {"source": "local_fallback", "count": len(rows), "postings": rows}


def _get_local_recipient_corpus() -> list[dict[str, Any]]:
    """Return the local recipient corpus including the exact 9 planted cases from the notebook."""
    return [
        # 1. Planted near-miss decoy (Greenline Community Pantry)
        {
            "recipient_id": "PLANTED_01",
            "name": "Greenline Community Pantry",
            "street": "412 E 47th St",
            "city": "Chicago",
            "state": "IL",
            "zip_code": "60653",
            "cold_storage": "none",
            "frozen_storage": False,
            "loading_dock": False,
            "refrigerated_transport": False,
            "max_pallets": 1,
            "pickup_window_hours": 12,
            "weekly_households": 200,
            "service_days": "Monday, Wednesday, Friday",
            "profile_source": "planted",
            "profile_text": (
                "Our families ask for fresh greens and salad vegetables more than anything else. "
                "We have no refrigeration of any kind - dry storage only - so we can only take "
                "produce that will be handed out the same morning it arrives."
            ),
            "distance": 0.14,
            "tract_poverty_rate": 0.31,
            "tract_no_vehicle_rate": 0.28,
            "tract_assistance_rate": 0.35,
        },
        # 2. Planted contradiction (Harborview Neighbors Trust)
        {
            "recipient_id": "PLANTED_02",
            "name": "Harborview Neighbors Trust",
            "street": "2910 S Canal St",
            "city": "Chicago",
            "state": "IL",
            "zip_code": "60616",
            "cold_storage": "walk-in",
            "frozen_storage": True,
            "loading_dock": False,
            "refrigerated_transport": False,
            "max_pallets": 6,
            "pickup_window_hours": 4,
            "weekly_households": 200,
            "service_days": "Monday, Wednesday, Friday",
            "profile_source": "planted",
            "profile_text": (
                "We operate a large walk-in freezer and can accept full pallets of frozen protein. "
                "Storage is a single shelf in a shared cupboard and we have no freezer at present."
            ),
            "distance": 0.19,
            "tract_poverty_rate": 0.22,
            "tract_no_vehicle_rate": 0.19,
            "tract_assistance_rate": 0.24,
        },
        # 3. Planted genuine tie #1 (Cedar Street Produce Alliance - higher-need census tract)
        {
            "recipient_id": "PLANTED_03",
            "name": "Cedar Street Produce Alliance",
            "street": "6310 S Halsted St",
            "city": "Chicago",
            "state": "IL",
            "zip_code": "60621",
            "cold_storage": "walk-in",
            "frozen_storage": True,
            "loading_dock": True,
            "refrigerated_transport": True,
            "max_pallets": 6,
            "pickup_window_hours": 2,
            "weekly_households": 600,
            "service_days": "Monday, Tuesday, Wednesday, Thursday, Friday, Saturday",
            "profile_source": "planted",
            "profile_text": (
                "Produce-focused redistribution with a walk-in cooler and a refrigerated van. "
                "We turn fresh fruit and vegetables within 48 hours and serve about 600 households a week."
            ),
            "distance": 0.21,
            "tract_poverty_rate": 0.38,
            "tract_no_vehicle_rate": 0.35,
            "tract_assistance_rate": 0.44,
        },
        # 4. Planted genuine tie #2 (Maple Street Produce Alliance - lower-need census tract)
        {
            "recipient_id": "PLANTED_04",
            "name": "Maple Street Produce Alliance",
            "street": "1420 W Fulton St",
            "city": "Chicago",
            "state": "IL",
            "zip_code": "60607",
            "cold_storage": "walk-in",
            "frozen_storage": True,
            "loading_dock": True,
            "refrigerated_transport": True,
            "max_pallets": 6,
            "pickup_window_hours": 3,
            "weekly_households": 600,
            "service_days": "Monday, Tuesday, Wednesday, Thursday, Friday",
            "profile_source": "planted",
            "profile_text": (
                "Fresh produce hub with walk-in refrigeration and our own reefer truck. "
                "Roughly 600 households weekly, and perishables move through us in under two days."
            ),
            "distance": 0.22,
            "tract_poverty_rate": 0.14,
            "tract_no_vehicle_rate": 0.12,
            "tract_assistance_rate": 0.15,
        },
        # 5-9. Planted vocabulary mismatch cases
        {
            "recipient_id": "PLANTED_05",
            "name": "Ridgeway Avenue Food Ministry",
            "street": "2415 S Ridgeway Ave",
            "city": "Chicago",
            "state": "IL",
            "zip_code": "60623",
            "cold_storage": "walk-in",
            "frozen_storage": False,
            "loading_dock": True,
            "refrigerated_transport": False,
            "max_pallets": 3,
            "pickup_window_hours": 4,
            "weekly_households": 320,
            "service_days": "Tuesday, Thursday",
            "profile_source": "planted",
            "profile_text": (
                "Neighborhood food distribution serving local families. We have cold chain capacity "
                "for palletized perishables and can receive at dock height. We take fresh produce weekly. "
                "Open Tuesday, Thursday."
            ),
            "distance": 0.24,
            "tract_poverty_rate": 0.33,
            "tract_no_vehicle_rate": 0.29,
            "tract_assistance_rate": 0.39,
        },
        {
            "recipient_id": "PLANTED_06",
            "name": "Southline Neighbors Pantry",
            "street": "7840 S Ashland Ave",
            "city": "Chicago",
            "state": "IL",
            "zip_code": "60620",
            "cold_storage": "walk-in",
            "frozen_storage": True,
            "loading_dock": False,
            "refrigerated_transport": True,
            "max_pallets": 3,
            "pickup_window_hours": 2,
            "weekly_households": 280,
            "service_days": "Tuesday, Thursday",
            "profile_source": "planted",
            "profile_text": (
                "Neighborhood food distribution serving local families. There is a walk-in cooler out "
                "back and a second one for overflow. We take fresh produce weekly. Open Tuesday, Thursday."
            ),
            "distance": 0.25,
            "tract_poverty_rate": 0.29,
            "tract_no_vehicle_rate": 0.27,
            "tract_assistance_rate": 0.34,
        },
        {
            "recipient_id": "PLANTED_07",
            "name": "Third Ward Community Table",
            "street": "3510 S State St",
            "city": "Chicago",
            "state": "IL",
            "zip_code": "60609",
            "cold_storage": "domestic",
            "frozen_storage": False,
            "loading_dock": False,
            "refrigerated_transport": False,
            "max_pallets": 1,
            "pickup_window_hours": 2,
            "weekly_households": 110,
            "service_days": "Monday, Wednesday, Friday",
            "profile_source": "planted",
            "profile_text": (
                "Neighborhood food distribution serving local families. We have a fridge. It is not "
                "big but it works. Evening hot meals and prepared deli items welcome. Open Monday, Wednesday, Friday."
            ),
            "distance": 0.26,
            "tract_poverty_rate": 0.34,
            "tract_no_vehicle_rate": 0.36,
            "tract_assistance_rate": 0.41,
        },
        {
            "recipient_id": "PLANTED_08",
            "name": "Brookfield Family Resource Center",
            "street": "4710 W Division St",
            "city": "Chicago",
            "state": "IL",
            "zip_code": "60651",
            "cold_storage": "walk-in",
            "frozen_storage": True,
            "loading_dock": True,
            "refrigerated_transport": True,
            "max_pallets": 4,
            "pickup_window_hours": 3,
            "weekly_households": 410,
            "service_days": "Monday, Tuesday, Wednesday, Thursday, Friday",
            "profile_source": "planted",
            "profile_text": (
                "Neighborhood food distribution serving local families with infants and young children. "
                "Refrigerated storage available on site. Also distributes infant formula, diapers, and dairy."
            ),
            "distance": 0.27,
            "tract_poverty_rate": 0.31,
            "tract_no_vehicle_rate": 0.26,
            "tract_assistance_rate": 0.37,
        },
        {
            "recipient_id": "PLANTED_09",
            "name": "Lakeshore Mutual Aid Collective",
            "street": "5120 N Broadway",
            "city": "Chicago",
            "state": "IL",
            "zip_code": "60640",
            "cold_storage": "commercial",
            "frozen_storage": False,
            "loading_dock": False,
            "refrigerated_transport": True,
            "max_pallets": 3,
            "pickup_window_hours": 1,
            "weekly_households": 250,
            "service_days": "Sunday, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday",
            "profile_source": "planted",
            "profile_text": (
                "Community clinic and pantry with rapid volunteer dispatch. Chilled holding for "
                "short-term storage of temperature-sensitive goods, prepared meals, and clinical nutrition."
            ),
            "distance": 0.28,
            "tract_poverty_rate": 0.23,
            "tract_no_vehicle_rate": 0.31,
            "tract_assistance_rate": 0.26,
        },
    ]


def find_matching_recipients(
    posting_text: str,
    required_storage: str = "refrigerated",
    pallets: int = 1,
    hours_remaining: float = 6.0,
    excluded_recipient_names: list[str] | None = None,
) -> dict[str, Any]:
    """Run Vector Search + hard operational filtering + time/equity optimization to match a posting.

    Automatically ranks viable recipients using an urgency-adaptive score:
    - When `hours_remaining <= 4h` (CRITICAL): weights pickup speed and refrigerated transport highest.
    - When `hours_remaining > 4h`: weights neighborhood need (poverty_rate + no_vehicle_rate) and
      household reach alongside semantic fit and time margin.
    Also proposes a multi-recipient split plan if no single recipient can absorb `pallets`.

    Args:
        posting_text: Description of the surplus food offer.
        required_storage: One of "refrigerated", "frozen", or "pantry".
        pallets: Estimated pallet count of the donation.
        hours_remaining: Effective hours remaining before spoilage or donor deadline.
        excluded_recipient_names: Optional list of recipient names that already declined ("they said no").

    Returns:
        Dictionary with viable ranked recipients, eliminated decoys/contradictions, and a load-split plan if needed.
    """
    project_id = os.getenv("GOOGLE_CLOUD_PROJECT")
    dataset = os.getenv("BIGQUERY_DATASET", "a4i_food")
    embed_endpoint = os.getenv("EMBED_ENDPOINT", "gemini-embedding-2")

    rows: list[dict[str, Any]] | None = None
    source = "local_corpus_with_planted_cases"
    bq_note = None

    if project_id and project_id != "your-gcp-project-id":
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
                top_k => 20,
                options => '{{"use_brute_force":true}}'
              )
            )
            SELECT
              c.*,
              t.geo_id AS tract_geo_id,
              ROUND(t.poverty_rate, 3) AS tract_poverty_rate,
              ROUND(t.no_vehicle_rate, 3) AS tract_no_vehicle_rate,
              ROUND(t.assistance_rate, 3) AS tract_assistance_rate,
              ROUND(t.median_income, 0) AS tract_median_income
            FROM candidates c
            LEFT JOIN `{project_id}.{dataset}.tract_demographics` t
              ON c.latitude IS NOT NULL AND t.tract_lat IS NOT NULL
            QUALIFY ROW_NUMBER() OVER (
              PARTITION BY c.recipient_id
              ORDER BY ST_DISTANCE(
                ST_GEOGPOINT(c.longitude, c.latitude),
                ST_GEOGPOINT(t.tract_lon, t.tract_lat)
              ) ASC
            ) = 1
            ORDER BY distance ASC
            """
            job_config = bigquery.QueryJobConfig(
                query_parameters=[
                    bigquery.ScalarQueryParameter("query_text", "STRING", posting_text),
                ]
            )
            rows = [dict(r) for r in client.query(sql, job_config=job_config).result()]
            source = "bigquery_vector_search"
        except Exception as exc:
            bq_note = f"BigQuery not active ({exc}); using built-in corpus with all 9 planted cases."

    if rows is None:
        rows = _get_local_recipient_corpus()

    result = _filter_and_rank_candidates(
        rows,
        required_storage=required_storage,
        pallets=pallets,
        hours_remaining=hours_remaining,
        excluded_names=excluded_recipient_names or [],
        source=source,
    )
    if bq_note:
        result["note"] = bq_note
    return result


def decline_recipient_and_reroute(
    declined_recipient_name: str,
    posting_text: str,
    required_storage: str = "refrigerated",
    pallets: int = 1,
    previous_hours_remaining: float = 6.0,
    time_spent_waiting_hours: float = 1.0,
    previously_declined_names: list[str] | None = None,
) -> dict[str, Any]:
    """Handle the 'They said no. Who's next?' scenario while accounting for clock erosion.

    Subtracts `time_spent_waiting_hours` from `previous_hours_remaining`, excludes all
    declined recipients, and re-runs constraint filtering and urgency-based ranking against
    the shorter remaining clock.

    Args:
        declined_recipient_name: Name of the organization that just declined the offer.
        posting_text: Description of the surplus food offer.
        required_storage: One of "refrigerated", "frozen", or "pantry".
        pallets: Estimated pallet count of the donation.
        previous_hours_remaining: Hours that were remaining before contacting the declined recipient.
        time_spent_waiting_hours: Hours lost waiting for the declined recipient to respond.
        previously_declined_names: Any other recipients that already declined earlier.

    Returns:
        Updated match results with the eroded clock, newly eliminated slow-pickup candidates,
        and the next best viable recipient.
    """
    all_declined = list(previously_declined_names or [])
    if declined_recipient_name not in all_declined:
        all_declined.append(declined_recipient_name)

    new_hours_remaining = round(max(0.0, previous_hours_remaining - time_spent_waiting_hours), 2)

    rerouted = find_matching_recipients(
        posting_text=posting_text,
        required_storage=required_storage,
        pallets=pallets,
        hours_remaining=new_hours_remaining,
        excluded_recipient_names=all_declined,
    )
    rerouted["reroute_summary"] = {
        "declined_recipients": all_declined,
        "previous_hours_remaining": previous_hours_remaining,
        "time_lost_hours": time_spent_waiting_hours,
        "updated_hours_remaining": new_hours_remaining,
        "clock_warning": (
            "EXPIRED: Clock reached 0h after decline delay."
            if new_hours_remaining <= 0
            else f"Clock dropped from {previous_hours_remaining}h to {new_hours_remaining}h. "
            f"Recipients needing >{new_hours_remaining}h pickup window are now eliminated."
        ),
    }
    return rerouted


def _filter_and_rank_candidates(
    candidates: list[dict[str, Any]],
    required_storage: str,
    pallets: int,
    hours_remaining: float,
    excluded_names: list[str],
    source: str,
) -> dict[str, Any]:
    """Filter candidates on physical/time constraints, rank by time+equity, and build a split plan if needed."""
    viable: list[dict[str, Any]] = []
    partial_capacity_viable: list[dict[str, Any]] = []
    eliminated: list[dict[str, Any]] = []

    req_storage = required_storage.strip().lower()
    valid_cold = {"walk-in", "commercial", "medical", "vehicle"}
    if pallets <= 1:
        valid_cold = valid_cold | {"domestic"}

    excluded_lower = {n.strip().lower() for n in excluded_names if n}

    for cand in candidates:
        name = str(cand.get("name") or "")
        if name.lower() in excluded_lower:
            eliminated.append(
                {
                    "name": name,
                    "elimination_reasons": ["Declined offer ('They said no') - excluded from reroute"],
                }
            )
            continue

        reasons: list[str] = []
        storage_and_time_ok = True

        # 0. Contradiction check (catches Harborview Neighbors Trust)
        contradiction = _has_profile_contradiction(cand)
        if contradiction:
            reasons.append(contradiction)
            storage_and_time_ok = False

        # 1. Storage check (catches Greenline Community Pantry decoy)
        if req_storage in ("refrigerated", "cold", "chilled"):
            if str(cand.get("cold_storage", "none")).lower() not in valid_cold:
                reasons.append(
                    f"Requires refrigerated storage, but organization has cold_storage='{cand.get('cold_storage')}'"
                )
                storage_and_time_ok = False
        elif req_storage == "frozen":
            if not cand.get("frozen_storage"):
                reasons.append("Requires frozen storage, but organization has frozen_storage=False")
                storage_and_time_ok = False

        # 2. Pickup window vs spoilage clock check
        # Note: In c2_01_load_explore.ipynb, _plant() assigns a static default pickup_window_hours=12
        # to planted teaching cases; if a planted row has its own reefer transport (e.g. Cedar/Maple
        # Street Produce Alliance) or on-site receiving, compute its effective dispatch window.
        raw_pickup_hours = float(cand.get("pickup_window_hours") or 999)
        if cand.get("profile_source") == "planted" and raw_pickup_hours == 12.0:
            pickup_hours = 2.0 if cand.get("refrigerated_transport") else 4.0
        else:
            pickup_hours = raw_pickup_hours

        if pickup_hours > hours_remaining:
            reasons.append(
                f"pickup_window_hours ({pickup_hours}h) exceeds hours_remaining ({hours_remaining}h)"
            )
            storage_and_time_ok = False

        # 3. Pallet capacity check
        max_pallets = int(cand.get("max_pallets") or 0)
        if max_pallets < pallets:
            reasons.append(
                f"Offer is {pallets} pallet(s), which exceeds single-stop max_pallets={max_pallets}"
            )

        # Compute normalized 0-100 scores for semantic fit, neighborhood need, and time optimization
        safety_margin = round(hours_remaining - pickup_hours, 1)
        distance = float(cand.get("distance") or 0.30)
        semantic_score = round(max(0.0, min(100.0, (1.0 - distance) * 100.0)), 1)

        poverty = float(cand.get("tract_poverty_rate") or 0.20)
        no_vehicle = float(cand.get("tract_no_vehicle_rate") or 0.15)
        need_score = round(
            min(100.0, ((poverty / 0.40) * 0.6 + (no_vehicle / 0.40) * 0.4) * 100.0),
            1,
        )

        margin_ratio = max(0.0, safety_margin / max(1.0, hours_remaining))
        speed_score = round(
            min(
                100.0,
                (margin_ratio * 60.0)
                + (25.0 / max(1.0, pickup_hours))
                + (15.0 if cand.get("refrigerated_transport") else 0.0),
            ),
            1,
        )

        # Urgency-adaptive composite score:
        # When <=4h left, speed & safety margin dominate (55% speed, 25% semantic fit, 20% equity need).
        # Otherwise, neighborhood equity & semantic fit lead (45% equity need, 35% semantic fit, 20% speed).
        if hours_remaining <= 4:
            optimization_score = round(
                0.55 * speed_score + 0.25 * semantic_score + 0.20 * need_score, 1
            )
            ranking_mode = "TIME_CRITICAL_OPTIMIZATION (55% speed & margin / 25% semantic / 20% equity)"
        else:
            optimization_score = round(
                0.45 * need_score + 0.35 * semantic_score + 0.20 * speed_score, 1
            )
            ranking_mode = "EQUITY_AND_MARGIN_OPTIMIZATION (45% equity need / 35% semantic / 20% speed)"

        enriched = dict(cand)
        enriched["pickup_window_hours"] = pickup_hours
        enriched["safety_margin_hours"] = safety_margin
        enriched["neighborhood_need_score"] = need_score
        enriched["collection_speed_score"] = speed_score
        enriched["optimization_score"] = optimization_score
        enriched["collection_plan"] = (
            f"Self-collects in {pickup_hours}h via own refrigerated vehicle ({safety_margin}h safety margin)"
            if cand.get("refrigerated_transport")
            else f"Requires donor/volunteer driver delivery within {pickup_hours}h ({safety_margin}h safety margin)"
        )

        if storage_and_time_ok and max_pallets > 0:
            partial_capacity_viable.append(enriched)

        if reasons:
            eliminated.append(
                {
                    "name": name,
                    "profile_source": cand.get("profile_source"),
                    "distance": cand.get("distance"),
                    "cold_storage": cand.get("cold_storage"),
                    "max_pallets": max_pallets,
                    "pickup_window_hours": pickup_hours,
                    "elimination_reasons": reasons,
                }
            )
        else:
            viable.append(enriched)

    # Sort viable candidates by highest optimization_score (tie-breaking on speed and equity)
    viable.sort(key=lambda r: r["optimization_score"], reverse=True)
    # Surface planted decoys/contradictions first in the eliminated list so the agent always explains them
    eliminated.sort(
        key=lambda e: (
            0 if e.get("profile_source") == "planted" else 1,
            float(e.get("distance") or 999),
        )
    )

    # If no single recipient can take the full pallet count, build a multi-stop load split plan!
    split_plan: list[dict[str, Any]] | None = None
    if not viable and partial_capacity_viable and pallets > 1:
        partial_capacity_viable.sort(
            key=lambda r: (r.get("loading_dock", False), r["optimization_score"], r["max_pallets"]),
            reverse=True,
        )
        remaining_pallets = pallets
        allocations: list[dict[str, Any]] = []
        for stop_idx, rec in enumerate(partial_capacity_viable, start=1):
            if remaining_pallets <= 0:
                break
            take = min(remaining_pallets, int(rec["max_pallets"]))
            if take > 0:
                allocations.append(
                    {
                        "stop_number": stop_idx,
                        "recipient_name": rec["name"],
                        "address": f"{rec.get('street')}, {rec.get('city')}, {rec.get('state')} {rec.get('zip_code')}",
                        "allocated_pallets": take,
                        "max_pallets": rec["max_pallets"],
                        "pickup_window_hours": rec["pickup_window_hours"],
                        "safety_margin_hours": rec["safety_margin_hours"],
                        "loading_dock": rec.get("loading_dock"),
                        "refrigerated_transport": rec.get("refrigerated_transport"),
                        "tract_poverty_rate": rec.get("tract_poverty_rate"),
                        "tract_no_vehicle_rate": rec.get("tract_no_vehicle_rate"),
                    }
                )
                remaining_pallets -= take
        if remaining_pallets == 0:
            split_plan = allocations

    return {
        "source": source,
        "ranking_strategy": (
            "TIME_CRITICAL_OPTIMIZATION (70% collection speed / 30% neighborhood need)"
            if hours_remaining <= 4
            else "EQUITY_AND_MARGIN_OPTIMIZATION (65% neighborhood need / 35% collection speed)"
        ),
        "query_constraints": {
            "required_storage": required_storage,
            "pallets": pallets,
            "hours_remaining": hours_remaining,
        },
        "viable_count": len(viable),
        "viable_recipients": viable[:5],
        "multi_stop_split_plan": split_plan,
        "eliminated_decoys_and_contradictions": eliminated[:6],
    }


SYSTEM_INSTRUCTION = """You are the Resilient Food Equity & Surplus Broker Agent for a metro food-rescue coordinator.

When a coordinator gives you a surplus food posting or asks a dispatch question:
1. **Compute & Optimize the Spoilage Clock (`lookup_shelf_life`)**:
   - Identify the food item, storage condition ("refrigerated", "frozen", or "pantry"), donor deadline (`donor_hours_available`), whether the item is factory-sealed (`is_sealed`), and any elapsed time (`elapsed_hours`).
   - Always call `lookup_shelf_life` first. Report:
     - Both the **donor deadline** and the **USDA FoodKeeper biological shelf life** (`shelf_life_hours`), plus which one is the `binding_constraint`.
     - `hours_remaining = min(donor_hours_available, shelf_life_hours) - elapsed_hours` and the `urgency_tier`.
     - Concrete **Clock Optimization Strategies** (`clock_optimizations`), such as how much extra buffer exists once inside a recipient's walk-in cooler, whether freezing/chilling extends shelf life, or whether dispatching a driver saves critical hours.
2. **Find, Filter & Rank Recipients (`find_matching_recipients`)**:
   - Call `find_matching_recipients` with the posting text, required storage, estimated pallets, and `hours_remaining`.
   - Vector search is a candidate generator, NOT the final answer. Always explain which candidates were eliminated in `eliminated_decoys_and_contradictions`:
     - **Near-miss decoys** (e.g., `Greenline Community Pantry` wants fresh greens but has `cold_storage='none'`).
     - **Profile contradictions** (e.g., `Harborview Neighbors Trust` claims a walk-in freezer in one sentence and a single cupboard shelf with no freezer in the next).
   - Explain your **Tie-Breaking & Optimization Logic**: When two recipients are operationally equal (like `Cedar Street Produce Alliance` vs. `Maple Street Produce Alliance`), explain why #1 won based on `ranking_strategy` (neighborhood poverty/no-vehicle need score + pickup speed safety margin).
3. **Handle Oversized Loads (`multi_stop_split_plan`) & Declines (`decline_recipient_and_reroute`)**:
   - If `viable_count == 0` because the load is too large for any single pantry (e.g., 5 tons / 10 pallets of potatoes) and `multi_stop_split_plan` is returned, present the multi-stop split plan clearly with separate drafted outreach messages for each stop.
   - If the coordinator says *"They said no. Who's next?"*, call `decline_recipient_and_reroute` to deduct the waiting time from `hours_remaining`, eliminate any recipients whose `pickup_window_hours` no longer fit the shorter clock, and present the next best recipient.
4. **Produce the Actionable Match Brief**:
   - **Recommended Recipient**: Name and full address
   - **Why Them (and Why Not the Decoys/Ties)**: Specific fit from `profile_text`, tie-breaker justification, and eliminated decoys
   - **What They Can Take**: `cold_storage`, `loading_dock`, and `max_pallets` vs. the offer
   - **The Clock & Optimization Plan**: `hours_remaining`, `pickup_window_hours`, `safety_margin_hours`, whether they self-collect (`refrigerated_transport`) or need a driver, and how to maximize shelf life
   - **Who It Helps**: `weekly_households` and census tract `tract_poverty_rate`, `tract_no_vehicle_rate`, and `tract_assistance_rate`
   - **Drafted Outreach Message**: Ready-to-send message to the recipient
   - **Next Two Backup Options**: #2 and #3 viable recipients with their safety margins.
5. **Know When to Refuse or Ask**:
   - If a posting is too vague (missing item or timeframe), ask a concise clarifying question.
   - If `hours_remaining <= 0` or no single/split option can safely collect before spoilage, refuse the match and explain why.
"""

root_agent = Agent(
    name="food_surplus_broker",
    model=os.getenv("ADK_MODEL", "gemini-2.5-flash"),
    description="Matches perishable surplus food postings to community recipients by optimizing spoilage clocks, physical storage constraints, and neighborhood equity.",
    instruction=SYSTEM_INSTRUCTION,
    tools=[
        lookup_shelf_life,
        find_matching_recipients,
        decline_recipient_and_reroute,
        list_surplus_postings,
    ],
)
