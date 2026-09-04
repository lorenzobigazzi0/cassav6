import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(cassaRoot, "..");

function parseIntEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(process.env[name] ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function envString(name, fallback) {
  const value = String(process.env[name] ?? "").trim();
  return value || fallback;
}

const options = {
  origin: envString("CANARY_FRONTEND_ORIGIN", "https://127.0.0.1:5280").replace(/\/+$/, ""),
  streams: parseIntEnv("CANARY_STREAMS", 20, { min: 1, max: 250 }),
  events: parseIntEnv("CANARY_EVENTS", 20, { min: 1, max: 500 }),
  intervalMs: parseIntEnv("CANARY_EVENT_INTERVAL_MS", 50, { min: 0, max: 10_000 }),
  timeoutMs: parseIntEnv("CANARY_TIMEOUT_MS", 15_000, { min: 1_000, max: 120_000 }),
  cleanupConcurrency: parseIntEnv("CANARY_CLEANUP_CONCURRENCY", 8, { min: 1, max: 50 }),
  reportRoot: envString("CANARY_REPORT_ROOT", path.join(repoRoot, "logs")),
  relationalDbPath: envString(
    "CANARY_RELATIONAL_DB_PATH",
    path.join(cassaRoot, "backend", "backend-relational.sqlite"),
  ),
  insecureTls: String(process.env.CANARY_INSECURE_TLS ?? "1") !== "0",
};

if (options.insecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const runId = envString("CANARY_RUN_ID", `rtgw_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`);
const consumerPrefix = `canary-${runId}`;

function delay(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, p) {
  const clean = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!clean.length) return null;
  const index = Math.min(clean.length - 1, Math.max(0, Math.ceil((p / 100) * clean.length) - 1));
  return clean[index];
}

function roundMs(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : null;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchWithTimeout(url, init = {}, timeoutMs = options.timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timeout HTTP ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(method, pathname, body = null) {
  const response = await fetchWithTimeout(`${options.origin}${pathname}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body === null ? {} : { "Content-Type": "application/json" }),
    },
    body: body === null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
  }
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`${method} ${pathname} HTTP ${response.status}`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  return { status: response.status, body: parsed };
}

function parseSseBlock(block) {
  const event = { event: "message", data: "" };
  const dataLines = [];
  for (const line of String(block || "").split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event.event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  event.data = dataLines.join("\n");
  return event;
}

function extractCanaryMarker(parsed) {
  if (!parsed || typeof parsed !== "object") return "";
  const detail = parsed.detail && typeof parsed.detail === "object" ? parsed.detail : {};
  const notification =
    detail.notification && typeof detail.notification === "object" ? detail.notification : {};
  const meta = notification.meta && typeof notification.meta === "object" ? notification.meta : {};
  return String(meta.canaryMarker ?? detail.canaryMarker ?? "").trim();
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function openSseClient(index, records, diagnostics) {
  const controller = new AbortController();
  const consumer = `${consumerPrefix}-stream-${String(index + 1).padStart(3, "0")}`;
  const query = new URLSearchParams({
    consumer,
    clientApp: "mobile-frontend",
    deviceUuid: consumer,
    _: String(Date.now()),
  });
  const response = await fetch(`${options.origin}/api/integration/notifications/stream?${query}`, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (response.status !== 200) {
    controller.abort();
    throw new Error(`stream ${index + 1} HTTP ${response.status}`);
  }

  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let readyResolved = false;

  const donePromise = (async () => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const read = await reader.read();
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        const parts = buffer.split(/\n\n/);
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const event = parseSseBlock(part);
          if (event.event === "ready" && !readyResolved) {
            readyResolved = true;
            resolveReady({ index, consumer });
            continue;
          }
          if (event.event !== "payload" && event.event !== "refresh") continue;
          let parsed = null;
          try {
            parsed = JSON.parse(event.data || "{}");
          } catch {
            diagnostics.parseErrors += 1;
            continue;
          }
          const marker = extractCanaryMarker(parsed);
          if (!marker) continue;
          const record = records.get(marker);
          if (!record) continue;
          if (!record.deliveries.has(index)) {
            record.deliveries.set(index, {
              event: event.event,
              latencyFromPublishStartMs: performance.now() - record.publishStartedAtMs,
              latencyFromPublishAckMs: record.publishAckAtMs
                ? performance.now() - record.publishAckAtMs
                : null,
              receivedAtIso: new Date().toISOString(),
            });
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        diagnostics.streamErrors.push({ index, message: error?.message ?? String(error) });
        if (!readyResolved) {
          rejectReady(error);
        }
      }
    } finally {
      if (!readyResolved && !controller.signal.aborted) {
        rejectReady(new Error(`stream ${index + 1} chiuso prima del ready`));
      }
    }
  })();

  return { index, consumer, controller, readyPromise, donePromise };
}

async function readOutboxStats() {
  try {
    await fs.access(options.relationalDbPath);
  } catch {
    return { available: false, path: options.relationalDbPath };
  }
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(options.relationalDbPath, { readOnly: true });
    try {
      const countRows = db
        .prepare(
          `
            SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN published_at IS NULL THEN 1 ELSE 0 END) AS unpublished
            FROM event_outbox
          `,
        )
        .get();
      const latestUnpublished = db
        .prepare(
          `
            SELECT id, event_type, aggregate_type, aggregate_id, occurred_at
            FROM event_outbox
            WHERE published_at IS NULL
            ORDER BY id DESC
            LIMIT 5
          `,
        )
        .all();
      return {
        available: true,
        path: options.relationalDbPath,
        total: Number(countRows?.total ?? 0),
        unpublished: Number(countRows?.unpublished ?? 0),
        latestUnpublished,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      available: false,
      path: options.relationalDbPath,
      error: error?.message ?? String(error),
    };
  }
}

function buildPublishPayload(index, marker) {
  return {
    type: "general",
    title: `Canary realtime ${index + 1}`,
    description: "Evento sintetico canary gateway realtime",
    meta: {
      eventType: "realtime_gateway_canary",
      canaryRunId: runId,
      canaryMarker: marker,
      canaryIndex: index,
      targetClientApp: "mobile-frontend",
      createdAtMs: Date.now(),
    },
  };
}

async function cleanupNotifications(notificationIds, diagnostics) {
  const ids = [...new Set(notificationIds.filter(Boolean))];
  await mapLimit(ids, options.cleanupConcurrency, async (id) => {
    try {
      await requestJson("POST", "/api/integration/notifications/ack", {
        id,
        action: "delete",
        consumer: `${consumerPrefix}-cleanup`,
        clientApp: "mobile-frontend",
        deviceUuid: `${consumerPrefix}-cleanup`,
      });
      diagnostics.cleanedNotifications += 1;
    } catch (error) {
      diagnostics.cleanupErrors.push({
        id,
        message: error?.message ?? String(error),
        body: error?.body ?? null,
      });
    }
  });
}

function summarize(records) {
  const rows = Array.from(records.values());
  const firstLatencies = [];
  const allLatencies = [];
  const publishDurations = [];
  let completeEvents = 0;
  let missingDeliveries = 0;
  for (const row of rows) {
    const latencies = Array.from(row.deliveries.values())
      .map((delivery) => delivery.latencyFromPublishStartMs)
      .filter((value) => Number.isFinite(value));
    if (latencies.length) firstLatencies.push(Math.min(...latencies));
    if (latencies.length === options.streams) {
      completeEvents += 1;
      allLatencies.push(Math.max(...latencies));
    }
    missingDeliveries += Math.max(0, options.streams - latencies.length);
    if (Number.isFinite(row.publishDurationMs)) {
      publishDurations.push(row.publishDurationMs);
    }
  }
  return {
    events: rows.length,
    streams: options.streams,
    expectedDeliveries: rows.length * options.streams,
    receivedDeliveries: rows.reduce((total, row) => total + row.deliveries.size, 0),
    completeEvents,
    missingDeliveries,
    publishMs: {
      p50: roundMs(percentile(publishDurations, 50)),
      p95: roundMs(percentile(publishDurations, 95)),
      max: roundMs(publishDurations.length ? Math.max(...publishDurations) : null),
    },
    firstDeliveryMs: {
      p50: roundMs(percentile(firstLatencies, 50)),
      p95: roundMs(percentile(firstLatencies, 95)),
      max: roundMs(firstLatencies.length ? Math.max(...firstLatencies) : null),
    },
    allStreamsDeliveryMs: {
      p50: roundMs(percentile(allLatencies, 50)),
      p95: roundMs(percentile(allLatencies, 95)),
      max: roundMs(allLatencies.length ? Math.max(...allLatencies) : null),
    },
  };
}

async function writeReport(reportDir, result) {
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(
    path.join(reportDir, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  const lines = [
    `# Canary realtime gateway ${runId}`,
    "",
    `Data: ${new Date().toISOString()}`,
    "",
    "## Configurazione",
    "",
    `- frontend origin: ${options.origin}`,
    `- streams SSE: ${options.streams}`,
    `- eventi pubblicati: ${options.events}`,
    `- intervallo eventi: ${options.intervalMs}ms`,
    `- timeout: ${options.timeoutMs}ms`,
    `- DB outbox: ${options.relationalDbPath}`,
    "",
    "## Esito",
    "",
    `- deliveries ricevute: ${result.summary.receivedDeliveries}/${result.summary.expectedDeliveries}`,
    `- eventi completi: ${result.summary.completeEvents}/${result.summary.events}`,
    `- delivery mancanti: ${result.summary.missingDeliveries}`,
    `- publish p95: ${result.summary.publishMs.p95 ?? "n.d."}ms`,
    `- first delivery p95: ${result.summary.firstDeliveryMs.p95 ?? "n.d."}ms`,
    `- all streams delivery p95: ${result.summary.allStreamsDeliveryMs.p95 ?? "n.d."}ms`,
    `- notifiche pulite: ${result.diagnostics.cleanedNotifications}`,
    `- errori cleanup: ${result.diagnostics.cleanupErrors.length}`,
    `- errori stream: ${result.diagnostics.streamErrors.length}`,
    `- errori parse SSE: ${result.diagnostics.parseErrors}`,
    "",
    "## Outbox",
    "",
    result.outbox.available
      ? `- unpublished: ${result.outbox.unpublished}/${result.outbox.total}`
      : `- non disponibile: ${result.outbox.error ?? result.outbox.path}`,
    "",
  ];
  await fs.writeFile(path.join(reportDir, "REPORT.md"), `${lines.join("\n")}\n`);
}

async function main() {
  console.log(`[canary] origin=${options.origin} streams=${options.streams} events=${options.events}`);
  const records = new Map();
  const diagnostics = {
    parseErrors: 0,
    streamErrors: [],
    publishErrors: [],
    cleanupErrors: [],
    cleanedNotifications: 0,
  };
  const clients = [];

  try {
    for (let index = 0; index < options.streams; index += 1) {
      clients.push(await openSseClient(index, records, diagnostics));
    }
    await Promise.all(
      clients.map((client) =>
        withTimeout(client.readyPromise, options.timeoutMs, `stream ${client.index + 1} ready`),
      ),
    );
    console.log(`[canary] stream pronti=${clients.length}`);

    for (let index = 0; index < options.events; index += 1) {
      const marker = `${runId}-${String(index + 1).padStart(4, "0")}`;
      const record = {
        index,
        marker,
        notificationId: "",
        publishStartedAtMs: performance.now(),
        publishAckAtMs: null,
        publishDurationMs: null,
        deliveries: new Map(),
      };
      records.set(marker, record);
      try {
        const response = await requestJson("POST", "/api/integration/notifications/publish", buildPublishPayload(index, marker));
        record.publishAckAtMs = performance.now();
        record.publishDurationMs = record.publishAckAtMs - record.publishStartedAtMs;
        record.notificationId = String(response.body?.notification?.id ?? "");
      } catch (error) {
        record.publishAckAtMs = performance.now();
        record.publishDurationMs = record.publishAckAtMs - record.publishStartedAtMs;
        diagnostics.publishErrors.push({
          marker,
          message: error?.message ?? String(error),
          body: error?.body ?? null,
        });
      }
      await delay(options.intervalMs);
    }

    const waitDeadline = Date.now() + options.timeoutMs;
    while (Date.now() < waitDeadline) {
      const summary = summarize(records);
      if (summary.missingDeliveries === 0) break;
      await delay(100);
    }

    await cleanupNotifications(
      Array.from(records.values()).map((record) => record.notificationId),
      diagnostics,
    );
    await delay(500);
  } finally {
    for (const client of clients) {
      client.controller.abort();
    }
    await Promise.allSettled(clients.map((client) => client.donePromise));
  }

  const serializableRecords = Array.from(records.values()).map((record) => ({
    index: record.index,
    marker: record.marker,
    notificationId: record.notificationId,
    publishDurationMs: roundMs(record.publishDurationMs),
    deliveries: Array.from(record.deliveries.entries()).map(([streamIndex, delivery]) => ({
      streamIndex,
      event: delivery.event,
      latencyFromPublishStartMs: roundMs(delivery.latencyFromPublishStartMs),
      latencyFromPublishAckMs: roundMs(delivery.latencyFromPublishAckMs),
      receivedAtIso: delivery.receivedAtIso,
    })),
  }));
  const result = {
    runId,
    startedAtIso: new Date().toISOString(),
    options,
    summary: summarize(records),
    diagnostics,
    outbox: await readOutboxStats(),
    records: serializableRecords,
  };
  const reportDir = path.join(options.reportRoot, `realtime-gateway-canary-${runId}`);
  await writeReport(reportDir, result);
  console.log(`[canary] report=${reportDir}`);
  console.log(`[canary] deliveries=${result.summary.receivedDeliveries}/${result.summary.expectedDeliveries}`);
  console.log(`[canary] first-p95=${result.summary.firstDeliveryMs.p95 ?? "n.d."}ms all-p95=${result.summary.allStreamsDeliveryMs.p95 ?? "n.d."}ms`);
  if (result.outbox.available) {
    console.log(`[canary] outbox unpublished=${result.outbox.unpublished}/${result.outbox.total}`);
  }

  const failed =
    result.summary.missingDeliveries > 0 ||
    diagnostics.publishErrors.length > 0 ||
    diagnostics.cleanupErrors.length > 0 ||
    diagnostics.streamErrors.length > 0 ||
    (result.outbox.available && result.outbox.unpublished > 0);
  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[canary] errore", error);
  process.exitCode = 1;
});
