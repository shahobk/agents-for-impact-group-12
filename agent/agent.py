"""Google ADK agent and custom food-rescue matching tool.

The custom tool is intentionally usable without ADK installed. This lets the HTTP
service and unit tests exercise the deterministic matcher without requiring model
credentials. ADK and the managed BigQuery MCP connection are added when their
packages and opt-in configuration are available.
"""

from __future__ import annotations

import asyncio
from dataclasses import asdict, is_dataclass
from datetime import datetime
import importlib
import inspect
import logging
from typing import Any, Callable, Mapping

from .config import settings

logger = logging.getLogger(__name__)


class MatcherUnavailableError(RuntimeError):
    """Raised when the configured matcher cannot be loaded."""


def _load_matcher(path: str | None = None) -> Callable[..., Any]:
    dotted_path = path or settings.matcher_provider
    module_name, separator, attribute_name = dotted_path.partition(":")
    if not separator or not module_name or not attribute_name:
        raise MatcherUnavailableError(
            "MATCHER_PROVIDER must use the form 'module.path:callable'."
        )

    try:
        module = importlib.import_module(module_name)
        matcher = getattr(module, attribute_name)
    except (ImportError, AttributeError) as exc:
        raise MatcherUnavailableError("The matching provider is not available.") from exc

    if not callable(matcher):
        raise MatcherUnavailableError("The configured matching provider is not callable.")
    return matcher


def _plain_result(result: Any) -> dict[str, Any]:
    if isinstance(result, Mapping):
        return dict(result)
    if hasattr(result, "model_dump"):
        return dict(result.model_dump(mode="json"))
    if is_dataclass(result):
        return asdict(result)
    raise TypeError("The matching provider returned an unsupported result type.")


async def _invoke_matcher(payload: dict[str, Any]) -> dict[str, Any]:
    matcher = _load_matcher()
    if inspect.iscoroutinefunction(matcher):
        result = await matcher(payload)
    else:
        # BigQuery's Python client is synchronous; keep its network wait off the
        # FastAPI/ADK event loop.
        result = await asyncio.to_thread(matcher, payload)
    if inspect.isawaitable(result):
        result = await result
    return _plain_result(result)


def _draft_outreach(
    *,
    recipient: Mapping[str, Any] | None,
    description: str,
    quantity_pallets: float,
    storage_state: str,
    pickup_deadline: str,
) -> str | None:
    if not recipient:
        return None
    name = recipient.get("name") or "your team"
    quantity_label = f"{quantity_pallets:g} pallet"
    if quantity_pallets != 1:
        quantity_label += "s"
    return (
        f"Hello {name} — we have {description} (about {quantity_label}) available "
        f"for pickup by {pickup_deadline}. It requires {storage_state} handling. "
        "Your current profile appears operationally eligible. Can you confirm live "
        "capacity and pickup availability?"
    )


async def match_surplus_offer(
    description: str,
    quantity_pallets: float,
    storage_state: str,
    pickup_deadline: str,
    donor_latitude: float,
    donor_longitude: float,
    split_allowed: bool = False,
    transport_mode: str | None = None,
    donor_delivery_radius_km: float | None = None,
) -> dict[str, Any]:
    """Find operationally eligible recipients for a surplus food offer.

    Args:
        description: Plain-language description of the available food.
        quantity_pallets: Estimated load size in pallet equivalents.
        storage_state: Required storage: ambient, refrigerated, or frozen.
        pickup_deadline: Timezone-aware ISO-8601 deadline for collection.
        donor_latitude: Donor pickup latitude.
        donor_longitude: Donor pickup longitude.
        split_allowed: Whether the load may be divided among recipients.
        transport_mode: recipient_pickup, donor_delivery, or transportation_needed.
        donor_delivery_radius_km: Donor delivery radius, greater than zero and at most 5.

    Returns:
        A match brief with one selected recipient, fallbacks, deterministic
        rejections, warnings, and an outreach message.
    """
    # Validate the timestamp enough to give direct ADK tool calls the same basic
    # guardrail as the FastAPI route. The matcher remains the source of truth for
    # feasibility and never delegates eligibility decisions to the LLM.
    deadline = datetime.fromisoformat(pickup_deadline.replace("Z", "+00:00"))
    if deadline.tzinfo is None or deadline.utcoffset() is None:
        raise ValueError("pickup_deadline must include a timezone offset")

    payload = {
        "posting_text": description,
        "quantity_pallets": quantity_pallets,
        "storage_state": storage_state,
        "pickup_deadline": deadline,
        "donor_latitude": donor_latitude,
        "donor_longitude": donor_longitude,
        "split_allowed": split_allowed,
    }
    if transport_mode is not None:
        payload["transport_mode"] = transport_mode
    if donor_delivery_radius_km is not None:
        payload["donor_delivery_radius_km"] = donor_delivery_radius_km
    result = await _invoke_matcher(payload)
    selected = result.get("selected", result.get("best"))
    result.setdefault("selected", selected)
    result.setdefault(
        "outreach",
        _draft_outreach(
            recipient=selected,
            description=description,
            quantity_pallets=quantity_pallets,
            storage_state=storage_state,
            pickup_deadline=pickup_deadline,
        ),
    )
    return result


def _build_bigquery_mcp_toolset() -> Any | None:
    """Create the opt-in managed BigQuery MCP toolset.

    Authentication is deliberately attempted only when ENABLE_BIGQUERY_MCP=true.
    Cloud Run can then use Application Default Credentials, while local service
    startup remains credential-free by default.
    """
    if not settings.enable_bigquery_mcp:
        return None

    try:
        import google.auth
        from google.auth.transport.requests import Request
        from google.adk.tools.mcp_tool import (
            McpToolset,
            StreamableHTTPConnectionParams,
        )

        credentials, detected_project = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        project = settings.google_cloud_project or detected_project

        def auth_headers(_context: Any) -> dict[str, str]:
            if not credentials.valid or credentials.expired:
                credentials.refresh(Request())
            headers = {
                "Authorization": f"Bearer {credentials.token}",
                "Accept": "application/json, text/event-stream",
            }
            if project:
                headers["x-goog-user-project"] = project
            return headers

        return McpToolset(
            connection_params=StreamableHTTPConnectionParams(
                url=settings.bigquery_mcp_url,
            ),
            header_provider=auth_headers,
        )
    except Exception:  # MCP is an optional enhancement, never a startup gate.
        logger.exception("BigQuery MCP was enabled but could not be configured")
        return None


def _build_root_agent() -> Any | None:
    try:
        from google.adk.agents import Agent
    except ImportError:
        logger.info("google-adk is not installed; root_agent is unavailable")
        return None

    tools: list[Any] = [match_surplus_offer]
    bigquery_toolset = _build_bigquery_mcp_toolset()
    if bigquery_toolset is not None:
        tools.append(bigquery_toolset)

    return Agent(
        # The stable name makes exported ADK events unambiguous evidence of
        # root_agent -> match_surplus_offer rather than an app-name alias.
        name="root_agent",
        model=settings.agent_model,
        description="Matches Atlanta grocery surplus with eligible recipients.",
        instruction=(
            "You are an Atlanta food-rescue coordinator. Clarify any missing load "
            "size, storage state, pickup deadline, donor coordinates, or split "
            "preference. Respect recipient pickup, donor delivery (never more "
            "than 5 km), and transportation-needed as deterministic inputs. "
            "Always call match_surplus_offer before recommending a "
            "recipient. Treat the tool's deterministic eligibility checks as "
            "authoritative: never recommend a rejected recipient or invent live "
            "capacity. Explain the selected match, mention material warnings and "
            "fallbacks, and provide the tool's ready-to-send outreach copy. State "
            "that availability must still be confirmed with the recipient."
        ),
        tools=tools,
    )


root_agent = _build_root_agent()
