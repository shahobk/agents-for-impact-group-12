from __future__ import annotations

import asyncio
import base64
from datetime import datetime, timezone

import pytest

from agent.intake import IntakeError, IntakeInterpreter, deterministic_interpret


NOW = datetime(2026, 10, 20, 16, 0, tzinfo=timezone.utc)
PNG = b"\x89PNG\r\n\x1a\n" + b"transient-test-bytes"


def test_deterministic_spinach_interpretation_is_review_first():
    result = deterministic_interpret(
        "I have ten crates of refrigerated spinach that must move within six hours for pickup",
        now=NOW,
    )

    assert result["draft"] == {
        "description": "I have ten crates of refrigerated spinach that must move within six hours for pickup",
        "quantity_original": "ten crates",
        "quantity_pallets": 1.0,
        "storage_state": "refrigerated",
        "pickup_deadline": "2026-10-20T22:00:00+00:00",
        "transport_mode": "recipient_pickup",
    }
    assert result["missing_fields"] == []
    assert result["provider"] == "deterministic_fallback"
    assert result["retained"] is False
    assert result["review_required"] is True


def test_photo_without_provider_is_validated_but_never_retained_or_echoed():
    interpreter = IntakeInterpreter(photo_provider=None, max_photo_bytes=1024)
    encoded = base64.b64encode(PNG).decode()

    result = asyncio.run(
        interpreter.extract(
            text="refrigerated spinach",
            photo_mime_type="image/png",
            photo_base64=encoded,
            now=NOW,
        )
    )

    assert result["retained"] is False
    assert result["review_required"] is True
    assert encoded not in str(result)
    assert any("Photo analysis is unavailable" in warning for warning in result["warnings"])


def test_photo_type_encoding_signature_and_decoded_size_are_enforced():
    interpreter = IntakeInterpreter(max_photo_bytes=16)
    with pytest.raises(IntakeError) as media:
        asyncio.run(
            interpreter.extract(
                photo_mime_type="image/svg+xml",
                photo_base64=base64.b64encode(b"<svg/>").decode(),
                now=NOW,
            )
        )
    assert media.value.status_code == 415

    with pytest.raises(IntakeError) as encoding:
        asyncio.run(
            interpreter.extract(
                photo_mime_type="image/png", photo_base64="not-base64", now=NOW
            )
        )
    assert encoding.value.code == "invalid_photo_encoding"

    with pytest.raises(IntakeError) as signature:
        asyncio.run(
            interpreter.extract(
                photo_mime_type="image/png",
                photo_base64=base64.b64encode(b"not png").decode(),
                now=NOW,
            )
        )
    assert signature.value.code == "photo_signature_mismatch"

    with pytest.raises(IntakeError) as size:
        asyncio.run(
            interpreter.extract(
                photo_mime_type="image/png",
                photo_base64=base64.b64encode(PNG).decode(),
                now=NOW,
            )
        )
    assert size.value.status_code == 413


def test_gemini_provider_output_is_allowlisted_and_requires_review():
    async def provider(data, mime_type, context):
        assert data == PNG
        assert mime_type == "image/png"
        return {
            "draft": {
                "description": "Bagged spinach",
                "quantity_original": "10 crates",
                "quantity_pallets": 1,
                "storage_state": "refrigerated",
                "pickup_deadline": "2026-10-20T22:00:00Z",
                "transport_mode": "recipient_pickup",
                "donor_latitude": 33.7,
            },
            "warnings": ["Visible label is partly obscured."],
        }

    result = asyncio.run(
        IntakeInterpreter(photo_provider=provider).extract(
            photo_mime_type="image/png",
            photo_base64=base64.b64encode(PNG).decode(),
            now=NOW,
        )
    )

    assert result["provider"] == "gemini"
    assert result["review_required"] is True
    assert result["retained"] is False
    assert "donor_latitude" not in result["draft"]



def test_text_goes_to_language_model_first_and_low_confidence_fields_get_questions():
    seen = {}

    async def text_provider(text, now):
        seen["text"] = text
        seen["now"] = now
        return {
            "draft": {
                "description": "Yogurt cups, 40 cases",
                "quantity_original": "40 cases",
                "quantity_pallets": 1,
                "storage_state": "refrigerated",
                "pickup_deadline": "2026-10-21T01:00:00Z",
                "transport_mode": None,
            },
            "confidence": {"quantity_pallets": "low", "storage_state": "high"},
            "warnings": [],
        }

    result = asyncio.run(
        IntakeInterpreter(text_provider=text_provider).extract(
            text="about 40 cases of yogurt, gotta go before we close at 9", now=NOW
        )
    )

    assert seen == {"text": "about 40 cases of yogurt, gotta go before we close at 9", "now": NOW}
    assert result["provider"] == "gemini"
    assert result["draft"]["quantity_original"] == "40 cases"
    assert result["confidence"]["quantity_pallets"] == "low"
    assert result["confidence"]["storage_state"] == "high"
    assert [question["field"] for question in result["questions"]] == [
        "quantity_pallets",
        "transport_mode",
    ]
    pallets = result["questions"][0]
    assert pallets["prompt"] == "Roughly how many pallets is 40 cases?"
    assert all({"label", "value"} <= option.keys() for option in pallets["options"])


def test_text_model_failure_falls_back_to_deterministic_reading():
    async def text_provider(text, now):
        raise RuntimeError("model unavailable")

    result = asyncio.run(
        IntakeInterpreter(text_provider=text_provider).extract(
            text="ten crates of refrigerated spinach within six hours for pickup", now=NOW
        )
    )

    assert result["provider"] == "deterministic_fallback"
    assert "intake assistant was unavailable" in result["warnings"][0]
    assert result["draft"]["storage_state"] == "refrigerated"


def test_deterministic_fallback_reads_clock_deadline_in_atlanta_time_and_asks_the_rest():
    # 16:00 UTC is noon in Atlanta (EDT), so "by 8 pm" is 00:00 UTC next day.
    result = deterministic_interpret("some bread, must be gone by 8 pm", now=NOW)

    assert result["draft"]["pickup_deadline"] == "2026-10-21T00:00:00+00:00"
    asked = [question["field"] for question in result["questions"]]
    assert asked == ["quantity_original", "quantity_pallets", "storage_state", "transport_mode"]
    deadline_question = asyncio.run(
        IntakeInterpreter().extract(text="some bread", now=NOW)
    )["questions"][3]
    assert deadline_question["field"] == "pickup_deadline"
    assert [option["label"] for option in deadline_question["options"]] == [
        "In 2 hours",
        "In 4 hours",
        "By 8 pm today",
    ]


def test_slow_language_model_times_out_to_deterministic_reading():
    async def text_provider(text, now):
        await asyncio.sleep(5)

    result = asyncio.run(
        IntakeInterpreter(text_provider=text_provider, provider_timeout_seconds=0.01).extract(
            text="ten crates of refrigerated spinach", now=NOW
        )
    )

    assert result["provider"] == "deterministic_fallback"
    assert result["draft"]["storage_state"] == "refrigerated"
