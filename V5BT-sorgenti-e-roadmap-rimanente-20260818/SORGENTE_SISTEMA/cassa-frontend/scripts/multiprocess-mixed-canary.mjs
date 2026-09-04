import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(cassaRoot, "..");

function envString(name, fallback) {
  const value = String(process.env[name] ?? "").trim();
  return value || fallback;
}

function parseIntEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(String(process.env[name] ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

const options = {
  frontendOrigin: envString("CANARY_FRONTEND_ORIGIN", "https://127.0.0.1:5280").replace(/\/+$/, ""),
  workerOrigin: envString("CANARY_API_WORKER_ORIGIN", "http://127.0.0.1:5283").replace(/\/+$/, ""),
  streams: parseIntEnv("CANARY_STREAMS", 4, { min: 1, max: 100 }),
  events: parseIntEnv("CANARY_EVENTS", 10, { min: 1, max: 500 }),
  eventIntervalMs: parseIntEnv("CANARY_EVENT_INTERVAL_MS", 500, { min: 0, max: 10_000 }),
  readConcurrency: parseIntEnv("CANARY_READ_CONCURRENCY", 8, { min: 1, max: 64 }),
  readDurationMs: parseIntEnv("CANARY_READ_DURATION_MS", 30_000, { min: 1_000, max: 300_000 }),
  readDelayMs: parseIntEnv("CANARY_READ_DELAY_MS", 250, { min: 0, max: 10_000 }),
  readMaxProbes: parseIntEnv("CANARY_READ_MAX_PROBES", 5_000, { min: 1, max: 50_000 }),
  timeoutMs: parseIntEnv("CANARY_TIMEOUT_MS", 20_000, { min: 1_000, max: 120_000 }),
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

const runId = envString("CANARY_RUN_ID", `mpmixed_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}`);
const consumerPrefix = `canary-${runId}`;
const readPaths = [
  "/api/health",
  "/api/integration/menu",
  "/api/integration/layout",
  "/api/integration/stations/active",
  "/api/integration/stations/state",
  "/api/integration/waiters",
];

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
    return await fetch(url, { ...init, signal: init.signal ?? controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function requestProbe(origin, pathname, init = {}) {
  const startedAt = performance.now();
  const response = await fetchWithTimeout(`${origin}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      Accept: init.accept ?? "application/json",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
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
  return {
    pathname,
    method: init.method ?? "GET",
    status: response.status,
    durationMs: performance.now() - startedAt,
    proxyRole: response.headers.get("x-proxy-backend-role") ?? "",
    desiredProxyRole: response.headers.get("x-proxy-backend-desired-role") ?? "",
    contentType: response.headers.get("content-type") ?? "",
    bytes: Buffer.byteLength(text),
    body: parsed,
    bodyPreview: text.slice(0, 300),
  };
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
  const notification = detail.notification && typeof detail.notification === "object" ? detail.notification : {};
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
  const response = await fetch(`${options.frontendOrigin}/api/integration/notifications/stream?${query}`, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (response.status !== 200) {
    controller.abort();
    throw new Error(`stream ${index + 1} HTTP ${response.status}`);
  }
  const proxyRole = response.headers.get("x-proxy-backend-role") ?? "";

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
            resolveReady({ index, consumer, proxyRole });
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
              latencyFromPublishAckMs: record.publishAckAtMs ? performance.now() - record.publishAckAtMs : null,
              receivedAtIso: new Date().toISOString(),
            });
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        diagnostics.streamErrors.push({ index, message: error?.message ?? String(error) });
        if (!readyResolved) rejectReady(error);
      }
    } finally {
      if (!readyResolved && !controller.signal.aborted) {
        rejectReady(new Error(`stream ${index + 1} chiuso prima del ready`));
      }
    }
  })();

  return { index, consumer, controller, proxyRole, readyPromise, donePromise };
}

function buildPublishPayload(index, marker) {
  return {
    type: "general",
    title: `Canary multiprocess ${index + 1}`,
    description: "Evento sintetico canary multiprocess",
    meta: {
      eventType: "multiprocess_mixed_canary",
      canaryRunId: runId,
      canaryMarker: marker,
      canaryIndex: index,
      targetClientApp: "mobile-frontend",
      createdAtMs: Date.now(),
    },
  };
}

async function publishEvent(index, marker, record, diagnostics) {
  try {
    const response = await requestProbe(options.frontendOrigin, "/api/integration/notifications/publish", {
      method: "POST",
      body: buildPublishPayload(index, marker),
    });
    record.publishAckAtMs = performance.now();
    record.publishDurationMs = record.publishAckAtMs - record.publishStartedAtMs;
    record.publishStatus = response.status;
    record.publishProxyRole = response.proxyRole;
    record.notificationId = String(response.body?.notification?.id ?? "");
    if (response.status < 200 || response.status >= 300 || response.proxyRole !== "api-owner") {
      diagnostics.publishErrors.push({
        marker,
        status: response.status,
        proxyRole: response.proxyRole,
        bodyPreview: response.bodyPreview,
      });
    }
  } catch (error) {
    record.publishAckAtMs = performance.now();
    record.publishDurationMs = record.publishAckAtMs - record.publishStartedAtMs;
    diagnostics.publishErrors.push({ marker, message: error?.message ?? String(error) });
  }
}

async function cleanupNotifications(notificationIds, diagnostics) {
  const ids = [...new Set(notificationIds.filter(Boolean))];
  await mapLimit(ids, options.cleanupConcurrency, async (id) => {
    try {
      const response = await requestProbe(options.frontendOrigin, "/api/integration/notifications/ack", {
        method: "POST",
        body: {
          id,
          action: "delete",
          consumer: `${consumerPrefix}-cleanup`,
          clientApp: "mobile-frontend",
          deviceUuid: `${consumerPrefix}-cleanup`,
        },
      });
      if (response.status >= 200 && response.status < 300 && response.proxyRole === "api-owner") {
        diagnostics.cleanedNotifications += 1;
        return;
      }
      diagnostics.cleanupErrors.push({
        id,
        status: response.status,
        proxyRole: response.proxyRole,
        bodyPreview: response.bodyPreview,
      });
    } catch (error) {
      diagnostics.cleanupErrors.push({ id, message: error?.message ?? String(error) });
    }
  });
}

async function runReadLoad(diagnostics) {
  const probes = [];
  let cursor = 0;
  const deadline = performance.now() + options.readDurationMs;
  async function durationWorker(workerIndex) {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= options.readMaxProbes || performance.now() >= deadline) return;
      const pathname = readPaths[index % readPaths.length];
      try {
        probes.push(
          await requestProbe(
            options.frontendOrigin,
            `${pathname}${pathname.includes("?") ? "&" : "?"}_=${Date.now()}_${workerIndex}_${index}`,
          ),
        );
      } catch (error) {
        probes.push({
          pathname,
          method: "GET",
          status: 0,
          durationMs: null,
          proxyRole: "",
          desiredProxyRole: "",
          contentType: "",
          bytes: 0,
          bodyPreview: error?.message ?? String(error),
        });
      }
      await delay(options.readDelayMs);
    }
  }
  await Promise.all(Array.from({ length: options.readConcurrency }, (_, index) => durationWorker(index)));
  for (const probe of probes) {
    const basePath = String(probe.pathname ?? "").split("?")[0];
    if (basePath === "/api/health") {
      if (probe.proxyRole !== "api-owner") diagnostics.readErrors.push({ reason: "health non su owner", probe });
    } else if (probe.proxyRole !== "api-worker") {
      diagnostics.readErrors.push({ reason: "read non su api-worker", probe });
    }
    if (probe.status < 200 || probe.status >= 300) {
      diagnostics.readErrors.push({ reason: "read status non 2xx", probe });
    }
  }
  return probes;
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
      return {
        available: true,
        path: options.relationalDbPath,
        total: Number(countRows?.total ?? 0),
        unpublished: Number(countRows?.unpublished ?? 0),
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return { available: false, path: options.relationalDbPath, error: error?.message ?? String(error) };
  }
}

function summarizeReads(probes) {
  const durations = probes.map((probe) => probe.durationMs);
  const byRole = probes.reduce((accumulator, probe) => {
    const role = probe.proxyRole || "none";
    accumulator[role] = (accumulator[role] ?? 0) + 1;
    return accumulator;
  }, {});
  return {
    count: probes.length,
    expectedReadsToWorker: probes.filter((probe) => String(probe.pathname ?? "").split("?")[0] !== "/api/health").length,
    readsToWorker: probes.filter(
      (probe) => String(probe.pathname ?? "").split("?")[0] !== "/api/health" && probe.proxyRole === "api-worker",
    ).length,
    healthToOwner: probes.filter(
      (probe) => String(probe.pathname ?? "").split("?")[0] === "/api/health" && probe.proxyRole === "api-owner",
    ).length,
    p50Ms: roundMs(percentile(durations, 50)),
    p95Ms: roundMs(percentile(durations, 95)),
    maxMs: roundMs(durations.length ? Math.max(...durations.filter((value) => Number.isFinite(value))) : null),
    byRole,
  };
}

function summarizeEvents(records) {
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
    if (Number.isFinite(row.publishDurationMs)) publishDurations.push(row.publishDurationMs);
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
  await fs.writeFile(path.join(reportDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const lines = [
    `# Canary multiprocess mixed ${runId}`,
    "",
    `Data: ${new Date().toISOString()}`,
    "",
    "## Configurazione",
    "",
    `- frontend origin: ${options.frontendOrigin}`,
    `- worker origin: ${options.workerOrigin}`,
    `- streams SSE: ${options.streams}`,
    `- eventi pubblicati: ${options.events}`,
    `- read concurrency: ${options.readConcurrency}`,
    `- read duration: ${options.readDurationMs}ms`,
    `- read delay: ${options.readDelayMs}ms`,
    "",
    "## Esito",
    "",
    `- read api-worker: ${result.readSummary.readsToWorker}/${result.readSummary.expectedReadsToWorker}`,
    `- health owner: ${result.readSummary.healthToOwner}`,
    `- ruoli read: ${JSON.stringify(result.readSummary.byRole)}`,
    `- read p95: ${result.readSummary.p95Ms ?? "n.d."}ms`,
    `- publish owner ok: ${result.publishToOwnerOk ? "yes" : "no"}`,
    `- SSE realtime-gateway ok: ${result.sseToRealtimeOk ? "yes" : "no"}`,
    `- direct worker mutation blocked: ${result.directWorkerMutationBlocked ? "yes" : "no"}`,
    `- deliveries: ${result.eventSummary.receivedDeliveries}/${result.eventSummary.expectedDeliveries}`,
    `- first delivery p95: ${result.eventSummary.firstDeliveryMs.p95 ?? "n.d."}ms`,
    `- all streams delivery p95: ${result.eventSummary.allStreamsDeliveryMs.p95 ?? "n.d."}ms`,
    `- notifiche pulite: ${result.diagnostics.cleanedNotifications}`,
    "",
    "## Outbox",
    "",
    result.outbox.available
      ? `- unpublished: ${result.outbox.unpublished}/${result.outbox.total}`
      : `- non disponibile: ${result.outbox.error ?? result.outbox.path}`,
    "",
    "## Errori",
    "",
    `- read: ${result.diagnostics.readErrors.length}`,
    `- publish: ${result.diagnostics.publishErrors.length}`,
    `- cleanup: ${result.diagnostics.cleanupErrors.length}`,
    `- stream: ${result.diagnostics.streamErrors.length}`,
    `- parse SSE: ${result.diagnostics.parseErrors}`,
    "",
  ];
  await fs.writeFile(path.join(reportDir, "REPORT.md"), `${lines.join("\n")}\n`);
}

async function main() {
  console.log(
    `[mp-mixed-canary] frontend=${options.frontendOrigin} worker=${options.workerOrigin} streams=${options.streams} events=${options.events} readDurationMs=${options.readDurationMs}`,
  );
  const records = new Map();
  const diagnostics = {
    parseErrors: 0,
    streamErrors: [],
    publishErrors: [],
    cleanupErrors: [],
    readErrors: [],
    cleanedNotifications: 0,
  };
  const clients = [];
  let readProbes = [];
  let directWorkerMutation = null;

  try {
    const directHealth = await requestProbe(options.workerOrigin, "/api/health");
    if (directHealth.status !== 200) {
      throw new Error(`api-worker diretto non raggiungibile: HTTP ${directHealth.status}`);
    }
    for (let index = 0; index < options.streams; index += 1) {
      clients.push(await openSseClient(index, records, diagnostics));
    }
    await Promise.all(
      clients.map((client) =>
        withTimeout(client.readyPromise, options.timeoutMs, `stream ${client.index + 1} ready`),
      ),
    );
    console.log(`[mp-mixed-canary] stream pronti=${clients.length}`);

    const readLoadPromise = runReadLoad(diagnostics);
    for (let index = 0; index < options.events; index += 1) {
      const marker = `${runId}-${String(index + 1).padStart(4, "0")}`;
      const record = {
        index,
        marker,
        notificationId: "",
        publishStartedAtMs: performance.now(),
        publishAckAtMs: null,
        publishDurationMs: null,
        publishStatus: 0,
        publishProxyRole: "",
        deliveries: new Map(),
      };
      records.set(marker, record);
      await publishEvent(index, marker, record, diagnostics);
      await delay(options.eventIntervalMs);
    }
    readProbes = await readLoadPromise;

    directWorkerMutation = await requestProbe(options.workerOrigin, "/api/integration/orders/create", {
      method: "POST",
      body: {},
    });

    const waitDeadline = Date.now() + options.timeoutMs;
    while (Date.now() < waitDeadline) {
      const summary = summarizeEvents(records);
      if (summary.missingDeliveries === 0) break;
      await delay(100);
    }

    await cleanupNotifications(
      Array.from(records.values()).map((record) => record.notificationId),
      diagnostics,
    );
    await delay(500);
  } finally {
    for (const client of clients) client.controller.abort();
    await Promise.allSettled(clients.map((client) => client.donePromise));
  }

  const readSummary = summarizeReads(readProbes);
  const eventSummary = summarizeEvents(records);
  const sseToRealtimeOk = clients.length > 0 && clients.every((client) => client.proxyRole === "realtime-gateway");
  const publishToOwnerOk = Array.from(records.values()).every(
    (record) => record.publishStatus >= 200 && record.publishStatus < 300 && record.publishProxyRole === "api-owner",
  );
  const directWorkerMutationBlocked =
    directWorkerMutation?.status === 503 && /BACKEND_PROCESS_ROUTE_BLOCKED/.test(directWorkerMutation?.bodyPreview ?? "");
  const outbox = await readOutboxStats();
  const serializableRecords = Array.from(records.values()).map((record) => ({
    index: record.index,
    marker: record.marker,
    notificationId: record.notificationId,
    publishDurationMs: roundMs(record.publishDurationMs),
    publishStatus: record.publishStatus,
    publishProxyRole: record.publishProxyRole,
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
    readSummary,
    eventSummary,
    publishToOwnerOk,
    sseToRealtimeOk,
    directWorkerMutationBlocked,
    directWorkerMutation,
    diagnostics,
    outbox,
    records: serializableRecords,
  };
  const reportDir = path.join(options.reportRoot, `multiprocess-mixed-canary-${runId}`);
  await writeReport(reportDir, result);
  console.log(`[mp-mixed-canary] report=${reportDir}`);
  console.log(
    `[mp-mixed-canary] read=${readSummary.readsToWorker}/${readSummary.expectedReadsToWorker} p95=${readSummary.p95Ms ?? "n.d."}ms roles=${JSON.stringify(readSummary.byRole)}`,
  );
  console.log(
    `[mp-mixed-canary] deliveries=${eventSummary.receivedDeliveries}/${eventSummary.expectedDeliveries} firstP95=${eventSummary.firstDeliveryMs.p95 ?? "n.d."}ms allP95=${eventSummary.allStreamsDeliveryMs.p95 ?? "n.d."}ms`,
  );
  console.log(
    `[mp-mixed-canary] publishToOwner=${publishToOwnerOk} sseToRealtime=${sseToRealtimeOk} directWorkerBlocked=${directWorkerMutationBlocked} outboxUnpublished=${outbox.available ? outbox.unpublished : "n.d."}`,
  );

  const failed =
    diagnostics.readErrors.length > 0 ||
    diagnostics.publishErrors.length > 0 ||
    diagnostics.cleanupErrors.length > 0 ||
    diagnostics.streamErrors.length > 0 ||
    eventSummary.missingDeliveries > 0 ||
    readSummary.readsToWorker !== readSummary.expectedReadsToWorker ||
    !publishToOwnerOk ||
    !sseToRealtimeOk ||
    !directWorkerMutationBlocked ||
    (outbox.available && outbox.unpublished > 0);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[mp-mixed-canary] errore", error);
  process.exitCode = 1;
});
