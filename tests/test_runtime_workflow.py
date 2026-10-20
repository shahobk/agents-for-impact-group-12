from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from functools import partial

from google.adk.events import Event
from google.genai import types
import pytest

from agent.auth import TokenAuthority
from agent.locations import RouteEstimator
from agent.repository import InMemoryWorkflowRepository
from agent.runtime import match_offer_via_root_agent
from agent.tasks import InMemoryTaskScheduler
from agent.workflow import WorkflowError, WorkflowService


NOW = datetime(2026, 10, 20, 16, 0, tzinfo=timezone.utc)


class _SessionService:
    def __init__(self) -> None:
        self.created = []

    async def create_session(self, **kwargs):
        self.created.append(kwargs)


class _Runner:
    def __init__(self, events) -> None:
        self.session_service = _SessionService()
        self.events = events
        self.runs = []

    async def run_async(self, **kwargs):
        self.runs.append(kwargs)
        for event in self.events:
            yield event


def _events(*, include_match: bool = True):
    if not include_match:
        return [
            Event(
                invocation_id="invocation-failed",
                author="root_agent",
                timestamp=1.0,
                content=types.Content(
                    role="model", parts=[types.Part.from_text(text="No tool call")]
                ),
            )
        ]
    call = types.FunctionCall(
        id="workflow-call",
        name="match_surplus_offer",
        args={"description": "transient prompt content"},
    )
    response = types.FunctionResponse(
        id="workflow-call",
        name="match_surplus_offer",
        response={
            "result": {
                "selected": {
                    "recipient_id": "adk-recipient",
                    "name": "ADK Community Pantry",
                    "max_pallets": 5,
                    "cold_storage": True,
                    "latitude": 33.76,
                    "longitude": -84.37,
                    "distance_miles": 1.5,
                },
                "fallbacks": [],
                "rejections": [],
                "warnings": [],
                "retrieval_evidence": {
                    "provider": "bigquery",
                    "job_id": "workflow-job-123",
                    "query_label": "pantry_relay_vector_search",
                    "vector_search": True,
                    "use_brute_force": True,
                    "secret": "raw-tool-secret",
                },
                "raw_private_field": "raw-tool-response-must-not-persist",
            }
        },
    )
    return [
        Event(
            invocation_id="invocation-success",
            author="root_agent",
            timestamp=1.0,
            content=types.Content(role="model", parts=[types.Part(function_call=call)]),
        ),
        Event(
            invocation_id="invocation-success",
            author="root_agent",
            timestamp=1.125,
            content=types.Content(
                role="user", parts=[types.Part(function_response=response)]
            ),
        ),
    ]


def _payload():
    return {
        "description": "ten crates of refrigerated spinach",
        "quantity_original": "10 crates",
        "quantity_pallets": 1,
        "storage_state": "refrigerated",
        "pickup_deadline": (NOW + timedelta(hours=6)).isoformat(),
        "donor_latitude": 33.749,
        "donor_longitude": -84.388,
        "pickup_address": "Atlanta demo grocery",
        "location_source": "address",
        "transport_mode": "recipient_pickup",
    }


def test_create_offer_traverses_adk_runner_and_persists_only_safe_trace():
    runner = _Runner(_events())
    matcher = partial(
        match_offer_via_root_agent,
        runner=runner,
        agent_instance=object(),
        session_id="safe-workflow-session",
    )
    repo = InMemoryWorkflowRepository()
    workflow = WorkflowService(
        repo,
        TokenAuthority("pepper", "ops-token"),
        InMemoryTaskScheduler(),
        matcher=matcher,
        route_estimator=RouteEstimator(),
        demo_mode=True,
        demo_fallback=False,
    )

    created = asyncio.run(
        workflow.create_offer(_payload(), idempotency_key="adk-create", now=NOW)
    )

    assert len(runner.session_service.created) == 1
    assert len(runner.runs) == 1
    state = repo.snapshot()
    offer = state["offers"][created["offer_id"]]
    assert offer["match_evidence"]["job_id"] == "workflow-job-123"
    assert offer["agent_trace"] == {
        "runner": "google.adk.runners.InMemoryRunner",
        "session_id": "safe-workflow-session",
        "root_agent_observed": True,
        "tool_name": "match_surplus_offer",
        "status": "succeeded",
        "latency_ms": 125,
        "elapsed_ms": offer["agent_trace"]["elapsed_ms"],
        "completed_at": offer["agent_trace"]["completed_at"],
        "retrieval_evidence": offer["match_evidence"],
    }
    rendered = str(state)
    assert "raw-tool-secret" not in rendered
    assert "raw-tool-response-must-not-persist" not in rendered
    assert "transient prompt content" not in rendered


def test_missing_adk_match_tool_result_fails_safely_without_persistence():
    runner = _Runner(_events(include_match=False))
    matcher = partial(
        match_offer_via_root_agent,
        runner=runner,
        agent_instance=object(),
        session_id="failed-workflow-session",
    )
    repo = InMemoryWorkflowRepository()
    workflow = WorkflowService(
        repo,
        TokenAuthority("pepper", "ops-token"),
        InMemoryTaskScheduler(),
        matcher=matcher,
        demo_mode=True,
        demo_fallback=False,
    )

    with pytest.raises(WorkflowError) as failure:
        asyncio.run(
            workflow.create_offer(_payload(), idempotency_key="adk-fail", now=NOW)
        )

    assert failure.value.code == "matcher_unavailable"
    assert failure.value.status_code == 503
    assert repo.snapshot()["offers"] == {}
