import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  BLUETOOTH_METRIC_STATUSES,
  BLUETOOTH_METRICS_MAX_REPORT_BYTES,
  BLUETOOTH_METRICS_REPORTER_STATES,
  BluetoothMetricsReporterError,
  BluetoothMetricsReporterV1
} from "../dist/metrics/BluetoothMetricsReporterV1.js";
import { MetricsRegistry } from "../dist/metrics/MetricsRegistry.js";

class FakeScheduler {
  nextId = 1;
  handlers = new Map();
  intervals = [];
  failSet = false;

  set(handler, intervalMs) {
    if (this.failSet) throw new Error("simulated scheduler failure");
    const id = this.nextId++;
    this.handlers.set(id, handler);
    this.intervals.push(intervalMs);
    return id;
  }

  clear(handle) {
    this.handlers.delete(handle);
  }

  runAll() {
    for (const handler of [...this.handlers.values()]) handler();
  }

  get activeCount() {
    return this.handlers.size;
  }
}

function nodeMetrics(peerExpiryCount = 3) {
  const registry = new MetricsRegistry();
  registry.recordMaintenance(peerExpiryCount, 0);
  return {
    ...registry.snapshot(),
    nodeId: "private-node-id",
    macAddress: "aa:bb:cc:dd:ee:ff",
    payload: "private-payload",
    secret: "private-secret"
  };
}

function transportMetrics(overrides = {}) {
  return {
    framesTx: 11,
    framesRx: 12,
    retries: 2,
    duplicates: 1,
    outboxDepth: 4,
    devicePath: "/org/bluez/private/device",
    token: "private-token",
    ...overrides
  };
}

function createReporter(overrides = {}) {
  let now = 1_000;
  const scheduler = overrides.scheduler ?? new FakeScheduler();
  const reports = [];
  const fatals = [];
  const reporter = new BluetoothMetricsReporterV1({
    intervalMs: 10_000,
    nodeMetrics: () => nodeMetrics(),
    transportMetrics: () => transportMetrics(),
    publish: (report) => reports.push(report),
    scheduler,
    now: () => now,
    onFatal: (error) => fatals.push(error),
    ...overrides
  });
  return {
    reporter,
    scheduler,
    reports,
    fatals,
    setNow(value) {
      now = value;
    }
  };
}

test("periodic reporter emits a bounded fixed-schema redacted snapshot", () => {
  const fixture = createReporter();
  const started = fixture.reporter.start();
  assert.equal(started.state, BLUETOOTH_METRICS_REPORTER_STATES.RUNNING);
  assert.equal(started.timerActive, true);
  assert.deepEqual(fixture.scheduler.intervals, [10_000]);

  fixture.setNow(11_000);
  fixture.scheduler.runAll();
  assert.equal(fixture.reports.length, 1);
  const report = fixture.reports[0];
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.source, "V6_RASPBERRY_BLUETOOTH_METRICS");
  assert.equal(report.sampleSequence, 1);
  assert.equal(report.sampledAtEpochMs, 11_000);
  assert.equal(report.reporterStartedAtEpochMs, 1_000);
  assert.deepEqual(report.metrics.framesTx, {
    status: BLUETOOTH_METRIC_STATUSES.AVAILABLE,
    value: 11
  });
  assert.deepEqual(report.metrics.framesRx, {
    status: BLUETOOTH_METRIC_STATUSES.AVAILABLE,
    value: 12
  });
  assert.deepEqual(report.metrics.retries, {
    status: BLUETOOTH_METRIC_STATUSES.AVAILABLE,
    value: 2
  });
  assert.deepEqual(report.metrics.duplicates, {
    status: BLUETOOTH_METRIC_STATUSES.AVAILABLE,
    value: 1
  });
  assert.deepEqual(report.metrics.outboxDepth, {
    status: BLUETOOTH_METRIC_STATUSES.AVAILABLE,
    value: 4
  });
  assert.deepEqual(report.metrics.peerExpiryCount, {
    status: BLUETOOTH_METRIC_STATUSES.AVAILABLE,
    value: 3
  });
  for (const field of [
    "discoveryLatencyMs",
    "connectLatencyMs",
    "authLatencyMs",
    "mtu",
    "rssi",
    "sessionDuration",
    "closeReason"
  ]) {
    assert.deepEqual(report.metrics[field], {
      status: BLUETOOTH_METRIC_STATUSES.UNAVAILABLE
    });
  }

  const encoded = JSON.stringify(report);
  assert.ok(Buffer.byteLength(encoded, "utf8") <= BLUETOOTH_METRICS_MAX_REPORT_BYTES);
  assert.doesNotMatch(
    encoded,
    /nodeId|storeId|macAddress|devicePath|payload|secret|token|aa:bb/iu
  );
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.metrics), true);

  const scheduledHandler = [...fixture.scheduler.handlers.values()][0];
  fixture.reporter.stop();
  fixture.reporter.stop();
  assert.equal(fixture.scheduler.activeCount, 0);
  assert.equal(fixture.reporter.snapshot().timerActive, false);
  scheduledHandler();
  assert.equal(fixture.reports.length, 1);
});

test("missing transport metrics use explicit UNAVAILABLE markers", () => {
  const fixture = createReporter({ transportMetrics: () => null });
  fixture.reporter.start();
  fixture.setNow(2_000);
  fixture.scheduler.runAll();
  const metrics = fixture.reports[0].metrics;
  for (const field of [
    "framesTx",
    "framesRx",
    "retries",
    "duplicates",
    "outboxDepth"
  ]) {
    assert.deepEqual(metrics[field], {
      status: BLUETOOTH_METRIC_STATUSES.UNAVAILABLE
    });
  }
  assert.equal(metrics.peerExpiryCount.status, BLUETOOTH_METRIC_STATUSES.AVAILABLE);
  fixture.reporter.stop();
  assert.equal(fixture.scheduler.activeCount, 0);
});

test("clock regression fails closed and releases the periodic timer", () => {
  const fixture = createReporter();
  fixture.reporter.start();
  fixture.setNow(999);
  fixture.scheduler.runAll();
  assert.equal(
    fixture.reporter.snapshot().state,
    BLUETOOTH_METRICS_REPORTER_STATES.FAILED
  );
  assert.equal(fixture.reporter.snapshot().timerActive, false);
  assert.equal(fixture.scheduler.activeCount, 0);
  assert.equal(fixture.reports.length, 0);
  assert.equal(fixture.fatals.length, 1);
  assert.equal(fixture.fatals[0].code, "CLOCK_REGRESSION");
  fixture.scheduler.runAll();
  assert.equal(fixture.fatals.length, 1);
});

test("invalid source data and sink failures both fail closed", () => {
  for (const overrides of [
    {
      nodeMetrics: () => nodeMetrics(-1)
    },
    {
      transportMetrics: () => ({
        framesRx: 1,
        retries: 0,
        duplicates: 0,
        outboxDepth: 0
      })
    },
    {
      publish: () => {
        throw new Error("simulated sink failure");
      }
    }
  ]) {
    const fixture = createReporter(overrides);
    fixture.reporter.start();
    fixture.setNow(2_000);
    fixture.scheduler.runAll();
    assert.equal(
      fixture.reporter.snapshot().state,
      BLUETOOTH_METRICS_REPORTER_STATES.FAILED
    );
    assert.equal(fixture.reporter.snapshot().timerActive, false);
    assert.equal(fixture.scheduler.activeCount, 0);
    assert.equal(fixture.fatals.length, 1);
  }
});

test("configuration and scheduler startup failures leave no timer", () => {
  assert.throws(
    () => createReporter({ intervalMs: 999 }),
    (error) =>
      error instanceof BluetoothMetricsReporterError &&
      error.code === "INVALID_REPORTER_CONFIGURATION"
  );
  assert.throws(
    () => createReporter({ intervalMs: 60_001 }),
    (error) =>
      error instanceof BluetoothMetricsReporterError &&
      error.code === "INVALID_REPORTER_CONFIGURATION"
  );

  const scheduler = new FakeScheduler();
  scheduler.failSet = true;
  const fixture = createReporter({ scheduler });
  assert.throws(
    () => fixture.reporter.start(),
    (error) =>
      error instanceof BluetoothMetricsReporterError &&
      error.code === "REPORTER_START_FAILED"
  );
  assert.equal(fixture.reporter.snapshot().timerActive, false);
  assert.equal(scheduler.activeCount, 0);
});

test("disabled and dry-run entrypoints never keep a metrics timer alive", () => {
  const baseEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("CASSA_BT_"))
  );
  for (const [environment, expectedState] of [
    [baseEnvironment, "DISABLED"],
    [
      {
        ...baseEnvironment,
        CASSA_BT_FEATURE_ENABLED: "1",
        CASSA_BT_DRY_RUN: "1"
      },
      "DRY_RUN"
    ]
  ]) {
    const result = spawnSync(process.execPath, ["dist/index.js"], {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
      timeout: 2_000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).state, expectedState);
    assert.doesNotMatch(result.stdout, /V6_RASPBERRY_BLUETOOTH_METRICS/u);
  }
});
