import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  B11SoftwareNonGateError,
  validateB11SoftwareNonGateReport,
  writeB11SoftwareNonGateReport
} from "../scripts/run-b11-software-non-gate.mjs";

const reportPath = new URL(
  "../../reports/V6_B11_MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE_20260818.json",
  import.meta.url
);

async function loadReport() {
  return JSON.parse(await readFile(reportPath, "utf8"));
}

function withDigest(report) {
  const { reportDigest: _discarded, ...body } = report;
  return {
    ...body,
    reportDigest: createHash("sha256").update(JSON.stringify(body)).digest("hex")
  };
}

function expectRejected(candidate) {
  assert.throws(
    () => validateB11SoftwareNonGateReport(withDigest(candidate)),
    (error) =>
      error instanceof B11SoftwareNonGateError &&
      new Set(["INVALID_REPORT", "PROMOTION_CONTRACT_VIOLATION", "PRIVATE_REPORT_FIELD"])
        .has(error.code)
  );
}

test("published hybrid report passes the strict runtime validator", async () => {
  const report = await loadReport();
  assert.equal(report.verdict, "NON_GATE_PASS");
  assert.equal(
    validateB11SoftwareNonGateReport(report).reportDigest,
    "6b527f1003329004628dc79abad1db2d2ca607a68551f7030e699abda7ef8f37"
  );
});

test("recalculated digest cannot hide physical or promotion signals", async () => {
  const report = await loadReport();
  for (const patch of [
    { timeBasis: "REAL" },
    { seedCommitment: "b11-hybrid-deterministic-v2" },
    { b5HundredSessionGate: "PASS" },
    { physicalEvidenceConsumed: true },
    { officialProgressDelta: 1 }
  ]) {
    expectRejected({ ...structuredClone(report), ...patch });
  }

  const external = structuredClone(report);
  external.businessWorkload.externalAccess = true;
  expectRejected(external);

  const realPeripheral = structuredClone(report);
  realPeripheral.virtualPeripherals.realInstances = 1;
  expectRejected(realPeripheral);

  const physicalPair = structuredClone(report);
  physicalPair.phaseCoverage.B6.androidPairsOnly = false;
  expectRejected(physicalPair);

  const leakedState = structuredClone(report);
  leakedState.persistence.openSessionCount = 1;
  expectRejected(leakedState);

  const leakedOutbox = structuredClone(report);
  leakedOutbox.persistence.outboxDepth = 1;
  expectRejected(leakedOutbox);

  const incompleteTeardown = structuredClone(report);
  incompleteTeardown.teardown.temporaryWorkspaceRemoved = false;
  expectRejected(incompleteTeardown);
});

test("every schema level rejects omitted and additional fields", async () => {
  const report = await loadReport();
  const containers = [
    [[], "mode"],
    [["actors"], "totalActors"],
    [["actors", "roles"], "HANDHELD"],
    [["topology"], "nodeCount"],
    [["phaseCoverage"], "B7"],
    [["phaseCoverage", "B10"], "shadowDiagnosticsAccepted"],
    [["workload"], "framesTx"],
    [["businessPlane"], "transport"],
    [["businessWorkload"], "externalAccess"],
    [["businessWorkload", "automaticCash"], "totalCents"],
    [["virtualPeripherals"], "realInstances"],
    [["faultModel"], "retryFaults"],
    [["soak"], "ticks"],
    [["persistence"], "openSessionCount"],
    [["teardown"], "temporaryWorkspaceRemoved"],
    [["checks"], "antiPromotionLocked"]
  ];
  for (const [segments, key] of containers) {
    const missing = structuredClone(report);
    let cursor = missing;
    for (const segment of segments) cursor = cursor[segment];
    delete cursor[key];
    expectRejected(missing);
  }

  const extraNested = structuredClone(report);
  extraNested.businessWorkload.note = "not allowed";
  expectRejected(extraNested);

  const reducedChecks = structuredClone(report);
  reducedChecks.checks = {
    allActorsVirtualized: true,
    antiPromotionLocked: true
  };
  expectRejected(reducedChecks);
});

test("writer rejects symlink parents and pre-existing hardlink targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v6-b11-writer-hardening-"));
  chmodSync(root, 0o700);
  const report = await loadReport();
  try {
    const realParent = path.join(root, "real");
    await mkdir(realParent, { mode: 0o700 });
    const linkedParent = path.join(root, "linked");
    await symlink(realParent, linkedParent, "dir");
    await assert.rejects(
      () => writeB11SoftwareNonGateReport(path.join(linkedParent, "report.json"), report),
      (error) => error instanceof B11SoftwareNonGateError && error.code === "REPORT_WRITE_FAILED"
    );
    assert.deepEqual(await readdir(realParent), []);

    const source = path.join(root, "source.json");
    const target = path.join(root, "target.json");
    await writeFile(source, "preserve", { mode: 0o600 });
    await link(source, target);
    await assert.rejects(
      () => writeB11SoftwareNonGateReport(target, report),
      (error) => error instanceof B11SoftwareNonGateError && error.code === "REPORT_WRITE_FAILED"
    );
    assert.equal(await readFile(source, "utf8"), "preserve");
    assert.equal(await readFile(target, "utf8"), "preserve");
    assert.equal((await readdir(root)).some((name) => name.includes(".tmp-")), false);

    const successfulTarget = path.join(realParent, "success.json");
    await writeB11SoftwareNonGateReport(successfulTarget, report);
    const successfulMetadata = await lstat(successfulTarget);
    assert.equal(successfulMetadata.isFile(), true);
    assert.equal(successfulMetadata.isSymbolicLink(), false);
    assert.equal(successfulMetadata.nlink, 1);
    assert.equal(successfulMetadata.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(successfulTarget, "utf8")), report);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("physical B4 and B5 gates do not consume the virtualized report", async () => {
  const root = new URL("../../", import.meta.url);
  for (const relative of [
    "raspberry/scripts/run-b4-ten-device-gate.mjs",
    "raspberry/scripts/run-b5-hundred-session-gate.mjs",
    "raspberry/scripts/run-b5-promotion-gate.mjs"
  ]) {
    const source = await readFile(new URL(relative, root), "utf8");
    assert.equal(source.includes("MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE"), false);
    assert.equal(source.includes("V6_B11_MAXIMUM_VIRTUALIZED_SYSTEM"), false);
    assert.equal(source.includes("--virtualized-report"), false);
  }
});
