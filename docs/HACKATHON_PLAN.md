# Atlanta Grocery Rescue — Hackathon Plan

## Baseline outcome

A coordinator enters a grocery surplus offer and receives one actionable Atlanta recipient plus two fallbacks, with:

- semantic fit from BigQuery vector search;
- explicit storage, capacity, pickup-window, and distance checks;
- remaining-time margin and a short explanation;
- a ready-to-send outreach message.

Demo first with: **10 crates of spinach, refrigerated, pickup within 6 hours**.

## Critical path

1. **Load Atlanta data**
   - Run `bash scripts/load.sh atlanta`.
   - Confirm `a4i_food` contains non-empty `recipients`, `surplus_postings`, `shelf_life`, and `tract_demographics` tables.
   - Record row counts and validation results for the pitch.

2. **Build embeddings**
   - Embed only `recipients.profile_text` with `gemini-embedding-2`.
   - Materialize `a4i_food.recipient_embeddings`; retain structured recipient columns beside the vector.
   - Keep only rows where `AI.EMBED(...).status = ''` and store `.result` as the embedding.
   - Use brute-force `VECTOR_SEARCH`; this corpus is too small to benefit from a vector index.

3. **Build one matching tool**
   - Input: posting text, quantity/pallet estimate, storage state, pickup deadline, and donor coordinates.
   - Retrieve the top 30 semantic candidates.
   - Apply deterministic filters: storage compatibility, pallet capacity, transport, pickup window, service day, and travel-time margin.
   - Rank survivors by feasibility/time margin, distance, capacity, then an explicit need tie-break.
   - Return the best three with selection and rejection reasons.

4. **Create the ADK agent**
   - Put the Python agent in `agent/`.
   - Give it the custom matching tool above and access to a Google-managed BigQuery MCP server.
   - Agent responsibilities: clarify missing inputs, call the matcher, explain results, and draft outreach.
   - It must refuse to recommend an operationally ineligible recipient.

5. **Create the thinnest useful UI**
   - Start with `adk web` unless a custom UI is already progressing in parallel.
   - Form fields: offer description, quantity, storage state, pickup deadline, pickup location, and split allowed.
   - Result card: recipient, address, fit, capacity, clock/travel margin, warnings, fallbacks, and outreach copy.

6. **Deploy and iterate**
   - Deploy the agent to Agent Runtime or Cloud Run early.
   - Point the UI at the live endpoint.
   - Improve ranking and presentation only after the end-to-end spinach flow works.

## Parallel workstreams

| Lane | First deliverable | Then |
|---|---|---|
| Data/search | Atlanta tables + working spinach vector query | Filters, ranking, four retail-case evaluation |
| Agent | ADK skeleton using mocked matcher output | Connect real matching tool and BigQuery MCP |
| UI | Form and mocked result card | Connect deployed agent and polish demo states |
| Story/QA | One-minute Atlanta grocery narrative | Evidence, limitations, demo script, backup recording |

## Embedding policy

Embed `profile_text`, not the entire row. Do not embed identifiers, address/coordinates, income, demographics, exact capacity, or clock values. Operational dietary/medical restrictions may remain in the profile because they determine whether food can be used.

Vector search generates candidates; it does **not** decide eligibility. Exact constraints remain structured and auditable.

## Fast validation set

Run all four retail postings:

1. Spinach — refrigerated, 6 hours.
2. Milk/yogurt — refrigerated, 8 hours.
3. Bread/pastries — ambient, 24 hours.
4. Prepared sandwiches/salads — refrigerated, 4 hours.

Required checks:

- Greenline ranks semantically but is rejected for no refrigeration.
- Harborview's text/flag contradiction produces a warning or manual-review result.
- Refrigerated recommendations never use `cold_storage = 'none'`.
- Every final match meets capacity and deadline constraints.
- The system returns fallbacks and a clear no-match response.

## Timeboxes

- **T+30 min:** Atlanta tables loaded and verified.
- **T+60 min:** Embeddings and spinach search working.
- **T+120 min:** Real matching tool connected to the ADK agent.
- **T+180 min:** UI calls a deployed endpoint end to end.
- **Final 60–90 min:** Test four retail cases, fix only demo blockers, capture evidence, rehearse.

## Defer until baseline works

- Live traffic or routing APIs.
- Real-time recipient availability/reservations.
- Additional external datasets.
- Load splitting beyond a simple `split_allowed` path.
- Complex vector indexes or model comparisons.
- Authentication, multi-tenancy, and production-grade persistence.

## Honest limitations to state

- Organization identity/location and reported income come from the IRS; operational capabilities and profile prose are generated.
- Recipient coordinates are approximate ZIP centroids.
- Sample postings lack donor coordinates and normalized quantities; the UI must collect them.
- FoodKeeper is consumer freshness guidance, not a commercial food-safety guarantee.
- There is no live capacity, open/closed, acceptance, or reservation state.

## Definition of done

The demo succeeds when a fresh Atlanta grocery offer reaches the deployed agent, invokes real BigQuery vector search, rejects unsafe candidates with deterministic checks, and returns one actionable match plus two fallbacks in the UI.
