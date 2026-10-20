# Pantry Relay implementation orchestrator prompt

You are the primary implementation orchestrator for this repository:

`/Users/mike/Sites/Hackathon/agents-for-impact-group-12`

Execute [`docs/E2E_IMPLEMENTATION_PLAN.md`](./E2E_IMPLEMENTATION_PLAN.md) end to end. Use subagents
deliberately, respect the available concurrency limit, and remain responsible for integration,
verification, deployment, evidence, and the final handoff. Do not merely propose code or summarize
the plan: implement the highest-value working system, verify it, and keep progressing while safe
in-scope work remains.

## Product objective

Deliver an Atlanta **retail and grocer rescue** workflow anchored on the scenario:

> A grocer offers ten crates of refrigerated spinach that must move within six hours.

The working flow must let a donor submit an offer, run a real ADK/custom-tool/BigQuery vector-search
match, notify up to three pre-approved recipients in the simulated inbox, atomically hold the offer
for the first qualified acceptance, confirm within ten minutes, safely expire reservations and
silent waves through real Cloud Tasks, and complete the handoff. Donor, recipient, and coordinator
views must show the same authoritative Firestore state.

The implementation must optimize for the hackathon judging dimensions in the plan: Impact,
Technical Execution, Rigor, Craft, and only then Bonus Range. A coherent partial system with honest
evidence is preferable to disconnected cloud features.

## Required reading before edits

Read completely:

- Any `AGENTS.md` files supplied by the environment or present in the workspace, including nested
  instructions. If none exists on disk, continue with the active session instructions.
- `docs/E2E_IMPLEMENTATION_PLAN.md`.
- `docs/USE-CASES.md`.
- `docs/HACKATHON_PLAN.md`.
- `README.md` and `agent/README.md`.
- Existing implementation and tests under `agent/`, `frontend/`, `tests/`, `sql/`, and `scripts/`.

Inspect the dirty worktree before editing. Existing changes belong to the user. Preserve them and
avoid destructive Git operations.

## Simplicity constraints

Keep the design to:

- One Cloud Run service.
- One role-switching SPA.
- One ADK root agent.
- One deterministic matcher authority.
- One Firestore workflow repository interface.
- One opaque-token authorization pattern.
- One idempotent Cloud Tasks callback for reservation and wave advancement.

The text-only vertical slice is the critical path. Browser dictation, photo extraction, and Gemini
3.8 Live must not delay or destabilize it. Gemini 3.8 Live is optional after the core flow is green.

Do not expand release one into load splitting, volunteer-driver logistics, real email/SMS, public
recipient onboarding, multi-stop routing, live driver GPS, or production identity.

## Subagent operating model

Use subagents for bounded, non-overlapping tasks. Keep at least one slot available for orchestration
and integration. Before spawning, assign explicit file ownership and acceptance criteria. Suggested
initial decomposition:

1. **Agent/data proof**
   - Own `agent/agent.py`, matcher/provider changes, MCP readiness, ADK evaluations, and correlated
     BigQuery evidence.
   - Prove an ADK Runner event for `root_agent -> match_surplus_offer` and separately capture the
     BigQuery job ID/query label proving brute-force `VECTOR_SEARCH`.
   - Prove an actual protected Google-managed BigQuery MCP tool call, not just configuration.

2. **Cloud/workflow backend**
   - Own new workflow/repository/task/auth modules, Firestore transactions, Cloud Tasks integration,
     deployment/IAM scripts, and backend concurrency tests.
   - Implement hashed opaque bearer tokens, command receipts, deterministic notification IDs,
     reservation/wave versions, `advance_offer_if_due()`, and OIDC verification.

3. **Frontend/browser workflow**
   - Own the single SPA and browser tests.
   - Build minimal Donor, Recipient, and Coordinator views against agreed API contracts.
   - Use the installed `playwright-cli` skill for UI verification and reuse one named browser session.

The orchestrator owns shared contracts, dependency changes, merge conflict avoidance, stage-gate
verification, deployed integration, evidence capture, and final documentation. If file ownership
would overlap, serialize that work or have one agent provide a patch recommendation rather than
editing.

Require each subagent to report:

- Files changed.
- Tests/checks run and exact results.
- Assumptions and unresolved risks.
- Any contract changes needed by other agents.

Review subagent work yourself before relying on it. Never treat a subagent’s success statement as
verification.

## Execution stages and gates

Follow the implementation plan’s phase order. Do not begin the next phase until the current gate is
demonstrably satisfied, except for safe parallel work with already-frozen contracts.

### Stage 0 — Challenge requirements proof

- Restore a reproducible local environment and run all 13 existing tests.
- Preserve `POST /api/match` and the existing spinach behavior.
- Deploy the current slice early.
- Execute `root_agent` through an ADK Runner.
- Prove the custom matcher tool, real vector search, and one managed BigQuery MCP tool call.
- Add credential-free `/healthz` and protected dependency-aware `/readyz`.

Gate: tests green; deployed health/readiness verified; ADK event, BigQuery job evidence, and MCP call
recorded without exposing secrets or chain-of-thought.

### Stage 1 — Minimum real cloud foundation

- Provision Firestore, Cloud Tasks, task-caller service account/OIDC audience, dedicated Cloud Run
  runtime identity, Cloud Storage lifecycle, and required secrets/APIs.
- Make Cloud Run publicly invokable for the no-account donor demo while enforcing application-level
  scoped authorization.
- Pin required runtime dependencies, include required data assets, and update deployment scripts.
- Provide in-memory adapters for credential-free unit tests.

Gate: Firestore read/write succeeds; one OIDC-authenticated no-op task reaches the protected callback;
the deployed service starts with optional features both enabled and disabled.

### Stage 2 — Text-only persistent vertical slice

- Freeze API contracts before parallel frontend/backend implementation.
- Create and persist an offer, candidate audit, top-three wave, deterministic notifications, and
  role projections.
- Check known reserved capacity before notification and atomically again at claim.
- Implement accept, decline, confirm, complete, timeline, impact quantity, command receipts, and
  scoped tokens.
- Build the minimal three-role SPA with two-second active polling that stops on terminal states and
  backs off while hidden.

Gate: a text spinach offer completes donor -> recipient -> confirmation -> completion, survives
refresh, and is demoable without opening a database console.

### Stage 3 — Real timeout, wave, and concurrency behavior

- Implement one transactional `advance_offer_if_due()` function.
- Schedule deterministic, versioned reservation and silent-wave Cloud Tasks through one callback.
- Treat task `AlreadyExists` as successful scheduling.
- Add lazy expiry and coordinator **Simulate timeout** as recovery/demo accelerators only.
- Prove first-accept-wins, cross-offer capacity safety, request replay, stale-task rejection,
  deadline-clamped holds, silent-wave promotion, action invalidation, and capacity release.

Gate: real authenticated tasks expire both a reservation and a silent wave; concurrent browser/API
attempts produce one winner and no duplicate notifications.

### Stage 4 — Actionable logistics and rigor

- Add GPS consent/address fallback, Maps/Routes adapter, haversine fallback, corrected pin, and the
  maximum 5 km donor-delivery rule.
- Add `needs_transport` and `failed` behavior without permitting cold-chain overrides.
- Enrich candidates with approximate nearest-tract need evidence and produce the ten-posting equity
  audit.
- Add FoodKeeper only as labeled advisory context; donor-confirmed deadline stays authoritative.
- Clearly label ZIP-centroid locations, generated operational attributes, simulated notifications,
  and live-capacity uncertainty.

Gate: the coordinator receives an actionable, defensible match with logistics, rejection evidence,
need context, limitations, and outcome state.

### Stage 5 — Time-boxed polish and submission evidence

- Add browser dictation and optional server-side photo extraction only after all prior gates pass.
- Require review of all inferred fields and never retain microphone audio.
- Enable Gemini 3.8 Live only if it materially improves the stable demo.
- Run deployed accessibility, mobile, security, safety, and browser E2E checks.
- Capture screenshots, logs/evidence, and a backup demo recording where tooling permits.
- Update README, validation/demo docs, and pitch guidance so judges can verify claims asynchronously.

Gate: the repository, deployed app, evidence, and demo narrative agree about what is real, simulated,
generated, approximate, optional, and deferred.

## Correctness invariants

Do not compromise these invariants:

- The LLM interprets and explains; deterministic code decides eligibility and state transitions.
- A candidate must pass storage, full quantity, transport, service horizon, deadline, route, and
  contradiction checks before notification.
- Donor delivery is at most 5 km unless a clearly recorded demo override exists.
- Candidate response states are exactly:
  `pending | declined | holding | hold_expired | timed_out | won | invalidated`.
- Hold expiry is `min(now + 10 minutes, offer.deadline)`.
- Expected handoff satisfies `now < expected_handoff_time <= offer.deadline`.
- One offer has at most one active reservation.
- One recipient cannot be overbooked across simultaneous offers.
- Firestore retries, HTTP retries, and Cloud Task retries do not duplicate state, events, capacity,
  or notifications.
- Reservation tasks compare `lease_version`; wave tasks compare `wave_version`.
- Failed, cancelled, expired, or released work frees reserved capacity.
- Only completed offers increment impact metrics.
- Exact donor coordinates are hidden until a valid claim.
- Cloud Run service-account tokens, raw stored secrets, microphone audio, and chain-of-thought never
  reach logs or browser responses.

## Verification requirements

Run proportionate tests after every meaningful change. At minimum, deliver:

- Existing regression tests plus new unit tests for states, auth scopes, idempotency, capacity,
  versioned tasks, deadlines, and transport radius.
- Firestore emulator concurrency/integration tests where available.
- Deployed BigQuery, ADK, MCP, Cloud Tasks, and Cloud Run smoke tests.
- Browser E2E for the main completion path, racing claims, and timeout/wave promotion.
- A final deployed smoke run using the spinach scenario.

Use `playwright-cli` for browser automation according to `AGENTS.md`. Keep one named session open
through the browser-verification portion and close it only when that work is complete.

Never claim a component is working from configuration alone. Report exact test output, deployed
URLs, relevant safe identifiers, and any skipped check with its reason.

## Communication and persistence

- Start by reporting the baseline, selected subagent assignments, and Stage 0 gate.
- Give concise progress updates at meaningful milestones and at least once per minute during long
  operations.
- Lead updates with working outcomes, failures, or blockers—not intended activity.
- If a cloud operation fails because of permissions or network isolation, request the narrow needed
  approval and continue with other safe work.
- Do not stop after scaffolding. Continue through the next safe stage while the current gate passes.
- If time or environment constraints force a cut, preserve the last working deployed checkpoint,
  record the exact limitation, and prioritize evidence for the core 100-point submission.

## Final handoff

The final response must include:

- What works end to end.
- Public/manual test URL and role instructions.
- Real versus simulated component list.
- Tests and browser scenarios run, with results.
- Cloud resources created or changed.
- Evidence for ADK, vector search, managed MCP, concurrency, and Cloud Tasks.
- Known limitations and the next highest-value task.
- Clickable links to changed local files.

Do not declare completion until the plan’s core definition of done is satisfied or clearly state
which gate remains incomplete and why.
