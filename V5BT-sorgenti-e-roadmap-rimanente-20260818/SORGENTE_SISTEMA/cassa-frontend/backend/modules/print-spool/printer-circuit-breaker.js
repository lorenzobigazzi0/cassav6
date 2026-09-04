// Step 6 — circuit breaker per stampante. Isola una stampante che va in errore
// ripetuto così che i suoi timeout non rallentino la coda (e quindi gli ordini):
// dopo `failureThreshold` fallimenti consecutivi il circuito si apre per
// `cooldownMs`; scaduto il cooldown passa a `half_open` (un solo probe); un
// successo lo richiude, un fallimento lo riapre.

const CLOSED = "closed";
const OPEN = "open";
const HALF_OPEN = "half_open";

function normalizeKey(printerId) {
  const normalized = String(printerId ?? "").trim();
  return normalized || "__default__";
}

export function createPrinterCircuitBreaker(options = {}) {
  const enabled = options.enabled !== false;
  const failureThreshold = Math.max(1, Math.trunc(Number(options.failureThreshold) || 3));
  const cooldownMs = Math.max(0, Math.trunc(Number(options.cooldownMs) || 15_000));
  const halfOpenMax = Math.max(1, Math.trunc(Number(options.halfOpenMax) || 1));
  const nowMs = typeof options.nowMs === "function" ? options.nowMs : () => Date.now();
  const metrics = options.metrics && typeof options.metrics === "object" ? options.metrics : null;

  // key -> { state, failures, openedAtMs, halfOpenInFlight }
  const circuits = new Map();

  function circuit(key) {
    let entry = circuits.get(key);
    if (!entry) {
      entry = { state: CLOSED, failures: 0, openedAtMs: 0, halfOpenInFlight: 0 };
      circuits.set(key, entry);
    }
    return entry;
  }

  function refreshOpenGauge() {
    if (!metrics || typeof metrics.setGauge !== "function") return;
    let open = 0;
    for (const entry of circuits.values()) {
      if (entry.state === OPEN || entry.state === HALF_OPEN) open += 1;
    }
    metrics.setGauge("printerCircuitOpen", open);
  }

  // Fa evolvere lo stato in base al tempo (open → half_open dopo il cooldown).
  function tick(entry) {
    if (entry.state === OPEN && nowMs() - entry.openedAtMs >= cooldownMs) {
      entry.state = HALF_OPEN;
      entry.halfOpenInFlight = 0;
    }
  }

  function canAttempt(printerId) {
    if (!enabled) return true;
    const entry = circuit(normalizeKey(printerId));
    tick(entry);
    if (entry.state === CLOSED) return true;
    if (entry.state === OPEN) return false;
    // half_open: consenti un numero limitato di probe.
    if (entry.halfOpenInFlight < halfOpenMax) {
      entry.halfOpenInFlight += 1;
      return true;
    }
    return false;
  }

  function recordSuccess(printerId) {
    if (!enabled) return;
    const entry = circuit(normalizeKey(printerId));
    entry.state = CLOSED;
    entry.failures = 0;
    entry.openedAtMs = 0;
    entry.halfOpenInFlight = 0;
    refreshOpenGauge();
  }

  function recordFailure(printerId) {
    if (!enabled) return;
    const entry = circuit(normalizeKey(printerId));
    if (entry.state === HALF_OPEN) {
      // il probe è fallito: riapri subito.
      entry.state = OPEN;
      entry.openedAtMs = nowMs();
      entry.halfOpenInFlight = 0;
      refreshOpenGauge();
      return;
    }
    entry.failures += 1;
    if (entry.failures >= failureThreshold) {
      entry.state = OPEN;
      entry.openedAtMs = nowMs();
    }
    refreshOpenGauge();
  }

  function stateOf(printerId) {
    const entry = circuit(normalizeKey(printerId));
    tick(entry);
    return entry.state;
  }

  function snapshot() {
    const out = {};
    for (const [key, entry] of circuits.entries()) {
      out[key] = { state: entry.state, failures: entry.failures };
    }
    return out;
  }

  return {
    get enabled() {
      return enabled;
    },
    canAttempt,
    recordSuccess,
    recordFailure,
    stateOf,
    snapshot,
  };
}
