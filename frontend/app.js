(function () {
  "use strict";

  const form = document.querySelector("#offer-form");
  const submitButton = document.querySelector("#submit-button");
  const demoButton = document.querySelector("#load-demo");
  const resultRegion = document.querySelector("#result-region");
  const resultStatus = document.querySelector("#result-status");
  const loadingTemplate = document.querySelector("#loading-template");

  const DEMO_COORDINATES = { latitude: 33.749, longitude: -84.388 };

  demoButton.addEventListener("click", () => {
    const deadline = new Date(Date.now() + 6 * 60 * 60 * 1000);
    deadline.setMinutes(deadline.getMinutes() - deadline.getTimezoneOffset());

    form.elements.description.value = "10 crates of fresh spinach, bagged and refrigerated";
    form.elements.quantity.value = "1";
    form.elements.storage_state.value = "refrigerated";
    form.elements.deadline.value = deadline.toISOString().slice(0, 16);
    form.elements.location.value = "Downtown Atlanta grocery store";
    form.elements.latitude.value = DEMO_COORDINATES.latitude;
    form.elements.longitude.value = DEMO_COORDINATES.longitude;
    form.elements.split_allowed.checked = false;
    form.elements.description.focus();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const payload = buildPayload(new FormData(form));
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
      renderNoMatch(normalized.rejections, normalized.message);
      return;
    }

    const selected = normalized.matches[0];
    const fallbacks = normalized.matches.slice(1, 3);
    const section = document.createElement("div");
    section.className = "recommendation";
    section.innerHTML = `
      <article class="selected-card">
        <div class="selected-card-top">
          <div>
            <span class="match-badge">Selected match</span>
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
        ${renderWarnings(selected.warnings)}
      </article>
      ${renderFallbacks(fallbacks)}
      ${renderOutreach(normalized.outreach || selected.outreach)}
      ${renderRejections(normalized.rejections)}
    `;

    resultRegion.replaceChildren(section);
    resultStatus.className = "status-chip success";
    resultStatus.textContent = normalized.manualReview ? "Review needed" : "Eligible match";
    attachCopyHandler();
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
    if (normalizedMatches.length && envelope.warnings) {
      normalizedMatches[0].warnings.push(...normalizeStrings(envelope.warnings));
    }

    return {
      matches: normalizedMatches,
      rejections: normalizeRejections(envelope.rejections || envelope.rejected || envelope.rejection_reasons),
      outreach: envelope.outreach || envelope.outreach_message || envelope.message_to_recipient || "",
      message: envelope.message || envelope.explanation || (envelope.no_match ? "No recipient passed every operational check." : ""),
      manualReview: Boolean(envelope.manual_review || envelope.requires_review),
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
    const score = match.fit_score ?? match.semantic_score ?? match.score;

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
          ${fallbacks.map((match, index) => `
            <article class="fallback-card">
              <span class="rank">0${index + 2}</span>
              <h5>${escapeHtml(match.name)}</h5>
              <p>${escapeHtml(match.reason || match.address || "Eligible alternate")}</p>
              <p class="fallback-stats">${escapeHtml(match.travel)} · ${escapeHtml(match.margin)} margin</p>
            </article>
          `).join("")}
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
        <div class="result-section-title"><h4 id="rejections-heading">Why others were filtered</h4><span>Auditable rules</span></div>
        <ul class="rejections">${rejections.slice(0, 4).map((item) =>
          `<li><span><strong>${escapeHtml(item.name)}:</strong> ${escapeHtml(item.reason)}</span></li>`
        ).join("")}</ul>
      </section>`;
  }

  function renderNoMatch(rejections, message) {
    const reasons = rejections.length
      ? `<ul class="no-match-reasons">${rejections.slice(0, 4).map((item) =>
          `<li><strong>${escapeHtml(item.name)}:</strong> ${escapeHtml(item.reason)}</li>`
        ).join("")}</ul>`
      : "";
    resultRegion.innerHTML = `
      <div class="no-match-state">
        <div class="no-match-icon" aria-hidden="true">×</div>
        <h3>No safe match yet</h3>
        <p>${escapeHtml(message || "No recipient passed every operational check. Try a later deadline, smaller quantity, or allow splitting.")}</p>
        ${reasons}
      </div>`;
    resultStatus.className = "status-chip error";
    resultStatus.textContent = "No eligible match";
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
