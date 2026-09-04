#!/usr/bin/env node
const DEFAULT_TIMEOUT_MS = 8000;

const options = parseArgs(process.argv.slice(2));
const results = [];
let session = null;

function parseArgs(argv) {
  const parsed = {
    baseUrl: process.env.STAGING_BASE_URL || process.env.BASE_URL || "",
    username: process.env.STAGING_USERNAME || process.env.POS_USERNAME || "",
    pin: process.env.STAGING_PIN || process.env.POS_PIN || "",
    deviceUuid: process.env.STAGING_DEVICE_UUID || `staging-smoke-${Date.now()}`,
    clientApp: process.env.STAGING_CLIENT_APP || "mobile-frontend",
    timeoutMs: Number(process.env.STAGING_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    requireAuth: false,
    requireBattery: false,
    json: false,
    help: false,
    allowFiscalReprint: false,
    fiscalReprintId: process.env.STAGING_FISCAL_REPRINT_ID || "",
    fiscalReprintType: process.env.STAGING_FISCAL_REPRINT_TYPE || "payment",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--require-auth") parsed.requireAuth = true;
    else if (arg === "--require-battery") parsed.requireBattery = true;
    else if (arg === "--allow-fiscal-reprint") parsed.allowFiscalReprint = true;
    else if (arg === "--base-url") {
      parsed.baseUrl = String(argv[index + 1] ?? "").trim();
      index += 1;
    } else if (arg.startsWith("--base-url=")) parsed.baseUrl = arg.slice("--base-url=".length).trim();
    else if (arg === "--username") {
      parsed.username = String(argv[index + 1] ?? "").trim();
      index += 1;
    } else if (arg.startsWith("--username=")) parsed.username = arg.slice("--username=".length).trim();
    else if (arg === "--pin") {
      parsed.pin = String(argv[index + 1] ?? "").trim();
      index += 1;
    } else if (arg.startsWith("--pin=")) parsed.pin = arg.slice("--pin=".length).trim();
    else if (arg === "--device-uuid") {
      parsed.deviceUuid = String(argv[index + 1] ?? "").trim();
      index += 1;
    } else if (arg.startsWith("--device-uuid=")) parsed.deviceUuid = arg.slice("--device-uuid=".length).trim();
    else if (arg === "--client-app") {
      parsed.clientApp = String(argv[index + 1] ?? "").trim();
      index += 1;
    } else if (arg.startsWith("--client-app=")) parsed.clientApp = arg.slice("--client-app=".length).trim();
    else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith("--timeout-ms=")) parsed.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    else if (arg === "--fiscal-reprint-id") {
      parsed.fiscalReprintId = String(argv[index + 1] ?? "").trim();
      index += 1;
    } else if (arg.startsWith("--fiscal-reprint-id=")) parsed.fiscalReprintId = arg.slice("--fiscal-reprint-id=".length).trim();
    else if (arg === "--fiscal-reprint-type") {
      parsed.fiscalReprintType = String(argv[index + 1] ?? "").trim();
      index += 1;
    } else if (arg.startsWith("--fiscal-reprint-type=")) parsed.fiscalReprintType = arg.slice("--fiscal-reprint-type=".length).trim();
  }

  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs < 1000) parsed.timeoutMs = DEFAULT_TIMEOUT_MS;
  parsed.baseUrl = parsed.baseUrl.replace(/\/+$/, "");
  return parsed;
}

function printHelp() {
  console.log(`Uso:
  STAGING_BASE_URL=https://staging.example.test npm run smoke:staging -- [opzioni]

Opzioni principali:
  --base-url URL              URL backend/static gateway staging
  --username USER --pin PIN   credenziali per controlli autenticati
  --device-uuid ID            device uuid da usare nel login smoke
  --require-auth              fallisce se mancano credenziali o login/sessione non passano
  --require-battery           fallisce se /api/mobile/battery non risponde ok
  --allow-fiscal-reprint      abilita chiamata reale di ristampa fiscale; richiede --fiscal-reprint-id
  --fiscal-reprint-id ID      movimento pagamento da ristampare in staging controllato
  --json                      output machine-readable

Default safe-by-default:
  - esegue sempre health/layout/menu pubblici;
  - esegue login, session status, pos rooms e battery solo se sono presenti username+pin;
  - NON esegue ristampa fiscale reale senza --allow-fiscal-reprint.
`);
}

function endpoint(path) {
  if (!options.baseUrl) throw new Error("base URL staging mancante");
  return new URL(path, `${options.baseUrl}/`).toString();
}

function authHeaders({ includeDevice = true } = {}) {
  if (!session) return {};
  return {
    Authorization: `Bearer ${session.token}`,
    "X-User-Id": session.userId,
    ...(includeDevice ? { "X-Device-Uuid": options.deviceUuid } : {}),
  };
}

async function fetchJson(path, { method = "GET", headers = {}, body = undefined, expectStatus = 200 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(endpoint(path), {
      method,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 500) };
      }
    }
    if (response.status !== expectStatus) {
      throw new Error(`HTTP ${response.status}, atteso ${expectStatus}: ${json?.error || json?.raw || text}`);
    }
    return { response, json };
  } finally {
    clearTimeout(timeout);
  }
}

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  if (!options.json) {
    const suffix = detail ? ` — ${detail}` : "";
    console.log(`[${status}] ${name}${suffix}`);
  }
}

async function step(name, fn, { optional = false } = {}) {
  try {
    const detail = await fn();
    record(name, "OK", detail || "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record(name, optional ? "WARN" : "FAIL", message);
  }
}

function hasFailure() {
  return results.some((entry) => entry.status === "FAIL");
}

async function run() {
  if (options.help) {
    printHelp();
    return 0;
  }
  if (!options.baseUrl) {
    throw new Error("Configura STAGING_BASE_URL oppure passa --base-url.");
  }

  await step("health pubblico", async () => {
    const { json } = await fetchJson("/api/health");
    if (json?.ok !== true) throw new Error("payload health senza ok=true");
    return `${json.service || "service"} ${json.version || ""}`.trim();
  });

  await step("layout pubblico", async () => {
    const { json } = await fetchJson("/api/integration/layout");
    if (json?.ok !== true) throw new Error("payload layout senza ok=true");
    if (!Array.isArray(json.rooms)) throw new Error("layout.rooms non è un array");
    if (!Array.isArray(json.tables)) throw new Error("layout.tables non è un array");
    return `${json.rooms.length} stanze, ${json.tables.length} tavoli`;
  });

  await step("menu pubblico", async () => {
    const { json } = await fetchJson("/api/integration/menu");
    if (json?.ok !== true) throw new Error("payload menu senza ok=true");
    const products = Array.isArray(json.products) ? json.products.length : 0;
    return `${products} prodotti`;
  });

  const canAuth = Boolean(options.username && options.pin);
  if (!canAuth) {
    record(
      "controlli autenticati",
      options.requireAuth ? "FAIL" : "WARN",
      "saltati: mancano --username/--pin o STAGING_USERNAME/STAGING_PIN"
    );
    return hasFailure() ? 2 : 0;
  }

  await step("login mobile", async () => {
    const { json } = await fetchJson("/api/auth/login", {
      method: "POST",
      body: {
        username: options.username,
        pin: options.pin,
        deviceUuid: options.deviceUuid,
        clientApp: options.clientApp,
      },
    });
    if (json?.ok !== true || !json.token || !json.user?.id) throw new Error("login senza token/user.id");
    session = { token: json.token, userId: json.user.id };
    return `utente ${json.user.username || json.user.id}`;
  }, { optional: !options.requireAuth });

  if (!session) return hasFailure() ? 2 : 0;

  await step("session status", async () => {
    const { json } = await fetchJson("/api/auth/session/status", {
      method: "POST",
      headers: authHeaders(),
      body: {
        token: session.token,
        userId: session.userId,
        deviceUuid: options.deviceUuid,
        clientApp: options.clientApp,
      },
    });
    if (json?.ok !== true || json.valid !== true) throw new Error("sessione non valida");
    return json.sessionId ? `session ${json.sessionId}` : "sessione valida";
  }, { optional: !options.requireAuth });

  await step("stanze mobile autenticate", async () => {
    const { json } = await fetchJson("/api/pos/rooms", {
      method: "POST",
      headers: authHeaders(),
      body: {
        token: session.token,
        userId: session.userId,
        deviceUuid: options.deviceUuid,
      },
    });
    if (json?.ok !== true) throw new Error("payload pos rooms senza ok=true");
    if (!Array.isArray(json.rooms)) throw new Error("rooms non è un array");
    return `${json.rooms.length} stanze abilitate/visibili`;
  }, { optional: !options.requireAuth });

  await step("batteria mobile senza query deviceUuid", async () => {
    const { json } = await fetchJson("/api/mobile/battery", {
      headers: authHeaders(),
    });
    if (json?.ok !== true) throw new Error(json?.error || "payload batteria senza ok=true");
    const matchedBy = json.matchedBy || (json.matched ? "matched" : "not matched");
    const level = typeof json.device?.level === "number" ? `${json.device.level}%` : "livello non disponibile";
    return `${matchedBy}, ${level}`;
  }, { optional: !options.requireBattery });

  if (options.allowFiscalReprint && options.fiscalReprintId) {
    await step("ristampa fiscale reale controllata", async () => {
      const { json } = await fetchJson("/api/reports/payment-movement/reprint", {
        method: "POST",
        headers: authHeaders(),
        body: {
          token: session.token,
          userId: session.userId,
          deviceUuid: options.deviceUuid,
          movementId: options.fiscalReprintId,
          type: options.fiscalReprintType,
        },
      });
      if (json?.ok !== true) throw new Error("ristampa senza ok=true");
      return `queued=${Boolean(json.fiscalReprintQueued)}, jobs=${json.printJobs?.length ?? 0}`;
    });
  } else {
    record("ristampa fiscale reale controllata", "WARN", "saltata: richiede --allow-fiscal-reprint --fiscal-reprint-id ID");
  }

  return hasFailure() ? 2 : 0;
}

try {
  const exitCode = await run();
  if (options.json) {
    console.log(JSON.stringify({ ok: !hasFailure(), baseUrl: options.baseUrl, results }, null, 2));
  }
  process.exit(exitCode);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (options.json) {
    console.log(JSON.stringify({ ok: false, error: message, results }, null, 2));
  } else {
    console.error(`[staging-smoke] FAIL: ${message}`);
  }
  process.exit(2);
}
