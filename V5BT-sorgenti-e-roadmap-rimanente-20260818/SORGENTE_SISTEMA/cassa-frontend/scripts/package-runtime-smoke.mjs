#!/usr/bin/env node
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");
const startupTimeoutMs = 25_000;
const requestTimeoutMs = 5_000;
const maxCapturedLogLength = 64_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function appendLog(current, chunk) {
  const next = `${current}${String(chunk ?? "")}`;
  return next.length <= maxCapturedLogLength
    ? next
    : next.slice(next.length - maxCapturedLogLength);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${url} ha risposto ${response.status} con JSON non valido: ${text.slice(0, 240)}`);
  }
  if (response.status !== 200) {
    throw new Error(`${url} ha risposto con HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  return body;
}

async function waitForHealth(baseUrl, child) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < startupTimeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Il backend e' terminato prima del health check con codice ${child.exitCode}.`);
    }
    try {
      const health = await fetchJson(`${baseUrl}/api/health`);
      if (health?.ok === true && health?.database?.ok === true) return health;
      lastError = new Error(`Health non pronto: ${JSON.stringify(health)}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw lastError ?? new Error(`Timeout durante l'avvio di ${baseUrl}.`);
}

async function stopChild(child, exitPromise) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exitPromise.then(() => true),
    sleep(4_000).then(() => false),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill("SIGKILL");
    await exitPromise;
  }
}

async function main() {
  const startedAt = Date.now();
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cassav4-package-smoke-"));
  const dbPath = path.join(runtimeDir, "app-state.json");
  const port = await reserveFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let stdout = "";
  let stderr = "";

  const child = spawn(process.execPath, ["backend/scripts/start-backend.mjs"], {
    cwd: cassaRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      BACKEND_HOST: "127.0.0.1",
      BACKEND_PORT: String(port),
      PORT: String(port),
      BACKEND_DB_MODE: "json",
      BACKEND_DB_PATH: dbPath,
      BACKEND_ALLOW_EMPTY_DB_INIT: "1",
      BACKEND_TOKEN_SECRET: "package-smoke-token-secret-0123456789abcdef",
      CORS_ALLOWED_ORIGINS: "",
      ENABLE_DEBUG_ENDPOINTS: "0",
      ENABLE_MAINTENANCE_ENDPOINTS: "0",
      ENABLE_MOCK_MENU: "0",
      ENABLE_DEMO_PRODUCTS: "0",
      PRINTING_ENABLED: "0",
      FISCAL_PROVIDER: "mock",
      FISCAL_REAL_IO_DISABLED: "1",
      POS_FISCAL_REAL_IO_DISABLED: "1",
      BACKEND_FISCAL_OUTBOX_ENABLED: "0",
      BACKEND_FISCAL_OUTBOX_WORKER_ENABLED: "0",
      AUTOMATIC_CASH_GATEWAY_ENABLED: "0",
      AUTOMATIC_CASH_REAL_ENABLED: "0",
      AUTOMATIC_CASH_SIMULATOR_SEED: "0",
      MQTT_ENABLED: "0",
      MQTT_EVENTS_ENABLED: "0",
      REDIS_ENABLED: "0",
      SMART_CARD_READER_MODE: "push",
      SMART_CARD_PUSH_TOKEN: "package-smoke-smart-card-token",
      SMART_CARD_AUTO_DETECT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    stdout = appendLog(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendLog(stderr, chunk);
  });
  const exitPromise = new Promise((resolve) => child.once("exit", resolve));

  try {
    const health = await waitForHealth(baseUrl, child);
    const probes = [
      ["order-workflow", "/api/settings/order-workflow"],
      ["payment-methods", "/api/settings/payment-methods"],
      ["monitor-overview", "/api/monitor/overview"],
    ];
    const results = [{ name: "health", path: "/api/health", ok: health?.ok === true }];
    for (const [name, endpoint] of probes) {
      const body = await fetchJson(`${baseUrl}${endpoint}`);
      if (body?.ok !== true) throw new Error(`${endpoint} non ha restituito ok=true.`);
      results.push({ name, path: endpoint, ok: true });
    }

    await stopChild(child, exitPromise);
    console.log(JSON.stringify({
      ok: true,
      mode: "isolated-package-runtime",
      backendEntryPoint: "backend/scripts/start-backend.mjs",
      hardwareIo: "disabled",
      database: health.database,
      probes: results,
      elapsedMs: Date.now() - startedAt,
    }, null, 2));
  } catch (error) {
    await stopChild(child, exitPromise);
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stdout: stdout.trim().slice(-12_000),
      stderr: stderr.trim().slice(-12_000),
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
}

await main();
