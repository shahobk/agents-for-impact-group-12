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
            <p id="pickup-current" class="pickup-current" aria-live="polite"></p>
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
    const current = workspace.querySelector("#pickup-current");
    if (current) current.textContent = state.offerLocation ? `📍 ${state.offerLocation.address || "Pin placed on the map"}` : "Search for the store, use your location, or tap the map.";
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
    workspace.innerHTML = loadingView("Loading your offer…");
    loadDonorStatus();
  }

  async function loadDonorStatus() {
    try {
      state.data = await api("/api/offers/status");
      if (state.role !== "status") return;
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

  // Polling redraws every 2s, so the page is built once per offer and then
  // only the regions whose content changed are replaced. That keeps focus,
  // open <details>, and the live map intact between polls.
  const statusRegionHtml = new WeakMap();
  const STATUS_STEPS = ["submitted", "matching", "notified", "reserved", "confirmed", "completed"];

  function drawDonorStatus() {
    const offer = offerOf(state.data);
    const offerId = offer.offer_id || offer.id || "";
    const events = arrayOf(state.data.events || offer.events);
    const candidates = arrayOf(state.data.candidates || offer.candidates);
    const reservation = state.data.reservation || offer.reservation;
    let root = workspace.querySelector(".status-view");
    if (!root || root.dataset.offerId !== offerId) {
      workspace.innerHTML = `
        <section class="status-view" data-offer-id="${e(offerId)}" aria-labelledby="status-sentence">
          <div class="status-head">
            <h1 id="status-sentence" class="status-sentence" aria-live="polite"></h1>
            <p class="status-detail" data-region="detail"></p>
            <div data-region="action"></div>
            <div class="status-progress" data-region="progress"></div>
          </div>
          <p class="status-summary" data-region="summary"></p>
          <div class="status-body">
            <section class="status-recipients" aria-labelledby="status-recipients-title">
              <h2 id="status-recipients-title">Food banks</h2>
              <div data-region="recipients"></div>
            </section>
            <div class="status-map" data-region="map"></div>
          </div>
          <details class="status-more"><summary>Activity</summary><div data-region="activity"></div></details>
          <details class="status-more" id="status-demo"><summary>Demo controls</summary><div data-region="demo"></div></details>
          <div class="status-again" data-region="again"></div>
        </section>`;
      root = workspace.querySelector(".status-view");
      root.addEventListener("click", (event) => {
        if (event.target.closest("[data-status-new]")) clearToken("donor", "donor");
      });
    }
    const story = statusStory(offer, candidates, reservation);
    root.dataset.tone = story.tone;
    const sentence = root.querySelector("#status-sentence");
    if (sentence.textContent !== story.sentence) sentence.textContent = story.sentence;
    statusPatch(root, "detail", story.detail);
    statusPatch(root, "action", story.action ? `<button class="button primary" type="button" data-status-new>${e(story.action)}</button>` : "");
    statusPatch(root, "progress", STATUS_STEPS.includes(offer.status) ? progress(offer.status) : "");
    statusPatch(root, "summary", statusSummary(offer));
    statusPatch(root, "recipients", statusRecipientRows(offer, candidates));
    statusPatch(root, "map", workflowMap(state.data.map, "Pickup and nearby food banks"));
    statusPatch(root, "activity", statusActivity(events, candidates));
    statusPatch(root, "again", story.action ? "" : `<button class="status-link" type="button" data-status-new>Start another offer</button>`);
    root.querySelector("#status-demo").hidden = !state.demoRecipients.length || !candidates.some((item) => item.notification_status === "sent");
    if (statusPatch(root, "demo", demoAccess(state.demoRecipients, candidates, offer.current_wave))) bindDemoRecipientButtons();
    statusCountdown();
    hydrateMaps();
  }

  function statusPatch(root, region, html) {
    const element = root.querySelector(`[data-region="${region}"]`);
    if (!element || statusRegionHtml.get(element) === html) return false;
    statusRegionHtml.set(element, html);
    element.innerHTML = html;
    return true;
  }

  // One plain sentence answering "what's happening with my food right now?",
  // plus one supporting line and, only when the offer is over, one action.
  function statusStory(offer, candidates, reservation) {
    const asked = candidates.filter((item) => item.notification_status === "sent");
    const holderId = reservation?.recipient_id || offer.selected_recipient_id;
    const holder = candidates.find((item) => item.recipient_id === holderId)?.name || "A food bank";
    const reason = offer.outcome_reason ? ` Reason: ${offer.outcome_reason.trim().replace(/[^.!?]$/, "$&.")}` : "";
    const again = "Post another offer";
    switch (offer.status) {
      case "notified": {
        const count = offer.current_wave > 1 ? `asked ${asked.length} nearby food banks so far` : `${asked.length} nearby food bank${asked.length === 1 ? " was" : "s were"} asked`;
        const more = candidates.some((item) => item.notification_status !== "sent");
        const by = offer.wave_expires_at ? ` by ${statusTime(offer.wave_expires_at)}` : "";
        return { tone: "active", sentence: `Finding a home — ${count}.`, detail: e(more ? `If no one says yes${by}, we'll ask the next closest.` : `Waiting for an answer${by}.`) };
      }
      case "reserved": {
        const expires = reservation?.expires_at || offer.reservation_expires_at;
        return { tone: "active", sentence: `${holder} is holding it.`, detail: expires ? `<span role="timer" data-status-expires="${e(expires)}"></span>` : "Waiting for them to confirm pickup." };
      }
      case "confirmed": {
        const details = reservation?.confirmation_details || {};
        const when = details.expected_handoff_time ? ` for ${statusTime(details.expected_handoff_time)}` : "";
        const who = details.contact_name ? `${details.contact_name} from ${holder}` : holder;
        const phone = details.contact_phone ? ` · <a href="tel:${e(details.contact_phone.replace(/[^\d+]/g, ""))}">${e(details.contact_phone)}</a>` : "";
        return { tone: "done", sentence: `Pickup confirmed${when}.`, detail: `${e(who)} is coming${phone}` };
      }
      case "completed": {
        const rescued = offer.completed_quantity_estimated !== false && offer.quantity_original ? offer.quantity_original : pallets(offer.completed_quantity ?? offer.quantity_pallets);
        return { tone: "done", sentence: `Picked up. Thank you — ${rescued} rescued.`, detail: e(`Collected by ${holder}.`) };
      }
      case "needs_transport":
        return { tone: "warn", sentence: "This one needs a driver first.", detail: "A coordinator is arranging transport. We'll ask nearby food banks as soon as that's sorted — nothing for you to do." };
      case "no_match":
        return { tone: "stop", sentence: "No nearby food bank could take it this time.", detail: "Everyone who could fit it was asked.", action: again };
      case "expired":
        return { tone: "stop", sentence: "The pickup window closed before anyone could collect it.", detail: "Nothing more will be sent for this offer.", action: again };
      case "cancelled":
        return { tone: "stop", sentence: "This offer was cancelled.", detail: e(`No food bank will be asked about it.${reason}`), action: again };
      case "failed":
        return { tone: "stop", sentence: "This pickup fell through.", detail: e(`A coordinator closed it.${reason}`), action: again };
      default:
        return { tone: "active", sentence: "Finding a home — choosing nearby food banks.", detail: "" };
    }
  }

  function statusSummary(offer) {
    return [
      offer.description_structured || offer.description_original || offer.description || "Food offer",
      offer.quantity_original || pallets(offer.quantity_pallets),
      STORAGE_LABELS[offer.storage_state] || title(offer.storage_state),
      `Gone by ${statusTime(offer.deadline || offer.pickup_deadline)}`,
    ].filter(Boolean).map((part, index, parts) => {
      // The separator trails each item so a wrapped line never starts with it.
      const dot = index < parts.length - 1 ? `<span class="status-dot" aria-hidden="true"> ·</span>` : "";
      return index ? `<span class="status-part">${e(part)}${dot}</span>` : `<strong>${e(part)}</strong>${dot}`;
    }).join(" ");
  }

  function statusRecipientRows(offer, candidates) {
    const asked = candidates.filter((item) => item.notification_status === "sent");
    if (!asked.length) {
      const empty = { needs_transport: "None asked yet — waiting on a driver.", no_match: "None nearby could take this amount." }[offer.status] || (TERMINAL.has(offer.status) ? "No food banks were asked." : "Choosing who to ask…");
      return `<p class="status-empty">${e(empty)}</p>`;
    }
    const order = { holding: 0, won: 0, pending: 1 };
    const rows = [...asked].sort((a, b) => (order[a.response] ?? 2) - (order[b.response] ?? 2));
    return `<ul class="status-rows">${rows.map((item) => {
      const [label, tone] = statusRecipientState(item.response, offer.status);
      return `<li><span>${e(item.name || item.recipient_id || "Food bank")}</span><span class="status-state" data-tone="${tone}">${e(label)}</span></li>`;
    }).join("")}</ul>`;
  }

  function statusRecipientState(response, offerStatus) {
    if (response === "won") return offerStatus === "completed" ? ["Picked up", "done"] : ["Confirmed", "done"];
    return ({
      pending: ["Asked", "active"],
      holding: ["Holding", "hold"],
      declined: ["Declined", "off"],
      timed_out: ["Didn't reply", "off"],
      hold_expired: ["Didn't confirm", "off"],
      invalidated: ["No longer needed", "off"],
    })[response] || ["Asked", "active"];
  }

  // Plain-language version of the shared timeline for donors.
  function statusActivity(events, candidates) {
    if (!events.length) return `<p class="status-empty">Nothing yet.</p>`;
    const nameOf = (id) => candidates.find((item) => item.recipient_id === id)?.name || "A food bank";
    const text = (event) => {
      const who = nameOf(event.actor_id);
      const asked = /(\d+)/.exec(event.text || "")?.[1];
      return ({
        offer_submitted: "You posted the offer.",
        transport_needed: "Waiting for a driver before asking food banks.",
        wave_notified: asked ? `Asked ${asked} nearby food bank${asked === "1" ? "" : "s"}.` : "Asked nearby food banks.",
        candidate_declined: `${who} said no.`,
        offer_held: `${who} put a hold on it.`,
        reservation_expired: "The hold ran out.",
        handoff_confirmed: `${who} confirmed pickup.`,
        handoff_completed: `${who} picked it up.`,
        no_match: "No one else nearby to ask.",
        offer_expired: "The pickup window closed.",
        offer_cancelled: "A coordinator cancelled the offer.",
        offer_failed: "A coordinator closed the offer.",
      })[event.type] || event.display_text || event.text || "Offer updated.";
    };
    return `<ol class="status-activity">${[...events].reverse().map((event) => `<li><span>${e(text(event))}</span><time datetime="${e(event.timestamp || "")}">${e(statusTime(event.timestamp || event.created_at))}</time></li>`).join("")}</ol>`;
  }

  function statusTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
    if (date.toDateString() === new Date().toDateString()) return time;
    return `${new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(date)}, ${time}`;
  }

  function statusCountdown() {
    const element = workspace.querySelector("[data-status-expires]");
    if (state.countdownTimer) window.clearInterval(state.countdownTimer);
    state.countdownTimer = null;
    if (!element) return;
    const update = () => {
      const remaining = Math.max(0, new Date(element.dataset.statusExpires).getTime() - Date.now());
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      element.textContent = remaining > 0 ? `${minutes}:${String(seconds).padStart(2, "0")} left for them to confirm pickup.` : "Their hold ran out — asking the others again.";
      if (!remaining && state.countdownTimer) {
        window.clearInterval(state.countdownTimer);
        state.countdownTimer = null;
      }
    };
    update();
    state.countdownTimer = window.setInterval(update, 1000);
  }

  function demoAccess(access, candidates, currentWave) {
    if (!access.length) return "";
    const currentIds = new Set(candidates.filter((item) => item.wave === currentWave && item.notification_status === "sent").map((item) => item.recipient_id));
    const currentAccess = access.filter((item) => currentIds.has(item.recipient_id));
    const visible = currentAccess.length ? currentAccess : access.slice(0, 3);
    return `<p class="status-demo-note">Open a food bank's inbox in a new tab to hold, confirm, or decline.</p><div class="option-row">${visible.map((item, index) => `<button class="option demo-recipient" data-index="${access.indexOf(item)}" type="button">${e(item.name || item.recipient_id || `Recipient ${index + 1}`)} <span aria-hidden="true">↗</span></button>`).join("")}</div>`;
  }

  function bindDemoRecipientButtons() {
    workspace.querySelectorAll(".demo-recipient").forEach((button) => button.addEventListener("click", () => {
      const item = state.demoRecipients[Number(button.dataset.index)];
      if (!item) return;
      const target = item.role_url || `/?role=recipient#token=${encodeURIComponent(item.token)}`;
      window.open(target, "_blank", "noopener,noreferrer");
    }));
  }

  // Recipient inbox: one card, one step at a time (offer -> hold & confirm -> pick up).
  // The pantry replies in its own words; the agent fills in the confirmation.
  const RECIPIENT_CONTACT_KEY = "pantry-relay:recipient-contact";
  const RECIPIENT_FIELDS = ["contact_name", "contact_phone", "expected_handoff_time"];
  const RECIPIENT_LABELS = { contact_name: "Picking up", contact_phone: "Phone", expected_handoff_time: "Arriving" };
  const RECIPIENT_DECLINE_REASONS = ["No space", "No transport", "No staff", "Not today"];

  function renderRecipient() {
    if (!state.token) return renderMissingContext("recipient");
    state.handoff = null;
    state.recipientView = "";
    state.recipientStage = "";
    workspace.innerHTML = loadingView("Loading your offers…");
    loadRecipient();
  }

  async function loadRecipient() {
    try {
      state.data = await api("/api/recipients/notifications");
      if (state.role !== "recipient") return;
      const notices = arrayOf(state.data.notifications);
      if (!notices.some((item) => recipientOfferId(item) === state.selectedOfferId)) state.selectedOfferId = notices[0] ? recipientOfferId(notices[0]) : "";
      drawRecipient();
      if (!notices.length || notices.some((item) => !TERMINAL.has(item.offer?.status || item.status))) startPolling(loadRecipient);
    } catch (err) {
      if (isAuthError(err)) return recoverMissingContext("recipient");
      renderLoadError("Could not load this recipient inbox", err, () => clearToken("recipient"));
    }
  }

  function recipientOfferId(item) { return item?.offer_id || item?.offer?.offer_id || ""; }

  function recipientCurrent() {
    const notices = arrayOf(state.data?.notifications);
    return notices.find((item) => recipientOfferId(item) === state.selectedOfferId) || notices[0];
  }

  function recipientReservation(item) {
    if (item.reservation) return item.reservation;
    return state.reservation?.offer_id === recipientOfferId(item) ? state.reservation : null;
  }

  function recipientStage(item) {
    const status = item.offer?.status;
    const response = item.response || "pending";
    if (response === "won" && status === "completed") return "done";
    if (response === "won" || (status === "confirmed" && recipientReservation(item)?.status === "confirmed")) return "confirmed";
    if (response === "holding" && recipientReservation(item)) return "holding";
    if (response === "pending" && status === "notified") return "offer";
    if (response === "pending" && status === "reserved") return "waiting";
    return "closed";
  }

  function drawRecipient() {
    const notices = arrayOf(state.data.notifications);
    const current = recipientCurrent();
    const stage = current ? recipientStage(current) : "empty";
    const reservation = current ? recipientReservation(current) : null;
    // Polling redraws every few seconds; only rebuild when something visible
    // changed, so a half-typed reply, open editor, or note is never wiped.
    const signature = JSON.stringify([notices.map((item) => [recipientOfferId(item), item.response, item.offer?.status]), state.selectedOfferId, stage, reservation?.reservation_id, reservation?.status, Boolean(current?.offer?.donor_location)]);
    if (signature === state.recipientView && workspace.querySelector(".recipient-inbox")) return;
    const stageKey = `${state.selectedOfferId}:${stage}`;
    const moved = Boolean(state.recipientStage) && state.recipientStage !== stageKey;
    state.recipientView = signature;
    state.recipientStage = stageKey;
    if (stage === "holding" && (!state.handoff || state.handoff.reservationId !== reservation.reservation_id)) state.handoff = recipientFreshReply(current, reservation);
    const name = state.data.recipient?.name;
    workspace.innerHTML = `<div class="recipient-inbox">
      ${name ? `<p class="recipient-hello">For ${e(name)}</p>` : ""}
      ${notices.length > 1 ? recipientList(notices) : ""}
      ${current ? recipientCard(current, stage) : `<article class="recipient-card">${emptyState("No offers right now", "When food that fits your pantry comes up, it shows here.")}</article>`}
    </div>`;
    workspace.querySelectorAll("[data-pick-offer]").forEach((button) => button.addEventListener("click", () => {
      state.selectedOfferId = button.dataset.pickOffer;
      drawRecipient();
    }));
    if (current) bindRecipientActions(current, stage);
    hydrateMaps();
    if (moved) workspace.querySelector("#recipient-heading")?.focus();
  }

  function recipientList(notices) {
    const tags = { offer: "New", waiting: "Held by another pantry", holding: "Held for you", confirmed: "Confirmed", done: "Picked up", closed: "Closed" };
    return `<nav class="recipient-list" aria-label="Your offers">${notices.map((item) => {
      const id = recipientOfferId(item);
      const active = id === state.selectedOfferId;
      return `<button type="button" class="recipient-list-item${active ? " active" : ""}" data-pick-offer="${e(id)}" aria-pressed="${active}"><span>${e(recipientHeadline(item))}</span><small>${e(tags[recipientStage(item)])} · gone by ${e(recipientClock(item.offer?.deadline || item.deadline))}</small></button>`;
    }).join("")}</nav>`;
  }

  function recipientCard(item, stage) {
    const offer = item.offer || {};
    const mapTitle = offer.donor_location ? "Pickup spot" : "Exact pickup spot shared once you say yes";
    const map = ["done", "closed", "waiting"].includes(stage) ? "" : `<div class="recipient-map">${workflowMap(offer.map, mapTitle)}</div>`;
    const body = { offer: recipientOfferStep, holding: recipientHoldStep, confirmed: recipientConfirmedStep, done: recipientDoneStep }[stage] || recipientClosedStep;
    return `<article class="recipient-card" data-stage="${e(stage)}" aria-labelledby="recipient-heading"><div class="recipient-main">${body(item)}</div>${map}</article>`;
  }

  function recipientOfferStep(item) {
    const offer = item.offer || {};
    const needs = recipientNeeds(offer);
    return `<h1 id="recipient-heading" tabindex="-1">${e(recipientHeadline(item))}</h1>
      <p class="recipient-meta">${e(recipientMeta(offer))}</p>
      ${needs ? `<p class="recipient-needs">${e(needs)}</p>` : ""}
      <div class="recipient-actions">
        <button class="button primary recipient-primary" data-action="claim" type="button">Yes, we'll take it</button>
        <button class="button quiet" data-action="decline-open" type="button" aria-expanded="false" aria-controls="decline-reasons">Not this time</button>
      </div>
      <p class="recipient-fine">We'll hold it for you for 10 minutes while you sort out pickup.</p>
      <fieldset id="decline-reasons" class="recipient-decline question" hidden><legend>What's in the way? (optional)</legend><div class="option-row">${RECIPIENT_DECLINE_REASONS.map((reason) => `<button type="button" class="option" data-decline="${e(reason)}">${e(reason)}</button>`).join("")}<button type="button" class="option other" data-decline="">Just pass</button></div></fieldset>`;
  }

  function recipientHoldStep(item) {
    const offer = item.offer || {};
    const reservation = recipientReservation(item);
    const id = reservation?.reservation_id || reservation?.id || "";
    return `<h1 id="recipient-heading" class="recipient-heading-small" tabindex="-1">${e(recipientHeadline(item))}</h1>
      <p class="recipient-meta">${e(recipientMeta(offer))}</p>
      ${reservation?.expires_at ? `<div class="recipient-timer"><span class="recipient-timer-digits" role="timer" aria-label="Time left to confirm" data-recipient-expires="${e(reservation.expires_at)}">10:00</span><span class="recipient-timer-label">It's held for you. Confirm before the timer runs out.</span><span id="recipient-timer-announce" class="visually-hidden" aria-live="polite"></span></div>` : ""}
      <div class="recipient-reply">
        <label for="handoff-text">Who's picking it up, when, and a phone number?</label>
        <textarea id="handoff-text" rows="2" placeholder="Maria, around 6:30, 404-555-0182" autocomplete="off"></textarea>
        <p id="handoff-parse" class="parse-state" role="status" aria-live="polite"></p>
      </div>
      <div id="handoff-result" class="recipient-chips"></div>
      <div class="recipient-confirm">
        <p class="recipient-ready"><span aria-hidden="true">✓</span> ${e(recipientReady(offer))}</p>
        <button class="button primary recipient-primary" id="confirm-pickup" type="button" data-reservation-id="${e(id)}" aria-describedby="confirm-hint">Confirm pickup</button>
        <p id="confirm-hint" class="recipient-fine">${id ? "" : "Refresh the page before confirming."}</p>
      </div>`;
  }

  function recipientConfirmedStep(item) {
    const offer = item.offer || {};
    const details = recipientReservation(item)?.confirmation_details || {};
    const place = offer.donor_location;
    const hasPoint = place && Number.isFinite(Number(place.latitude)) && Number.isFinite(Number(place.longitude));
    const directions = hasPoint ? `https://www.google.com/maps/dir/?api=1&destination=${Number(place.latitude)},${Number(place.longitude)}` : "";
    const contact = [details.contact_name, details.contact_phone].filter(Boolean).join(" · ");
    return `<p class="recipient-badge"><span aria-hidden="true">✓</span> Pickup confirmed</p>
      <h1 id="recipient-heading" tabindex="-1">${details.expected_handoff_time ? `Pick up at ${e(recipientClock(details.expected_handoff_time))}` : "You're picking this up"}</h1>
      <p class="recipient-meta">${e(recipientHeadline(item))}${contact ? ` · ${e(contact)}` : ""}</p>
      <div class="recipient-where">
        <div><small>Pickup address</small><strong>${e(locationLabel(place) || "Shared with you once confirmed")}</strong></div>
        ${directions ? `<a class="button secondary" href="${e(directions)}" target="_blank" rel="noopener noreferrer">Directions <span aria-hidden="true">↗</span></a>` : ""}
      </div>
      <form id="complete-form" class="recipient-complete" data-offer-id="${e(recipientOfferId(item))}">
        <details class="recipient-note"><summary>Add a note</summary>
          <div class="recipient-note-fields"><label for="actual-quantity">How much did you get? (pallets, optional)</label><input id="actual-quantity" name="actual_quantity_pallets" type="number" min="0.1" step="0.1" inputmode="decimal" placeholder="${e(formatNumber(offer.quantity_pallets))}" />
          <label for="completion-note">Note (optional)</label><input id="completion-note" name="note" maxlength="1000" placeholder="e.g. 2 crates were damaged" /></div>
        </details>
        <button class="button primary recipient-primary" type="submit">Picked up ✓</button>
      </form>`;
  }

  function recipientDoneStep(item) {
    return `<p class="recipient-badge"><span aria-hidden="true">✓</span> Picked up</p>
      <h1 id="recipient-heading" tabindex="-1">Thank you. That food has a home.</h1>
      <p class="recipient-meta">${e(recipientHeadline(item))}</p>`;
  }

  function recipientClosedStep(item) {
    const response = item.response || "pending";
    const [heading, copy] = recipientStage(item) === "waiting"
      ? ["Another pantry is holding this right now.", "If they let it go, it comes back here."]
      : ({
        declined: ["You passed on this one.", "No problem. We'll keep sending offers that fit."],
        hold_expired: ["The hold ran out.", "It was offered to the next pantry."],
        invalidated: ["Another pantry is picking this one up.", "Thanks for being ready."],
      })[response] || ["This offer has closed.", "We'll let you know when the next one fits."];
    return `<h1 id="recipient-heading" class="recipient-heading-small" tabindex="-1">${e(heading)}</h1>
      <p class="recipient-meta">${e(recipientHeadline(item))}</p>
      <p class="recipient-fine">${e(copy)}</p>`;
  }

  function recipientHeadline(item) {
    const offer = item.offer || {};
    let food = String(offer.description || item.title || "Food rescue offer").trim().split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, "");
    const amount = offer.quantity_original || (offer.quantity_pallets == null ? "" : pallets(offer.quantity_pallets));
    if (amount && !food.toLowerCase().includes(String(amount).toLowerCase())) food = `${amount} · ${food}`;
    return food.charAt(0).toUpperCase() + food.slice(1);
  }

  function recipientMeta(offer) {
    return [offer.distance_miles == null ? "" : `${formatNumber(offer.distance_miles)} mi away`, offer.deadline ? `gone by ${recipientClock(offer.deadline)}` : ""].filter(Boolean).join(" · ");
  }

  function recipientNeeds(offer) {
    const storage = { refrigerated: "cold storage", frozen: "freezer space" }[offer.storage_state];
    const transport = { recipient_pickup: "your own transport", transportation_needed: "a driver" }[offer.transport_mode];
    const delivered = offer.transport_mode === "donor_delivery" ? " The donor delivers." : "";
    if (storage && transport) return `Needs ${storage} and ${transport}.`;
    if (storage || transport) return `Needs ${storage || transport}.${delivered}`;
    return delivered.trim();
  }

  function recipientReady(offer) {
    const storage = { refrigerated: "cold storage", frozen: "freezer space" }[offer.storage_state] || "room for it";
    const transport = offer.transport_mode === "donor_delivery" ? "someone to receive it" : "transport";
    return `We have ${storage} and ${transport} ready.`;
  }

  function recipientClock(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return "—";
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(date).map((part) => [part.type, part.value]));
    const time = `${parts.hour}${parts.minute === "00" ? "" : `:${parts.minute}`} ${String(parts.dayPeriod || "").toLowerCase()}`.trim();
    const today = new Date();
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    if (date.toDateString() === today.toDateString()) return time;
    if (date.toDateString() === tomorrow.toDateString()) return `${time} tomorrow`;
    return `${time} ${new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date)}`;
  }

  function readRecipientContact() {
    try {
      const saved = JSON.parse(localStorage.getItem(RECIPIENT_CONTACT_KEY)) || {};
      return { contact_name: typeof saved.contact_name === "string" ? saved.contact_name : "", contact_phone: typeof saved.contact_phone === "string" ? saved.contact_phone : "" };
    } catch (_err) { return { contact_name: "", contact_phone: "" }; }
  }

  function recipientFreshReply(item, reservation) {
    const saved = readRecipientContact();
    const draft = { contact_name: saved.contact_name || null, contact_phone: saved.contact_phone || null, expected_handoff_time: null };
    return {
      reservationId: reservation.reservation_id,
      offerId: recipientOfferId(item),
      deadline: item.offer?.deadline || item.deadline || "",
      text: "",
      draft,
      confidence: {},
      saved: new Set(RECIPIENT_FIELDS.filter((field) => hasValue(draft[field]))),
      edited: new Set(),
      answered: new Set(),
      questions: [],
      editing: "",
      seq: 0,
      parsed: false,
    };
  }

  function bindRecipientActions(current, stage) {
    const offerId = recipientOfferId(current);
    const claim = workspace.querySelector("[data-action=claim]");
    claim?.addEventListener("click", async () => {
      const result = await mutateButton(claim, `/api/offers/${encodeURIComponent(offerId)}/claim`, {}, (held) => {
        state.reservation = held.reservation;
        loadRecipient();
      });
      if (!result) loadRecipient();
    });
    const declineOpen = workspace.querySelector("[data-action=decline-open]");
    declineOpen?.addEventListener("click", () => {
      const reasons = workspace.querySelector("#decline-reasons");
      reasons.hidden = !reasons.hidden;
      declineOpen.setAttribute("aria-expanded", String(!reasons.hidden));
      if (!reasons.hidden) reasons.querySelector(".option")?.focus();
    });
    workspace.querySelectorAll("[data-decline]").forEach((button) => button.addEventListener("click", () => {
      workspace.querySelectorAll("[data-decline]").forEach((other) => { if (other !== button) other.disabled = true; });
      mutateButton(button, `/api/offers/${encodeURIComponent(offerId)}/decline`, { reason: button.dataset.decline }, () => {
        showToast("Got it. We'll offer it to the next pantry.");
        loadRecipient();
      }).finally(() => workspace.querySelectorAll("[data-decline]").forEach((other) => { other.disabled = false; }));
    }));
    if (stage === "holding") bindRecipientReply();
    workspace.querySelector("#complete-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const quantity = String(data.get("actual_quantity_pallets") || "").trim();
      const payload = { note: String(data.get("note") || "").trim() };
      if (quantity !== "") payload.actual_quantity_pallets = Number(quantity);
      mutateButton(form.querySelector("[type=submit]"), `/api/offers/${encodeURIComponent(form.dataset.offerId)}/complete`, payload, () => { showToast("Marked as picked up. Thank you!"); loadRecipient(); });
    });
  }

  function bindRecipientReply() {
    const reply = state.handoff;
    const input = workspace.querySelector("#handoff-text");
    input.value = reply.text;
    input.addEventListener("input", () => {
      window.clearTimeout(state.parseTimer);
      state.parseTimer = window.setTimeout(recipientParse, 900);
    });
    input.addEventListener("blur", () => recipientParse());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); recipientParse(); }
    });
    const panel = workspace.querySelector("#handoff-result");
    panel.addEventListener("click", onRecipientReplyClick);
    panel.addEventListener("submit", onRecipientReplySubmit);
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.handoff.editing) { state.handoff.editing = ""; recipientRenderReply(); }
    });
    workspace.querySelector("#confirm-pickup").addEventListener("click", recipientConfirm);
    if (reply.saved.size && !reply.parsed) recipientParseState("Saved from last time. Add when you'll arrive, or type to change anything.", "done");
    recipientRenderReply();
    recipientCountdown();
  }

  async function recipientParse() {
    window.clearTimeout(state.parseTimer);
    const input = workspace.querySelector("#handoff-text");
    const reply = state.handoff;
    if (!input || !reply) return;
    const text = input.value.trim();
    if (text.length < 3 || text === reply.text) return;
    const seq = ++reply.seq;
    reply.text = text;
    recipientParseState("Reading…", "busy");
    try {
      const result = await api("/api/intake/handoff", { method: "POST", body: { text, offer_id: reply.offerId } });
      if (seq !== reply.seq || state.handoff !== reply) return;
      RECIPIENT_FIELDS.forEach((field) => {
        // Never overwrite what the pantry typed or tapped; re-reads fill the rest.
        const value = result.draft?.[field];
        if (reply.edited.has(field) || reply.answered.has(field) || !hasValue(value)) return;
        reply.draft[field] = value;
        reply.confidence[field] = result.confidence?.[field] || "high";
        reply.saved.delete(field);
      });
      reply.questions = arrayOf(result.questions);
      reply.parsed = true;
      recipientParseState(result.provider === "gemini" ? "Filled in by Gemini. Tap anything to change it." : "Filled in. Tap anything to change it.", "done");
      recipientRenderReply();
    } catch (err) {
      if (isAuthError(err)) return recoverMissingContext("recipient");
      if (seq === reply.seq && state.handoff === reply) recipientParseState(`${errorMessage(err)} You can fill in the details below yourself.`, "error");
      recipientRenderReply();
    }
  }

  function recipientParseState(message, tone = "") {
    const status = workspace.querySelector("#handoff-parse");
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function recipientTimeProblem(value) {
    const time = new Date(value).getTime();
    const deadline = new Date(state.handoff.deadline).getTime();
    if (!Number.isFinite(time)) return "When will you get there?";
    if (time <= Date.now()) return `${recipientClock(value)} has already passed. When will you get there?`;
    if (Number.isFinite(deadline) && time > deadline) return `${recipientClock(value)} is after the food has to be gone (${recipientClock(state.handoff.deadline)}). When can you get there?`;
    return "";
  }

  function recipientNeedsAnswer(field) {
    const reply = state.handoff;
    if (reply.editing === field) return false;
    const value = reply.draft[field];
    if (!hasValue(value)) return true;
    if (field === "expected_handoff_time" && recipientTimeProblem(value)) return true;
    if (field === "contact_phone" && String(value).replace(/\D/g, "").length < 7) return true;
    return reply.confidence[field] === "low" && !reply.edited.has(field) && !reply.answered.has(field);
  }

  function recipientQuestionFor(field) {
    const reply = state.handoff;
    const value = reply.draft[field];
    const problem = field === "expected_handoff_time" && hasValue(value) ? recipientTimeProblem(value) : "";
    const server = reply.questions.find((question) => question.field === field);
    if (server && !problem) return server;
    if (field === "contact_name") return { field, prompt: "Who's picking it up?", kind: "text", options: [] };
    if (field === "contact_phone") return { field, prompt: hasValue(value) ? "That number looks short. What number can the donor call?" : "What number can the donor call?", kind: "text", options: [] };
    return { field, prompt: problem || "When will you get there?", kind: "choice", options: recipientTimeOptions(reply.deadline) };
  }

  function recipientTimeOptions(deadline) {
    const step = 5 * 60000;
    const end = new Date(deadline).getTime();
    const options = [[30, "In 30 min"], [60, "In 1 hour"], [120, "In 2 hours"]]
      .map(([minutes, label]) => ({ label, value: new Date(Math.ceil((Date.now() + minutes * 60000) / step) * step).toISOString() }))
      .filter((option) => !Number.isFinite(end) || new Date(option.value).getTime() <= end);
    const latest = Math.floor((end - 10 * 60000) / step) * step;
    const last = options.length ? new Date(options[options.length - 1].value).getTime() : Date.now();
    if (Number.isFinite(end) && latest > last + 20 * 60000) options.push({ label: `By ${recipientClock(latest)}`, value: new Date(latest).toISOString() });
    return options;
  }

  function recipientRenderReply() {
    const panel = workspace.querySelector("#handoff-result");
    const reply = state.handoff;
    if (!panel || !reply) return;
    const chips = RECIPIENT_FIELDS.filter((field) => hasValue(reply.draft[field]) || reply.editing === field).map(recipientChip).join("");
    // Until there is something to build on, the reply box is the only ask.
    const started = reply.parsed || RECIPIENT_FIELDS.some((field) => hasValue(reply.draft[field]));
    const questions = started ? RECIPIENT_FIELDS.filter(recipientNeedsAnswer).map((field) => recipientQuestion(recipientQuestionFor(field))).join("") : "";
    panel.innerHTML = `${chips ? `<div class="chip-row">${chips}</div>` : ""}${questions}`;
    panel.querySelector(".chip.editing [name=value]")?.focus();
    recipientUpdateConfirm();
  }

  function recipientChipText(field) {
    const value = state.handoff.draft[field];
    return field === "expected_handoff_time" ? recipientClock(value) : String(value);
  }

  function recipientChip(field) {
    const reply = state.handoff;
    const label = RECIPIENT_LABELS[field];
    if (reply.editing === field) {
      const value = reply.draft[field];
      const id = `handoff-edit-${field}`;
      const control = field === "expected_handoff_time"
        ? `<input id="${id}" name="value" type="datetime-local" required value="${e(localDateTimeValue(value))}" />`
        : `<input id="${id}" name="value" required ${field === "contact_phone" ? `type="tel" autocomplete="tel" inputmode="tel"` : `autocomplete="name"`} value="${e(value || "")}" />`;
      return `<form class="chip editing" data-field="${field}"><label for="${id}">${e(label)}</label>${control}<button class="chip-done" type="submit">Done</button></form>`;
    }
    const unsure = reply.confidence[field] === "low" && !reply.edited.has(field) && !reply.answered.has(field);
    const tag = unsure ? " · best guess" : reply.saved.has(field) ? " · saved" : "";
    return `<button type="button" class="chip${unsure ? " unsure" : ""}" data-edit="${field}" aria-label="${e(label)}: ${e(recipientChipText(field))}${unsure ? " (best guess)" : ""}. Change"><small>${e(label)}${e(tag)}</small><span>${e(recipientChipText(field))}</span></button>`;
  }

  function recipientQuestion(question) {
    const field = e(question.field);
    if (question.kind === "text") {
      const type = question.field === "contact_phone" ? `type="tel" autocomplete="tel" inputmode="tel"` : `autocomplete="name"`;
      return `<form class="question" data-question="${field}"><label for="hq-${field}">${e(question.prompt)}</label><div class="question-input"><input id="hq-${field}" name="value" required ${type} /><button class="button secondary" type="submit">OK</button></div></form>`;
    }
    const current = state.handoff.draft[question.field];
    const buttons = arrayOf(question.options).map((option) => `<button type="button" class="option${option.value === current ? " selected" : ""}" data-answer="${field}" data-value="${e(option.value)}">${e(option.label)}</button>`).join("");
    return `<fieldset class="question"><legend>${e(question.prompt)}</legend><div class="option-row">${buttons}<button type="button" class="option other" data-edit="${field}">Other time…</button></div></fieldset>`;
  }

  function onRecipientReplyClick(event) {
    const reply = state.handoff;
    const answer = event.target.closest("[data-answer]");
    if (answer) {
      reply.draft[answer.dataset.answer] = answer.dataset.value;
      reply.answered.add(answer.dataset.answer);
      reply.saved.delete(answer.dataset.answer);
      recipientRenderReply();
      return workspace.querySelector("#confirm-pickup:not(:disabled)")?.focus();
    }
    const edit = event.target.closest("[data-edit]");
    if (edit) {
      reply.editing = edit.dataset.edit;
      recipientRenderReply();
    }
  }

  function onRecipientReplySubmit(event) {
    event.preventDefault();
    const form = event.target;
    const field = form.dataset.field || form.dataset.question;
    const raw = String(new FormData(form).get("value") || "").trim();
    if (!field || !raw) return;
    const reply = state.handoff;
    reply.draft[field] = field === "expected_handoff_time" ? new Date(raw).toISOString() : raw;
    reply.edited.add(field);
    reply.saved.delete(field);
    reply.editing = "";
    recipientRenderReply();
  }

  function recipientMissing() {
    const reply = state.handoff;
    const words = { contact_name: "who's coming", contact_phone: "a phone number", expected_handoff_time: "a pickup time" };
    return RECIPIENT_FIELDS.filter((field) => {
      const value = reply.draft[field];
      if (!hasValue(value)) return true;
      if (field === "expected_handoff_time") return Boolean(recipientTimeProblem(value));
      if (field === "contact_phone") return String(value).replace(/\D/g, "").length < 7;
      return false;
    }).map((field) => words[field]);
  }

  function recipientUpdateConfirm() {
    const button = workspace.querySelector("#confirm-pickup");
    const hint = workspace.querySelector("#confirm-hint");
    if (!button || !hint || !button.dataset.reservationId) return;
    const missing = recipientMissing();
    const untouched = missing.length === RECIPIENT_FIELDS.length && !state.handoff.parsed;
    button.disabled = missing.length > 0;
    hint.textContent = untouched ? "" : missing.length ? `Still need ${missing.join(", ")}.` : "The donor gets your name, number, and time.";
  }

  async function recipientConfirm(event) {
    const button = event.currentTarget;
    const reply = state.handoff;
    if (recipientMissing().length) return recipientUpdateConfirm();
    const payload = {
      expected_handoff_time: new Date(reply.draft.expected_handoff_time).toISOString(),
      contact_name: String(reply.draft.contact_name).trim(),
      contact_phone: String(reply.draft.contact_phone).trim(),
    };
    const result = await mutateButton(button, `/api/reservations/${encodeURIComponent(button.dataset.reservationId)}/confirm`, payload, () => {
      try { localStorage.setItem(RECIPIENT_CONTACT_KEY, JSON.stringify({ contact_name: payload.contact_name, contact_phone: payload.contact_phone })); } catch (_err) { /* storage is optional */ }
      showToast("Pickup confirmed. The donor has your details.");
      loadRecipient();
    });
    if (!result) { recipientUpdateConfirm(); loadRecipient(); }
  }

  function recipientCountdown() {
    const element = workspace.querySelector("[data-recipient-expires]");
    if (!element) return;
    if (state.countdownTimer) window.clearInterval(state.countdownTimer);
    const announce = workspace.querySelector("#recipient-timer-announce");
    const box = element.closest(".recipient-timer");
    let lastMinute = null;
    const update = () => {
      if (!element.isConnected) {
        window.clearInterval(state.countdownTimer);
        state.countdownTimer = null;
        return;
      }
      const remaining = Math.max(0, new Date(element.dataset.recipientExpires).getTime() - Date.now());
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      element.textContent = `${minutes}:${String(seconds).padStart(2, "0")}`;
      box.classList.toggle("urgent", remaining < 2 * 60000);
      // Announce a few milestones rather than every second.
      if (lastMinute !== null && minutes !== lastMinute && [4, 1, 0].includes(minutes) && remaining > 0) announce.textContent = `${minutes + 1} minute${minutes ? "s" : ""} left to confirm.`;
      lastMinute = minutes;
      if (remaining === 0) {
        window.clearInterval(state.countdownTimer);
        state.countdownTimer = null;
        box.querySelector(".recipient-timer-label").textContent = "Time's up. Checking if it's still yours…";
        announce.textContent = "The hold ran out.";
        loadRecipient();
      }
    };
    update();
    state.countdownTimer = window.setInterval(update, 1000);
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
    hydrateMaps();
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
    if (role !== "recipient") {
      // A donor without a live status link simply starts a new offer.
      sessionStorage.removeItem(tokenKey("donor"));
      state.token = "";
      state.role = "donor";
      history.replaceState(null, "", `${location.pathname}?role=donor`);
      return renderDonorForm();
    }
    const donorAvailable = Boolean(sessionStorage.getItem(tokenKey("donor")));
    workspace.innerHTML = `<section class="panel context-panel"><h1>No offer to show yet.</h1><p>${donorAvailable ? "Open a food bank's inbox from your offer's Demo controls." : "Post an offer as a donor first; food banks are asked automatically."}</p><div class="button-row"><button id="open-donor-demo" class="button primary" type="button">${donorAvailable ? "Back to my offer" : "Post an offer"}</button></div></section>`;
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
