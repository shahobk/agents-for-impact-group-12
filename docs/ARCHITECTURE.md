# Pantry Relay architecture and evidence boundary

## System shape

Pantry Relay keeps the first release deliberately small: one Cloud Run service,
one role-switching SPA, one ADK root agent, one deterministic matcher authority,
one workflow repository interface, one opaque-token pattern, and one idempotent
task callback.

```text
Donor / Recipient / Coordinator browser
                  |
                  v
        FastAPI + static SPA (one service)
          |        |             |
          |        |             +-- ADK root agent
          |        |                   |-- custom matcher tool
          |        |                   +-- managed BigQuery MCP analysis path
          |        |
          |        +-- deterministic workflow service
          |              |-- opaque-token authorization
          |              |-- command receipts / idempotency
          |              |-- atomic claims and capacity accounting
          |              +-- advance_offer_if_due()
          |
          +-- deterministic matcher
                 |-- BigQuery top-30 VECTOR_SEARCH
                 +-- storage/capacity/transport/clock/contradiction rules

Cloud target adapters
  |-- Firestore: authoritative mutable workflow state
  |-- Cloud Tasks: versioned reservation and silent-wave callbacks
  |-- Secret Manager: coordinator token and token pepper
  +-- Cloud Storage: lifecycle-managed contingency bucket; current photos are not retained

Local adapters
  |-- in-memory transactional repository
  +-- in-memory scheduler
```

The public Cloud Run checkpoint is revision `00020-yaq` at
<https://atlanta-grocery-rescue-61272668502.us-central1.run.app>, serving 100%
of traffic with optional integrations enabled and verified response hardening.
Revision `00017-rop` receives no traffic and separately proves the service
becomes ready with optional photo, Google geocoding, and Google Routes disabled.
Functional browser and task evidence was captured on revisions `00011-mgf` and
`00015-dlw`. Configuration or resource existence alone is not counted as proof.

## Workflow request path

1. The donor submits reviewed text, normalized quantity, required storage,
   deadline, location, and transport through `POST /api/offers`.
2. An ADK Runner executes `root_agent`, which calls the custom
   `match_surplus_offer` tool. The workflow accepts the structured tool result
   and persists only allowlisted trace metadata; deterministic code remains the
   authority for retrieval, eligibility, ranking, and state transitions.
3. BigQuery semantic search retrieves candidates. Structured code rejects any
   candidate that fails storage, full quantity, transport, service horizon,
   deadline, route, or contradiction checks.
4. The repository persists the offer, complete candidate audit, first wave of
   up to three recipients, deterministic simulated notifications, timeline,
   and role projections.
5. A recipient claim transaction rechecks eligibility and unreserved capacity,
   then creates at most one active reservation with
   `expires_at = min(now + 10 minutes, offer.deadline)`.
6. Confirmation requires a future handoff no later than the donor deadline and
   invalidates competing actions. Completion alone increments impact.
7. Reservation and wave tasks call the same `advance_offer_if_due()` transition.
   Lease and wave versions make stale callbacks harmless. The coordinator’s
   **Simulate timeout** is a labeled demo/recovery accelerator, not a substitute
   for Cloud Tasks proof.

`POST /api/match` remains as a stateless compatibility endpoint. It is not the
persistent offer/claim workflow.

## Authoritative state

BigQuery is the retrieval and analytics system; it never owns a live hold.
Firestore is the cloud target for mutable operational state:

- offers, deadlines, wave/lease versions, selected recipient, and outcomes;
- complete candidate decisions and response states;
- append-only display-safe events;
- flat simulated notification records;
- recipient capacity and reserved capacity;
- reservations;
- hashes and scopes for opaque tokens; and
- command receipts for replay-safe mutations.

The local repository implements the same workflow interface in memory so unit
and browser tests do not require credentials. Local success alone is not cloud
proof; the production browser, readiness, and task records separately establish
the deployed Firestore path.

## Decision boundary and invariants

The LLM interprets and explains. Deterministic code decides eligibility and
state transitions.

- One offer has at most one active reservation.
- One recipient cannot exceed known capacity across concurrent offers.
- Candidate responses are exactly `pending`, `declined`, `holding`,
  `hold_expired`, `timed_out`, `won`, or `invalidated`.
- Only an eligible recipient in the current wave may claim.
- Donor delivery is limited to 5 km unless a documented demo override exists.
- Confirmation requires `now < expected_handoff_time <= offer.deadline`.
- Failed, cancelled, expired, and released work frees reserved capacity.
- Firestore retries, HTTP retries, and task retries must not duplicate state,
  events, reservations, capacity, or notifications.
- Only completed offers increment impact.

Semantic distance explains why a recipient may be relevant; it never excuses a
failed hard constraint. Candidate evidence and rejection reasons remain visible
to the coordinator.

## Browser and authorization contract

The same HTML shell serves these views:

- `/?role=donor` — reviewed intake;
- `/?role=status#token=...` — private donor status and timeline;
- `/?role=recipient#token=...` — scoped recipient inbox and actions; and
- `/?role=ops` — coordinator queue and impact behind a separate bearer token.

The SPA reads an opaque token from the URL fragment, removes the fragment with
`history.replaceState`, keeps the token only for the browser session so refresh
works, and sends it only in the `Authorization` header. It never prints the
token. Mutations carry an `X-Idempotency-Key`. Donor/recipient/coordinator/task
tokens cannot cross scopes.

Active views poll every two seconds, back off to fifteen seconds while hidden,
and stop when relevant offers are terminal. Exact donor coordinates are hidden
from a recipient until that recipient has a valid claim.

## Real versus simulated or approximate

| Area | Evidence label |
|---|---|
| Workflow rules, authorization checks, state machine, command receipts | Real deterministic code |
| Local transactional workflow | Verified with in-memory adapters and integrated browser checks |
| Public Cloud Run revision | Production `00020-yaq`; functional flow passed on its feature-enabled predecessors and response-hardening headers passed on `00020-yaq` |
| Firestore and Cloud Tasks adapters | Deployed readiness, authenticated no-op, production reservation expiry, wave promotion, and capacity release verified |
| BigQuery vector search | Real top-30 brute-force challenge path; deployed offer job `8c4be85d-4cab-4913-be2a-bccd9f3dd568` |
| ADK/custom matcher and managed MCP | Real Runner/custom-tool path and protected managed-MCP call independently recorded |
| Notifications | Simulated in-app inbox only |
| Organization identity and IRS attributes | Source data |
| Operational capabilities and recipient profile prose | Generated demo attributes |
| Recipient coordinates | Approximate ZIP centroids |
| Tract need evidence | Approximate nearest-tract context or an explicitly labeled fallback |
| Geocoding and Routes | Real Google address/route calls when available; explicitly labeled bounded fallback otherwise |
| Photo extraction | Real server-side Gemini suggestions; review required and image not retained |
| FoodKeeper | Advisory context; donor deadline remains authoritative |
| Identity | Scoped demo authorization, not production identity proofing |

## Current limitations

- Real email, SMS, and push delivery are intentionally absent.
- Recipient onboarding, production identity, load splitting, volunteer-driver
  dispatch, multi-stop routes, and moving-driver GPS are deferred.
- Live capacity, staffing, business hours, and operational profile details must
  be reconfirmed by the recipient.
- Automated Chromium cannot provide real microphone speech recognition. A
  browser fake verifies dictation lifecycle safety; a supported interactive
  browser is still needed for a live-microphone check.
- Gemini photo extraction is deployed and verified, but images are processed
  transiently and never retained by Pantry Relay.
- Gemini 3.8 Live is intentionally deferred and is not a dependency of the
  verified workflow.
- A local coordinator timeout check proves the UI/recovery transition, not
  Cloud Tasks OIDC delivery.
- Exact `/healthz` is intercepted with a Google Front End 404 on the default
  `run.app` domain; `/healthz/` reaches the app and returns 200.
- Production responses include verified CSP, HSTS, `X-Frame-Options`,
  `X-Content-Type-Options: nosniff`, and `Permissions-Policy` headers.

See [VALIDATION.md](./VALIDATION.md) for results and remaining limitations, and
[DEMO.md](./DEMO.md) for the honest presentation path.
