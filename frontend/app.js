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
    recipientLoadSeq: 0,
    recipientDrawnSeq: 0,
    recipientActed: 0,
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

  function statusPatch(root, region, html, afterSwap) {
    const element = root.querySelector(`[data-region="${region}"]`);
    if (!element || statusRegionHtml.get(element) === html) return false;
    statusRegionHtml.set(element, html);
    swapKeepingInput(element, html, afterSwap);
    return true;
  }

  // Replace a region's markup without taking anything away from the person
  // using it: typed text, ticked boxes, open <details>, focus and caret carry
  // over to the element with the same id in the new markup. `afterSwap` runs
  // before restoring, so parts it renders (e.g. an open chip editor) get their
  // typed text back too.
  function swapKeepingInput(element, html, afterSwap) {
    const kept = [...element.querySelectorAll("input[id], textarea[id], details[id]")].map((node) => {
      if (node.tagName === "DETAILS") return { id: node.id, open: node.open };
      if (node.type === "checkbox" || node.type === "radio") return node.checked === node.defaultChecked ? null : { id: node.id, checked: node.checked };
      return node.value === node.defaultValue ? null : { id: node.id, value: node.value };
    }).filter(Boolean);
    const active = document.activeElement;
    const focus = active && active.id && element.contains(active) ? { id: active.id, start: caret(active, "selectionStart"), end: caret(active, "selectionEnd") } : null;
    element.innerHTML = html;
    if (afterSwap) afterSwap();
    const find = (id) => element.querySelector(`#${CSS.escape(id)}`);
    kept.forEach((item) => {
      const node = find(item.id);
      if (!node) return;
      if ("open" in item) node.open = item.open;
      else if ("checked" in item) node.checked = item.checked;
      else node.value = item.value;
    });
    const target = focus && find(focus.id);
    if (target && (document.activeElement === document.body || !document.activeElement)) {
      target.focus({ preventScroll: true });
      if (focus.start != null) try { target.setSelectionRange(focus.start, focus.end); } catch (_err) { /* not a text field */ }
    }
  }

  function caret(node, key) {
    try { return node[key]; } catch (_err) { return null; }
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
    state.recipientStage = "";
    state.recipientDeclineOpen = false;
    workspace.innerHTML = loadingView("Loading your offers…");
    loadRecipient();
  }

  // Polls, post-action reloads, and the hold timer all call this, so several
  // reads can be in flight. A read may not draw if a newer read already drew,
  // or if an action succeeded after it was sent: that older answer would
  // briefly bring back the previous step (e.g. the "take it" button right
  // after taking it). Failed actions change nothing, so they never discard.
  function recipientStale(seq, acted) {
    return state.role !== "recipient" || seq < state.recipientDrawnSeq || acted !== state.recipientActed;
  }

  async function loadRecipient() {
    const seq = ++state.recipientLoadSeq;
    const acted = state.recipientActed;
    try {
      const data = await api("/api/recipients/notifications");
      if (recipientStale(seq, acted)) return;
      state.recipientDrawnSeq = seq;
      state.data = data;
      const notices = arrayOf(state.data.notifications);
      if (!notices.some((item) => recipientOfferId(item) === state.selectedOfferId)) state.selectedOfferId = notices[0] ? recipientOfferId(notices[0]) : "";
      drawRecipient();
      if (!notices.length || notices.some((item) => !TERMINAL.has(item.offer?.status || item.status))) startPolling(loadRecipient);
    } catch (err) {
      if (recipientStale(seq, acted)) return;
      if (isAuthError(err)) return recoverMissingContext("recipient");
      // A blip while the card is up: keep everything on screen and try again.
      if (workspace.querySelector(".recipient-inbox")) return startPolling(loadRecipient);
      renderLoadError("Could not load this recipient inbox", err, () => clearToken("recipient"));
    }
  }

  // Show what an action did right away (the server already said so), then
  // re-read the inbox. Without this the old button sat there, enabled, until
  // the reload came back, and a second tap failed with "no longer valid".
  function recipientApply(offerId, result) {
    state.recipientActed += 1;
    const item = arrayOf(state.data?.notifications).find((notice) => recipientOfferId(notice) === offerId);
    if (item && result) {
      const response = { reserved: "holding", confirmed: "won", completed: "won" }[result.status];
      if (result.response || response) item.response = result.response || response;
      if (result.status) item.offer = { ...item.offer, status: result.status };
      if (result.reservation) item.reservation = result.reservation;
      drawRecipient();
    }
    loadRecipient();
  }

  function recipientOfferId(item) { return item?.offer_id || item?.offer?.offer_id || ""; }

  function recipientCurrent() {
    const notices = arrayOf(state.data?.notifications);
    return notices.find((item) => recipientOfferId(item) === state.selectedOfferId) || notices[0];
  }

  function recipientReservation(item) {
    return item.reservation || null;
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
    const stageKey = `${state.selectedOfferId}:${stage}`;
    const moved = Boolean(state.recipientStage) && state.recipientStage !== stageKey;
    if (state.recipientStage !== stageKey) state.recipientDeclineOpen = false;
    state.recipientStage = stageKey;
    if (stage === "holding" && (!state.handoff || state.handoff.reservationId !== reservation.reservation_id)) state.handoff = recipientFreshReply(current, reservation);
    // Polling redraws every few seconds. The inbox is built once; after that
    // only regions whose markup changed are swapped, and the swap keeps typed
    // text, open editors/notes, and focus. An unchanged card is never touched,
    // so its countdown and in-progress reply keep running.
    let root = workspace.querySelector(".recipient-inbox");
    if (!root) {
      workspace.innerHTML = `<div class="recipient-inbox"><div data-region="hello"></div><div data-region="list"></div><div data-region="card"></div></div>`;
      root = workspace.querySelector(".recipient-inbox");
      root.addEventListener("click", (event) => {
        const pick = event.target.closest("[data-pick-offer]");
        if (!pick) return;
        state.selectedOfferId = pick.dataset.pickOffer;
        drawRecipient();
      });
    }
    const name = state.data.recipient?.name;
    statusPatch(root, "hello", name ? `<p class="recipient-hello">For ${e(name)}</p>` : "");
    statusPatch(root, "list", notices.length > 1 ? recipientList(notices) : "");
    const card = current ? recipientCard(current, stage) : `<article class="recipient-card">${emptyState("No offers right now", "When food that fits your pantry comes up, it shows here.")}</article>`;
    if (statusPatch(root, "card", card, () => { if (current) bindRecipientActions(current, stage); })) hydrateMaps();
    if (moved) root.querySelector("#recipient-heading")?.focus();
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
    return `<article class="recipient-card" data-stage="${e(stage)}" data-offer-id="${e(recipientOfferId(item))}" aria-labelledby="recipient-heading"><div class="recipient-main">${body(item)}</div>${map}</article>`;
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
        <details id="recipient-note" class="recipient-note"><summary>Add a note</summary>
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

  function recipientReplyKey(reservationId) { return `pantry-relay:handoff:${reservationId}`; }

  function recipientFreshReply(item, reservation) {
    const saved = readRecipientContact();
    const draft = { contact_name: saved.contact_name || null, contact_phone: saved.contact_phone || null, expected_handoff_time: null };
    const reply = {
      reservationId: reservation.reservation_id,
      offerId: recipientOfferId(item),
      deadline: item.offer?.deadline || item.deadline || "",
      input: "",
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
    // A reload during the hold brings back what was already typed and picked.
    const kept = readSessionJson(recipientReplyKey(reservation.reservation_id), null);
    if (kept && typeof kept === "object") {
      reply.input = typeof kept.input === "string" ? kept.input : "";
      reply.text = typeof kept.text === "string" ? kept.text : "";
      RECIPIENT_FIELDS.forEach((field) => { if (hasValue(kept.draft?.[field])) reply.draft[field] = String(kept.draft[field]); });
      reply.confidence = kept.confidence && typeof kept.confidence === "object" ? kept.confidence : {};
      ["saved", "edited", "answered"].forEach((key) => { reply[key] = new Set(arrayOf(kept[key]).filter((field) => RECIPIENT_FIELDS.includes(field))); });
      reply.questions = arrayOf(kept.questions);
      reply.parsed = Boolean(kept.parsed);
      reply.resumed = true;
    }
    return reply;
  }

  function recipientKeepReply() {
    const reply = state.handoff;
    if (!reply) return;
    const { input, text, draft, confidence, questions, parsed } = reply;
    try {
      sessionStorage.setItem(recipientReplyKey(reply.reservationId), JSON.stringify({ input, text, draft, confidence, questions, parsed, saved: [...reply.saved], edited: [...reply.edited], answered: [...reply.answered] }));
    } catch (_err) { /* storage is optional */ }
  }

  const RECIPIENT_ERRORS = {
    offer_currently_held: "Another pantry just put a hold on this. If they let it go, it comes back to you.",
    candidate_response_closed: "This offer isn't open to you any more.",
    candidate_not_eligible: "This offer has moved on to other pantries.",
    offer_not_claimable: "This offer just closed.",
    capacity_unavailable: "Your pantry's space is already promised to another offer.",
    reservation_expired: "The hold ran out before your confirmation arrived.",
    invalid_handoff_time: "That pickup time no longer works. Pick a time before the food has to be gone.",
  };

  // Turn workflow error codes into plain words, then re-read the inbox so the
  // card shows where things actually stand.
  function recipientActionFailed(offerId, err) {
    const code = err.detail?.code;
    if (isAuthError(err) && !RECIPIENT_ERRORS[code]) return recoverMissingContext("recipient");
    showToast(RECIPIENT_ERRORS[code] || errorMessage(err), code !== "offer_currently_held");
    // Lost the race: say so on the card now instead of leaving "take it" up.
    if (code === "offer_currently_held") return recipientApply(offerId, { status: "reserved", response: "pending" });
    loadRecipient();
  }

  function bindRecipientActions(current, stage) {
    const offerId = recipientOfferId(current);
    const claim = workspace.querySelector("[data-action=claim]");
    const declineOpen = workspace.querySelector("[data-action=decline-open]");
    claim?.addEventListener("click", async () => {
      if (declineOpen) declineOpen.disabled = true;
      await mutateButton(claim, `/api/offers/${encodeURIComponent(offerId)}/claim`, {}, (held) => recipientApply(offerId, held), (err) => recipientActionFailed(offerId, err));
      if (declineOpen?.isConnected) declineOpen.disabled = false;
    });
    const reasons = workspace.querySelector("#decline-reasons");
    if (reasons && declineOpen) {
      reasons.hidden = !state.recipientDeclineOpen;
      declineOpen.setAttribute("aria-expanded", String(state.recipientDeclineOpen));
    }
    declineOpen?.addEventListener("click", () => {
      state.recipientDeclineOpen = reasons.hidden;
      reasons.hidden = !state.recipientDeclineOpen;
      declineOpen.setAttribute("aria-expanded", String(state.recipientDeclineOpen));
      if (state.recipientDeclineOpen) reasons.querySelector(".option")?.focus();
    });
    workspace.querySelectorAll("[data-decline]").forEach((button) => button.addEventListener("click", () => {
      workspace.querySelectorAll("[data-decline], [data-action=claim]").forEach((other) => { if (other !== button) other.disabled = true; });
      mutateButton(button, `/api/offers/${encodeURIComponent(offerId)}/decline`, { reason: button.dataset.decline }, (result) => {
        showToast("Got it. We'll offer it to the next pantry.");
        recipientApply(offerId, { ...result, response: "declined" });
      }, (err) => recipientActionFailed(offerId, err)).finally(() => workspace.querySelectorAll("[data-decline], [data-action=claim]").forEach((other) => { other.disabled = false; }));
    }));
    if (stage === "holding") bindRecipientReply();
    workspace.querySelector("#complete-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const quantity = String(data.get("actual_quantity_pallets") || "").trim();
      const payload = { note: String(data.get("note") || "").trim() };
      if (quantity !== "") payload.actual_quantity_pallets = Number(quantity);
      mutateButton(form.querySelector("[type=submit]"), `/api/offers/${encodeURIComponent(form.dataset.offerId)}/complete`, payload, (result) => { showToast("Marked as picked up. Thank you!"); recipientApply(form.dataset.offerId, result); }, (err) => recipientActionFailed(form.dataset.offerId, err));
    });
  }

  function bindRecipientReply() {
    const reply = state.handoff;
    const input = workspace.querySelector("#handoff-text");
    if (input.value !== reply.input) input.value = reply.input;
    input.addEventListener("input", () => {
      reply.input = input.value;
      recipientKeepReply();
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
      if (event.key === "Escape" && state.handoff.editing) recipientCloseEditor();
    });
    workspace.querySelector("#confirm-pickup").addEventListener("click", recipientConfirm);
    if (reply.saved.size && !reply.parsed) recipientParseState("Saved from last time. Add when you'll arrive, or type to change anything.", "done");
    recipientRenderReply();
    recipientCountdown();
    // Typed before a reload but never read: read it now.
    if (reply.resumed) {
      reply.resumed = false;
      if (reply.input.trim() && reply.input.trim() !== reply.text) recipientParse();
    }
  }

  function recipientCloseEditor() {
    const field = state.handoff.editing;
    state.handoff.editing = "";
    recipientRenderReply();
    workspace.querySelector(`#handoff-result [data-edit="${field}"]`)?.focus();
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
    // A reading can land while someone is typing in a chip editor or a
    // question; keep what they typed and where their cursor is.
    swapKeepingInput(panel, `${chips ? `<div class="chip-row">${chips}</div>` : ""}${questions}`);
    recipientKeepReply();
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
      const editor = workspace.querySelector("#handoff-result .chip.editing [name=value]");
      editor?.focus();
      if (editor?.type !== "datetime-local") editor?.setSelectionRange(editor.value.length, editor.value.length);
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
    if (form.dataset.field) return recipientCloseEditor();
    recipientRenderReply();
    workspace.querySelector("#confirm-pickup:not(:disabled)")?.focus();
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
    await mutateButton(button, `/api/reservations/${encodeURIComponent(button.dataset.reservationId)}/confirm`, payload, (result) => {
      try {
        localStorage.setItem(RECIPIENT_CONTACT_KEY, JSON.stringify({ contact_name: payload.contact_name, contact_phone: payload.contact_phone }));
        sessionStorage.removeItem(recipientReplyKey(reply.reservationId));
      } catch (_err) { /* storage is optional */ }
      showToast("Pickup confirmed. The donor has your details.");
      recipientApply(reply.offerId, result);
    }, (err) => recipientActionFailed(reply.offerId, err));
    if (button.isConnected) recipientUpdateConfirm();
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

  async function mutateButton(button, path, body, onSuccess, onError) {
    setBusy(button, true, "Working…");
    try {
      const result = await api(path, { method: "POST", body, mutation: true });
      onSuccess(result);
      return result;
    } catch (err) {
      if (onError) onError(err);
      else showToast(errorMessage(err), true);
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
