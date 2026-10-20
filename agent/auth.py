"""Opaque bearer-token authorization for the public demo workflow."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import secrets
import base64
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

