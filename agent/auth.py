"""Opaque bearer-token authorization for the public demo workflow."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import hashlib
import hmac
import secrets
import base64
import binascii
from typing import Any


class AuthorizationError(RuntimeError):
    def __init__(self, code: str, message: str, *, status_code: int = 401) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


@dataclass(frozen=True)
class TokenAuthority:
    pepper: str
    coordinator_token: str

    def digest(self, raw_token: str) -> str:
        return hmac.new(
            self.pepper.encode("utf-8"),
            raw_token.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    def issue(
        self,
        state: dict[str, Any],
        *,
        actor_type: str,
        actor_id: str,
        actions: list[str],
        offer_id: str | None = None,
        ttl: timedelta = timedelta(days=7),
        now: datetime | None = None,
    ) -> str:
        issued_at = now or utc_now()
        raw_token = secrets.token_urlsafe(32)
        state["access_tokens"][self.digest(raw_token)] = {
            "actor_type": actor_type,
            "actor_id": actor_id,
            "offer_id": offer_id,
            "actions": sorted(set(actions)),
            "issued_at": issued_at.isoformat(),
            "expires_at": (issued_at + ttl).isoformat(),
            "revoked": False,
        }
        return raw_token

    def issue_deterministic(
        self,
        state: dict[str, Any],
        *,
        token_key: str,
        actor_type: str,
        actor_id: str,
        actions: list[str],
        offer_id: str | None = None,
        ttl: timedelta = timedelta(days=7),
        now: datetime | None = None,
    ) -> str:
        """Issue a replayable opaque token without persisting its raw value."""
        raw_token = self.derive_deterministic(token_key)
        issued_at = now or utc_now()
        state["access_tokens"].setdefault(
            self.digest(raw_token),
            {
                "actor_type": actor_type,
                "actor_id": actor_id,
                "offer_id": offer_id,
                "actions": sorted(set(actions)),
                "issued_at": issued_at.isoformat(),
                "expires_at": (issued_at + ttl).isoformat(),
                "revoked": False,
            },
        )
        return raw_token

    def derive_deterministic(self, token_key: str) -> str:
        """Regenerate a scoped demo token without reading or writing persistence."""
        token_bytes = hmac.new(
            self.pepper.encode("utf-8"), token_key.encode("utf-8"), hashlib.sha256
        ).digest()
        return base64.urlsafe_b64encode(token_bytes).rstrip(b"=").decode("ascii")

    def authenticate(
        self,
        state: dict[str, Any],
        raw_token: str | None,
        *,
        action: str,
        offer_id: str | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        if not raw_token:
            raise AuthorizationError("missing_bearer_token", "A bearer token is required.")
        record = state["access_tokens"].get(self.digest(raw_token))
        if not record or record.get("revoked"):
            raise AuthorizationError("invalid_bearer_token", "The bearer token is invalid.")
        if parse_time(record["expires_at"]) <= (now or utc_now()):
            raise AuthorizationError("expired_bearer_token", "The bearer token has expired.")
        if action not in record.get("actions", []):
            raise AuthorizationError(
                "insufficient_scope",
                "The bearer token does not permit this action.",
                status_code=403,
            )
        token_offer = record.get("offer_id")
        if offer_id is not None and token_offer not in {None, offer_id}:
            raise AuthorizationError(
                "offer_scope_mismatch",
                "The bearer token is scoped to another offer.",
                status_code=403,
            )
        return record

    def authenticate_coordinator(self, raw_token: str | None) -> dict[str, str]:
        if not raw_token or not hmac.compare_digest(raw_token, self.coordinator_token):
            raise AuthorizationError(
                "invalid_coordinator_token",
                "A valid coordinator bearer token is required.",
            )
        return {"actor_type": "coordinator", "actor_id": "demo-coordinator"}

    def issue_coordinator_session(
        self,
        *,
        ttl: timedelta = timedelta(minutes=15),
        now: datetime | None = None,
    ) -> str:
        """Issue a short-lived, stateless coordinator cookie value.

        The payload contains no coordinator secret. Its HMAC uses a distinct
        domain prefix so these signatures cannot be reused as opaque tokens.
        """
        issued_at = now or utc_now()
        payload = {
            "aud": "pantry-relay-demo",
            "exp": int((issued_at + ttl).timestamp()),
            "iat": int(issued_at.timestamp()),
            "scope": "coordinator",
            "v": 1,
        }
        encoded = base64.urlsafe_b64encode(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode(
                "utf-8"
            )
        ).rstrip(b"=").decode("ascii")
        signing_input = f"v1.{encoded}"
        signature = hmac.new(
            self.pepper.encode("utf-8"),
            f"demo-session:{signing_input}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        return f"{signing_input}.{signature}"

    def authenticate_coordinator_session(
        self,
        raw_session: str | None,
        *,
        now: datetime | None = None,
    ) -> dict[str, str]:
        if not raw_session:
            raise AuthorizationError(
                "missing_demo_session", "A coordinator session is required."
            )
        try:
            version, encoded, supplied_signature = raw_session.split(".", 2)
        except ValueError as exc:
            raise AuthorizationError(
                "invalid_demo_session", "The coordinator session is invalid."
            ) from exc
        signing_input = f"{version}.{encoded}"
        expected_signature = hmac.new(
            self.pepper.encode("utf-8"),
            f"demo-session:{signing_input}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        if version != "v1" or not hmac.compare_digest(
            supplied_signature, expected_signature
        ):
            raise AuthorizationError(
                "invalid_demo_session", "The coordinator session is invalid."
            )
        try:
            padding = "=" * (-len(encoded) % 4)
            payload = json.loads(
                base64.urlsafe_b64decode(encoded + padding).decode("utf-8")
            )
            if not isinstance(payload, dict):
                raise ValueError("session payload must be an object")
            expires_at = int(payload["exp"])
        except (
            binascii.Error,
            KeyError,
            TypeError,
            ValueError,
            UnicodeError,
            json.JSONDecodeError,
        ) as exc:
            raise AuthorizationError(
                "invalid_demo_session", "The coordinator session is invalid."
            ) from exc
        if payload.get("aud") != "pantry-relay-demo" or payload.get("scope") != "coordinator":
            raise AuthorizationError(
                "insufficient_demo_session_scope",
                "The demo session does not permit coordinator access.",
                status_code=403,
            )
        if expires_at <= int((now or utc_now()).timestamp()):
            raise AuthorizationError(
                "expired_demo_session", "The coordinator session has expired."
            )
        return {"actor_type": "coordinator", "actor_id": "demo-coordinator"}

