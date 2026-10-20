from __future__ import annotations

import asyncio

from google.adk.events import Event
from google.genai import types

from agent.equity import summarize_equity_audit
from agent.proof import invoke_managed_bigquery_mcp_smoke
from agent.runtime import summarize_adk_events


def test_adk_event_summary_proves_root_match_call_without_arguments_or_raw_result() -> None:
    call = types.FunctionCall(
        id="call-1",
        name="match_surplus_offer",
        args={"description": "secret donor text", "donor_latitude": 33.75},
    )
    response = types.FunctionResponse(
        id="call-1",
        name="match_surplus_offer",
        response={
            "result": {
                "candidate_count": 30,
                "eligible_count": 3,
                "selected": {"recipient_id": "recipient-7", "profile_text": "private"},
                "retrieval_evidence": {
                    "provider": "bigquery",
                    "job_id": "job-123",
                    "query_label": "pantry_relay_vector_search",
                    "sql_fingerprint_sha256": "a" * 64,
                    "vector_search": True,
                    "use_brute_force": True,
                },
                "raw_private_field": "do-not-expose",
            }
        },
    )
    events = [
        Event(
            invocation_id="invocation-1",
            author="root_agent",
            timestamp=1,
            content=types.Content(role="model", parts=[types.Part(function_call=call)]),
        ),
        Event(
            invocation_id="invocation-1",
            author="root_agent",
            timestamp=1.125,
            content=types.Content(
                role="user", parts=[types.Part(function_response=response)]
            ),
        ),
        Event(
            invocation_id="invocation-1",
            author="root_agent",
            timestamp=1.2,
            content=types.Content(
                role="model", parts=[types.Part.from_text(text="Three recipients qualify.")]
            ),
        ),
    ]

    summary = summarize_adk_events(events)

    assert summary["root_agent_observed"] is True
    assert summary["match_tool_succeeded"] is True
    trace = summary["tool_trace"][0]
    assert trace["status"] == "succeeded"
    assert trace["latency_ms"] == 125
    assert trace["safe_result_metadata"]["selected_recipient_id"] == "recipient-7"
    rendered = str(summary)
    assert "secret donor text" not in rendered
    assert "do-not-expose" not in rendered
    assert "private" not in rendered


class _FakeMcpTool:
    name = "list_dataset_ids"

    def __init__(self) -> None:
        self.called = False

    async def run_async(self, *, args, tool_context):
        assert args == {"projectId": "project-1", "pageSize": 10}
        assert tool_context.tool_confirmation is None
        self.called = True
        return {"content": [{"type": "text", "text": "dataset-a"}], "isError": False}


class _FakeToolset:
    def __init__(self) -> None:
        self.tool = _FakeMcpTool()
        self.closed = False

    async def get_tools(self):
        return [self.tool]

    async def close(self):
        self.closed = True


def test_managed_mcp_smoke_invokes_protected_readonly_tool_and_redacts_result() -> None:
    toolset = _FakeToolset()

    result = asyncio.run(
        invoke_managed_bigquery_mcp_smoke(project_id="project-1", toolset=toolset)
    )

    assert result["ok"] is True
    assert result["protected_tool_call"] is True
    assert result["tool_name"] == "list_dataset_ids"
    assert result["read_only"] is True
    assert len(result["result_sha256"]) == 64
    assert toolset.tool.called is True
    # Caller-owned toolsets remain open for reuse by the ADK root agent.
    assert toolset.closed is False
    assert "dataset-a" not in str(result)


def test_equity_audit_counts_tract_evidence_and_explicit_fallbacks() -> None:
    audit = summarize_equity_audit(
        [
            {
                "posting_id": 1,
                "selected_recipient_id": "recipient-1",
                "tract_geo_id": "13001000100",
                "poverty_rate": 0.2,
                "no_vehicle_rate": 0.1,
                "need_evidence_source": (
                    "nearest_census_tract_to_approximate_zip_centroid"
                ),
            },
            {
                "posting_id": 2,
                "selected_recipient_id": "recipient-2",
                "tract_geo_id": None,
                "poverty_rate": None,
                "no_vehicle_rate": None,
                "need_evidence_source": "weekly_households_fallback",
            },
        ],
        expected_postings=2,
    )

    assert audit["status"] == "complete"
    assert audit["matched_postings"] == 2
    assert audit["tract_evidence_count"] == 1
    assert audit["weekly_households_fallback_count"] == 1
    assert audit["selected_mean_poverty_rate"] == 0.2

