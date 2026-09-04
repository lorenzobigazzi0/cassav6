#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const B4_3_HARNESS_VERSION = "1.0.0";
export const B4_3_REQUIRED_DURATION_SECONDS = 90;
export const B4_3_MIN_EVIDENCE_DURATION_MS = 75_000;
export const B4_REQUIRED_PHYSICAL_NODES = 10;

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const RASPBERRY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const DEFAULT_NODE_PATH = path.join(RASPBERRY_ROOT, "dist", "index.js");
const EXPECTED_ANDROID_NODE_KINDS = new Set(["handheld", "station"]);

export class B4PhysicalGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "B4PhysicalGateError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new B4PhysicalGateError(code, message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value, code, message) {
  if (!isRecord(value)) fail(code, message);
  return value;
}

function requireBoolean(value, expected, code, message) {
  if (value !== expected) fail(code, message);
}

function requireInteger(value, minimum, code, message) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(code, message);
  }
  return value;
}

function requireFiniteNumber(value, minimum, maximum, code, message) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(code, message);
  }
  return value;
}

function parseJsonLine(line, index) {
  try {
    const parsed = JSON.parse(line);
    return requireRecord(
      parsed,
      "NODE_LOG_INVALID",
      `node log line ${index + 1} is not an object`
    );
  } catch (error) {
    if (error instanceof B4PhysicalGateError) throw error;
    fail(
      "NODE_LOG_INVALID",
      `node log line ${index + 1} is not valid JSON`
    );
  }
}

export function parseNodeLog(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > MAX_LOG_BYTES
  ) {
    fail("NODE_LOG_INVALID", "node log is empty or exceeds the size limit");
  }
  const snapshots = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseJsonLine);
  const started = snapshots.find(
    (snapshot) =>
      snapshot.component === "cassav6-bluetooth-node" &&
      snapshot.state === "DISCOVERING"
  );
  const stopped = [...snapshots].reverse().find(
    (snapshot) =>
      snapshot.component === "cassav6-bluetooth-node" &&
      snapshot.state === "STOPPED"
  );
  if (started === undefined || stopped === undefined) {
    fail(
      "NODE_LIFECYCLE_INCOMPLETE",
      "node log must contain DISCOVERING and STOPPED snapshots"
    );
  }
  return Object.freeze({ started, stopped, snapshots: snapshots.length });
}

function validateStartedSnapshot(started) {
  requireBoolean(
    started.enabled,
    true,
    "NODE_NOT_ENABLED",
    "physical node was not explicitly enabled"
  );
  requireBoolean(
    started.dryRun,
    false,
    "NODE_DRY_RUN",
    "physical node remained in dry-run"
  );
  const scanner = requireRecord(
    started.scanner,
    "STARTUP_INVALID",
    "startup scanner snapshot is missing"
  );
  if (scanner.state !== "RUNNING") {
    fail("STARTUP_INVALID", "scanner did not enter RUNNING");
  }
  const adapter = requireRecord(
    scanner.adapter,
    "STARTUP_INVALID",
    "startup adapter snapshot is missing"
  );
  requireBoolean(
    adapter.discovering,
    true,
    "STARTUP_INVALID",
    "BlueZ discovery did not start"
  );
  requireBoolean(
    adapter.observationHandlerAttached,
    true,
    "STARTUP_INVALID",
    "observation handler was not attached"
  );
  const dbus = requireRecord(
    adapter.dbus,
    "STARTUP_INVALID",
    "startup D-Bus snapshot is missing"
  );
  requireBoolean(
    dbus.busConnected,
    true,
    "STARTUP_INVALID",
    "system bus was not connected"
  );
  requireBoolean(
    dbus.discoverySessionAcquired,
    true,
    "STARTUP_INVALID",
    "BlueZ discovery session was not acquired"
  );
  requireInteger(
    dbus.activeMatchRules,
    1,
    "STARTUP_INVALID",
    "BlueZ match rules were not installed"
  );
}

function validateStoppedSnapshot(stopped) {
  const scanner = requireRecord(
    stopped.scanner,
    "CLEANUP_INVALID",
    "shutdown scanner snapshot is missing"
  );
  if (scanner.state !== "STOPPED") {
    fail("CLEANUP_INVALID", "scanner did not enter STOPPED");
  }
  const adapter = requireRecord(
    scanner.adapter,
    "CLEANUP_INVALID",
    "shutdown adapter snapshot is missing"
  );
  requireBoolean(
    adapter.discovering,
    false,
    "CLEANUP_INVALID",
    "BlueZ discovery remained active"
  );
  requireBoolean(
    adapter.observationHandlerAttached,
    false,
    "CLEANUP_INVALID",
    "observation handler remained attached"
  );
  requireBoolean(
    adapter.recovering,
    false,
    "CLEANUP_INVALID",
    "adapter remained in recovery"
  );
  requireBoolean(
    adapter.retryScheduled,
    false,
    "CLEANUP_INVALID",
    "adapter retained a retry timer"
  );
  requireInteger(
    adapter.trackedDevices,
    0,
    "CLEANUP_INVALID",
    "trackedDevices is invalid"
  );
  if (adapter.trackedDevices !== 0) {
    fail("CLEANUP_INVALID", "adapter retained tracked devices");
  }
  const dbus = requireRecord(
    adapter.dbus,
    "CLEANUP_INVALID",
    "shutdown D-Bus snapshot is missing"
  );
  requireBoolean(
    dbus.busConnected,
    false,
    "CLEANUP_INVALID",
    "system bus remained connected"
  );
  requireBoolean(
    dbus.discoverySessionAcquired,
    false,
    "CLEANUP_INVALID",
    "BlueZ discovery session remained acquired"
  );
  requireInteger(
    dbus.activeMatchRules,
    0,
    "CLEANUP_INVALID",
    "activeMatchRules is invalid"
  );
  if (dbus.activeMatchRules !== 0) {
    fail("CLEANUP_INVALID", "BlueZ match rules leaked");
  }
  if (
    requireInteger(
      dbus.stopDiscoveryCallsTotal,
      1,
      "CLEANUP_INVALID",
      "StopDiscovery was not called"
    ) < 1
  ) {
    fail("CLEANUP_INVALID", "StopDiscovery was not called");
  }
  return { adapter, dbus };
}

function validateErrorMetrics(stopped, adapter, dbus) {
  const metrics = requireRecord(
    stopped.metrics,
    "METRICS_INVALID",
    "node metrics are missing"
  );
  const peerMetrics = requireRecord(
    stopped.peerMetrics,
    "METRICS_INVALID",
    "peer metrics are missing"
  );
  const zeroMetrics = [
    [metrics.adapterErrorsTotal, "adapterErrorsTotal"],
    [metrics.scannerErrorsTotal, "scannerErrorsTotal"],
    [metrics.maintenanceFailuresTotal, "maintenanceFailuresTotal"],
    [metrics.lateObservationsIgnoredTotal, "lateObservationsIgnoredTotal"],
    [adapter.dbusErrorsTotal, "adapter.dbusErrorsTotal"],
    [adapter.observationHandlerErrorsTotal, "observationHandlerErrorsTotal"],
    [dbus.errorsTotal, "dbus.errorsTotal"],
    [peerMetrics.invalidObservationTotal, "invalidObservationTotal"],
    [peerMetrics.invalidPayloadTotal, "invalidPayloadTotal"],
    [peerMetrics.sequenceConflictTotal, "sequenceConflictTotal"],
    [peerMetrics.capacityRejectedTotal, "capacityRejectedTotal"]
  ];
  for (const [value, name] of zeroMetrics) {
    requireInteger(
      value,
      0,
      "METRICS_INVALID",
      `${name} is not a nonnegative integer`
    );
    if (value !== 0) {
      fail("RUNTIME_ERROR_REPORTED", `${name} is not zero`);
    }
  }
  return { metrics, peerMetrics };
}

function validatePhysicalEvidence(stopped, metrics, peerMetrics, dbus) {
  const observationsAccepted = requireInteger(
    metrics.observationsAcceptedTotal,
    1,
    "SERVICEDATA_NOT_OBSERVED",
    "no valid ServiceData observation was accepted"
  );
  const observationsTotal = requireInteger(
    metrics.observationsTotal,
    observationsAccepted,
    "METRICS_INVALID",
    "observation totals are inconsistent"
  );
  const observationsRejected = requireInteger(
    metrics.observationsRejectedTotal,
    0,
    "METRICS_INVALID",
    "rejected observation count is invalid"
  );
  if (observationsAccepted + observationsRejected !== observationsTotal) {
    fail("METRICS_INVALID", "accepted and rejected observation totals diverge");
  }
  requireInteger(
    dbus.deviceUpdatesTotal,
    1,
    "SERVICEDATA_NOT_OBSERVED",
    "BlueZ emitted no Device1 updates"
  );
  const peerHighWatermark = requireInteger(
    metrics.peerHighWatermark,
    1,
    "SERVICEDATA_NOT_OBSERVED",
    "peer registry never contained a V1 stream"
  );
  const insertedStreams = requireInteger(
    peerMetrics.insertedTotal,
    1,
    "SERVICEDATA_NOT_OBSERVED",
    "peer registry inserted no V1 stream"
  );
  const maintenanceRuns = requireInteger(
    metrics.maintenanceRunsTotal,
    1,
    "MAINTENANCE_NOT_OBSERVED",
    "maintenance loop did not run"
  );
  const prunePasses = requireInteger(
    peerMetrics.prunePassesTotal,
    1,
    "MAINTENANCE_NOT_OBSERVED",
    "peer pruning did not run"
  );
  const expiredStreamsRemoved = requireInteger(
    peerMetrics.expiredRemovedTotal,
    1,
    "PRUNING_NOT_OBSERVED",
    "no expired peer stream was removed"
  );
  const peersPruned = requireInteger(
    metrics.peersPrunedTotal,
    1,
    "PRUNING_NOT_OBSERVED",
    "node lifecycle did not record a pruned peer stream"
  );
  const peers = requireRecord(
    stopped.peers,
    "PEER_EVIDENCE_INVALID",
    "peer snapshot is missing"
  );
  if (!Array.isArray(peers.peers) || peers.peers.length < 1) {
    fail(
      "PEER_EVIDENCE_INVALID",
      "shutdown snapshot contains no current Android peer"
    );
  }

  const nodeKinds = new Set();
  const rssiSamples = [];
  for (const peer of peers.peers) {
    const peerRecord = requireRecord(
      peer,
      "PEER_EVIDENCE_INVALID",
      "peer entry is invalid"
    );
    const advertisement = requireRecord(
      peerRecord.advertisement,
      "PEER_EVIDENCE_INVALID",
      "peer advertisement is missing"
    );
    if (!EXPECTED_ANDROID_NODE_KINDS.has(advertisement.nodeKind)) {
      fail(
        "PEER_EVIDENCE_INVALID",
        "controlled advertiser is not an Android handheld or station"
      );
    }
    if (
      !Number.isSafeInteger(advertisement.capabilities) ||
      (advertisement.capabilities & 0x0f) !== 0x0f
    ) {
      fail(
        "PEER_EVIDENCE_INVALID",
        "controlled advertiser lacks required B2 capabilities"
      );
    }
    nodeKinds.add(advertisement.nodeKind);
    rssiSamples.push(
      requireFiniteNumber(
        peerRecord.lastRssiDbm,
        -127,
        20,
        "RSSI_INVALID",
        "peer RSSI is outside the valid range"
      )
    );
  }

  return {
    observationsTotal,
    observationsAccepted,
    observationsRejected,
    bluezDeviceUpdates: dbus.deviceUpdatesTotal,
    peerStreamHighWatermark: peerHighWatermark,
    insertedAnonymousStreams: insertedStreams,
    currentAnonymousStreams: peers.peers.length,
    nodeKinds: [...nodeKinds].sort(),
    rssiDbm: {
      minimum: Math.min(...rssiSamples),
      maximum: Math.max(...rssiSamples),
      samples: rssiSamples.length
    },
    maintenanceRuns,
    prunePasses,
    expiredStreamsRemoved,
    peersPruned
  };
}

function buildChecks(evidence) {
  return [
    {
      id: "bluez.servicedata_callback",
      status: "PASS",
      detail: `${evidence.observationsAccepted} valid observations accepted`
    },
    {
      id: "peer.android_kind",
      status: "PASS",
      detail: evidence.nodeKinds.join(",")
    },
    {
      id: "peer.rssi",
      status: "PASS",
      detail: `${evidence.rssiDbm.minimum}..${evidence.rssiDbm.maximum} dBm`
    },
    {
      id: "peer.maintenance",
      status: "PASS",
      detail:
        `${evidence.prunePasses} prune passes, ` +
        `${evidence.expiredStreamsRemoved} expired streams removed`
    },
    {
      id: "bluez.cleanup",
      status: "PASS",
      detail: "scanner, D-Bus session, match rules and retry timer released"
    }
  ];
}

export function evaluateNodeLog(
  rawLog,
  {
    generatedAt = new Date().toISOString(),
    sourceLogSha256 = crypto
      .createHash("sha256")
      .update(rawLog, "utf8")
      .digest("hex")
  } = {}
) {
  const { started, stopped, snapshots } = parseNodeLog(rawLog);
  validateStartedSnapshot(started);
  const { adapter, dbus } = validateStoppedSnapshot(stopped);
  const { metrics, peerMetrics } = validateErrorMetrics(
    stopped,
    adapter,
    dbus
  );
  const evidence = validatePhysicalEvidence(
    stopped,
    metrics,
    peerMetrics,
    dbus
  );
  const startedPeers = requireRecord(
    started.peers,
    "DURATION_INVALID",
    "startup peer clock is missing"
  );
  const stoppedPeers = requireRecord(
    stopped.peers,
    "DURATION_INVALID",
    "shutdown peer clock is missing"
  );
  const durationMs =
    requireFiniteNumber(
      stoppedPeers.observedAtMs,
      0,
      Number.MAX_SAFE_INTEGER,
      "DURATION_INVALID",
      "shutdown peer clock is invalid"
    ) -
    requireFiniteNumber(
      startedPeers.observedAtMs,
      0,
      Number.MAX_SAFE_INTEGER,
      "DURATION_INVALID",
      "startup peer clock is invalid"
    );
  if (durationMs < B4_3_MIN_EVIDENCE_DURATION_MS) {
    fail(
      "DURATION_TOO_SHORT",
      `physical evidence must span at least ${B4_3_MIN_EVIDENCE_DURATION_MS} ms`
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B4_3_HARNESS_VERSION,
    product: "V6",
    phase: "B4.3",
    generatedAt,
    mode: "PHYSICAL_SINGLE_ADVERTISER",
    verdict: "PASS",
    scope:
      "Physical Android ServiceData callback on Raspberry; the 10-node B4 gate remains separate",
    sourceLogSha256,
    lifecycle: {
      snapshots,
      durationMs,
      startupState: "DISCOVERING",
      shutdownState: "STOPPED",
      shutdownSignal: stopped.signal ?? null
    },
    serviceData: evidence,
    cleanup: {
      discovering: false,
      busConnected: false,
      discoverySessionAcquired: false,
      activeMatchRules: 0,
      trackedDevices: 0,
      retryScheduled: false,
      stopDiscoveryCalls: dbus.stopDiscoveryCallsTotal
    },
    errors: {
      adapter: 0,
      scanner: 0,
      maintenance: 0,
      dbus: 0,
      observationHandler: 0,
      invalidPayload: 0,
      sequenceConflict: 0
    },
    checks: buildChecks(evidence),
    gate: {
      serviceDataLive: "PASS",
      controlledPhysicalAdvertisers: 1,
      requiredDistinctPhysicalNodes: B4_REQUIRED_PHYSICAL_NODES,
      b4TenNodeGate: "PENDING",
      reason:
        "One controlled physical Android advertiser is validated; aliases are not counted as distinct devices"
    },
    privacy: {
      bluetoothAddressesIncluded: false,
      rotatingAliasesIncluded: false,
      stableNodeIdsIncluded: false,
      rawPayloadsIncluded: false
    },
    activeV4Changes: false
  });
}

function parseArguments(argv) {
  const options = {
    mode: "LIVE",
    output: null,
    rawLog: null,
    evaluateLog: null,
    nodePath: DEFAULT_NODE_PATH,
    help: false,
    selfTest: false
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) {
      fail("INVALID_ARGUMENT", `duplicate option: ${argument}`);
    }
    seen.add(argument);
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--self-test") {
      options.selfTest = true;
      continue;
    }
    if (
      !["--output", "--raw-log", "--evaluate-log", "--node"].includes(
        argument
      )
    ) {
      fail("INVALID_ARGUMENT", `unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("INVALID_ARGUMENT", `missing value for ${argument}`);
    }
    index += 1;
    if (argument === "--output") options.output = path.resolve(value);
    if (argument === "--raw-log") options.rawLog = path.resolve(value);
    if (argument === "--evaluate-log") {
      options.evaluateLog = path.resolve(value);
      options.mode = "EVALUATE_LOG";
    }
    if (argument === "--node") options.nodePath = path.resolve(value);
  }
  if ((options.help || options.selfTest) && argv.length !== 1) {
    fail(
      "INVALID_ARGUMENT",
      "--help and --self-test cannot be combined with other options"
    );
  }
  if (options.evaluateLog !== null && options.rawLog !== null) {
    fail(
      "INVALID_ARGUMENT",
      "--raw-log is only valid for a live physical run"
    );
  }
  return Object.freeze(options);
}

function atomicWrite(destination, content) {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeReport(report, destination = null) {
  const formatted = `${JSON.stringify(report, null, 2)}\n`;
  if (destination !== null) atomicWrite(destination, formatted);
  process.stdout.write(formatted);
}

async function runLiveNode(options) {
  if (!fs.existsSync(options.nodePath)) {
    fail("NODE_ENTRYPOINT_MISSING", "Bluetooth node entrypoint is missing");
  }
  const startedAt = Date.now();
  const child = spawn(process.execPath, [options.nodePath], {
    cwd: RASPBERRY_ROOT,
    env: {
      ...process.env,
      CASSA_BT_FEATURE_ENABLED: "1",
      CASSA_BT_DRY_RUN: "0",
      CASSA_BT_ADAPTER: process.env.CASSA_BT_ADAPTER || "hci0",
      CASSA_BT_NODE_ID: process.env.CASSA_BT_NODE_ID || "raspberry-main",
      CASSA_BT_STORE_ID: process.env.CASSA_BT_STORE_ID || "store-1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderrBytes = 0;
  let terminationRequested = false;
  let forcedKillTimer = null;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout, "utf8") > MAX_LOG_BYTES) {
      child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
  });

  const exit = new Promise((resolve, reject) => {
    child.once("error", () => {
      reject(
        new B4PhysicalGateError(
          "NODE_START_FAILED",
          "Bluetooth node could not be started"
        )
      );
    });
    child.once("close", (code, signal) => {
      if (forcedKillTimer !== null) clearTimeout(forcedKillTimer);
      resolve({ code, signal });
    });
  });

  const measurementTimer = setTimeout(() => {
    terminationRequested = true;
    child.kill("SIGTERM");
    forcedKillTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, SHUTDOWN_TIMEOUT_MS);
  }, B4_3_REQUIRED_DURATION_SECONDS * 1_000);

  const result = await exit;
  clearTimeout(measurementTimer);
  if (!terminationRequested) {
    fail(
      "NODE_EXITED_EARLY",
      "Bluetooth node exited before the required physical duration"
    );
  }
  if (result.signal === "SIGKILL") {
    fail("NODE_SHUTDOWN_TIMEOUT", "Bluetooth node did not stop cleanly");
  }
  if (result.code !== 0 && result.code !== null) {
    fail("NODE_EXIT_FAILED", "Bluetooth node returned a failure exit code");
  }
  if (stderrBytes !== 0) {
    fail("NODE_STDERR_NOT_EMPTY", "Bluetooth node emitted stderr output");
  }
  if (options.rawLog !== null) atomicWrite(options.rawLog, stdout);
  const report = evaluateNodeLog(stdout);
  return Object.freeze({
    ...report,
    measurement: {
      requiredDurationSeconds: B4_3_REQUIRED_DURATION_SECONDS,
      wallClockDurationMs: Date.now() - startedAt
    }
  });
}

function fixtureLog() {
  const adapter = {
    adapterName: "hci0",
    adapterPath: "/org/bluez/hci0",
    transport: "@jellybrick/dbus-next",
    discovering: true,
    recovering: false,
    retryScheduled: false,
    observationHandlerAttached: true,
    trackedDevices: 0,
    reconnectAttemptsTotal: 0,
    reconnectSuccessesTotal: 0,
    dbusErrorsTotal: 0,
    observationHandlerErrorsTotal: 0,
    dbus: {
      transport: "@jellybrick/dbus-next",
      busConnected: true,
      bluezOwnerAvailable: true,
      discoverySessionAcquired: true,
      activeMatchRules: 4,
      signalsTotal: 10,
      deviceUpdatesTotal: 0,
      ownerChangesTotal: 0,
      errorsTotal: 0,
      lastErrorCategory: null,
      lastErrorCode: null,
      startDiscoveryCallsTotal: 1,
      stopDiscoveryCallsTotal: 0
    }
  };
  const peerMetrics = {
    observationsTotal: 0,
    acceptedTotal: 0,
    rejectedTotal: 0,
    insertedTotal: 0,
    duplicateRefreshedTotal: 0,
    newerReplacedTotal: 0,
    belowRssiFloorTotal: 0,
    invalidObservationTotal: 0,
    invalidPayloadTotal: 0,
    sequenceConflictTotal: 0,
    olderRejectedTotal: 0,
    ambiguousRejectedTotal: 0,
    capacityRejectedTotal: 0,
    newStreamRateRejectedTotal: 0,
    capacityEvictedTotal: 0,
    newStreamAttemptsTotal: 0,
    newStreamAdmissionsTotal: 0,
    newStreamWindowsStartedTotal: 0,
    expiredRemovedTotal: 0,
    prunePassesTotal: 0,
    clockRegressionTotal: 0,
    capacityHighWatermarkStreams: 0,
    currentStreams: 0
  };
  const metrics = {
    state: "DISCOVERING",
    stateTransitionsTotal: 3,
    startAttemptsTotal: 1,
    startsTotal: 1,
    startFailuresTotal: 0,
    stopsTotal: 0,
    adapterErrorsTotal: 0,
    scannerErrorsTotal: 0,
    maintenanceFailuresTotal: 0,
    maintenanceRunsTotal: 0,
    peersPrunedTotal: 0,
    observationsTotal: 0,
    observationsAcceptedTotal: 0,
    observationsRejectedTotal: 0,
    lateObservationsIgnoredTotal: 0,
    currentPeers: 0,
    peerHighWatermark: 0,
    lastObservationOutcome: null
  };
  const started = {
    component: "cassav6-bluetooth-node",
    state: "DISCOVERING",
    enabled: true,
    dryRun: false,
    scanner: { state: "RUNNING", adapter },
    peers: { observedAtMs: 100, streamCount: 0, peers: [] },
    peerMetrics,
    metrics
  };
  const stoppedAdapter = {
    ...adapter,
    discovering: false,
    observationHandlerAttached: false,
    dbus: {
      ...adapter.dbus,
      busConnected: false,
      bluezOwnerAvailable: false,
      discoverySessionAcquired: false,
      activeMatchRules: 0,
      signalsTotal: 500,
      deviceUpdatesTotal: 40,
      stopDiscoveryCallsTotal: 1
    }
  };
  const stopped = {
    ...started,
    signal: "SIGTERM",
    state: "STOPPED",
    scanner: { state: "STOPPED", adapter: stoppedAdapter },
    peers: {
      observedAtMs: 90_200,
      streamCount: 1,
      peers: [
        {
          streamKey: "redacted-in-report",
          advertisement: {
            protocolVersion: 1,
            nodeKind: "handheld",
            rotatingAlias: "000000000001",
            bootId: 1,
            capabilities: 15,
            serverReachable: false,
            sequence: 1
          },
          lastRssiDbm: -60
        }
      ]
    },
    peerMetrics: {
      ...peerMetrics,
      observationsTotal: 40,
      acceptedTotal: 40,
      insertedTotal: 1,
      duplicateRefreshedTotal: 39,
      expiredRemovedTotal: 1,
      prunePassesTotal: 90,
      currentStreams: 1
    },
    metrics: {
      ...metrics,
      state: "STOPPED",
      stateTransitionsTotal: 5,
      stopsTotal: 1,
      maintenanceRunsTotal: 90,
      peersPrunedTotal: 1,
      observationsTotal: 40,
      observationsAcceptedTotal: 40,
      currentPeers: 1,
      peerHighWatermark: 1,
      lastObservationOutcome: "duplicate-refreshed"
    }
  };
  return `${JSON.stringify(started)}\n${JSON.stringify(stopped)}\n`;
}

export function runSelfTest() {
  const report = evaluateNodeLog(fixtureLog(), {
    generatedAt: "2026-07-20T00:00:00.000Z"
  });
  if (
    report.verdict !== "PASS" ||
    report.gate.serviceDataLive !== "PASS" ||
    report.gate.b4TenNodeGate !== "PENDING"
  ) {
    fail("SELF_TEST_FAILED", "B4.3 self-test did not preserve gate semantics");
  }
  return Object.freeze({
    schemaVersion: 1,
    harnessVersion: B4_3_HARNESS_VERSION,
    product: "V6",
    phase: "B4.3",
    mode: "SELF_TEST",
    verdict: "PASS",
    checks: report.checks.length,
    physicalRadioAccessed: false,
    activeV4Changes: false
  });
}

function usage() {
  return [
    "V6 B4.3 Raspberry ServiceData gate",
    "",
    "Usage:",
    "  node scripts/run-b4-raspberry-servicedata-gate.mjs --self-test",
    "  node scripts/run-b4-raspberry-servicedata-gate.mjs --evaluate-log FILE [--output FILE]",
    "  node scripts/run-b4-raspberry-servicedata-gate.mjs --output FILE --raw-log FILE",
    "",
    `A live run lasts exactly ${B4_3_REQUIRED_DURATION_SECONDS} seconds.`,
    "It validates one controlled Android advertiser only.",
    `The final B4 gate still requires ${B4_REQUIRED_PHYSICAL_NODES} distinct physical nodes.`
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (options.selfTest) {
      writeReport(runSelfTest(), options.output);
      return 0;
    }
    const report =
      options.mode === "EVALUATE_LOG"
        ? evaluateNodeLog(
            fs.readFileSync(options.evaluateLog, {
              encoding: "utf8",
              flag: "r"
            })
          )
        : await runLiveNode(options);
    writeReport(report, options.output);
    return 0;
  } catch (error) {
    const safeError =
      error instanceof B4PhysicalGateError
        ? error
        : new B4PhysicalGateError(
            "B4_PHYSICAL_GATE_FAILED",
            "B4.3 physical gate failed"
          );
    writeReport(
      {
        schemaVersion: 1,
        harnessVersion: B4_3_HARNESS_VERSION,
        product: "V6",
        phase: "B4.3",
        generatedAt: new Date().toISOString(),
        mode: options?.mode ?? "UNKNOWN",
        verdict: "FAIL",
        failure: {
          code: safeError.code,
          message: safeError.message
        },
        activeV4Changes: false
      },
      options?.output ?? null
    );
    return 1;
  }
}

const invokedPath =
  process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (
  invokedPath !== null &&
  fs.existsSync(invokedPath) &&
  fs.realpathSync(fileURLToPath(import.meta.url)) ===
    fs.realpathSync(invokedPath)
) {
  process.exitCode = await main();
}
