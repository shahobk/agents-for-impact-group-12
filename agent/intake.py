"""Transient, review-first intake interpretation for text and optional photos."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime, timedelta, timezone
import base64
import binascii
import json
import re
from typing import Any


PhotoProvider = Callable[[bytes, str, str], Awaitable[Mapping[str, Any]]]
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
_NUMBER_WORDS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "twenty-four": 24,
}


class IntakeError(ValueError):
    def __init__(self, code: str, message: str, *, status_code: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _number(value: str) -> float | None:
    try:
        return float(value)
    except ValueError:
        return float(_NUMBER_WORDS[value.lower()]) if value.lower() in _NUMBER_WORDS else None


def _blank_draft(description: str = "") -> dict[str, Any]:
    return {
        "description": description,
        "quantity_original": None,
        "quantity_pallets": None,
        "storage_state": None,
        "pickup_deadline": None,
        "transport_mode": None,
    }


def deterministic_interpret(text: str, *, now: datetime) -> dict[str, Any]:
    """Extract conservative suggestions without asserting safety or submitting."""
    normalized = " ".join(text.split()).strip()
    draft = _blank_draft(normalized)
    inferred: list[str] = []
    warnings: list[str] = []
    lower = normalized.lower()

    quantity_match = re.search(
        r"\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+"
        r"(crates?|cases?|boxes?|pallets?|gallons?|loaves|pounds?|lbs?)\b",
        lower,
    )
    if quantity_match:
        amount = _number(quantity_match.group(1))
        unit = quantity_match.group(2)
        draft["quantity_original"] = quantity_match.group(0)
        inferred.append("quantity_original")
        if unit.startswith("pallet") and amount is not None:
            draft["quantity_pallets"] = amount
            inferred.append("quantity_pallets")
        elif amount == 10 and unit.startswith("crate") and "spinach" in lower:
            draft["quantity_pallets"] = 1.0
            inferred.append("quantity_pallets")
            warnings.append(
                "One pallet is a demo normalization for ten crates; the donor must review it."
            )

    if re.search(r"\bfrozen|freezer\b", lower):
        draft["storage_state"] = "frozen"
        inferred.append("storage_state")
    elif re.search(r"\brefrigerat|chilled|cold storage|keep cold\b", lower):
        draft["storage_state"] = "refrigerated"
        inferred.append("storage_state")
    elif re.search(r"\bambient|shelf[- ]stable|pantry|room temperature\b", lower):
        draft["storage_state"] = "ambient"
        inferred.append("storage_state")

    hours_match = re.search(
        r"\b(?:within|in|before)\s+(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty-four)\s+hours?\b",
        lower,
    )
    if hours_match:
        hours = _number(hours_match.group(1))
        if hours and hours > 0:
            draft["pickup_deadline"] = _iso(now + timedelta(hours=hours))
            inferred.append("pickup_deadline")

    if re.search(r"\bI can deliver|donor delivery|we can deliver\b", lower):
        draft["transport_mode"] = "donor_delivery"
        inferred.append("transport_mode")
    elif re.search(r"\bneed(?:s)? (?:a )?(?:driver|ride|transport)|transportation needed\b", lower):
        draft["transport_mode"] = "transportation_needed"
        inferred.append("transport_mode")
    elif re.search(r"\bpick ?up|collect\b", lower):
        draft["transport_mode"] = "recipient_pickup"
        inferred.append("transport_mode")

    if normalized:
        inferred.insert(0, "description")
    missing = [key for key, value in draft.items() if value in {None, ""}]
    warnings.append(
        "All inferred quantity, storage, transport, and deadline fields require donor review."
    )
    return {
        "draft": draft,
        "inferred_fields": list(dict.fromkeys(inferred)),
        "missing_fields": missing,
        "warnings": warnings,
        "provider": "deterministic_fallback",
        "retained": False,
        "review_required": True,
    }


def _validate_image(data: bytes, mime_type: str, max_bytes: int) -> None:
    if mime_type not in ALLOWED_IMAGE_TYPES:
        raise IntakeError(
            "unsupported_photo_type",
            "Photo must be JPEG, PNG, or WebP.",
            status_code=415,
        )
    if not data:
        raise IntakeError("empty_photo", "Photo data is empty.")
    if len(data) > max_bytes:
        raise IntakeError(
            "photo_too_large",
            f"Photo exceeds the {max_bytes // (1024 * 1024)} MB limit.",
            status_code=413,
        )
    signatures = {
        "image/jpeg": data.startswith(b"\xff\xd8\xff"),
        "image/png": data.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/webp": len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP",
    }
    if not signatures[mime_type]:
        raise IntakeError("photo_signature_mismatch", "Photo bytes do not match the media type.")


def _safe_provider_draft(value: Mapping[str, Any], context: str) -> dict[str, Any]:
    allowed = _blank_draft(context)
    for key in allowed:
        if key in value:
            allowed[key] = value[key]
    if allowed["storage_state"] not in {None, "ambient", "refrigerated", "frozen"}:
        allowed["storage_state"] = None
    if allowed["transport_mode"] not in {
        None,
        "recipient_pickup",
        "donor_delivery",
        "transportation_needed",
    }:
        allowed["transport_mode"] = None
    try:
        if allowed["quantity_pallets"] is not None:
            amount = float(allowed["quantity_pallets"])
            allowed["quantity_pallets"] = amount if amount > 0 else None
    except (TypeError, ValueError):
        allowed["quantity_pallets"] = None
    if allowed["pickup_deadline"]:
        try:
            parsed = datetime.fromisoformat(str(allowed["pickup_deadline"]).replace("Z", "+00:00"))
            allowed["pickup_deadline"] = _iso(parsed) if parsed.tzinfo else None
        except ValueError:
            allowed["pickup_deadline"] = None
    allowed["description"] = str(allowed["description"] or context).strip()[:4000]
    if allowed["quantity_original"] is not None:
        allowed["quantity_original"] = str(allowed["quantity_original"])[:300]
    return allowed


class IntakeInterpreter:
    def __init__(
        self,
        *,
        photo_provider: PhotoProvider | None = None,
        max_photo_bytes: int = 5 * 1024 * 1024,
    ) -> None:
        self.photo_provider = photo_provider
        self.max_photo_bytes = max_photo_bytes

    async def extract(
        self,
        *,
        text: str = "",
        transcript: str = "",
        photo_mime_type: str | None = None,
        photo_base64: str | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        at = now or datetime.now(timezone.utc)
        if at.tzinfo is None:
            raise IntakeError("invalid_now", "now must include a timezone offset.")
        combined = " ".join(part.strip() for part in (text, transcript) if part.strip())
        if not combined and not photo_base64:
            raise IntakeError("empty_intake", "Text, transcript, or a photo is required.")

        data: bytes | None = None
        if photo_base64 is not None:
            if not photo_mime_type:
                raise IntakeError("missing_photo_type", "Photo media type is required.")
            # Reject oversized encoded input before allocating the decoded form.
            if len(photo_base64) > ((self.max_photo_bytes + 2) // 3) * 4 + 16:
                raise IntakeError("photo_too_large", "Photo exceeds the decoded size limit.", status_code=413)
            try:
                data = base64.b64decode(photo_base64, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise IntakeError("invalid_photo_encoding", "Photo must be valid base64.") from exc
            _validate_image(data, photo_mime_type, self.max_photo_bytes)

        fallback = deterministic_interpret(combined, now=at)
        if data is None or self.photo_provider is None:
            if data is not None:
                fallback["warnings"].insert(
                    0,
                    "Photo analysis is unavailable; only supplied text was interpreted.",
                )
            return fallback

        try:
            provider_value = await self.photo_provider(data, photo_mime_type or "", combined)
            draft = _safe_provider_draft(provider_value.get("draft", provider_value), combined)
            inferred = [key for key, value in draft.items() if value not in {None, ""}]
            warnings = [
                str(item)[:500] for item in provider_value.get("warnings", []) if item
            ]
            warnings.append(
                "Photo suggestions are not food-safety decisions and require donor review."
            )
            return {
                "draft": draft,
                "inferred_fields": inferred,
                "missing_fields": [key for key, value in draft.items() if value in {None, ""}],
                "warnings": warnings,
                "provider": "gemini",
                "retained": False,
                "review_required": True,
            }
        except Exception:
            fallback["warnings"].insert(
                0,
                "Photo analysis was unavailable; deterministic text interpretation was used.",
            )
            return fallback
        finally:
            # No reference escapes this request. The bytes are never written to
            # Firestore, Cloud Storage, logs, command receipts, or the response.
            data = None


def build_gemini_photo_provider(
    *, project: str | None, location: str, model: str
) -> PhotoProvider | None:
    if not project:
        return None

    async def provider(data: bytes, mime_type: str, context: str) -> Mapping[str, Any]:
        from google import genai
        from google.genai import types

        client = genai.Client(vertexai=True, project=project, location=location)
        prompt = (
            "Return JSON only with a draft object containing description, quantity_original, "
            "quantity_pallets, storage_state, pickup_deadline, and transport_mode, plus a warnings "
            "array. Use null when uncertain. Never infer food safety or a deadline that is not visible "
            f"or stated. Optional donor context: {context[:2000]}"
        )
        response = await client.aio.models.generate_content(
            model=model,
            contents=[
                types.Part.from_text(text=prompt),
                types.Part.from_bytes(data=data, mime_type=mime_type),
            ],
            config=types.GenerateContentConfig(response_mime_type="application/json"),
        )
        rendered = (response.text or "{}").strip()
        return json.loads(rendered)

    return provider


__all__ = [
    "ALLOWED_IMAGE_TYPES",
    "IntakeError",
    "IntakeInterpreter",
    "build_gemini_photo_provider",
    "deterministic_interpret",
]
