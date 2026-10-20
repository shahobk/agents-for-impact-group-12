# Demo validation

Run these cases against the same deployed endpoint used in the presentation. Record the selected recipient, two fallbacks, rejected candidates/reasons, warnings, capacity result, travel estimate, and time margin. Mark a case passing only when every returned recommendation meets all hard constraints.

## Four-case checklist

- [x] **Spinach:** “10 crates of fresh spinach, bagged,” refrigerated, 1 pallet, deadline in 6 hours, downtown Atlanta donor coordinates. Confirm a selected match and up to two eligible fallbacks; Greenline may rank semantically but must be rejected for no refrigeration.
- [x] **Milk and yogurt:** “Mixed cases of milk and yogurt,” refrigerated, 2 pallets, deadline in 8 hours. Confirm every recommendation supports refrigeration, fits quantity, and retains a positive travel-time margin.
- [x] **Bread and pastries:** “Day-old packaged bread and assorted pastries,” ambient, 1 pallet, deadline in 24 hours. Confirm ambient-compatible recipients remain eligible and ranking/rejections are explained.
- [x] **Prepared sandwiches and salads:** “Prepared sandwiches and salads, kept refrigerated,” refrigerated, 0.5 pallets, deadline in 4 hours. Confirm the shorter window is enforced and no recommendation has a non-positive time margin.

## Cross-case assertions

- [x] No refrigerated recommendation has `cold_storage = 'none'`.
- [x] Every selected/fallback recipient passes capacity, transport, pickup/service-window, and deadline checks.
- [x] Harborview’s profile/flag contradiction produces a visible warning or manual-review result; it must not silently become an eligible recommendation.
- [x] When eligible results exist, the response includes one selected match and up to two fallbacks plus outreach copy.
- [x] A deliberately impossible offer (large quantity and near-immediate deadline) produces a clear no-match state with rejection reasons, not an ineligible suggestion.
- [x] API failure produces a readable error and retry control; the form values remain intact.
- [x] At 375 px and desktop width, labels, controls, result cards, and copy control remain readable and keyboard-accessible.

## Evidence log

| Case | Selected | Fallbacks | Key rejection/warning | Pass |
|---|---|---|---|---|
| Spinach | Seed Of Georgia | Second Helpings Atlanta; Food Flow Collaborative | Greenline rejected; Lakeshore contradiction warned | Pass |
| Milk/yogurt | Seed Of Georgia | Second Helpings Atlanta; Helping Hands Holiday Dinner | No recommendation lacked refrigeration; all margins positive | Pass |
| Bread/pastries | A Beautiful Creation Pantry | New Testament Refuge Ministries; Cedar Street Produce Alliance | Capacity/service-day rejections present | Pass |
| Sandwiches/salads | New Testament Refuge Ministries | Helping Hands Holiday Dinner | 28 candidates rejected by the 4-hour constraints | Pass |

Endpoint/build tested: private Cloud Run revision `atlanta-grocery-rescue-00001-8qd`,
`https://atlanta-grocery-rescue-61272668502.us-central1.run.app` (via authenticated proxy).
Tester and timestamp: Codex orchestration run, 2026-10-20 (America/Toronto).

## Loaded-data evidence

- `recipients`: 135 rows; `recipient_embeddings`: 135 successful vectors.
- `surplus_postings`: 10 rows; `shelf_life`: 661 rows;
  `tract_demographics`: 165 rows.
- Recipient profiles are 100% distinct in the loaded Atlanta corpus.
- Live spinach retrieval used top-30 brute-force `VECTOR_SEARCH`; the deployed
  `POST /api/match` returned HTTP 200 with one selection and two fallbacks.
- Impossible-offer probe returned `no_match: true`, no selected/fallback rows,
  and 30 explicit rejections.
