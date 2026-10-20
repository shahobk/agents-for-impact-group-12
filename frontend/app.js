(function () {
  "use strict";

  const workspace = document.querySelector("#workspace");
  const roleButtons = [...document.querySelectorAll("[data-role]")];
  const toast = document.querySelector("#toast");
  const TERMINAL = new Set(["completed", "failed", "expired", "cancelled", "no_match"]);
  const STATUS_LABELS = {
    submitted: "Submitted", matching: "Matching", notified: "Waiting", reserved: "Held",
    confirmed: "Confirmed", completed: "Completed", needs_transport: "Needs transport",
    no_match: "No match", failed: "Failed", expired: "Expired", cancelled: "Cancelled",
  };
  const state = {
    role: normalizeRole(new URLSearchParams(location.search).get("role")),
    token: "",
    timer: null,
    countdownTimer: null,
    data: null,
    selectedOfferId: "",
    reservation: null,
    demoRecipients: [],
  };

  captureFragmentToken();
  setRole(state.role, false);

  roleButtons.forEach((button) => button.addEventListener("click", () => setRole(button.dataset.role)));
  document.addEventListener("visibilitychange", () => {
    if (state.timer) startPolling(currentLoader);
  });

  function normalizeRole(role) {
    if (role === "status") return "status";
    return ["donor", "recipient", "ops"].includes(role) ? role : "donor";
  }

  function captureFragmentToken() {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const raw = fragment.get("token");
    if (raw) {
      const tokenRole = state.role === "status" ? "donor" : state.role;
      sessionStorage.setItem(tokenKey(tokenRole), raw);
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    }
  }

  function tokenKey(role) {
    return `pantry-relay:${role === "status" ? "donor" : role}:token`;
  }

  function setRole(role, updateUrl = true) {
    stopPolling();
    state.role = normalizeRole(role);
    state.data = null;
    state.selectedOfferId = "";
    state.reservation = null;
    state.token = sessionStorage.getItem(tokenKey(state.role)) || "";
    if (state.role === "donor" && state.token) state.role = "status";
    if (updateUrl) {
      const queryRole = state.role === "status" ? "status" : state.role;
      history.pushState(null, "", `${location.pathname}?role=${queryRole}`);
    }
    roleButtons.forEach((button) => {
      const activeRole = state.role === "status" ? "donor" : state.role;
      button.setAttribute("aria-current", button.dataset.role === activeRole ? "page" : "false");
    });
    render();
  }

  function render() {
    if (state.role === "donor") renderDonorForm();
    else if (state.role === "status") renderDonorStatus();
    else if (state.role === "recipient") renderRecipient();
    else renderCoordinator();
  }

  function renderDonorForm() {
    workspace.innerHTML = `
      <section class="hero compact">
        <p class="eyebrow">Donor workspace</p>
        <h1>Move good food while it is still good.</h1>
        <p>Review every detail before sending it to up to three pre-approved Atlanta recipients.</p>
      </section>
      <section class="panel form-panel" aria-labelledby="offer-title">
        <div class="section-heading">
          <div><p class="kicker">New rescue offer</p><h2 id="offer-title">Describe the handoff</h2></div>
          <button class="button quiet" id="load-demo" type="button">Load spinach scenario</button>
        </div>
        <form id="offer-form">
          <div class="field full">
            <label for="description">Food description</label>
            <textarea id="description" name="description" required rows="3" placeholder="10 crates of fresh spinach, bagged and refrigerated"></textarea>
            <small>Include packaging, visible condition, and any label dates. Food-safety decisions are never inferred.</small>
          </div>
          <div class="form-grid thirds">
            <div class="field"><label for="quantity-original">Donor wording</label><input id="quantity-original" name="quantity_original" required placeholder="10 crates" /></div>
            <div class="field"><label for="quantity-pallets">Confirmed pallet estimate</label><input id="quantity-pallets" name="quantity_pallets" required type="number" min="0.1" step="0.1" value="1" /></div>
            <div class="field"><label for="deadline">Must move by</label><input id="deadline" name="pickup_deadline" required type="datetime-local" /></div>
          </div>
          <fieldset class="field"><legend>Required storage</legend><div class="choice-row">
            ${radio("storage_state", "refrigerated", "Refrigerated", true)}
            ${radio("storage_state", "frozen", "Frozen")}
            ${radio("storage_state", "ambient", "Shelf stable")}
          </div></fieldset>
          <div class="location-review">
            <div class="section-heading small"><div><p class="kicker">Pickup point</p><h3>Share only what is needed</h3></div><button class="button secondary" id="use-location" type="button">Use my location</button></div>
            <div class="field full"><label for="pickup-address">Address or store label</label><input id="pickup-address" name="pickup_address" autocomplete="street-address" required placeholder="Downtown Atlanta grocery store" /></div>
            <div class="form-grid">
              <div class="field"><label for="latitude">Reviewed latitude</label><input id="latitude" name="donor_latitude" type="number" min="-90" max="90" step="any" required placeholder="33.749" /></div>
              <div class="field"><label for="longitude">Reviewed longitude</label><input id="longitude" name="donor_longitude" type="number" min="-180" max="180" step="any" required placeholder="-84.388" /></div>
            </div>
            <input id="location-source" name="location_source" type="hidden" value="address" />
            <p class="notice neutral">Exact donor coordinates stay hidden from recipients until a valid claim. Address entry remains available if GPS is declined.</p>
          </div>
          <fieldset class="field"><legend>Transport plan</legend><div class="transport-grid">
            ${radio("transport_mode", "recipient_pickup", "Recipient pickup", true, "Recipient reconfirms cold-chain transport.")}
            ${radio("transport_mode", "donor_delivery", "Donor delivery", false, "Limited to 5 km in this release.")}
            ${radio("transport_mode", "transportation_needed", "Transport needed", false, "Blocks confirmation until safely resolved.")}
          </div></fieldset>
          <div class="field radius-field" hidden><label for="delivery-radius">Delivery radius (km, maximum 5)</label><input id="delivery-radius" name="donor_delivery_radius_km" type="number" min="0.1" max="5" step="0.1" value="5" /></div>
          <label class="review-check"><input name="reviewed" type="checkbox" required /><span><strong>I reviewed the quantity, storage, location, transport, and deadline.</strong><small>The deadline I entered is authoritative; any FoodKeeper context is advisory.</small></span></label>
          <div id="form-error" class="notice danger" role="alert" hidden></div>
          <button class="button primary wide" type="submit">Start safe matching <span aria-hidden="true">→</span></button>
        </form>
      </section>`;

    const form = workspace.querySelector("#offer-form");
    workspace.querySelector("#load-demo").addEventListener("click", () => loadDemo(form));
    workspace.querySelector("#use-location").addEventListener("click", () => useLocation(form));
    form.addEventListener("change", (event) => {
      if (event.target.name === "transport_mode") {
        form.querySelector(".radius-field").hidden = event.target.value !== "donor_delivery";
      }
    });
    form.addEventListener("submit", submitOffer);
  }

  function radio(name, value, label, checked = false, help = "") {
    return `<label class="choice"><input type="radio" name="${name}" value="${value}" ${checked ? "checked" : ""}/><span><strong>${label}</strong>${help ? `<small>${help}</small>` : ""}</span></label>`;
  }

  function loadDemo(form) {
    const deadline = new Date(Date.now() + 6 * 60 * 60 * 1000);
    deadline.setMinutes(deadline.getMinutes() - deadline.getTimezoneOffset());
    form.elements.description.value = "10 crates of fresh spinach, bagged and refrigerated";
    form.elements.quantity_original.value = "10 crates";
    form.elements.quantity_pallets.value = "1";
    form.elements.pickup_deadline.value = deadline.toISOString().slice(0, 16);
    form.elements.pickup_address.value = "Downtown Atlanta grocery store";
    form.elements.donor_latitude.value = "33.749";
    form.elements.donor_longitude.value = "-84.388";
    form.elements.location_source.value = "corrected_pin";
    form.elements.reviewed.checked = true;
    form.elements.description.focus();
  }

  function useLocation(form) {
    const button = form.querySelector("#use-location");
    if (!navigator.geolocation) return showToast("This browser does not provide location. Enter an address and reviewed pin instead.");
    button.disabled = true;
    button.textContent = "Locating…";
    navigator.geolocation.getCurrentPosition((position) => {
      form.elements.donor_latitude.value = position.coords.latitude.toFixed(6);
      form.elements.donor_longitude.value = position.coords.longitude.toFixed(6);
      form.elements.location_source.value = "gps";
      button.textContent = "Location added";
      button.disabled = false;
    }, () => {
      button.textContent = "Use my location";
      button.disabled = false;
      showToast("Location was not shared. Enter an address and reviewed pin instead.");
    }, { enableHighAccuracy: false, timeout: 8000 });
  }

  async function submitOffer(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = form.querySelector("[type=submit]");
    const error = form.querySelector("#form-error");
    const data = new FormData(form);
    const transport = String(data.get("transport_mode"));
    const payload = {
      description: String(data.get("description")).trim(),
      quantity_original: String(data.get("quantity_original")).trim(),
      quantity_pallets: Number(data.get("quantity_pallets")),
      storage_state: String(data.get("storage_state")),
      pickup_deadline: new Date(String(data.get("pickup_deadline"))).toISOString(),
      pickup_address: String(data.get("pickup_address")).trim(),
      donor_latitude: Number(data.get("donor_latitude")),
      donor_longitude: Number(data.get("donor_longitude")),
      location_source: String(data.get("location_source")),
      transport_mode: transport,
    };
    if (transport === "donor_delivery") payload.donor_delivery_radius_km = Number(data.get("donor_delivery_radius_km"));
    setBusy(button, true, "Creating rescue…");
    error.hidden = true;
    try {
      const result = await api("/api/offers", { method: "POST", body: payload, mutation: true, token: null });
      if (!result.status_token) throw new Error("The offer was created without a donor status token.");
      sessionStorage.setItem(tokenKey("donor"), result.status_token);
      state.token = result.status_token;
      state.demoRecipients = Array.isArray(result.recipient_access) ? result.recipient_access : [];
      state.data = { offer: result, events: [] };
      state.role = "status";
      history.replaceState(null, "", `${location.pathname}?role=status`);
      renderDonorStatus();
    } catch (err) {
      error.textContent = errorMessage(err);
      error.hidden = false;
    } finally {
      setBusy(button, false);
    }
  }

  function renderDonorStatus() {
    if (!state.token) return renderTokenGate("donor", "Open private donor status", "Paste the opaque status token from your confirmation link.");
    workspace.innerHTML = loadingView("Loading donor status…");
    loadDonorStatus();
  }

  async function loadDonorStatus() {
    try {
      state.data = await api("/api/offers/status");
      drawDonorStatus();
      const status = offerOf(state.data).status;
      if (!TERMINAL.has(status)) startPolling(loadDonorStatus);
    } catch (err) {
      renderLoadError("Could not load this private offer", err, () => clearToken("donor"));
    }
  }

  function drawDonorStatus() {
    const offer = offerOf(state.data);
    const events = arrayOf(state.data.events || offer.events);
    const candidates = arrayOf(state.data.candidates || offer.candidates);
    const reservation = state.data.reservation || offer.reservation;
    workspace.innerHTML = `
      ${pageLead("Donor status", "Your rescue, from matching to handoff.", "This view polls the same authoritative workflow record shown to recipients and coordinators.")}
      <div class="dashboard-grid">
        <section class="panel span-2">
          <div class="section-heading"><div><p class="kicker">Offer ${e(shortId(offer.offer_id || offer.id))}</p><h2>${e(offer.description_original || offer.description || "Food rescue offer")}</h2></div>${statusPill(offer.status)}</div>
          ${progress(offer.status)}
          <div class="fact-grid">
            ${fact("Quantity", offer.quantity_original || pallets(offer.quantity_pallets))}
            ${fact("Storage", title(offer.storage_state))}
            ${fact("Deadline", dateTime(offer.deadline || offer.pickup_deadline))}
            ${fact("Transport", transportLabel(offer.transport_mode))}
          </div>
          ${reservation ? `<div class="notice success"><strong>${offer.status === "reserved" ? "A recipient has a temporary hold." : "Handoff reservation"}</strong> ${reservation.expires_at ? `Confirmation deadline: ${e(dateTime(reservation.expires_at))}.` : ""}</div>` : ""}
          <div class="button-row"><button class="button quiet" id="refresh-status" type="button">Refresh now</button><button class="button secondary" id="new-offer" type="button">Start another offer</button></div>
        </section>
        <section class="panel"><p class="kicker">Notification wave</p><h2>${candidates.filter((item) => item.notification_status === "sent").length || offer.notifications_count || 0} recipient updates</h2>
          <p class="muted">Simulated in-app outreach only. Live staffing and capacity remain uncertain until confirmation.</p>
          ${candidateList(candidates)}
          ${demoAccess(state.demoRecipients, candidates, offer.current_wave)}
        </section>
        ${timelinePanel(events)}
      </div>`;
    workspace.querySelector("#refresh-status").addEventListener("click", loadDonorStatus);
    workspace.querySelector("#new-offer").addEventListener("click", () => clearToken("donor", "donor"));
    bindDemoRecipientButtons();
  }

  function demoAccess(access, candidates, currentWave) {
    if (!access.length) return "";
    const currentIds = new Set(candidates.filter((item) => item.wave === currentWave && item.notification_status === "sent").map((item) => item.recipient_id));
    const currentAccess = access.filter((item) => currentIds.has(item.recipient_id));
    const visible = currentAccess.length ? currentAccess : access.slice(0, 3);
    return `<div class="demo-access"><p class="kicker">Current-wave demo sessions</p>${visible.map((item, index) => `<button class="button secondary wide demo-recipient" data-index="${access.indexOf(item)}" type="button">Open ${e(item.name || item.recipient_id || `recipient ${index + 1}`)} <span aria-hidden="true">↗</span></button>`).join("")}<small>Demo authorization links are opened without printing their opaque token.</small></div>`;
  }

  function bindDemoRecipientButtons() {
    workspace.querySelectorAll(".demo-recipient").forEach((button) => button.addEventListener("click", () => {
      const item = state.demoRecipients[Number(button.dataset.index)];
      if (!item) return;
      const target = item.role_url || `/?role=recipient#token=${encodeURIComponent(item.token)}`;
      window.open(target, "_blank", "noopener,noreferrer");
    }));
  }

  function renderRecipient() {
    if (!state.token) return renderTokenGate("recipient", "Open simulated recipient inbox", "Use a scoped link from the donor confirmation or paste a recipient demo token.");
    workspace.innerHTML = loadingView("Loading simulated inbox…");
    loadRecipient();
  }

  async function loadRecipient() {
    try {
      state.data = await api("/api/recipients/notifications");
      const notices = arrayOf(state.data.notifications);
      if (!state.selectedOfferId && notices[0]) state.selectedOfferId = notices[0].offer_id || notices[0].offer?.offer_id;
      drawRecipient();
      if (!notices.length || notices.some((item) => !TERMINAL.has(item.offer?.status || item.status))) startPolling(loadRecipient);
    } catch (err) {
      renderLoadError("Could not load this recipient inbox", err, () => clearToken("recipient"));
    }
  }

  function currentNotification() {
    const notices = arrayOf(state.data?.notifications);
    return notices.find((item) => (item.offer_id || item.offer?.offer_id) === state.selectedOfferId) || notices[0];
  }

  function drawRecipient() {
    const notices = arrayOf(state.data.notifications);
    const current = currentNotification();
    workspace.innerHTML = `
      ${pageLead("Recipient inbox", `Welcome, ${e(state.data.recipient?.name || "rescue partner")}.`, "These notifications are simulated; availability and staffing must be reconfirmed.")}
      <div class="inbox-layout">
        <section class="panel inbox-list"><div class="section-heading"><div><p class="kicker">Simulated inbox</p><h2>${notices.length} offer${notices.length === 1 ? "" : "s"}</h2></div><button id="leave-recipient" class="button quiet" type="button">Leave inbox</button></div>
          ${notices.length ? notices.map(notificationCard).join("") : emptyState("No active notifications", "A new wave will appear here when an eligible offer is available.")}
        </section>
        <section class="panel offer-detail" id="offer-detail">${current ? recipientDetail(current) : emptyState("Choose an offer", "Select a notification to review its safety and logistics evidence.")}</section>
      </div>`;
    workspace.querySelector("#leave-recipient").addEventListener("click", () => clearToken("recipient"));
    workspace.querySelectorAll(".notification-card").forEach((button) => button.addEventListener("click", () => {
      state.selectedOfferId = button.dataset.offerId;
      drawRecipient();
    }));
    bindRecipientActions(current);
  }

  function notificationCard(item) {
    const offer = item.offer || item;
    const id = item.offer_id || offer.offer_id || "";
    const active = id === state.selectedOfferId;
    return `<button type="button" class="notification-card ${active ? "active" : ""}" data-offer-id="${e(id)}" aria-pressed="${active}"><span>${e(item.title || offer.description || "Food rescue offer")}</span><small>${e(responseLabel(item.response || offer.response))} · ${e(dateTime(item.deadline || offer.deadline))}</small></button>`;
  }

  function recipientDetail(item) {
    const offer = item.offer || item;
    const offerId = item.offer_id || offer.offer_id;
    const response = item.response || offer.response || "pending";
    const reservation = item.reservation || offer.reservation || state.reservation;
    const status = offer.status || (response === "holding" ? "reserved" : "notified");
    const canRespond = response === "pending" && !["reserved", "confirmed", "completed"].includes(status);
    const canConfirm = response === "holding" || (status === "reserved" && reservation);
    const canComplete = response === "won" || status === "confirmed";
    return `<div class="section-heading"><div><p class="kicker">Offer ${e(shortId(offerId))}</p><h2>${e(offer.description || item.title || "Food rescue offer")}</h2></div>${statusPill(status)}</div>
      <p>${e(item.message || "Your operation passed deterministic storage, quantity, route, and deadline checks.")}</p>
      <div class="fact-grid compact-facts">
        ${fact("Quantity", offer.quantity_original || pallets(offer.quantity_pallets))}
        ${fact("Storage", title(offer.storage_state))}
        ${fact("Distance", offer.distance_miles == null ? "Route estimate pending" : `${formatNumber(offer.distance_miles)} mi estimated`)}
        ${fact("Deadline", dateTime(offer.deadline))}
        ${fact("Transport", transportLabel(offer.transport_mode))}
        ${fact("Response", responseLabel(response))}
      </div>
      <div class="map-card" aria-label="Pickup location summary"><span class="map-pin" aria-hidden="true"></span><div><strong>${e(locationLabel(offer.donor_location) || "Exact pickup point is hidden")}</strong><small>${offer.donor_location ? "Available because this recipient has a valid claim." : "Exact coordinates unlock only after a valid claim. Route values may use approximate ZIP-centroid data."}</small></div></div>
      <div class="notice warning"><strong>Live-capacity check:</strong> Confirm current space, staffing, and cold-chain transport before the handoff.</div>
      ${canRespond ? `<div class="action-block"><h3>Can you take the full offer?</h3><div class="button-row"><button class="button primary" data-action="claim" type="button">Accept temporarily</button><button class="button secondary" data-action="decline" type="button">Decline</button></div></div>` : ""}
      ${canConfirm ? confirmForm(offerId, reservation) : ""}
      ${canComplete ? completeForm(offerId) : ""}
      ${!canRespond && !canConfirm && !canComplete ? `<div class="notice neutral">This action is ${e(responseLabel(response).toLowerCase())}. Refreshing cannot replay an invalidated action.</div>` : ""}`;
  }

  function confirmForm(offerId, reservation) {
    const id = reservation?.reservation_id || reservation?.id || "";
    const defaultTime = new Date(Date.now() + 60 * 60 * 1000);
    defaultTime.setMinutes(defaultTime.getMinutes() - defaultTime.getTimezoneOffset());
    return `<form id="confirm-form" class="action-block" data-offer-id="${e(offerId)}" data-reservation-id="${e(id)}"><h3>Confirm within the hold</h3>${reservation?.expires_at ? `<p class="countdown" data-expires="${e(reservation.expires_at)}">Hold expires ${e(dateTime(reservation.expires_at))}</p>` : ""}
      <div class="field"><label for="handoff-time">Expected handoff time</label><input id="handoff-time" name="expected_handoff_time" type="datetime-local" value="${defaultTime.toISOString().slice(0, 16)}" required /></div>
      <div class="form-grid"><div class="field"><label for="contact-name">Contact name</label><input id="contact-name" name="contact_name" required autocomplete="name" /></div><div class="field"><label for="contact-phone">Contact phone</label><input id="contact-phone" name="contact_phone" required autocomplete="tel" type="tel" /></div></div>
      <label class="review-check"><input name="capacity_ack" type="checkbox" required /><span><strong>Current capacity and safe transport are available.</strong><small>Expected handoff must be after now and no later than the donor deadline.</small></span></label>
      <button class="button primary wide" type="submit" ${id ? "" : "disabled"}>Confirm handoff</button>${id ? "" : `<p class="notice danger">Reservation identifier unavailable. Refresh the inbox before confirming.</p>`}</form>`;
  }

  function completeForm(offerId) {
    return `<form id="complete-form" class="action-block" data-offer-id="${e(offerId)}"><h3>Record completed handoff</h3><div class="form-grid"><div class="field"><label for="actual-quantity">Actual pallets (optional)</label><input id="actual-quantity" name="actual_quantity_pallets" type="number" min="0" step="0.1" /></div><div class="field"><label for="completion-note">Handoff note (optional)</label><input id="completion-note" name="note" /></div></div><button class="button primary wide" type="submit">Mark handoff complete</button></form>`;
  }

  function bindRecipientActions(current) {
    if (!current) return;
    startCountdown();
    const offerId = current.offer_id || current.offer?.offer_id;
    workspace.querySelector("[data-action=claim]")?.addEventListener("click", async (event) => mutateButton(event.currentTarget, `/api/offers/${encodeURIComponent(offerId)}/claim`, {}, (result) => {
      state.reservation = result.reservation;
      showToast("Temporary hold created. Confirm before it expires.");
      loadRecipient();
    }));
    workspace.querySelector("[data-action=decline]")?.addEventListener("click", async (event) => {
      const reason = window.prompt("Optional decline reason (do not include sensitive information):", "Insufficient current capacity");
      if (reason === null) return;
      mutateButton(event.currentTarget, `/api/offers/${encodeURIComponent(offerId)}/decline`, { reason }, () => { showToast("Offer declined."); loadRecipient(); });
    });
    workspace.querySelector("#confirm-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!form.reportValidity()) return;
      const data = new FormData(form);
      const payload = { expected_handoff_time: new Date(String(data.get("expected_handoff_time"))).toISOString(), contact_name: String(data.get("contact_name")).trim(), contact_phone: String(data.get("contact_phone")).trim() };
      mutateButton(form.querySelector("[type=submit]"), `/api/reservations/${encodeURIComponent(form.dataset.reservationId)}/confirm`, payload, () => { showToast("Handoff confirmed."); loadRecipient(); });
    });
    workspace.querySelector("#complete-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const quantity = data.get("actual_quantity_pallets");
      const payload = { note: String(data.get("note") || "").trim() };
      if (quantity !== "") payload.actual_quantity_pallets = Number(quantity);
      mutateButton(form.querySelector("[type=submit]"), `/api/offers/${encodeURIComponent(form.dataset.offerId)}/complete`, payload, () => { showToast("Handoff completed and impact recorded."); loadRecipient(); });
    });
  }

  function renderCoordinator() {
    if (!state.token) return renderTokenGate("ops", "Open coordinator operations", "Enter the separate coordinator demo bearer token.");
    workspace.innerHTML = loadingView("Loading operations queue…");
    loadCoordinator();
  }

  async function loadCoordinator() {
    try {
      state.data = await api("/api/ops/offers");
      const offers = coordinatorOffers(state.data);
      if (!state.selectedOfferId && offers[0]) state.selectedOfferId = offers[0].offer_id || offers[0].id;
      drawCoordinator();
      if (offers.some((offer) => !TERMINAL.has(offer.status))) startPolling(loadCoordinator);
    } catch (err) {
      renderLoadError("Could not load coordinator operations", err, () => clearToken("ops"));
    }
  }

  function drawCoordinator() {
    const offers = coordinatorOffers(state.data);
    const impact = state.data.impact || {};
    const current = offers.find((offer) => (offer.offer_id || offer.id) === state.selectedOfferId) || offers[0];
    workspace.innerHTML = `
      ${pageLead("Coordinator operations", "Keep every rescue safe, explainable, and moving.", "Demo authorization only — this is not production identity or recipient onboarding.")}
      <section class="metric-strip" aria-label="Completed impact"><div><strong>${e(impact.completed_offers ?? 0)}</strong><span>completed rescues</span></div><div><strong>${e(formatNumber(impact.completed_quantity_pallets ?? 0))}</strong><span>pallets moved</span></div><div><strong>${e(offers.filter((o) => !TERMINAL.has(o.status)).length)}</strong><span>active offers</span></div></section>
      <div class="ops-layout">
        <section class="panel ops-queue"><div class="section-heading"><div><p class="kicker">Shared queue</p><h2>${offers.length} offer${offers.length === 1 ? "" : "s"}</h2></div><button id="leave-ops" class="button quiet" type="button">Lock view</button></div>${offers.length ? offers.map(opsCard).join("") : emptyState("Queue is clear", "New donor offers will appear here.")}</section>
        <section class="panel ops-detail">${current ? coordinatorDetail(current) : emptyState("Choose an offer", "Select a queue item to inspect its timeline and actions.")}</section>
      </div>`;
    workspace.querySelector("#leave-ops").addEventListener("click", () => clearToken("ops"));
    workspace.querySelectorAll(".ops-card").forEach((button) => button.addEventListener("click", () => { state.selectedOfferId = button.dataset.offerId; drawCoordinator(); }));
    workspace.querySelectorAll("[data-ops-action]").forEach((button) => button.addEventListener("click", () => runOpsAction(button, current)));
  }

  function opsCard(offer) {
    const id = offer.offer_id || offer.id;
    return `<button class="ops-card ${id === state.selectedOfferId ? "active" : ""}" data-offer-id="${e(id)}" type="button"><span>${e(offer.description_original || offer.description || "Food rescue offer")}</span><small>${e(STATUS_LABELS[offer.status] || title(offer.status))} · ${e(dateTime(offer.deadline || offer.pickup_deadline))}</small></button>`;
  }

  function coordinatorDetail(offer) {
    const id = offer.offer_id || offer.id;
    const events = arrayOf(offer.events);
    const candidates = arrayOf(offer.candidates);
    const closed = TERMINAL.has(offer.status);
    return `<div class="section-heading"><div><p class="kicker">Offer ${e(shortId(id))}</p><h2>${e(offer.description_original || offer.description || "Food rescue offer")}</h2></div>${statusPill(offer.status)}</div>
      <div class="fact-grid compact-facts">${fact("Quantity", offer.quantity_original || pallets(offer.quantity_pallets))}${fact("Deadline", dateTime(offer.deadline || offer.pickup_deadline))}${fact("Transport", transportLabel(offer.transport_mode))}${fact("Wave", offer.current_wave ?? "—")}${fact("Reserved for", offer.selected_recipient_name || offer.selected_recipient_id || "No one yet")}${fact("Location", offer.pickup_address || "Private donor pin")}</div>
      <div class="map-card"><span class="map-pin" aria-hidden="true"></span><div><strong>${e(offer.pickup_address || "Donor pickup point")}</strong><small>Coordinator access may show an exact corrected pin. Candidate locations and need context may use approximate ZIP centroids.</small></div></div>
      <section class="subsection"><div class="section-heading small"><div><p class="kicker">Deterministic candidate audit</p><h3>Why recipients did or did not qualify</h3></div></div>${candidateList(candidates, true)}</section>
      <section class="subsection"><p class="kicker">Recovery and outcome</p><div class="button-row wrap"><button class="button secondary" data-ops-action="expire" type="button" ${closed ? "disabled" : ""}>Simulate timeout</button><button class="button secondary" data-ops-action="promote" type="button" ${closed ? "disabled" : ""}>Promote wave</button><button class="button danger" data-ops-action="cancel" type="button" ${closed ? "disabled" : ""}>Cancel</button><button class="button danger" data-ops-action="fail" type="button" ${closed ? "disabled" : ""}>Mark failed</button></div><p class="muted">${closed ? "This offer is terminal; state-changing controls are disabled." : "Timeout is a demo/recovery accelerator; authenticated Cloud Tasks remain the normal expiry path."}</p></section>
      ${events.length ? `<section class="subsection">${timelineContent(events)}</section>` : ""}`;
  }

  async function runOpsAction(button, offer) {
    const action = button.dataset.opsAction;
    const risky = action === "cancel" || action === "fail";
    let reason = action === "expire" ? "Coordinator demo timeout" : action === "promote" ? "Coordinator advanced silent wave" : "";
    if (risky) {
      reason = window.prompt(`Reason to ${action} this offer:`, "Operational issue documented by coordinator");
      if (!reason) return;
    }
    const id = offer.offer_id || offer.id;
    await mutateButton(button, `/api/ops/offers/${encodeURIComponent(id)}/${action}`, { reason }, () => { showToast(action === "expire" ? "Due-state advancement requested." : `Offer action recorded: ${action}.`); loadCoordinator(); });
  }

  function renderTokenGate(role, heading, copy) {
    workspace.innerHTML = `${pageLead(role === "ops" ? "Coordinator access" : role === "recipient" ? "Recipient access" : "Donor access", heading, copy)}<section class="panel token-panel"><form id="token-form"><div class="field"><label for="access-token">Opaque access token</label><input id="access-token" name="token" type="password" autocomplete="off" required /><small>The token is removed from shared links after reading and sent only in the Authorization header.</small></div><button class="button primary wide" type="submit">Open scoped view</button></form></section>`;
    workspace.querySelector("#token-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const raw = String(new FormData(event.currentTarget).get("token") || "").trim();
      if (!raw) return;
      sessionStorage.setItem(tokenKey(role), raw);
      state.token = raw;
      state.role = role === "donor" ? "status" : role;
      render();
    });
  }

  function clearToken(role, nextRole = role) {
    sessionStorage.removeItem(tokenKey(role));
    state.token = "";
    setRole(nextRole);
  }

  function candidateList(candidates, audit = false) {
    if (!candidates.length) return `<p class="muted">Candidate evidence will appear after matching.</p>`;
    return `<ul class="candidate-list">${candidates.slice(0, audit ? 30 : 3).map((candidate) => {
      const eligible = candidate.eligible !== false;
      const reason = arrayOf(candidate.reasons).join("; ") || candidate.reason || candidate.selection_reason || (eligible ? "Passed deterministic checks" : "Did not pass eligibility checks");
      return `<li><span class="candidate-mark ${eligible ? "pass" : "fail"}" aria-hidden="true">${eligible ? "✓" : "×"}</span><div><strong>${e(candidate.name || candidate.recipient_name || candidate.recipient_id || "Recipient")}</strong><small>${e(responseLabel(candidate.response || candidate.notification_status || (eligible ? "eligible" : "rejected")))} · ${e(reason)}</small>${candidate.tract_need_evidence ? `<small>${e(needEvidence(candidate.tract_need_evidence))}</small>` : ""}</div></li>`;
    }).join("")}</ul>`;
  }

  function timelinePanel(events) {
    return `<section class="panel"><p class="kicker">Authoritative timeline</p><h2>What happened</h2>${timelineContent(events)}</section>`;
  }

  function timelineContent(events) {
    if (!events.length) return `<p class="muted">The first event will appear after the offer is persisted.</p>`;
    return `<ol class="timeline">${events.map((event) => `<li><span aria-hidden="true"></span><div><strong>${e(event.display_text || event.message || event.text || title(event.type) || "Offer updated")}</strong><small>${e(dateTime(event.timestamp || event.created_at))}${event.actor_type ? ` · ${e(title(event.actor_type))}` : ""}</small></div></li>`).join("")}</ol>`;
  }

  function progress(status) {
    const steps = ["submitted", "matching", "notified", "reserved", "confirmed", "completed"];
    const index = steps.indexOf(status);
    const exception = index === -1;
    return `<ol class="progress" aria-label="Offer progress">${steps.map((step, i) => `<li class="${!exception && i <= index ? "done" : ""} ${step === status ? "current" : ""}"><span>${i + 1}</span><small>${e(STATUS_LABELS[step])}</small></li>`).join("")}</ol>`;
  }

  function pageLead(kicker, titleText, copy) {
    return `<section class="hero compact"><p class="eyebrow">${e(kicker)}</p><h1>${e(titleText)}</h1><p>${e(copy)}</p></section>`;
  }

  function fact(label, value) {
    return `<div class="fact"><dt>${e(label)}</dt><dd>${e(value ?? "—")}</dd></div>`;
  }

  function statusPill(status) {
    const value = status || "submitted";
    return `<span class="status-pill status-${e(value)}">${e(STATUS_LABELS[value] || title(value))}</span>`;
  }

  function emptyState(titleText, copy) {
    return `<div class="empty-state"><span aria-hidden="true">↝</span><h3>${e(titleText)}</h3><p>${e(copy)}</p></div>`;
  }

  function loadingView(label) {
    return `<section class="loading-state" role="status"><span aria-hidden="true"></span><p>${e(label)}</p></section>`;
  }

  function renderLoadError(titleText, err, reset) {
    stopPolling();
    workspace.innerHTML = `<section class="panel error-panel"><p class="kicker">Access or connection issue</p><h1>${e(titleText)}</h1><p>${e(errorMessage(err))}</p><div class="button-row"><button id="retry-load" class="button primary" type="button">Try again</button><button id="reset-token" class="button secondary" type="button">Use another token</button></div></section>`;
    workspace.querySelector("#retry-load").addEventListener("click", render);
    workspace.querySelector("#reset-token").addEventListener("click", reset);
  }

  let currentLoader = null;
  function startPolling(loader) {
    if (state.timer) window.clearTimeout(state.timer);
    state.timer = null;
    currentLoader = loader;
    const delay = document.hidden ? 15000 : 2000;
    state.timer = window.setTimeout(async () => {
      state.timer = null;
      await loader();
    }, delay);
  }

  function stopPolling() {
    if (state.timer) window.clearTimeout(state.timer);
    if (state.countdownTimer) window.clearInterval(state.countdownTimer);
    state.timer = null;
    state.countdownTimer = null;
  }

  function startCountdown() {
    const element = workspace.querySelector("[data-expires]");
    if (!element) return;
    if (state.countdownTimer) window.clearInterval(state.countdownTimer);
    const update = () => {
      const expires = new Date(element.dataset.expires).getTime();
      const remaining = Math.max(0, expires - Date.now());
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      element.textContent = remaining > 0
        ? `Hold: ${minutes}:${String(seconds).padStart(2, "0")} remaining · expires ${dateTime(element.dataset.expires)}`
        : "Hold expired. Refreshing eligibility…";
      if (remaining === 0) {
        window.clearInterval(state.countdownTimer);
        state.countdownTimer = null;
      }
    };
    update();
    state.countdownTimer = window.setInterval(update, 1000);
  }

  async function mutateButton(button, path, body, onSuccess) {
    setBusy(button, true, "Working…");
    try {
      const result = await api(path, { method: "POST", body, mutation: true });
      onSuccess(result);
      return result;
    } catch (err) {
      showToast(errorMessage(err), true);
      return null;
    } finally {
      setBusy(button, false);
    }
  }

  async function api(path, options = {}) {
    const headers = { Accept: "application/json" };
    const token = options.token === null ? "" : (options.token || state.token);
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.mutation) headers["X-Idempotency-Key"] = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const response = await fetch(path, { method: options.method || "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    let result = {};
    try { result = await response.json(); } catch (_err) { /* handled below */ }
    if (!response.ok) {
      const detail = result.detail;
      const message = typeof detail === "string" ? detail : detail?.message || detail?.code || result.error || `Request failed (${response.status})`;
      const error = new Error(message);
      error.status = response.status;
      error.detail = detail;
      throw error;
    }
    return result;
  }

  function setBusy(button, busy, text) {
    if (!button) return;
    if (busy) {
      button.dataset.label = button.textContent;
      button.disabled = true;
      button.textContent = text;
    } else {
      button.disabled = false;
      if (button.dataset.label) button.textContent = button.dataset.label;
    }
  }

  let toastTimer;
  function showToast(message, danger = false) {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.toggle("danger", danger);
    toast.hidden = false;
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 5000);
  }

  function offerOf(data) { return data?.offer || data || {}; }
  function coordinatorOffers(data) {
    return arrayOf(data?.offers).map((entry) => entry?.offer
      ? { ...entry.offer, events: arrayOf(entry.events), candidates: arrayOf(entry.candidates), reservation: entry.reservation }
      : entry);
  }
  function arrayOf(value) { return Array.isArray(value) ? value : []; }
  function shortId(value) { const text = String(value || ""); return text ? text.slice(0, 8) : "pending"; }
  function title(value) { return String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
  function pallets(value) { return value == null ? "—" : `${formatNumber(value)} pallet${Number(value) === 1 ? "" : "s"}`; }
  function formatNumber(value) { const number = Number(value); return Number.isFinite(number) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(number) : String(value || "0"); }
  function transportLabel(value) { return ({ recipient_pickup: "Recipient pickup", donor_delivery: "Donor delivery (≤ 5 km)", transportation_needed: "Transportation needed" })[value] || title(value) || "—"; }
  function locationLabel(value) {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (value.address) return value.address;
    if (value.latitude != null && value.longitude != null) return `${formatNumber(value.latitude)}, ${formatNumber(value.longitude)}`;
    return "Claimed pickup point";
  }
  function needEvidence(value) {
    if (typeof value === "string") return `Approximate need context: ${value}`;
    const label = value?.label || "Approximate nearest-tract need context";
    const score = value?.score == null ? "" : ` · score ${formatNumber(value.score)}`;
    return `${label}${score}`;
  }
  function responseLabel(value) { return ({ pending: "Awaiting response", declined: "Declined", holding: "Holding", hold_expired: "Hold expired", timed_out: "Timed out", won: "Confirmed winner", invalidated: "Action invalidated", eligible: "Eligible", rejected: "Rejected", sent: "Notified" })[value] || title(value) || "Pending"; }
  function dateTime(value) { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date); }
  function errorMessage(err) { return err instanceof Error ? err.message : "The service is unavailable. Your input has not been lost."; }
  function e(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
})();
