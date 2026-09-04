import assert from "node:assert/strict";
import test from "node:test";

import {
  B11VirtualBusinessWorkloadError,
  B11_VIRTUAL_ACTIONS_PER_ANDROID,
  B11_VIRTUAL_PERIPHERAL_TRANSACTIONS,
  buildB11HybridTopology,
  runB11VirtualBusinessWorkload
} from "../scripts/b11-virtual-business-workload.mjs";

test("hybrid topology fixes ten handhelds, three stations and three supporting actors", () => {
  assert.deepEqual(buildB11HybridTopology(), {
    totalActors: 16,
    bluetoothNodeCount: 14,
    androidNodeCount: 13,
    handheldCount: 10,
    stationCount: 3,
    raspberryCount: 1,
    automaticCashCount: 1,
    fiscalRtCount: 1,
    androidPairCount: 78,
    androidRaspberryLinkCount: 13,
    transportLinkCount: 91
  });
});

test("maximum virtual business workload covers every actor and peripheral", () => {
  const report = runB11VirtualBusinessWorkload({ seed: "maximum-test" });
  assert.equal(report.actionsPerAndroid, B11_VIRTUAL_ACTIONS_PER_ANDROID);
  assert.equal(report.expectedActions, 2_600);
  assert.equal(report.completedActions, 2_600);
  assert.equal(report.handheldActions, 2_000);
  assert.equal(report.stationActions, 600);
  assert.equal(report.handheldCommands, 800);
  assert.equal(report.coveredHandhelds, 10);
  assert.equal(report.coveredStations, 3);
  assert.equal(report.raspberryBrokeredActions, 2_600);
  for (const peripheral of [report.automaticCash, report.fiscalRt]) {
    assert.equal(peripheral.expectedTransactions, B11_VIRTUAL_PERIPHERAL_TRANSACTIONS);
    assert.equal(peripheral.completedTransactions, 100);
    assert.equal(peripheral.exactReplays, 100);
    assert.equal(peripheral.mutatedReplaysRejected, 1);
    assert.equal(peripheral.outageFaults, 1);
    assert.equal(peripheral.recoveries, 1);
    assert.equal(peripheral.pendingTransactions, 0);
    assert.ok(peripheral.totalCents > 0);
  }
  assert.equal(report.businessTransport, "LAN_HTTP_SSE");
  assert.equal(report.bluetoothBusinessMessagesForwarded, 0);
  assert.equal(report.externalAccess, false);
  assert.equal(report.cleanupComplete, true);
});

test("same seed produces the same aggregate-only workload", () => {
  const first = runB11VirtualBusinessWorkload({ seed: "repeatable" });
  const second = runB11VirtualBusinessWorkload({ seed: "repeatable" });
  assert.deepEqual(second, first);
  const serialized = JSON.stringify(first);
  for (const forbidden of [
    "repeatable",
    '"transactionId"',
    '"receiptId"',
    '"idempotencyKey"',
    '"token"',
    '"deviceUuid"',
    '"username"',
    '"endpoint"',
    '"url"',
    '"port"'
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("required hybrid workload cannot be reduced", () => {
  for (const patch of [
    { handheldCount: 9 },
    { stationCount: 2 },
    { raspberryCount: 0 },
    { automaticCashCount: 0 },
    { fiscalRtCount: 0 },
    { actionsPerAndroidDevice: 199 },
    { peripheralCycles: 99 },
    { physicalDeviceCount: 16 }
  ]) {
    assert.throws(
      () => runB11VirtualBusinessWorkload(patch),
      (error) =>
        error instanceof B11VirtualBusinessWorkloadError &&
        error.code === "INVALID_PROFILE"
    );
  }
});

test("invalid seed and oversized profile values fail closed", () => {
  assert.throws(
    () => runB11VirtualBusinessWorkload({ seed: "contains spaces" }),
    (error) =>
      error instanceof B11VirtualBusinessWorkloadError &&
      error.code === "INVALID_PROFILE"
  );
  assert.throws(
    () => runB11VirtualBusinessWorkload({
      actionsPerAndroidDevice: Number.MAX_SAFE_INTEGER
    }),
    (error) =>
      error instanceof B11VirtualBusinessWorkloadError &&
      error.code === "INVALID_PROFILE"
  );
});
