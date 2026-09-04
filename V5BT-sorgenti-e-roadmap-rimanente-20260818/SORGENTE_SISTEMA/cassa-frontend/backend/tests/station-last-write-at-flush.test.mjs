import test from "node:test";
import assert from "node:assert/strict";
import {
  createStationLastWriteAtFlush,
  inspectStationLastWriteAt,
} from "../modules/integration/station-last-write-at-flush.js";

function state(marker, stationTimes = [], fieldsBeforeMarker = 1) {
  const integration = {};
  for (let index = 0; index < fieldsBeforeMarker; index += 1) {
    integration[`field${index}`] = null;
  }
  integration.lastWriteAt = marker;
  integration.stationStates = stationTimes.map((updatedAtMs) => ({ updatedAtMs }));
  return { integration };
}

function metrics() {
  const counters = {};
  const gauges = {};
  const operations = [];
  return {
    counters,
    gauges,
    operations,
    incrementCounter(name, amount = 1) {
      counters[name] = (counters[name] || 0) + amount;
    },
    setGauge(name, value) {
      gauges[name] = value;
    },
    recordOperation(kind, label, durationMs) {
      operations.push({ kind, label, durationMs });
    },
  };
}

test("l'ispezione usa MAX station/marker e conserva la posizione canonica", () => {
  const now = Date.parse("2026-08-07T12:00:00.000Z");
  const inspected = inspectStationLastWriteAt(
    state("2026-08-07T11:59:00.000Z", [now - 20_000, now - 10_000], 3),
    { nowMs: () => now },
  );
  assert.equal(inspected.candidateMs, now - 10_000);
  assert.equal(inspected.position, 3);
  assert.equal(inspected.recoveryRequired, true);
  assert.equal(inspected.valid, true);
});

test("l'ispezione rifiuta timestamp futuri e input senza watermark", () => {
  const now = Date.parse("2026-08-07T12:00:00.000Z");
  assert.equal(
    inspectStationLastWriteAt(state("", [now + 301_000]), { nowMs: () => now }).futureTimestamp,
    true,
  );
  assert.equal(
    inspectStationLastWriteAt({ integration: { stationStates: [] } }, { nowMs: () => now }).valid,
    false,
  );
});

test("OFF non accoda e non invoca il writer", async () => {
  let writes = 0;
  const queue = createStationLastWriteAtFlush({
    enabled: false,
    writeTimestamp: async () => {
      writes += 1;
    },
  });
  assert.equal(queue.enqueueFromAppState(state("2026-08-07T12:00:00.000Z")), false);
  assert.deepEqual(await queue.drain(), { drained: true, remaining: 0 });
  assert.equal(writes, 0);
});

test("il burst fuori ordine viene coalesciato sul timestamp massimo", async () => {
  const observed = [];
  const runtimeMetrics = metrics();
  const queue = createStationLastWriteAtFlush({
    enabled: true,
    intervalMs: 10_000,
    runtimeMetrics,
    writeTimestamp: async (payload) => observed.push(payload),
  });
  queue.enqueueFromAppState(state("2026-08-07T12:00:02.000Z"));
  queue.enqueueFromAppState(state("2026-08-07T12:00:01.000Z"));
  queue.enqueueFromAppState(state("2026-08-07T12:00:03.000Z"));
  await queue.flushOnce();
  assert.equal(observed.length, 1);
  assert.equal(observed[0].timestamp, "2026-08-07T12:00:03.000Z");
  assert.equal(runtimeMetrics.counters.stationStateLastWriteEnqueued, 3);
  assert.equal(runtimeMetrics.counters.stationStateLastWriteCoalesced, 2);
  assert.equal(runtimeMetrics.counters.stationStateLastWriteFlushed, 3);
  assert.equal(runtimeMetrics.gauges.stationStateLastWritePendingDepth, 0);
});

test("un valore nuovo durante il flush resta per il batch successivo", async () => {
  let releaseFirst;
  const firstWrite = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const observed = [];
  const queue = createStationLastWriteAtFlush({
    enabled: true,
    intervalMs: 10_000,
    writeTimestamp: async (payload) => {
      observed.push(payload.timestamp);
      if (observed.length === 1) await firstWrite;
    },
  });
  queue.enqueueFromAppState(state("2026-08-07T12:00:01.000Z"));
  const active = queue.flushOnce();
  await new Promise((resolve) => setImmediate(resolve));
  queue.enqueueFromAppState(state("2026-08-07T12:00:02.000Z"));
  releaseFirst();
  await active;
  await queue.flushOnce();
  assert.deepEqual(observed, [
    "2026-08-07T12:00:01.000Z",
    "2026-08-07T12:00:02.000Z",
  ]);
});

test("errore e retry reinseriscono il massimo senza perdita", async () => {
  let attempts = 0;
  const runtimeMetrics = metrics();
  const queue = createStationLastWriteAtFlush({
    enabled: true,
    intervalMs: 10_000,
    runtimeMetrics,
    logger: { warn() {} },
    writeTimestamp: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("lock timeout");
    },
  });
  queue.enqueueFromAppState(state("2026-08-07T12:00:01.000Z"));
  await queue.flushOnce();
  queue.enqueueFromAppState(state("2026-08-07T12:00:02.000Z"));
  assert.deepEqual(await queue.drain({ timeoutMs: 1_000 }), {
    drained: true,
    remaining: 0,
  });
  assert.equal(attempts, 2);
  assert.equal(runtimeMetrics.counters.stationStateLastWriteRetries, 1);
  assert.equal(runtimeMetrics.counters.stationStateLastWriteErrors, 1);
  assert.equal(runtimeMetrics.counters.stationStateLastWriteFlushed, 2);
});

for (const contentionError of [
  { code: "ER_LOCK_NOWAIT" },
  { errno: 3_572 },
  { code: "ER_LOCK_WAIT_TIMEOUT" },
  { errno: 1_205 },
]) {
  test(`la contesa ${contentionError.code ?? contentionError.errno} viene differita senza errore applicativo`, async () => {
    let attempts = 0;
    const contexts = [];
    const warnings = [];
    const runtimeMetrics = metrics();
    const queue = createStationLastWriteAtFlush({
      enabled: true,
      intervalMs: 10_000,
      retryBaseMs: 1,
      runtimeMetrics,
      logger: { warn: (message) => warnings.push(message) },
      writeTimestamp: async (payload, context) => {
        attempts += 1;
        contexts.push(context);
        if (attempts === 1) {
          throw Object.assign(new Error("lock non disponibile"), contentionError);
        }
      },
    });
    queue.enqueueFromAppState(state("2026-08-07T12:00:01.000Z"));
    await queue.flushOnce();
    await queue.flushOnce();
    assert.equal(attempts, 2);
    assert.equal(runtimeMetrics.counters.stationStateLastWriteRetries, 1);
    assert.equal(
      runtimeMetrics.counters.stationStateLastWriteMysqlLockContentionDeferrals,
      1,
    );
    assert.equal(runtimeMetrics.counters.stationStateLastWriteErrors || 0, 0);
    assert.equal(runtimeMetrics.counters.stationStateLastWriteFlushed, 1);
    assert.deepEqual(warnings, []);
    assert.ok(contexts.every((context) => context.lockRowsNowait === true));
    assert.ok(contexts.every((context) => context.mode === "flush"));
  });
}

test("un deferral fonde il valore arrivato in-flight e ritenta il massimo", async () => {
  let rejectFirst;
  const firstAttempt = new Promise((resolve, reject) => {
    rejectFirst = reject;
  });
  const observed = [];
  const runtimeMetrics = metrics();
  const queue = createStationLastWriteAtFlush({
    enabled: true,
    intervalMs: 10_000,
    retryBaseMs: 1,
    runtimeMetrics,
    writeTimestamp: async (payload) => {
      observed.push(payload.timestamp);
      if (observed.length === 1) return firstAttempt;
    },
  });
  queue.enqueueFromAppState(state("2026-08-07T12:00:01.000Z"));
  const active = queue.flushOnce();
  await new Promise((resolve) => setImmediate(resolve));
  queue.enqueueFromAppState(state("2026-08-07T12:00:02.000Z"));
  rejectFirst(
    Object.assign(new Error("NOWAIT"), {
      code: "ER_LOCK_NOWAIT",
      errno: 3_572,
    }),
  );
  await active;
  await queue.flushOnce();
  assert.deepEqual(observed, [
    "2026-08-07T12:00:01.000Z",
    "2026-08-07T12:00:02.000Z",
  ]);
  assert.equal(runtimeMetrics.counters.stationStateLastWriteFlushed, 2);
  assert.equal(runtimeMetrics.counters.stationStateLastWriteRetries, 1);
  assert.equal(
    runtimeMetrics.counters.stationStateLastWriteMysqlLockContentionDeferrals,
    1,
  );
  assert.equal(runtimeMetrics.counters.stationStateLastWriteErrors || 0, 0);
});

test("recovery ripara solo quando stationStates e' piu recente e resta bloccante", async () => {
  const now = Date.parse("2026-08-07T12:00:00.000Z");
  const writes = [];
  const contexts = [];
  const runtimeMetrics = metrics();
  const queue = createStationLastWriteAtFlush({
    enabled: true,
    nowMs: () => now,
    runtimeMetrics,
    writeTimestamp: async (payload, context) => {
      writes.push(payload.timestamp);
      contexts.push(context);
    },
  });
  const appState = state("2026-08-07T11:59:00.000Z", [now - 10_000]);
  const repaired = await queue.recoverFromAppState(appState);
  const noop = await queue.recoverFromAppState(appState);
  assert.equal(repaired.recovered, true);
  assert.equal(noop.recovered, false);
  assert.deepEqual(writes, ["2026-08-07T11:59:50.000Z"]);
  assert.deepEqual(contexts, [{ lockRowsNowait: false, mode: "recovery" }]);
  assert.equal(appState.integration.lastWriteAt, "2026-08-07T11:59:50.000Z");
  assert.equal(runtimeMetrics.counters.stationStateLastWriteRecoveryWrites, 1);
  assert.equal(runtimeMetrics.counters.stationStateLastWriteRecoveryNoops, 1);
});

test("recovery distingue stato iniziale vuoto da timestamp corrotti o futuri", async () => {
  const now = Date.parse("2026-08-07T12:00:00.000Z");
  let writes = 0;
  const queue = createStationLastWriteAtFlush({
    enabled: true,
    nowMs: () => now,
    writeTimestamp: async () => {
      writes += 1;
    },
  });
  assert.deepEqual(
    await queue.recoverFromAppState({ integration: { stationStates: [] } }),
    { recovered: false, reason: "empty" },
  );
  await assert.rejects(
    queue.recoverFromAppState(
      state("timestamp-corrotto", []),
    ),
    /timestamp invalido/,
  );
  await assert.rejects(
    queue.recoverFromAppState(state("", [now + 301_000])),
    /timestamp invalido o futuro/,
  );
  assert.equal(writes, 0);
});

test("drain segnala residuo se un writer non termina entro il timeout", async () => {
  const queue = createStationLastWriteAtFlush({
    enabled: true,
    intervalMs: 10_000,
    writeTimestamp: () => new Promise(() => {}),
  });
  queue.enqueueFromAppState(state("2026-08-07T12:00:00.000Z"));
  void queue.flushOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await queue.drain({ timeoutMs: 20 }), {
    drained: false,
    remaining: 1,
  });
});
