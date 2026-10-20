# Pantry Relay validation status

This document separates verified behavior from configured behavior. Resource
existence and environment variables are not counted as proof by themselves.

## Current checkpoints

| Environment | Identifier | Verified result |
|---|---|---|
| Production Cloud Run | `atlanta-grocery-rescue-00020-yaq`, 100% traffic | Feature-enabled successor preserves the verified workflow and adds verified CSP, HSTS, frame, nosniff, and Permissions Policy headers |
| Feature-enabled functional proof | `atlanta-grocery-rescue-00015-dlw` | Real ADK offer path, BigQuery vector search, Firestore workflow, browser race/completion, real geocoding/Routes/Gemini, protected ten-match proof, and production Cloud Tasks callbacks passed |
| Optional-features-off smoke | `atlanta-grocery-rescue-00017-rop`, no traffic | Service started and protected readiness passed with optional photo, Google geocoding, and Google Routes disabled |
| Public URL | <https://atlanta-grocery-rescue-61272668502.us-central1.run.app> | Manual Donor, Recipient, and Coordinator demonstration target |
| Local integrated browser | `playwright-cli` sessions recorded under `docs/evidence/` | Review-first intake, token privacy, refresh, completion, timeout acceleration, keyboard map, speech lifecycle fake, and mobile behavior passed |

## Automated checks

Final repository checks:

```text
.venv/bin/pytest -q -p no:cacheprovider
........................................................................ [100%]
72 passed, 1 warning in 0.78s

node --check frontend/app.js                         PASS
bash -n scripts/provision_cloud.sh scripts/deploy_cloud_run.sh
                                                     PASS
git diff --check                                     PASS
```

The warning is an upstream `google.genai.types` Python deprecation warning, not
a failed Pantry Relay assertion. The suite covers the preserved matching API,
ADK event/result handling, workflow states, authorization boundaries, command
replay, concurrency, cross-offer capacity, versioned tasks, deadlines,
transport radius, location normalization, transient image validation, equity
proof validation, and role API behavior.

## Deployed spinach workflow

The installed `playwright-cli` drove the public service. One named session,
`pantry-relay-integration`, was reused; its browser daemon exited while idle
during a deployment wait, so the same named session was reopened for the final
revision.

Passed:

1. Submitted ten crates of refrigerated spinach using a reviewed map-selected
   pickup with no address or coordinate typing.
2. The donor view showed a first wave of three simulated recipient
   notifications, deterministic audit evidence, and Google Routes logistics.
3. Opened two scoped recipient sessions and sent their claims concurrently.
   Exactly one request returned HTTP 200 and one returned HTTP 409.
4. The loser retained a hidden exact pickup point. The winner received the
   reviewed pickup location and a ten-minute hold.
5. The winner refreshed, confirmed, and completed one actual pallet; both the
   recipient and donor views reached `Completed`.
6. The protected coordinator showed the same completed offer, event timeline,
   and impact totals.
7. Tokens were removed from URL fragments, were absent from rendered text, and
   the coordinator token was deleted from browser session storage after use.

Screenshots and detailed assertions are in
[`evidence/browser-deployed-2026-10-20.md`](./evidence/browser-deployed-2026-10-20.md).

## Real ADK, BigQuery, MCP, and ten-match evidence

The deployed reviewed-offer path ran through the ADK `root_agent`, its custom
`match_surplus_offer` tool, and real BigQuery brute-force `VECTOR_SEARCH`. The
correlated offer job was
`8c4be85d-4cab-4913-be2a-bccd9f3dd568`.

Independent Stage 0 evidence also records:

- an ADK Runner `root_agent -> match_surplus_offer` event;
- a protected Google-managed BigQuery MCP `list_dataset_ids` call, not merely a
  public tool-list handshake;
- query label `workload=pantry_relay_vector_search` and the safe SQL
  fingerprint;
- ten independent matches with ten distinct labeled BigQuery job IDs;
- brute-force top-30 vector evidence for all ten; and
- approximate nearest-tract evidence for all ten selected outcomes.

The deployed protected Coordinator rendered the same proof as `10 / 10 passed`,
ten posting rows, `10/10` distinct jobs, top-30 brute-force search, and `10/10`
tract evidence. The proof is an audit of matches, not ten completed rescues or a
claim of measured equitable impact.

See:

- [`evidence/agent-stage0-2026-10-20.md`](./evidence/agent-stage0-2026-10-20.md)
- [`evidence/matching-ten-real-2026-10-20.md`](./evidence/matching-ten-real-2026-10-20.md)
- [`evidence/browser-deployed-equity-ten-match.png`](./evidence/browser-deployed-equity-ten-match.png)

## Firestore, readiness, and Cloud Tasks

Protected `GET /readyz` returned HTTP 200 on both production revision
`00020-yaq` and
the no-traffic optional-features-disabled revision. Live checks reported
Firestore, Cloud Tasks, ADK, and managed MCP ready, with 136 BigQuery recipient
embedding rows. The MCP result was retained only as a SHA-256 digest.

The exact credential-free `/healthz` route passes local tests and appears in
OpenAPI. On the default `run.app` domain, Google Front End intercepts exact
`/healthz` with its own 404 before the container. `/healthz/` reaches the
application and returns HTTP 200. This is a known deployed routing deviation.

Real OIDC delivery evidence includes:

- the earlier authenticated no-op callback and bounded reservation/wave proof;
- feature-enabled revision `00015-dlw` wave callbacks at
  `2026-10-20T18:54:05.483015Z` and
  `2026-10-20T18:54:16.573016Z`, both HTTP 200; and
- reservation expiry for `offer_9baecfb4b78a520dbd37` at
  `2026-10-20T18:57:25.240469Z`, HTTP 200.

After expiry, authoritative Firestore state showed no active reservation or
selected recipient, recipient `130` as `hold_expired`, and wave 2 open. Safe
task, revision, trace, and state details are in
[`evidence/deployed-cloud-2026-10-20.md`](./evidence/deployed-cloud-2026-10-20.md).
The coordinator **Simulate timeout** action remains a labeled recovery/demo
accelerator and is not counted as Cloud Tasks proof.

## Location, photo, mobile, accessibility, and security checks

Deployed browser checks passed these paths:

- keyboard-only map placement;
- GPS-only reviewed location with no coordinate inputs;
- address-only geocoding for Atlanta City Hall, returning provider
  `google_geocoding` and precision `rooftop`;
- traffic-aware Google Routes evidence on the matched offer;
- Gemini photo extraction returning `provider=gemini`,
  `review_required=true`, and `retained=false`, without creating an offer;
- 390 × 844 layout with no horizontal overflow;
- one `h1`, one `main`, labeled navigation, named controls, and visible
  keyboard focus; and
- protected Coordinator/equity access rejecting an anonymous request with HTTP
  401 and returning an `X-Request-ID`.

Automated Chromium does not provide a real microphone or speech-recognition
service. A browser fake verified dictation lifecycle, navigation abort, and
stale-callback safety; live microphone transcription still requires a supported
interactive browser and permission grant.

Production revision `00020-yaq` returned every checked hardening header: Content
Security Policy, HTTP Strict Transport Security, `X-Frame-Options`,
`X-Content-Type-Options: nosniff`, and `Permissions-Policy`.

## Deterministic matching cases

| Case | Verified safety result |
|---|---|
| Refrigerated spinach, one pallet, six hours | Eligible cold-chain recipients only; Greenline rejected for no refrigeration |
| Milk and yogurt, two pallets, eight hours | Refrigeration, full quantity, transport, and positive margin enforced |
| Ambient bread and pastries, one pallet, 24 hours | Capacity and service-day checks enforced |
| Refrigerated prepared food, half pallet, four hours | Short deadline and positive route/handling margin enforced |
| Deliberately impossible offer | Honest `no_match`, never an unsafe suggestion |

Hard assertions include storage, full-load capacity, known reserved capacity,
transport, service horizon, donor deadline, route margin, and contradiction
handling. Donor delivery is capped at 5 km.

## Manual public check

1. Open the [public donor view](https://atlanta-grocery-rescue-61272668502.us-central1.run.app/?role=donor).
2. Choose **Run the spinach rescue**, review every suggestion, and place the
   pickup with GPS, address, or map.
3. Submit and open two current-wave recipient sessions from the donor demo
   controls.
4. Race **Hold for 10 minutes**; require one winner and one conflict.
5. Refresh the winner, confirm a handoff before the deadline, and complete it.
6. Return to donor status and verify `Completed` without a database console.
7. Open Coordinator using the separately supplied secret and verify the shared
   timeline, impact, candidate audit, and `10 / 10` matching proof.

Never place donor, recipient, coordinator, or service-account credentials in a
URL, screenshot, document, terminal transcript, or chat.

## Honest product boundaries

- Notifications are simulated; no external email, SMS, or push was delivered.
- Organization identity and reported IRS fields come from source data, while
  capacity, storage, schedules, transport, and profile prose are generated.
- Recipient points are approximate ZIP centroids; nearest-tract context and
  non-Google route fallbacks are approximate.
- Live capacity, hours, staffing, and transport must be reconfirmed.
- FoodKeeper context is advisory; the donor-confirmed deadline is authoritative.
- Demo bearer scopes are not production identity or organization verification.
- Images are processed transiently and are not retained; microphone audio is
  never stored by Pantry Relay.
- Load splitting, real driver logistics, moving GPS, external notifications,
  public recipient onboarding, and Gemini 3.8 Live are deferred.
