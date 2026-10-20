"""Deterministic Cloud Tasks scheduling and callback authentication."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
import json
from typing import Any, Protocol

from .auth import AuthorizationError, parse_time


class TaskScheduler(Protocol):
    def schedule(self, *, task_name: str, run_at: str, payload: dict[str, Any]) -> str: ...

    def ping(self) -> bool: ...


@dataclass
class InMemoryTaskScheduler:
    """Idempotent local scheduler; callers can execute recorded payloads in tests."""

    tasks: dict[str, dict[str, Any]] = field(default_factory=dict)

    def schedule(self, *, task_name: str, run_at: str, payload: dict[str, Any]) -> str:
        self.tasks.setdefault(
            task_name,
            {"task_name": task_name, "run_at": run_at, "payload": dict(payload)},
        )
        return task_name

    def ping(self) -> bool:
        return True


class CloudTasksScheduler:
    def __init__(
        self,
        *,
        project: str,
        location: str,
        queue: str,
        callback_url: str,
        service_account_email: str,
        audience: str,
    ) -> None:
        from google.cloud import tasks_v2

        self._tasks_v2 = tasks_v2
        self._client = tasks_v2.CloudTasksClient()
        self._parent = self._client.queue_path(project, location, queue)
        self._callback_url = callback_url
        self._service_account_email = service_account_email
        self._audience = audience

    def schedule(self, *, task_name: str, run_at: str, payload: dict[str, Any]) -> str:
        from google.api_core.exceptions import AlreadyExists
        from google.protobuf import timestamp_pb2

        timestamp = timestamp_pb2.Timestamp()
        due = parse_time(run_at)
        timestamp.FromDatetime(due)
        full_name = f"{self._parent}/tasks/{task_name}"
        task = {
            "name": full_name,
            "schedule_time": timestamp,
            "http_request": {
                "http_method": self._tasks_v2.HttpMethod.POST,
                "url": self._callback_url,
                "headers": {"Content-Type": "application/json"},
                "body": json.dumps(payload, separators=(",", ":")).encode("utf-8"),
                "oidc_token": {
                    "service_account_email": self._service_account_email,
                    "audience": self._audience,
                },
            },
        }
        try:
            response = self._client.create_task(parent=self._parent, task=task)
            return response.name
        except AlreadyExists:
            # Deterministic task names make a retry an acknowledged success.
            return full_name

    def ping(self) -> bool:
        self._client.get_queue(name=self._parent)
        return True


@dataclass(frozen=True)
class TaskOidcVerifier:
    audience: str | None
    service_account_email: str | None
    local_secret: str | None = None

    def verify(
        self,
        authorization: str | None,
        *,
        local_secret_header: str | None = None,
    ) -> dict[str, Any]:
        # This explicit local hook is disabled unless a separate secret is set.
        if self.local_secret and local_secret_header == self.local_secret:
            return {"email": "local-task-caller", "local": True}
        if not authorization or not authorization.lower().startswith("bearer "):
            raise AuthorizationError("missing_task_token", "Cloud Tasks OIDC token required.")
        if not self.audience or not self.service_account_email:
            raise AuthorizationError(
                "task_auth_not_configured",
                "Cloud Tasks OIDC verification is not configured.",
                status_code=503,
            )

        raw_token = authorization.split(None, 1)[1]
        try:
            from google.auth.transport.requests import Request
            from google.oauth2 import id_token

            claims = id_token.verify_oauth2_token(raw_token, Request(), self.audience)
        except Exception as exc:
            raise AuthorizationError("invalid_task_token", "Invalid Cloud Tasks OIDC token.") from exc
        issuer = claims.get("iss")
        if issuer not in {"accounts.google.com", "https://accounts.google.com"}:
            raise AuthorizationError("invalid_task_issuer", "Invalid Cloud Tasks token issuer.")
        if claims.get("email") != self.service_account_email or not claims.get(
            "email_verified", False
        ):
            raise AuthorizationError(
                "invalid_task_principal", "Unexpected Cloud Tasks service account."
            )
        return dict(claims)

