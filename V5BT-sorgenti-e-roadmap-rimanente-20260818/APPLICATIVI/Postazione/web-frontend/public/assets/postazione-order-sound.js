(function () {
  if (window.__postazioneOrderSoundInitialized) {
    return;
  }

  window.__postazioneOrderSoundInitialized = true;

  const ORDERS_ENDPOINT = "/api/integration/orders";
  const FETCH_TIMEOUT_MS = 6000;
  const POLL_MS = 3500;
  const COOLDOWN_MS = 2500;
  const AUTH_STORAGE_KEY = "BAR_OPERATOR_AUTH_V1";
  const OPERATOR_STORAGE_KEY = "BAR_OPERATOR_SESSION_V1";
  const SESSION_ACTIVE_EVENT = "postazione:session-active";
  const SESSION_CLEARED_EVENT = "postazione:session-cleared";
  const state = {
    station: "",
    knownOrderIds: new Set(),
    bootstrapped: false,
    loading: false,
    audioContext: null,
    pendingTone: false,
    lastPlayedAt: 0,
    sessionInvalidated: false,
    sessionGeneration: 0,
  };

  function readJsonStorage(storage, key) {
    try {
      return JSON.parse(storage.getItem(key) || "{}") || {};
    } catch {
      return {};
    }
  }

  function hasStoredAuthenticatedSession() {
    const auth =
      readJsonStorage(window.sessionStorage, AUTH_STORAGE_KEY) ||
      readJsonStorage(window.localStorage, AUTH_STORAGE_KEY);
    const localAuth = Object.keys(auth).length > 0
      ? auth
      : readJsonStorage(window.localStorage, AUTH_STORAGE_KEY);
    const operator =
      readJsonStorage(window.sessionStorage, OPERATOR_STORAGE_KEY) ||
      readJsonStorage(window.localStorage, OPERATOR_STORAGE_KEY);
    const localOperator = Object.keys(operator).length > 0
      ? operator
      : readJsonStorage(window.localStorage, OPERATOR_STORAGE_KEY);
    const token = String(localAuth.token || "").trim();
    const identity = String(localAuth.userId || localAuth.username || "").trim();
    return token.length > 0 && identity.length > 0 && localOperator.loggedIn === true;
  }

  function hasAuthenticatedSession() {
    return !state.sessionInvalidated && hasStoredAuthenticatedSession();
  }

  function authenticatedHeaders() {
    const sessionAuth = readJsonStorage(window.sessionStorage, AUTH_STORAGE_KEY);
    const localAuth = readJsonStorage(window.localStorage, AUTH_STORAGE_KEY);
    const auth = Object.keys(sessionAuth).length > 0 ? sessionAuth : localAuth;
    const headers = { "X-Client-App": "postazione" };
    const token = String(auth.token || "").trim();
    const userId = String(auth.userId || "").trim();
    const deviceUuid = String(auth.deviceUuid || localAuth.deviceUuid || "").trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (userId) headers["X-User-Id"] = userId;
    if (deviceUuid) headers["X-Device-Uuid"] = deviceUuid;
    return headers;
  }

  function clearSessionAudio() {
    state.sessionInvalidated = true;
    state.sessionGeneration += 1;
    state.station = "";
    state.knownOrderIds.clear();
    state.bootstrapped = false;
    state.loading = false;
    state.pendingTone = false;
    state.lastPlayedAt = 0;
    const audioContext = state.audioContext;
    state.audioContext = null;
    if (audioContext && typeof audioContext.close === "function") {
      try {
        const closing = audioContext.close();
        if (closing && typeof closing.catch === "function") closing.catch(() => {});
      } catch {
        // noop
      }
    }
  }

  function activateSessionAudio() {
    state.sessionInvalidated = false;
    state.sessionGeneration += 1;
    state.station = "";
    state.knownOrderIds.clear();
    state.bootstrapped = false;
    state.loading = false;
    state.pendingTone = false;
    void refreshOrders();
  }

  function normalizeStationName(value) {
    const station = String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!station) return "";
    const placeholder = station.toLowerCase();
    if (placeholder === "undefined" || placeholder === "null" || placeholder === "nan") return "";
    const key = station.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (["bar", "barprincipale", "bar1", "caffetteria"].includes(key)) return "BAR-1";
    if (key === "bar2") return "BAR-2";
    return station.toUpperCase();
  }

  function rememberStationName(value) {
    const station = normalizeStationName(value);
    if (!station) return;
    try {
      window.sessionStorage.setItem("postazione:lastStation", station);
    } catch {
      // noop
    }
  }

  function readRememberedStationName() {
    try {
      return normalizeStationName(window.sessionStorage.getItem("postazione:lastStation"));
    } catch {
      return "";
    }
  }

  function readStationLabel(node) {
    if (!node) return "";
    if (node instanceof HTMLSelectElement) {
      return normalizeStationName(node.value);
    }
    const textNode = Array.from(node.childNodes).find((child) => child.nodeType === Node.TEXT_NODE);
    const rawValue = textNode ? textNode.textContent : node.textContent;
    return normalizeStationName(rawValue);
  }

  function getCurrentStationName() {
    const selectors = [
      ".station-selector .ss-value",
      ".station-grid .station-tile.selected .tile-name",
      ".modal-station .modal-select",
      ".station-row .station-name",
      ".topbar .station",
    ];
    for (const selector of selectors) {
      const station = readStationLabel(document.querySelector(selector));
      if (station) {
        rememberStationName(station);
        return station;
      }
    }
    const rememberedStation = readRememberedStationName();
    if (rememberedStation) return rememberedStation;
    return "";
  }

  function getAudioContext(allowCreate = false) {
    if (state.audioContext) return state.audioContext;
    if (!allowCreate) return null;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioCtor !== "function") {
      return null;
    }
    try {
      state.audioContext = new AudioCtor();
    } catch {
      state.audioContext = null;
    }
    return state.audioContext;
  }

  function scheduleTone(oscillator, gainNode, startAt, duration, peakGain) {
    gainNode.gain.setValueAtTime(0.0001, startAt);
    gainNode.gain.exponentialRampToValueAtTime(peakGain, startAt + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.04);
  }

  function playArrivalTone() {
    if (!hasAuthenticatedSession()) {
      clearSessionAudio();
      return;
    }
    const now = Date.now();
    if (now - state.lastPlayedAt < COOLDOWN_MS) {
      return;
    }
    const audioContext = getAudioContext(false);
    if (!audioContext || audioContext.state !== "running") {
      state.pendingTone = true;
      return;
    }

    const frequencies = [880, 1174, 1568];
    const startAt = audioContext.currentTime + 0.04;

    frequencies.forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      oscillator.type = index === frequencies.length - 1 ? "triangle" : "sine";
      oscillator.frequency.setValueAtTime(frequency, startAt);
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      scheduleTone(oscillator, gainNode, startAt + index * 0.18, 0.12 + (index === frequencies.length - 1 ? 0.08 : 0), 0.07);
    });

    state.pendingTone = false;
    state.lastPlayedAt = now;
  }

  async function unlockAudio() {
    if (!hasAuthenticatedSession()) {
      clearSessionAudio();
      return false;
    }
    const audioContext = getAudioContext(true);
    if (!audioContext) return false;
    try {
      if (audioContext.state !== "running") {
        await audioContext.resume();
      }
    } catch {
      return false;
    }
    if (audioContext.state === "running" && state.pendingTone) {
      playArrivalTone();
    }
    return audioContext.state === "running";
  }

  async function fetchJson(url) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeoutId =
      controller !== null
        ? window.setTimeout(() => {
            controller.abort();
          }, FETCH_TIMEOUT_MS)
        : 0;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: authenticatedHeaders(),
        credentials: "same-origin",
        cache: "no-store",
        signal: controller ? controller.signal : undefined,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.ok !== true) {
        throw new Error((payload && (payload.error || payload.message)) || `Errore ${response.status}`);
      }
      return payload;
    } finally {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    }
  }

  function normalizeOrderId(order) {
    return String(order && order.id ? order.id : "").trim();
  }

  function updateKnownOrders(station, orders) {
    state.station = station;
    state.knownOrderIds = new Set(
      (Array.isArray(orders) ? orders : []).map((order) => normalizeOrderId(order)).filter(Boolean)
    );
    state.bootstrapped = true;
  }

  function handleOrders(station, orders) {
    if (!hasAuthenticatedSession()) return;
    const normalizedStation = normalizeStationName(station);
    if (!state.bootstrapped || normalizedStation !== state.station) {
      updateKnownOrders(normalizedStation, orders);
      return;
    }

    const nextOrderIds = new Set();
    let hasNewOrder = false;

    (Array.isArray(orders) ? orders : []).forEach((order) => {
      const orderId = normalizeOrderId(order);
      if (!orderId) return;
      nextOrderIds.add(orderId);
      if (!state.knownOrderIds.has(orderId)) {
        hasNewOrder = true;
      }
    });

    state.station = normalizedStation;
    state.knownOrderIds = nextOrderIds;

    if (hasNewOrder) {
      playArrivalTone();
    }
  }

  async function refreshOrders() {
    if (state.loading) return;
    if (!hasAuthenticatedSession()) {
      clearSessionAudio();
      return;
    }
    const station = getCurrentStationName();
    if (!station) return;

    const sessionGeneration = state.sessionGeneration;
    state.loading = true;
    try {
      const payload = await fetchJson(
        `${ORDERS_ENDPOINT}?station=${encodeURIComponent(station)}&includeDone=0&_=${Date.now()}`
      );
      if (
        sessionGeneration !== state.sessionGeneration ||
        !hasAuthenticatedSession()
      ) return;
      handleOrders(station, Array.isArray(payload.orders) ? payload.orders : []);
    } catch {
      // noop
    } finally {
      if (sessionGeneration === state.sessionGeneration) state.loading = false;
    }
  }

  function start() {
    state.sessionInvalidated = !hasStoredAuthenticatedSession();
    window.addEventListener(SESSION_CLEARED_EVENT, clearSessionAudio);
    window.addEventListener(SESSION_ACTIVE_EVENT, activateSessionAudio);
    document.addEventListener(
      "pointerdown",
      () => {
        void unlockAudio();
      },
      true
    );
    document.addEventListener(
      "keydown",
      () => {
        void unlockAudio();
      },
      true
    );
    window.addEventListener("focus", () => {
      void unlockAudio();
      void refreshOrders();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        void unlockAudio();
        void refreshOrders();
      }
    });

    void refreshOrders();
    window.setInterval(() => {
      if (document.hidden) return;
      void refreshOrders();
    }, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
