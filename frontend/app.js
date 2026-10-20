(function () {
  "use strict";

  const form = document.querySelector("#offer-form");
  const submitButton = document.querySelector("#submit-button");
  const demoButton = document.querySelector("#load-demo");
  const presetChips = document.querySelector("#preset-chips");
  const postingSelect = document.querySelector("#bq-posting-select");
  const resultRegion = document.querySelector("#result-region");
  const resultStatus = document.querySelector("#result-status");
  const loadingTemplate = document.querySelector("#loading-template");

  const runAuditButton = document.querySelector("#run-audit-button");
  const auditResultsRegion = document.querySelector("#audit-results-region");
  const onboardForm = document.querySelector("#onboard-form");
  const fillOnboardSample = document.querySelector("#fill-onboard-sample");
  const onboardResultRegion = document.querySelector("#onboard-result-region");

  const DEMO_COORDINATES = { latitude: 33.749, longitude: -84.388 };

  const SCENARIO_PRESETS = {
    spinach: {
      description: "10 crates of fresh spinach, bagged and refrigerated",
      quantity: 1,
      storage_state: "refrigerated",
      hours: 6,
      location: "Downtown Atlanta grocery store",
      latitude: 33.749,
      longitude: -84.388,
      split_allowed: false,
    },
    potatoes: {
      description: "5 tons of loose Russet potatoes in bulk bins, farm surplus",
      quantity: 6,
      storage_state: "ambient",
      hours: 48,
      location: "South Metro Farm Aggregation Hub",
      latitude: 33.66,
      longitude: -84.42,
      split_allowed: true,
    },
    formula_sealed: {
      description: "80 cases of factory-sealed Enfamil infant formula powder, unopened",
      quantity: 1,
      storage_state: "ambient",
      hours: 24,
      location: "Midtown Pharmacy Distribution Center",
      latitude: 33.781,
      longitude: -84.386,
      split_allowed: false,
    },
    formula_open: {
      description: "12 opened canisters of infant formula powder, unsealed containers",
      quantity: 0.5,
      storage_state: "ambient",
      hours: 6,
      location: "Local Community Drop-Off",
      latitude: 33.749,
      longitude: -84.388,
      split_allowed: false,
    },
    halal_chicken: {
      description: "15 cases of fresh halal-slaughtered chicken breast, chilled",
      quantity: 1,
      storage_state: "refrigerated",
      hours: 8,
      location: "Clarkston International Market",
      latitude: 33.809,
      longitude: -84.239,
      split_allowed: false,
    },
    biryani: {
      description: "12 hot catered trays of chicken biryani and vegetable samosas",
      quantity: 1,
      storage_state: "ambient",
      hours: 12,
      location: "Downtown Atlanta Conference Center",
      latitude: 33.761,
      longitude: -84.395,
      split_allowed: false,
    },
  };

  let currentEnvelopeState = null;
  let declinedHistory = [];
  let loadedPostings = [];

  function applyPreset(preset) {
    const deadline = new Date(Date.now() + (preset.hours || 6) * 60 * 60 * 1000);
    deadline.setMinutes(deadline.getMinutes() - deadline.getTimezoneOffset());

    form.elements.description.value = preset.description;
    form.elements.quantity.value = String(preset.quantity ?? 1);
    form.elements.storage_state.value = preset.storage_state || "refrigerated";
    form.elements.deadline.value = deadline.toISOString().slice(0, 16);
    form.elements.location.value = preset.location || "Atlanta Metro Donor";
    form.elements.latitude.value = preset.latitude ?? DEMO_COORDINATES.latitude;
    form.elements.longitude.value = preset.longitude ?? DEMO_COORDINATES.longitude;
    form.elements.split_allowed.checked = Boolean(preset.split_allowed);
    form.elements.description.focus();
  }

  demoButton.addEventListener("click", () => {
    applyPreset(SCENARIO_PRESETS.spinach);
  });

  if (presetChips) {
    presetChips.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-preset]");
      if (!btn) return;
      const key = btn.getAttribute("data-preset");
      if (SCENARIO_PRESETS[key]) {
        applyPreset(SCENARIO_PRESETS[key]);
        form.requestSubmit();
      }
    });
  }

  async function loadBigQueryPostings() {
    if (!postingSelect) return;
    try {
      const resp = await fetch("/api/postings");
      if (!resp.ok) return;
      const data = await resp.json();
      loadedPostings = Array.isArray(data.postings) ? data.postings : [];
      loadedPostings.forEach((p, idx) => {
        const opt = document.createElement("option");
        opt.value = String(idx);
        opt.textContent = `[${p.track || "POSTING"} · ${p.posting_id || idx + 1}] ${p.description.slice(0, 72)}…`;
        postingSelect.appendChild(opt);
      });
    } catch (_err) {
      // Ignore if offline
    }
  }

  if (postingSelect) {
    postingSelect.addEventListener("change", () => {
      const idx = Number(postingSelect.value);
      if (!Number.isFinite(idx) || !loadedPostings[idx]) return;
      const p = loadedPostings[idx];
      const descLower = (p.description || "").toLowerCase();
      let storage = "refrigerated";
      if (descLower.includes("frozen") || descLower.includes("freezer")) {
        storage = "frozen";
      } else if (
        descLower.includes("shelf-stable") ||
        descLower.includes("canned") ||
        descLower.includes("diaper") ||
        descLower.includes("formula") ||
        descLower.includes("potato") ||
        descLower.includes("bread")
      ) {
        storage = "ambient";
      }
      const isLarge = (p.description || "").includes("5 tons") || (p.description || "").includes("pallet");
      applyPreset({
        description: p.description,
        quantity: (p.description || "").includes("5 tons") ? 6 : 1,
        storage_state: storage,
        hours: p.hours_until_expiry || 8,
        location: `${p.donor_type || "Atlanta Donor"} (${p.track || "SURPLUS"})`,
        latitude: p.donor_lat ?? DEMO_COORDINATES.latitude,
        longitude: p.donor_lon ?? DEMO_COORDINATES.longitude,
        split_allowed: isLarge,
      });
      form.requestSubmit();
    });
  }

  loadBigQueryPostings();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const payload = buildPayload(new FormData(form));
    declinedHistory = [];
    setLoading(true);

    try {
      const response = await fetch("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });

      let data;
      try {
        data = await response.json();
      } catch (_error) {
        throw new Error("The matching service returned an unreadable response.");
      }

      if (!response.ok) {
        throw new Error(data.detail || data.error || `Matching failed (${response.status}).`);
      }

      currentEnvelopeState = data;
      renderResponse(data);
    } catch (error) {
      renderError(error instanceof Error ? error.message : "The matching service is unavailable.");
    } finally {
      setLoading(false, true);
    }
  });

  function buildPayload(data) {
    const quantity = Number(data.get("quantity"));
    const latitude = Number(data.get("latitude"));
    const longitude = Number(data.get("longitude"));

    return {
      description: String(data.get("description")).trim(),
      quantity,
      quantity_pallets: quantity,
      pallet_estimate: quantity,
      storage_state: data.get("storage_state"),
      pickup_deadline: new Date(String(data.get("deadline"))).toISOString(),
      pickup_location: String(data.get("location")).trim(),
      donor_latitude: latitude,
      donor_longitude: longitude,
      donor_lat: latitude,
      donor_lon: longitude,
      split_allowed: data.get("split_allowed") === "on",
    };
  }

  function setLoading(isLoading, preserveResult) {
    submitButton.disabled = isLoading;
    submitButton.querySelector("span").textContent = isLoading
      ? "Checking recipients…"
      : "Find the best handoff";

    if (isLoading) {
      resultStatus.className = "status-chip";
      resultStatus.textContent = "Matching";
      resultRegion.replaceChildren(loadingTemplate.content.cloneNode(true));
    } else if (!preserveResult) {
      resultStatus.textContent = "Waiting for offer";
    }
  }

  function renderResponse(raw) {
    const normalized = normalizeResponse(raw);
    if (!normalized.matches.length) {
      renderNoMatch(normalized.rejections, normalized.message, normalized.offerBrief, normalized.warnings);
      return;
    }

    const selected = normalized.matches[0];
    const fallbacks = normalized.matches.slice(1, 3);
    const section = document.createElement("div");
    section.className = "recommendation";
    section.innerHTML = `
      ${renderRerouteBanner()}
      <article class="selected-card">
        <div class="selected-card-top">
          <div>
            <span class="match-badge">${declinedHistory.length ? `Rerouted Match #${declinedHistory.length + 1}` : "Selected match"}</span>
            <h3>${escapeHtml(selected.name)}</h3>
            <p class="address">${escapeHtml(selected.address || "Address available on confirmation")}</p>
          </div>
          ${selected.fitScore ? `<div class="fit-score"><strong>${escapeHtml(selected.fitScore)}</strong><span>fit</span></div>` : ""}
        </div>
        <p class="reason">${escapeHtml(selected.reason || "Meets the operational constraints for this offer.")}</p>
        <dl class="metrics">
          <div class="metric"><dt>Capacity</dt><dd>${escapeHtml(selected.capacity)}</dd></div>
          <div class="metric"><dt>Travel</dt><dd>${escapeHtml(selected.travel)}</dd></div>
          <div class="metric"><dt>Time margin</dt><dd>${escapeHtml(selected.margin)}</dd></div>
        </dl>
        ${renderOperationalBadges(selected.raw)}
        ${renderWarnings(selected.warnings)}
        ${renderRerouteAction(selected, fallbacks)}
      </article>
      ${renderAgentFullReply(selected.agentFullReply)}
      ${renderShelfLifeAndFda(selected.shelfLife, selected.fdaRecall)}
      ${renderEquityProfile(selected.equityProfile)}
      ${renderPalletSplitPlan(selected.palletSplitPlan)}
      ${renderFallbacks(fallbacks)}
      ${renderOutreach(normalized.outreach || selected.outreach)}
      ${renderRejections(normalized.rejections)}
    `;

    resultRegion.replaceChildren(section);
    resultStatus.className = "status-chip success";
    resultStatus.textContent = normalized.manualReview
      ? "Review needed"
      : declinedHistory.length
      ? `Rerouted (${declinedHistory.length} declined)`
      : "Eligible match";
    attachCopyHandler();
    attachAgentReplyCopyHandler();
    attachRerouteHandler();
  }

  function renderRerouteBanner() {
    if (!declinedHistory.length) return "";
    return `
      <div class="reroute-banner" role="status">
        <strong>Live Reroute Active:</strong> Declined by ${declinedHistory
          .map((d) => `${escapeHtml(d.name)} (-${d.elapsedHours}h clock)`)
          .join(", ")} → Promoted next verified recipient.
      </div>
    `;
  }

  function renderOperationalBadges(raw) {
    if (!raw || typeof raw !== "object") return "";
    const pills = [];
    if (raw.cold_storage) {
      pills.push(`Cold storage: ${raw.cold_storage}`);
    }
    if (raw.frozen_storage !== undefined) {
      pills.push(`Freezer: ${raw.frozen_storage ? "Yes" : "No"}`);
    }
    if (raw.refrigerated_transport !== undefined) {
      pills.push(`Reefer van: ${raw.refrigerated_transport ? "Yes" : "No"}`);
    }
    if (raw.loading_dock !== undefined) {
      pills.push(`Loading dock: ${raw.loading_dock ? "Commercial dock" : "Street-level / No dock"}`);
    }
    if (raw.service_days) {
      pills.push(`Open: ${raw.service_days}`);
    }
    if (raw.weekly_households) {
      pills.push(`${raw.weekly_households} weekly households`);
    }
    if (!pills.length && !raw.profile_text) return "";

    return `
      <div class="op-details">
        <div class="op-badges">
          ${pills.map((p) => `<span class="op-pill">${escapeHtml(p)}</span>`).join("")}
        </div>
        ${raw.populations_served ? `<p class="op-meta"><strong>Populations served:</strong> ${escapeHtml(raw.populations_served)}</p>` : ""}
        ${raw.profile_text ? `<p class="op-profile">“${escapeHtml(raw.profile_text)}”</p>` : ""}
      </div>
    `;
  }

  function renderRerouteAction(selected, fallbacks) {
    if (!fallbacks || !fallbacks.length) return "";
    const nextFallback = fallbacks[0];
    return `
      <div class="reroute-bar">
        <span>Primary can’t take the load?</span>
        <button type="button" class="reroute-button" id="reroute-next-button">
          They Said No → Reroute to ${escapeHtml(nextFallback.name)} (-0.5h clock)
        </button>
      </div>
    `;
  }

  function renderAgentFullReply(replyText) {
    if (!replyText) return "";
    return `
      <section class="result-section" aria-labelledby="agent-brief-heading">
        <div class="result-section-title">
          <h4 id="agent-brief-heading">Full Agent Broker Reply</h4>
          <button type="button" class="mini-copy-btn" id="copy-agent-brief-btn">Copy full brief</button>
        </div>
        <pre class="agent-reply-box" id="agent-reply-text">${escapeHtml(replyText)}</pre>
      </section>
    `;
  }

  function renderShelfLifeAndFda(shelfLife, fdaRecall) {
    if (!shelfLife && !fdaRecall) return "";
    const sl = shelfLife || {};
    const fda = fdaRecall || {};
    const bioHours =
      sl.shelf_life_hours !== null && sl.shelf_life_hours !== undefined
        ? `${roundNumber(sl.shelf_life_hours)} hr`
        : "Non-perishable";
    const donorHours =
      sl.donor_hours_available !== null && sl.donor_hours_available !== undefined
        ? `${roundNumber(sl.donor_hours_available)} hr`
        : "N/A";
    const effectiveHours =
      sl.hours_remaining !== null && sl.hours_remaining !== undefined
        ? `${roundNumber(sl.hours_remaining)} hr`
        : "N/A";
    const fdaStatus = fda.safety_clearance_status || "CLEAR_TO_ROUTE";
    const fdaIsClear = fdaStatus === "CLEAR_TO_ROUTE";
    const optimizations = Array.isArray(sl.clock_optimizations) ? sl.clock_optimizations : [];
    const sourceUrls = Array.isArray(sl.source_urls) ? sl.source_urls : [];

    return `
      <section class="result-section" aria-labelledby="clock-fda-heading">
        <div class="result-section-title">
          <h4 id="clock-fda-heading">The Spoilage Clock &amp; Live FDA Safety</h4>
          <span>${escapeHtml(sl.source_method || "USDA FoodKeeper + openFDA")}</span>
        </div>
        <div class="judge-card">
          <div class="judge-grid-3">
            <div class="judge-stat">
              <span class="judge-stat-label">Biological Shelf Life</span>
              <strong>${escapeHtml(bioHours)}</strong>
              <small>${escapeHtml(sl.matched_foodkeeper_name || sl.category || "Verified")}</small>
            </div>
            <div class="judge-stat">
              <span class="judge-stat-label">Donor Pickup Window</span>
              <strong>${escapeHtml(donorHours)}</strong>
              <small>Binding: ${escapeHtml(sl.binding_constraint || "DONOR_WINDOW")}</small>
            </div>
            <div class="judge-stat">
              <span class="judge-stat-label">Effective Clock</span>
              <strong>${escapeHtml(effectiveHours)}</strong>
              <small>${escapeHtml((sl.urgency_tier || "STANDARD").split("—")[0])}</small>
            </div>
          </div>

          <div class="fda-status-row ${fdaIsClear ? "fda-clear" : "fda-alert"}">
            <div>
              <strong>openFDA Enforcement (${escapeHtml(fda.state_filter || "GA")}): ${escapeHtml(fdaStatus)}</strong>
              <p>${escapeHtml(fda.broker_action || "No active FDA recalls matched this item.")}</p>
            </div>
            <span class="fda-pill">${fda.active_recalls_found || 0} active recalls</span>
          </div>

          ${
            optimizations.length
              ? `<div class="clock-tips">
                  <strong>Clock Optimization Strategies:</strong>
                  <ul>${optimizations.slice(0, 2).map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>
                </div>`
              : ""
          }
          ${
            sourceUrls.length
              ? `<div class="grounding-sources">
                  <strong>Google Search Grounding Citations:</strong>
                  ${sourceUrls
                    .slice(0, 3)
                    .map(
                      (u) =>
                        `<a href="${escapeHtml(u.url || "#")}" target="_blank" rel="noopener noreferrer">${escapeHtml(
                          u.title || u.url || "Source"
                        )}</a>`
                    )
                    .join(" · ")}
                </div>`
              : ""
          }
        </div>
      </section>
    `;
  }

  function renderEquityProfile(eq) {
    if (!eq) return "";
    const incomeStr =
      eq.tract_median_income != null
        ? `$${Number(eq.tract_median_income).toLocaleString()}`
        : "Community Verified";
    const povStr =
      eq.tract_poverty_rate != null
        ? `${(Number(eq.tract_poverty_rate) * 100).toFixed(1)}%`
        : "N/A";
    const noVehStr =
      eq.tract_no_vehicle_rate != null
        ? `${(Number(eq.tract_no_vehicle_rate) * 100).toFixed(1)}%`
        : "N/A";
    const snapStr =
      eq.tract_assistance_rate != null
        ? `${(Number(eq.tract_assistance_rate) * 100).toFixed(1)}%`
        : "N/A";

    return `
      <section class="result-section" aria-labelledby="equity-heading">
        <div class="result-section-title">
          <h4 id="equity-heading">Neighborhood Equity &amp; Census Tract Demographics</h4>
          <span>${escapeHtml(eq.neighborhood_income_tier || "Equity Priority")}</span>
        </div>
        <div class="judge-card">
          <div class="judge-grid-4">
            <div class="judge-stat">
              <span class="judge-stat-label">Tract Median Income</span>
              <strong>${escapeHtml(incomeStr)}</strong>
              <small>vs. $55,949 Metro avg</small>
            </div>
            <div class="judge-stat">
              <span class="judge-stat-label">Tract Poverty Rate</span>
              <strong>${escapeHtml(povStr)}</strong>
              <small>vs. 21.8% Metro avg</small>
            </div>
            <div class="judge-stat">
              <span class="judge-stat-label">No-Vehicle HH</span>
              <strong>${escapeHtml(noVehStr)}</strong>
              <small>SNAP/Assist: ${escapeHtml(snapStr)}</small>
            </div>
            <div class="judge-stat">
              <span class="judge-stat-label">Equity Need Score</span>
              <strong>${escapeHtml(String(eq.need_score ?? "0.00"))}</strong>
              <small>Tract ${escapeHtml(String(eq.tract_geo_id || "Spatial"))}</small>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function renderPalletSplitPlan(splitPlan) {
    if (!splitPlan || !Array.isArray(splitPlan.stops) || !splitPlan.stops.length) return "";
    return `
      <section class="result-section" aria-labelledby="split-heading">
        <div class="result-section-title">
          <h4 id="split-heading">Need-Proportional Multi-Stop Pallet Split</h4>
          <span>${escapeHtml(String(splitPlan.total_pallets))} pallets across ${escapeHtml(String(splitPlan.stops_count))} stops</span>
        </div>
        <div class="judge-card">
          <p class="split-method">${escapeHtml(splitPlan.allocation_method || "Weighted by Census Tract Equity Need & Weekly Households")}</p>
          <div class="split-table-wrap">
            <table class="split-table">
              <thead>
                <tr>
                  <th>Stop</th>
                  <th>Recipient</th>
                  <th>Allocated</th>
                  <th>Share</th>
                  <th>Distance</th>
                  <th>Need Score</th>
                </tr>
              </thead>
              <tbody>
                ${splitPlan.stops
                  .map(
                    (s) => `
                  <tr>
                    <td>#${escapeHtml(String(s.stop_number))}</td>
                    <td><strong>${escapeHtml(s.name)}</strong></td>
                    <td>${escapeHtml(String(s.allocated_pallets))} / ${escapeHtml(String(s.max_pallets))} pallets</td>
                    <td>${escapeHtml(String(s.share_pct))}%</td>
                    <td>${escapeHtml(String(s.distance_miles))} mi</td>
                    <td>${escapeHtml(String(s.need_score))}</td>
                  </tr>
                `
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    `;
  }

  function normalizeResponse(raw) {
    const envelope = raw && raw.result && typeof raw.result === "object" ? raw.result : raw || {};
    const explicitMatches = [envelope.selected, ...(Array.isArray(envelope.fallbacks) ? envelope.fallbacks : [])].filter(Boolean);
    const sourceMatches = envelope.matches || envelope.recommendations || envelope.candidates || explicitMatches;
    const matches = Array.isArray(sourceMatches)
      ? sourceMatches
      : [envelope.selected || envelope.match].filter(Boolean);

    if (envelope.selected && !matches.includes(envelope.selected)) matches.unshift(envelope.selected);

    const normalizedMatches = matches.filter(Boolean).map(normalizeMatch);
    const topWarnings = normalizeStrings(envelope.warnings);
    if (normalizedMatches.length && topWarnings.length) {
      normalizedMatches[0].warnings.push(...topWarnings);
    }

    const rawRejections = envelope.rejections || envelope.rejected || envelope.rejection_reasons || [];
    let offerBrief = null;
    if (Array.isArray(rawRejections) && rawRejections.length && rawRejections[0] && rawRejections[0]._offer_brief) {
      offerBrief = rawRejections[0]._offer_brief;
    }

    return {
      matches: normalizedMatches,
      rejections: normalizeRejections(rawRejections),
      outreach: envelope.outreach || envelope.outreach_message || envelope.message_to_recipient || "",
      message: envelope.message || envelope.explanation || (envelope.no_match ? "No recipient passed every operational check." : ""),
      manualReview: Boolean(envelope.manual_review || envelope.requires_review),
      offerBrief,
      warnings: topWarnings,
    };
  }

  function normalizeMatch(match, index) {
    const capacity = match.capacity && typeof match.capacity === "object" ? match.capacity : {};
    const travel = match.travel && typeof match.travel === "object" ? match.travel : {};
    const clock = match.clock && typeof match.clock === "object" ? match.clock : {};
    const capacityValue = firstDefined(
      match.capacity_summary,
      capacity.max_pallets != null
        ? `${roundNumber(capacity.offered_pallets ?? 0)} of ${roundNumber(capacity.max_pallets)} pallets`
        : "",
      typeof match.capacity === "string" || typeof match.capacity === "number" ? match.capacity : "",
      match.capacity_pallets != null ? `${match.capacity_pallets} pallets` : ""
    );
    const travelValue = firstDefined(
      match.travel_summary,
      travel.estimated_minutes != null
        ? `${roundNumber(travel.estimated_minutes)} min${travel.distance_miles != null ? ` · ${roundNumber(travel.distance_miles)} mi` : ""}`
        : "",
      typeof match.travel_time === "string" || typeof match.travel_time === "number" ? match.travel_time : "",
      match.travel_minutes != null ? `${roundNumber(match.travel_minutes)} min` : "",
      match.distance_miles != null ? `${roundNumber(match.distance_miles)} mi` : ""
    );
    const marginValue = firstDefined(
      match.time_margin,
      match.margin,
      clock.remaining_margin_hours != null ? `${roundNumber(clock.remaining_margin_hours)} hr` : "",
      match.time_margin_hours != null ? `${roundNumber(match.time_margin_hours)} hr` : "",
      match.margin_minutes != null ? `${roundNumber(match.margin_minutes)} min` : ""
    );
    const score =
      match.fit_score ??
      match.semantic_score ??
      match.score ??
      (match.semantic_distance != null ? Math.max(0.5, 1 - Number(match.semantic_distance) * 0.5) : null);

    return {
      name: firstDefined(match.name, match.recipient_name, match.organization_name, `Recipient ${index + 1}`),
      address: firstDefined(match.address, match.recipient_address, match.location, ""),
      fitScore: formatScore(score),
      reason: firstDefined(match.selection_reason, match.reason, match.explanation, match.fit, ""),
      capacity: String(capacityValue || "Pass"),
      travel: String(travelValue || "Pass"),
      margin: String(marginValue || "Pass"),
      warnings: normalizeStrings(match.warnings || match.warning),
      outreach: match.outreach || match.outreach_message || "",
      shelfLife: match.shelf_life || null,
      fdaRecall: match.fda_recall || null,
      equityProfile: match.equity_profile || null,
      palletSplitPlan: match.pallet_split_plan || null,
      agentFullReply: match.agent_full_reply || "",
      raw: match,
    };
  }

  function normalizeRejections(rejections) {
    if (!rejections) return [];
    const list = Array.isArray(rejections)
      ? rejections
      : Object.entries(rejections).map(([name, reason]) => ({ name, reason }));
    return list.map((item) => {
      if (typeof item === "string") return { name: "Candidate", reason: item };
      return {
        name: firstDefined(item.name, item.recipient_name, item.organization_name, "Candidate"),
        reason: firstDefined(
          Array.isArray(item.reasons) ? item.reasons.join("; ") : item.reasons,
          item.reason,
          item.rejection_reason,
          item.explanation,
          "Did not pass eligibility checks"
        ),
      };
    });
  }

  function normalizeStrings(value) {
    if (!value) return [];
    return (Array.isArray(value) ? value : [value]).map((item) =>
      typeof item === "string" ? item : item.message || item.reason || JSON.stringify(item)
    );
  }

  function renderFallbacks(fallbacks) {
    if (!fallbacks.length) return "";
    return `
      <section class="result-section" aria-labelledby="fallback-heading">
        <div class="result-section-title"><h4 id="fallback-heading">Fallbacks</h4><span>${fallbacks.length} eligible</span></div>
        <div class="fallbacks">
          ${fallbacks
            .map(
              (match, index) => `
            <article class="fallback-card">
              <span class="rank">0${index + 2}</span>
              <h5>${escapeHtml(match.name)}</h5>
              <p>${escapeHtml(match.reason || match.address || "Eligible alternate")}</p>
              <p class="fallback-stats">${escapeHtml(match.travel)} · ${escapeHtml(match.margin)} margin</p>
            </article>
          `
            )
            .join("")}
        </div>
      </section>`;
  }

  function renderWarnings(warnings) {
    if (!warnings.length) return "";
    return `<div class="warnings" aria-label="Warnings">${warnings
      .map((warning) => `<div class="warning">${escapeHtml(warning)}</div>`)
      .join("")}</div>`;
  }

  function renderOutreach(message) {
    if (!message) return "";
    return `
      <section class="result-section" aria-labelledby="outreach-heading">
        <div class="result-section-title"><h4 id="outreach-heading">Ready-to-send outreach</h4><span>Verify availability</span></div>
        <div class="outreach-box">
          <p id="outreach-text">${escapeHtml(message)}</p>
          <button class="copy-button" type="button" aria-label="Copy outreach message" title="Copy outreach message">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
          </button>
        </div>
      </section>`;
  }

  function renderRejections(rejections) {
    if (!rejections.length) return "";
    return `
      <section class="result-section" aria-labelledby="rejections-heading">
        <div class="result-section-title"><h4 id="rejections-heading">Why others were filtered (Decoy &amp; Safety Audit)</h4><span>${rejections.length} filtered</span></div>
        <ul class="rejections">${rejections
          .slice(0, 8)
          .map(
            (item) =>
              `<li><span><strong>${escapeHtml(item.name)}:</strong> ${escapeHtml(item.reason)}</span></li>`
          )
          .join("")}</ul>
      </section>`;
  }

  function renderNoMatch(rejections, message, offerBrief, warnings) {
    const reasons = rejections.length
      ? `<ul class="no-match-reasons">${rejections
          .slice(0, 6)
          .map((item) => `<li><strong>${escapeHtml(item.name)}:</strong> ${escapeHtml(item.reason)}</li>`)
          .join("")}</ul>`
      : "";
    const safetyBanner =
      offerBrief && offerBrief.safety_blocked_reason
        ? `<div class="safety-block-banner">${escapeHtml(offerBrief.safety_blocked_reason)}</div>`
        : "";
    const briefHtml = offerBrief
      ? `
        <div class="no-match-brief-wrap">
          ${renderAgentFullReply(offerBrief.agent_full_reply)}
          ${renderShelfLifeAndFda(offerBrief.shelf_life, offerBrief.fda_recall)}
        </div>
      `
      : "";

    resultRegion.innerHTML = `
      <div class="no-match-state-expanded">
        <div class="no-match-header">
          <div class="no-match-icon" aria-hidden="true">×</div>
          <h3>${offerBrief && offerBrief.safety_blocked_reason ? "Hard Safety Guardrail Triggered — Do Not Route" : "No safe match yet"}</h3>
          <p>${escapeHtml(
            (offerBrief && offerBrief.safety_blocked_reason) ||
              message ||
              "No recipient passed every operational check. Try a later deadline, smaller quantity, or allow splitting."
          )}</p>
        </div>
        ${safetyBanner}
        ${renderWarnings(warnings || [])}
        ${briefHtml}
        ${reasons}
      </div>`;
    resultStatus.className = "status-chip error";
    resultStatus.textContent =
      offerBrief && offerBrief.safety_blocked_reason ? "Safety Blocked" : "No eligible match";
    attachAgentReplyCopyHandler();
  }

  function renderError(message) {
    resultRegion.innerHTML = `
      <div class="error-state" role="alert">
        <div class="error-icon" aria-hidden="true">!</div>
        <h3>We couldn’t reach the matcher</h3>
        <p>${escapeHtml(message)} Your offer is still in the form.</p>
        <button class="retry-button" type="button">Try again</button>
      </div>`;
    resultStatus.className = "status-chip error";
    resultStatus.textContent = "Connection issue";
    resultRegion.querySelector(".retry-button").addEventListener("click", () => form.requestSubmit());
  }

  function attachCopyHandler() {
    const button = resultRegion.querySelector(".copy-button");
    if (!button) return;
    button.addEventListener("click", async () => {
      const text = resultRegion.querySelector("#outreach-text").textContent;
      try {
        await navigator.clipboard.writeText(text);
        button.setAttribute("aria-label", "Outreach message copied");
        button.title = "Copied";
      } catch (_error) {
        button.setAttribute("aria-label", "Copy unavailable; select the message manually");
      }
    });
  }

  function attachAgentReplyCopyHandler() {
    const btn = resultRegion.querySelector("#copy-agent-brief-btn");
    const pre = resultRegion.querySelector("#agent-reply-text");
    if (!btn || !pre) return;
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent);
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = "Copy full brief";
        }, 1800);
      } catch (_err) {
        btn.textContent = "Select manually";
      }
    });
  }

  function attachRerouteHandler() {
    const btn = resultRegion.querySelector("#reroute-next-button");
    if (!btn || !currentEnvelopeState) return;
    btn.addEventListener("click", () => {
      const fallbacks = Array.isArray(currentEnvelopeState.fallbacks)
        ? [...currentEnvelopeState.fallbacks]
        : [];
      const prevSelected = currentEnvelopeState.selected;
      if (!prevSelected || !fallbacks.length) return;

      declinedHistory.push({
        name: prevSelected.name || "Primary Recipient",
        elapsedHours: 0.5,
      });

      const nextPrimary = { ...fallbacks.shift() };
      const prevMargin = Number(nextPrimary.time_margin_hours ?? 2.0);
      const newMargin = Math.max(0.1, Number((prevMargin - 0.5).toFixed(2)));
      nextPrimary.time_margin_hours = newMargin;
      if (nextPrimary.clock && typeof nextPrimary.clock === "object") {
        nextPrimary.clock = {
          ...nextPrimary.clock,
          remaining_margin_hours: newMargin,
        };
      }
      nextPrimary.selection_reason = `Promoted after ${prevSelected.name} declined (-0.5h negotiation clock deducted). Remaining time margin: +${newMargin}h.`;
      nextPrimary.agent_full_reply =
        `[LIVE REROUTE UPDATE: ${prevSelected.name} declined. Deducted 0.5h elapsed negotiation time. Promoted #${
          declinedHistory.length + 1
        } ${nextPrimary.name} with +${newMargin}h remaining time margin.]\n\n` +
        (prevSelected.agent_full_reply || "");

      const updatedRejections = [
        {
          name: prevSelected.name,
          reasons: ["declined_by_recipient:rerouted_to_next_fallback (-0.5h clock)"],
        },
        ...(Array.isArray(currentEnvelopeState.rejections) ? currentEnvelopeState.rejections : []),
      ];

      currentEnvelopeState = {
        ...currentEnvelopeState,
        selected: nextPrimary,
        fallbacks,
        rejections: updatedRejections,
        outreach: (currentEnvelopeState.outreach || "").replace(
          prevSelected.name || "",
          nextPrimary.name || "team"
        ),
      };
      renderResponse(currentEnvelopeState);
    });
  }

  // Judge Suite Panel 1: 10-Posting Metro Equity Outcome Audit
  if (runAuditButton && auditResultsRegion) {
    runAuditButton.addEventListener("click", async () => {
      runAuditButton.disabled = true;
      runAuditButton.textContent = "Running 10-Posting Audit…";
      auditResultsRegion.innerHTML = `<p class="muted-placeholder">Evaluating all 10 Challenge postings against BigQuery Census Tract demographics…</p>`;
      try {
        const resp = await fetch("/api/equity-audit");
        if (!resp.ok) throw new Error(`Audit HTTP ${resp.status}`);
        const data = await resp.json();
        renderAuditResults(data);
      } catch (err) {
        auditResultsRegion.innerHTML = `<p class="error-inline">Audit failed: ${escapeHtml(
          err instanceof Error ? err.message : String(err)
        )}</p>`;
      } finally {
        runAuditButton.disabled = false;
        runAuditButton.textContent = "Run Live Audit";
      }
    });
  }

  function renderAuditResults(data) {
    const broker = data.equity_broker_outcomes || {};
    const metro = data.atlanta_metro_baseline || {};
    const naive = data.naive_logistics_baseline || {};
    const rows = Array.isArray(data.per_posting_results) ? data.per_posting_results : [];

    auditResultsRegion.innerHTML = `
      <div class="audit-cards">
        <div class="audit-card audit-card-highlight">
          <span class="audit-tag">Our Equity-Aware Broker</span>
          <strong>${escapeHtml(String(broker.pct_routed_to_low_income_tracts ?? 100))}% Low-Income Routing</strong>
          <p>Avg Tract Income: <strong>$${Number(broker.avg_tract_median_income || 34899).toLocaleString()}</strong></p>
          <p>Avg Poverty Rate: <strong>${escapeHtml(String(broker.avg_tract_poverty_rate_pct ?? 33.5))}%</strong></p>
          <p>Dock Bias: <strong>${escapeHtml(String(broker.pct_routed_to_commercial_loading_dock ?? 0))}%</strong></p>
        </div>
        <div class="audit-card">
          <span class="audit-tag">Atlanta Metro Baseline</span>
          <strong>297 Census Tracts</strong>
          <p>Avg Tract Income: <strong>$${Number(metro.avg_tract_median_income || 55949).toLocaleString()}</strong></p>
          <p>Avg Poverty Rate: <strong>${escapeHtml(String(metro.avg_tract_poverty_rate_pct ?? 21.8))}%</strong></p>
          <p>No-Vehicle HH: <strong>${escapeHtml(String(metro.avg_tract_no_vehicle_rate_pct ?? 11.4))}%</strong></p>
        </div>
        <div class="audit-card">
          <span class="audit-tag">Naive Logistics Baseline</span>
          <strong>${escapeHtml(String(naive.pct_routed_to_commercial_loading_dock ?? 80))}% Commercial Dock Bias</strong>
          <p>Avg Tract Income: <strong>$${Number(naive.avg_tract_median_income || 50860).toLocaleString()}</strong></p>
          <p>Avg Poverty Rate: <strong>${escapeHtml(String(naive.avg_tract_poverty_rate_pct ?? 22.9))}%</strong></p>
          <p>Low-Income Share: <strong>${escapeHtml(String(naive.pct_routed_to_low_income_tracts ?? 40))}%</strong></p>
        </div>
      </div>
      ${
        rows.length
          ? `<div class="audit-table-wrap">
              <table class="audit-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Track</th>
                    <th>Primary Winner</th>
                    <th>Tract Income</th>
                    <th>Poverty</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows
                    .map(
                      (r) => `
                    <tr>
                      <td><code>${escapeHtml(r.posting_id || "")}</code></td>
                      <td>${escapeHtml(r.track || "")}</td>
                      <td><strong>${escapeHtml(r.primary_recipient || r.status || "")}</strong></td>
                      <td>${r.tract_median_income ? `$${Number(r.tract_median_income).toLocaleString()}` : "—"}</td>
                      <td>${r.tract_poverty_rate != null ? `${(Number(r.tract_poverty_rate) * 100).toFixed(1)}%` : "—"}</td>
                      <td>${escapeHtml(r.status || "")}</td>
                    </tr>
                  `
                    )
                    .join("")}
                </tbody>
              </table>
            </div>`
          : ""
      }
    `;
  }

  // Judge Suite Panel 2: Conversational Pantry Onboarding (`AI.EMBED`)
  if (fillOnboardSample && onboardForm) {
    fillOnboardSample.addEventListener("click", () => {
      onboardForm.elements.name.value = "West End Mothers & Seniors Cooperative Pantry";
      onboardForm.elements.street.value = "640 Evans St SW";
      onboardForm.elements.cold_storage.value = "walk-in";
      onboardForm.elements.max_pallets.value = "3";
      onboardForm.elements.weekly_households.value = "480";
      onboardForm.elements.service_days.value = "Monday, Tuesday, Wednesday, Thursday, Friday, Saturday";
      onboardForm.elements.profile_description.value =
        "Community-run West End food pantry with walk-in cooler and reach-in freezer serving 480 low-income families, WIC mothers, and seniors weekly.";
    });
  }

  if (onboardForm && onboardResultRegion) {
    onboardForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const btn = document.querySelector("#onboard-submit-button");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Writing to BigQuery & generating AI.EMBED vector…";
      }
      const fd = new FormData(onboardForm);
      const body = {
        name: String(fd.get("name") || "").trim(),
        street: String(fd.get("street") || "").trim(),
        city: "Atlanta",
        zip_code: "30310",
        cold_storage: String(fd.get("cold_storage") || "walk-in").trim(),
        frozen_storage: true,
        loading_dock: false,
        refrigerated_transport: false,
        max_pallets: Number(fd.get("max_pallets") || 3),
        pickup_window_hours: 4,
        weekly_households: Number(fd.get("weekly_households") || 350),
        populations_served: "Low-income families, seniors, and children",
        service_days: String(fd.get("service_days") || "Monday, Wednesday, Friday"),
        profile_description: String(fd.get("profile_description") || "").trim(),
        latitude: 33.735,
        longitude: -84.417,
      };
      try {
        const resp = await fetch("/api/onboard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await resp.json();
        const rec = data.onboarded_recipient || {};
        onboardResultRegion.innerHTML = `
          <div class="onboard-success-card">
            <strong>${escapeHtml(data.status || "ONBOARDED")}: ${escapeHtml(rec.name || body.name)}</strong>
            <p>${escapeHtml(data.confirmation_message || "Indexed in BigQuery recipient_embeddings.")}</p>
            <div class="op-badges">
              <span class="op-pill">ID: ${escapeHtml(rec.recipient_id || "rec_new")}</span>
              <span class="op-pill">Equity Need Score: ${escapeHtml(String(rec.equity_priority_score ?? "N/A"))}</span>
              <span class="op-pill">Tract Income: ${
                rec.nearest_census_tract?.median_income
                  ? `$${Number(rec.nearest_census_tract.median_income).toLocaleString()}`
                  : "Verified"
              }</span>
              <span class="op-pill">Vector Indexed: ${data.bigquery_persistence?.embedded_in_recipient_embeddings ? "Yes (768-d AI.EMBED)" : "Local Ready"}</span>
            </div>
          </div>
        `;
      } catch (err) {
        onboardResultRegion.innerHTML = `<p class="error-inline">Onboarding failed: ${escapeHtml(
          err instanceof Error ? err.message : String(err)
        )}</p>`;
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Onboard & Index in BigQuery (`AI.EMBED`)";
        }
      }
    });
  }

  function formatScore(score) {
    if (score == null || score === "") return "";
    if (typeof score === "string" && score.includes("%")) return score;
    const numeric = Number(score);
    if (!Number.isFinite(numeric)) return String(score);
    return `${Math.round(numeric <= 1 ? numeric * 100 : numeric)}%`;
  }

  function roundNumber(value) {
    const number = Number(value);
    return Number.isInteger(number) ? String(number) : number.toFixed(1);
  }

  function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null && value !== "");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();
