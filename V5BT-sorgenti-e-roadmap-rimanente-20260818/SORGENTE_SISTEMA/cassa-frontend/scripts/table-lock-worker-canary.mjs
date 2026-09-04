import { performance } from "node:perf_hooks";

const baseUrl = String(process.env.TABLE_LOCK_CANARY_BASE_URL || "https://127.0.0.1:5280").replace(/\/$/, "");
const lockBaseUrl = String(process.env.TABLE_LOCK_CANARY_LOCK_BASE_URL || baseUrl).replace(/\/$/, "");
const username = String(process.env.TABLE_LOCK_CANARY_USERNAME || "amalia");
const pin = String(process.env.TABLE_LOCK_CANARY_PIN || "");
const concurrency = Math.max(1, Number.parseInt(process.env.TABLE_LOCK_CANARY_CONCURRENCY || "50", 10));
const rounds = Math.max(1, Number.parseInt(process.env.TABLE_LOCK_CANARY_ROUNDS || "3", 10));
const timeoutMs = Math.max(1_000, Number.parseInt(process.env.TABLE_LOCK_CANARY_TIMEOUT_MS || "15000", 10));
const compactOutput = ["1", "true", "yes", "on"].includes(String(process.env.TABLE_LOCK_CANARY_COMPACT || "").trim().toLowerCase());
const deviceUuid = `table-lock-canary-${Date.now()}-${process.pid}`;

if (!pin) throw new Error("TABLE_LOCK_CANARY_PIN richiesto.");

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function summarize(samples) {
  const values = samples.map((sample) => sample.durationMs);
  return {
    count: values.length,
    ok: samples.filter((sample) => sample.ok).length,
    errors: samples.filter((sample) => !sample.ok).length,
    p50Ms: Math.round(percentile(values, 0.5)),
    p95Ms: Math.round(percentile(values, 0.95)),
    p99Ms: Math.round(percentile(values, 0.99)),
    maxMs: Math.round(Math.max(0, ...values)),
    roles: [...new Set(samples.map((sample) => sample.role).filter(Boolean))],
  };
}

async function request(pathname, { method = "GET", session = null, body = null, origin = baseUrl } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const headers = { accept: "application/json" };
    if (body !== null) headers["content-type"] = "application/json";
    if (session) {
      headers.authorization = `Bearer ${session.token}`;
      headers["x-user-id"] = session.userId;
      headers["x-device-uuid"] = session.deviceUuid;
    }
    const response = await fetch(`${origin}${pathname}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      body: payload,
      role: response.headers.get("x-proxy-backend-role") || "",
      durationMs: performance.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runBatch(items, callback) {
  const results = [];
  for (let offset = 0; offset < items.length; offset += concurrency) {
    const batch = items.slice(offset, offset + concurrency);
    results.push(...(await Promise.all(batch.map(callback))));
  }
  return results;
}

const login = await request("/api/auth/login", {
  method: "POST",
  body: { username, pin, deviceUuid, clientApp: "mobile-frontend" },
});
if (!login.ok || !login.body?.token || !login.body?.user?.id) {
  throw new Error(`Login fallito (${login.status}): ${JSON.stringify(login.body)}`);
}

const session = {
  token: login.body.token,
  userId: login.body.user.id,
  deviceUuid,
};
const acquiredTableIds = new Set();
const samples = { acquire: [], heartbeat: [], release: [] };

try {
  const layout = await request("/api/integration/layout", { session });
  if (!layout.ok || !Array.isArray(layout.body?.tables)) {
    throw new Error(`Layout non disponibile (${layout.status}).`);
  }
  const tables = layout.body.tables.filter((table) => table?.id && !table?.workLock);
  if (tables.length === 0) throw new Error("Nessun tavolo libero per il canary.");

  for (let round = 0; round < rounds; round += 1) {
    const acquired = await runBatch(tables, async (table) => {
      const result = await request("/api/tables/lock/acquire", {
        method: "POST",
        session,
        origin: lockBaseUrl,
        body: { tableId: table.id, purpose: `p4.fastpath.canary.${round}` },
      });
      samples.acquire.push(result);
      if (result.ok) acquiredTableIds.add(table.id);
      return { table, result };
    });
    const owned = acquired.filter((entry) => entry.result.ok).map((entry) => entry.table);

    await runBatch(owned, async (table) => {
      const result = await request("/api/tables/lock/heartbeat", {
        method: "POST",
        session,
        origin: lockBaseUrl,
        body: { tableId: table.id, purpose: `p4.fastpath.canary.${round}` },
      });
      samples.heartbeat.push(result);
      return result;
    });

    await runBatch(owned, async (table) => {
      const result = await request("/api/tables/lock/release", {
        method: "POST",
        session,
        origin: lockBaseUrl,
        body: { tableId: table.id },
      });
      samples.release.push(result);
      if (result.ok) acquiredTableIds.delete(table.id);
      return result;
    });
  }

  const metrics = await request("/api/monitor/runtime-metrics", { session });
  const lockWorker = metrics.body?.runtimeMetrics?.workers?.find(
    (worker) => worker?.role === "table-lock-worker",
  )?.runtimeMetrics;
  const result = {
    ok: Object.values(samples).every((group) => group.every((sample) => sample.ok)),
    baseUrl,
    lockBaseUrl,
    tables: tables.length,
    rounds,
    concurrency,
    summary: Object.fromEntries(
      Object.entries(samples).map(([name, group]) => [name, summarize(group)]),
    ),
    worker: lockWorker
      ? {
          pid: lockWorker.process?.pid ?? null,
          requests: lockWorker.counters?.requests ?? 0,
          readDb: lockWorker.counters?.readDb ?? 0,
          writeDb: lockWorker.counters?.writeDb ?? 0,
          authCache: {
            hits: lockWorker.counters?.tableLockFastAuthCacheHits ?? 0,
            misses: lockWorker.counters?.tableLockFastAuthCacheMisses ?? 0,
            errors: lockWorker.counters?.tableLockFastAuthCacheErrors ?? 0,
            mysqlHits: lockWorker.counters?.tableLockFastAuthHits ?? 0,
            mysqlMisses: lockWorker.counters?.tableLockFastAuthMisses ?? 0,
            mysqlFallbacks: lockWorker.counters?.tableLockFastAuthFallbacks ?? 0,
          },
          redisClient: {
            poolSize: lockWorker.gauges?.redisClientPoolSize ?? 0,
            openConnections: lockWorker.gauges?.redisClientOpenConnections ?? 0,
            connectionsOpened: lockWorker.gauges?.redisClientConnectionsOpened ?? 0,
            reconnects: lockWorker.gauges?.redisClientReconnects ?? 0,
            queued: lockWorker.gauges?.redisClientQueued ?? 0,
            commands: lockWorker.gauges?.redisClientCommands ?? 0,
          },
          readDbInternal: lockWorker.operations?.runMsByLabel ?? {},
        }
      : null,
  };
  const output = compactOutput
    ? {
        ...result,
        worker: result.worker
          ? {
              pid: result.worker.pid,
              authCache: result.worker.authCache,
              redisClient: result.worker.redisClient,
              authCacheTiming: result.worker.readDbInternal?.["tableLockWorkerFastPath:authCacheHit"] ?? null,
            }
          : null,
      }
    : result;
  console.log(JSON.stringify(output, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  await Promise.all(
    [...acquiredTableIds].map((tableId) =>
      request("/api/tables/lock/release", {
        method: "POST",
        session,
        origin: lockBaseUrl,
        body: { tableId },
      }).catch(() => null),
    ),
  );
  await request("/api/auth/logout", {
    method: "POST",
    session,
    body: { token: session.token, userId: session.userId, deviceUuid },
  }).catch(() => null);
}
