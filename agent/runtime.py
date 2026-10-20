"""Real ADK Runner execution with deliberately safe event evidence."""

from __future__ import annotations

from datetime import datetime, timezone
import time
from typing import Any, AsyncIterable, Iterable, Mapping
from uuid import uuid4

from .agent import root_agent
from .config import settings


class AgentRuntimeUnavailable(RuntimeError):
    """Raised when the deployed ADK runtime cannot be constructed."""


def _safe_match_metadata(response: Any) -> dict[str, Any]:
    if not isinstance(response, Mapping):
        return {}
    # ADK function responses commonly wrap a Python dict in ``result``.
    result = response.get("result", response)
    if not isinstance(result, Mapping):
        return {}
    selected = result.get("selected") or result.get("best")
    evidence = result.get("retrieval_evidence")
    safe: dict[str, Any] = {
        "candidate_count": result.get("candidate_count"),
        "eligible_count": result.get("eligible_count"),
        "no_match": result.get("no_match"),
    }
    if isinstance(selected, Mapping):
        safe["selected_recipient_id"] = selected.get("recipient_id")
    if isinstance(evidence, Mapping):
        safe["retrieval_evidence"] = {
            key: evidence.get(key)
            for key in (
                "provider",
                "job_id",
                "location",
                "query_label",
                "job_labels",
                "sql_fingerprint_sha256",
                "vector_search",
                "use_brute_force",
                "top_k",
                "result_count",
                "total_bytes_processed",
            )
            if evidence.get(key) is not None
        }
    return {key: value for key, value in safe.items() if value is not None}


def summarize_adk_events(events: Iterable[Any]) -> dict[str, Any]:
    """Reduce ADK events to tool names, statuses, timing, and safe metadata.

    Function arguments, prompts, model thoughts, tokens, and raw tool results
    are intentionally excluded.
    """

    traces: list[dict[str, Any]] = []
    by_call_id: dict[str, dict[str, Any]] = {}
    final_text = ""
    root_authors: set[str] = set()

    for event in events:
        author = str(getattr(event, "author", "") or "")
        if author:
            root_authors.add(author)
        timestamp = float(getattr(event, "timestamp", 0.0) or 0.0)
        get_calls = getattr(event, "get_function_calls", None)
        for call in get_calls() if callable(get_calls) else []:
            call_id = str(getattr(call, "id", "") or uuid4().hex)
            trace = {
                "agent": author or "unknown",
                "tool": str(getattr(call, "name", "") or "unknown"),
                "call_id": call_id,
                "status": "started",
                "started_at_epoch": timestamp or None,
            }
            traces.append(trace)
            by_call_id[call_id] = trace

        get_responses = getattr(event, "get_function_responses", None)
        for response in get_responses() if callable(get_responses) else []:
            call_id = str(getattr(response, "id", "") or "")
            trace = by_call_id.get(call_id)
            if trace is None:
                trace = {
                    "agent": author or "unknown",
                    "tool": str(getattr(response, "name", "") or "unknown"),
                    "call_id": call_id or "unreported",
                    "started_at_epoch": None,
                }
                traces.append(trace)
            payload = getattr(response, "response", None)
            error = isinstance(payload, Mapping) and bool(payload.get("error"))
            trace["status"] = "error" if error else "succeeded"
            if timestamp and trace.get("started_at_epoch"):
                trace["latency_ms"] = max(
                    0,
                    round((timestamp - float(trace["started_at_epoch"])) * 1000),
                )
            if trace.get("tool") == "match_surplus_offer" and not error:
                metadata = _safe_match_metadata(payload)
                if metadata:
                    trace["safe_result_metadata"] = metadata

        is_final = getattr(event, "is_final_response", None)
        if callable(is_final) and is_final():
            parts = getattr(getattr(event, "content", None), "parts", None) or []
            final_text = "".join(
                str(getattr(part, "text", "") or "")
                for part in parts
                if not bool(getattr(part, "thought", False))
            ).strip()

    match_succeeded = any(
        item.get("tool") == "match_surplus_offer"
        and item.get("status") == "succeeded"
        for item in traces
    )
    return {
        "root_agent_observed": "root_agent" in root_authors,
        "match_tool_succeeded": match_succeeded,
        "tool_trace": traces,
        "final_text": final_text,
    }


async def run_root_agent(
    prompt: str,
    *,
    user_id: str = "pantry-relay-demo",
    session_id: str | None = None,
    runner: Any | None = None,
    agent_instance: Any | None = None,
) -> dict[str, Any]:
    """Execute the root agent through an ADK Runner and return safe evidence."""

    if not prompt.strip():
        raise ValueError("prompt is required")
    selected_agent = agent_instance or root_agent
    if selected_agent is None:
        raise AgentRuntimeUnavailable("The ADK root agent is unavailable.")

    try:
        from google.adk.runners import InMemoryRunner
        from google.genai import types
    except ImportError as exc:  # pragma: no cover - deployment dependency
        raise AgentRuntimeUnavailable("google-adk is not installed.") from exc

    owns_runner = runner is None
    active_runner = runner or InMemoryRunner(
        agent=selected_agent,
        app_name=settings.app_name,
    )
    active_session_id = session_id or f"agent-proof-{uuid4().hex}"
    started = time.monotonic()
    events: list[Any] = []
    try:
        await active_runner.session_service.create_session(
            app_name=settings.app_name,
            user_id=user_id,
            session_id=active_session_id,
        )
        async for event in active_runner.run_async(
            user_id=user_id,
            session_id=active_session_id,
            new_message=types.Content(
                role="user",
                parts=[types.Part.from_text(text=prompt)],
            ),
        ):
            events.append(event)
    finally:
        if owns_runner:
            await active_runner.close()

    result = summarize_adk_events(events)
    result.update(
        {
            "runner": "google.adk.runners.InMemoryRunner",
            "session_id": active_session_id,
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }
    )
    return result


__all__ = [
    "AgentRuntimeUnavailable",
    "run_root_agent",
    "summarize_adk_events",
]
