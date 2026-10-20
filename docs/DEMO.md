# Pantry Relay demo guide

## Before presenting

The public production checkpoint is feature-enabled Cloud Run revision
`atlanta-grocery-rescue-00020-yaq`, serving 100% of traffic:

<https://atlanta-grocery-rescue-61272668502.us-central1.run.app/?role=donor>

Keep the coordinator demo bearer token available through a private channel.
Never paste it into slides, notes, a URL, recorded terminal output, screenshots,
or chat. A no-traffic revision, `00017-rop`, separately proves the service starts
and becomes ready with optional photo, Google geocoding, and Google Routes
disabled. Functional browser and task evidence was captured on feature-enabled
revisions `00011-mgf` and `00015-dlw`; Firestore state and the same workflow
remain available through the production successor.

## Three-minute walkthrough

### 1. Donor — capture and review

1. Open **Donor**. Point out the Atlanta rescue map, completed-impact counters,
   and clear labels for simulated notifications, generated recipient operations,
   and approximate locations.
2. Choose **Run the spinach rescue**. This is the fastest no-typing path. The
   editable review shows ten crates, one-pallet normalization, refrigeration,
   a six-hour deadline, and recipient pickup.
3. Place the private pickup point using **Use my location**, an Atlanta street
   address, or the keyboard/clickable map. Donors never type coordinates.
4. Read the review warning: inferred quantity, storage, transport, and deadline
   remain suggestions until the donor confirms them.
5. Submit and leave the private donor status view open.

Talk track:

> A grocer has ten crates of refrigerated spinach that must move within six
> hours. AI structures and explains the offer. Deterministic code decides
> storage, capacity, transport, deadline, route, and contradiction eligibility.

The production request runs through `root_agent -> match_surplus_offer ->`
BigQuery brute-force `VECTOR_SEARCH`; the recorded correlated job is
`8c4be85d-4cab-4913-be2a-bccd9f3dd568`.

### 2. Recipient — race, confirm, and complete

1. From donor status, open two current-wave demo recipient sessions.
2. Before claiming, show that the exact pickup point is hidden. Each recipient
   sees the full quantity, deadline, storage, transport expectation, approximate
   distance, and live-capacity warning.
3. Trigger **Hold for 10 minutes** in both sessions. Require one winner and one
   conflict. The deployed proof produced one HTTP 200 and one HTTP 409.
4. Refresh the winning session. The reservation and countdown survive; only the
   winner now sees the reviewed pickup point.
5. Confirm a future handoff no later than the donor deadline, including contact,
   capacity, and transport acknowledgement.
6. Complete one actual pallet. Return to donor status and show `Completed`
   without refreshing manually.

Talk track:

> Claiming is an atomic transaction, not an AI decision. It rechecks the
> current wave and known reserved capacity. The hold expires after ten minutes
> or sooner at the donor deadline.

### 3. Coordinator — decision evidence and ten matches

1. Open **Coordinator** and enter the separate bearer token through the password
   field.
2. Show the same completed offer, timeline, selected recipient, route evidence,
   and impact total seen in the donor and recipient views.
3. Expand the deterministic candidate audit. Point out rejection reasons,
   approximate nearest-tract need context, generated operational attributes,
   and the requirement to reconfirm live capacity.
4. Open **Equity & ten-match proof**. Show `10 / 10 passed`, ten posting rows,
   ten distinct BigQuery jobs, top-30 brute-force vector search, and tract
   evidence for all ten selected outcomes.
5. If showing **Simulate timeout**, call it a recovery/demo accelerator. For
   real timeout proof, cite the production OIDC callbacks in the evidence note:
   offer `offer_9baecfb4b78a520dbd37` safely reached `hold_expired`, released its
   reservation, and opened wave 2.

Talk track:

> Vector search finds possibilities. Deterministic rules decide eligibility.
> Firestore owns the shared workflow, and versioned Cloud Tasks safely advance
> silent waves and expired holds.

## Optional intake beats

Use these only if time permits:

- **Type:** free text is converted into an editable, review-required draft.
- **Speak:** a supported browser can dictate into the same draft; Pantry Relay
  never stores microphone audio. Automated Chromium lacks a real microphone and
  speech-recognition service, so automation verified the lifecycle with a
  browser fake, including navigation abort and stale-callback safety.
- **Photo:** upload a JPEG, PNG, or WebP under 5 MB. The deployed endpoint
  returned `provider=gemini`, `review_required=true`, and `retained=false`; the
  image produced suggestions but did not create an offer or make a food-safety
  decision.
- **Address:** the deployed Atlanta City Hall check returned
  `google_geocoding` with `rooftop` precision.
- **Map/GPS:** both avoid coordinate entry and require the donor to review the
  resulting pin.

## What is real, simulated, generated, and approximate

- **Real:** ADK Runner, custom matcher tool, BigQuery top-30 brute-force vector
  search, protected managed BigQuery MCP call, Firestore workflow, atomic
  claims, Google geocoding, Google Routes evidence, Gemini photo extraction,
  Cloud Tasks OIDC callbacks, and Cloud Run deployment.
- **Simulated:** recipient notification delivery is an in-app inbox, not email,
  SMS, or push. Demo authorization is not production identity proofing.
- **Generated:** recipient capacity, storage, schedules, transport, and
  operational profile prose. Live availability is established only when a
  recipient confirms.
- **Approximate:** recipient ZIP-centroid locations, nearest-tract context, and
  haversine route fallback. This is workflow tracking, not moving-driver GPS.
- **Authoritative:** donor-confirmed deadline and Firestore workflow state.
- **Advisory:** FoodKeeper context; it never overrides the deadline or makes an
  automatic food-safety decision.
- **Impact:** only completed offers increment completed-rescue and quantity
  counters. The ten-match proof is not ten completed rescues.

## Evidence shortcuts

- Browser acceptance and screenshots:
  [`evidence/browser-deployed-2026-10-20.md`](./evidence/browser-deployed-2026-10-20.md)
- Cloud revision, readiness, task, and safe job evidence:
  [`evidence/deployed-cloud-2026-10-20.md`](./evidence/deployed-cloud-2026-10-20.md)
- Independent ADK/MCP/vector proof:
  [`evidence/agent-stage0-2026-10-20.md`](./evidence/agent-stage0-2026-10-20.md)
- Ten independent matcher executions:
  [`evidence/matching-ten-real-2026-10-20.md`](./evidence/matching-ten-real-2026-10-20.md)

## Guardrails and known limitations

- Say “first qualified acceptance wins,” not “the AI awards the food.”
- Say “pre-approved demo recipient,” not “verified live pantry.”
- Say “known demo capacity, reconfirmed by the recipient,” not “live inventory.”
- Say “Google Routes evidence” only for a recorded Google result; otherwise say
  “estimated route.”
- Never reveal an opaque token, coordinator secret, service-account token, raw
  secret, exact pre-claim donor coordinates, or model chain-of-thought.
- Exact `/healthz` is intercepted with a Google Front End 404 on the default
  `run.app` domain; `/healthz/` reaches the application and returns 200.
- Production revision `00020-yaq` has verified CSP, HSTS,
  `X-Frame-Options`, `X-Content-Type-Options: nosniff`, and
  `Permissions-Policy` response headers.
- Gemini 3.8 Live, external notifications, load splitting, volunteer-driver
  logistics, production identity, and live vehicle tracking are deferred.
