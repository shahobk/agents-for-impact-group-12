#!/usr/bin/env python3
"""Apply purpose-focused table and column descriptions to the BigQuery dataset."""

from __future__ import annotations

import argparse

from google.cloud import bigquery


RECIPIENT_COLUMNS = {
    "recipient_id": "Unique recipient record identifier.",
    "ein": "IRS Employer Identification Number.",
    "name": "Recipient organization name.",
    "street": "Recipient street address.",
    "city": "Recipient city.",
    "state": "Two-letter state code.",
    "zip_code": "Five-digit ZIP code.",
    "ntee_code": "IRS nonprofit activity classification code.",
    "archetype": "Operational category used to characterize recipient capabilities.",
    "archetype_label": "Human-readable operational category name.",
    "cold_storage": "Type of refrigerated storage available.",
    "frozen_storage": "Whether frozen storage is available.",
    "loading_dock": "Whether the location has a loading dock.",
    "refrigerated_transport": "Whether refrigerated pickup transport is available.",
    "max_pallets": "Maximum number of pallets the recipient can accept per offer.",
    "pickup_window_hours": "Number of hours available for the recipient to collect an offer.",
    "weekly_households": "Estimated number of households served per week.",
    "reported_income": "Organization income reported to the IRS, in US dollars.",
    "populations_served": "Population groups served by the organization.",
    "service_days": "Days on which the recipient operates or distributes goods.",
    "profile_text": "Searchable operational description used for semantic matching.",
    "profile_source": "Provenance category for the recipient profile.",
    "latitude": "Latitude used for distance and geographic matching.",
    "longitude": "Longitude used for distance and geographic matching.",
}


TABLES = {
    "recipients": {
        "description": "Organizations eligible to receive and distribute surplus goods.",
        "columns": RECIPIENT_COLUMNS,
    },
    "surplus_postings": {
        "description": "Surplus offers used for recipient matching and fulfillment planning.",
        "columns": {
            "posting_id": "Unique surplus-posting identifier.",
            "track": "Surplus category: retail, farm, or essential goods.",
            "posting_text": "Free-text description used to find suitable recipients.",
            "foodkeeper_product": "FoodKeeper product used to obtain shelf-life guidance.",
            "storage_state": "Required storage condition for the offered goods.",
            "hours_available": "Number of hours before the donor collection deadline.",
            "shelf_life_hours": "Recommended usable storage duration in hours.",
            "hours_remaining": (
                "Effective matching window after considering both donor deadline and shelf life."
            ),
        },
    },
    "shelf_life": {
        "description": "Product-storage guidance used to estimate safe planning windows.",
        "columns": {
            "product_id": "Unique FoodKeeper product identifier.",
            "product_name": "Product display name.",
            "product_subtitle": "Product form, preparation, or variant.",
            "keywords": "Search terms used to identify the product.",
            "category": "Product category.",
            "refrigerated_hours": "Recommended refrigerated storage duration in hours.",
            "refrigerated_note": (
                "Interpretation status or special guidance for refrigerated storage."
            ),
            "pantry_hours": "Recommended pantry or ambient storage duration in hours.",
            "pantry_note": "Interpretation status or special guidance for pantry storage.",
        },
    },
    "tract_demographics": {
        "description": (
            "Neighborhood-level need indicators used for equity analysis and ranking tie-breaks."
        ),
        "columns": {
            "geo_id": "Unique eleven-digit Census tract identifier.",
            "tract_lat": "Latitude of the tract internal reference point.",
            "tract_lon": "Longitude of the tract internal reference point.",
            "total_pop": "Estimated total population.",
            "median_income": "Estimated median household income in US dollars.",
            "poverty_rate": "Share of residents below the poverty threshold.",
            "no_vehicle_rate": "Share of households without an available vehicle.",
            "assistance_rate": "Share of households receiving public assistance or SNAP.",
        },
    },
    "recipient_embeddings": {
        "description": "Vectorized recipient profiles used for semantic candidate retrieval.",
        "columns": {
            **RECIPIENT_COLUMNS,
            "embedding": "Vector representation of profile_text used for similarity search.",
        },
    },
}


def update_table(client: bigquery.Client, dataset: str, table_name: str) -> None:
    metadata = TABLES[table_name]
    table_id = f"{client.project}.{dataset}.{table_name}"
    table = client.get_table(table_id)
    descriptions = metadata["columns"]
    actual = {field.name for field in table.schema}
    expected = set(descriptions)
    if actual != expected:
        raise RuntimeError(
            f"{table_id} schema differs from the description map; "
            f"missing={sorted(actual - expected)}, extra={sorted(expected - actual)}"
        )

    table.description = metadata["description"]
    table.schema = [
        bigquery.SchemaField.from_api_repr(
            {**field.to_api_repr(), "description": descriptions[field.name]}
        )
        for field in table.schema
    ]
    updated = client.update_table(table, ["description", "schema"])
    described = sum(bool(field.description) for field in updated.schema)
    print(f"{updated.full_table_id}: {described}/{len(updated.schema)} columns described")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--dataset", default="a4i_food")
    args = parser.parse_args()
    client = bigquery.Client(project=args.project)
    for table_name in TABLES:
        update_table(client, args.dataset, table_name)


if __name__ == "__main__":
    main()
