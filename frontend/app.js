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
    demoRecipients: readSessionJson("pantry-relay:demo-recipients", []),
    draftMeta: { inferredFields: [], warnings: [], source: null },
    offerLocation: null,
    recognition: null,
    captureMode: "type",
    publicSummary: null,
    commandKeys: new Map(),
    equityAudit: null,
    coordinatorSession: "idle",
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
      if (tokenRole !== "ops") sessionStorage.setItem(tokenKey(tokenRole), raw);
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    }
  }

  function tokenKey(role) {
    return `pantry-relay:${role === "status" ? "donor" : role}:token`;
  }

  function setRole(role, updateUrl = true) {
    stopSpeechCapture();
    stopPolling();
    state.role = normalizeRole(role);
    state.data = null;
    state.selectedOfferId = "";
    state.reservation = null;
    if (state.role === "ops") {
      sessionStorage.removeItem(tokenKey("ops"));
      state.token = "";
      state.coordinatorSession = "idle";
    } else {
      state.token = sessionStorage.getItem(tokenKey(state.role)) || "";
    }
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
    stopSpeechCapture();
    workspace.innerHTML = `
      <section class="hero demo-hero">
        <div class="hero-copy">
          <p class="eyebrow">Atlanta grocery rescue pilot</p>
          <h1>Ten crates. Six hours. One safe handoff.</h1>
          <p>Pantry Relay finds likely recipients, rejects unsafe options with deterministic rules, and protects the first qualified acceptance.</p>
          <div class="hero-actions"><button class="button primary hero-button" id="run-demo" type="button">Run the spinach rescue <span aria-hidden="true">→</span></button><a class="button-link" href="#capture">Create a different offer</a></div>
        </div>
        ${landingMap()}
      </section>
      <section class="proof-rail" aria-label="How Pantry Relay works">
        <div><strong>30</strong><span>semantic candidates</span></div><div><strong>≤3</strong><span>notified per wave</span></div><div><strong>10 min</strong><span>protected hold</span></div><div><strong>1</strong><span>shared workflow</span></div>
      </section>
      <p class="impact-context"><strong>Impact starts at completion.</strong> Offers and temporary holds are food at risk—not food rescued.</p>
      <section class="public-impact" aria-label="Demo environment impact"><div><span id="public-completed">—</span><small>completed rescues</small></div><div><span id="public-pallets">—</span><small>completed pallets</small></div><div><span id="public-active">—</span><small>active offers</small></div><p id="public-scope">Authoritative workflow counts for this demo environment; not live recipient operations.</p></section>
      <section class="panel capture-panel" id="capture" aria-labelledby="capture-title">
        <div class="section-heading">
          <div><p class="kicker">Offer intake</p><h2 id="capture-title">Tell us what needs a home</h2><p class="muted">Speak, add a photo, or type. Nothing is submitted until you review every field.</p></div>
        </div>
        <div class="capture-methods" role="group" aria-label="Offer capture method"><button class="capture-method active" data-mode="type" type="button"><span aria-hidden="true">Aa</span><strong>Type</strong><small>Describe the food</small></button><button class="capture-method" id="speak-offer" data-mode="speak" type="button"><span aria-hidden="true">◉</span><strong>Speak</strong><small>No audio retained</small></button><label class="capture-method" for="photo-offer"><input id="photo-offer" class="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" /><span aria-hidden="true">▧</span><strong>Photo</strong><small>Take or upload</small></label></div>
        <div class="field capture-text"><label for="offer-text">Food and quantity</label><textarea id="offer-text" rows="4" placeholder="For example: 10 crates of bagged spinach, refrigerated, must move by 8 p.m."></textarea><small id="capture-help">Include packaging, visible condition, storage, and any label dates. Pantry Relay never infers food safety.</small></div>
        <div id="capture-status" class="capture-status" role="status" aria-live="polite"></div>
        <button class="button primary wide" id="review-offer" type="button">Create editable draft <span aria-hidden="true">→</span></button>
      </section>`;
    workspace.querySelector("#run-demo").addEventListener("click", loadDemo);
    workspace.querySelector("#review-offer").addEventListener("click", interpretOfferText);
    workspace.querySelector("#speak-offer").addEventListener("click", startSpeechCapture);
    workspace.querySelector("#photo-offer").addEventListener("change", analyzeOfferPhoto);
    workspace.querySelector("[data-mode=type]").addEventListener("click", () => {
      state.captureMode = "type";
      workspace.querySelector("#offer-text").focus();
    });
    loadPublicSummary();
  }

  function radio(name, value, label, checked = false, help = "") {
    return `<label class="choice"><input type="radio" name="${name}" value="${value}" required ${checked ? "checked" : ""}/><span><strong>${label}</strong>${help ? `<small>${help}</small>` : ""}</span></label>`;
  }

  function landingMap(review = false) {
    return `<div class="city-map-card ${review ? "review-map" : ""}" aria-label="Illustrative Atlanta recipient coverage map"><div class="map-topline"><span>Atlanta rescue coverage</span><span class="map-live"><i></i> Demo network</span></div><div class="city-map" aria-hidden="true"><span class="road road-a"></span><span class="road road-b"></span><span class="road road-c"></span><span class="city-label midtown">Midtown</span><span class="city-label downtown">Downtown</span><span class="city-label westside">Westside</span><span class="coverage-ring"></span><span class="map-dot donor"></span><span class="map-dot recipient one"></span><span class="map-dot recipient two"></span><span class="map-dot recipient three"></span></div><div class="map-legend"><span><i class="legend-donor"></i>Generated demo anchor</span><span><i class="legend-recipient"></i>Approximate recipient area</span></div><p>Estimated logistics—not live vehicle tracking. Exact pickup details stay private until a valid claim.</p></div>`;
  }

  async function loadPublicSummary() {
    try {
      const summary = await api("/api/public/summary", { token: null });
      state.publicSummary = summary;
      const activity = summary.activity || {};
      const impact = summary.impact || {};
      const completed = workspace.querySelector("#public-completed");
      const palletsMoved = workspace.querySelector("#public-pallets");
      const active = workspace.querySelector("#public-active");
      const scope = workspace.querySelector("#public-scope");
      if (completed) completed.textContent = formatNumber(impact.completed_offers ?? 0);
      if (palletsMoved) palletsMoved.textContent = formatNumber(impact.completed_quantity_pallets ?? 0);
      if (active) active.textContent = formatNumber(activity.active_offers ?? 0);
      if (scope) scope.textContent = "Authoritative workflow counts for this demo environment; generated recipient profiles and no external live-capacity feed.";
    } catch (_err) {
      const scope = workspace.querySelector("#public-scope");
      if (scope) scope.textContent = "Workflow totals are temporarily unavailable. No live recipient-capacity feed is connected.";
    }
  }

  function workflowMap(map, titleText = "Offer logistics") {
    if (!map) return "";
    const donor = map.donor;
    const recipients = arrayOf(map.recipients);
    const markers = recipients.slice(0, 8).map((recipient, index) => {
      const point = mapPoint(recipient.latitude, recipient.longitude);
      return point ? `<span class="workflow-point recipient-point" style="left:${point.x}%;top:${point.y}%" title="${e(recipient.name || `Recipient ${index + 1}`)}" aria-hidden="true"></span>` : "";
    }).join("");
    const donorPoint = donor ? mapPoint(donor.latitude, donor.longitude) : null;
    const limitations = arrayOf(map.limitations).join(" ");
    const routes = recipients.filter((recipient) => recipient.distance_miles != null).slice(0, 3).map((recipient) => {
      const source = recipient.route_source === "google_routes" ? "Google Routes estimate" : "Haversine estimate";
      const duration = recipient.estimated_minutes == null ? "" : ` · ${formatNumber(recipient.estimated_minutes)} min`;
      return `<li><span>${e(recipient.name || recipient.recipient_id)}</span><strong>${e(formatNumber(recipient.distance_miles))} mi${e(duration)}</strong><small>${e(source)}${recipient.traffic_aware ? " · traffic-aware" : " · not live traffic"}</small></li>`;
    }).join("");
    const donorLabel = donor ? (donor.label || (donor.precision === "reviewed_address_candidate" ? "Reviewed address candidate" : "Reviewed donor pin")) : "Donor pin private";
    return `<section class="workflow-map-card" aria-label="${e(titleText)}"><div class="map-topline"><span>${e(titleText)}</span><span class="map-live"><i></i> Estimated logistics</span></div><div class="workflow-map" aria-hidden="true"><span class="road road-a"></span><span class="road road-b"></span><span class="road road-c"></span><span class="city-label midtown">Midtown</span><span class="city-label downtown">Downtown</span><span class="city-label westside">Westside</span>${markers}${donorPoint ? `<span class="workflow-point donor-point" style="left:${donorPoint.x}%;top:${donorPoint.y}%"></span>` : ""}</div><div class="map-legend"><span><i class="legend-donor"></i>${e(donorLabel)}</span><span><i class="legend-recipient"></i>Approximate recipient area</span></div>${routes ? `<ul class="workflow-routes">${routes}</ul>` : ""}<p>${e(limitations || "Recipient locations and route values are approximate. This is not live tracking.")}</p></section>`;
  }

  function mapPoint(latitude, longitude) {
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      x: Math.max(3, Math.min(97, ((lng + 84.55) / .32) * 100)),
      y: Math.max(4, Math.min(96, ((33.91 - lat) / .3) * 100)),
    };
  }

  function interactivePinMap() {
    return `<button class="pin-map" id="pin-map" type="button" aria-label="Place or adjust the pickup pin on an illustrative Atlanta map" aria-describedby="pin-map-help"><span class="road road-a"></span><span class="road road-b"></span><span class="road road-c"></span><span class="city-label midtown">Midtown</span><span class="city-label downtown">Downtown</span><span class="city-label westside">Westside</span><span id="reviewed-pin" class="reviewed-pin" aria-hidden="true"></span><span class="pin-instruction">Click, tap, or press Enter to place pin</span></button><small id="pin-map-help" class="map-keyboard-help">Keyboard activation places the pin at the center of this illustrative Atlanta map.</small>`;
  }

  function setMapPin(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const keyboardActivation = event.detail === 0 || (event.clientX === 0 && event.clientY === 0);
    const x = keyboardActivation ? .5 : Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = keyboardActivation ? .5 : Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    state.offerLocation = {
      latitude: 33.83 - y * 0.13,
      longitude: -84.48 + x * 0.18,
      source: "corrected_pin",
    };
    positionMapPin();
    updateLocationSummary();
  }

  function positionMapPin() {
    const pin = workspace.querySelector("#reviewed-pin");
    if (!pin) return;
    if (!state.offerLocation) { pin.hidden = true; return; }
    const x = (state.offerLocation.longitude + 84.48) / 0.18;
    const y = (33.83 - state.offerLocation.latitude) / 0.13;
    pin.hidden = false;
    pin.style.left = `${Math.max(2, Math.min(98, x * 100))}%`;
    pin.style.top = `${Math.max(4, Math.min(96, y * 100))}%`;
  }

  function locationReviewLabel() {
    const labels = { gps: "GPS location reviewed. Click the map to correct the pin.", corrected_pin: "Map pin reviewed. Click again to adjust.", address: "Address pin reviewed. Click the map to adjust." };
    return labels[state.offerLocation?.source] || "Pickup pin reviewed.";
  }

  function updateLocationSummary() {
    const summary = workspace.querySelector("#location-summary");
    if (summary) summary.textContent = locationReviewLabel();
  }

  function inferredTag(inferred, field) {
    return inferred.has(field) ? `<span class="inferred-tag">Suggested · review</span>` : "";
  }

  function draftWarnings() {
    const warnings = state.draftMeta.warnings;
    const photoNote = state.draftMeta.source?.photo_retained === false
      ? `<div class="notice neutral"><strong>${state.draftMeta.source?.photo_analyzed ? "Photo analyzed." : "Photo handled transiently."}</strong> It was used only to suggest this draft and is not retained by Pantry Relay.</div>` : "";
    return `${photoNote}${warnings.map((warning) => `<div class="notice warning">${e(warning)}</div>`).join("")}`;
  }

  function localDateTimeValue(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 16);
  }

  function setCaptureStatus(message, danger = false) {
    const status = workspace.querySelector("#capture-status");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("danger", danger);
  }

  function fileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
      reader.onerror = () => reject(new Error("The photo could not be read."));
      reader.readAsDataURL(file);
    });
  }

  function loadDemo() {
    const deadline = new Date(Date.now() + 6 * 60 * 60 * 1000);
    state.offerLocation = { latitude: 33.749, longitude: -84.388, source: "corrected_pin" };
    state.draftMeta = {
      inferredFields: ["description", "quantity_original", "quantity_pallets", "storage_state", "pickup_deadline", "transport_mode"],
      warnings: ["Demo scenario: downtown Atlanta is a generated anchor, not a live grocer location."],
      source: { provider: "demo_scenario", photo_analyzed: false, photo_retained: null },
    };
    renderDonorReview({ description: "10 crates of fresh spinach, bagged and refrigerated", quantity_original: "10 crates", quantity_pallets: 1, storage_state: "refrigerated", pickup_deadline: deadline.toISOString(), transport_mode: "recipient_pickup", pickup_address: "Downtown Atlanta demo grocery" });
  }

  async function interpretOfferText() {
    const text = workspace.querySelector("#offer-text").value.trim();
    if (!text) return setCaptureStatus("Describe the food before creating a draft.", true);
    const button = workspace.querySelector("#review-offer");
    setBusy(button, true, "Creating draft…");
    try {
      const body = state.captureMode === "speech" ? { transcript: text } : { text };
      const result = await api("/api/intake/extract", { method: "POST", body, token: null });
      adoptDraft(result, { description: text });
    } catch (err) {
      setCaptureStatus(`${errorMessage(err)} Your description is still here.`, true);
    } finally { setBusy(button, false); }
  }

  function startSpeechCapture() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return setCaptureStatus("Speech capture is not supported in this browser. Type your offer instead.", true);
    if (state.recognition) return state.recognition.stop();
    const button = workspace.querySelector("#speak-offer");
    const recognition = new SpeechRecognition();
    state.captureMode = "speech";
    state.recognition = recognition;
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onstart = () => {
      if (state.recognition !== recognition || !button.isConnected) return;
      button.classList.add("listening");
      setCaptureStatus("Listening… audio is processed by the browser and is not retained by Pantry Relay.");
    };
    recognition.onresult = (event) => {
      if (state.recognition !== recognition) return;
      const transcript = Array.from(event.results).map((result) => result[0].transcript).join(" ").trim();
      const input = workspace.querySelector("#offer-text");
      if (!input) return;
      input.value = transcript;
      setCaptureStatus("Transcript captured. Review the text, then create an editable draft.");
    };
    recognition.onerror = () => {
      if (state.recognition === recognition) setCaptureStatus("Speech capture ended without a transcript. Type the offer instead.", true);
    };
    recognition.onend = () => {
      if (state.recognition === recognition) state.recognition = null;
      if (button.isConnected) button.classList.remove("listening");
    };
    recognition.start();
  }

  function stopSpeechCapture() {
    const recognition = state.recognition;
    if (!recognition) return;
    state.recognition = null;
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try { recognition.abort(); } catch (_err) { /* already stopped */ }
    workspace.querySelector("#speak-offer")?.classList.remove("listening");
  }

  async function analyzeOfferPhoto(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return setCaptureStatus("Choose a photo smaller than 5 MB.", true);
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return setCaptureStatus("Choose a JPEG, PNG, or WebP image.", true);
    setCaptureStatus(`Reviewing ${file.name}… The photo will only produce an editable draft.`);
    try {
      const dataBase64 = await fileAsBase64(file);
      const context = workspace.querySelector("#offer-text").value.trim();
      const payload = { photo: { mime_type: file.type, data_base64: dataBase64 } };
      if (context) payload.text = context;
      const result = await api("/api/intake/extract", { method: "POST", body: payload, token: null });
      adoptDraft(result, context ? { description: context } : {}, true);
    } catch (err) {
      setCaptureStatus(`${errorMessage(err)} The photo was not submitted as an offer.`, true);
    } finally {
      event.target.value = "";
    }
  }

  function adoptDraft(result, fallback, photoUsed = false) {
    const draft = { ...fallback, ...(result?.draft || {}) };
    const responseSource = result?.source || (result ? { provider: result.provider, photo_analyzed: result.provider === "gemini", photo_retained: result.retained } : null);
    state.draftMeta = {
      inferredFields: arrayOf(result?.inferred_fields),
      warnings: arrayOf(result?.warnings),
      source: responseSource ? { ...responseSource, photo_retained: photoUsed ? responseSource.photo_retained : null } : null,
    };
    renderDonorReview(draft);
  }

  function renderDonorReview(draft) {
    stopSpeechCapture();
    const inferred = new Set(state.draftMeta.inferredFields);
    const storage = draft.storage_state || "";
    const transport = draft.transport_mode || "";
    workspace.innerHTML = `
      <section class="hero compact review-hero"><p class="eyebrow">Review before outreach</p><h1>Check the rescue details.</h1><p>Every inferred field is editable. Nothing has been sent to a recipient yet.</p></section>
      <div class="review-layout">
        <section class="panel form-panel" aria-labelledby="review-title"><div class="section-heading"><div><p class="kicker">Editable offer</p><h2 id="review-title">What recipients will evaluate</h2></div><button class="button quiet" id="back-to-capture" type="button">Start over</button></div>
        ${draftWarnings()}
        <form id="offer-form">
          <div class="field"><label for="description">Food description ${inferredTag(inferred, "description")}</label><textarea id="description" name="description" required rows="3">${e(draft.description || "")}</textarea></div>
          <div class="form-grid thirds"><div class="field"><label for="quantity-original">Quantity ${inferredTag(inferred, "quantity_original")}</label><input id="quantity-original" name="quantity_original" required value="${e(draft.quantity_original || "")}" placeholder="10 crates" /></div><div class="field"><label for="quantity-pallets">Pallet estimate ${inferredTag(inferred, "quantity_pallets")}</label><input id="quantity-pallets" name="quantity_pallets" required type="number" min="0.1" step="0.1" value="${e(draft.quantity_pallets ?? "")}" placeholder="1" /></div><div class="field"><label for="deadline">Must move by ${inferredTag(inferred, "pickup_deadline")}</label><input id="deadline" name="pickup_deadline" required type="datetime-local" value="${e(localDateTimeValue(draft.pickup_deadline))}" /></div></div>
          <fieldset class="field"><legend>Required storage ${inferredTag(inferred, "storage_state")}</legend><div class="choice-row">${radio("storage_state", "refrigerated", "Refrigerated", storage === "refrigerated")}${radio("storage_state", "frozen", "Frozen", storage === "frozen")}${radio("storage_state", "ambient", "Shelf stable", storage === "ambient")}</div></fieldset>
          <div class="location-review"><div class="section-heading small"><div><p class="kicker">Reviewed pickup point</p><h3>Place the private donor pin</h3></div><button class="button secondary" id="use-location" type="button">Use my location</button></div><div class="field"><label for="pickup-address">Pickup address <span class="optional-label">Optional</span></label><div class="address-row"><input id="pickup-address" name="pickup_address" autocomplete="street-address" value="${e(draft.pickup_address || "")}" placeholder="Store or street address" /><button class="button secondary" id="find-address" type="button">Find address</button></div><small>Find an Atlanta-area address, use GPS, or place the map pin. Any one option is enough.</small></div>${interactivePinMap()}<p id="location-summary" class="map-caption">${state.offerLocation ? locationReviewLabel() : "Find an address, use GPS, or click the map to place a reviewed pickup pin."}</p><p class="notice neutral">Exact coordinates are hidden from recipients until a valid claim. Media analysis never infers location.</p></div>
          <fieldset class="field"><legend>Transport plan ${inferredTag(inferred, "transport_mode")}</legend><div class="transport-grid">${radio("transport_mode", "recipient_pickup", "Recipient pickup", transport === "recipient_pickup", "Recipient reconfirms cold-chain transport.")}${radio("transport_mode", "donor_delivery", "Donor delivery", transport === "donor_delivery", "Maximum 5 km in this release.")}${radio("transport_mode", "transportation_needed", "Transport needed", transport === "transportation_needed", "Blocks confirmation until resolved.")}</div></fieldset>
          <div class="field radius-field" ${transport === "donor_delivery" ? "" : "hidden"}><label for="delivery-radius">Delivery radius (km, maximum 5)</label><input id="delivery-radius" name="donor_delivery_radius_km" type="number" min="0.1" max="5" step="0.1" value="5" /></div>
          <div id="form-error" class="notice danger" role="alert" hidden></div><button class="button primary wide" type="submit">I reviewed this offer — notify recipients <span aria-hidden="true">→</span></button><p class="submit-note">Your confirmed deadline is authoritative. FoodKeeper context, if shown later, is advisory only.</p>
        </form></section>
        <aside class="review-aside">${landingMap(true)}<div class="panel decision-card"><p class="kicker">What happens next</p><ol><li>Retrieve 30 likely profiles by meaning.</li><li>Apply non-negotiable safety and logistics rules.</li><li>Notify up to three feasible recipients.</li></ol><strong>Vector search finds possibilities. Rules decide eligibility.</strong></div></aside>
      </div>`;
    const form = workspace.querySelector("#offer-form");
    workspace.querySelector("#back-to-capture").addEventListener("click", () => { state.offerLocation = null; renderDonorForm(); });
    workspace.querySelector("#use-location").addEventListener("click", () => useLocation(form));
    workspace.querySelector("#find-address").addEventListener("click", () => findAddress(form));
    workspace.querySelector("#pin-map").addEventListener("click", setMapPin);
    positionMapPin();
    form.addEventListener("change", (event) => { if (event.target.name === "transport_mode") form.querySelector(".radius-field").hidden = event.target.value !== "donor_delivery"; });
    form.addEventListener("submit", submitOffer);
  }

  async function findAddress(form) {
    const address = form.elements.pickup_address.value.trim();
    const button = form.querySelector("#find-address");
    if (!address) {
      form.elements.pickup_address.focus();
      return showToast("Enter a complete pickup address first.", true);
    }
    setBusy(button, true, "Finding…");
    try {
      const result = await api("/api/locations/geocode", { method: "POST", body: { address }, token: null });
      if (!Number.isFinite(Number(result.latitude)) || !Number.isFinite(Number(result.longitude))) throw new Error("That address did not return a usable pickup pin.");
      state.offerLocation = { latitude: Number(result.latitude), longitude: Number(result.longitude), source: "address" };
      if (result.formatted_address) form.elements.pickup_address.value = result.formatted_address;
      positionMapPin();
      updateLocationSummary();
      showToast("Address found. Review the pin before outreach.");
    } catch (err) {
      showToast(errorMessage(err), true);
    } finally {
      setBusy(button, false);
    }
  }

  function useLocation(form) {
    const button = form.querySelector("#use-location");
    if (!navigator.geolocation) return showToast("This browser does not provide location. Enter an address and reviewed pin instead.");
    button.disabled = true;
    button.textContent = "Locating…";
    navigator.geolocation.getCurrentPosition((position) => {
      state.offerLocation = { latitude: position.coords.latitude, longitude: position.coords.longitude, source: "gps" };
      positionMapPin();
      updateLocationSummary();
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
    const pickupAddress = String(data.get("pickup_address") || "").trim() || ({ gps: "GPS-selected pickup", corrected_pin: "Map-selected pickup", address: "Address-selected pickup" }[state.offerLocation?.source] || "Reviewed pickup location");
    const payload = {
      description: String(data.get("description")).trim(),
      quantity_original: String(data.get("quantity_original")).trim(),
      quantity_pallets: Number(data.get("quantity_pallets")),
      storage_state: String(data.get("storage_state")),
      pickup_deadline: new Date(String(data.get("pickup_deadline"))).toISOString(),
      pickup_address: pickupAddress,
      donor_latitude: state.offerLocation?.latitude,
      donor_longitude: state.offerLocation?.longitude,
      location_source: state.offerLocation?.source,
      transport_mode: transport,
    };
    if (transport === "donor_delivery") payload.donor_delivery_radius_km = Number(data.get("donor_delivery_radius_km"));
    if (!state.offerLocation) { error.textContent = "Place the reviewed pickup pin or use your location before notifying recipients."; error.hidden = false; return; }
    setBusy(button, true, "Creating rescue…");
    error.hidden = true;
    try {
      const result = await api("/api/offers", { method: "POST", body: payload, mutation: true, token: null });
      if (!result.status_token) throw new Error("The offer was created without a private status link. Please retry.");
      sessionStorage.setItem(tokenKey("donor"), result.status_token);
      state.token = result.status_token;
      state.demoRecipients = Array.isArray(result.recipient_access) ? result.recipient_access : [];
      sessionStorage.setItem("pantry-relay:demo-recipients", JSON.stringify(state.demoRecipients));
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
    if (!state.token) return renderMissingContext("donor");
    workspace.innerHTML = loadingView("Loading donor status…");
    loadDonorStatus();
  }

  async function loadDonorStatus() {
    try {
      state.data = await api("/api/offers/status");
      if (Array.isArray(state.data.demo_recipient_access)) {
        state.demoRecipients = state.data.demo_recipient_access;
        sessionStorage.setItem("pantry-relay:demo-recipients", JSON.stringify(state.demoRecipients));
      }
      drawDonorStatus();
      const status = offerOf(state.data).status;
      if (!TERMINAL.has(status)) startPolling(loadDonorStatus);
    } catch (err) {
      if (isAuthError(err)) return recoverMissingContext("donor");
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
        ${workflowMap(state.data.map, "Reviewed rescue map")}
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
    return `<div class="demo-access"><p class="kicker">Current-wave demo inboxes</p>${visible.map((item, index) => `<button class="button secondary wide demo-recipient" data-index="${access.indexOf(item)}" type="button">Open ${e(item.name || item.recipient_id || `recipient ${index + 1}`)} <span aria-hidden="true">↗</span></button>`).join("")}<small>Each button opens the selected simulated recipient inbox directly.</small></div>`;
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
    if (!state.token) return renderMissingContext("recipient");
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
      if (isAuthError(err)) return recoverMissingContext("recipient");
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
    const single = notices.length === 1;
    workspace.innerHTML = `
      ${pageLead("Simulated recipient inbox", `Welcome, ${e(state.data.recipient?.name || "rescue partner")}.`, "Review one urgent offer. Live capacity, staffing, and transport still need your confirmation.")}
      <div class="inbox-layout ${single ? "single-offer" : ""}">
        ${single ? "" : `<section class="panel inbox-list"><div class="section-heading"><div><p class="kicker">Offers needing a response</p><h2>${notices.length} offers</h2></div><button id="leave-recipient" class="button quiet" type="button">Leave inbox</button></div>
          ${notices.length ? notices.map(notificationCard).join("") : emptyState("No active notifications", "A new wave will appear here when an eligible offer is available.")}
        </section>`}
        <section class="panel offer-detail" id="offer-detail">${current ? recipientDetail(current) : emptyState("Choose an offer", "Select a notification to review its safety and logistics evidence.")}</section>
      </div>`;
    workspace.querySelector("#leave-recipient")?.addEventListener("click", () => clearToken("recipient"));
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
    const donorLocation = offer.donor_location || offer.map?.donor;
    return `<div class="section-heading"><div><p class="kicker">Offer ${e(shortId(offerId))}</p><h2>Can you rescue ${e(offer.quantity_original || pallets(offer.quantity_pallets))}?</h2></div>${statusPill(status)}</div>
      <p class="offer-name">${e(offer.description || item.title || "Food rescue offer")}</p>
      <p>${e(item.message || "Your operation passed deterministic storage, quantity, route, and deadline checks.")}</p>
      <div class="fact-grid compact-facts">
        ${fact("Quantity", offer.quantity_original || pallets(offer.quantity_pallets))}
        ${fact("Storage", title(offer.storage_state))}
        ${fact("Distance", offer.distance_miles == null ? "Route estimate pending" : `${formatNumber(offer.distance_miles)} mi estimated`)}
        ${fact("Deadline", dateTime(offer.deadline))}
        ${fact("Transport", transportLabel(offer.transport_mode))}
        ${fact("Response", responseLabel(response))}
      </div>
      <div class="map-card" aria-label="Pickup location summary"><span class="map-pin" aria-hidden="true"></span><div><strong>${e(locationLabel(donorLocation) || "Exact pickup point is hidden")}</strong><small>${donorLocation ? "Available because this recipient has a valid claim." : "Exact coordinates unlock only after a valid claim. Route values may use approximate ZIP-centroid data."}</small></div></div>
      ${workflowMap(offer.map, "Recipient route context")}
      <div class="notice warning"><strong>Live-capacity check:</strong> Confirm current space, staffing, and cold-chain transport before the handoff.</div>
      ${canRespond ? `<div class="action-block"><h3>Can your team safely receive the full offer?</h3><div class="button-row"><button class="button primary" data-action="claim" type="button">Hold for 10 minutes</button><button class="button secondary" data-action="decline" type="button">Decline</button></div></div>` : ""}
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

  async function renderCoordinator() {
    state.token = "";
    sessionStorage.removeItem(tokenKey("ops"));
    workspace.innerHTML = loadingView("Opening coordinator demo…");
    try {
      await api("/api/demo/session", { method: "POST", token: null });
      if (state.role !== "ops") return;
      state.coordinatorSession = "ready";
      workspace.innerHTML = loadingView("Loading operations queue…");
      await loadCoordinator();
    } catch (err) {
      if (state.role !== "ops") return;
      state.coordinatorSession = "idle";
      renderCoordinatorRecovery(err);
    }
  }

  async function loadCoordinator() {
    try {
      state.data = await api("/api/ops/offers");
      const offers = coordinatorOffers(state.data);
      if (!state.selectedOfferId && offers[0]) state.selectedOfferId = offers[0].offer_id || offers[0].id;
      drawCoordinator();
      if (!state.equityAudit) loadEquityAudit();
      if (offers.some((offer) => !TERMINAL.has(offer.status))) startPolling(loadCoordinator);
    } catch (err) {
      if (isAuthError(err)) {
        state.coordinatorSession = "idle";
        renderCoordinatorRecovery(err);
      } else {
        renderLoadError("Could not load coordinator operations", err, renderCoordinator);
      }
    }
  }

  async function loadEquityAudit() {
    state.equityAudit = { loading: true };
    if (state.role === "ops" && state.data) drawCoordinator();
    try {
      state.equityAudit = await api("/api/ops/equity-audit");
    } catch (err) {
      state.equityAudit = { error: errorMessage(err) };
    }
    if (state.role === "ops" && state.data) drawCoordinator();
  }

  function drawCoordinator() {
    const offers = coordinatorOffers(state.data);
    const impact = state.data.impact || {};
    const current = offers.find((offer) => (offer.offer_id || offer.id) === state.selectedOfferId) || offers[0];
    workspace.innerHTML = `
      ${pageLead("Coordinator operations", "Keep every rescue safe, explainable, and moving.", "Shared demo operations — this is not production identity or recipient onboarding.")}
      <section class="metric-strip" aria-label="Completed impact"><div><strong>${e(impact.completed_offers ?? 0)}</strong><span>completed rescues</span></div><div><strong>${e(formatNumber(impact.completed_quantity_pallets ?? 0))}</strong><span>pallets moved</span></div><div><strong>${e(offers.filter((o) => !TERMINAL.has(o.status)).length)}</strong><span>active offers</span></div></section>
      ${equityProof(state.equityAudit)}
      <div class="ops-layout">
        <section class="panel ops-queue"><div class="section-heading"><div><p class="kicker">Shared queue</p><h2>${offers.length} offer${offers.length === 1 ? "" : "s"}</h2></div><button id="leave-ops" class="button quiet" type="button">Back to donor demo</button></div>${offers.length ? offers.map(opsCard).join("") : emptyState("Queue is clear", "New donor offers will appear here.")}</section>
        <section class="panel ops-detail">${current ? coordinatorDetail(current) : emptyState("Choose an offer", "Select a queue item to inspect its timeline and actions.")}</section>
      </div>`;
    workspace.querySelector("#leave-ops").addEventListener("click", () => setRole("donor"));
    workspace.querySelector("#refresh-equity")?.addEventListener("click", loadEquityAudit);
    workspace.querySelectorAll(".ops-card").forEach((button) => button.addEventListener("click", () => { state.selectedOfferId = button.dataset.offerId; drawCoordinator(); }));
    workspace.querySelectorAll("[data-ops-action]").forEach((button) => button.addEventListener("click", () => runOpsAction(button, current)));
  }

  function equityProof(audit) {
    if (audit?.loading) {
      return `<section class="panel equity-proof" aria-labelledby="equity-title"><div class="section-heading"><div><p class="kicker">Real matcher evidence</p><h2 id="equity-title">Equity &amp; ten-match proof</h2></div><span class="proof-status unavailable">Loading</span></div><p class="muted">Loading protected BigQuery proof. Coordinator operations remain available while this runs.</p></section>`;
    }
    if (!audit || audit.error) {
      return `<section class="panel equity-proof" aria-labelledby="equity-title"><div class="section-heading"><div><p class="kicker">Real matcher evidence</p><h2 id="equity-title">Equity &amp; ten-match proof</h2></div><span class="proof-status unavailable">Unavailable</span></div><p class="muted">${e(audit?.error || "Loading protected BigQuery evidence…")}</p><button class="button secondary" id="refresh-equity" type="button">Retry evidence</button></section>`;
    }
    const proof = audit.ten_match_proof || {};
    const execution = audit.execution || {};
    const postings = arrayOf(audit.postings);
    const passed = proof.ok === true && Number(audit.posting_count) === Number(audit.expected_postings || 10);
    const sourceLabel = execution.source === "cache" ? "Cached real BigQuery proof" : "Live BigQuery proof";
    const generated = dateTime(execution.generated_at);
    const served = dateTime(execution.served_at);
    const firstEvidence = postings[0]?.retrieval_evidence || {};
    return `<section class="panel equity-proof" aria-labelledby="equity-title">
      <div class="section-heading"><div><p class="kicker">Real matcher evidence</p><h2 id="equity-title">Equity &amp; ten-match proof</h2><p class="muted">Ten independent sample postings—not ten rescues or measured community outcomes.</p></div><span class="proof-status ${passed ? "passed" : "incomplete"}">${passed ? "10 / 10 passed" : "Incomplete proof"}</span></div>
      <div class="proof-metrics" aria-label="Ten-match proof summary">
        ${proofMetric(`${formatNumber(proof.match_execution_count ?? audit.posting_count)}/${formatNumber(proof.expected_matches ?? audit.expected_postings)}`, "matches recorded")}
        ${proofMetric(`${formatNumber(proof.unique_vector_job_count ?? 0)}/${formatNumber(proof.vector_job_count ?? 0)}`, "distinct vector jobs")}
        ${proofMetric(proof.all_jobs_brute_force_vector_search ? "Top 30" : "Unverified", "brute-force VECTOR_SEARCH")}
        ${proofMetric(`${formatNumber(audit.tract_evidence_count ?? 0)}/${formatNumber(audit.matched_postings ?? 0)}`, "selected tracts evidenced")}
      </div>
      <div class="proof-provenance"><strong>${e(sourceLabel)}</strong><span>Generated ${e(generated)} · served ${e(served)}</span><span>${e(firstEvidence.query_label || "Query label unavailable")} · source job ${e(shortId(audit.source_job_id))}</span></div>
      ${equityRows(postings)}
      <div class="proof-footer"><div><p class="kicker">Generated assumptions</p><p>${e(audit.generated_assumptions?.donor_location?.label || "Sample postings use a documented Atlanta demo anchor.")} Quantity: ${e(audit.generated_assumptions?.quantity_label || "standardized for comparison")}.</p></div><div><p class="kicker">Limitations</p><ul>${arrayOf(audit.limitations).map((item) => `<li>${e(item)}</li>`).join("")}</ul></div></div>
      <div class="proof-actions"><span>${proof.all_jobs_labeled ? "All jobs labeled" : "Job labeling incomplete"} · ${proof.all_results_recorded ? "all outcomes recorded" : "outcomes incomplete"}</span><button class="button quiet" id="refresh-equity" type="button">Refresh evidence</button></div>
    </section>`;
  }

  function proofMetric(value, label) {
    return `<div><strong>${e(value)}</strong><span>${e(label)}</span></div>`;
  }

  function equityRows(postings) {
    if (!postings.length) return `<p class="notice warning">No posting-level proof is available.</p>`;
    return `<div class="equity-table-wrap"><table class="equity-table"><thead><tr><th scope="col">Posting</th><th scope="col">Selected / rejected</th><th scope="col">Approximate tract evidence</th><th scope="col">Vector job</th></tr></thead><tbody>${postings.map((posting, index) => {
      const evidence = posting.retrieval_evidence || {};
      const total = Number(evidence.result_count ?? evidence.top_k);
      const eligible = Number(posting.eligible_count ?? 0);
      const rejected = Number.isFinite(total) ? Math.max(0, total - eligible) : null;
      const tract = posting.tract_geo_id ? `Tract ${posting.tract_geo_id}` : "Explicit fallback/no tract";
      const rates = [posting.poverty_rate == null ? "" : `${percent(posting.poverty_rate)} poverty`, posting.no_vehicle_rate == null ? "" : `${percent(posting.no_vehicle_rate)} no vehicle`].filter(Boolean).join(" · ");
      return `<tr><th scope="row">${e(posting.posting_id || index + 1)}</th><td><strong>${e(posting.selected_recipient_id || "No match")}</strong><small>${e(eligible)} eligible${rejected == null ? "" : ` · ${e(rejected)} deterministically rejected`}</small></td><td><strong>${e(tract)}</strong><small>${e(rates || posting.need_evidence_source || "Need evidence unavailable")}</small></td><td><strong>${e(shortId(evidence.job_id))}</strong><small>${e(evidence.use_brute_force && evidence.top_k === 30 ? "brute-force · top 30" : "proof incomplete")}</small></td></tr>`;
    }).join("")}</tbody></table></div>`;
  }

  function opsCard(offer) {
    const id = offer.offer_id || offer.id;
    return `<button class="ops-card ${id === state.selectedOfferId ? "active" : ""}" data-offer-id="${e(id)}" type="button"><span>${e(offer.description_original || offer.description || "Food rescue offer")}</span><small>${e(STATUS_LABELS[offer.status] || title(offer.status))} · ${e(dateTime(offer.deadline || offer.pickup_deadline))}</small></button>`;
  }

  function coordinatorDetail(offer) {
    const id = offer.offer_id || offer.id;
    const events = arrayOf(offer.events);
    const candidates = [...arrayOf(offer.candidates), ...arrayOf(offer.rejections).map((item) => ({ ...item, eligible: false, response: "rejected" }))];
    const closed = TERMINAL.has(offer.status);
    return `<div class="section-heading"><div><p class="kicker">Offer ${e(shortId(id))}</p><h2>${e(offer.description_original || offer.description || "Food rescue offer")}</h2></div>${statusPill(offer.status)}</div>
      <div class="fact-grid compact-facts">${fact("Quantity", offer.quantity_original || pallets(offer.quantity_pallets))}${fact("Deadline", dateTime(offer.deadline || offer.pickup_deadline))}${fact("Transport", transportLabel(offer.transport_mode))}${fact("Wave", offer.current_wave ?? "—")}${fact("Reserved for", offer.selected_recipient_name || offer.selected_recipient_id || "No one yet")}${fact("Location", offer.pickup_address || "Private donor pin")}</div>
      <div class="map-card"><span class="map-pin" aria-hidden="true"></span><div><strong>${e(offer.pickup_address || "Donor pickup point")}</strong><small>Coordinator access may show an exact corrected pin. Candidate locations and need context may use approximate ZIP centroids.</small></div></div>
      ${workflowMap(offer.map, "Coordinator logistics map")}
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

  function renderMissingContext(role) {
    const recipient = role === "recipient";
    const donorAvailable = Boolean(sessionStorage.getItem(tokenKey("donor")));
    const eyebrow = recipient ? "Recipient demo" : "Donor status";
    const heading = recipient ? "Open an inbox from the donor view." : "This private status link is not available in this tab.";
    const copy = recipient
      ? "Recipient inboxes open from the current notification wave so the right simulated partner is selected automatically."
      : "Start a new rescue offer to create a fresh private status view.";
    workspace.innerHTML = `${pageLead(eyebrow, heading, copy)}<section class="panel context-panel"><h2>${recipient && donorAvailable ? "Your active donor offer is ready." : "Start with the spinach rescue."}</h2><p>${recipient && donorAvailable ? "Return to the donor status and choose one of the current-wave recipient inboxes." : "The guided donor demo takes you from an editable offer to matched recipient inboxes."}</p><div class="button-row"><button id="open-donor-demo" class="button primary" type="button">${recipient && donorAvailable ? "Return to donor status" : "Open donor demo"}</button></div></section>`;
    workspace.querySelector("#open-donor-demo").addEventListener("click", () => setRole("donor"));
  }

  function recoverMissingContext(role) {
    sessionStorage.removeItem(tokenKey(role));
    state.token = "";
    renderMissingContext(role);
  }

  function renderCoordinatorRecovery(err) {
    const copy = isAuthError(err)
      ? "The demo session ended. Reopen it to continue with the shared operations queue."
      : "The coordinator demo could not start. Check the connection and try again.";
    workspace.innerHTML = `${pageLead("Coordinator demo", "The operations view is temporarily unavailable.", copy)}<section class="panel context-panel"><h2>No sign-in is needed for this demo.</h2><p>Reopening creates a short-lived browser session and then loads the shared queue.</p><div class="button-row"><button id="retry-coordinator" class="button primary" type="button">Reopen coordinator demo</button><button id="coordinator-to-donor" class="button secondary" type="button">Back to donor demo</button></div></section>`;
    workspace.querySelector("#retry-coordinator").addEventListener("click", renderCoordinator);
    workspace.querySelector("#coordinator-to-donor").addEventListener("click", () => setRole("donor"));
  }

  function clearToken(role, nextRole = role) {
    sessionStorage.removeItem(tokenKey(role));
    if (role === "donor") {
      sessionStorage.removeItem("pantry-relay:demo-recipients");
      state.demoRecipients = [];
      state.offerLocation = null;
    }
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
    const message = isAuthError(err) ? "This private demo link is no longer active." : errorMessage(err);
    workspace.innerHTML = `<section class="panel error-panel"><p class="kicker">Demo connection issue</p><h1>${e(titleText)}</h1><p>${e(message)}</p><div class="button-row"><button id="retry-load" class="button primary" type="button">Try again</button><button id="restart-demo" class="button secondary" type="button">Restart demo</button></div></section>`;
    workspace.querySelector("#retry-load").addEventListener("click", render);
    workspace.querySelector("#restart-demo").addEventListener("click", reset);
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
    const commandId = options.mutation ? commandIdentity(options.method || "POST", path, options.body) : "";
    if (options.mutation) {
      if (options.intentionalNewAction) state.commandKeys.delete(commandId);
      if (!state.commandKeys.has(commandId)) state.commandKeys.set(commandId, crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
      headers["X-Idempotency-Key"] = state.commandKeys.get(commandId);
    }
    const response = await fetch(path, { method: options.method || "GET", headers, credentials: "same-origin", body: options.body === undefined ? undefined : JSON.stringify(options.body) });
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
    if (commandId) state.commandKeys.delete(commandId);
    return result;
  }

  function commandIdentity(method, path, body) {
    return `${method}:${path}:${stableJson(body)}`;
  }

  function isAuthError(err) {
    return err?.status === 401 || err?.status === 403;
  }

  function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    return JSON.stringify(value ?? null);
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
      ? { ...entry.offer, events: arrayOf(entry.events), candidates: arrayOf(entry.candidates), reservation: entry.reservation, map: entry.map }
      : entry);
  }
  function arrayOf(value) { return Array.isArray(value) ? value : []; }
  function shortId(value) { const text = String(value || ""); return text ? text.slice(0, 8) : "pending"; }
  function title(value) { return String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
  function pallets(value) { return value == null ? "—" : `${formatNumber(value)} pallet${Number(value) === 1 ? "" : "s"}`; }
  function formatNumber(value) { const number = Number(value); return Number.isFinite(number) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(number) : String(value || "0"); }
  function percent(value) { const number = Number(value); return Number.isFinite(number) ? new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(number) : "—"; }
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
  function readSessionJson(key, fallback) {
    try { return JSON.parse(sessionStorage.getItem(key)) || fallback; }
    catch (_err) { return fallback; }
  }
  function e(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
})();
