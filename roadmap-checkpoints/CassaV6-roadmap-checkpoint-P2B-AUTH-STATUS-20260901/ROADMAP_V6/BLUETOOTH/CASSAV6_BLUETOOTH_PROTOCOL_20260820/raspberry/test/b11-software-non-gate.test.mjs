import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  B11SoftwareNonGateError,
  B11_HYBRID_ANDROID_PAIR_COUNT,
  B11_HYBRID_ANDROID_RASPBERRY_LINK_COUNT,
  B11_HYBRID_BLUETOOTH_NODE_COUNT,
  B11_HYBRID_LINK_COUNT,
  B11_HYBRID_NON_GATE_MODE,
  B11_HYBRID_TOTAL_ACTOR_COUNT,
  B11_REQUIRED_CYCLES_PER_PAIR,
  B11_REQUIRED_NODE_COUNT,
  B11_REQUIRED_SOAK_MS,
  buildB11SoftwareNonGatePlan,
  parseB11SoftwareNonGateArguments,
  runB11SoftwareNonGate,
  validateB11SoftwareNonGateReport,
  writeB11SoftwareNonGateReport
} from "../scripts/run-b11-software-non-gate.mjs";

const HISTORICAL_SOAK_DIGEST =
  "2527641f52ad15459ede6debe628c9dd392b53e774ca39179c59dc95b3adb3a1";
let historicalSoakReportPromise;
let hybridReportPromise;

function historicalSoakReport() {
  historicalSoakReportPromise ??= runB11SoftwareNonGate({ profile: "soak" });
  return historicalSoakReportPromise;
}

function hybridReport() {
  hybridReportPromise ??= runB11SoftwareNonGate({ profile: "hybrid" });
  return hybridReportPromise;
}

function recalculateDigest(report) {
  const { reportDigest: _discarded, ...body } = report;
  return {
    ...body,
    reportDigest: createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex")
  };
}

test("standard soak plan freezes ten nodes and 4500 useful-pair cycles", () => {
  const plan = buildB11SoftwareNonGatePlan({ profile: "soak" });
  assert.equal(plan.nodeCount, B11_REQUIRED_NODE_COUNT);
  assert.equal(plan.pairCount, 45);
  assert.equal(plan.cyclesPerPair, B11_REQUIRED_CYCLES_PER_PAIR);
  assert.equal(plan.expectedConnectDisconnectCycles, 4_500);
  assert.equal(plan.soakDurationMs, B11_REQUIRED_SOAK_MS);
  assert.equal(plan.requiredProfileSatisfied, true);
});

test("historical schema-1 soak output and digest remain frozen", async () => {
  const report = await historicalSoakReport();
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.mode, "B11_SOFTWARE_SYNTHETIC_NON_GATE");
  assert.equal(report.profile, "soak");
  assert.equal(report.topology.nodeCount, 10);
  assert.equal(report.topology.usefulPairCount, 45);
  assert.equal(report.workload.completedConnectDisconnectCycles, 4_500);
  assert.equal(report.reportDigest, HISTORICAL_SOAK_DIGEST);
  validateB11SoftwareNonGateReport(report);
});

test("hybrid plan freezes sixteen virtual actors and 9100 transport cycles", () => {
  const plan = buildB11SoftwareNonGatePlan({ profile: "hybrid" });
  assert.equal(B11_HYBRID_TOTAL_ACTOR_COUNT, 16);
  assert.equal(plan.nodeCount, B11_HYBRID_BLUETOOTH_NODE_COUNT);
  assert.equal(plan.androidNodeCount, 13);
  assert.equal(plan.androidPairCount, B11_HYBRID_ANDROID_PAIR_COUNT);
  assert.equal(plan.androidPairCount, 78);
  assert.equal(
    plan.androidRaspberryLinkCount,
    B11_HYBRID_ANDROID_RASPBERRY_LINK_COUNT
  );
  assert.equal(plan.androidRaspberryLinkCount, 13);
  assert.equal(plan.pairCount, B11_HYBRID_LINK_COUNT);
  assert.equal(plan.pairCount, 91);
  assert.equal(plan.cyclesPerPair, B11_REQUIRED_CYCLES_PER_PAIR);
  assert.equal(plan.expectedConnectDisconnectCycles, 9_100);
  assert.equal(plan.soakDurationMs, B11_REQUIRED_SOAK_MS);
  assert.equal(plan.requiredProfileSatisfied, true);

  for (const patch of [
    { nodeCount: 13 },
    { cyclesPerPair: 99 },
    { soakDurationMs: B11_REQUIRED_SOAK_MS - 1 },
    { soakTickMs: 500 }
  ]) {
    assert.throws(
      () => buildB11SoftwareNonGatePlan({ profile: "hybrid", ...patch }),
      (error) =>
        error instanceof B11SoftwareNonGateError &&
        error.code === "INVALID_ARGUMENT"
    );
  }
  assert.deepEqual(
    parseB11SoftwareNonGateArguments(["--profile", "hybrid"]),
    { profile: "hybrid" }
  );
});

test("hybrid maximum virtualized system completes exact non-gate counters", async () => {
  const report = await hybridReport();
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.mode, B11_HYBRID_NON_GATE_MODE);
  assert.equal(report.profile, "hybrid");
  assert.equal(report.verdict, "NON_GATE_PASS");
  assert.equal(report.evidenceClass, "NON_GATE_EVIDENCE");
  assert.equal(report.gateImpact, "NONE");
  assert.equal(report.promotionAllowed, false);
  assert.equal(report.officialEvidence, false);
  assert.equal(report.statusMutationAllowed, false);
  assert.equal(report.officialProgressPercent, 49);
  assert.equal(report.b11Gate, "PENDING");
  assert.equal(report.hardwareAccess, false);
  assert.equal(report.radioAccess, false);
  assert.equal(report.adbAccess, false);
  assert.equal(report.sshAccess, false);
  assert.equal(report.serviceAccess, false);
  assert.equal(report.realPeripheralAccess, false);
  assert.equal(report.virtualizationPolicy, "IGNORE_AND_VIRTUALIZE_NON_GATE");
  assert.equal(report.missingHardwarePolicy, "IGNORE_AND_VIRTUALIZE_NON_GATE");
  assert.deepEqual(report.actors, {
    totalActors: 16,
    virtualizedActors: 16,
    physicalActors: 0,
    roles: {
      HANDHELD: 10,
      STATION: 3,
      RASPBERRY_VIRTUAL: 1,
      AUTOMATIC_CASH_VIRTUAL: 1,
      FISCAL_RT_VIRTUAL: 1
    }
  });
  assert.equal(report.topology.nodeCount, 14);
  assert.equal(report.topology.androidPairCount, 78);
  assert.equal(report.topology.androidRaspberryLinkCount, 13);
  assert.equal(report.topology.usefulPairCount, 91);
  assert.equal(report.workload.cyclesPerPair, 100);
  assert.equal(report.workload.completedConnectDisconnectCycles, 9_100);
  assert.equal(report.phaseCoverage.B6.roleElections, 156);
  assert.equal(report.phaseCoverage.B6.duplicateConnectionsArbitrated, 78);
  assert.equal(report.phaseCoverage.B6.androidPairsOnly, true);
  assert.equal(report.phaseCoverage.B8.sessionHistoryCount, 18_200);
  assert.equal(report.phaseCoverage.B8.knownPeerCount, 182);
  assert.equal(report.businessWorkload.expectedActions, 2_600);
  assert.equal(report.businessWorkload.completedActions, 2_600);
  assert.equal(report.businessWorkload.handheldCommands, 800);
  assert.equal(report.businessWorkload.automaticCash.completedTransactions, 100);
  assert.equal(report.businessWorkload.fiscalRt.completedTransactions, 100);
  assert.equal(report.businessWorkload.bluetoothBusinessMessagesForwarded, 0);
  assert.equal(report.businessWorkload.cleanupComplete, true);
  assert.equal(report.businessPlane.transport, "LAN_HTTP_SSE");
  assert.equal(report.businessPlane.bluetoothBusinessMessagesForwarded, 0);
  assert.equal(report.soak.simulatedDurationMs, B11_REQUIRED_SOAK_MS);
  assert.equal(report.persistence.openSessionCount, 0);
  assert.equal(report.persistence.outboxDepth, 0);
  assert.equal(report.teardown.temporaryWorkspaceRemoved, true);
  assert.equal(report.teardown.persistentArtifactsRetained, 0);
  assert.ok(Object.values(report.checks).every(Boolean));
  validateB11SoftwareNonGateReport(report);
});

test("hybrid anti-promotion survives a recalculated attacker digest", async () => {
  const report = await hybridReport();
  const elevations = [
    { promotionAllowed: true },
    { officialEvidence: true },
    { statusMutationAllowed: true },
    { officialProgressPercent: 50 },
    { b11Gate: "PASS" },
    { evidenceClass: "FORMAL" },
    { gateImpact: "B11" },
    { hardwareAccess: true },
    { radioAccess: true },
    { adbAccess: true },
    { sshAccess: true },
    { serviceAccess: true },
    { realPeripheralAccess: true },
    { virtualizationPolicy: "COUNT_AS_PHYSICAL" },
    { missingHardwarePolicy: "COUNT_AS_PHYSICAL" }
  ];
  for (const elevation of elevations) {
    const candidate = recalculateDigest({ ...report, ...elevation });
    assert.throws(
      () => validateB11SoftwareNonGateReport(candidate),
      (error) =>
        error instanceof B11SoftwareNonGateError &&
        error.code === "PROMOTION_CONTRACT_VIOLATION"
    );
  }

  const actorElevation = recalculateDigest({
    ...report,
    actors: { ...report.actors, physicalActors: 1, virtualizedActors: 15 }
  });
  assert.throws(
    () => validateB11SoftwareNonGateReport(actorElevation),
    (error) =>
      error instanceof B11SoftwareNonGateError &&
      error.code === "INVALID_REPORT"
  );
});

test("package exposes only the canonical maximum virtualized launcher", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.equal(
    packageJson.scripts["run:maximum-virtualized-system-non-gate"],
    "npm run build && node scripts/run-b11-software-non-gate.mjs --profile hybrid"
  );
});

test("micro profile exercises every fault and remains explicitly non gate", async () => {
  const report = await runB11SoftwareNonGate({ profile: "micro" });
  assert.equal(report.verdict, "NON_GATE_PASS");
  assert.equal(report.evidenceClass, "NON_GATE_EVIDENCE");
  assert.equal(report.gateImpact, "NONE");
  assert.equal(report.promotionAllowed, false);
  assert.equal(report.officialEvidence, false);
  assert.equal(report.b11Gate, "PENDING");
  assert.equal(report.topology.nodeCount, 4);
  assert.equal(report.topology.usefulPairCount, 6);
  assert.equal(report.workload.completedConnectDisconnectCycles, 18);
  assert.equal(report.phaseCoverage.B6.roleElections, 12);
  assert.equal(report.phaseCoverage.B6.duplicateConnectionsArbitrated, 6);
  assert.ok(report.workload.fragmentedSessions > 0);
  assert.ok(report.faultModel.retryFaults > 0);
  assert.ok(report.faultModel.duplicateFaults > 0);
  assert.ok(report.faultModel.backgroundFaults > 0);
  assert.equal(report.faultModel.rebootCount, 1);
  assert.equal(report.faultModel.recoveredDurableMessages, 1);
  assert.equal(report.faultModel.invalidCertificatesRejected, 1);
  assert.equal(report.phaseCoverage.B8.sessionHistoryCount, 36);
  assert.equal(report.phaseCoverage.B9.routeAdvertisementsPersisted, 4);
  assert.equal(report.phaseCoverage.B9.multihopClaimsRejected, 1);
  assert.equal(report.phaseCoverage.B10.shadowDiagnosticsAccepted, 3);
  assert.equal(report.phaseCoverage.B10.shadowDuplicatesSuppressed, 3);
  assert.equal(report.phaseCoverage.B10.defaultOffRejections, 1);
  assert.equal(report.phaseCoverage.B10.businessMessagesRejected, 1);
  assert.equal(report.phaseCoverage.B10.businessMessagesForwarded, 0);
  assert.equal(report.persistence.openSessionCount, 0);
  assert.equal(report.persistence.outboxDepth, 0);
  assert.equal(report.teardown.temporaryWorkspaceRemoved, true);
  assert.equal(report.teardown.persistentArtifactsRetained, 0);
  assert.ok(Object.values(report.checks).every(Boolean));
  validateB11SoftwareNonGateReport(report);
});

test("same micro input produces the same redacted report and digest", async () => {
  const options = {
    profile: "micro",
    nodeCount: 3,
    cyclesPerPair: 4,
    soakDurationMs: 20_000,
    soakTickMs: 2_000,
    seed: "repeatable-test"
  };
  const first = await runB11SoftwareNonGate(options);
  const second = await runB11SoftwareNonGate(options);
  assert.deepEqual(second, first);
  assert.match(first.reportDigest, /^[0-9a-f]{64}$/);
  const serialized = JSON.stringify(first);
  for (const field of [
    "certificateId",
    "hostname",
    "nodeId",
    "privateKey",
    "publicKey",
    "serial"
  ]) {
    assert.equal(serialized.includes(`\"${field}\"`), false);
  }
});

test("validator rejects a changed body or digest", async () => {
  const report = await runB11SoftwareNonGate({ profile: "micro" });
  assert.throws(
    () =>
      validateB11SoftwareNonGateReport({
        ...report,
        workload: {
          ...report.workload,
          framesTx: report.workload.framesTx + 1
        }
      }),
    (error) =>
      error instanceof B11SoftwareNonGateError &&
      error.code === "INVALID_REPORT"
  );
  assert.throws(
    () =>
      validateB11SoftwareNonGateReport({
        ...report,
        reportDigest: "0".repeat(64)
      }),
    (error) =>
      error instanceof B11SoftwareNonGateError &&
      error.code === "INVALID_REPORT"
  );
});

test("anti promotion validator rejects every attempted gate elevation", async () => {
  const report = await runB11SoftwareNonGate({
    profile: "micro",
    nodeCount: 2,
    cyclesPerPair: 4,
    soakDurationMs: 10_000,
    soakTickMs: 1_000
  });
  for (const patch of [
    { promotionAllowed: true },
    { officialEvidence: true },
    { gateImpact: "B11" },
    { b11Gate: "PASS" },
    { evidenceClass: "FORMAL" },
    { hardwareAccess: true }
  ]) {
    assert.throws(
      () => validateB11SoftwareNonGateReport({ ...report, ...patch }),
      (error) =>
        error instanceof B11SoftwareNonGateError &&
        error.code === "PROMOTION_CONTRACT_VIOLATION"
    );
  }
});

test("report writer uses 0600 and refuses overwrite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v6-b11-report-"));
  chmodSync(root, 0o700);
  const output = path.join(root, "report.json");
  try {
    const report = await runB11SoftwareNonGate({
      profile: "micro",
      nodeCount: 2,
      cyclesPerPair: 4,
      soakDurationMs: 10_000,
      soakTickMs: 1_000
    });
    await writeB11SoftwareNonGateReport(output, report);
    assert.equal(lstatSync(output).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), report);
    await assert.rejects(
      () => writeB11SoftwareNonGateReport(output, report),
      (error) =>
        error instanceof B11SoftwareNonGateError &&
        error.code === "REPORT_WRITE_FAILED"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("argument parser and limits reject ambiguous or oversized workloads", () => {
  assert.deepEqual(
    parseB11SoftwareNonGateArguments([
      "--profile", "micro",
      "--nodes", "3",
      "--cycles", "4",
      "--duration-ms", "20000",
      "--tick-ms", "2000",
      "--seed", "cli-test",
      "--output", "report.json"
    ]),
    {
      profile: "micro",
      nodeCount: 3,
      cyclesPerPair: 4,
      soakDurationMs: 20_000,
      soakTickMs: 2_000,
      seed: "cli-test",
      output: "report.json"
    }
  );
  assert.throws(
    () => buildB11SoftwareNonGatePlan({ nodeCount: 11 }),
    (error) =>
      error instanceof B11SoftwareNonGateError &&
      error.code === "INVALID_ARGUMENT"
  );
  assert.throws(
    () => buildB11SoftwareNonGatePlan({ cyclesPerPair: 101 }),
    (error) =>
      error instanceof B11SoftwareNonGateError &&
      error.code === "INVALID_ARGUMENT"
  );
  for (const patch of [
    { nodeCount: B11_REQUIRED_NODE_COUNT - 1 },
    { cyclesPerPair: B11_REQUIRED_CYCLES_PER_PAIR - 1 },
    { soakDurationMs: B11_REQUIRED_SOAK_MS - 1 }
  ]) {
    assert.throws(
      () => buildB11SoftwareNonGatePlan({ profile: "soak", ...patch }),
      (error) =>
        error instanceof B11SoftwareNonGateError &&
        error.code === "INVALID_ARGUMENT"
    );
  }
  assert.throws(
    () => parseB11SoftwareNonGateArguments(["--unknown", "x"]),
    (error) =>
      error instanceof B11SoftwareNonGateError &&
      error.code === "INVALID_ARGUMENT"
  );
});
