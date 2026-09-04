import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { authHeaders, loginJson, startBackend } from "./helpers/test-server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, "../../..");
const serveFrontendsPath = path.join(sourceRoot, "serve-frontends.mjs");

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForOutput(child, expected, timeoutMs = 5_000) {
  return await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timeout avvio proxy: ${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += String(chunk);
      if (!output.includes(expected)) return;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      resolve();
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Proxy terminato prima dell'avvio: ${code}; ${output}`));
    });
  });
}

function createSseQueue(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  const waiters = [];
  let buffer = "";
  let ended = false;
  let error = null;

  const dispatch = (event) => {
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(event));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
      return;
    }
    events.push(event);
  };

  const parse = (part) => {
    const event = { event: "message", data: "", id: "" };
    for (const line of part.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) event.event = line.slice(6).trim();
      else if (line.startsWith("data:")) event.data += line.slice(5).trim();
      else if (line.startsWith("id:")) event.id = line.slice(3).trim();
    }
    if (event.data || event.event !== "message") dispatch(event);
  };

  const pump = (async () => {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        const parts = buffer.split(/\n\n/);
        buffer = parts.pop() ?? "";
        for (const part of parts) parse(part);
      }
      ended = true;
    } catch (cause) {
      error = cause;
    } finally {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(error ?? new Error("Stream SSE terminato"));
      }
    }
  })();

  return {
    async next(predicate, timeoutMs = 2_000) {
      const existingIndex = events.findIndex(predicate);
      if (existingIndex >= 0) return events.splice(existingIndex, 1)[0];
      if (error) throw error;
      if (ended) throw new Error("Stream SSE terminato");
      return await new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error("Timeout attesa evento SSE"));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    async close() {
      await reader.cancel().catch(() => undefined);
      await pump.catch(() => undefined);
    },
  };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

test("10 notifiche chiamata cameriere attraversano backend e proxy senza il ritardo da 10-15 secondi", async (t) => {
  const { baseUrl } = await startBackend(t, {
    env: {
      SSE_EVENT_PAYLOAD: "1",
      SSE_LEGACY_REFRESH: "0",
      BACKEND_REALTIME_SCOPED_DELIVERY: "1",
      BACKEND_REALTIME_HEARTBEAT_MS: "5000",
      BACKEND_REALTIME_BOOTSTRAP_PADDING_BYTES: "2048",
      RUNTIME_METRICS: "1",
    },
  });
  const proxyPort = await reservePort();
  const proxy = spawn(process.execPath, [serveFrontendsPath], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      FRONTEND_HOST: "127.0.0.1",
      FRONTEND_PORT: String(proxyPort),
      FRONTEND_ROOT: sourceRoot,
      FRONTEND_HTTPS: "false",
      FRONTEND_LAN_HTTPS: "false",
      BACKEND_ORIGIN: baseUrl,
      BACKEND_REALTIME_ORIGIN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (!proxy.killed) proxy.kill("SIGTERM");
  });
  await waitForOutput(proxy, "Static server attivo");

  const proxyBaseUrl = `http://127.0.0.1:${proxyPort}`;
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(
    `${proxyBaseUrl}/api/integration/notifications/stream?consumer=latency-test&clientApp=postazione`,
    { signal: controller.signal },
  );
  assert.equal(response.status, 200);
  const stream = createSseQueue(response);
  t.after(() => stream.close());
  await stream.next((event) => event.event === "ready", 1_500);

  const adminDevice = "realtime-latency-admin";
  const admin = await loginJson(baseUrl, "ultra_admin", "1111", {
    deviceUuid: adminDevice,
    clientApp: "cassa-frontend",
  });

  const durations = [];
  for (let index = 0; index < 10; index += 1) {
    const marker = `waiter-call-${Date.now()}-${index}`;
    const expected = stream.next((event) => {
      if (event.event !== "payload") return false;
      const payload = JSON.parse(event.data || "{}");
      return payload.detail?.notification?.meta?.marker === marker;
    }, 2_000);
    const startedAt = performance.now();
    const publishResponse = await fetch(`${proxyBaseUrl}/api/integration/notifications/publish`, {
      method: "POST",
      headers: authHeaders(admin, adminDevice),
      body: JSON.stringify({
        type: "general",
        title: "Chiama cameriere",
        description: `Test realtime ${index + 1}`,
        meta: { marker, targetClientApp: "mobile-frontend" },
      }),
    });
    assert.equal(publishResponse.status, 200);
    await expected;
    durations.push(performance.now() - startedAt);
  }

  const p50 = percentile(durations, 50);
  const p95 = percentile(durations, 95);
  const maximum = Math.max(...durations);
  t.diagnostic(
    `realtime notifications: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${maximum.toFixed(1)}ms`,
  );
  assert.ok(p95 < 1_000, `p95 realtime ${p95.toFixed(1)} ms; campioni=${durations.map((v) => v.toFixed(1)).join(",")}`);
});
