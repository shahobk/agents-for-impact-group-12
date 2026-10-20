"""Real ADK Runner execution with deliberately safe event evidence."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import threading
import time
from typing import Any, AsyncIterable, Iterable, Mapping
from uuid import uuid4

from .agent import root_agent
from .config import settings


class AgentRuntimeUnavailable(RuntimeError):
    """Raised when the deployed ADK runtime cannot be constructed."""


class AgentMatchUnavailable(AgentRuntimeUnavailable):
    """Raised when an ADK run does not return a successful matcher tool result."""


_shared_runner: Any | None = None
_shared_runner_lock = threading.Lock()


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


def _extract_match_result(events: Iterable[Any]) -> dict[str, Any] | None:
    """Extract the transient tool result; callers must not persist it wholesale."""
    match_result: dict[str, Any] | None = None
    for event in events:
        get_responses = getattr(event, "get_function_responses", None)
        for response in get_responses() if callable(get_responses) else []:
            if str(getattr(response, "name", "") or "") != "match_surplus_offer":
                continue
            payload = getattr(response, "response", None)
            if not isinstance(payload, Mapping) or payload.get("error"):
                continue
            result = payload.get("result", payload)
            if isinstance(result, Mapping):
                match_result = dict(result)
    return match_result


async def _execute_root_agent(
    prompt: str,
    *,
    user_id: str,
    session_id: str | None,
    runner: Any | None,
    agent_instance: Any | None,
) -> tuple[list[Any], dict[str, Any]]:
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

    global _shared_runner
    owns_runner = runner is None and agent_instance is not None
    uses_shared_runner = runner is None and agent_instance is None
    if uses_shared_runner:
        with _shared_runner_lock:
            if _shared_runner is None:
                _shared_runner = InMemoryRunner(
                    agent=selected_agent,
                    app_name=settings.app_name,
                )
        active_runner = _shared_runner
    else:
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
        elif uses_shared_runner:
            # Keep the runner/toolsets alive across offers, but discard prompt
            # and event history once safe evidence has been extracted.
            try:
                await active_runner.session_service.delete_session(
                    app_name=settings.app_name,
                    user_id=user_id,
                    session_id=active_session_id,
                )
            except Exception:
                # Session cleanup must not replace a completed matcher result.
                pass
    return events, {
        "runner": "google.adk.runners.InMemoryRunner",
        "session_id": active_session_id,
        "elapsed_ms": round((time.monotonic() - started) * 1000),
        "completed_at": datetime.now(timezone.utc).isoformat(),
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

    events, execution = await _execute_root_agent(
        prompt,
        user_id=user_id,
        session_id=session_id,
        runner=runner,
        agent_instance=agent_instance,
    )

    result = summarize_adk_events(events)
    result.update(execution)
    return result


async def match_offer_via_root_agent(
    description: str,
    quantity_pallets: float,
    storage_state: str,
    pickup_deadline: str,
    donor_latitude: float,
    donor_longitude: float,
    split_allowed: bool = False,
    transport_mode: str | None = None,
    donor_delivery_radius_km: float | None = None,
    *,
    user_id: str = "pantry-relay-workflow",
    session_id: str | None = None,
    runner: Any | None = None,
    agent_instance: Any | None = None,
) -> dict[str, Any]:
    """Run root_agent and return its matcher result plus an allowlisted trace.

    The generated prompt and raw ADK/model events remain transient. Workflow
    persistence consumes the structured match and ``_agent_trace`` separately.
    """
    payload = {
        "description": description,
        "quantity_pallets": quantity_pallets,
        "storage_state": storage_state,
        "pickup_deadline": pickup_deadline,
        "donor_latitude": donor_latitude,
        "donor_longitude": donor_longitude,
        "split_allowed": split_allowed,
        "transport_mode": transport_mode,
        "donor_delivery_radius_km": donor_delivery_radius_km,
    }
    prompt = (
        "Call match_surplus_offer exactly once with this reviewed offer JSON. "
        "Use the deterministic tool result as authoritative and do not change "
        f"eligibility: {json.dumps(payload, separators=(',', ':'), sort_keys=True)}"
    )
    events, execution = await _execute_root_agent(
        prompt,
        user_id=user_id,
        session_id=session_id or f"workflow-match-{uuid4().hex}",
        runner=runner,
        agent_instance=agent_instance,
    )
    summary = summarize_adk_events(events)
    result = _extract_match_result(events)
    if result is None or not summary.get("match_tool_succeeded"):
        raise AgentMatchUnavailable(
            "The ADK root agent did not return a successful match_surplus_offer result."
        )
    match_trace = next(
        (
            trace
            for trace in summary.get("tool_trace", [])
            if trace.get("tool") == "match_surplus_offer"
            and trace.get("status") == "succeeded"
        ),
        {},
    )
    safe_metadata = match_trace.get("safe_result_metadata") or {}
    result["_agent_trace"] = {
        "runner": execution["runner"],
        "session_id": execution["session_id"],
        "root_agent_observed": bool(summary.get("root_agent_observed")),
        "tool_name": "match_surplus_offer",
        "status": "succeeded",
        "latency_ms": match_trace.get("latency_ms"),
        "elapsed_ms": execution["elapsed_ms"],
        "completed_at": execution["completed_at"],
        "retrieval_evidence": dict(safe_metadata.get("retrieval_evidence") or {}),
    }
    return result


__all__ = [
    "AgentMatchUnavailable",
    "AgentRuntimeUnavailable",
    "match_offer_via_root_agent",
    "run_root_agent",
    "summarize_adk_events",
]
