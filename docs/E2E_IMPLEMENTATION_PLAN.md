# Pantry Relay — End-to-End Implementation Plan

## Objective

Turn the existing Atlanta matcher into a working three-sided rescue workflow:

1. A donor describes surplus food by typing, speaking, or attaching a photo.
2. The system structures and validates the offer, then finds operationally safe recipients.
3. The top three eligible pre-approved recipients receive simulated notifications.
4. The first recipient to accept receives a temporary hold and must confirm within 10 minutes.
5. A confirmed handoff is tracked to completion while donor, recipient, and coordinator views update.

The hackathon implementation must prove real matching, persistence, concurrency safety, timeout
handling, multimodal intake, and role-specific UI. Real email, volunteer drivers, load splitting,
and external marketplace integrations are follow-ups.

## Confirmed product decisions

| Area | First-release decision |
|---|---|
| Recipient access | Pre-approved recipients only, seeded from the Atlanta recipient corpus |
| Donor access | No account; minimal submission plus an unguessable status token |
| Demo access | Public Cloud Run invocation with application-scoped demo tokens; no claim of production identity |
| Notifications | Simulated in-app notification inbox and event timeline |
| Fan-out | Notify the top three eligible recipients; promote the next wave if needed |
| Claiming | First eligible acceptance wins through an atomic transaction |
| Confirmation | Acceptance creates a 10-minute hold, clamped to the donor deadline; recipient must confirm before expiry |
| Wave response | Ten-minute configurable response window, also clamped to the donor deadline; coordinator can promote during the demo |
| Transport | Recipient pickup, donor delivery up to 5 km, or transportation-needed warning |
| Splitting | Deferred; one recipient must be able to handle the full offer |
| Donor selection | Deferred; the donor observes progress rather than selecting a recipient |
| Coordinator | Lightweight operations dashboard with override/reopen/cancel controls |
| Map | Donor GPS with consent or address fallback; recipient points and status shown on a map |
| Tracking | Workflow/status tracking, not real moving-driver GPS |
| Voice | Live dictation into editable form fields; no retained audio |
| Photo | Optional photo analyzed into editable offer suggestions and retained only for the active offer |
| Quantity | Preserve donor wording and separately confirm normalized pallet estimate |
| Completion | One-step completion with optional actual quantity and failure reason |
| ADK | Agent handles intake, clarification, tool routing, explanations, and messaging; rules remain deterministic |
| Deployment | Google Cloud services are real; external notifications and volunteer delivery are simulated |

## Scope

### Core acceptance — do not trade away

- Donor landing and submission flow.
- Typed donor description and editable structured review.
- Persistent offers and live status history.
- Real BigQuery vector search and deterministic eligibility checks.
- Top-three recipient fan-out.
- Recipient inbox/detail/accept/decline/confirm flow.
- Atomic first-accept-wins reservation.
- Ten-minute confirmation timeout and next-wave promotion.
- Minimal coordinator queue/status/actions view.
- Simulated notification feed.
- Completion and basic impact metrics.
- A real ADK `root_agent` execution path that calls the custom matcher tool.
- A judge-visible call through Google-managed BigQuery MCP; it may support coordinator analysis,
  but deterministic code remains the eligibility authority.

### High-value next — confirmed scope after the core is green

- GPS or address-based pickup location and a map with donor/recipient points.
- Transport-mode validation, Routes adapter, and visible logistics evidence.
- Coordinator filters, warnings, impact summary, and controlled recovery actions.
- Census-tract need evidence and a ten-posting equity audit; FoodKeeper shelf-life data is
  advisory context and never an unverified food-safety decision.

### Time-boxed polish

- Browser dictation into editable text.
- Optional photo-to-text suggestions through a server-side Gemini request.
- Gemini 3.8 Live only if it materially improves an already-working flow.

### Explicitly deferred

- Multiple recipients splitting an offer.
- Volunteer-driver enrollment, badges, live GPS, or route matching.
- Uber, Lyft, Too Good To Go, or other marketplace integrations.
- Real email, SMS, and push delivery.
- Public recipient self-registration.
- Production identity proofing and organization verification.
- Multi-stop route optimization.
- Automated dispatch without human confirmation.
- Server-Sent Events, live driver tracking, and a separately deployed agent runtime.
- A conversational voice agent as a dependency of the core flow.

### Hackathon cut line and graceful fallbacks

The non-negotiable vertical slice is: reviewed intake -> ADK tool call -> real BigQuery vector
search -> deterministic filtering -> persisted top-three fan-out -> atomic hold -> confirmation or
safe timeout -> completion, visible from all three roles.

- Use two-second status polling instead of SSE.
- Use Google Maps when configured, with the existing deterministic haversine estimate clearly
  labeled as the routing fallback.
- The deployed acceptance environment must execute real authenticated Cloud Tasks for reservation
  and silent-wave expiry. Lazy expiry and **Simulate timeout** are recovery/demo accelerators, not
  substitutes for the Cloud Tasks proof.
- Keep offline tests credential-free through repository, scheduler, map, model, and notification
  interfaces. The deployed demo must enable ADK, managed BigQuery MCP, BigQuery, and Firestore.
- Do not spend hackathon time on email delivery, auth onboarding, volunteer logistics, or SSE.

Apply one simplicity rule throughout: one Cloud Run service, one SPA, one ADK root agent, one
Firestore workflow repository, one opaque-token pattern, and one idempotent task callback. Browser
speech-to-text may fill editable fields and a server-side Gemini call may inspect one photo after the
text-only workflow works. Gemini 3.8 Live remains an optional enhancement, not a dependency of the
core 100-point submission.

## Chosen track and judging alignment

### Track statement

**Track: Atlanta retail and grocer rescue.** The anchor scenario is a grocer offering ten crates of
refrigerated spinach that must move within six hours. This track is about small, unpredictable,
perishable offers moving quickly to a neighborhood pantry or similar recipient. Release one therefore
optimizes storage, full-load capacity, short travel time, pickup horizon, and confirmation under a
clock. Farm-scale splitting, loading-dock logistics, and multi-recipient routing are intentionally
out of scope; omitting them is a track choice, not an unfinished retail feature.

### Score strategy

| Dimension | What the implementation proves | Submission evidence |
|---|---|---|
| Impact & insight — 30 | A coordinator receives a specific recipient, rejection reasons, route/deadline evidence, transport expectation, contact/confirmation state, and safe fallbacks—not a generic recommendation. The three-role workflow closes the loop through completion. | Main spinach walkthrough; coordinator match brief; map/timeline; real accept/confirm/complete record; equity-audit screen. |
| Technical execution — 30 | ADK genuinely calls the custom matcher; the matcher genuinely executes BigQuery brute-force `VECTOR_SEARCH`; deterministic rules reject unsafe semantic matches; Firestore transactions prevent duplicate claims; authenticated Cloud Tasks expire holds and silent waves. | ADK tool event; correlated BigQuery job ID/query label; Greenline rejection; race test; task log; deployed URL. |
| Rigor & judgment — 25 | The repo separates semantic retrieval from eligibility, labels real versus generated data, exposes contradictions for manual review, prevents the model from overriding rules, audits neighborhood outcomes, and documents every fallback and deferred feature. | Decision table in this plan; candidate audit; Lakeshore/Harborview warning; ten-posting equity audit; limitations slide and README section. |
| Craft & communication — 15 | One SPA tells one understandable story across Donor, Recipient, and Coordinator views. Six primary states, concise warnings, countdown, map, and timeline make the system legible without opening a cloud console. | Rehearsed short demo; screenshots; backup recording; role switcher; plain-language warning catalog. |
| Bonus—range — +10 | Managed BigQuery MCP, Firestore, Cloud Tasks, Maps, Cloud Storage, Gemini photo extraction, and optional Live intake demonstrate breadth only after they support a reliable rescue workflow. | Architecture/evidence slide naming what is real versus simulated; MCP smoke call; cloud logs. |

### Priority rule

Build for the 100 points before the bonus. Phases 0–3 establish a defensible submission even if work
stops there. Phase 4 increases the two highest-value dimensions—Impact and Rigor. Phase 5 is
time-boxed polish and bonus range. Every completed phase must leave behind repo-visible evidence,
because judges evaluate the repository, deck, and recorded pitch without a follow-up conversation.

## Build on the current repository

Keep and extend:

- BigQuery `recipient_embeddings` and brute-force top-30 `VECTOR_SEARCH`.
- `agent.matcher.match_surplus` as the eligibility authority.
- Existing Greenline and Harborview safety behavior.
- FastAPI and same-origin static frontend on Cloud Run.
- Existing 13-test matcher/service regression suite, including the four documented demo cases.

Add:

- Firestore workflow repository and transactions.
- Cloud Tasks reservation/wave-expiry scheduling plus lazy-expiry safety net.
- One role-switching SPA and hashed opaque bearer tokens.
- An in-app notification provider.
- Google Maps location and route adapters.
- Browser dictation plus server-side Gemini photo extraction; optional Gemini 3.8 Live enhancement.
- ADK workflow/routing layer, an actual `root_agent` runner, mandatory deployed managed-MCP smoke
  path, and traceable tool calls.
- Nearest-tract demographic enrichment, FoodKeeper advisory context, and equity-audit output.

Do not move reservation state into BigQuery. BigQuery remains the semantic retrieval and analytics
system; Firestore owns mutable operational state.

## Target architecture

```text
Donor / Recipient / Coordinator browser
              |
              v
     Cloud Run web + API service
       |       |        |       \
       |       |        |        \-- Google Maps Platform
       |       |        |
       |       |        \-- browser dictation + server-side Gemini photo extraction
       |       |
       |       \-- ADK root broker agent + Runner
       |             |-- structure/clarify offer tool
       |             |-- deterministic matcher tool
       |             |-- workflow/status tool
       |             |-- notification-copy tool
       |             \-- managed BigQuery MCP (read-only analysis)
       |
       |-- Firestore
       |     |-- offers and status events
       |     |-- recipient demo identities
       |     |-- flat simulated notification inbox
       |     |-- candidate waves and responses
       |     |-- active reservation lease
       |     \-- hashed access tokens + idempotency receipts
       |
       |-- Expiration scheduler
       |     |-- deterministic reservation and wave Cloud Tasks
       |     |-- one idempotent advance-offer callback
       |     \-- lazy expiry + coordinator demo trigger
       |
       |-- BigQuery
       |     |-- recipient profile embeddings
       |     |-- top-30 semantic retrieval
       |     |-- nearest-tract demographics / equity audit
       |     \-- FoodKeeper shelf-life advisory context
       |
       \-- Cloud Storage
             \-- temporary offer photos with lifecycle deletion
```

For the hackathon, ADK may run inside the Cloud Run application to minimize deployment risk. Keep
the agent package compatible with a later move to Agent Runtime and Gemini Enterprise registration.

## User journeys

### 1. Donor submission

1. Donor chooses **Donate food**.
2. Donor types a description, dictates it, attaches a photo, or combines all three.
3. Gemini proposes structured fields by calling a typed `update_offer_draft` function:
   - food description;
   - original quantity and unit;
   - pallet estimate;
   - storage requirement;
   - visible date/deadline, if any;
   - confidence and warnings.
4. Donor reviews every suggestion. Image analysis never asserts food safety.
5. Donor uses **Use my location** or enters an address.
6. Donor chooses recipient pickup, donor delivery radius, or transportation needed.
7. Donor chooses the pickup deadline and submits.
8. API creates the offer and returns a private status URL.
9. Status view immediately shows `Matching` and an event timeline.

### 2. Match and fan-out

1. ADK verifies required fields and calls the deterministic matcher.
2. Matcher retrieves 30 semantic candidates from BigQuery.
3. Structured rules reject unsafe or infeasible candidates.
4. Service persists the candidate audit and the ranked eligible list.
5. Before fan-out, the service joins eligible candidates to Firestore and removes candidates whose
   known `capacity_pallets - reserved_pallets` cannot fit the offer. Claim repeats this check atomically.
6. The first wave contains up to three eligible recipients.
7. Each recipient receives an in-app notification and scoped opaque action token.
8. Donor status changes to `Waiting for recipient`.
9. If no candidates survive, status becomes `No match` with a coordinator-visible explanation.

### 3. Recipient response

1. Recipient opens the simulated inbox or scoped opaque-token action link.
2. Page shows offer details, deadline, distance, transport expectation, and why the recipient fits.
3. Recipient selects **Decline** or **Accept temporarily**.
4. Decline records a reason and leaves the offer open to other notified recipients.
5. Accept executes the first-accept-wins transaction.
6. Winner sees a 10-minute countdown and confirms:
   - pickup or delivery;
   - expected handoff time;
   - contact name and phone;
   - acknowledgement that current capacity is available.
7. Losing concurrent accept attempts receive HTTP `409 offer_currently_held` with the hold expiry.
   They remain `pending`, rather than entering a separate waitlist state, and may try again if
   the winner's hold expires.

### 4. Reservation timeout

1. Accept transaction first checks `now < offer.deadline`, candidate eligibility, current-wave
   membership, and unreserved recipient capacity. In the same transaction it increments the
   recipient's `reserved_pallets` and creates `reservation_id`, `lease_version`, and
   `expires_at = min(now + 10 minutes, offer.deadline)`.
2. After the Firestore transaction commits, the service enqueues a deterministically named Cloud
   Task carrying the offer ID, reservation ID, and lease version. Retrying task creation is safe.
3. Cloud Tasks cannot commit atomically with Firestore. If enqueue fails, every offer read/mutation
   still performs lazy expiry, and the coordinator can invoke **Simulate timeout**; enqueue failure
   is logged and shown as an operations warning rather than leaving an immortal hold.
4. The expiry handler or lazy-expiry path checks in a transaction that the same lease is active,
   unconfirmed, and actually due.
5. It marks the reservation `expired`, sets the holder response to `hold_expired`, releases reserved
   capacity, writes an event, and returns the offer to `notified` unless its donor deadline passed.
6. The expired holder cannot immediately reclaim the same offer. Other already-notified recipients
   may accept.
7. Each wave has `wave_expires_at = min(wave_started_at + response_window, offer.deadline)`. Promote
   the next three when everyone in the wave declines/holds expire, when that response window ends,
   or when the coordinator triggers promotion. End as `no_match` when candidates are exhausted.
8. Wave creation also enqueues `expire-wave-{offer_id}-{wave_version}`. Reservation and wave tasks
   call the same transactional `advance_offer_if_due()` callback. It marks unanswered recipients
   `timed_out`, increments `wave_version`, and creates the next deterministic notification set.
9. Stale tasks can never change newer state because reservation tasks compare `lease_version` and
   wave tasks compare `wave_version`.

### 5. Confirmation and completion

1. Confirmation lazily expires due state, requires
   `now < expected_handoff_time <= offer.deadline`, revalidates transport, sets the offer to
   `Confirmed`, and atomically invalidates other action records.
2. Donor, recipient, and coordinator timelines update.
3. Map highlights the confirmed route and handoff details.
4. Either participant can mark the handoff complete with actual quantity and an optional note.
5. Coordinator can resolve cancellation or failure with a short reason. Failed/cancelled handoffs
   release reserved capacity and never increment completed-impact metrics.
6. Dashboard impact counters use actual completed quantity when supplied; otherwise they use the
   normalized offered quantity with an `estimated` label.

## Simple public status model

Use six primary labels in the UI:

```text
Submitted -> Matching -> Waiting -> Held -> Confirmed -> Completed
```

Exception labels:

```text
Needs transport | No match | Failed | Expired | Cancelled
```

Internally, keep enough detail for safe transitions:

```text
submitted
matching
notified
reserved
confirmed
completed
needs_transport
no_match
failed
expired
cancelled
```

Declines and reservation expirations are events, not top-level offer states, unless every candidate
has declined or the donor deadline has passed.

Candidate responses use one explicit state machine:

```text
pending | declined | holding | hold_expired | timed_out | won | invalidated
```

`transportation_needed` enters `needs_transport` until the coordinator records a concrete safe
arrangement. An override may document transport, but it may never bypass cold-chain requirements.

## Matching and routing rules

The model may interpret input and explain results. It may not determine eligibility.

### Hard eligibility rules

- Required storage is available.
- Full quantity fits recipient capacity.
- Transport arrangement preserves the required cold chain. For `donor_delivery`, require
  `0 < donor_delivery_radius_km <= 5` and
  `distance_miles <= donor_delivery_radius_km * 0.621371`; 5 km is the release-one default and
  maximum unless a coordinator records an explicit demo override. For `recipient_pickup`, recipient
  transport must be compatible. `transportation_needed` blocks confirmation until safely resolved.
- Generated service-day and pickup-horizon fields permit the handoff. Exact business hours and live
  staffing are not present in the corpus and must be confirmed by the recipient.
- Estimated route and handling fit inside the effective time window.
- Contradictory capability data requires manual review and cannot silently qualify.
- Offer has not expired, been cancelled, or already been confirmed.

### Ranking order

1. Positive feasibility/time margin.
2. Route duration/distance.
3. Useful spare capacity, matching the existing deterministic matcher.
4. Explicit neighborhood-need tie-break from the recipient's nearest census tract, using poverty
   and no-vehicle rates; fall back transparently to `weekly_households` only when tract data is absent.
5. Semantic distance and stable recipient ID.

### Fan-out rules

- Wave size is three.
- Never notify a hard-ineligible recipient.
- A recipient appears at most once per offer.
- Do not start another wave while an active reservation exists.
- Promote the next wave when all current-wave recipients decline, the wave response window ends,
  or a reservation expires with no remaining current-wave responders.
- Store `wave_started_at` and `wave_expires_at`; never rely on an unstored implicit window.
- Store and compare `wave_version`; a wave-expiry task is stale unless its version matches exactly.
- `split_allowed` may be stored but has no effect in release one.

## ADK design

Use one root broker agent and explicit tools rather than a large multi-agent graph.

### Agent responsibilities

- Recognize donor-intake, match, status, and coordinator-explanation intents.
- Ask only for missing required fields.
- Route audio/image/text through intake extraction.
- Call `match_surplus_offer` before naming any recipient.
- Treat matcher eligibility and Firestore state transitions as authoritative.
- Explain human-readable warnings and rejection reasons.
- Draft notification and confirmation copy.
- Refuse to promise live availability until a recipient confirms.

### Tools

- `update_offer_draft`: typed function arguments for extracted offer fields.
- `analyze_offer_photo`: sends image plus donor context to Gemini.
- `match_surplus_offer`: existing BigQuery + deterministic matcher.
- `get_offer_status`: reads Firestore timeline safely by scoped token/user.
- `claim_offer`: atomic transaction; never implemented as an LLM decision.
- `confirm_reservation`, `decline_offer`, and `complete_offer`: validated state transitions.
- Managed BigQuery MCP tools: required in the deployed demo for at least one read-only coordinator
  analysis/equity-audit flow. MCP never bypasses deterministic eligibility. Offline tests may disable it.

The simple intake path uses browser speech-to-text to populate editable text and one server-side
Gemini image-analysis request for an optional photo. Microphone audio may be streamed transiently to
the configured speech provider but is never saved by this application. Photo/text suggestions pass
through a declared function schema plus Pydantic validation and donor review.

Gemini 3.8 Live is a post-core enhancement for conversational multimodal intake. The current service
uses Vertex AI Application Default Credentials, which must never be sent to a browser. If direct
browser Live API is enabled, `POST /api/live/session` may mint a constrained, one-use Gemini
Developer API ephemeral token only when `GEMINI_API_KEY` is configured through Secret Manager. The
endpoint returns no long-lived key or service-account OAuth token.

The web workflow must execute `root_agent` through an ADK Runner/session path—not merely import the
agent while calling `match_surplus_offer` directly. Capture tool-call name, status, latency, and safe
result metadata; never expose chain-of-thought. An ADK event proves
`root_agent -> match_surplus_offer`; a correlated BigQuery job ID, query label, and safe SQL
fingerprint prove that the custom tool executed brute-force `VECTOR_SEARCH`. Preserve
`POST /api/match` as a deterministic compatibility endpoint and unit-test seam.

Keep `/healthz` credential-free for liveness. Add protected `/readyz` for actual ADK construction,
BigQuery access, and a cached real managed-MCP smoke-call result. The judge-visible coordinator flow
records the MCP tool name and safe result metadata; it never exposes arbitrary anonymous querying.

## Firestore model

### `offers/{offer_id}`

```text
status
created_at / updated_at / deadline
wave_started_at / wave_expires_at / current_wave / wave_version
donor_status_token_hash
description_original / description_structured
quantity_original / quantity_pallets
storage_state
pickup_address / pickup_geopoint / location_source
transport_mode / donor_delivery_radius_km
photo_object_path / photo_delete_after
selected_recipient_id
active_reservation_id / reservation_expires_at / lease_version
completed_quantity / completed_at / outcome_reason
```

### `offers/{offer_id}/candidates/{recipient_id}`

```text
rank / wave
semantic_distance
eligible
reasons / warnings
capacity / route / clock evidence
notification_status / notified_at
response: pending | declined | holding | hold_expired | timed_out | won | invalidated
responded_at / decline_reason
tract_geo_id / tract_need_score / tract_need_evidence
```

### `offers/{offer_id}/events/{event_id}`

Append-only timeline entry with event type, actor type, actor ID, timestamp, and safe display text.

### `notifications/{notification_id}`

Flat simulated inbox records keyed by donor status token scope, recipient ID, or coordinator role.
This avoids collection-group queries across candidate subcollections. Candidate and event reads stay
under a known offer path; with at most 30 candidates, filter wave/response state in application code
instead of requiring composite indexes during the hackathon.

Use deterministic notification IDs: `{offer_id}:{wave_version}:{recipient_id}`. Query a bounded set
by recipient and sort it in application code so the hackathon path needs no composite index.

### `recipients/{recipient_id}`

Demo-facing projection of pre-approved recipient identity, profile, contact alias, location, and
capabilities. BigQuery remains the source for semantic profiles; the Firestore projection supports
workflow reads, while the flat `notifications` collection supports inbox queries.

Store `capacity_pallets`, `reserved_pallets`, and a revision/update timestamp. Claim, release,
cancel, and completion transactions update reserved capacity so simultaneous offers cannot
overbook one recipient even if each offer independently passes the BigQuery snapshot.

### `reservations/{reservation_id}`

```text
offer_id / recipient_id
status: active | confirmed | expired | released
created_at / expires_at / confirmed_at
lease_version
confirmation_details
```

### `access_tokens/{token_hash}`

Store only the hash, actor/scope, offer or recipient ID, allowed actions, expiry, and revocation
state. Raw 256-bit tokens live in the SPA URL fragment and are exchanged for API access through the
`Authorization: Bearer` header, keeping secrets out of Cloud Run request URLs and referrers.

### `command_receipts/{receipt_id}`

`receipt_id = {actor_scope}:{operation}:{idempotency_key}`. Store the request hash, completion
status, and replayable result. A retry with the same request replays success; the same key with a
different request fails. State, candidate response, event, deterministic notification/reservation,
capacity update, and receipt are written in one transaction when possible. Firestore transaction
retries therefore do not duplicate user-visible side effects.

## API and page contract

### Pages

- `/` — the only HTML shell, with a Donor / Recipient / Coordinator role switcher.
- `/?role=donor` — submission and donor workflow.
- `/?role=status#token=...` — donor status, map, and timeline.
- `/?role=recipient#token=...` — scoped simulated inbox and action view.
- `/?role=ops` — protected coordinator dashboard and impact summary.

The SPA reads raw tokens from the URL fragment, removes the fragment after loading, and sends tokens
only in the `Authorization` header. This avoids dynamic static-file routes and token-bearing request
URLs while keeping shareable simulated-notification links.

### APIs

- `POST /api/match` — preserve the existing stateless deterministic compatibility endpoint.
- `POST /api/agent/run` — execute the ADK `root_agent` and return safe tool-trace metadata.
- `POST /api/intake/extract` — validate text/transcript plus optional photo into an editable draft.
- `POST /api/offers` — create, run the ADK matcher tool path, persist, and start fan-out.
- `GET /api/offers/status` — bearer-scoped donor projection and timeline, polled every two seconds.
- `POST /api/offers/{offer_id}/claim` — atomic temporary reservation.
- `POST /api/reservations/{id}/confirm` — confirm before timeout.
- `POST /api/offers/{offer_id}/decline` — decline and optionally trigger promotion.
- `POST /api/offers/{offer_id}/complete` — minimal completion.
- `POST /internal/tasks/advance-offer` — OIDC-authenticated, versioned reservation/wave task handler.
- `GET /api/recipients/notifications` — bearer-scoped simulated recipient inbox.
- `GET /api/ops/offers` — coordinator list.
- `GET /api/ops/equity-audit` — ten-posting tract-demographic outcome audit.
- `POST /api/ops/offers/{id}/{action}` — controlled reopen/cancel/override/expire/promote actions.
- `POST /api/ops/ask` — ADK + managed BigQuery MCP coordinator question path.
- `POST /api/live/session` — feature-gated, one-use Gemini API ephemeral Live token/configuration.

Use command receipts and idempotency keys on create, claim, confirm, decline, complete, promotion,
and coordinator commands. Treat Cloud Tasks `AlreadyExists` as successful scheduling.

## Location and map behavior

- **Use my location** uses the browser Geolocation API only after explicit consent.
- Address entry remains available through Places autocomplete/geocoding.
- Save which source was used and allow the donor to correct the map pin.
- Exact donor location is visible only to the matched recipient and coordinator.
- Candidate maps may use approximate recipient coordinates from the corpus.
- Prefer Routes API travel duration for final eligibility; fall back to the existing haversine estimate
  with an explicit `Estimated, not live traffic` label.
- Use one route-estimate snapshot per match request; fluctuating live-traffic results must not change
  tie-breaking midway through an evaluation.
- Recipient coordinates are ZIP centroids; label nearest-tract demographics and map positions as
  approximations rather than verified organization locations.
- Use separate restricted browser/server Maps credentials with only required APIs and bounded quotas.
- The map shows state changes and confirmed route; it does not imply live vehicle tracking.

## Notification simulation

Define a provider interface:

```python
notify_recipient(...)
notify_donor(...)
notify_coordinator(...)
```

The first implementation writes a notification document and timeline event. The UI displays unread
badges, message preview, timestamp, deadline, and action link. A later email/SMS provider can consume
the same payload without changing matching or state transitions.

## Security and trust boundaries

- Deploy the hackathon web service with public Cloud Run invocation so no-account donors can open it;
  authorization is enforced inside the application with scoped demo tokens.
- Replace the current broadly privileged runtime identity with a dedicated least-privilege service account.
- Restrict BigQuery access to the required dataset and prefer read-only managed MCP tools.
- Require a separate coordinator bearer secret for every `/api/ops/*` route. Enable recipient role
  switching and coordinator shortcuts only when `DEMO_MODE=true`; label this demo authorization,
  not production identity proofing.
- Require and verify Cloud Tasks OIDC issuer, service account, and audience on `/internal/tasks/*`.
- Use random 256-bit opaque donor/recipient tokens; store only their hashes, scope, actions, and expiry.
- Do not expose exact donor coordinates in recipient fan-out notifications before a valid claim.
- Limit photo type/size, inspect MIME bytes, clean up abandoned drafts, and use lifecycle deletion.
- Rate-limit offer creation and claim endpoints.
- Log state transitions and actor IDs without logging raw tokens, photos, or audio.
- Never return the Cloud Run service-account OAuth token to the browser. Live browser sessions use
  constrained Gemini API ephemeral tokens, or a server-side proxy/fallback.
- Never treat generated recipient capabilities or image analysis as verified food-safety facts.

## Incremental implementation sequence

### Phase 0 — Prove the challenge requirements on the existing slice

- Freeze the 13 existing tests and preserve `POST /api/match`.
- Deploy the current matcher immediately.
- Run `root_agent` through an ADK Runner and prove one `match_surplus_offer` call.
- Enable the Google-managed BigQuery MCP toolset and prove one protected coordinator tool call.
- Add `/readyz` and correlated ADK/BigQuery evidence: agent tool event, BigQuery job ID/query label,
  and safe SQL fingerprint for the brute-force `VECTOR_SEARCH`.

Exit: the existing spinach demo still works; tests remain green; the custom tool, vector query, and
managed MCP call are independently evidenced. Capture this evidence now, not at the end.

### Phase 1 — Provision the minimum real cloud foundation

- Create Firestore, Cloud Tasks queue, task-caller identity/OIDC audience, dedicated runtime service
  account, Cloud Storage bucket/lifecycle, and required secrets.
- Deploy Cloud Run with public invocation and application-level demo authorization.
- Pin Firestore, Tasks, Storage, ADK/Gen AI, and Maps dependencies; copy required
  `data/foodkeeper.json` into the image; validate startup with optional features on and off.
- Add workflow repository, scheduler, notification, token, routing, and model interfaces with
  credential-free in-memory test implementations.

Exit: `/healthz` is live, `/readyz` proves actual dependencies, Firestore writes succeed, and one
OIDC-authenticated no-op task reaches the private task route.

### Phase 2 — Text-only persistent vertical slice

- Extend the matcher with backward-compatible `transport_mode` and a maximum 5 km donor radius.
- Build the single SPA shell and thinnest donor, recipient, and coordinator views.
- Create an offer, persist the audit, check reserved capacity, fan out three deterministic
  notifications, accept/decline, confirm, complete, and display the shared timeline.
- Implement hashed opaque tokens, command receipts, and deterministic side-effect IDs.
- Poll active views every two seconds; stop on terminal state and back off while the page is hidden.

Exit: one text offer completes end to end after refresh without database consoles. This is the first
credible submission and the stop point if time is nearly gone.

### Phase 3 — Real timeout, waves, and concurrency

- Implement the transactional `advance_offer_if_due()` function.
- Schedule real versioned reservation and wave Cloud Tasks through the single callback.
- Add lazy expiry and **Simulate timeout** as recovery/demo controls.
- Test first-accept-wins, cross-offer recipient capacity, command replay, stale lease/wave tasks,
  silent-wave promotion, deadline-clamped holds, and failed/cancelled capacity release.

Exit: two browser sessions produce exactly one hold; real tasks expire reservations and silent waves
without duplicate notifications or overbooking. Stopping here still demonstrates strong execution.

### Phase 4 — Actionable logistics and rigor

- Add GPS consent/address fallback, map pins, donor delivery/pickup choices, and Routes adapter with
  deterministic haversine fallback.
- Enrich top-30 candidates with approximate nearest-tract demographics and create the ten-posting
  equity audit. Clearly label ZIP-centroid and generated operational data limitations.
- Add FoodKeeper as labeled advisory context; the donor-confirmed deadline stays authoritative.
- Finish `needs_transport`, failure, completion quantity, warning, and coordinator controls. Reopen
  only documented safe states; never reopen completed/confirmed work without a compensating release.

Exit: the coordinator receives a specific, actionable match with defensible logistics, need context,
limitations, and outcome evidence—the highest-value Impact and Rigor work after the core flow.

### Phase 5 — Time-boxed multimodal polish and submission evidence

- Add browser dictation into editable text and one server-side Gemini photo-analysis request.
- Require donor confirmation of all inferred quantity, storage, and date fields.
- Enable Gemini 3.8 Live only if the core flow is already green and the live experience materially
  improves the demo; otherwise leave it feature-gated and documented.
- Add Cloud Logging correlation IDs and run deployed safety, accessibility, mobile, and browser E2E.
- Delete photos on completion/cancel/expiry, retain lifecycle cleanup for abandoned drafts, capture
  screenshots plus a backup recording, and update the repo/deck/video with limitations and evidence.

Exit: the pitch artifact can stand alone after judging. Bonus technology is visible only where it
serves the solution and has not displaced the core workflow.

## Test and evaluation plan

### Unit tests

- State-transition allow/deny table.
- Token scope and expiry.
- Wave selection without duplicates.
- Reservation transaction and idempotency.
- Command receipt replays the original success; key reuse with a different request fails.
- Two offers racing for the same recipient cannot exceed its unreserved capacity.
- Stale timeout cannot release a new lease.
- Stale wave task cannot promote twice; silent responses become `timed_out` exactly once.
- Confirmation after expiry fails.
- Expected handoff time must be after now and no later than the donor deadline.
- Hold expiry is clamped to the donor deadline.
- Expired holder cannot reclaim; silent wave expiry promotes exactly once.
- Cloud Task enqueue failure still expires safely through lazy evaluation.
- Notification payload rendering.
- GPS/address normalization and route fallback.
- Donor-delivery radius enforces 5 km / 3.11 mi correctly.
- Nearest-tract need score and missing-demographics fallback are explicit.
- Gemini tool arguments require server validation.

### Integration tests

- Firestore emulator: two recipients accept concurrently; exactly one wins.
- Cloud Tasks handler: verified OIDC task expires an active lease and a silent wave; deterministic
  notification IDs prevent duplicate fan-out.
- Public-access authorization: donor, recipient, coordinator, and task tokens cannot cross scopes.
- BigQuery provider: real top-30 search followed by rules.
- ADK Runner: `root_agent` calls the custom matcher tool; correlated BigQuery job proves vector
  execution; deployed managed-MCP smoke query succeeds and `/readyz` reports the cached result.
- Equity audit: all ten postings resolve to documented tract evidence or a labeled fallback.
- Photo/voice extraction: malformed or incomplete fields return to review, never auto-submit.
- Map outage falls back to estimated distance with a visible warning.

### ADK evaluations

- Agent asks for a missing deadline instead of inventing one.
- Agent always calls the matcher before recommending.
- The deployed agent consumes the managed BigQuery MCP coordinator path at least once.
- Agent never recommends Greenline for refrigerated food.
- Harborview (fixture) and Lakeshore (live corpus) contradictions become human-readable manual review.
- Agent refuses to override an active reservation.
- Agent reports no match honestly.
- Prompt injection inside donor text or a photographed label cannot alter tool policy.

### Browser E2E

1. Donor submits spinach using reviewed text and GPS/address.
2. Three recipient notifications appear.
3. Two recipient sessions race to accept; one wins.
4. Winner confirms within the countdown.
5. Donor and coordinator views update through two-second polling without manual refresh.
6. Handoff is completed and dashboard metrics increment.
7. Repeat with a deliberately expired reservation and verify next-wave promotion, stale-task safety,
   and no immediate re-claim by the expired holder.
8. If Phase 5 shipped, repeat intake with dictation and an optional photo without changing the
   downstream workflow.

## Hackathon demo story

1. **Donor:** enter “I have ten crates of refrigerated spinach that must go in six hours,” confirm
   the fields, and use current location. Dictation/photo is a bonus beat only if already stable.
2. **Agent:** show intake clarification, real BigQuery vector retrieval, and deterministic filtering.
3. **Coordinator:** show the top-three fan-out, Greenline rejection, and contradiction warning.
4. **Recipient A/B:** open two recipient views and accept nearly simultaneously; show only one hold.
5. **Timeout or confirm:** confirm the winner for the main demo; keep an expiration path ready as a second beat.
6. **Map/status:** show the selected route and synchronized donor/coordinator timeline.
7. **Complete:** mark the handoff complete and show impact counters.
8. **Close honestly:** notifications are simulated, recipient operational data is generated, and real
   availability is established only by confirmation.

## Definition of done

The first release is done when:

- A donor can create an offer through reviewed text; optional dictation/photo never blocks this path.
- GPS or address produces a usable donor location.
- The offer persists and survives refreshes.
- The real matcher returns only operationally eligible recipients.
- The deployed workflow runs through the ADK `root_agent`, its custom matcher tool, real vector
  search, and at least one Google-managed BigQuery MCP flow.
- Match evidence includes census-tract need context or an explicit fallback, and the ten-posting
  equity audit is available to the coordinator.
- Exactly three or fewer eligible recipients form the first notification wave.
- Concurrent accepts create exactly one active reservation.
- The winner must confirm within 10 minutes or the hold safely expires.
- A real authenticated Cloud Task expires both reservations and silent waves; recovery paths do not
  create duplicate claims or notifications.
- Donor, recipient, and coordinator views show the same authoritative status.
- A confirmed handoff can be marked complete and reflected in impact metrics.
- The deployed flow passes the safety, concurrency, timeout, and browser E2E suites.
- The demo clearly labels simulated notifications, generated operational profiles, approximate data,
  and all remaining human-verification steps.

## Follow-up roadmap

1. Real email/SMS/push providers.
2. Recipient profile claiming and coordinator verification workflow.
3. Partial acceptance and multi-recipient load splitting.
4. Volunteer-driver matching, route overlap, claims, and live GPS.
5. Uber/Lyft and rescue-marketplace integrations.
6. Agent Runtime deployment, managed sessions/traces, Gemini Enterprise registration, and A2A exposure.
7. Conversational Agents/Dialogflow CX phone or chat intake using the same secure workflow APIs.
8. Production identity, tenancy, consent, retention, abuse prevention, and service-level monitoring.

## Official implementation references

- [Gemini 3.8 Live model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live)
- [Gemini Live ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens)
- [ADK on Agent Runtime](https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/runtime/quickstart-adk)
- [BigQuery managed MCP server](https://docs.cloud.google.com/bigquery/docs/use-bigquery-mcp)
- [Dialogflow CX secure Cloud Run webhooks](https://docs.cloud.google.com/dialogflow/cx/docs/concept/webhook)
