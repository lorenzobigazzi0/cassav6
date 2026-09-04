#!/usr/bin/env node
import { promises as fs, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

const require = createRequire(import.meta.url);
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const BASE_URL = process.env.POS_BASE_URL || "http://127.0.0.1:5281";
const DB_PATH =
  process.env.POS_DB_PATH || "/srv/applicazione/v3/cassa-frontend/backend/app-state.json";
const SPOOL_DIR =
  process.env.POS_PRINT_SPOOL_DIR || "/srv/applicazione/v3/cassa-frontend/backend/.print-spool";
const STATE_FILE =
  process.env.FRANCESCA_PRECONTO_STATE_FILE ||
  "/srv/applicazione/data/francesca-preconto-mirror-state.json";
const TARGET_HOST = process.env.FRANCESCA_PRECONTO_HOST || "192.168.1.36";
const TARGET_PORT = Number(process.env.FRANCESCA_PRECONTO_PORT || 9100);
const POLL_MS = Math.max(1000, Number(process.env.FRANCESCA_PRECONTO_POLL_MS || 2500));
const SOCKET_TIMEOUT_MS = Math.max(1000, Number(process.env.FRANCESCA_PRECONTO_TIMEOUT_MS || 5000));
const MAX_ATTEMPTS = Math.max(1, Number(process.env.FRANCESCA_PRECONTO_MAX_ATTEMPTS || 120));
const STARTED_AT_MS = Date.now();

const log = (message) => {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
};

async function loadState() {
  try {
    const state = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    if (!Number.isFinite(Number(state.watchFromMs))) {
      state.watchFromMs = STARTED_AT_MS - 60_000;
    }
    state.mirrored = state.mirrored && typeof state.mirrored === "object" ? state.mirrored : {};
    state.attempts = state.attempts && typeof state.attempts === "object" ? state.attempts : {};
    return state;
  } catch {
    return {
      mirrored: {},
      attempts: {},
      startedAt: new Date(STARTED_AT_MS).toISOString(),
      watchFromMs: STARTED_AT_MS - 60_000,
    };
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function readAppState() {
  if (DB_PATH.endsWith(".json")) {
    const raw = readFileSync(DB_PATH, "utf8");
    return JSON.parse(raw);
  }

  if (typeof DatabaseSync !== "function") {
    throw new Error("node:sqlite non disponibile: configurare POS_DB_PATH verso il DB JSON V3 o usare Node con sqlite abilitato.");
  }

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const row = db.prepare("SELECT json FROM app_state WHERE id = 1").get();
    if (!row?.json) return null;
    return JSON.parse(row.json);
  } finally {
    db.close();
  }
}

async function fetchOrders() {
  const response = await fetch(`${BASE_URL}/api/integration/orders?includeDone=1&_=${Date.now()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`orders HTTP ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload.orders) ? payload.orders : [];
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isFrancescaOrder(order) {
  return (
    normalize(order?.createdByUserId) === "u_francesca" ||
    normalize(order?.createdByUsername) === "francesca" ||
    normalize(order?.waiter) === "francesca maria perri"
  );
}

function orderTimestampMs(order) {
  const candidates = [order?.receivedAtMs, order?.createdAtMs, Date.parse(String(order?.createdAt ?? ""))];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function findPrecontoJob(appState, orderId) {
  const jobs = Array.isArray(appState?.printSpoolJobs) ? appState.printSpoolJobs : [];
  return jobs
    .filter((job) => normalize(job?.kind) === "preconto")
    .filter((job) => String(job?.orderId ?? "").trim() === orderId)
    .sort((a, b) => Date.parse(String(b?.requestedAt ?? "")) - Date.parse(String(a?.requestedAt ?? "")))[0] ?? null;
}

function buildRawEscPosPayload(text) {
  return Buffer.concat([
    Buffer.from([0x1b, 0x40]),
    Buffer.from(String(text ?? ""), "utf8"),
    Buffer.from("\r\n\r\n", "utf8"),
    Buffer.from([0x1b, 0x64, 0x02]),
    Buffer.from([0x1d, 0x56, 0x41, 0x01]),
  ]);
}

async function sendTcpPrint(text) {
  const payload = buildRawEscPosPayload(text);
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: TARGET_HOST, port: TARGET_PORT });
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    socket.on("connect", () => {
      socket.write(payload, (error) => {
        if (error) {
          finish(error);
          return;
        }
        socket.end();
      });
    });
    socket.on("close", () => finish());
    socket.on("timeout", () => finish(new Error("timeout stampante")));
    socket.on("error", (error) => finish(error));
  });
}

async function mirrorOrderPreconto(state, order) {
  const orderId = String(order?.id ?? "").trim();
  if (!orderId) return false;

  const attempts = Number(state.attempts?.[orderId] ?? 0);
  if (attempts >= MAX_ATTEMPTS) return false;

  const appState = readAppState();
  const precontoJob = findPrecontoJob(appState, orderId);
  if (!precontoJob?.fileName) {
    state.attempts[orderId] = attempts + 1;
    return false;
  }

  const mirrorKey = String(precontoJob.id ?? precontoJob.fileName ?? orderId).trim();
  if (!mirrorKey || state.mirrored?.[mirrorKey]) return false;

  const text = await fs.readFile(path.join(SPOOL_DIR, precontoJob.fileName), "utf8");
  await sendTcpPrint(text);
  state.mirrored[mirrorKey] = {
    mirroredAt: new Date().toISOString(),
    orderId,
    sourceJobId: precontoJob.id ?? "",
    sourceFileName: precontoJob.fileName,
    targetHost: TARGET_HOST,
    targetPort: TARGET_PORT,
  };
  delete state.attempts[orderId];
  log(`preconto Francesca duplicato su ${TARGET_HOST}:${TARGET_PORT} per ordine ${orderId}`);
  return true;
}

async function tick(state) {
  const orders = await fetchOrders();
  const watchFromMs = Number.isFinite(Number(state.watchFromMs))
    ? Number(state.watchFromMs)
    : STARTED_AT_MS - 60_000;
  const candidates = orders
    .filter(isFrancescaOrder)
    .filter((order) => orderTimestampMs(order) >= watchFromMs)
    .sort((a, b) => orderTimestampMs(a) - orderTimestampMs(b));

  let changed = false;
  for (const order of candidates) {
    try {
      const mirrored = await mirrorOrderPreconto(state, order);
      changed = changed || mirrored || Boolean(state.attempts?.[order.id]);
    } catch (error) {
      const orderId = String(order?.id ?? "").trim();
      state.attempts[orderId] = Number(state.attempts?.[orderId] ?? 0) + 1;
      changed = true;
      log(`errore mirror ordine ${orderId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (changed) await saveState(state);
}

const state = await loadState();
log(`mirror preconti Francesca attivo verso ${TARGET_HOST}:${TARGET_PORT}, polling ${POLL_MS}ms`);

let running = false;
setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await tick(state);
  } catch (error) {
    log(`tick fallito: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    running = false;
  }
}, POLL_MS);

await tick(state).catch((error) => {
  log(`tick iniziale fallito: ${error instanceof Error ? error.message : String(error)}`);
});
