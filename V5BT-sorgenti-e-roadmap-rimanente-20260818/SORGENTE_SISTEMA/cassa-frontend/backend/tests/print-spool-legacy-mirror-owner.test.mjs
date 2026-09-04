import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPrintSpoolLegacyMirrorOwnerPayload,
  createPrintSpoolLegacyMirrorOwnerForwarder,
} from "../modules/print-spool/legacy-mirror-owner.js";

function fakeMetrics() {
  const counters = {};
  const operations = [];
  return {
    counters,
    operations,
    incrementCounter(name, amount = 1) {
      counters[name] = (counters[name] ?? 0) + amount;
    },
    recordOperation(...args) {
      operations.push(args);
    },
  };
}

test("normalizza e deduplica gli ID del batch mirror", () => {
  assert.deepEqual(
    buildPrintSpoolLegacyMirrorOwnerPayload([
      { key: "print_1" },
      { id: "print_2" },
      "print_1",
      "",
    ]),
    { jobIds: ["print_1", "print_2"] },
  );
});

test("inoltra il mirror dall'API worker all'owner con soli ID", async () => {
  const metrics = fakeMetrics();
  let request = null;
  const forwarder = createPrintSpoolLegacyMirrorOwnerForwarder({
    enabled: true,
    getRole: () => "api-worker",
    ownerUrl: "http://127.0.0.1:5281/",
    serviceToken: "service-token",
    timeoutMs: 2_000,
    runtimeMetrics: metrics,
    fetchWithTimeout: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 202, json: async () => ({ ok: true }) };
    },
  });

  assert.equal(await forwarder.forward([{ key: "print_1" }, { key: "print_2" }]), true);
  assert.equal(request.url, "http://127.0.0.1:5281/api/internal/print-spool/legacy-mirror");
  assert.deepEqual(JSON.parse(request.options.body), { jobIds: ["print_1", "print_2"] });
  assert.equal(request.options.headers["X-Service-Token"], "service-token");
  assert.equal(metrics.counters.printSpoolLegacyMirrorRemoteOwnerForwarded, 1);
  assert.equal(metrics.counters.printSpoolLegacyMirrorRemoteOwnerAccepted, 1);
  assert.equal(metrics.operations.length, 1);
});

test("usa il fallback locale quando l'owner non risponde", async () => {
  const metrics = fakeMetrics();
  const warnings = [];
  const forwarder = createPrintSpoolLegacyMirrorOwnerForwarder({
    enabled: true,
    getRole: () => "api-worker",
    ownerUrl: "http://127.0.0.1:5281",
    serviceToken: "service-token",
    runtimeMetrics: metrics,
    logger: { warn: (message) => warnings.push(message) },
    fetchWithTimeout: async () => { throw new Error("offline"); },
  });

  assert.equal(await forwarder.forward([{ key: "print_1" }]), false);
  assert.equal(metrics.counters.printSpoolLegacyMirrorRemoteOwnerFallbacks, 1);
  assert.match(warnings[0], /fallback locale/);
});

test("non inoltra fuori dal ruolo api-worker", async () => {
  let called = false;
  const forwarder = createPrintSpoolLegacyMirrorOwnerForwarder({
    enabled: true,
    getRole: () => "api-owner",
    ownerUrl: "http://127.0.0.1:5281",
    serviceToken: "service-token",
    fetchWithTimeout: async () => { called = true; },
  });

  assert.equal(await forwarder.forward([{ key: "print_1" }]), false);
  assert.equal(called, false);
});
