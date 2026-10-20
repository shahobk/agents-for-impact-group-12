"""Protected dependency proof helpers for readiness and judge evidence."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from types import SimpleNamespace
from typing import Any, Mapping

from .agent import _build_bigquery_mcp_toolset, _load_matcher, root_agent
from .config import settings
from .matcher import check_bigquery_readiness


_MCP_CACHE_TTL_SECONDS = 300.0
_mcp_cache: tuple[float, dict[str, Any]] | None = None
_mcp_lock: asyncio.Lock | None = None


class _DirectToolContext:
    """Minimum context required by an ADK MCP tool for a server-side call."""

    def __init__(self) -> None:
        self._invocation_context = SimpleNamespace()
        self.tool_confirmation = None
        self.custom_metadata: dict[str, Any] = {}


def _result_digest(value: Any) -> tuple[str, int]:
    rendered = json.dumps(value, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(rendered.encode("utf-8")).hexdigest(), len(rendered)


async def invoke_managed_bigquery_mcp_smoke(
    *,
    project_id: str | None = None,
    toolset: Any | None = None,
) -> dict[str, Any]:
    """Call the protected managed ``list_dataset_ids`` tool.

    Listing tool specifications is public and is not accepted as proof. This
    function invokes ``tools/call`` through ADK's managed MCP wrapper with ADC,
    then returns only safe metadata and a digest of the result.
    """

    project = project_id or settings.google_cloud_project
    if not project:
        return {"ok": False, "reason": "project_not_configured"}

    owns_toolset = toolset is None
    active_toolset = toolset or _build_bigquery_mcp_toolset()
    if active_toolset is None:
        return {"ok": False, "reason": "managed_mcp_not_enabled_or_unavailable"}

    started = time.monotonic()
    try:
        tools = await active_toolset.get_tools()
        by_name = {item.name: item for item in tools}
        tool = by_name.get("list_dataset_ids")
        if tool is None:
            return {
                "ok": False,
                "reason": "required_readonly_tool_not_advertised",
                "advertised_tool_names": sorted(by_name),
            }
        result = await tool.run_async(
            args={"projectId": project, "pageSize": 10},
            tool_context=_DirectToolContext(),
        )
        digest, result_bytes = _result_digest(result)
        is_error = isinstance(result, Mapping) and bool(
            result.get("isError", result.get("is_error", False))
        )
        return {
            "ok": not is_error,
            "server": "bigquery.googleapis.com/mcp",
            "tool_name": "list_dataset_ids",
            "protected_tool_call": True,
            "read_only": True,
            "project_id": project,
            "advertised_tool_count": len(tools),
            "result_sha256": digest,
            "result_bytes": result_bytes,
            "latency_ms": round((time.monotonic() - started) * 1000),
        }
    except Exception as exc:
        # Exception text can contain request or backend details. A class name is
        # enough for readiness and logs while keeping the response safe.
        return {
            "ok": False,
            "server": "bigquery.googleapis.com/mcp",
            "tool_name": "list_dataset_ids",
            "protected_tool_call": True,
            "reason": type(exc).__name__,
            "latency_ms": round((time.monotonic() - started) * 1000),
        }
    finally:
        if owns_toolset:
            await active_toolset.close()


async def cached_managed_mcp_readiness(*, force: bool = False) -> dict[str, Any]:
    """Return a short-lived cached result of the real protected MCP call."""

    global _mcp_cache, _mcp_lock
    now = time.monotonic()
    if not force and _mcp_cache and now - _mcp_cache[0] < _MCP_CACHE_TTL_SECONDS:
        return dict(_mcp_cache[1]) | {"cached": True}
    if _mcp_lock is None:
        _mcp_lock = asyncio.Lock()
    async with _mcp_lock:
        now = time.monotonic()
        if not force and _mcp_cache and now - _mcp_cache[0] < _MCP_CACHE_TTL_SECONDS:
            return dict(_mcp_cache[1]) | {"cached": True}
        result = await invoke_managed_bigquery_mcp_smoke()
        _mcp_cache = (time.monotonic(), dict(result))
        return dict(result) | {"cached": False}


async def check_agent_dependencies(
    *,
    require_mcp: bool | None = None,
    force_mcp: bool = False,
) -> dict[str, Any]:
    """Dependency-aware result suitable for a protected ``/readyz`` route."""

    mcp_required = settings.enable_bigquery_mcp if require_mcp is None else require_mcp
    try:
        _load_matcher()
        matcher_loadable = True
    except Exception:
        matcher_loadable = False
    bigquery = await asyncio.to_thread(check_bigquery_readiness)
    mcp = (
        await cached_managed_mcp_readiness(force=force_mcp)
        if mcp_required
        else {"ok": True, "enabled": False, "required": False}
    )
    checks = {
        "root_agent_constructed": root_agent is not None,
        "matcher_loadable": matcher_loadable,
        "bigquery": bigquery,
        "managed_bigquery_mcp": mcp,
    }
    ready = bool(
        checks["root_agent_constructed"]
        and checks["matcher_loadable"]
        and bigquery.get("ok")
        and (not mcp_required or mcp.get("ok"))
    )
    return {"status": "ready" if ready else "not_ready", "checks": checks}


__all__ = [
    "cached_managed_mcp_readiness",
    "check_agent_dependencies",
    "invoke_managed_bigquery_mcp_smoke",
]
