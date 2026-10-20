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
  const DRAFT_FIELDS = ["description", "quantity_original", "quantity_pallets", "storage_state", "pickup_deadline", "transport_mode"];
  const REQUIRED_FIELDS = ["description", "quantity_pallets", "storage_state", "pickup_deadline", "transport_mode"];
  const FIELD_LABELS = { description: "Food", quantity_original: "Amount", quantity_pallets: "Size", storage_state: "Storage", pickup_deadline: "Gone by", transport_mode: "Transport" };
  const MISSING_LABELS = { description: "what the food is", quantity_pallets: "size", storage_state: "storage", pickup_deadline: "when it must go", transport_mode: "transport" };
  const STORAGE_LABELS = { refrigerated: "Refrigerated", frozen: "Frozen", ambient: "Shelf stable" };
  const TRANSPORT_CHOICES = { recipient_pickup: "They pick up", donor_delivery: "We deliver (≤ 5 km)", transportation_needed: "Need a driver" };
  const SPINACH_EXAMPLE = "10 crates of bagged spinach, refrigerated, must move within 6 hours. Recipient picks up.";
  const DEMO_PICKUP = { latitude: 33.749, longitude: -84.388, source: "corrected_pin", address: "Downtown Atlanta demo grocery" };
  const SAVED_PICKUP_KEY = "pantry-relay:saved-pickup";
  const ATLANTA_CENTER = { lat: 33.749, lng: -84.388 };
  const state = {
    role: normalizeRole(new URLSearchParams(location.search).get("role")),
    token: "",
    timer: null,
    countdownTimer: null,
    data: null,
    selectedOfferId: "",
    reservation: null,
    demoRecipients: readSessionJson("pantry-relay:demo-recipients", []),
    intake: null,
    parseTimer: null,
    offerLocation: null,
    recognition: null,
    mapsPromise: null,
    mapsConfig: null,
    mapsFailed: false,
    mapCache: new Map(),
    pickupMap: null,
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
    state.intake = freshIntake();
    if (!state.offerLocation) state.offerLocation = readSavedPickup();
    workspace.innerHTML = `
      <section class="composer" aria-labelledby="composer-title">
        <h1 id="composer-title">What food needs a new home?</h1>
        <p class="composer-lead">Describe it the way you'd tell a colleague. We fill in the details; you check them before anything is sent.</p>
        <div class="composer-box">
          <label class="visually-hidden" for="offer-text">Describe the food</label>
          <textarea id="offer-text" rows="3" placeholder="About 40 cases of yogurt, has to go before we close at 9. They'd need to pick up."></textarea>
          <div class="composer-tools">
            <button class="tool-button" id="speak-offer" type="button"><span aria-hidden="true">◉</span> Speak</button>
            <label class="tool-button" for="photo-offer"><input id="photo-offer" class="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" /><span aria-hidden="true">▧</span> Photo</label>
            <span id="parse-state" class="parse-state" role="status" aria-live="polite"></span>
            <button class="button-link" id="run-demo" type="button">Try the spinach example</button>
          </div>
        </div>
        <div class="composer-result" id="composer-result" hidden>
          <section class="draft-panel" aria-label="Offer details"><div id="draft-panel"></div></section>
          <section class="pickup-panel" aria-labelledby="pickup-title">
            <h2 id="pickup-title">Pickup</h2>
            <div class="address-row"><div id="pickup-address-slot" class="address-slot"><input id="pickup-address" aria-label="Pickup address" autocomplete="street-address" placeholder="Store address" /></div><button class="button secondary" id="use-location" type="button">Use my location</button></div>
            <div id="pickup-map" class="pickup-map"></div>
            <p id="pickup-note" class="pickup-note">Only the recipient who claims the food sees the exact spot.</p>
          </section>
          <div class="composer-submit">
            <p id="submit-hint" class="submit-hint"></p>
            <button class="button primary" id="submit-offer" type="button">Find a home <span aria-hidden="true">→</span></button>
            <p id="form-error" class="notice danger" role="alert" hidden></p>
          </div>
        </div>
      </section>`;
    const input = workspace.querySelector("#offer-text");
    input.addEventListener("input", () => scheduleParse());
    input.addEventListener("blur", () => parseOffer());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); parseOffer(); }
    });
    workspace.querySelector("#run-demo").addEventListener("click", loadDemo);
    workspace.querySelector("#speak-offer").addEventListener("click", startSpeechCapture);
    workspace.querySelector("#photo-offer").addEventListener("change", analyzeOfferPhoto);
    workspace.querySelector("#use-location").addEventListener("click", useLocation);
    workspace.querySelector("#pickup-address").addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); findAddress(); }
    });
    workspace.querySelector("#submit-offer").addEventListener("click", submitOffer);
    const panel = workspace.querySelector("#draft-panel");
    panel.addEventListener("click", onDraftClick);
    panel.addEventListener("submit", onDraftSubmit);
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.intake.editing) { state.intake.editing = ""; renderDraft(); }
    });
    input.focus();
  }

  function freshIntake() {
    return { text: "", draft: {}, confidence: {}, questions: [], edited: new Set(), answered: new Set(), editing: "", seq: 0, photoUsed: false };
  }

  function hasValue(value) { return value !== null && value !== undefined && value !== ""; }

  function fieldText(field) {
    const value = state.intake.draft[field];
    if (field === "quantity_pallets") return `${formatNumber(value)} pallet${Number(value) === 1 ? "" : "s"}`;
    if (field === "storage_state") return STORAGE_LABELS[value] || title(value);
    if (field === "transport_mode") return TRANSPORT_CHOICES[value] || title(value);
    if (field === "pickup_deadline") return `By ${dateTime(value)}`;
    return String(value);
  }

  function scheduleParse(delay = 800) {
    window.clearTimeout(state.parseTimer);
    state.parseTimer = window.setTimeout(() => parseOffer(), delay);
  }

  async function parseOffer(extra = {}) {
    window.clearTimeout(state.parseTimer);
    const input = workspace.querySelector("#offer-text");
    if (!input) return;
    const text = input.value.trim();
    if (!extra.photo && (text.length < 8 || text === state.intake.text)) return;
    const intake = state.intake;
    const seq = ++intake.seq;
    intake.text = text;
    setParseState(extra.photo ? "Reading the photo…" : "Reading…", "busy");
    try {
      const body = { text };
      if (extra.photo) body.photo = extra.photo;
      const result = await api("/api/intake/extract", { method: "POST", body, token: null });
      if (seq !== intake.seq || state.intake !== intake) return;
      if (extra.photo) intake.photoUsed = true;
      mergeDraft(result);
      setParseState(result.provider === "gemini" ? "Filled in by Gemini. Tap anything to change it." : "Filled in. Tap anything to change it.", "done");
    } catch (err) {
      if (seq === intake.seq) setParseState(`${errorMessage(err)} Your text is still here.`, "error");
    }
  }

  function mergeDraft(result) {
    const intake = state.intake;
    const draft = result.draft || {};
    DRAFT_FIELDS.forEach((field) => {
      // Never overwrite what the donor typed or tapped; re-reads only fill the rest.
      if (intake.edited.has(field) || intake.answered.has(field) || !hasValue(draft[field])) return;
      intake.draft[field] = draft[field];
      intake.confidence[field] = result.confidence?.[field] || "high";
    });
    intake.questions = arrayOf(result.questions);
    workspace.querySelector("#composer-result").hidden = false;
    renderDraft();
    renderPickup();
  }

  function renderDraft() {
    const panel = workspace.querySelector("#draft-panel");
    if (!panel) return;
    const intake = state.intake;
    const chips = DRAFT_FIELDS.filter((field) => hasValue(intake.draft[field]) || intake.editing === field).map(chip).join("");
    const open = intake.questions.filter((question) => !intake.answered.has(question.field) && !intake.edited.has(question.field) && intake.editing !== question.field);
    panel.innerHTML = `<div class="chip-row">${chips}</div>${open.map(questionBlock).join("")}${intake.photoUsed ? `<p class="pickup-note">The photo was only used to fill this in. It was not kept.</p>` : ""}`;
    panel.querySelector(".chip.editing [name=value]")?.focus();
    updateSubmitState();
  }

  function chip(field) {
    const intake = state.intake;
    const wide = field === "description" ? " wide" : "";
    if (intake.editing === field) return chipEditor(field, wide);
    const unsure = intake.confidence[field] === "low" && !intake.answered.has(field) && !intake.edited.has(field);
    return `<button type="button" class="chip${wide}${unsure ? " unsure" : ""}" data-edit="${field}" aria-label="${e(FIELD_LABELS[field])}: ${e(fieldText(field))}${unsure ? " (estimated)" : ""}. Change"><small>${e(FIELD_LABELS[field])}${unsure ? " · estimate" : ""}</small><span>${e(fieldText(field))}</span></button>`;
  }

  function chipEditor(field, wide) {
    const value = state.intake.draft[field];
    const id = `edit-${field}`;
    const options = (choices) => Object.entries(choices).map(([key, label]) => `<option value="${key}" ${key === value ? "selected" : ""}>${e(label)}</option>`).join("");
    const control = {
      description: `<textarea id="${id}" name="value" rows="2" required>${e(value || "")}</textarea>`,
      quantity_pallets: `<input id="${id}" name="value" type="number" min="0.1" step="0.1" required value="${e(value ?? "")}" />`,
      pickup_deadline: `<input id="${id}" name="value" type="datetime-local" required value="${e(localDateTimeValue(value))}" />`,
      storage_state: `<select id="${id}" name="value" required><option value="">Choose…</option>${options(STORAGE_LABELS)}</select>`,
      transport_mode: `<select id="${id}" name="value" required><option value="">Choose…</option>${options(TRANSPORT_CHOICES)}</select>`,
    }[field] || `<input id="${id}" name="value" required value="${e(value || "")}" />`;
    return `<form class="chip editing${wide}" data-field="${field}"><label for="${id}">${e(FIELD_LABELS[field])}</label>${control}<button class="chip-done" type="submit">Done</button></form>`;
  }

  function questionBlock(question) {
    const current = state.intake.draft[question.field];
    if (question.kind === "text") {
      return `<form class="question" data-question="${e(question.field)}"><label for="q-${e(question.field)}">${e(question.prompt)}</label><div class="question-input"><input id="q-${e(question.field)}" name="value" required /><button class="button secondary" type="submit">OK</button></div></form>`;
    }
    const buttons = arrayOf(question.options).map((option) => `<button type="button" class="option ${option.value === current ? "selected" : ""}" data-answer="${e(question.field)}" data-value="${e(JSON.stringify(option.value))}">${e(option.label)}</button>`).join("");
    return `<fieldset class="question"><legend>${e(question.prompt)}</legend><div class="option-row">${buttons}<button type="button" class="option other" data-edit="${e(question.field)}">Other…</button></div></fieldset>`;
  }

  function onDraftClick(event) {
    const intake = state.intake;
    const answer = event.target.closest("[data-answer]");
    if (answer) {
      intake.draft[answer.dataset.answer] = JSON.parse(answer.dataset.value);
      intake.answered.add(answer.dataset.answer);
      return renderDraft();
    }
    const edit = event.target.closest("[data-edit]");
    if (edit) {
      intake.editing = edit.dataset.edit;
      renderDraft();
    }
  }

  function onDraftSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const field = form.dataset.field || form.dataset.question;
    const raw = String(new FormData(form).get("value") || "").trim();
    if (!field || !raw) return;
    const value = field === "quantity_pallets" ? Number(raw) : field === "pickup_deadline" ? new Date(raw).toISOString() : raw;
    state.intake.draft[field] = value;
    state.intake.edited.add(field);
    state.intake.editing = "";
    renderDraft();
  }

  function missingForSubmit() {
    const draft = state.intake.draft;
    const missing = REQUIRED_FIELDS.filter((field) => !hasValue(draft[field])).map((field) => MISSING_LABELS[field]);
    if (!state.offerLocation) missing.push("pickup location");
    return missing;
  }

  function updateSubmitState() {
    const button = workspace.querySelector("#submit-offer");
    const hint = workspace.querySelector("#submit-hint");
    if (!button || !hint) return;
    const missing = missingForSubmit();
    button.disabled = missing.length > 0;
    hint.textContent = missing.length ? `Still needed: ${missing.join(", ")}.` : "Nothing is sent until you press this.";
  }

  function setParseState(message, tone = "") {
    const status = workspace.querySelector("#parse-state");
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function loadDemo() {
    const input = workspace.querySelector("#offer-text");
    input.value = SPINACH_EXAMPLE;
    state.offerLocation = { ...DEMO_PICKUP };
    parseOffer();
  }

  function startSpeechCapture() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return setParseState("Speech isn't supported in this browser. Type instead.", "error");
    if (state.recognition) return state.recognition.stop();
    const button = workspace.querySelector("#speak-offer");
    const recognition = new SpeechRecognition();
    state.recognition = recognition;
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onstart = () => {
      if (state.recognition !== recognition || !button.isConnected) return;
      button.classList.add("listening");
      setParseState("Listening… audio stays in your browser.", "busy");
    };
    recognition.onresult = (event) => {
      if (state.recognition !== recognition) return;
      const transcript = Array.from(event.results).map((result) => result[0].transcript).join(" ").trim();
      const input = workspace.querySelector("#offer-text");
      if (!input || !transcript) return;
      input.value = [input.value.trim(), transcript].filter(Boolean).join(" ");
      parseOffer();
    };
    recognition.onerror = () => {
      if (state.recognition === recognition) setParseState("Didn't catch that. Try again or type it.", "error");
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
    if (file.size > 5 * 1024 * 1024) return setParseState("Choose a photo smaller than 5 MB.", "error");
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return setParseState("Choose a JPEG, PNG, or WebP image.", "error");
    try {
      const dataBase64 = await fileAsBase64(file);
      await parseOffer({ photo: { mime_type: file.type, data_base64: dataBase64 } });
    } catch (err) {
      setParseState(`${errorMessage(err)} Nothing was sent.`, "error");
    } finally {
      event.target.value = "";
    }
  }

  function fileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
      reader.onerror = () => reject(new Error("The photo could not be read."));
      reader.readAsDataURL(file);
    });
  }

  function localDateTimeValue(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 16);
  }

  function readSavedPickup() {
    try {
      const saved = JSON.parse(localStorage.getItem(SAVED_PICKUP_KEY));
      return Number.isFinite(saved?.latitude) && Number.isFinite(saved?.longitude) ? { ...saved, saved: true } : null;
    } catch (_err) { return null; }
  }

  function setPickup(location) {
    state.offerLocation = location;
    const input = workspace.querySelector("#pickup-address");
    if (input && location.address) input.value = location.address;
    renderPickup();
    updateSubmitState();
  }

  async function renderPickup() {
    const container = workspace.querySelector("#pickup-map");
    if (!container) return;
    const input = workspace.querySelector("#pickup-address");
    if (input && state.offerLocation?.address && !input.value) input.value = state.offerLocation.address;
    const note = workspace.querySelector("#pickup-note");
    if (note) note.textContent = state.offerLocation?.saved ? "Using your saved pickup spot. Only the recipient who claims the food sees it." : "Only the recipient who claims the food sees the exact spot.";
    const maps = await loadGoogleMaps();
    if (!container.isConnected) return;
    if (!maps) return renderFallbackPickup(container);
    if (!state.pickupMap || state.pickupMap.container !== container) {
      const [{ Map }, { AdvancedMarkerElement }] = await Promise.all([maps.importLibrary("maps"), maps.importLibrary("marker")]);
      const map = new Map(container, { center: ATLANTA_CENTER, zoom: 11, mapId: state.mapsConfig.map_id, disableDefaultUI: true, zoomControl: true, gestureHandling: "cooperative" });
      const marker = new AdvancedMarkerElement({ map: null, gmpDraggable: true, title: "Pickup spot. Drag to adjust." });
      marker.addListener("dragend", () => {
        const position = marker.position;
        setPickup({ latitude: lat(position), longitude: lng(position), source: "corrected_pin", address: state.offerLocation?.address || "" });
      });
      map.addListener("click", (event) => setPickup({ latitude: event.latLng.lat(), longitude: event.latLng.lng(), source: "corrected_pin", address: state.offerLocation?.address || "" }));
      state.pickupMap = { container, map, marker };
      mountPlaceAutocomplete(maps);
    }
    const { map, marker } = state.pickupMap;
    if (state.offerLocation) {
      const position = { lat: state.offerLocation.latitude, lng: state.offerLocation.longitude };
      marker.position = position;
      marker.map = map;
      map.panTo(position);
      if (map.getZoom() < 14) map.setZoom(15);
    } else {
      marker.map = null;
    }
  }

  async function mountPlaceAutocomplete(maps) {
    try {
      const { PlaceAutocompleteElement } = await maps.importLibrary("places");
      const slot = workspace.querySelector("#pickup-address-slot");
      if (!slot || !PlaceAutocompleteElement) return;
      const autocomplete = new PlaceAutocompleteElement({ includedRegionCodes: ["us"], locationBias: { center: ATLANTA_CENTER, radius: 40000 } });
      autocomplete.id = "pickup-autocomplete";
      autocomplete.setAttribute("aria-label", "Pickup address");
      autocomplete.addEventListener("gmp-select", async ({ placePrediction }) => {
        const place = placePrediction.toPlace();
        await place.fetchFields({ fields: ["formattedAddress", "location"] });
        setPickup({ latitude: place.location.lat(), longitude: place.location.lng(), source: "address", address: place.formattedAddress || "" });
      });
      slot.replaceChildren(autocomplete);
    } catch (_err) {
      // Places is optional: the plain address field still geocodes on Enter.
    }
  }

  function renderFallbackPickup(container) {
    if (!container.querySelector("#pin-map")) {
      container.innerHTML = `<button class="pin-map" id="pin-map" type="button" aria-label="Place the pickup pin on an illustrative Atlanta map"><span class="road road-a"></span><span class="road road-b"></span><span class="road road-c"></span><span class="city-label midtown">Midtown</span><span class="city-label downtown">Downtown</span><span class="city-label westside">Westside</span><span id="reviewed-pin" class="reviewed-pin" aria-hidden="true"></span><span class="pin-instruction">Tap to place the pin</span></button>`;
      container.querySelector("#pin-map").addEventListener("click", (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const keyboard = event.detail === 0;
        const x = keyboard ? .5 : Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        const y = keyboard ? .5 : Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
        setPickup({ latitude: 33.83 - y * 0.13, longitude: -84.48 + x * 0.18, source: "corrected_pin", address: state.offerLocation?.address || "" });
      });
    }
    const pin = container.querySelector("#reviewed-pin");
    pin.hidden = !state.offerLocation;
    if (state.offerLocation) {
      pin.style.left = `${Math.max(2, Math.min(98, ((state.offerLocation.longitude + 84.48) / 0.18) * 100))}%`;
      pin.style.top = `${Math.max(4, Math.min(96, ((33.83 - state.offerLocation.latitude) / 0.13) * 100))}%`;
    }
  }

  async function findAddress() {
    const input = workspace.querySelector("#pickup-address");
    const address = input?.value.trim();
    if (!address) return;
    setParseState("Finding the address…", "busy");
    try {
      const result = await api("/api/locations/geocode", { method: "POST", body: { address }, token: null });
      if (!Number.isFinite(Number(result.latitude)) || !Number.isFinite(Number(result.longitude))) throw new Error("That address didn't return a usable location.");
      setPickup({ latitude: Number(result.latitude), longitude: Number(result.longitude), source: "address", address: result.formatted_address || address });
      setParseState("Address found. Drag the pin if it's off.", "done");
    } catch (err) {
      setParseState(errorMessage(err), "error");
    }
  }

  function useLocation() {
    const button = workspace.querySelector("#use-location");
    if (!navigator.geolocation) return setParseState("This browser can't share location. Enter an address instead.", "error");
    setBusy(button, true, "Locating…");
    navigator.geolocation.getCurrentPosition((position) => {
      setBusy(button, false);
      setPickup({ latitude: position.coords.latitude, longitude: position.coords.longitude, source: "gps", address: "" });
    }, () => {
      setBusy(button, false);
      setParseState("Location wasn't shared. Enter an address instead.", "error");
    }, { enableHighAccuracy: false, timeout: 8000 });
  }

  async function submitOffer() {
    const button = workspace.querySelector("#submit-offer");
    const error = workspace.querySelector("#form-error");
    if (missingForSubmit().length) return updateSubmitState();
    const draft = state.intake.draft;
    const pickup = state.offerLocation;
    const payload = {
      description: String(draft.description).trim(),
      quantity_original: String(draft.quantity_original || "").trim() || null,
      quantity_pallets: Number(draft.quantity_pallets),
      storage_state: draft.storage_state,
      pickup_deadline: new Date(draft.pickup_deadline).toISOString(),
      pickup_address: pickup.address || ({ gps: "GPS-selected pickup", corrected_pin: "Map-selected pickup", address: "Address-selected pickup" }[pickup.source] || "Reviewed pickup location"),
      donor_latitude: pickup.latitude,
      donor_longitude: pickup.longitude,
      location_source: pickup.source,
      transport_mode: draft.transport_mode,
    };
    if (draft.transport_mode === "donor_delivery") payload.donor_delivery_radius_km = 5;
    setBusy(button, true, "Finding a home…");
    error.hidden = true;
    try {
      const result = await api("/api/offers", { method: "POST", body: payload, mutation: true, token: null });
      if (!result.status_token) throw new Error("The offer was created without a private status link. Please retry.");
      if (pickup.source !== "corrected_pin" || pickup.address) localStorage.setItem(SAVED_PICKUP_KEY, JSON.stringify({ latitude: pickup.latitude, longitude: pickup.longitude, source: pickup.source, address: pickup.address || "" }));
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

  function loadGoogleMaps() {
    if (!state.mapsPromise) state.mapsPromise = api("/api/config", { token: null }).then((config) => {
      const key = config?.maps?.browser_key;
      if (!key) return null;
      state.mapsConfig = config.maps;
      return new Promise((resolve) => {
        window.gm_authFailure = () => {
          // A rejected key: drop live maps and fall back to the drawn ones
          // without discarding anything the donor has typed.
          state.mapsFailed = true;
          state.pickupMap = null;
          state.mapCache.clear();
          if (state.role === "donor") renderPickup(); else render();
        };
        window.__pantryRelayMapsReady = () => resolve(window.google.maps);
        const script = document.createElement("script");
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__pantryRelayMapsReady`;
        script.async = true;
        script.onerror = () => resolve(null);
        document.head.append(script);
      });
    }).catch(() => null);
    return state.mapsPromise.then((maps) => (state.mapsFailed ? null : maps));
  }

  function lat(position) { return typeof position.lat === "function" ? position.lat() : position.lat; }
  function lng(position) { return typeof position.lng === "function" ? position.lng() : position.lng; }

  function workflowMap(map, titleText = "Offer logistics") {
    if (!map) return "";
    const donor = map.donor;
    const recipients = arrayOf(map.recipients);
    const markers = recipients.slice(0, 8).map((recipient, index) => {
      const point = mapPoint(recipient.latitude, recipient.longitude);
      return point ? `<span class="workflow-point recipient-point" style="left:${point.x}%;top:${point.y}%" title="${e(recipient.name || `Recipient ${index + 1}`)}" aria-hidden="true"></span>` : "";
    }).join("");
    const donorPoint = donor ? mapPoint(donor.latitude, donor.longitude) : null;
    const routes = recipients.filter((recipient) => recipient.distance_miles != null).slice(0, 3).map((recipient) => {
      const duration = recipient.estimated_minutes == null ? "" : ` · ${formatNumber(recipient.estimated_minutes)} min`;
      return `<li><span>${e(recipient.name || recipient.recipient_id)}</span><strong>${e(formatNumber(recipient.distance_miles))} mi${e(duration)}</strong></li>`;
    }).join("");
    const mapData = { donor: donor ? { latitude: donor.latitude, longitude: donor.longitude } : null, recipients: recipients.slice(0, 8).map((recipient) => ({ latitude: recipient.latitude, longitude: recipient.longitude, name: recipient.name || recipient.recipient_id || "" })) };
    return `<section class="workflow-map-card" aria-label="${e(titleText)}"><div class="map-topline"><span>${e(titleText)}</span></div><div class="workflow-map" data-map="${e(JSON.stringify(mapData))}" aria-hidden="true"><span class="road road-a"></span><span class="road road-b"></span><span class="road road-c"></span><span class="city-label midtown">Midtown</span><span class="city-label downtown">Downtown</span><span class="city-label westside">Westside</span>${markers}${donorPoint ? `<span class="workflow-point donor-point" style="left:${donorPoint.x}%;top:${donorPoint.y}%"></span>` : ""}</div><div class="map-legend"><span><i class="legend-donor"></i>Pickup</span><span><i class="legend-recipient"></i>Recipient area (approximate)</span></div>${routes ? `<ul class="workflow-routes">${routes}</ul>` : ""}</section>`;
  }

  async function hydrateMaps() {
    const placeholders = [...workspace.querySelectorAll("[data-map]")];
    if (!placeholders.length) return;
    const maps = await loadGoogleMaps();
    if (!maps) return;
    const [{ Map, Circle }, { AdvancedMarkerElement, PinElement }] = await Promise.all([maps.importLibrary("maps"), maps.importLibrary("marker")]);
    placeholders.forEach((placeholder) => {
      if (!placeholder.isConnected) return;
      const key = placeholder.dataset.map;
      // Polling redraws the page every few seconds; reuse the live map so it
      // neither flickers nor counts as a new map load.
      const cached = state.mapCache.get(key);
      if (cached) return placeholder.replaceWith(cached);
      const data = JSON.parse(key);
      const element = document.createElement("div");
      element.className = "workflow-map google-map";
      element.dataset.map = key;
      placeholder.replaceWith(element);
      const map = new Map(element, { center: ATLANTA_CENTER, zoom: 11, mapId: state.mapsConfig.map_id, disableDefaultUI: true, zoomControl: true, gestureHandling: "cooperative" });
      const bounds = new maps.LatLngBounds();
      if (data.donor) {
        const position = { lat: data.donor.latitude, lng: data.donor.longitude };
        new AdvancedMarkerElement({ map, position, title: "Pickup", content: new PinElement({ background: "#145f45", borderColor: "#0c4733", glyphColor: "#d2e27e" }).element });
        bounds.extend(position);
      }
      data.recipients.forEach((recipient) => {
        if (!Number.isFinite(Number(recipient.latitude))) return;
        const center = { lat: Number(recipient.latitude), lng: Number(recipient.longitude) };
        // Recipient locations are approximate, so they are drawn as areas, not pins.
        new Circle({ map, center, radius: 700, strokeColor: "#8c560f", strokeWeight: 1, fillColor: "#d9a441", fillOpacity: .35 });
        bounds.extend(center);
      });
      if (!bounds.isEmpty()) map.fitBounds(bounds, 48);
      state.mapCache.set(key, element);
    });
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
    hydrateMaps();
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
    hydrateMaps();
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

  // Coordinator operations: what needs a human first, everything else one tap away.
  function opsUi() {
    if (!state.ops) {
      state.ops = {
        tab: "attention",
        regions: new Map(),
        reasonFor: null,
        timelineOpen: false,
        fitOpen: {},
        dismissed: new Set(readSessionJson("pantry-relay:ops-dismissed", [])),
        chat: [],
        chatBusy: false,
        chatOpen: false,
      };
    }
    return state.ops;
  }

  async function renderCoordinator() {
    state.token = "";
    sessionStorage.removeItem(tokenKey("ops"));
    workspace.innerHTML = loadingView("Opening the coordinator view…");
    try {
      await api("/api/demo/session", { method: "POST", token: null });
      if (state.role !== "ops") return;
      state.coordinatorSession = "ready";
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
      if (state.role !== "ops") return;
      drawCoordinator();
      if (coordinatorOffers(state.data).some((offer) => !TERMINAL.has(offer.status))) startPolling(loadCoordinator);
    } catch (err) {
      if (state.role !== "ops") return;
      if (isAuthError(err)) {
        state.coordinatorSession = "idle";
        renderCoordinatorRecovery(err);
      } else if (workspace.querySelector("#ops-shell")) {
        // Keep the page (and any chat) in place; a poll hiccup should not wipe it.
        showToast(`${errorMessage(err)} Retrying…`, true);
        startPolling(loadCoordinator);
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

  function drawCoordinator(force = false) {
    const ui = opsUi();
    if (!workspace.querySelector("#ops-shell")) {
      workspace.innerHTML = coordinatorShell();
      ui.regions.clear();
      bindCoordinatorShell();
      coordinatorChatRestore();
    }
    const now = Date.now();
    const offers = coordinatorOffers(state.data);
    const attention = coordinatorAttention(offers, now);
    const impact = state.data.impact || {};
    const active = offers.filter((offer) => !TERMINAL.has(offer.status)).length;
    const completed = Number(impact.completed_offers ?? 0);
    opsSetRegion("ops-metrics", `<strong>${e(formatNumber(completed))}</strong> completed rescue${completed === 1 ? "" : "s"} · <strong>${e(formatNumber(impact.completed_quantity_pallets ?? 0))}</strong> pallets moved · <strong>${e(formatNumber(active))}</strong> active`);
    opsSetRegion("ops-tabs", coordinatorTabs(attention.length, offers.length), force);
    if (ui.tab === "audit") {
      opsSetRegion("ops-panel", equityProof(state.equityAudit), force);
      return opsChatContext();
    }
    opsSetRegion("ops-panel", `<div class="ops-board"><div class="ops-list" id="ops-list"></div><div class="ops-detail-slot" id="ops-detail"></div></div>`);
    const visible = ui.tab === "all" ? offers : attention.map((item) => item.offer);
    let current = visible.find((offer) => opsId(offer) === state.selectedOfferId);
    if (!current && visible[0]) {
      current = visible[0];
      state.selectedOfferId = opsId(current);
    }
    const healthy = offers.filter((offer) => !TERMINAL.has(offer.status) && !opsIssue(offer, now)).length;
    opsSetRegion("ops-list", ui.tab === "all" ? coordinatorAllList(offers, now) : coordinatorAttentionList(attention, healthy, offers.length, now), force);
    opsSetRegion("ops-detail", current ? coordinatorDetail(current, now) : "", force);
    hydrateMaps();
    opsChatContext();
  }

  // Redraw a region only when its markup changed, and never while the
  // coordinator has a menu open or is typing a reason (polls run every 2 s).
  function opsSetRegion(id, html, force = false) {
    const ui = opsUi();
    const element = document.getElementById(id);
    if (!element || (!force && ui.regions.get(id) === html)) return;
    if (!force && (element.querySelector(".ops-more[open]") || (ui.reasonFor && element.querySelector(".ops-reason-form")))) return;
    const focusId = element.contains(document.activeElement) ? document.activeElement.id : "";
    element.innerHTML = html;
    ui.regions.set(id, html);
    [...ui.regions.keys()].forEach((key) => { if (key !== id && element.querySelector(`#${key}`)) ui.regions.delete(key); });
    if (focusId) document.getElementById(focusId)?.focus();
  }

  function coordinatorShell() {
    return `<div class="ops-shell" id="ops-shell">
      <header class="ops-head">
        <div><h1>Operations</h1><p class="ops-metrics" id="ops-metrics" aria-label="Impact so far"></p></div>
        <button class="tool-button ops-chat-toggle" id="ops-chat-toggle" type="button" aria-expanded="false" aria-controls="ops-chat"><span aria-hidden="true">✦</span> Ask Pantry Relay</button>
      </header>
      <div id="ops-tabs"></div>
      <div id="ops-panel" class="ops-panel" role="tabpanel" aria-labelledby="ops-tab-attention" tabindex="-1"></div>
      <aside class="ops-chat" id="ops-chat" aria-labelledby="ops-chat-title" hidden>
        <header class="ops-chat-head"><h2 id="ops-chat-title">Ask Pantry Relay</h2><button class="ops-chat-close" id="ops-chat-close" type="button" aria-label="Close chat">×</button></header>
        <div class="ops-chat-log" id="ops-chat-log" role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation with Pantry Relay"></div>
        <div class="ops-chat-suggest option-row" id="ops-chat-suggest"></div>
        <form class="ops-chat-form" id="ops-chat-form">
          <p class="ops-chat-context" id="ops-chat-context"></p>
          <div class="ops-chat-input"><label class="visually-hidden" for="ops-chat-input">Ask a question about the queue</label><textarea id="ops-chat-input" rows="1" maxlength="1000" placeholder="Ask about any offer…"></textarea><button class="button primary" id="ops-chat-send" type="submit">Send</button></div>
        </form>
      </aside>
    </div>`;
  }

  function coordinatorTabs(attentionCount, total) {
    const tab = opsUi().tab;
    const tabs = [["attention", "Needs attention", attentionCount], ["all", "All offers", total], ["audit", "Audit", null]];
    return `<div class="ops-tabs" role="tablist" aria-label="Coordinator views">${tabs.map(([key, label, count]) => {
      const selected = key === tab;
      return `<button type="button" role="tab" id="ops-tab-${key}" data-ops-tab="${key}" aria-controls="ops-panel" aria-selected="${selected}" tabindex="${selected ? "0" : "-1"}">${e(label)}${count == null ? "" : ` <span class="ops-count${key === "attention" && count ? " hot" : ""}">${e(count)}</span>`}</button>`;
    }).join("")}</div>`;
  }

  function bindCoordinatorShell() {
    const shell = workspace.querySelector("#ops-shell");
    shell.addEventListener("click", onCoordinatorClick);
    shell.addEventListener("submit", onCoordinatorSubmit);
    shell.addEventListener("keydown", onCoordinatorKeydown);
    // <details> toggle does not bubble; capture it to remember what is open.
    shell.addEventListener("toggle", (event) => {
      const target = event.target;
      const ui = opsUi();
      if (target.matches?.(".ops-timeline")) ui.timelineOpen = target.open;
      else if (target.matches?.(".ops-unfit")) ui.fitOpen[target.dataset.opsFit] = target.open;
      else if (target.matches?.(".ops-more") && !target.open) drawCoordinator();
    }, true);
    const input = shell.querySelector("#ops-chat-input");
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    });
  }

  function onCoordinatorClick(event) {
    const ui = opsUi();
    const target = event.target;
    workspace.querySelectorAll(".ops-more[open]").forEach((menu) => {
      if (!menu.contains(target) || target.closest(".ops-menu-item")) menu.open = false;
    });
    const tab = target.closest("[data-ops-tab]");
    if (tab) return selectCoordinatorTab(tab.dataset.opsTab);
    const select = target.closest("[data-ops-select]");
    if (select) {
      state.selectedOfferId = select.dataset.opsSelect;
      ui.reasonFor = null;
      drawCoordinator(true);
      if (window.matchMedia("(max-width: 850px)").matches) workspace.querySelector("#ops-detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const act = target.closest("[data-ops-act]");
    if (act) return runOpsAction(act, act.dataset.opsOffer, act.dataset.opsAct, act.dataset.opsBody ? JSON.parse(act.dataset.opsBody) : {});
    const reason = target.closest("[data-ops-reason]");
    if (reason) {
      ui.reasonFor = { offerId: reason.dataset.opsOffer, action: reason.dataset.opsReason };
      drawCoordinator(true);
      return workspace.querySelector("#ops-reason-input")?.focus();
    }
    if (target.closest("[data-ops-reason-cancel]")) return closeCoordinatorReason();
    const dismiss = target.closest("[data-ops-dismiss]");
    if (dismiss) {
      ui.dismissed.add(dismiss.dataset.opsDismiss);
      sessionStorage.setItem("pantry-relay:ops-dismissed", JSON.stringify([...ui.dismissed]));
      showToast("Removed from Needs attention. It's still under All offers.");
      return drawCoordinator(true);
    }
    const ask = target.closest("[data-ops-ask]");
    if (ask) {
      if (ask.dataset.opsOffer && ask.dataset.opsOffer !== state.selectedOfferId) {
        state.selectedOfferId = ask.dataset.opsOffer;
        drawCoordinator(true);
      }
      return opsAsk(ask.dataset.opsAsk);
    }
    if (target.closest("#refresh-equity")) return loadEquityAudit();
    if (target.closest("#ops-chat-toggle")) return opsChatOpen(!ui.chatOpen);
    if (target.closest("#ops-chat-close")) return opsChatOpen(false);
    const suggestion = target.closest("[data-chat-suggest]");
    if (suggestion) return opsAsk(suggestion.dataset.chatSuggest);
  }

  function onCoordinatorSubmit(event) {
    event.preventDefault();
    const form = event.target;
    if (form.id === "ops-chat-form") {
      const input = form.querySelector("#ops-chat-input");
      const text = input.value;
      if (!text.trim() || opsUi().chatBusy) return;
      input.value = "";
      input.style.height = "auto";
      return opsAsk(text);
    }
    if (form.matches(".ops-reason-form")) {
      const reason = String(new FormData(form).get("reason") || "").trim();
      if (!reason) return form.reportValidity();
      runOpsAction(form.querySelector("[type=submit]"), form.dataset.opsOffer, form.dataset.opsAction, { reason });
    }
  }

  function onCoordinatorKeydown(event) {
    const tab = event.target.closest?.("[role=tab]");
    if (tab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const tabs = [...workspace.querySelectorAll("#ops-tabs [role=tab]")];
      const index = tabs.indexOf(tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      return selectCoordinatorTab(tabs[next].dataset.opsTab);
    }
    if (event.target.id === "ops-chat-input" && event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      return event.target.form.requestSubmit();
    }
    if (event.key === "Escape") {
      if (event.target.closest(".ops-reason-form")) return closeCoordinatorReason();
      const menu = event.target.closest(".ops-more[open]");
      if (menu) { menu.open = false; return menu.querySelector("summary").focus(); }
      if (event.target.closest("#ops-chat")) opsChatOpen(false);
    }
  }

  function selectCoordinatorTab(tab) {
    const ui = opsUi();
    ui.tab = tab;
    ui.reasonFor = null;
    if (tab === "audit" && !state.equityAudit) loadEquityAudit();
    else drawCoordinator(true);
    workspace.querySelector("#ops-panel")?.setAttribute("aria-labelledby", `ops-tab-${tab}`);
    workspace.querySelector(`#ops-tab-${tab}`)?.focus();
  }

  function closeCoordinatorReason() {
    const ui = opsUi();
    const offerId = ui.reasonFor?.offerId;
    ui.reasonFor = null;
    drawCoordinator(true);
    if (offerId) workspace.querySelector(`#ops-more-${opsKey(offerId)} summary`)?.focus();
  }

  function coordinatorAttention(offers, now) {
    const dismissed = opsUi().dismissed;
    const rank = { danger: 0, warn: 1 };
    return offers
      .map((offer) => ({ offer, issue: opsIssue(offer, now) }))
      .filter(({ offer, issue }) => issue && !(TERMINAL.has(offer.status) && dismissed.has(opsId(offer))))
      .sort((a, b) => (rank[a.issue.tone] - rank[b.issue.tone]) || (opsDeadline(a.offer) - opsDeadline(b.offer)));
  }

  // One plain-language problem per offer and the action that fixes it.
  // Actions map to WorkflowService.ops_action: "expire" releases a held offer
  // (or times out the current wave) and asks the next wave; "promote" asks the
  // next wave but is refused while a hold is active; "resolve-transport" picks
  // a concrete transport mode for a needs_transport offer and opens a wave.
  function opsIssue(offer, now = Date.now()) {
    const id = opsId(offer);
    const status = offer.status;
    const deadline = opsDeadline(offer);
    const minutes = Number.isFinite(deadline) ? Math.round((deadline - now) / 60000) : Infinity;
    const holder = opsCandidateName(offer, offer.selected_recipient_id) || "The recipient";
    const left = arrayOf(offer.candidates).filter((item) => item.notification_status === "not_sent").length;
    const askNext = left
      ? { action: "promote", label: "Ask the next recipients" }
      : { action: "promote", label: "Close as no match" };
    const ask = (label, prompt) => ({ ask: prompt, label });
    const recent = (Date.parse(offer.updated_at || offer.created_at) || 0) > now - 24 * 3600 * 1000;
    if (TERMINAL.has(status)) {
      if (!recent) return null;
      if (status === "no_match") {
        const checked = arrayOf(offer.rejections).length;
        return { tone: "danger", title: "No one could take it", text: checked && !arrayOf(offer.candidates).length ? `${checked} recipient${checked === 1 ? "" : "s"} checked; none could safely take it.` : "Everyone who was asked said no or didn't reply.", primary: ask("Ask why", `Why wasn't anyone matched for offer #${opsShortId(id)}?`) };
      }
      if (status === "failed") return { tone: "danger", title: "Rescue failed", text: offer.outcome_reason || "Marked failed by a coordinator.", primary: ask("Ask what's next", `Offer #${opsShortId(id)} was marked failed. What should I do next?`) };
      return null;
    }
    if (status === "confirmed") return null;
    if (minutes <= 0) return { tone: "danger", title: "Pickup time passed", text: "The donor's deadline is over but the offer is still open.", primary: { action: "expire", label: "Close it out" } };
    const holdEnds = Date.parse(offer.reservation_expires_at);
    if (status === "reserved" && Number.isFinite(holdEnds) && holdEnds <= now) {
      return { tone: "danger", title: "Hold expired", text: `${holder} held it but didn't confirm in time.`, primary: { action: "expire", label: left ? "Ask the next recipients" : "Release and close" } };
    }
    const waveEnds = Date.parse(offer.wave_expires_at);
    if (status === "notified" && Number.isFinite(waveEnds) && waveEnds <= now) {
      return { tone: "danger", title: "No one replied in time", text: `Wave ${offer.current_wave || 1} got no answer.${left ? ` ${left} more recipient${left === 1 ? "" : "s"} can be asked.` : " No one is left to ask."}`, primary: askNext };
    }
    if (status === "needs_transport") {
      return {
        tone: "warn", title: "Needs a driver", text: "Nobody is lined up to move it. If recipients can collect, switch to pickup and they'll be asked.",
        primary: { action: "resolve-transport", label: "Recipients pick up", body: { transport_mode: "recipient_pickup" } },
        extras: [{ action: "resolve-transport", label: "Donor delivers (≤ 5 km)", body: { transport_mode: "donor_delivery", donor_delivery_radius_km: 5 } }],
      };
    }
    if (minutes <= 60) {
      const soon = `Gone in ${minutes} min`;
      if (status === "reserved") return { tone: "warn", title: soon, text: `${holder} is holding it but hasn't confirmed.`, primary: ask("Ask what to do", `Offer #${opsShortId(id)} leaves in ${minutes} minutes and ${holder} hasn't confirmed. What should I do?`) };
      return { tone: "warn", title: soon, text: "Nobody has claimed it yet.", primary: left ? { action: "promote", label: "Ask the next recipients now" } : ask("Ask what to do", `Offer #${opsShortId(id)} leaves in ${minutes} minutes and nobody has claimed it. What should I do?`) };
    }
    return null;
  }

  function coordinatorAttentionList(attention, healthy, total, now) {
    const healthyLine = `<p class="ops-healthy"><span aria-hidden="true"></span>Healthy: ${e(healthy)} moving normally</p>`;
    if (!total) return `<div class="ops-clear"><h2>No offers yet</h2><p>New donor offers show up here as soon as they're sent.</p></div>`;
    if (!attention.length) return `<div class="ops-clear"><h2>Nothing needs you right now.</h2>${healthyLine}</div>`;
    return `<h2 class="visually-hidden">Offers that need attention</h2><ul class="ops-rows">${attention.map(({ offer, issue }) => {
      const id = opsId(offer);
      const active = id === state.selectedOfferId;
      return `<li class="ops-row tone-${issue.tone}${active ? " active" : ""}"><button type="button" class="ops-row-main" id="ops-sel-${opsKey(id)}" data-ops-select="${e(id)}" aria-current="${active}"><span class="ops-row-title">${e(issue.title)}</span><span class="ops-row-text">${e(issue.text)}</span><small>${e(opsFood(offer))} · ${e(TERMINAL.has(offer.status) ? STATUS_LABELS[offer.status] || title(offer.status) : opsWhen(offer, now))}</small></button>${opsPrimaryButton(offer, issue, "row")}</li>`;
    }).join("")}</ul>${healthy ? healthyLine : ""}`;
  }

  function coordinatorAllList(offers, now) {
    if (!offers.length) return `<div class="ops-clear"><h2>No offers yet</h2><p>New donor offers show up here as soon as they're sent.</p></div>`;
    return `<h2 class="visually-hidden">All offers</h2><ul class="ops-rows">${offers.map((offer) => {
      const id = opsId(offer);
      const active = id === state.selectedOfferId;
      return `<li class="ops-row${active ? " active" : ""}"><button type="button" class="ops-row-main" id="ops-sel-${opsKey(id)}" data-ops-select="${e(id)}" aria-current="${active}"><span class="ops-row-title">${e(opsFood(offer))}</span><small>${e(opsWhen(offer, now))}</small></button>${statusPill(offer.status)}</li>`;
    }).join("")}</ul>`;
  }

  function opsPrimaryButton(offer, issue, place) {
    const primary = issue?.primary;
    if (!primary) return "";
    const id = opsId(offer);
    if (primary.ask) return `<button type="button" class="option ops-primary" id="ops-${place}-ask-${opsKey(id)}" data-ops-ask="${e(primary.ask)}" data-ops-offer="${e(id)}"><span aria-hidden="true">✦</span> ${e(primary.label)}</button>`;
    return `<button type="button" class="button primary ops-primary" id="ops-${place}-act-${opsKey(id)}" data-ops-act="${e(primary.action)}" data-ops-offer="${e(id)}"${primary.body ? ` data-ops-body="${e(JSON.stringify(primary.body))}"` : ""}>${e(primary.label)}</button>`;
  }

  function coordinatorDetail(offer, now) {
    const ui = opsUi();
    const id = opsId(offer);
    const issue = opsIssue(offer, now);
    const candidates = arrayOf(offer.candidates);
    const rejections = arrayOf(offer.rejections);
    const events = arrayOf(offer.events);
    const summary = [offer.quantity_original || pallets(offer.quantity_pallets), STORAGE_LABELS[offer.storage_state] || title(offer.storage_state), `gone by ${opsWhen(offer, now)}`, transportLabel(offer.transport_mode)].filter(Boolean).join(" · ");
    const asked = candidates.filter((item) => item.notification_status === "sent").length;
    const fitOpen = ui.fitOpen[id] ?? !candidates.length;
    return `<article class="ops-detail" aria-labelledby="ops-detail-title">
      <div class="ops-detail-head"><p class="kicker">Offer #${e(opsShortId(id))}</p>${statusPill(offer.status)}</div>
      <h2 id="ops-detail-title">${e(opsFood(offer))}</h2>
      <p class="ops-summary">${e(summary)}</p>
      ${issue ? `<p class="ops-callout tone-${issue.tone}"><strong>${e(issue.title)}.</strong> ${e(issue.text)}</p>` : ""}
      ${coordinatorActions(offer, issue)}
      <section class="ops-recipients" aria-labelledby="ops-recipients-title">
        <h3 id="ops-recipients-title">Recipients <small>${e(asked)} asked · ${e(candidates.length - asked)} next in line · ${e(rejections.length)} not a fit</small></h3>
        ${candidates.length ? `<ul class="ops-people">${candidates.map((item) => opsPerson(item, offer)).join("")}</ul>` : `<p class="muted">No recipient passed the safety and logistics checks.</p>`}
        ${rejections.length ? `<details class="ops-unfit" data-ops-fit="${e(id)}"${fitOpen ? " open" : ""}><summary>Why ${e(rejections.length)} ${rejections.length === 1 ? "wasn't" : "weren't"} a fit</summary><ul class="ops-people">${rejections.map((item) => opsPerson(item, offer)).join("")}</ul></details>` : ""}
      </section>
      ${workflowMap(offer.map, "Pickup and recipient areas")}
      ${events.length ? `<details class="ops-timeline"${ui.timelineOpen ? " open" : ""}><summary>Timeline · ${e(events.length)} event${events.length === 1 ? "" : "s"}</summary>${timelineContent(events)}</details>` : ""}
    </article>`;
  }

  function coordinatorActions(offer, issue) {
    const ui = opsUi();
    const id = opsId(offer);
    const key = opsKey(id);
    if (ui.reasonFor?.offerId === id) {
      const cancel = ui.reasonFor.action === "cancel";
      return `<form class="ops-reason-form" data-ops-offer="${e(id)}" data-ops-action="${e(ui.reasonFor.action)}"><label for="ops-reason-input">${cancel ? "Why cancel this offer?" : "Why did this rescue fail?"}</label><div class="question-input"><input id="ops-reason-input" name="reason" required maxlength="500" placeholder="${cancel ? "Donor called to cancel" : "Driver never arrived"}" /><button class="button danger" type="submit">${cancel ? "Cancel offer" : "Mark failed"}</button><button class="button quiet" type="button" data-ops-reason-cancel>Never mind</button></div></form>`;
    }
    const items = [];
    const button = (action, label, body, cls = "") => `<button type="button" class="ops-menu-item${cls}" data-ops-act="${e(action)}" data-ops-offer="${e(id)}"${body ? ` data-ops-body="${e(JSON.stringify(body))}"` : ""}>${e(label)}</button>`;
    arrayOf(issue?.extras).forEach((extra) => items.push(button(extra.action, extra.label, extra.body)));
    const primary = issue?.primary?.action;
    if (!TERMINAL.has(offer.status)) {
      const left = arrayOf(offer.candidates).some((item) => item.notification_status === "not_sent");
      if (offer.status === "notified" && primary !== "promote") items.push(button("promote", left ? "Ask the next recipients" : "Close as no match"));
      if (["notified", "reserved"].includes(offer.status) && primary !== "expire") items.push(button("expire", offer.status === "reserved" ? "Simulate hold timeout" : "Simulate timeout"));
      items.push(`<button type="button" class="ops-menu-item danger" data-ops-reason="cancel" data-ops-offer="${e(id)}">Cancel offer…</button>`);
      items.push(`<button type="button" class="ops-menu-item danger" data-ops-reason="fail" data-ops-offer="${e(id)}">Mark failed…</button>`);
    } else if (issue && !ui.dismissed.has(id)) {
      items.push(`<button type="button" class="ops-menu-item" data-ops-dismiss="${e(id)}">Dismiss from Needs attention</button>`);
    }
    if (!issue?.primary && !items.length) return "";
    const more = items.length ? `<details class="ops-more" id="ops-more-${key}"><summary>More<span aria-hidden="true"> ▾</span></summary><div class="ops-menu" role="group" aria-label="More actions">${items.join("")}</div></details>` : "";
    return `<div class="ops-actions">${opsPrimaryButton(offer, issue, "detail")}${more}</div>`;
  }

  async function runOpsAction(button, offerId, action, extra = {}) {
    const defaults = { expire: "Coordinator demo timeout", promote: "Coordinator advanced silent wave" };
    const body = { reason: defaults[action] || "", ...extra };
    await mutateButton(button, `/api/ops/offers/${encodeURIComponent(offerId)}/${action}`, body, (result) => {
      opsUi().reasonFor = null;
      const status = result?.status;
      const message = status === "no_match" ? "No one is left to ask. Marked as no match."
        : status === "expired" ? "Closed: the pickup deadline has passed."
        : action === "cancel" ? "Offer cancelled."
        : action === "fail" ? "Marked as failed."
        : status === "notified" ? "The next recipients have been asked."
        : "Done.";
      showToast(message);
      loadCoordinator();
    });
  }

  function opsPerson(candidate, offer) {
    const fit = candidate.eligible !== false;
    const name = candidate.name || candidate.recipient_name || candidate.recipient_id || "Recipient";
    const holdOver = candidate.response === "holding" && Date.parse(offer?.reservation_expires_at) <= Date.now();
    const status = !fit ? opsReasons(candidate) : holdOver ? "Hold ran out — didn't confirm" : opsCandidateStatus(candidate);
    const distance = candidate.travel?.distance_miles ?? candidate.distance_miles;
    const tone = !fit ? "unfit" : ["won", "holding"].includes(candidate.response) ? "good" : ["declined", "timed_out", "hold_expired", "invalidated"].includes(candidate.response) ? "out" : "fit";
    return `<li class="${tone}"><span class="ops-mark" aria-hidden="true">${fit ? (tone === "out" ? "–" : "✓") : "×"}</span><div><strong>${e(name)}</strong><small>${e(status)}${distance != null ? ` · ${e(formatNumber(distance))} mi` : ""}</small></div></li>`;
  }

  function opsCandidateStatus(candidate) {
    const labels = { holding: "Holding it — needs to confirm", won: "Confirmed pickup", declined: "Said no", timed_out: "Didn't reply in time", hold_expired: "Held it but didn't confirm", invalidated: "Offer closed before they answered" };
    if (candidate.response === "declined" && candidate.decline_reason) return `Said no: ${candidate.decline_reason}`;
    if (labels[candidate.response]) return labels[candidate.response];
    if (candidate.notification_status === "sent") return `Asked${candidate.wave ? ` in wave ${candidate.wave}` : ""} — waiting for a reply`;
    return "Qualifies — next in line";
  }

  function opsReasons(candidate) {
    const reasons = arrayOf(candidate.reasons).map(opsReasonText);
    return reasons.length ? [...new Set(reasons)].join("; ") : (candidate.reason || "Didn't pass the safety checks");
  }

  function opsReasonText(code) {
    const text = String(code || "");
    const [kind, detail = ""] = text.split(":");
    const capacity = detail.match(/needs_([\d.]+)_pallets_but_max_is_([\d.]+)/);
    const labels = {
      manual_review_required: "Their profile needs a manual check first",
      storage_incompatible: detail.includes("frozen") ? "No freezer space" : "No commercial refrigeration",
      capacity_insufficient: capacity ? `Can take ${capacity[2]} pallets; this is ${capacity[1]}` : "Not enough space",
      known_reserved_capacity_insufficient: "Their space is already promised to other food",
      transportation_needed: "Needs a driver arranged first",
      transport_unavailable: "They can't pick up",
      transport_incompatible: "No refrigerated vehicle for pickup",
      location_missing: "Their location is unknown",
      donor_delivery_radius_exceeded: "Too far for donor delivery (over 5 km)",
      route_exceeds_donor_delivery_radius: "Too far for donor delivery (over 5 km)",
      donor_delivery_route_exceeds_radius: "Too far for donor delivery (over 5 km)",
      pickup_window_unknown: "Their pickup hours are unknown",
      travel_time_margin_negative: "Can't get there before the deadline",
      route_cannot_meet_donor_deadline: "The drive is too long for the deadline",
      route_cannot_meet_recipient_service_horizon: "Outside their pickup hours",
      route_recipient_service_horizon_invalid: "Their pickup hours couldn't be checked",
      service_day_unavailable_before_deadline: "Closed before the deadline",
    };
    return labels[kind] || title(kind) || "Didn't pass the safety checks";
  }

  // --- "Ask Pantry Relay" chat, backed by POST /api/ops/ask (ADK root agent).
  function opsChatOpen(open) {
    const ui = opsUi();
    ui.chatOpen = open;
    const panel = workspace.querySelector("#ops-chat");
    const toggle = workspace.querySelector("#ops-chat-toggle");
    if (!panel || !toggle) return;
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      opsChatContext();
      workspace.querySelector("#ops-chat-input")?.focus();
    } else {
      toggle.focus();
    }
  }

  function coordinatorChatRestore() {
    const ui = opsUi();
    ui.chat.forEach((message) => opsChatAppend(message));
    if (ui.chatBusy) opsChatTyping(true);
    if (ui.chatOpen) {
      workspace.querySelector("#ops-chat").hidden = false;
      workspace.querySelector("#ops-chat-toggle").setAttribute("aria-expanded", "true");
    }
  }

  function opsChatContext() {
    const context = workspace.querySelector("#ops-chat-context");
    const suggest = workspace.querySelector("#ops-chat-suggest");
    if (!context || !suggest) return;
    const offer = opsSelectedOffer();
    const text = offer ? `Asking about offer #${opsShortId(opsId(offer))} · ${opsFood(offer)}` : "";
    if (context.textContent !== text) context.textContent = text;
    const ui = opsUi();
    const suggestions = ["Which offers are at risk?", "Why wasn't anyone matched for the latest offer?"];
    const unfit = arrayOf(offer?.rejections)[0];
    if (unfit) suggestions.push(`Why wasn't ${unfit.name || unfit.recipient_id} a fit?`);
    const html = ui.chat.length ? "" : suggestions.map((item) => `<button type="button" class="option" data-chat-suggest="${e(item)}">${e(item)}</button>`).join("");
    if (suggest.dataset.html !== html) {
      suggest.innerHTML = html;
      suggest.dataset.html = html;
    }
  }

  function opsChatAppend(message) {
    const log = workspace.querySelector("#ops-chat-log");
    if (!log) return;
    const bubble = document.createElement("div");
    bubble.className = `ops-bubble ${message.role}${message.tone ? ` ${message.tone}` : ""}`;
    bubble.innerHTML = `<span class="visually-hidden">${message.role === "user" ? "You:" : "Pantry Relay:"}</span>${message.role === "user" ? `<p>${e(message.text)}</p>` : opsChatMarkup(message.text)}${message.meta ? `<small>${e(message.meta)}</small>` : ""}`;
    log.append(bubble);
    log.scrollTop = log.scrollHeight;
  }

  function opsChatTyping(on) {
    const log = workspace.querySelector("#ops-chat-log");
    if (!log) return;
    log.querySelector(".ops-typing")?.remove();
    if (on) {
      log.insertAdjacentHTML("beforeend", `<div class="ops-bubble agent ops-typing" aria-label="Pantry Relay is thinking"><i></i><i></i><i></i></div>`);
      log.scrollTop = log.scrollHeight;
    }
    const send = workspace.querySelector("#ops-chat-send");
    if (send) send.disabled = on;
  }

  async function opsAsk(question) {
    const ui = opsUi();
    const text = String(question || "").trim();
    if (!text || ui.chatBusy) return;
    if (!ui.chatOpen) opsChatOpen(true);
    const prompt = opsPrompt(text);
    const userMessage = { role: "user", text };
    ui.chat.push(userMessage);
    opsChatAppend(userMessage);
    opsChatContext();
    ui.chatBusy = true;
    opsChatTyping(true);
    let reply;
    try {
      const result = await api("/api/ops/ask", { method: "POST", body: { prompt }, token: null });
      const answer = String(result?.final_text || "").trim();
      const seconds = Number(result?.elapsed_ms) / 1000;
      const checkedMatcher = arrayOf(result?.tool_trace).some((item) => item.tool === "match_surplus_offer" && item.status === "succeeded");
      reply = answer
        ? { role: "agent", text: answer, meta: [checkedMatcher ? "Re-ran the matcher" : "", Number.isFinite(seconds) ? `${formatNumber(Math.round(seconds * 10) / 10)} s` : ""].filter(Boolean).join(" · ") }
        : { role: "agent", tone: "error", text: "No answer came back. Try asking another way." };
    } catch (err) {
      reply = { role: "agent", tone: "error", text: err?.status === 503
        ? "The assistant is offline right now. The queue and every action still work; try again in a minute."
        : isAuthError(err) ? "Your coordinator session ended. Reload the page to continue." : errorMessage(err) };
    }
    ui.chatBusy = false;
    ui.chat.push(reply);
    if (state.role !== "ops") return;
    opsChatTyping(false);
    opsChatAppend(reply);
  }

  // The agent has no direct access to the queue, so send a compact snapshot.
  function opsPrompt(question) {
    const ui = opsUi();
    const now = Date.now();
    const offers = coordinatorOffers(state.data);
    const local = (value) => { const time = Date.parse(value); return Number.isFinite(time) ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(time) : null; };
    const brief = (offer) => {
      const issue = opsIssue(offer, now);
      const candidates = arrayOf(offer.candidates);
      return { id: `#${opsShortId(opsId(offer))}`, food: opsFood(offer).slice(0, 90), status: offer.status, deadline: local(offer.deadline), minutes_left: Math.round((opsDeadline(offer) - now) / 60000), issue: issue ? `${issue.title}: ${issue.text}` : null, asked: candidates.filter((item) => item.notification_status === "sent").length, next_in_line: candidates.filter((item) => item.notification_status === "not_sent").length, not_a_fit: arrayOf(offer.rejections).length };
    };
    const full = (offer) => ({
      ...brief(offer),
      quantity: offer.quantity_original || pallets(offer.quantity_pallets),
      storage: offer.storage_state,
      transport: offer.transport_mode,
      wave: offer.current_wave,
      outcome_reason: offer.outcome_reason || undefined,
      recipients: arrayOf(offer.candidates).slice(0, 10).map((item) => ({ name: item.name || item.recipient_id, status: opsCandidateStatus(item), miles: item.travel?.distance_miles ?? item.distance_miles })),
      rejected: arrayOf(offer.rejections).slice(0, 12).map((item) => ({ name: item.name || item.recipient_id, why: opsReasons(item) })),
    });
    const selected = opsSelectedOffer();
    const latest = offers[0];
    const history = ui.chat.slice(-5).map((item) => `${item.role === "user" ? "Coordinator" : "You"}: ${item.text.slice(0, 400)}`).join("\n");
    const build = (queueSize) => [
      "You are Pantry Relay's assistant for a food-rescue coordinator in Atlanta, answering inside the operations screen.",
      "Answer in plain language, briefly (a few sentences or a short list). Refer to offers by food name and short id.",
      "Use the queue snapshot below as the source of truth for current offers. Its recipient eligibility reasons are authoritative deterministic checks: never say a rejected recipient could take the food, and never invent live capacity. Only call match_surplus_offer if the coordinator explicitly asks for a new match.",
      "Coordinator actions available on screen: 'Ask the next recipients', 'Simulate timeout', 'Recipients pick up' / 'Donor delivers' for offers needing transport, 'Cancel offer', 'Mark failed'.",
      `Current local time: ${local(new Date(now).toISOString())}. All times below are the coordinator's local time; quote them as given.`,
      `Queue snapshot (newest first): ${JSON.stringify(offers.slice(0, queueSize).map(brief))}`,
      selected ? `Offer the coordinator has open: ${JSON.stringify(full(selected))}` : "",
      latest && latest !== selected ? `Latest offer: ${JSON.stringify(full(latest))}` : "",
      history ? `Earlier in this conversation:\n${history}` : "",
      `Coordinator question: ${question}`,
    ].filter(Boolean).join("\n\n");
    let prompt = build(12);
    for (let size = 8; prompt.length > 7800 && size >= 0; size -= 4) prompt = build(size);
    return prompt.length > 7900 ? `${prompt.slice(0, 7000)}\n\nCoordinator question: ${question.slice(0, 800)}` : prompt;
  }

  function opsChatMarkup(text) {
    const inline = (value) => e(value).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
    const out = [];
    let paragraph = [];
    let list = null;
    const flushParagraph = () => { if (paragraph.length) out.push(`<p>${paragraph.join("<br>")}</p>`); paragraph = []; };
    const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.join("")}</${list.tag}>`); list = null; };
    String(text || "").split("\n").forEach((raw) => {
      const line = raw.trim();
      if (!line) { flushParagraph(); flushList(); return; }
      const item = line.match(/^([-*•]|\d+[.)])\s+(.*)$/);
      if (item) {
        flushParagraph();
        const tag = /\d/.test(item[1]) ? "ol" : "ul";
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push(`<li>${inline(item[2])}</li>`);
      } else {
        flushList();
        paragraph.push(inline(line.replace(/^#+\s*/, "")));
      }
    });
    flushParagraph();
    flushList();
    return out.join("");
  }

  function opsSelectedOffer() {
    return coordinatorOffers(state.data).find((offer) => opsId(offer) === state.selectedOfferId) || null;
  }
  function opsShortId(id) { return String(id || "").replace(/^offer_/, "").slice(0, 6) || "pending"; }
  function opsId(offer) { return String(offer?.offer_id || offer?.id || ""); }
  function opsKey(id) { return String(id).replace(/[^A-Za-z0-9_-]/g, ""); }
  function opsFood(offer) { return offer.description_original || offer.description || "Food rescue offer"; }
  function opsDeadline(offer) { const time = Date.parse(offer.deadline || offer.pickup_deadline); return Number.isFinite(time) ? time : Infinity; }
  function opsCandidateName(offer, recipientId) {
    if (!recipientId) return "";
    const match = arrayOf(offer.candidates).find((item) => item.recipient_id === recipientId);
    return match?.name || recipientId;
  }
  function opsWhen(offer, now = Date.now()) {
    const time = opsDeadline(offer);
    if (!Number.isFinite(time)) return "no deadline";
    const date = new Date(time);
    const sameDay = date.toDateString() === new Date(now).toDateString();
    const clock = new Intl.DateTimeFormat(undefined, sameDay ? { timeStyle: "short" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
    const minutes = Math.round((time - now) / 60000);
    if (minutes <= 0) return `${clock} (passed)`;
    if (minutes < 60) return `${clock} (in ${minutes} min)`;
    if (minutes < 24 * 60) return `${clock} (in ${Math.round(minutes / 60)} h)`;
    return clock;
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
    const copy = isAuthError(err) ? "The demo session ended." : "The coordinator view couldn't start. Check the connection.";
    workspace.innerHTML = `<section class="ops-recovery"><h1>Operations</h1><p>${e(copy)}</p><button id="retry-coordinator" class="button primary" type="button">Try again</button></section>`;
    workspace.querySelector("#retry-coordinator").addEventListener("click", renderCoordinator);
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
