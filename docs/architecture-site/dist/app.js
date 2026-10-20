(function () {
  "use strict";

  const statusLabels = { live: "Implemented", progress: "In progress", next: "Next" };

  function component(id, col, row, kind, layer, title, summary, status, owns, boundary, dependencies, drill) {
    return { id, col, row, kind, layer, title, summary, status, owns, boundary, dependencies, drill };
  }

  function edge(from, to) { return { from, to }; }

  const common = {
    current: {
      overview: {
        title: "System map",
        summary: "The deployed modular monolith: review-first intake, agent-orchestrated matching, and transactional handoff.",
        nodes: [
          component("experience", 1, 2, "experience", "Experience", "Role-switching web app", "Agent-first donor intake, private status, recipient inbox, and coordinator operations.", "live", ["Accept text, browser dictation, and optional photos", "Render inline clarification and map review", "Store only scoped demo context in the browser session"], "The browser confirms facts and presents actions; it never decides eligibility or owns workflow state.", ["Review-first intake", "Cloud Run + FastAPI"], null),
          component("intake", 2, 1, "agent", "Human-in-the-loop AI", "Review-first intake", "Latency-bounded Gemini suggestions, deterministic fallback, inline questions, and location confirmation.", "live", ["Extract an editable offer draft", "Fall back if model interpretation exceeds 15 seconds", "Ask only for missing or low-confidence fields"], "This endpoint never creates an offer. Photo bytes are transient and every inferred field remains editable.", ["Role-switching web app", "Vertex AI + Maps"], "intake"),
          component("api", 2, 2, "platform", "Application edge", "Cloud Run + FastAPI", "One hardened service hosts the SPA, APIs, agent runtime, and adapters.", "live", ["Validate and rate-limit public requests", "Apply CSP, HSTS, and request correlation", "Route typed commands to the owning authority"], "Public access does not imply public authority; protected operations remain scoped server-side.", ["ADK root agent", "Transactional workflow", "Scoped demo authorization"], null),
          component("auth", 2, 3, "authority", "Access boundary", "Scoped demo authorization", "Opaque donor/recipient capabilities, coordinator session cookie, and task OIDC.", "live", ["Separate actor and action scopes", "Keep coordinator secrets out of the browser", "Hide exact pickup data until a valid claim"], "This is demo authorization, not production identity proofing or recipient onboarding.", ["Cloud Run + FastAPI", "Transactional workflow", "Secret Manager"], null),
          component("agent", 3, 1, "agent", "Orchestration", "ADK root agent", "One root agent invokes the custom matching tool and exposes protected analysis.", "live", ["Execute through an ADK Runner", "Call match_surplus_offer with reviewed facts", "Persist only allowlisted trace evidence"], "The agent can invoke and explain; it cannot change the matcher result or workflow state.", ["Deterministic matching pipeline", "Managed BigQuery MCP"], "agent"),
          component("matcher", 3, 2, "authority", "Eligibility authority", "Deterministic matching pipeline", "BigQuery top-30 retrieval followed by operational and route constraints.", "live", ["Generate semantic candidates", "Enforce storage, full quantity, transport, service horizon, deadline, route, and contradiction rules", "Return eligible, fallback, rejected, warning, and proof records"], "Semantic relevance proposes candidates. Deterministic code alone decides eligibility.", ["BigQuery retrieval + equity", "Google Maps Routes"], "matcher"),
          component("workflow", 3, 3, "authority", "State authority", "Transactional workflow", "Offer waves, claims, holds, confirmation, completion, and recovery.", "live", ["Own the workflow state machine", "Make first-claim-wins and capacity accounting atomic", "Make HTTP and task retries idempotent"], "Every mutable operational action passes through one repository transaction.", ["Firestore + Cloud Tasks", "Scoped demo authorization"], "workflow"),
          component("bigquery", 4, 1, "data", "Retrieval & analytics", "BigQuery retrieval + equity", "Embeddings, profiles, top-30 vector search, tract context, and ten-posting audit.", "live", ["Run brute-force VECTOR_SEARCH", "Attach nearest-tract need evidence", "Support protected coordinator analysis through managed MCP"], "BigQuery never owns a live claim, hold, capacity value, or workflow transition.", ["Deterministic matching pipeline", "ADK root agent"], "bigquery"),
          component("operations", 4, 2, "data", "Operational platform", "Firestore + Cloud Tasks", "Authoritative mutable state with versioned OIDC-authenticated callbacks.", "live", ["Persist offers, candidates, reservations, events, tokens, and receipts", "Expire holds and advance silent waves", "Ignore stale or duplicate delivery"], "The bounded Firestore state document favors hackathon atomicity; Cloud Tasks can trigger only the same deterministic transition.", ["Transactional workflow"], "workflow"),
          component("integrations", 4, 3, "platform", "Google Cloud services", "Vertex AI + Maps + Secrets", "Gemini intake; browser Maps/Places; server geocoding and traffic-aware routes; restricted secrets.", "live", ["Interpret text and optional photos", "Search, display, adjust, geocode, and route pickup locations", "Keep server credentials outside source and restrict the public Maps key by referrer and API"], "The browser Maps key is intentionally public but narrowly restricted. Intake photos are transient; the contingency bucket grants the runtime no object access.", ["Review-first intake", "Deterministic matching pipeline", "Cloud Run + FastAPI"], null),
        ],
        edges: [edge("experience", "intake"), edge("experience", "api"), edge("auth", "api"), edge("api", "agent"), edge("agent", "matcher"), edge("matcher", "bigquery"), edge("api", "workflow"), edge("workflow", "operations"), edge("workflow", "auth"), edge("workflow", "integrations")],
      },
    },
    target: {
      overview: {
        title: "System map",
        summary: "The next production boundary: preserve the proven core while replacing demo-only identity and delivery.",
        nodes: [
          component("experience", 1, 2, "experience", "Experience", "Production role experience", "Accessible donor, verified recipient, and coordinator journeys across web and message channels.", "progress", ["Keep the agent-first intake and review", "Add production onboarding and recovery", "Expose evidence at the right level for each role"], "Human confirmation remains mandatory for inferred offer facts.", ["Review-first intake", "Cloud Run application edge"], null),
          component("intake", 2, 1, "agent", "Human-in-the-loop AI", "Review-first multimodal intake", "The implemented Gemini, speech, photo, questions, and map-review boundary.", "live", ["Preserve transient media processing", "Support richer packaging and label evidence", "Retain field-level confidence and provenance"], "AI remains a suggestion layer; a donor owns the submitted offer.", ["Production role experience", "Vertex AI + Maps"], "intake"),
          component("api", 2, 2, "platform", "Application edge", "Cloud Run application edge", "Keep the modular monolith until traffic or team ownership justifies service separation.", "live", ["Host the public experience and API", "Apply consistent request policy", "Route commands to explicit authorities"], "Do not create microservices without a measurable scaling or ownership need.", ["Root broker agent", "Transactional workflow", "Production identity"], null),
          component("auth", 2, 3, "authority", "Access boundary", "Production identity & consent", "Verified organizations, recipient onboarding, scoped roles, and consented location sharing.", "next", ["Replace demo capabilities with durable identities", "Approve and refresh recipient profiles", "Audit consent for exact-location disclosure"], "Authentication must not silently convert generated capability data into verified operational truth.", ["Cloud Run application edge", "Transactional workflow"], null),
          component("agent", 3, 1, "agent", "Orchestration", "Root broker agent", "Retain one agent and add tools only behind explicit, typed contracts.", "live", ["Invoke matching and protected analysis", "Explain authoritative results", "Add status tools only when they cannot bypass workflow policy"], "Avoid a fragile autonomous multi-agent graph; services keep authority.", ["Eligibility authority", "Managed BigQuery MCP"], "agent"),
          component("matcher", 3, 2, "authority", "Eligibility authority", "Eligibility authority", "The implemented vector-retrieval and hard-constraint pipeline.", "live", ["Add verified live availability inputs", "Keep rejection evidence complete", "Evaluate route and capacity changes at claim time"], "No unsafe candidate can be restored by model reasoning.", ["BigQuery retrieval + equity", "Maps Platform"], "matcher"),
          component("workflow", 3, 3, "authority", "State authority", "Transactional workflow", "The implemented command model, extended to real delivery and onboarding events.", "live", ["Preserve first-claim-wins", "Protect capacity across offers", "Publish replay-safe notification work"], "All mutable state remains deterministic and transactionally validated.", ["Entity-oriented Firestore", "Cloud Tasks", "Notification gateway"], "workflow"),
          component("bigquery", 4, 1, "data", "Retrieval & analytics", "BigQuery retrieval + equity", "The implemented retrieval store, extended with governed profile refresh and evaluation history.", "live", ["Version profile and embedding inputs", "Measure match quality and equity", "Retain bounded analytical provenance"], "Analytics and retrieval never become the live reservation system.", ["Eligibility authority", "Root broker agent"], "bigquery"),
          component("operations", 4, 2, "data", "Operational platform", "Entity-oriented Firestore", "Offers, candidates, events, recipients, reservations, capabilities, and receipts as bounded entities.", "next", ["Scale targeted transactional reads", "Keep cross-offer capacity invariants", "Support lifecycle and retention policy per entity"], "Decomposition may change storage shape, never transaction semantics.", ["Transactional workflow", "Cloud Tasks"], "workflow"),
          component("integrations", 4, 3, "platform", "Delivery & cloud services", "Notification gateway + Google Cloud", "Real email/SMS/push delivery with an outbox, plus existing Gemini, Maps, Tasks, and Secrets.", "next", ["Separate delivery from workflow decisions", "Use deterministic notification IDs", "Track delivery status without duplicating state transitions"], "External delivery acknowledges messages; it cannot decide eligibility or advance workflow state.", ["Transactional workflow", "Production role experience"], null),
        ],
        edges: [edge("experience", "intake"), edge("experience", "api"), edge("auth", "api"), edge("api", "agent"), edge("agent", "matcher"), edge("matcher", "bigquery"), edge("api", "workflow"), edge("workflow", "operations"), edge("workflow", "auth"), edge("workflow", "integrations")],
      },
    },
  };

  const drilldowns = {
    intake: {
      title: "Review-first intake",
      summary: "AI structures the conversation, the interface resolves uncertainty, and the donor confirms every submitted fact.",
      parent: "intake",
      nodes: [
        component("donor-input", 1, 2, "experience", "Browser input", "Text, speech & photo", "Free text, editable browser transcript, or an optional image starts the offer.", "live", ["Keep the donor's original description", "Expose microphone lifecycle", "Validate image type and size before model use"], "Microphone audio is not retained; photo bytes are processed transiently and never stored.", ["Gemini interpreter", "Deterministic fallback"], null),
        component("gemini-intake", 2, 1, "agent", "Vertex AI", "Gemini interpreter", "Server-side structured suggestions with field-level confidence and a bounded response time.", "live", ["Extract quantity, storage, deadline, and transport", "Resolve relative Atlanta-local time", "Return JSON-shaped draft or fall back after 15 seconds"], "Gemini never judges food safety, invents location, blocks the composer indefinitely, or submits an offer.", ["Question generator", "Deterministic fallback", "Donor review"], null),
        component("fallback", 2, 3, "authority", "Resilience", "Deterministic fallback", "Conservative parsing keeps text intake useful if the model is unavailable.", "live", ["Recognize bounded quantities and storage terms", "Resolve explicit relative time", "Label low-confidence pallet normalization"], "Fallback behavior remains conservative and cannot fill unsupported facts.", ["Question generator"], null),
        component("questions", 3, 2, "experience", "Clarification", "Inline question generator", "Tap-to-answer prompts appear only for missing or uncertain fields.", "live", ["Ask about amount, storage, deadline, and transport", "Offer bounded choices", "Keep all answers editable in the review"], "A low-confidence inference is treated like a missing answer until the donor confirms it.", ["Donor review"], null),
        component("location", 3, 3, "platform", "Maps", "Location confirmation", "Places search, device position, or an adjustable Maps JavaScript pin becomes a reviewed pickup point.", "live", ["Use a referrer- and API-restricted browser key", "Bias server geocoding to Atlanta", "Show the selected address and require explicit review"], "Exact coordinates stay scoped and never become eligibility evidence before confirmation.", ["Donor review", "Maps JavaScript", "Places", "Geocoding"], null),
        component("review", 4, 2, "authority", "Human authority", "Donor review", "One editable confirmation assembles the facts that may enter offer creation.", "live", ["Show provenance and warnings", "Confirm all required fields", "Submit only the reviewed payload"], "The intake endpoint cannot create an offer; only this confirmed payload crosses into workflow.", ["Cloud Run + FastAPI"], null),
      ],
      edges: [edge("donor-input", "gemini-intake"), edge("donor-input", "fallback"), edge("gemini-intake", "questions"), edge("fallback", "questions"), edge("questions", "review"), edge("location", "review")],
    },
    agent: {
      title: "Agent runtime",
      summary: "Offer matching traverses one ADK Runner and one custom tool; intake and workflow remain separate bounded services.",
      parent: "agent",
      nodes: [
        component("runner", 1, 2, "platform", "ADK runtime", "ADK Runner", "Creates an isolated session and executes root_agent for each matching request.", "live", ["Own the ADK session lifecycle", "Collect tool-call events", "Delete transient sessions after use"], "Raw prompts and model events remain transient.", ["Root broker", "Safe trace reducer"], null),
        component("root", 2, 2, "agent", "Coordinator", "Root broker", "Receives reviewed offer facts and invokes explicit tools.", "live", ["Call the custom matcher tool", "Use tool output as authoritative", "Explain structured evidence"], "Cannot change eligibility, capacity, or workflow state.", ["match_surplus_offer", "Managed BigQuery MCP"], null),
        component("match-tool", 3, 1, "agent", "Custom function tool", "match_surplus_offer", "Typed bridge from ADK to the deterministic matcher.", "live", ["Validate tool arguments", "Run retrieval off the event loop", "Return selected, fallback, rejected, warnings, and proof"], "The tool delegates the decision to deterministic matcher code.", ["Eligibility authority"], null),
        component("mcp", 3, 3, "platform", "Protected analysis", "Managed BigQuery MCP", "Read-only coordinator analysis, independently evidenced from matching.", "live", ["Use Google-managed MCP", "Run protected analytical tools", "Support coverage and equity questions"], "MCP never bypasses the custom matcher or exposes anonymous arbitrary querying.", ["BigQuery"], null),
        component("evidence", 4, 2, "platform", "Observability", "Safe trace reducer", "Allowlisted agent, tool, latency, and correlated retrieval evidence.", "live", ["Prove the root agent ran", "Record the custom tool name and status", "Correlate the BigQuery job without retaining prompt content"], "Tokens, prompts, raw model events, and secrets are excluded.", ["ADK Runner", "Transactional workflow"], null),
      ],
      edges: [edge("runner", "root"), edge("root", "match-tool"), edge("root", "mcp"), edge("runner", "evidence"), edge("match-tool", "evidence")],
    },
    matcher: {
      title: "Matching decision",
      summary: "Vector retrieval improves recall; hard rules and bounded route evidence decide who is operationally eligible.",
      parent: "matcher",
      nodes: [
        component("offer", 1, 2, "experience", "Reviewed input", "Typed offer", "Confirmed food, quantity, storage, deadline, and pickup facts.", "live", ["Carry donor-reviewed facts", "Preserve unknowns", "Expose contradictions"], "Only reviewed fields enter the matching decision.", ["Candidate retrieval"], null),
        component("retrieve", 2, 2, "data", "Recall stage", "Candidate retrieval", "BigQuery vector search returns the top 30 profiles.", "live", ["Embed normalized need text", "Run cosine similarity", "Attach tract and need context"], "Similarity is evidence of relevance, not eligibility.", ["Hard constraints"], null),
        component("rules", 3, 1, "authority", "Authority stage", "Hard constraints", "Storage, full quantity, transport, service-day, clock, and contradiction checks.", "live", ["Reject unsafe candidates", "Record every reason", "Apply the same rules on replay"], "No language-model output can waive a failed rule.", ["Route evidence", "Ranked evidence"], null),
        component("routes", 3, 3, "platform", "Logistics evidence", "Bounded route checks", "Google Routes enriches the first candidates; labeled haversine remains the fallback.", "live", ["Add traffic-aware distance and duration", "Reject deadline or delivery-radius conflicts", "Never resurrect a previously rejected candidate"], "Route evidence is an operational constraint, never a food-safety override.", ["Ranked evidence"], null),
        component("result", 4, 2, "platform", "Structured output", "Ranked evidence", "Selected recipients, fallbacks, rejections, warnings, route context, and proof.", "live", ["Separate eligible and rejected profiles", "Preserve query and rule evidence", "Give the agent explainable facts"], "The agent may summarize the result but cannot rewrite it.", ["Root broker", "Transactional workflow"], null),
      ],
      edges: [edge("offer", "retrieve"), edge("retrieve", "rules"), edge("rules", "routes"), edge("rules", "result"), edge("routes", "result")],
    },
    workflow: {
      title: "Workflow authority",
      summary: "Commands move through one transactional authority, with asynchronous work made replay-safe.",
      parent: "workflow",
      nodes: [
        component("commands", 1, 2, "experience", "Command edge", "Typed commands", "Create, notify, claim, confirm, expire, and complete.", "live", ["Identify actor and scope", "Carry idempotency keys", "Validate request shape"], "A command expresses intent; it does not guarantee a transition.", ["Authorization", "Transaction coordinator"], null),
        component("authorization", 2, 1, "authority", "Policy", "Scoped authorization", "Opaque capabilities, short-lived coordinator cookie, and task OIDC.", "live", ["Check actor, action, offer, and expiry", "Keep shared coordinator secret server-side", "Reject cross-scope and cross-origin use"], "Demo sessions are not production identity proofing; raw bearer tokens are not persisted.", ["Transaction coordinator"], null),
        component("transaction", 2, 2, "authority", "State machine", "Transaction coordinator", "Validates transition, eligibility, and capacity together.", "live", ["Enforce first-claim-wins", "Protect cross-offer capacity", "Commit event and state atomically"], "No mutable state bypasses this boundary.", ["Operational entities", "Idempotency receipts"], null),
        component("entities", 3, 1, "data", "Operational state", "Firestore state", "Offers, recipients, reservations, waves, events, and scoped token records.", "live", ["Persist authoritative state", "Support scoped projections", "Retain an audit timeline"], "The current bounded state document is intentional for atomic hackathon behavior; target collections must preserve the same invariants.", ["Transaction coordinator"], null),
        component("receipts", 3, 2, "data", "Replay safety", "Idempotency receipts", "Stable result for every accepted command ID.", "live", ["Deduplicate retries", "Return the original result", "Protect external side effects"], "A repeated command cannot apply the transition twice.", ["Transaction coordinator"], null),
        component("callbacks", 3, 3, "platform", "Async edge", "Versioned callbacks", "Hold expiry and next-wave promotion through Cloud Tasks.", "live", ["Authenticate callbacks with OIDC", "Compare lease and wave versions", "Ignore stale or repeated delivery"], "Delayed tasks can invoke only the same deterministic transition and cannot overwrite newer state.", ["Transaction coordinator"], null),
      ],
      edges: [edge("commands", "authorization"), edge("commands", "transaction"), edge("authorization", "transaction"), edge("transaction", "entities"), edge("transaction", "receipts"), edge("callbacks", "transaction")],
    },
    bigquery: {
      title: "Analytical data platform",
      summary: "Reference, retrieval, and equity data are organized for explainable analytical reads.",
      parent: "bigquery",
      nodes: [
        component("profiles", 1, 1, "data", "Reference table", "Recipient profiles", "Capabilities, schedules, storage, capacity, and service needs.", "live", ["Represent recipient constraints", "Support filtering", "Provide human-readable evidence"], "Operational availability is rechecked by the workflow, not assumed from analytics.", ["Candidate query"], null),
        component("embeddings", 1, 2, "data", "Feature table", "Need embeddings", "Vector representation of normalized recipient needs.", "live", ["Support semantic recall", "Keep model metadata", "Enable reproducible retrieval"], "Embeddings rank relevance; they do not encode hard eligibility.", ["Candidate query"], null),
        component("context", 1, 3, "data", "Context tables", "Tract & need context", "Geographic and community indicators used for evidence.", "live", ["Attach nearest-tract context", "Support aggregate analysis", "Keep provenance visible"], "Context informs prioritization and explanation without exposing individual-sensitive facts.", ["Candidate query"], null),
        component("query", 3, 2, "authority", "Retrieval", "Candidate query", "Brute-force cosine search with evidence projection.", "live", ["Return top 30 candidates", "Join readable evidence", "Emit query metadata"], "Results still pass through deterministic hard constraints.", ["Eligibility authority", "Coordinator analysis"], null),
        component("analysis", 4, 1, "platform", "Protected access", "Coordinator analysis", "Bounded read-only questions through the verified managed BigQuery MCP path.", "live", ["Answer coverage questions", "Compare aggregate need", "Explain analytical results"], "No public arbitrary SQL and no write access.", ["BigQuery MCP"], null),
        component("proof", 4, 3, "platform", "Evidence", "Retrieval proof", "Candidate IDs, scores, reasons, labels, and BigQuery job correlation.", "live", ["Support explanation", "Link retrieval to a decision", "Power the ten-posting equity audit"], "Only allowlisted evidence is retained.", ["Eligibility authority"], null),
      ],
      edges: [edge("profiles", "query"), edge("embeddings", "query"), edge("context", "query"), edge("query", "analysis"), edge("query", "proof")],
    },
  };

  const focusSets = {
    overview: null,
    matching: ["experience", "intake", "api", "agent", "matcher", "bigquery", "integrations"],
    handoff: ["experience", "api", "auth", "workflow", "operations", "integrations"],
    trust: ["experience", "intake", "api", "auth", "agent", "matcher", "workflow", "bigquery", "operations"],
  };

  const focusDefaults = { overview: "agent", matching: "matcher", handoff: "workflow", trust: "agent" };

  const flowSteps = [
    { number: "01", title: "Describe surplus", actor: "Donor", summary: "A donor starts in natural language, browser dictation, or with an optional food photo.", input: "Text, editable transcript, photo", output: "Unsubmitted intake context", guardrail: "Microphone audio and photo bytes are not retained by Pantry Relay.", systems: ["Role-switching SPA"] },
    { number: "02", title: "Interpret & clarify", actor: "Intake AI", summary: "Gemini proposes a structured draft; inline prompts resolve missing or low-confidence fields.", input: "Unstructured donor context", output: "Editable draft + confidence + questions", guardrail: "The intake endpoint cannot create an offer or judge food safety; slow model calls fall back after 15 seconds.", systems: ["Vertex AI", "Deterministic fallback"] },
    { number: "03", title: "Confirm offer & map", actor: "Donor", summary: "The donor edits facts and confirms an Atlanta pickup point before submission.", input: "Draft + geocode or map pin", output: "Reviewed typed offer", guardrail: "Every inferred quantity, storage rule, deadline, transport choice, and location stays reviewable.", systems: ["Web app", "Maps Platform"] },
    { number: "04", title: "Run the broker", actor: "ADK", summary: "Offer creation executes root_agent, which calls match_surplus_offer through an ADK Runner.", input: "Reviewed typed offer", output: "Structured tool result + safe trace", guardrail: "The agent invokes and explains; it does not select outside the tool result.", systems: ["ADK Runner", "Root agent"] },
    { number: "05", title: "Retrieve & enforce", actor: "Matcher", summary: "BigQuery returns the top 30; code applies operational and bounded route constraints.", input: "Offer + recipient corpus", output: "Eligible, fallback, rejected + proof", guardrail: "Similarity, Gemini, Maps, and need context cannot waive a failed hard rule.", systems: ["BigQuery", "Matcher", "Maps Routes"] },
    { number: "06", title: "Persist & notify", actor: "Workflow", summary: "Firestore commits the offer, audit, first wave, scoped access, and expiry task.", input: "Authoritative match result", output: "In-app wave of up to 3 recipients", guardrail: "Command receipts and deterministic notification IDs make retries harmless.", systems: ["Firestore", "Cloud Tasks"] },
    { number: "07", title: "Claim & confirm", actor: "Recipient", summary: "Exactly one qualified recipient gets a ten-minute hold and confirms the handoff.", input: "Scoped recipient commands", output: "Confirmed reservation", guardrail: "Eligibility and capacity are rechecked atomically; exact pickup details unlock only after a valid claim.", systems: ["Workflow", "Firestore", "Maps"] },
    { number: "08", title: "Complete & audit", actor: "Donor", summary: "Completion records the actual outcome, releases capacity, and updates the shared timeline.", input: "Confirmed handoff", output: "Completed impact event", guardrail: "Only completed offers count as impact; retries cannot duplicate it.", systems: ["Workflow", "Coordinator view"] },
  ];

  const state = { mode: "current", view: "map", focus: "overview", drill: null, selected: "agent", flowIndex: 0, timer: null };
  const panel = document.querySelector("#view-panel");
  const tabs = Array.from(document.querySelectorAll("[data-view]"));
  const modeButtons = Array.from(document.querySelectorAll("[data-mode]"));

  modeButtons.forEach((button) => button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    state.drill = null;
    state.selected = focusDefaults[state.focus] || "agent";
    modeButtons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    renderView();
  }));

  tabs.forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  document.querySelector(".view-tabs").addEventListener("keydown", (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.indexOf(document.activeElement);
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    next.focus();
    setView(next.dataset.view);
  });

  panel.addEventListener("click", (event) => {
    const focusButton = event.target.closest("[data-focus]");
    const nodeButton = event.target.closest("[data-node]");
    const flowButton = event.target.closest("[data-step]");
    if (focusButton) {
      state.focus = focusButton.dataset.focus;
      state.selected = focusDefaults[state.focus];
      renderMap();
    } else if (nodeButton) {
      state.selected = nodeButton.dataset.node;
      renderMap();
    } else if (event.target.closest("[data-action='drill']")) {
      state.drill = event.target.closest("[data-action='drill']").dataset.drill;
      state.selected = drilldowns[state.drill].nodes[0].id;
      renderMap();
    } else if (event.target.closest("[data-action='back']")) {
      const parent = drilldowns[state.drill]?.parent || "agent";
      state.drill = null;
      state.selected = parent;
      renderMap();
    } else if (flowButton) {
      stopFlow();
      state.flowIndex = Number(flowButton.dataset.step);
      renderFlow();
    } else if (event.target.closest("[data-action='play']")) {
      state.timer ? stopFlow(true) : startFlow();
    }
  });

  window.addEventListener("resize", debounce(() => {
    if (state.view === "map") drawEdges();
  }, 120));

  function setView(view) {
    if (state.view === "flow" && view !== "flow") stopFlow();
    state.view = view;
    tabs.forEach((tab) => {
      const active = tab.dataset.view === view;
      tab.setAttribute("aria-selected", String(active));
      tab.setAttribute("tabindex", active ? "0" : "-1");
    });
    panel.setAttribute("aria-labelledby", `tab-${view}`);
    renderView();
  }

  function renderView() {
    if (state.view === "flow") renderFlow();
    else if (state.view === "authority") renderAuthority();
    else renderMap();
  }

  function renderMap() {
    const root = common[state.mode].overview;
    const model = state.drill ? drilldowns[state.drill] : root;
    if (!model.nodes.some((item) => item.id === state.selected)) state.selected = model.nodes[0].id;
    const selected = model.nodes.find((item) => item.id === state.selected);
    const focusIds = state.drill || state.focus === "overview" ? model.nodes.map((item) => item.id) : (focusSets[state.focus] || []);
    const isFocused = (id) => focusIds.includes(id);

    panel.innerHTML = `
      <div class="map-toolbar">
        <div class="focus-control" role="group" aria-label="Focus architecture path" ${state.drill ? "hidden" : ""}>
          <span>Focus</span>
          ${["overview", "matching", "handoff", "trust"].map((focus) => `<button type="button" data-focus="${focus}" aria-pressed="${state.focus === focus}">${titleCase(focus)}</button>`).join("")}
        </div>
        <div class="legend" aria-label="Status legend"><span><i class="status-dot live"></i>Implemented</span><span><i class="status-dot progress"></i>In progress</span><span><i class="status-dot next"></i>Next</span></div>
      </div>
      <div class="workspace">
        <article class="canvas-card">
          <div class="canvas-header">
            <div class="breadcrumb" aria-label="Architecture breadcrumb">${state.drill ? `<button type="button" data-action="back">System map</button><i>›</i><strong>${model.title}</strong>` : `<strong>${model.title}</strong>`}</div>
            <p>${model.summary}</p>
          </div>
          <div class="map-stage" id="map-stage" aria-label="Interactive architecture diagram">
            <svg id="connections" aria-hidden="true"><defs><marker id="arrow-muted" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker><marker id="arrow-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker></defs></svg>
            <div class="node-grid">${model.nodes.map((item) => nodeMarkup(item, isFocused(item.id))).join("")}</div>
          </div>
          <p class="canvas-hint"><span aria-hidden="true">↳</span> Select a component for details. Use “Explore internals” only when you need implementation depth.</p>
        </article>
        ${inspectorMarkup(selected, !state.drill && Boolean(selected.drill))}
      </div>`;
    window.requestAnimationFrame(() => drawEdges(model.edges, focusIds));
  }

  function nodeMarkup(item, focused) {
    const selected = item.id === state.selected;
    return `<button type="button" class="system-node${selected ? " selected" : ""}${focused ? "" : " muted"}" data-node="${item.id}" data-kind="${item.kind}" data-status="${item.status}" aria-pressed="${selected}" style="grid-column:${item.col};grid-row:${item.row}"><span class="node-status">${statusLabels[item.status]}</span><small>${item.layer}</small><strong>${item.title}</strong><p>${item.summary}</p></button>`;
  }

  function inspectorMarkup(item, canDrill) {
    return `<aside class="inspector" id="inspector" aria-live="polite">
      <div class="inspector-topline"><p class="inspector-kicker">Selected component</p><span class="status-pill">${statusLabels[item.status]}</span></div>
      <h3>${item.title}</h3><p class="inspector-summary">${item.summary}</p>
      <div class="detail-block"><h4>Owns</h4><ul>${item.owns.map((value) => `<li>${value}</li>`).join("")}</ul></div>
      <div class="detail-block"><div class="boundary"><strong>Hard boundary</strong>${item.boundary}</div></div>
      <div class="detail-block"><h4>Connects to</h4><div class="dependency-list">${item.dependencies.map((value) => `<span>${value}</span>`).join("")}</div></div>
      ${canDrill ? `<button class="drill-button" type="button" data-action="drill" data-drill="${item.drill}"><span>Explore internals</span><span aria-hidden="true">→</span></button>` : ""}
    </aside>`;
  }

  function drawEdges(edgesArg, focusIdsArg) {
    if (window.innerWidth <= 820) return;
    const model = state.drill ? drilldowns[state.drill] : common[state.mode].overview;
    const edges = edgesArg || model.edges;
    const focusIds = focusIdsArg || (state.drill || state.focus === "overview" ? model.nodes.map((item) => item.id) : focusSets[state.focus]);
    const stage = document.querySelector("#map-stage");
    const svg = document.querySelector("#connections");
    if (!stage || !svg) return;
    svg.querySelectorAll("path.edge").forEach((path) => path.remove());
    const stageRect = stage.getBoundingClientRect();
    edges.forEach((item) => {
      const from = stage.querySelector(`[data-node="${item.from}"]`);
      const to = stage.querySelector(`[data-node="${item.to}"]`);
      if (!from || !to) return;
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      const horizontal = Math.abs((b.left + b.width / 2) - (a.left + a.width / 2)) >= Math.abs((b.top + b.height / 2) - (a.top + a.height / 2));
      let x1, y1, x2, y2;
      if (horizontal) {
        const forward = b.left >= a.left;
        x1 = (forward ? a.right : a.left) - stageRect.left;
        y1 = a.top + a.height / 2 - stageRect.top;
        x2 = (forward ? b.left : b.right) - stageRect.left;
        y2 = b.top + b.height / 2 - stageRect.top;
      } else {
        const downward = b.top >= a.top;
        x1 = a.left + a.width / 2 - stageRect.left;
        y1 = (downward ? a.bottom : a.top) - stageRect.top;
        x2 = b.left + b.width / 2 - stageRect.left;
        y2 = (downward ? b.top : b.bottom) - stageRect.top;
      }
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const selectedEdge = item.from === state.selected || item.to === state.selected;
      const focusedEdge = state.focus !== "overview" && focusIds.includes(item.from) && focusIds.includes(item.to);
      const muted = state.focus !== "overview" && (!focusIds.includes(item.from) || !focusIds.includes(item.to));
      path.setAttribute("class", `edge${selectedEdge || focusedEdge ? " active" : ""}${muted ? " muted" : ""}`);
      if (horizontal) {
        const bend = Math.max(28, Math.abs(x2 - x1) * .42);
        const sign = x2 >= x1 ? 1 : -1;
        path.setAttribute("d", `M ${x1} ${y1} C ${x1 + bend * sign} ${y1}, ${x2 - bend * sign} ${y2}, ${x2} ${y2}`);
      } else {
        const bend = Math.max(22, Math.abs(y2 - y1) * .42);
        const sign = y2 >= y1 ? 1 : -1;
        path.setAttribute("d", `M ${x1} ${y1} C ${x1} ${y1 + bend * sign}, ${x2} ${y2 - bend * sign}, ${x2} ${y2}`);
      }
      svg.appendChild(path);
    });
  }

  function renderFlow() {
    const item = flowSteps[state.flowIndex];
    panel.innerHTML = `<div class="flow-layout">
      <article class="flow-board">
        <div class="flow-heading"><h3>One offer, end to end</h3><button class="play-button" type="button" data-action="play" aria-pressed="${Boolean(state.timer)}"><span aria-hidden="true">${state.timer ? "Ⅱ" : "▶"}</span>${state.timer ? "Pause" : "Play flow"}</button></div>
        <ol class="flow-steps">${flowSteps.map((step, index) => `<li><button type="button" class="flow-step${index === state.flowIndex ? " active" : ""}" data-step="${index}" aria-pressed="${index === state.flowIndex}"><b>${step.number}</b><strong>${step.title}</strong><span>${step.summary}</span><small>${step.actor}</small></button></li>`).join("")}</ol>
      </article>
      <aside class="flow-detail" aria-live="polite"><span class="step-number">${item.number}</span><h3>${item.title}</h3><p>${item.summary}</p><div class="io-pair"><div><small>Input</small><span>${item.input}</span></div><div><small>Output</small><span>${item.output}</span></div></div><div class="guardrail"><strong>Guardrail</strong>${item.guardrail}</div><div class="system-tags">${item.systems.map((system) => `<span>${system}</span>`).join("")}</div></aside>
    </div>`;
  }

  function startFlow() {
    stopFlow();
    state.flowIndex = 0;
    state.timer = window.setInterval(() => {
      if (state.flowIndex >= flowSteps.length - 1) { stopFlow(true); return; }
      state.flowIndex += 1;
      renderFlow();
    }, 1700);
    renderFlow();
  }

  function stopFlow(render) {
    if (state.timer) window.clearInterval(state.timer);
    state.timer = null;
    if (render && state.view === "flow") renderFlow();
  }

  function renderAuthority() {
    const modeNote = state.mode === "current" ? "This is the four-part authority split enforced by the current implementation." : "The target architecture preserves these boundaries while replacing demo identity and delivery.";
    panel.innerHTML = `<div class="authority-view">
      <div class="authority-intro"><h3>Four responsibilities. No ambiguous handoff.</h3><p>${modeNote}</p></div>
      <div class="authority-grid">
        ${authorityCard("Offer suggestions", "Intake AI", ["Interpret text and optional photos", "Attach field confidence", "Ask bounded follow-up questions", "Return an editable draft"], "Cannot submit an offer, assert food safety, or hide an inference from donor review.")}
        ${authorityCard("Tool orchestration", "ADK root agent", ["Receive reviewed offer facts", "Invoke the custom matcher tool", "Use managed MCP for protected analysis", "Explain authoritative evidence"], "Cannot rewrite the matcher result, reserve capacity, or advance workflow state.")}
        ${authorityCard("Eligibility", "Deterministic matcher", ["Retrieve candidate profiles", "Apply operational constraints", "Rank eligible recipients", "Return rejection reasons and proof"], "Cannot create a claim, hold capacity, or mutate recipient state.")}
        ${authorityCard("Operational state", "Transactional workflow", ["Authorize scoped commands", "Own claims and reservations", "Protect capacity", "Expire, confirm, and complete handoffs"], "Cannot infer missing offer facts or silently reinterpret matching evidence.")}
      </div>
      <div class="authority-rule"><div><small>Intake AI output</small><strong>Editable suggestion</strong></div><div><small>Donor action</small><strong>Confirmed offer facts</strong></div><div><small>Rule-engine output</small><strong>Eligibility decision</strong></div><div><small>Committed transaction</small><strong>Operational truth</strong></div></div>
    </div>`;
  }

  function authorityCard(label, title, allowed, prohibited) {
    return `<article class="authority-card"><header><small>${label}</small><h3>${title}</h3></header><div class="authority-card-body"><h4>Allowed to</h4><ul>${allowed.map((item) => `<li>${item}</li>`).join("")}</ul><div class="not-allowed"><h4>Not allowed to</h4><p>${prohibited}</p></div></div></article>`;
  }

  function titleCase(value) { return value.charAt(0).toUpperCase() + value.slice(1); }
  function debounce(fn, delay) { let timeout; return (...args) => { window.clearTimeout(timeout); timeout = window.setTimeout(() => fn(...args), delay); }; }

  tabs.forEach((tab) => tab.setAttribute("tabindex", tab.dataset.view === state.view ? "0" : "-1"));
  renderView();
})();
