import assert from "node:assert/strict";
import test from "node:test";

import {
  B5WebPilotError,
  buildB5WebPilotReport,
  runB5WebPilot,
  validateB5WebPilotReport,
} from "./v5bt-b5-web-pilot.mjs";

test("four PING/PONG and clean CLOSE_ACK produce only NON_GATE_PASS", () => {
  const report = buildB5WebPilotReport();
  assert.equal(report.verdict, "NON_GATE_PASS");
  assert.equal(report.lifecycle.reachedActive, true);
  assert.equal(report.lifecycle.pingPongCount, 4);
  assert.equal(report.lifecycle.closeAckCount, 1);
  assert.equal(report.cleanup.connectionsAfterCleanup, 0);
});

test("missing PONG, CLOSE_ACK, cleanup or session continuity fails", () => {
  const cases = [
    { pingPongCount: 3 },
    { closeAckCount: 0 },
    { connectionsAfterCleanup: 1 },
    { browserSessionPreserved: false },
    { errors: 1 },
    { reachedActive: false },
  ];
  for (const options of cases) {
    assert.equal(buildB5WebPilotReport(options).verdict, "NON_GATE_FAIL");
  }
});

test("web transport never authorizes B5 or changes physical gates", () => {
  const report = buildB5WebPilotReport();
  assert.equal(report.transport.bluetoothUsed, false);
  assert.equal(report.transport.raspberryUsed, false);
  assert.equal(report.gates.b4TenPhysicalDeviceGate, "PENDING");
  assert.equal(report.gates.b5HundredSessionGate, "PENDING");
  assert.equal(report.gates.officialSessionsRecorded, 0);
  assert.equal(report.authorization.diagnosticPilotAuthorized, false);
  assert.equal(report.authorization.officialCampaignAuthorized, false);
});

test("validator rejects forged promotion or hardware use", () => {
  for (const mutate of [
    (report) => {
      report.gates.b5HundredSessionGate = "PASS";
    },
    (report) => {
      report.transport.bluetoothUsed = true;
    },
    (report) => {
      report.authorization.diagnosticPilotAuthorized = true;
    },
  ]) {
    const report = JSON.parse(JSON.stringify(buildB5WebPilotReport()));
    mutate(report);
    assert.throws(
      () => validateB5WebPilotReport(report),
      (error) =>
        error instanceof B5WebPilotError &&
        error.code === "REPORT_CONTRACT_INVALID",
    );
  }
});

test("validator rejects malformed failure counters and cleanup fields", () => {
  for (const mutate of [
    (report) => {
      report.lifecycle.reachedActive = "no";
    },
    (report) => {
      report.lifecycle.pingPongCount = -1;
    },
    (report) => {
      report.lifecycle.closeAckCount = 2;
    },
    (report) => {
      report.lifecycle.errors = -1;
    },
    (report) => {
      report.cleanup.connectionsAfterCleanup = -1;
    },
    (report) => {
      report.cleanup.browserSessionPreserved = null;
    },
  ]) {
    const report = JSON.parse(
      JSON.stringify(buildB5WebPilotReport({ reachedActive: false, errors: 1 })),
    );
    mutate(report);
    assert.throws(
      () => validateB5WebPilotReport(report),
      (error) =>
        error instanceof B5WebPilotError &&
        error.code === "REPORT_CONTRACT_INVALID",
    );
  }
});

test("public report contains no endpoint or private identity", () => {
  const serialized = JSON.stringify(buildB5WebPilotReport());
  for (const forbidden of [
    "ws://",
    "127.0.0.1",
    "pos_token",
    "web_palmare_03",
    "v5bt-b4-web-slot-03",
    "/home/",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("loopback state machine completes against an isolated web-compatible client", async () => {
  const storage = new Map([
    ["pos_token", "private-test-token"],
    ["pos_user_id", "private-test-user"],
    ["pos_device_uuid", "private-test-device"],
  ]);
  const page = {
    isClosed: () => false,
    evaluate: async (callback, argument) => {
      const previousWindow = globalThis.window;
      globalThis.window = {
        setTimeout,
        clearTimeout,
        localStorage: { getItem: (key) => storage.get(key) ?? null },
      };
      try {
        return await callback(argument);
      } finally {
        globalThis.window = previousWindow;
      }
    },
  };
  const report = await runB5WebPilot(page, { timeoutMs: 5_000 });
  assert.equal(report.verdict, "NON_GATE_PASS");
  assert.equal(report.lifecycle.pingPongCount, 4);
  assert.equal(report.cleanup.browserSessionPreserved, true);
});
