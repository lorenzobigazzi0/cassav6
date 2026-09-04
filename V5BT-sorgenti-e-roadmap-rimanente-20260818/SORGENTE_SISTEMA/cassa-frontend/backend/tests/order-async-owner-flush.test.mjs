import assert from "node:assert/strict";
import test from "node:test";

import { createOrderAsyncOwnerFlushForwarder } from "../modules/integration/order-async-owner-flush.js";

function createMetrics() {
  const counters = {};
  const operations = [];
  return {
    counters,
    operations,
    incrementCounter(name, amount = 1) {
      counters[name] = (counters[name] ?? 0) + amount;
    },
    recordOperation(kind, label, ms) {
      operations.push({ kind, label, ms });
    },
  };
}

test("l'api-worker inoltra il flush all'owner e attesta l'accettazione", async () => {
  const metrics = createMetrics();
  const requests = [];
  const forwarder = createOrderAsyncOwnerFlushForwarder({
    enabled: true,
    getRole: () => "api-worker",
    ownerUrl: "http://127.0.0.1:5281/",
    serviceToken: "test-token",
    timeoutMs: 750,
    fetchWithTimeout: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 202, json: async () => ({ ok: true }) };
    },
    runtimeMetrics: metrics,
    logger: { warn() {} },
  });

  const accepted = await forwarder.forward({
    orderIds: ["101", "101"],
    auditEventIds: ["a1"],
    syncSequence: true,
  });

  assert.equal(accepted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:5281/api/internal/orders/async-appstate-flush");
  assert.equal(requests[0].options.timeoutMs, 750);
  assert.equal(requests[0].options.headers["X-Service-Token"], "test-token");
  const payload = JSON.parse(requests[0].options.body);
  assert.deepEqual(payload.options.orderIds, ["101"]);
  assert.deepEqual(payload.options.auditEventIds, ["a1"]);
  assert.equal(payload.options.syncSequence, true);
  assert.equal(metrics.counters.ordersAsyncFlushRemoteOwnerForwarded, 1);
  assert.equal(metrics.counters.ordersAsyncFlushRemoteOwnerAccepted, 1);
  assert.equal(metrics.counters.ordersAsyncFlushRemoteOwnerFallbacks ?? 0, 0);
  assert.equal(metrics.operations[0].label, "orders.asyncFlush.remoteOwner");
});

test("una risposta owner negativa abilita il fallback locale senza propagare errori", async () => {
  const metrics = createMetrics();
  const warnings = [];
  const forwarder = createOrderAsyncOwnerFlushForwarder({
    enabled: true,
    getRole: () => "api-worker",
    ownerUrl: "http://127.0.0.1:5281",
    serviceToken: "test-token",
    fetchWithTimeout: async () => ({
      ok: false,
      status: 503,
      json: async () => ({ ok: false }),
    }),
    runtimeMetrics: metrics,
    logger: { warn(message) { warnings.push(message); } },
  });

  assert.equal(await forwarder.forward({ orderIds: ["102"] }), false);
  assert.equal(metrics.counters.ordersAsyncFlushRemoteOwnerForwarded, 1);
  assert.equal(metrics.counters.ordersAsyncFlushRemoteOwnerAccepted ?? 0, 0);
  assert.equal(metrics.counters.ordersAsyncFlushRemoteOwnerFallbacks, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /fallback locale/);
});

test("il processo owner non tenta un inoltro ricorsivo", async () => {
  const metrics = createMetrics();
  let fetchCalls = 0;
  const forwarder = createOrderAsyncOwnerFlushForwarder({
    enabled: true,
    getRole: () => "owner",
    ownerUrl: "http://127.0.0.1:5281",
    serviceToken: "test-token",
    fetchWithTimeout: async () => {
      fetchCalls += 1;
      throw new Error("non deve essere chiamato");
    },
    runtimeMetrics: metrics,
    logger: { warn() {} },
  });

  assert.equal(await forwarder.forward({ orderIds: ["103"] }), false);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(metrics.counters, {});
});
