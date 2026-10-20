# Resilient Food Equity & Surplus Broker — ADK Agent (`agent/`)

**Challenge 2 — Agents for Impact 2026**
- **Metro:** **Atlanta, GA** (`135` food-rescue organizations in `a4i_food.recipients`, `114` populated census tracts in `a4i_food.tract_demographics`)
- **Track:** **Combined Retail & Grocer Rescue (`RETAIL`) + Farm & Agricultural Surplus (`FARM`)** (plus support for `ESSENTIALS`), proving the core thesis of Challenge 2: **one semantic vector-search architecture with post-search operational and equity constraints handles urgent storefront drops, 10-pallet farm load splits, and temperature-sensitive clinical supplies from a single corpus.**

---

## Opening Scenario

> *"We coordinate food rescue in **Atlanta, Georgia**. A restaurant depot has just offered us **4 pallets of triple-washed baby spinach in sealed bags** (cold-stored since 5am, dock closes in **6 hours**), and a regional grower has **5 tons (10 pallets) of russet potatoes** that no single neighborhood pantry can absorb whole. Here is who we call, why the top semantic match is a trap, how we rescue transit-isolated pantries with volunteer drivers, and how we split pallets proportionally across low-income neighborhoods."*

---

## Architecture & Tooling (`agent/agent.py`)

Our ADK agent ([`root_agent`](agent.py)) combines **7 purpose-built Python broker tools** with **ADK's Managed `BigQueryToolset` / MCP Toolbox (`tools.yaml`)**:

| Tool | Type | Purpose |
| :--- | :--- | :--- |
| [`lookup_shelf_life`](agent.py) | Custom Python Tool | Queries `a4i_food.shelf_life` (USDA FSIS FoodKeeper, 661 products), separates prior cold-storage `elapsed_hours` from `donor_hours_available`, computes `hours_remaining = min(donor_hours_available, biological_remaining_hours)`, and generates **Clock Optimization Strategies**. |
| [`find_matching_recipients`](agent.py) | Custom Python Tool + **BigQuery `VECTOR_SEARCH`** | Runs `VECTOR_SEARCH` (`AI.EMBED` with `gemini-embedding-2`) over `a4i_food.recipient_embeddings`, spatially joins `a4i_food.tract_demographics` via `ST_DISTANCE`, eliminates **near-miss decoys** and **profile contradictions**, evaluates **Self-Pickup vs. Volunteer Driver Rescue**, and computes a **Need-Proportional Pallet Split (`multi_stop_split_plan`)** weighted toward low-income neighborhoods (`1.35x` boost). |
| [`decline_recipient_and_reroute`](agent.py) | Custom Python Tool | Solves the *"They said no. Who's next?"* problem by deducting elapsed waiting time from `hours_remaining`, eliminating recipients whose pickup windows no longer fit the tighter clock, and promoting the next best viable recipient. |
| [`check_fda_food_recalls`](agent.py) | Custom Python Tool (Live CC0 API) | Queries the public-domain [`openFDA Food Enforcement API`](https://api.fda.gov/food/enforcement.json) for ongoing recalls affecting `GA` before dispatching a driver, surfacing recalling firms, classifications (`Class I`/`II`), and lot codes (`code_info`). |
| [`onboard_new_pantry`](agent.py) | Custom Python Tool + Live `AI.EMBED` | **The "4-Hour Add-On" Conversational Intake Agent**: interviews a new pantry coordinator (asking whether loads must come in as hand-unloaded crates vs. full pallets, cold storage type, and dietary needs), writes the row to `a4i_food.recipients`, and **immediately embeds it into `a4i_food.recipient_embeddings`** so it is searchable via `VECTOR_SEARCH` in the next turn. |
| [`run_metro_equity_audit`](agent.py) | Custom Python Tool | Runs our matcher across all 10 postings in `a4i_food.surplus_postings` and compares the matched census tracts against the population-weighted Atlanta metro baseline and a naive logistics-only baseline. |
| [`list_surplus_postings`](agent.py) | Custom Python Tool | Lists incoming surplus postings in `a4i_food.surplus_postings` sorted by urgency (`hours_remaining ASC`). |
| `BigQueryToolset` & `McpToolset` ([`tools.yaml`](tools.yaml)) | Managed MCP / ADK Integration | Handles generic table/schema inspection (`list_dataset_ids`, `list_table_ids`, `get_table_info`, `execute_sql`) and parameterized MCP Toolbox queries. |

---

## Direct Answers to the Judging Rubric ("How You'll Be Judged")

### 1. Why Vector Search Is the Candidate Generator — Not the Final Answer
- A posting for *"10 crates of spinach, harvested yesterday, needs cold storage"* and a pantry profile saying *"we serve 200 families, we have refrigeration, we need fresh greens"* share almost no keywords, while a soup kitchen saying *"hot meals nightly, no cold storage"* matches the keyword `"cold storage"` for the opposite reason.
- However, pure semantic similarity is dangerous without post-search constraint verification:
  - **Planted Semantic Decoy Caught:** `Greenline Community Pantry` ranks near the top semantically for fresh produce and leafy greens, but has `cold_storage = 'none'`. Our filter eliminates it and explains why.
  - **Planted Profile Contradiction Caught:** `Harborview Neighbors Trust` claims a *"commercial walk-in freezer and loading dock"* in one sentence and *"a single cupboard shelf with no refrigerator or freezer on site"* in the next (`profile_source = 'planted'`). Our contradiction detector ([`_has_profile_contradiction`](agent.py)) flags and eliminates it before any food is dispatched.

### 2. Data Provenance: Which Half Is Real vs. Generated
- **What is REAL:**
  1. **Organizations (`a4i_food.recipients`):** Real tax-exempt organizations, names, addresses, NTEE codes, and `reported_income` from the **IRS Exempt Organizations Business Master File** (17 U.S.C. § 105 public domain).
  2. **The Spoilage Clock (`a4i_food.shelf_life`):** Real **USDA FSIS FoodKeeper** data (661 products, CC0 public domain).
  3. **Neighborhood Need (`a4i_food.tract_demographics`):** Real **US Census American Community Survey (ACS)** tract-level poverty rate, median household income, no-vehicle household rate, and public assistance rate.
  4. **Recall Safety (`check_fda_food_recalls`):** Real-time **openFDA Food Enforcement API** (CC0 public domain).
- **What is GENERATED (and why):**
  - Every pantry's operational details (`cold_storage`, `frozen_storage`, `loading_dock`, `refrigerated_transport`, `max_pallets`, `pickup_window_hours`, `service_days`, and `profile_text`) are synthetically generated from 14 archetypes (modeled on public Seattle/King County and Pennsylvania profiles), seeded deterministically by EIN and scaled by each organization's real IRS `reported_income`.
  - **Why:** No centralized public dataset of pantry cold-storage or pallet capacity exists anywhere in the United States. That is also why we built [`onboard_new_pantry`](agent.py) — to close that exact gap conversationally.

### 3. Data Validation Findings (What We Checked Before Building)
1. **US Census ACS Missing-Value Sentinel (`-666666666.0`):**
   - Inspecting `a4i_food.tract_demographics` in Atlanta revealed 51 unpopulated/special census tracts where `median_income = -666666666.0` (the standard US Census ACS sentinel for missing data). Without filtering `WHERE total_pop > 0 AND median_income > 0`, spatial joins attach corrupt negative incomes to nearby pantries.
2. **USDA FoodKeeper Infant Formula 1-Hour Trap (`Posting #8`):**
   - In `a4i_food.surplus_postings`, Posting #8 (*"48 cases of sealed infant formula, 8 months to expiry"*) had `shelf_life_hours = 1.0` because the raw USDA FoodKeeper entry for `"Formula"` reflects an *open, prepared liquid bottle at room temperature* (`1 hour`), whereas factory-sealed cases have `8 months` (`168h` donor pickup window). Our [`lookup_shelf_life`](agent.py) explicitly checks `is_sealed` to prevent false expiration refusals.
3. **Storage Time vs. Pickup Window Separation:**
   - When a donor states *"cold-stored since 5am, dock closes in 6 hours"*, the 9 hours in cold storage deduct from the 72-hour biological shelf life of spinach (`63h` biological life remaining), leaving the full `6.0h` dock window intact (`min(6.0, 63.0) = 6.0h`).

### 4. Bias Handling & The 10-Posting Metro Equity Audit
- **Responsible AI Embedding Boundary:** Operational and dietary constraints (e.g., halal/kosher observance, infant nutrition, hand-unloaded crates vs. full pallets) belong in `profile_text` because ignoring them causes wasted food drops. Demographic priority signals are kept out of the text embedding and evaluated transparently via census tract geography (`tract_poverty_rate`, `tract_median_income`, `tract_no_vehicle_rate`).
- **"Did the food go where the need is, or where the loading docks are?"**
  Running [`run_metro_equity_audit`](agent.py) across all 10 postings in Atlanta (`a4i_food` in BigQuery) proves how our broker overcomes "loading dock bias":

| Audit Metric | Atlanta Metro Baseline (`114` Valid Tracts) | Naive Semantic / Logistics Baseline *(Self-Pickup & Single-Stop Only)* | Our Equity-Weighted & Driver-Rescued Broker (`18` Drops Across `10` Postings) |
| :--- | :---: | :---: | :---: |
| **Avg. Tract Poverty Rate** | `21.7%` | `32.0%` | **`33.5%`** *(+11.8 pts above metro)* |
| **Avg. Tract No-Vehicle Rate** | `15.9%` | `24.4%` | **`26.1%`** *(1.64× metro baseline)* |
| **Avg. Tract Median Household Income** | `$55,949` | `$35,319` | **`$34,899`** *($21,050 below metro avg)* |
| **Share Going to Commercial Loading Docks** | — | **`80.0%`** *(skews to large warehouses; drops 5-ton potato load)* | Splits bulk loads across **high-need storefront pantries** |
| **Share in Low-Income Neighborhoods** | — | — | **`100.0%`** |

### 5. Honest Limitations (What Our System Cannot Do Yet)
1. **Consumer Guidance vs. Commercial Cold-Chain Telemetry:** USDA FoodKeeper provides consumer home-storage quality guidance, not commercial cold-chain microbiology or real-time pallet temperature sensor telemetry.
2. **ZIP-Centroid Coordinates vs. Turn-by-Turn Traffic:** Organization coordinates derive from IRS ZIP centroids and census tract internal points (`ST_DISTANCE`), not live Google Maps truck-routing with bridge/dock clearances.
3. **Analytics Warehouse vs. Transactional Claim Locking:** BigQuery is an analytical warehouse (`OLAP`). While appending a new pantry via `onboard_new_pantry` is low-concurrency and safe, preventing two volunteer drivers from claiming the same pallet in the same millisecond requires a transactional database (`Firestore`, `Cloud SQL`, or `AlloyDB`).

---

## Running Locally & Deploying to Google Cloud Run

### 1. Local Development (`adk web`)
```bash
pip install -r agent/requirements.txt
cp agent/.env.example agent/.env
# Edit agent/.env to set GOOGLE_CLOUD_PROJECT
adk web
```

### 2. Deploy to Google Cloud Run
```bash
bash scripts/deploy_cloud_run.sh
```
