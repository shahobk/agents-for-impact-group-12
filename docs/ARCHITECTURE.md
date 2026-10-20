# Architecture and evidence

## Request path

```text
Coordinator browser
  └─ POST /api/match (offer + operational constraints)
       └─ Matching service / ADK agent
            ├─ BigQuery vector search: top semantic candidates
            └─ Deterministic eligibility + ranking
                 └─ selected match + 2 fallbacks + rejections + outreach
```

The static UI in `frontend/` is served from the same origin as the API and has no build or runtime dependency. It submits JSON to `POST /api/match` and renders the service response without making eligibility decisions in the browser.

## Decision boundary

Vector search retrieves candidates from embedded recipient `profile_text`. It does not decide safety or eligibility. The matcher applies structured checks for storage compatibility, capacity, transport, pickup/service windows, and travel-time margin; only survivors may be selected. Ranking then favors feasibility and time margin, followed by distance, capacity, and an explicit need tie-break.

This separation is the core audit trail:

- semantic score/explanation shows why a recipient may fit the food;
- constraint fields show whether the handoff is operationally possible;
- warnings surface contradictory or uncertain source evidence;
- rejection reasons explain why plausible candidates were excluded.

## API contract used by the UI

Request fields are `description`, `quantity_pallets`, `storage_state`, `pickup_deadline` (ISO-8601), `pickup_location`, `donor_latitude`, `donor_longitude`, and `split_allowed`. The UI also sends temporary quantity and coordinate aliases for integration tolerance; the service remains authoritative.

The preferred response is:

```json
{
  "selected": {},
  "fallbacks": [{}, {}],
  "rejections": [],
  "warnings": [],
  "outreach": "..."
}
```

The client tolerates common naming variants during parallel integration, escapes rendered service text, exposes service errors, and has explicit empty, loading, no-match, and result states.

## Evidence to capture before judging

- BigQuery dataset row counts and the non-empty embedding table.
- A query/job result showing brute-force vector retrieval over recipient profiles.
- For all four validation cases: selected/fallback identities, structured checks, rejection reasons, and warnings.
- A refrigerated case showing that no selected/fallback recipient has `cold_storage = 'none'`.
- A screenshot of the spinach result and a copy of the rendered outreach message.

## Known limitations

- IRS data supplies organization identity/location and reported income; operational capabilities and profile prose are generated.
- Recipient coordinates use approximate ZIP centroids. Distance and travel time are estimates, not live routing.
- The service has no live capacity, open/closed, acceptance, reservation, or dispatch state.
- Donor coordinates and normalized quantities are coordinator-entered and can be wrong.
- FoodKeeper is consumer freshness guidance, not a commercial food-safety guarantee.
- `split_allowed` is collected and disclosed, but baseline matching still requires
  every recommendation to hold the full offer; multi-stop splitting is deferred.
- The UI has no app-level identity or multi-tenancy. The deployed Cloud Run
  service is private behind Google Cloud IAM and has no durable offer history.
