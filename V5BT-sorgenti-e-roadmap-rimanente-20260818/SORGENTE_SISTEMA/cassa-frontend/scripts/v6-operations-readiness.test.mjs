import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  V6OperationsReadinessError,
  canonicalCertificationMatrixSha256,
  canonicalJson,
  evaluateV6OperationsReadiness,
  parseV6OperationsReadinessReceipt,
  validV6OperationsStageFixture,
  writeImmutableV6OperationsReadinessReceipt,
} from "./v6-operations-readiness.mjs";

const STAGES = ["micro", "smoke", "full"];
const GENERATED_AT = "2026-08-06T11:00:00.000Z";

function matrixFixture() {
  return {
    schemaVersion: 3,
    roles: {
      handheld: {
        artifactRelativePath: "artifacts/Palmare-Cassa-V6-v6.0.0-Lab-debug.apk",
        packageId: "com.sentrapa.cassav6.palmare",
        versionName: "1.0.39",
        versionCode: 40,
        sha256: "a".repeat(64),
        signingCertificateSha256: "c".repeat(64),
      },
      station: {
        artifactRelativePath: "artifacts/Postazione-Cassa-V6-v6.0.0-Lab-debug.apk",
        packageId: "com.sentrapa.cassav6.postazione",
        versionName: "2.0.23",
        versionCode: 25,
        sha256: "b".repeat(64),
        signingCertificateSha256: "c".repeat(64),
      },
    },
  };
}

function bytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function reportSet(overrides = {}) {
  return Object.fromEntries(
    STAGES.map((stage) => [
      stage,
      bytes(overrides[stage] ?? validV6OperationsStageFixture(stage)),
    ]),
  );
}

function happyReceipt(options = {}) {
  const matrix = matrixFixture();
  return evaluateV6OperationsReadiness({
    certificationMatrix: matrix,
    expectedCertificationMatrixSha256:
      options.expectedCertificationMatrixSha256 ??
      canonicalCertificationMatrixSha256(matrix),
    reports: options.reports ?? reportSet(),
    generatedAt: options.generatedAt ?? GENERATED_AT,
  });
}

function assertCode(code) {
  return (error) =>
    error instanceof V6OperationsReadinessError && error.code === code;
}

test("happy path binds the canonical matrix and all three exact load stages", () => {
  const receipt = happyReceipt();
  assert.equal(receipt.verdict, "NON_GATE_PASS");
  assert.equal(receipt.evidenceClass, "NON_GATE_EVIDENCE");
  assert.equal(receipt.checks.matrixBinding, "PASS");
  assert.equal(receipt.checks.threeDistinctReports, "PASS");
  assert.deepEqual(
    receipt.stages.map(({ stage, status }) => ({ stage, status })),
    [
      { stage: "micro", status: "PASS" },
      { stage: "smoke", status: "PASS" },
      { stage: "full", status: "PASS" },
    ],
  );
  assert.deepEqual(
    receipt.stages.map((entry) => [
      entry.expected.actionsPerDevice,
      entry.expected.totalActions,
    ]),
    [
      [10, 300],
      [40, 1_200],
      [200, 6_000],
    ],
  );
  assert.equal(receipt.stages[0].observed.handhelds, 25);
  assert.equal(receipt.stages[0].observed.stations, 5);
  assert.equal(receipt.stages[0].observed.mobileActionAverageGapMs, 3_000);
  assert.equal(receipt.stages[0].observed.commandAverageGapMs, 7_500);
  assert.equal(receipt.stages[0].observed.batteryNotificationIntervalMs, 120_000);
  assert.deepEqual(receipt.gate, {
    gateImpact: "NONE",
    b4: "PENDING",
    b5: "PENDING",
    b6: "BLOCKED",
    officialProgressChanged: false,
  });
  assert.equal(parseV6OperationsReadinessReceipt(receipt), receipt);

  const encoded = JSON.stringify(receipt);
  for (const forbidden of [
    "private-micro-run",
    "private-device-1",
    "backendPid",
    "runId",
    "/home/",
  ]) {
    assert.equal(encoded.includes(forbidden), false);
  }
});

test("canonical matrix digest does not depend on object key order", () => {
  const matrix = matrixFixture();
  const reordered = {
    roles: {
      station: { ...matrix.roles.station },
      handheld: { ...matrix.roles.handheld },
    },
    schemaVersion: 3,
  };
  assert.equal(
    canonicalCertificationMatrixSha256(matrix),
    canonicalCertificationMatrixSha256(reordered),
  );
  assert.equal(
    canonicalJson({ z: 1, a: 2 }),
    canonicalJson({ a: 2, z: 1 }),
  );

  const roadmapRoot = new URL(
    "../../../ROADMAP_V6/BLUETOOTH/CASSAV6_BLUETOOTH_PROTOCOL_20260820/",
    import.meta.url,
  );
  const authoritativeMatrix = JSON.parse(
    fs.readFileSync(new URL("configs/advanced-certification-targets.json", roadmapRoot), "utf8"),
  );
  const roadmapStatus = JSON.parse(
    fs.readFileSync(new URL("configs/current-roadmap-status.json", roadmapRoot), "utf8"),
  );
  assert.equal(
    canonicalCertificationMatrixSha256(authoritativeMatrix),
    roadmapStatus.certificationMatrix.matrixSha256,
  );
});

test("missing, legacy and failing reports remain distinct and produce NOT_READY", () => {
  const legacy = validV6OperationsStageFixture("smoke");
  delete legacy.config.v6SchedulerContractVersion;
  delete legacy.config.v6OperationsStage;
  delete legacy.v6OperationsProfile.schedulerContractVersion;
  delete legacy.v6OperationsProfile.stage;
  const failed = validV6OperationsStageFixture("full");
  failed.v6OperationsProfile.totalFailed = 1;
  failed.recorder.failures.push({ type: "private failure detail" });
  const receipt = happyReceipt({
    reports: {
      micro: null,
      smoke: bytes(legacy),
      full: bytes(failed),
    },
  });
  assert.equal(receipt.verdict, "NOT_READY");
  assert.deepEqual(
    receipt.stages.map((entry) => entry.status),
    ["MISSING", "STALE", "FAIL"],
  );
  assert.equal(receipt.gate.gateImpact, "NONE");
  assert.equal(JSON.stringify(receipt).includes("private failure detail"), false);
});

test("current reports fail closed for stage mismatch, custom mode and future contract", () => {
  for (const mutate of [
    (report) => {
      report.config.v6OperationsStage = "smoke";
    },
    (report) => {
      report.config.v6OperationsStage = "custom";
      report.v6OperationsProfile.stage = "custom";
    },
    (report) => {
      report.config.v6SchedulerContractVersion = 3;
      report.v6OperationsProfile.schedulerContractVersion = 3;
    },
  ]) {
    const micro = validV6OperationsStageFixture("micro");
    mutate(micro);
    const receipt = happyReceipt({ reports: reportSet({ micro }) });
    assert.equal(receipt.verdict, "NOT_READY");
    assert.equal(receipt.stages[0].status, "FAIL");
  }
});

test("override diagnostici e concorrenze non certificate non sono promuovibili", () => {
  for (const mutate of [
    (report) => {
      report.config.laneCrossExclusionPaymentsEnabled = true;
    },
    (report) => {
      report.config.paymentLaneConcurrency = 1;
    },
    (report) => {
      report.config.paymentLaneConcurrency = 3;
      report.config.v6OperationsEvidenceClass = "NON_GATE";
      report.config.v6OperationsPromotionEligibility = "NON_PROMOTABLE";
      report.config.v6OperationsDiagnosticPaymentLaneConcurrency = 3;
      report.config.v6OperationsDiagnostic = true;
    },
    (report) => {
      report.config.v6OperationsEvidenceClass = "NON_GATE";
      report.config.v6OperationsPromotionEligibility = "NON_PROMOTABLE";
      report.config.v6OperationsDiagnostic = true;
    },
    (report) => {
      report.config.printLaneConcurrency = 2;
    },
    (report) => {
      report.config.ordersAsyncFlushIntervalMs = 1_000;
    },
    (report) => {
      report.config.hostPressurePreflight.checks.schedulerLoad.ok = false;
    },
  ]) {
    const micro = validV6OperationsStageFixture("micro");
    mutate(micro);
    const receipt = happyReceipt({ reports: reportSet({ micro }) });
    assert.equal(receipt.verdict, "NOT_READY");
    assert.equal(receipt.stages[0].checks.profileBinding, "FAIL");
  }
});

test("every workload readiness family is independently blocking", async (t) => {
  const cases = [
    ["quota", (r) => (r.v6OperationsProfile.totalCompleted -= 1)],
    ["device topology", (r) => r.v6OperationsProfile.devices.pop()],
    ["coverage", (r) => r.v6OperationsProfile.missingMobileActionTypes.push("order.create")],
    ["early dispatch", (r) => (r.v6OperationsProfile.cadence.earlyDispatchActionGaps = 1)],
    ["mobile cadence", (r) => (r.v6OperationsProfile.cadence.mobileActionAverageGapMs = 3_301)],
    ["command cadence", (r) => (r.v6OperationsProfile.cadence.commandAverageGapMs = 8_001)],
    ["latency", (r) => (r.v6OperationsProfile.actionLatencyMs.p95ms = 3_001)],
    ["battery", (r) => (r.mockIoMetrics.battery.body.notificationIntervalMs = 60_000)],
    ["persistence", (r) => (r.v6OperationsProfile.persistedOrderTargetOk = false)],
    ["audit", (r) => (r.relationalAudit.eventOutboxUnpublished = 1)],
    ["cleanup", (r) => (r.cleanup.processes.remaining = 1)],
    ["runtime", (r) => delete r.v6OperationsProfile.runtimeGate.checks.commandP95WithinLimit],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const full = validV6OperationsStageFixture("full");
      mutate(full);
      const receipt = happyReceipt({ reports: reportSet({ full }) });
      assert.equal(receipt.verdict, "NOT_READY");
      assert.equal(receipt.stages[2].status, "FAIL");
    });
  }
});

test("matrix mismatch and duplicate report reuse fail without changing gates", () => {
  const mismatch = happyReceipt({
    expectedCertificationMatrixSha256: "0".repeat(64),
  });
  assert.equal(mismatch.verdict, "NOT_READY");
  assert.equal(mismatch.checks.matrixBinding, "FAIL");

  const one = bytes(validV6OperationsStageFixture("micro"));
  const duplicate = happyReceipt({
    reports: { micro: one, smoke: one, full: one },
  });
  assert.equal(duplicate.verdict, "NOT_READY");
  assert.equal(duplicate.checks.threeDistinctReports, "FAIL");
  assert.equal(duplicate.gate.b5, "PENDING");
});

test("overlapping stages and a regressive receipt clock are blocking", () => {
  const smoke = validV6OperationsStageFixture("smoke", {
    startedAt: "2026-08-06T10:08:00.000Z",
    endedAt: "2026-08-06T10:18:00.000Z",
  });
  const overlap = happyReceipt({ reports: reportSet({ smoke }) });
  assert.equal(overlap.verdict, "NOT_READY");
  assert.equal(overlap.stages[1].status, "FAIL");
  assert.equal(overlap.checks.stageSequenceAndClock, "FAIL");

  const regressive = happyReceipt({ generatedAt: "2026-08-06T10:15:00.000Z" });
  assert.equal(regressive.verdict, "NOT_READY");
  assert.equal(regressive.checks.stageSequenceAndClock, "FAIL");
});

test("malformed and digest-mismatched stage evidence fails closed", () => {
  const malformed = happyReceipt({
    reports: { ...reportSet(), micro: Buffer.from("{not-json", "utf8") },
  });
  assert.equal(malformed.stages[0].status, "FAIL");

  const report = bytes(validV6OperationsStageFixture("micro"));
  const digestMismatch = happyReceipt({
    reports: {
      ...reportSet(),
      micro: { bytes: report, expectedSha256: "f".repeat(64) },
    },
  });
  assert.equal(digestMismatch.stages[0].status, "FAIL");
  assert.equal(digestMismatch.verdict, "NOT_READY");
});

test("receipt commitment detects subsequent tampering", () => {
  const receipt = structuredClone(happyReceipt());
  receipt.stages[0].observed.totalCompleted -= 1;
  assert.throws(
    () => parseV6OperationsReadinessReceipt(receipt),
    assertCode("RECEIPT_TAMPERED"),
  );
});

test("recomputed commitment cannot hide false gate promotion or altered evidence binding", () => {
  const recommit = (receipt) => {
    const { receiptCommitmentSha256: _old, ...base } = receipt;
    receipt.receiptCommitmentSha256 = crypto
      .createHash("sha256")
      .update(canonicalJson(base))
      .digest("hex");
  };

  const promoted = structuredClone(happyReceipt());
  promoted.gate.b5 = "PASS";
  recommit(promoted);
  assert.throws(
    () => parseV6OperationsReadinessReceipt(promoted),
    assertCode("RECEIPT_INVALID"),
  );

  const rebound = structuredClone(happyReceipt());
  rebound.evidenceBindingSha256 = "e".repeat(64);
  recommit(rebound);
  assert.throws(
    () => parseV6OperationsReadinessReceipt(rebound),
    assertCode("RECEIPT_INVALID"),
  );
});

test("immutable publication is 0600 and refuses overwrite, symlink and hardlink", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v6-readiness-output-"));
  const receipt = happyReceipt();
  const output = path.join(directory, "receipt.json");
  writeImmutableV6OperationsReadinessReceipt(output, receipt);
  const status = fs.lstatSync(output);
  assert.equal(status.isFile(), true);
  assert.equal(status.nlink, 1);
  if (process.platform !== "win32") assert.equal(status.mode & 0o777, 0o600);
  assert.deepEqual(
    parseV6OperationsReadinessReceipt(fs.readFileSync(output, "utf8")),
    receipt,
  );
  assert.throws(
    () => writeImmutableV6OperationsReadinessReceipt(output, receipt),
    assertCode("OUTPUT_EXISTS"),
  );

  const target = path.join(directory, "target.json");
  fs.writeFileSync(target, "target", { mode: 0o600 });
  const symbolic = path.join(directory, "symbolic.json");
  fs.symlinkSync(target, symbolic);
  assert.throws(
    () => writeImmutableV6OperationsReadinessReceipt(symbolic, receipt),
    assertCode("OUTPUT_EXISTS"),
  );
  const hard = path.join(directory, "hard.json");
  fs.linkSync(target, hard);
  assert.throws(
    () => writeImmutableV6OperationsReadinessReceipt(hard, receipt),
    assertCode("OUTPUT_EXISTS"),
  );

  const realParent = path.join(directory, "private-parent");
  fs.mkdirSync(realParent, { mode: 0o700 });
  const linkedParent = path.join(directory, "linked-parent");
  fs.symlinkSync(realParent, linkedParent);
  assert.throws(
    () =>
      writeImmutableV6OperationsReadinessReceipt(
        path.join(linkedParent, "receipt.json"),
        receipt,
      ),
    assertCode("OUTPUT_DIRECTORY_UNSAFE"),
  );

  const publicParent = path.join(directory, "public-parent");
  fs.mkdirSync(publicParent, { mode: 0o755 });
  if (process.platform !== "win32") {
    assert.throws(
      () =>
        writeImmutableV6OperationsReadinessReceipt(
          path.join(publicParent, "receipt.json"),
          receipt,
        ),
      assertCode("OUTPUT_DIRECTORY_UNSAFE"),
    );
  }
});

test("fixture private identifiers never affect the public evidence digests incorrectly", () => {
  const fixture = validV6OperationsStageFixture("micro");
  const first = bytes(fixture);
  fixture.runId = "another-private-run";
  const second = bytes(fixture);
  assert.notEqual(
    crypto.createHash("sha256").update(first).digest("hex"),
    crypto.createHash("sha256").update(second).digest("hex"),
  );
  const receipt = happyReceipt({ reports: reportSet({ micro: fixture }) });
  assert.equal(receipt.verdict, "NON_GATE_PASS");
  assert.equal(JSON.stringify(receipt).includes("another-private-run"), false);
});

test("CLI turns linked and oversized stage inputs into redacted FAIL evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v6-readiness-input-"));
  const matrix = path.join(directory, "matrix.json");
  fs.writeFileSync(matrix, bytes(matrixFixture()), { mode: 0o600 });

  const microTarget = path.join(directory, "micro-target.json");
  const micro = path.join(directory, "micro.json");
  fs.writeFileSync(microTarget, bytes(validV6OperationsStageFixture("micro")), {
    mode: 0o600,
  });
  fs.symlinkSync(microTarget, micro);

  const smokeTarget = path.join(directory, "smoke-target.json");
  const smoke = path.join(directory, "smoke.json");
  fs.writeFileSync(smokeTarget, bytes(validV6OperationsStageFixture("smoke")), {
    mode: 0o600,
  });
  fs.linkSync(smokeTarget, smoke);

  const full = path.join(directory, "full.json");
  fs.writeFileSync(full, "{}", { mode: 0o600 });
  fs.truncateSync(full, 64 * 1024 * 1024 + 1);
  const output = path.join(directory, "receipt.json");
  const child = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./v6-operations-readiness.mjs", import.meta.url)),
      "--matrix",
      matrix,
      "--micro",
      micro,
      "--smoke",
      smoke,
      "--full",
      full,
      "--output",
      output,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 2, child.stderr || child.stdout);
  const receipt = parseV6OperationsReadinessReceipt(
    fs.readFileSync(output, "utf8"),
  );
  assert.deepEqual(
    receipt.stages.map((stage) => stage.status),
    ["FAIL", "FAIL", "FAIL"],
  );
  assert.equal(receipt.verdict, "NOT_READY");
  assert.equal(receipt.gate.gateImpact, "NONE");
});
