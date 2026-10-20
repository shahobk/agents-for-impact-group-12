#!/usr/bin/env python3
"""Run the live Stage 0 ADK, vector-search, and managed-MCP proofs.

The script prints safe JSON only. It never prints credentials, model thoughts,
tool arguments, raw MCP results, or full BigQuery SQL.
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import sys


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--project",
        default=os.getenv("GOOGLE_CLOUD_PROJECT") or os.getenv("BQ_PROJECT_ID"),
        required=not bool(
            os.getenv("GOOGLE_CLOUD_PROJECT") or os.getenv("BQ_PROJECT_ID")
        ),
    )
    parser.add_argument("--dataset", default=os.getenv("BQ_DATASET", "a4i_food"))
    parser.add_argument("--location", default=os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1"))
    parser.add_argument("--skip-agent", action="store_true")
    parser.add_argument("--skip-mcp", action="store_true")
    parser.add_argument(
        "--skip-ten-match",
        action="store_true",
        help="Skip the ten real vector-match executions/equity samples.",
    )
    return parser.parse_args()


async def main() -> int:
    args = _args()
    os.environ["GOOGLE_CLOUD_PROJECT"] = args.project
    os.environ["BQ_DATASET"] = args.dataset
    os.environ["GOOGLE_CLOUD_LOCATION"] = args.location
    os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "true")
    if not args.skip_mcp:
        os.environ["ENABLE_BIGQUERY_MCP"] = "true"

    # Import only after setting configuration because Settings is immutable and
    # intentionally read once at process startup.
    from agent.matcher import match_surplus
    from agent.equity import run_bigquery_equity_audit
    from agent.proof import invoke_managed_bigquery_mcp_smoke
    from agent.runtime import run_root_agent

    now = datetime.now(timezone.utc)
    deadline = now + timedelta(hours=6)
    matcher_result = await asyncio.to_thread(
        match_surplus,
        {
            "posting_text": (
                "ten crates of refrigerated spinach that must move within six hours"
            ),
            "quantity_pallets": 1,
            "storage_state": "refrigerated",
            "requested_at": now,
            "pickup_deadline": deadline,
            "donor_latitude": 33.749,
            "donor_longitude": -84.388,
            "transport_mode": "recipient_pickup",
        },
    )
    output: dict[str, object] = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "project_id": args.project,
        "matcher": {
            "candidate_count": matcher_result["candidate_count"],
            "eligible_count": matcher_result["eligible_count"],
            "selected_recipient_id": (
                matcher_result.get("selected") or {}
            ).get("recipient_id"),
            "retrieval_evidence": matcher_result["retrieval_evidence"],
        },
    }

    if not args.skip_agent:
        prompt = (
            "Match ten crates of refrigerated spinach (1 pallet equivalent) that "
            f"must move by {deadline.isoformat()}. Donor coordinates are latitude "
            "33.749 and longitude -84.388. Recipient pickup is required and "
            "splitting is not allowed. Call match_surplus_offer before naming any "
            "recipient."
        )
        agent_result = await run_root_agent(prompt)
        final_text = agent_result.pop("final_text", "")
        agent_result["final_text_sha256"] = hashlib.sha256(
            final_text.encode("utf-8")
        ).hexdigest()
        output["adk"] = agent_result

    if not args.skip_mcp:
        output["managed_bigquery_mcp"] = await invoke_managed_bigquery_mcp_smoke()

    if not args.skip_ten_match:
        output["ten_match_equity_proof"] = await asyncio.to_thread(
            run_bigquery_equity_audit,
            project_id=args.project,
            dataset=args.dataset,
            requested_at=now,
        )

    print(json.dumps(output, indent=2, sort_keys=True))
    matcher_ok = bool(
        matcher_result["retrieval_evidence"].get("vector_search")
        and matcher_result["retrieval_evidence"].get("use_brute_force")
        and matcher_result["retrieval_evidence"].get("job_id")
    )
    agent_ok = args.skip_agent or bool(output["adk"]["match_tool_succeeded"])
    mcp_ok = args.skip_mcp or bool(output["managed_bigquery_mcp"]["ok"])
    ten_match_ok = args.skip_ten_match or bool(
        output["ten_match_equity_proof"]["ten_match_proof"]["ok"]
    )
    return 0 if matcher_ok and agent_ok and mcp_ok and ten_match_ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
