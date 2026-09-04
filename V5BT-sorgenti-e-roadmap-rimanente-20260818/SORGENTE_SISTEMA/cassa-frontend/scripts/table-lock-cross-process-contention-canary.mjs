import { performance } from "node:perf_hooks";

const apiBaseUrl = String(process.env.TABLE_LOCK_RACE_API_BASE_URL || "https://127.0.0.1:5280").replace(/\/$/, "");
const workerUrls = String(process.env.TABLE_LOCK_RACE_WORKER_URLS || "http://127.0.0.1:5285,http://127.0.0.1:5286")
  .split(",")
  .map((value) => value.trim().replace(/\/$/, ""))
  .filter(Boolean);
const username = String(process.env.TABLE_LOCK_RACE_USERNAME || "amalia");
const pin = String(process.env.TABLE_LOCK_RACE_PIN || "");
const rounds = Math.max(1, Number.parseInt(process.env.TABLE_LOCK_RACE_ROUNDS || "5", 10));
const concurrency = Math.max(1, Number.parseInt(process.env.TABLE_LOCK_RACE_CONCURRENCY || "10", 10));
const timeoutMs = Math.max(1_000, Number.parseInt(process.env.TABLE_LOCK_RACE_TIMEOUT_MS || "15000", 10));

if (!pin) throw new Error("TABLE_LOCK_RACE_PIN richiesto.");
if (workerUrls.length !== 2) throw new Error("TABLE_LOCK_RACE_WORKER_URLS richiede due origini.");

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

async function request(origin, pathname, { method = "GET", session = null, body = null } = {}) {
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
      status: response.status,
      ok: response.ok,
      body: payload,
      durationMs: performance.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function login(index) {
  const deviceUuid = `table-lock-race-${Date.now()}-${process.pid}-${index}`;
  const result = await request(apiBaseUrl, "/api/auth/login", {
    method: "POST",
    body: { username, pin, deviceUuid, clientApp: "mobile-frontend" },
  });
  if (!result.ok || !result.body?.token || !result.body?.user?.id) {
    throw new Error(`Login ${index} fallito (${result.status}): ${JSON.stringify(result.body)}`);
  }
  return {
    token: result.body.token,
    userId: result.body.user.id,
    deviceUuid,
  };
}

async function runBatch(entries, callback) {
  const results = [];
  for (let offset = 0; offset < entries.length; offset += concurrency) {
    results.push(...(await Promise.all(entries.slice(offset, offset + concurrency).map(callback))));
  }
  return results;
}

const sessions = await Promise.all([login(0), login(1)]);
const selectedTableIds = [];
const samples = [];
let releaseErrors = 0;

try {
  const layout = await request(apiBaseUrl, "/api/integration/layout", { session: sessions[0] });
  if (!layout.ok || !Array.isArray(layout.body?.tables)) {
    throw new Error(`Layout non disponibile (${layout.status}).`);
  }
  selectedTableIds.push(
    ...layout.body.tables.filter((table) => table?.id && !table?.workLock).map((table) => table.id),
  );
  if (selectedTableIds.length === 0) throw new Error("Nessun tavolo libero per la contesa.");

  for (let round = 0; round < rounds; round += 1) {
    await runBatch(selectedTableIds, async (tableId) => {
      const attempts = await Promise.all(
        workerUrls.map((origin, index) =>
          request(origin, "/api/tables/lock/acquire", {
            method: "POST",
            session: sessions[index],
            body: { tableId, purpose: `p4.cross-process-race.${round}` },
          }),
        ),
      );
      const statuses = attempts.map((attempt) => attempt.status).sort((a, b) => a - b);
      const winnerIndex = attempts.findIndex((attempt) => attempt.status === 200);
      const exactWinner = statuses[0] === 200 && statuses[1] === 409;
      samples.push({
        exactWinner,
        statuses,
        durationMs: Math.max(...attempts.map((attempt) => attempt.durationMs)),
      });
      if (winnerIndex >= 0) {
        const released = await request(workerUrls[winnerIndex], "/api/tables/lock/release", {
          method: "POST",
          session: sessions[winnerIndex],
          body: { tableId },
        });
        if (!released.ok) releaseErrors += 1;
      }
    });
  }

  const durations = samples.map((sample) => sample.durationMs);
  const result = {
    ok: samples.every((sample) => sample.exactWinner) && releaseErrors === 0,
    workers: workerUrls,
    tables: selectedTableIds.length,
    rounds,
    races: samples.length,
    exactWinners: samples.filter((sample) => sample.exactWinner).length,
    dualSuccess: samples.filter((sample) => sample.statuses[0] === 200 && sample.statuses[1] === 200).length,
    dualConflict: samples.filter((sample) => sample.statuses[0] === 409 && sample.statuses[1] === 409).length,
    unexpected: samples.filter((sample) => !sample.exactWinner).slice(0, 10),
    releaseErrors,
    p50Ms: Math.round(percentile(durations, 0.5)),
    p95Ms: Math.round(percentile(durations, 0.95)),
    p99Ms: Math.round(percentile(durations, 0.99)),
    maxMs: Math.round(Math.max(0, ...durations)),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  if (sessions[0]) {
    await Promise.all(
      selectedTableIds.map((tableId) =>
        request(workerUrls[0], "/api/tables/lock/force-release", {
          method: "POST",
          session: sessions[0],
          body: { tableId, purpose: "p4.cross-process-race.cleanup" },
        }).catch(() => null),
      ),
    );
  }
  await Promise.all(
    sessions.map((session) =>
      request(apiBaseUrl, "/api/auth/logout", {
        method: "POST",
        session,
        body: { token: session.token, userId: session.userId, deviceUuid: session.deviceUuid },
      }).catch(() => null),
    ),
  );
}
