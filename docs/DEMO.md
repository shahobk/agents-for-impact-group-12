# Demo script

## 60-second flow

1. Open Pantry Relay and click **Load spinach demo**. The form fills a refrigerated offer for 10 crates of spinach with a pickup deadline six hours away in downtown Atlanta.
2. Say: “A coordinator usually has minutes—not hours—to find a safe home. Description provides semantic fit; the remaining fields are hard operational constraints.”
3. Click **Find the best handoff**. While matching, point out that the system is checking Atlanta recipients rather than generating a plausible-sounding answer.
4. On the selected card, show the fit score/explanation, capacity pass, travel estimate, remaining-time margin, and any warning. Then show the two eligible fallbacks.
5. Expand the story with the rejection list: “A semantically relevant organization can still be rejected for refrigeration, capacity, service window, or deadline.”
6. Copy the outreach message. Close with: “The coordinator gets one call to make, two backups, and a record of why the unsafe options were filtered.”

## Backup beats

- If the service is unavailable, use the visible error state to explain the thin UI/API boundary, then show a captured successful result if one is available.
- If no recipient is eligible, treat that as a safety feature: the system refuses to recommend an operationally invalid handoff and reports why.
- Before presenting, submit each case in [VALIDATION.md](./VALIDATION.md) against the deployed endpoint and keep the spinach result open in a browser tab.

## Talk-track guardrails

- Say “decision support,” not “automated dispatch.” A coordinator must verify live availability and acceptance.
- Say “estimated travel time,” not live traffic or route optimization.
- Do not describe profile prose, capacity, cold storage, or coordinates as verified ground truth; operational capability fields are generated for the demo and locations are approximate.
