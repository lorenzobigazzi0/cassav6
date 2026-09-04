import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  B4_3_MIN_EVIDENCE_DURATION_MS,
  B4_3_REQUIRED_DURATION_SECONDS,
  B4_REQUIRED_PHYSICAL_NODES,
  B4PhysicalGateError,
  evaluateNodeLog,
  parseNodeLog,
  runSelfTest
} from "../scripts/run-b4-raspberry-servicedata-gate.mjs";

function snapshots() {
  const dbus = {
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
  };
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
    dbus
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
  const stopped = {
    ...started,
    signal: "SIGTERM",
    state: "STOPPED",
    scanner: {
      state: "STOPPED",
      adapter: {
        ...adapter,
        discovering: false,
        observationHandlerAttached: false,
        dbus: {
          ...dbus,
          busConnected: false,
          bluezOwnerAvailable: false,
          discoverySessionAcquired: false,
          activeMatchRules: 0,
          signalsTotal: 500,
          deviceUpdatesTotal: 40,
          stopDiscoveryCallsTotal: 1
        }
      }
    },
    peers: {
      observedAtMs: 90_200,
      streamCount: 1,
      peers: [
        {
          streamKey: "abcdef123456:4",
          advertisement: {
            protocolVersion: 1,
            nodeKind: "handheld",
            rotatingAlias: "abcdef123456",
            bootId: 4,
            capabilities: 15,
            serverReachable: false,
            sequence: 2
          },
          lastRssiDbm: -65
        }
      ]
    },
    peerMetrics: {
      ...peerMetrics,
      observationsTotal: 40,
      acceptedTotal: 40,
      insertedTotal: 2,
      duplicateRefreshedTotal: 38,
      expiredRemovedTotal: 1,
      prunePassesTotal: 90,
      capacityHighWatermarkStreams: 2,
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
      peerHighWatermark: 2,
      lastObservationOutcome: "duplicate-refreshed"
    }
  };
  return { started, stopped };
}

function log(overrides = {}) {
  const fixture = snapshots();
  const started = overrides.started?.(fixture.started) ?? fixture.started;
  const stopped = overrides.stopped?.(fixture.stopped) ?? fixture.stopped;
  return `${JSON.stringify(started)}\n${JSON.stringify(stopped)}\n`;
}

test("B4.3 constants keep the one-advertiser increment separate from B4", () => {
  assert.equal(B4_3_REQUIRED_DURATION_SECONDS, 90);
  assert.equal(B4_3_MIN_EVIDENCE_DURATION_MS, 75_000);
  assert.equal(B4_REQUIRED_PHYSICAL_NODES, 10);
});

test("accepts a complete physical ServiceData lifecycle", () => {
  const report = evaluateNodeLog(log(), {
    generatedAt: "2026-07-20T00:00:00.000Z",
    sourceLogSha256: "a".repeat(64)
  });
  assert.equal(report.verdict, "PASS");
  assert.equal(report.gate.serviceDataLive, "PASS");
  assert.equal(report.gate.controlledPhysicalAdvertisers, 1);
  assert.equal(report.gate.b4TenNodeGate, "PENDING");
  assert.equal(report.serviceData.observationsAccepted, 40);
  assert.equal(report.serviceData.peerStreamHighWatermark, 2);
  assert.deepEqual(report.serviceData.nodeKinds, ["handheld"]);
  assert.deepEqual(report.serviceData.rssiDbm, {
    minimum: -65,
    maximum: -65,
    samples: 1
  });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("abcdef123456"), false);
  assert.equal(serialized.includes("streamKey"), false);
  assert.equal(serialized.includes('"rotatingAlias":'), false);
  assert.equal(serialized.includes('"bootId":'), false);
});

test("accepts station advertisers but rejects non-Android node kinds", () => {
  const stationReport = evaluateNodeLog(
    log({
      stopped: (value) => ({
        ...value,
        peers: {
          ...value.peers,
          peers: value.peers.peers.map((peer) => ({
            ...peer,
            advertisement: {
              ...peer.advertisement,
              nodeKind: "station"
            }
          }))
        }
      })
    })
  );
  assert.deepEqual(stationReport.serviceData.nodeKinds, ["station"]);

  assert.throws(
    () =>
      evaluateNodeLog(
        log({
          stopped: (value) => ({
            ...value,
            peers: {
              ...value.peers,
              peers: value.peers.peers.map((peer) => ({
                ...peer,
                advertisement: {
                  ...peer.advertisement,
                  nodeKind: "raspberry"
                }
              }))
            }
          })
        })
      ),
    (error) =>
      error instanceof B4PhysicalGateError &&
      error.code === "PEER_EVIDENCE_INVALID"
  );
});

test("fails when ServiceData was not accepted", () => {
  assert.throws(
    () =>
      evaluateNodeLog(
        log({
          stopped: (value) => ({
            ...value,
            metrics: {
              ...value.metrics,
              observationsTotal: 0,
              observationsAcceptedTotal: 0,
              peerHighWatermark: 0
            }
          })
        })
      ),
    (error) =>
      error instanceof B4PhysicalGateError &&
      error.code === "SERVICEDATA_NOT_OBSERVED"
  );
});

test("fails on runtime errors and malformed payload metrics", () => {
  for (const mutate of [
    (value) => ({
      ...value,
      metrics: { ...value.metrics, scannerErrorsTotal: 1 }
    }),
    (value) => ({
      ...value,
      peerMetrics: { ...value.peerMetrics, invalidPayloadTotal: 1 }
    }),
    (value) => ({
      ...value,
      scanner: {
        ...value.scanner,
        adapter: {
          ...value.scanner.adapter,
          dbus: { ...value.scanner.adapter.dbus, errorsTotal: 1 }
        }
      }
    })
  ]) {
    assert.throws(
      () => evaluateNodeLog(log({ stopped: mutate })),
      (error) =>
        error instanceof B4PhysicalGateError &&
        error.code === "RUNTIME_ERROR_REPORTED"
    );
  }
});

test("fails on every cleanup resource leak", () => {
  const mutations = [
    (adapter) => ({ ...adapter, discovering: true }),
    (adapter) => ({ ...adapter, observationHandlerAttached: true }),
    (adapter) => ({ ...adapter, retryScheduled: true }),
    (adapter) => ({ ...adapter, trackedDevices: 1 }),
    (adapter) => ({
      ...adapter,
      dbus: { ...adapter.dbus, busConnected: true }
    }),
    (adapter) => ({
      ...adapter,
      dbus: { ...adapter.dbus, activeMatchRules: 1 }
    })
  ];
  for (const mutateAdapter of mutations) {
    assert.throws(
      () =>
        evaluateNodeLog(
          log({
            stopped: (value) => ({
              ...value,
              scanner: {
                ...value.scanner,
                adapter: mutateAdapter(value.scanner.adapter)
              }
            })
          })
        ),
      (error) =>
        error instanceof B4PhysicalGateError &&
        error.code === "CLEANUP_INVALID"
    );
  }
});

test("fails on evidence shorter than 75 seconds", () => {
  assert.throws(
    () =>
      evaluateNodeLog(
        log({
          stopped: (value) => ({
            ...value,
            peers: { ...value.peers, observedAtMs: 75_099 }
          })
        })
      ),
    (error) =>
      error instanceof B4PhysicalGateError &&
      error.code === "DURATION_TOO_SHORT"
  );
});

test("fails when expiry and pruning were not physically exercised", () => {
  assert.throws(
    () =>
      evaluateNodeLog(
        log({
          stopped: (value) => ({
            ...value,
            peerMetrics: {
              ...value.peerMetrics,
              expiredRemovedTotal: 0
            },
            metrics: {
              ...value.metrics,
              peersPrunedTotal: 0
            }
          })
        })
      ),
    (error) =>
      error instanceof B4PhysicalGateError &&
      error.code === "PRUNING_NOT_OBSERVED"
  );
});

test("rejects incomplete, malformed and oversized node logs", () => {
  assert.throws(
    () => parseNodeLog("{}\n"),
    (error) =>
      error instanceof B4PhysicalGateError &&
      error.code === "NODE_LIFECYCLE_INCOMPLETE"
  );
  assert.throws(
    () => parseNodeLog("{not-json}\n"),
    (error) =>
      error instanceof B4PhysicalGateError &&
      error.code === "NODE_LOG_INVALID"
  );
  assert.throws(
    () => parseNodeLog("x".repeat(8 * 1024 * 1024 + 1)),
    (error) =>
      error instanceof B4PhysicalGateError &&
      error.code === "NODE_LOG_INVALID"
  );
});

test("self-test is radio-free and preserves the pending 10-node gate", () => {
  const report = runSelfTest();
  assert.equal(report.verdict, "PASS");
  assert.equal(report.physicalRadioAccessed, false);
  assert.equal(report.activeV4Changes, false);
});

test("module import from stdin does not trigger the CLI entrypoint", () => {
  const moduleUrl = new URL(
    "../scripts/run-b4-raspberry-servicedata-gate.mjs",
    import.meta.url
  ).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-"], {
    input: `await import(${JSON.stringify(moduleUrl)});\n`,
    encoding: "utf8"
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
});
