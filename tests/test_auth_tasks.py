import base64
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json

import pytest

from agent.auth import AuthorizationError, TokenAuthority
from agent.config import Settings
from agent.repository import empty_state
from agent.tasks import InMemoryTaskScheduler, TaskOidcVerifier


NOW = datetime(2026, 10, 20, 12, tzinfo=timezone.utc)


def test_secret_backed_settings_ignore_transport_newlines(monkeypatch):
    monkeypatch.setenv("COORDINATOR_TOKEN", "coordinator-secret\n")
    monkeypatch.setenv("TOKEN_PEPPER", "pepper-secret\n")

    loaded = Settings.from_env()

    assert loaded.coordinator_token == "coordinator-secret"
    assert loaded.token_pepper == "pepper-secret"


def test_opaque_token_scope_expiry_and_raw_secret_not_stored():
    state = empty_state()
    authority = TokenAuthority("pepper", "coordinator")
    raw = authority.issue(
        state,
        actor_type="recipient",
        actor_id="r1",
        offer_id="o1",
        actions=["offer:claim"],
        ttl=timedelta(minutes=5),
        now=NOW,
    )
    assert len(raw) >= 43
    assert raw not in str(state)
    assert authority.authenticate(state, raw, action="offer:claim", offer_id="o1", now=NOW)["actor_id"] == "r1"

    with pytest.raises(AuthorizationError) as scope:
        authority.authenticate(state, raw, action="offer:complete", offer_id="o1", now=NOW)
    assert scope.value.status_code == 403
    with pytest.raises(AuthorizationError) as expired:
        authority.authenticate(state, raw, action="offer:claim", offer_id="o1", now=NOW + timedelta(minutes=5))
    assert expired.value.code == "expired_bearer_token"


def test_demo_coordinator_session_expiry_tamper_and_scope():
    authority = TokenAuthority("pepper", "coordinator")
    session = authority.issue_coordinator_session(
        ttl=timedelta(minutes=5), now=NOW
    )

    assert authority.authenticate_coordinator_session(session, now=NOW) == {
        "actor_type": "coordinator",
        "actor_id": "demo-coordinator",
    }
    with pytest.raises(AuthorizationError) as expired:
        authority.authenticate_coordinator_session(
            session, now=NOW + timedelta(minutes=5)
        )
    assert expired.value.code == "expired_demo_session"

    with pytest.raises(AuthorizationError) as tampered:
        authority.authenticate_coordinator_session(session[:-1] + "0", now=NOW)
    assert tampered.value.code == "invalid_demo_session"

    version, encoded, _signature = session.split(".", 2)
    padding = "=" * (-len(encoded) % 4)
    payload = json.loads(base64.urlsafe_b64decode(encoded + padding))
    payload["scope"] = "recipient"
    scoped_encoded = base64.urlsafe_b64encode(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).rstrip(b"=").decode()
    signing_input = f"{version}.{scoped_encoded}"
    signature = hmac.new(
        b"pepper",
        f"demo-session:{signing_input}".encode(),
        hashlib.sha256,
    ).hexdigest()
    with pytest.raises(AuthorizationError) as scope:
        authority.authenticate_coordinator_session(
            f"{signing_input}.{signature}", now=NOW
        )
    assert scope.value.code == "insufficient_demo_session_scope"
    assert scope.value.status_code == 403


def test_in_memory_tasks_are_deterministic_and_already_exists_is_success():
    scheduler = InMemoryTaskScheduler()
    first = scheduler.schedule(task_name="expire-o1-1", run_at=NOW.isoformat(), payload={"version": 1})
    second = scheduler.schedule(task_name="expire-o1-1", run_at=(NOW + timedelta(hours=1)).isoformat(), payload={"version": 2})
    assert first == second == "expire-o1-1"
    assert len(scheduler.tasks) == 1
    assert scheduler.tasks[first]["payload"] == {"version": 1}


def test_task_callback_local_secret_is_explicitly_opt_in():
    verifier = TaskOidcVerifier(None, None, local_secret="test-task-secret")
    assert verifier.verify(None, local_secret_header="test-task-secret")["local"] is True
    with pytest.raises(AuthorizationError) as error:
        TaskOidcVerifier(None, None, local_secret=None).verify(None)
    assert error.value.code == "missing_task_token"

