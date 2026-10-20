"""Read-only advisory lookup over the bundled USDA FoodKeeper export."""

from __future__ import annotations

from functools import lru_cache
import json
from pathlib import Path
import re
from typing import Any


_DATA_PATH = Path(__file__).resolve().parents[1] / "data" / "foodkeeper.json"
_WORDS = re.compile(r"[a-z0-9]+")


@lru_cache(maxsize=1)
def _products() -> tuple[dict[str, Any], ...]:
    with _DATA_PATH.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    return tuple(dict(item) for item in payload.get("product_data", []))


def lookup_foodkeeper(description: str, storage_state: str) -> dict[str, Any] | None:
    """Return label-only guidance; never derive or replace the offer deadline."""
    stopwords = {
        "a", "an", "and", "crate", "crates", "of", "the", "ten",
        "refrigerated", "frozen", "ambient", "fresh", "available",
    }
    query = set(_WORDS.findall(description.lower())) - stopwords
    if not query:
        return None
    scored: list[tuple[int, dict[str, Any]]] = []
    for product in _products():
        searchable = " ".join(
            str(product.get(key) or "")
            for key in ("name", "name_subtitle", "keywords")
        ).lower()
        terms = set(_WORDS.findall(searchable))
        score = len(query & terms)
        if score:
            scored.append((score, product))
    if not scored:
        return None
    scored.sort(key=lambda item: (-item[0], int(item[1].get("id") or 0)))
    product = scored[0][1]
    prefix = {
        "ambient": "pantry",
        "refrigerated": "refrigerate",
        "frozen": "freeze",
    }.get(storage_state, "refrigerate")
    guidance = {
        key: product.get(key)
        for key in (
            f"{prefix}_output_display_only",
            f"{prefix}_tips",
            f"from_date_of_purchase_{prefix}_output_display_only",
            f"from_date_of_purchase_{prefix}_tips",
            f"{prefix}_after_opening_output_display_only",
            f"{prefix}_after_thawing_output_display_only",
        )
        if product.get(key)
    }
    return {
        "source": "USDA FoodKeeper bundled dataset",
        "product_id": str(product.get("id")),
        "product_name": str(product.get("name") or "").strip(),
        "product_subtitle": product.get("name_subtitle"),
        "storage_state": storage_state,
        "guidance": guidance,
        "label": "Advisory only; donor-confirmed deadline is authoritative",
        "donor_deadline_authoritative": True,
    }


__all__ = ["lookup_foodkeeper"]
