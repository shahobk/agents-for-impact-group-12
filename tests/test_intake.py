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

