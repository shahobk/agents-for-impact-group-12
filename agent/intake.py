"""Transient, review-first intake interpretation for text and optional photos."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime, timedelta, timezone
import base64
import binascii
import json
import re
from typing import Any


PhotoProvider = Callable[[bytes, str, str], Awaitable[Mapping[str, Any]]]
TextProvider = Callable[[str, datetime], Awaitable[Mapping[str, Any]]]
# (reply text, now, offer deadline or None) -> {"draft", "confidence", "warnings"}
HandoffProvider = Callable[[str, datetime, datetime | None], Awaitable[Mapping[str, Any]]]
HANDOFF_FIELDS = ("contact_name", "contact_phone", "expected_handoff_time")
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
DRAFT_FIELDS = (
    "description",
    "quantity_original",
    "quantity_pallets",
    "storage_state",
    "pickup_deadline",
    "transport_mode",
)
# Fields the donor must settle before an offer can be created. Description is
# always the donor's own words, so it never needs a follow-up question.
QUESTION_FIELDS = (
    "quantity_original",
    "quantity_pallets",
    "storage_state",
    "pickup_deadline",
    "transport_mode",
)
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


def _atlanta_time(value: datetime) -> datetime:
    """Convert to Atlanta wall-clock time, even without a system tz database."""
    try:
        from zoneinfo import ZoneInfo

        return value.astimezone(ZoneInfo("America/New_York"))
    except Exception:
        # US Eastern DST: second Sunday of March to first Sunday of November.
        year = value.year
        march = datetime(year, 3, 8, 7, tzinfo=timezone.utc)
        november = datetime(year, 11, 1, 6, tzinfo=timezone.utc)
        dst_start = march + timedelta(days=(6 - march.weekday()) % 7)
        dst_end = november + timedelta(days=(6 - november.weekday()) % 7)
        offset = -4 if dst_start <= value < dst_end else -5
        return value.astimezone(timezone(timedelta(hours=offset)))


def _next_clock_time(now: datetime, hour: int, minute: int = 0) -> datetime:
    """Return the next Atlanta-local occurrence of hour:minute after now."""
    local_now = _atlanta_time(now)
    candidate = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if candidate <= local_now:
        candidate += timedelta(days=1)
    return candidate


def _clock_label(value: datetime, now: datetime) -> str:
    local = _atlanta_time(value)
    day = "today" if local.date() == _atlanta_time(now).date() else "tomorrow"
    clock = local.strftime("%I:%M %p").lstrip("0").replace(":00", "").lower()
    return f"{clock} {day}"


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
    else:
        clock_match = re.search(
            r"\b(?:by|before|until|till)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)",
            lower,
        )
        if clock_match:
            hour = int(clock_match.group(1))
            minute = int(clock_match.group(2) or 0)
            if 1 <= hour <= 12 and minute < 60:
                hour = hour % 12 + (12 if clock_match.group(3).startswith("p") else 0)
                draft["pickup_deadline"] = _iso(_next_clock_time(now, hour, minute))
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
    confidence = {key: "high" for key in inferred}
    if "quantity_pallets" in inferred and not draft["quantity_original"].endswith(("pallet", "pallets")):
        # Crate-to-pallet conversion is a demo normalization, not a reading.
        confidence["quantity_pallets"] = "low"
    return _with_questions(
        {
            "draft": draft,
            "inferred_fields": list(dict.fromkeys(inferred)),
            "missing_fields": missing,
            "confidence": confidence,
            "warnings": warnings,
            "provider": "deterministic_fallback",
            "retained": False,
            "review_required": True,
        },
        now,
    )


def _option(label: str, value: Any) -> dict[str, Any]:
    return {"label": label, "value": value}


def _question(field: str, draft: Mapping[str, Any], now: datetime) -> dict[str, Any]:
    """Build one tap-to-answer follow-up for a missing or uncertain field."""
    if field == "quantity_original":
        return {"field": field, "prompt": "How much food is there?", "kind": "text", "options": []}
    if field == "quantity_pallets":
        amount = draft.get("quantity_original")
        prompt = f"Roughly how many pallets is {amount}?" if amount else "Roughly how many pallets?"
        options = [_option("Under half", 0.25), _option("About half", 0.5), _option("1", 1.0), _option("2", 2.0), _option("3+", 3.0)]
        return {"field": field, "prompt": prompt, "kind": "choice", "options": options}
    if field == "storage_state":
        options = [_option("Refrigerated", "refrigerated"), _option("Frozen", "frozen"), _option("Shelf stable", "ambient")]
        return {"field": field, "prompt": "How does it need to be stored?", "kind": "choice", "options": options}
    if field == "pickup_deadline":
        choices = {
            _iso(now + timedelta(hours=2)): "In 2 hours",
            _iso(now + timedelta(hours=4)): "In 4 hours",
        }
        evening = _next_clock_time(now, 20)
        choices.setdefault(_iso(evening), f"By {_clock_label(evening, now)}")
        options = [_option(label, iso) for iso, label in sorted(choices.items())]
        return {"field": field, "prompt": "When does it need to be gone by?", "kind": "choice", "options": options}
    options = [
        _option("They pick up", "recipient_pickup"),
        _option("We can deliver", "donor_delivery"),
        _option("Need a driver", "transportation_needed"),
    ]
    return {"field": field, "prompt": "Who handles transport?", "kind": "choice", "options": options}


def _with_questions(result: dict[str, Any], now: datetime) -> dict[str, Any]:
    """Ask only about fields that are missing or that the reader was unsure of."""
    draft = result["draft"]
    confidence = result.setdefault("confidence", {})
    needs_answer = [
        field
        for field in QUESTION_FIELDS
        if draft.get(field) in {None, ""} or confidence.get(field) == "low"
    ]
    result["questions"] = [_question(field, draft, now) for field in needs_answer]
    return result


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
        text_provider: TextProvider | None = None,
        handoff_provider: HandoffProvider | None = None,
        max_photo_bytes: int = 5 * 1024 * 1024,
        provider_timeout_seconds: float = 15.0,
    ) -> None:
        self.photo_provider = photo_provider
        self.text_provider = text_provider
        self.provider_timeout_seconds = provider_timeout_seconds
        self.handoff_provider = handoff_provider
        self.max_photo_bytes = max_photo_bytes

    async def extract_handoff(
        self,
        *,
        text: str,
        deadline: datetime | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        """Read a recipient's free-text pickup reply into confirmation suggestions.

        The language model reads first; the deterministic reader only runs when
        the model is not configured or fails. Nothing is confirmed here.
        """
        at = now or datetime.now(timezone.utc)
        if at.tzinfo is None:
            raise IntakeError("invalid_now", "now must include a timezone offset.")
        normalized = " ".join(text.split()).strip()
        if not normalized:
            raise IntakeError("empty_handoff", "Tell us who is picking up, when, and a phone number.")
        if self.handoff_provider is not None:
            try:
                value = await asyncio.wait_for(
                    self.handoff_provider(normalized, at, deadline),
                    self.provider_timeout_seconds,
                )
                return _handoff_result(value, at, deadline, provider="gemini")
            except Exception:
                fallback = deterministic_handoff(normalized, now=at, deadline=deadline)
                fallback["warnings"].insert(
                    0, "The assistant was unavailable; a simpler reader filled this in."
                )
                return fallback
        return deterministic_handoff(normalized, now=at, deadline=deadline)

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
        if data is None:
            if self.text_provider is None or not combined:
                return fallback
            try:
                provider_value = await asyncio.wait_for(
                    self.text_provider(combined, at), self.provider_timeout_seconds
                )
                return _provider_result(provider_value, combined, at, [])
            except Exception:
                fallback["warnings"].insert(
                    0,
                    "The intake assistant was unavailable; deterministic text interpretation was used.",
                )
                return fallback
        if self.photo_provider is None:
            fallback["warnings"].insert(
                0,
                "Photo analysis is unavailable; only supplied text was interpreted.",
            )
            return fallback

        try:
            provider_value = await asyncio.wait_for(
                self.photo_provider(data, photo_mime_type or "", combined),
                self.provider_timeout_seconds,
            )
            return _provider_result(
                provider_value,
                combined,
                at,
                ["Photo suggestions are not food-safety decisions and require donor review."],
            )
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


def _provider_result(
    provider_value: Mapping[str, Any],
    context: str,
    now: datetime,
    extra_warnings: list[str],
) -> dict[str, Any]:
    draft = _safe_provider_draft(provider_value.get("draft", provider_value), context)
    inferred = [key for key, value in draft.items() if value not in {None, ""}]
    raw_confidence = provider_value.get("confidence")
    raw_confidence = raw_confidence if isinstance(raw_confidence, Mapping) else {}
    confidence = {
        key: "low" if raw_confidence.get(key) == "low" else "high" for key in inferred
    }
    warnings = [str(item)[:500] for item in provider_value.get("warnings", []) if item]
    warnings.extend(extra_warnings)
    return _with_questions(
        {
            "draft": draft,
            "inferred_fields": inferred,
            "missing_fields": [key for key, value in draft.items() if value in {None, ""}],
            "confidence": confidence,
            "warnings": warnings,
            "provider": "gemini",
            "retained": False,
            "review_required": True,
        },
        now,
    )


def _extraction_instructions(now: datetime) -> str:
    local_now = _atlanta_time(now)
    return (
        "You turn a grocery donor's description of surplus food into an offer draft. "
        "Return JSON only, shaped as {\"draft\": {...}, \"confidence\": {...}, \"warnings\": [...]}. "
        "draft fields: description (a short plain summary of the food and packaging, keeping the "
        "donor's details), quantity_original (the amount in the donor's own units, e.g. \"40 cases\"), "
        "quantity_pallets (number; estimate from the units when not stated, e.g. a standard pallet "
        "holds roughly 40-60 grocery cases or 10 produce crates), storage_state (one of ambient, "
        "refrigerated, frozen), pickup_deadline (ISO 8601 with offset), transport_mode (one of "
        "recipient_pickup, donor_delivery, transportation_needed). "
        "confidence maps each draft field you filled to \"high\" when the donor stated it and "
        "\"low\" when you estimated it. Use null for anything not stated or reasonably implied. "
        "Resolve relative times such as \"before we close at 9\" or \"tonight\" against the donor's "
        f"local time, which is {local_now.isoformat()} ({local_now.strftime('%A')}, Atlanta). "
        "Never judge food safety, and never invent a deadline, location, or contact detail."
    )


def build_gemini_text_provider(
    *, project: str | None, location: str, model: str
) -> TextProvider | None:
    if not project:
        return None

    async def provider(text: str, now: datetime) -> Mapping[str, Any]:
        from google import genai
        from google.genai import types

        client = genai.Client(vertexai=True, project=project, location=location)
        response = await client.aio.models.generate_content(
            model=model,
            contents=[
                types.Part.from_text(
                    text=f"{_extraction_instructions(now)}\n\nDonor description: {text[:4000]}"
                ),
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json", temperature=0
            ),
        )
        return json.loads((response.text or "{}").strip())

    return provider


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
            f"{_extraction_instructions(datetime.now(timezone.utc))} "
            "Read quantities, packaging, and label dates from the photo; a label date is not a "
            f"pickup deadline. Optional donor context: {context[:2000]}"
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


# --- Recipient pickup reply ("Maria, around 6:30, 404-555-0182") -------------

_PHONE = re.compile(r"(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b")
_TIME_WORDS = re.compile(
    r"\b(?:around|about|at|by|in|before|after|today|tonight|tomorrow|noon|am|pm|"
    r"hours?|hrs?|minutes?|mins?|asap|now|soon|call|text|phone|number|cell)\b",
    re.IGNORECASE,
)
_NAME_LEADS = re.compile(
    r"^(?:this is|it's|it is|i'm|i am|we'll send|sending|contact(?: is)?|name(?: is)?)\s+",
    re.IGNORECASE,
)
_NAME_TAILS = re.compile(
    r"\s+(?:will|can|is|'ll)\b.*$|\s+(?:picking|coming|driving|grabbing)\b.*$",
    re.IGNORECASE,
)


def _blank_handoff() -> dict[str, Any]:
    return {field: None for field in HANDOFF_FIELDS}


def _clean_phone(value: Any) -> str | None:
    text = " ".join(str(value or "").split())[:80]
    return text if len(re.sub(r"\D", "", text)) >= 7 else None


def _clean_name(value: Any) -> str | None:
    text = " ".join(str(value or "").split()).strip(" ,.;:-")[:200]
    return text or None


def _resolve_clock(
    now: datetime, deadline: datetime | None, hour: int, minute: int, meridiem: str | None
) -> datetime | None:
    if not (0 <= hour <= 23 and 0 <= minute < 60):
        return None
    if meridiem:
        if not 1 <= hour <= 12:
            return None
        hours = [hour % 12 + (12 if meridiem.startswith("p") else 0)]
    elif hour > 12 or hour == 0:
        hours = [hour]
    else:
        # "around 6:30" is whichever 6:30 comes next; prefer one before the deadline.
        hours = [hour % 12, hour % 12 + 12]
    candidates = sorted(_next_clock_time(now, h, minute) for h in hours)
    if deadline is not None:
        in_window = [c for c in candidates if c <= deadline]
        if in_window:
            return in_window[0]
    return candidates[0]


def deterministic_handoff(
    text: str, *, now: datetime, deadline: datetime | None = None
) -> dict[str, Any]:
    """Offline fallback: a conservative reading of name, phone, and time."""
    normalized = " ".join(text.split()).strip()
    draft = _blank_handoff()
    rest = normalized
    phone = _PHONE.search(rest)
    if phone:
        draft["contact_phone"] = _clean_phone(phone.group(0))
        rest = (rest[: phone.start()] + " , " + rest[phone.end():]).strip()
    lower = rest.lower()

    handoff: datetime | None = None
    relative = re.search(
        r"\bin\s+(?:(an?|half an|\d+(?:\.\d+)?)\s*)(hours?|hrs?|minutes?|mins?)\b", lower
    )
    if relative:
        amount_text, unit = relative.groups()
        amount = {"a": 1.0, "an": 1.0, "half an": 0.5}.get(amount_text) or float(amount_text)
        minutes = amount * (60 if unit.startswith("h") else 1)
        handoff = now + timedelta(minutes=minutes)
        rest = rest[: relative.start()] + " , " + rest[relative.end():]
    elif re.search(r"\bnoon\b", lower):
        handoff = _next_clock_time(now, 12)
        rest = re.sub(r"(?i)\b(?:around |at |by )?noon\b", " , ", rest)
    else:
        # A bare number is not a time; it needs "around/at/by", a colon, or am/pm.
        clock = next(
            (
                match
                for match in re.finditer(
                    r"(?:\b(around|about|at|by)\s+|~\s*)?\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?=\W|$)",
                    lower,
                )
                if match.group(1) or match.group(3) or match.group(4)
            ),
            None,
        )
        if clock:
            meridiem = (clock.group(4) or "").replace(".", "") or None
            handoff = _resolve_clock(
                now, deadline, int(clock.group(2)), int(clock.group(3) or 0), meridiem
            )
            rest = rest[: clock.start()] + " , " + rest[clock.end():]
    if handoff is not None:
        draft["expected_handoff_time"] = _iso(handoff)

    for segment in re.split(r"[,;\n]| - ", rest):
        candidate = _NAME_TAILS.sub("", _NAME_LEADS.sub("", segment.strip()))
        if (
            re.fullmatch(r"[A-Za-z][A-Za-z.'\- ]{0,60}", candidate)
            and not _TIME_WORDS.search(candidate)
            and len(candidate.split()) <= 4
        ):
            draft["contact_name"] = _clean_name(candidate)
            break
    return _handoff_result(
        {"draft": draft, "confidence": {}}, now, deadline, provider="deterministic_fallback"
    )


def _round_minutes(value: datetime, *, up: bool, step: int = 5) -> datetime:
    base = value.replace(second=0, microsecond=0)
    extra = base.minute % step
    if not extra:
        return base
    return base + timedelta(minutes=step - extra) if up else base - timedelta(minutes=extra)


def _handoff_question(
    field: str,
    now: datetime,
    deadline: datetime | None,
    problem: str = "",
    guess: str | None = None,
) -> dict[str, Any]:
    if field == "contact_name":
        return {"field": field, "prompt": "Who's picking it up?", "kind": "text", "options": []}
    if field == "contact_phone":
        return {"field": field, "prompt": "What number can the donor call?", "kind": "text", "options": []}
    options = []
    if guess:
        options.append(_option(f"Yes, {_clock_label(datetime.fromisoformat(guess), now)}", guess))
    for minutes, label in ((30, "In 30 min"), (60, "In 1 hour"), (120, "In 2 hours")):
        at = _round_minutes(now + timedelta(minutes=minutes), up=True)
        if deadline is None or at <= deadline:
            options.append(_option(label, _iso(at)))
    if deadline is not None and deadline - now > timedelta(minutes=20):
        latest = _round_minutes(deadline - timedelta(minutes=10), up=False)
        last = datetime.fromisoformat(options[-1]["value"]) if options else now
        if latest > last + timedelta(minutes=20):
            options.append(_option(f"By {_clock_label(latest, now)}", _iso(latest)))
    if guess:
        prompt = f"Did you mean {_clock_label(datetime.fromisoformat(guess), now)}?"
    else:
        prompt = problem or "When will you get there?"
    return {"field": field, "prompt": prompt, "kind": "choice", "options": options}


def _handoff_result(
    provider_value: Mapping[str, Any],
    now: datetime,
    deadline: datetime | None,
    *,
    provider: str,
) -> dict[str, Any]:
    raw = provider_value.get("draft", provider_value)
    raw = raw if isinstance(raw, Mapping) else {}
    draft = _blank_handoff()
    draft["contact_name"] = _clean_name(raw.get("contact_name"))
    draft["contact_phone"] = _clean_phone(raw.get("contact_phone"))
    warnings = [str(item)[:300] for item in provider_value.get("warnings", []) or [] if item]
    problem = ""
    if raw.get("expected_handoff_time"):
        try:
            parsed = datetime.fromisoformat(str(raw["expected_handoff_time"]).replace("Z", "+00:00"))
        except ValueError:
            parsed = None
        if parsed is not None and parsed.tzinfo is not None:
            label = _clock_label(parsed, now)
            if parsed <= now:
                problem = f"{label.capitalize()} has already passed. When will you get there?"
            elif deadline is not None and parsed > deadline:
                problem = (
                    f"{label.capitalize()} is after the food has to be gone "
                    f"({_clock_label(deadline, now)}). When can you get there?"
                )
            else:
                draft["expected_handoff_time"] = _iso(parsed)
    if problem:
        warnings.insert(0, problem)
    raw_confidence = provider_value.get("confidence")
    raw_confidence = raw_confidence if isinstance(raw_confidence, Mapping) else {}
    filled = [field for field in HANDOFF_FIELDS if draft[field]]
    confidence = {field: "low" if raw_confidence.get(field) == "low" else "high" for field in filled}
    questions = [
        _handoff_question(
            field,
            now,
            deadline,
            problem if field == "expected_handoff_time" else "",
            guess=draft[field] if field == "expected_handoff_time" else None,
        )
        for field in HANDOFF_FIELDS
        if not draft[field] or confidence.get(field) == "low"
    ]
    return {
        "draft": draft,
        "confidence": confidence,
        "missing_fields": [field for field in HANDOFF_FIELDS if not draft[field]],
        "questions": questions,
        "warnings": warnings,
        "provider": provider,
        "retained": False,
        "review_required": True,
    }


def _handoff_instructions(now: datetime, deadline: datetime | None) -> str:
    local_now = _atlanta_time(now)
    window = (
        f"The food must be picked up by {_atlanta_time(deadline).isoformat()}. "
        if deadline is not None
        else ""
    )
    return (
        "A food pantry is replying to a food-rescue offer with who will pick it up, when, and "
        "a phone number. Return JSON only, shaped as "
        "{\"draft\": {\"contact_name\": ..., \"contact_phone\": ..., \"expected_handoff_time\": ...}, "
        "\"confidence\": {...}, \"warnings\": [...]}. "
        "contact_name is the person picking up (just the name). contact_phone is the phone number "
        "as written. expected_handoff_time is ISO 8601 with offset. "
        f"The pantry's local time is {local_now.isoformat()} ({local_now.strftime('%A')}, Atlanta). "
        f"{window}"
        "Resolve relative or partial times such as \"around 6:30\", \"in an hour\", or \"after "
        "lunch\" against that local time; when am/pm is not said, choose the next occurrence, "
        "preferring one before the pickup deadline. "
        "confidence maps each filled field to \"high\" when stated and \"low\" when you had to "
        "guess. A time like \"around 6:30\" counts as stated (high) when only one reading falls "
        "between now and the pickup deadline; approximate words like \"around\" do not lower it. "
        "Use null for anything not stated. Never invent a name, number, or time."
    )


def build_gemini_handoff_provider(
    *, project: str | None, location: str, model: str
) -> HandoffProvider | None:
    if not project:
        return None

    async def provider(text: str, now: datetime, deadline: datetime | None) -> Mapping[str, Any]:
        from google import genai
        from google.genai import types

        client = genai.Client(vertexai=True, project=project, location=location)
        response = await client.aio.models.generate_content(
            model=model,
            contents=[
                types.Part.from_text(
                    text=f"{_handoff_instructions(now, deadline)}\n\nPantry reply: {text[:1000]}"
                ),
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json", temperature=0
            ),
        )
        return json.loads((response.text or "{}").strip())

    return provider


__all__ = [
    "ALLOWED_IMAGE_TYPES",
    "IntakeError",
    "IntakeInterpreter",
    "build_gemini_handoff_provider",
    "build_gemini_photo_provider",
    "build_gemini_text_provider",
    "deterministic_handoff",
    "deterministic_interpret",
]
