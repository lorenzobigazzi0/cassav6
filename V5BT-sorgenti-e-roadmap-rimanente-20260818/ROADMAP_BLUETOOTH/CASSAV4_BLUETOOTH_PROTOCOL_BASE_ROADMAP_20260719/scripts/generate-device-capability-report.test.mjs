import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  B0CapabilityGateError,
  B0_EVIDENCE_CLASSES,
  B0_REQUIRED_CHECKS,
  evaluateB0CapabilityMatrix,
  loadB0CapabilityMatrix,
  parseArguments,
  parseB0CapabilityMatrix
} from "./generate-device-capability-report.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./generate-device-capability-report.mjs", import.meta.url)
);
const MATRIX_SCHEMA_PATH = fileURLToPath(
  new URL(
    "../contracts/b0-device-capability-matrix-v1.schema.json",
    import.meta.url
  )
);
const REPORT_SCHEMA_PATH = fileURLToPath(
  new URL(
    "../contracts/b0-device-capability-report-v1.schema.json",
    import.meta.url
  )
);

function passingDevice(role, evidenceClass = "FORMAL", overrides = {}) {
  return {
    role,
    vendor: "Test Vendor",
    model: role === "handheld" ? "Phone Test" : "Tablet Test",
    androidApi: 36,
    connectionStatus: "CONNECTED",
    evidenceClass,
    scan: "PASS",
    advertise: "PASS",
    gattClient: "PASS",
    gattServer: "PASS",
    scanAdvertiseConcurrent: "PASS",
    wifiBleCoexistence: "PASS",
    backgroundForeground: "PASS",
    classification: "FULL_NODE",
    ...overrides
  };
}

function matrix(devices) {
  return JSON.stringify({
    schemaVersion: 1,
    evidenceDate: "2026-08-03",
    minimumFullNodesRequired: 2,
    devices
  });
}

test("passes only with complete formal handheld and station evidence", () => {
  const report = evaluateB0CapabilityMatrix(
    matrix([passingDevice("handheld"), passingDevice("station")])
  );
  assert.equal(report.gate, "PASS");
  assert.equal(report.counts.passingFormalFullNodes, 2);
  assert.deepEqual(report.requiredChecks, B0_REQUIRED_CHECKS);
  assert.deepEqual(B0_EVIDENCE_CLASSES, [
    "FORMAL",
    "SUPPLEMENTAL",
    "NON_GATE_EVIDENCE"
  ]);
  assert.deepEqual(report.formalRoleCoverage, {
    handheld: true,
    station: true
  });
});

test("every absent, UNKNOWN or non-PASS required check fails closed", () => {
  for (const check of B0_REQUIRED_CHECKS) {
    for (const status of [undefined, "UNKNOWN", "FAIL", "NOT_TESTED", true]) {
      const handheld = passingDevice("handheld");
      if (status === undefined) delete handheld[check];
      else handheld[check] = status;
      const report = evaluateB0CapabilityMatrix(
        matrix([handheld, passingDevice("station")])
      );
      assert.equal(report.gate, "PENDING", `${check}:${String(status)}`);
      assert.equal(report.devices[0].evidenceResult, "PENDING");
    }
  }
});

test("classification and formal role coverage are mandatory", () => {
  const wrongClassification = evaluateB0CapabilityMatrix(
    matrix([
      passingDevice("handheld", "FORMAL", {
        classification: "CLIENT_ONLY"
      }),
      passingDevice("station")
    ])
  );
  assert.equal(wrongClassification.gate, "PENDING");

  const missingStation = evaluateB0CapabilityMatrix(
    matrix([passingDevice("handheld"), passingDevice("handheld")])
  );
  assert.equal(missingStation.gate, "PENDING");
  assert.equal(missingStation.formalRoleCoverage.station, false);
});

test("supplemental and non-gate evidence never satisfy the formal minimum", () => {
  const report = evaluateB0CapabilityMatrix(
    matrix([
      passingDevice("handheld"),
      passingDevice("station", "SUPPLEMENTAL"),
      passingDevice("station", "NON_GATE_EVIDENCE")
    ])
  );
  assert.equal(report.gate, "PENDING");
  assert.equal(report.counts.formal, 1);
  assert.equal(report.counts.supplemental, 1);
  assert.equal(report.counts.nonGate, 1);
});

test("missing or invalid evidence class is non-gate and cannot pass", () => {
  const device = passingDevice("handheld");
  delete device.evidenceClass;
  const parsed = parseB0CapabilityMatrix(
    matrix([device, passingDevice("station")])
  );
  assert.equal(parsed.devices[0].evidenceClass, "NON_GATE_EVIDENCE");
  assert.equal(parsed.devices[0].evidenceResult, "PENDING");
  assert.equal(
    parsed.devices[0].blockers.includes("EVIDENCE_CLASS_MISSING_OR_INVALID"),
    true
  );
  assert.equal(
    evaluateB0CapabilityMatrix(matrix([device, passingDevice("station")])).gate,
    "PENDING"
  );
});

test("exported report is built from a public allowlist", () => {
  const rawSerial = "PRIVATE_SERIAL_SHOULD_NOT_LEAK";
  const rawAddress = "AA:BB:CC:DD:EE:FF";
  const report = evaluateB0CapabilityMatrix(
    matrix([
      passingDevice("handheld", "FORMAL", {
        privateEvidence: {
          serial: rawSerial,
          bluetoothAddress: rawAddress,
          evidencePath: "/private/evidence.json",
          enrollmentId: "private-enrollment"
        }
      }),
      passingDevice("station")
    ])
  );
  const exported = JSON.stringify(report);
  assert.equal(report.redaction.status, "REDACTED");
  assert.equal(report.redaction.policy, "PUBLIC_ALLOWLIST_V1");
  assert.equal(exported.includes(rawSerial), false);
  assert.equal(exported.includes(rawAddress), false);
  assert.equal(exported.includes("/private/evidence.json"), false);
  assert.equal(exported.includes("private-enrollment"), false);
  assert.equal(exported.includes("privateEvidence"), false);
});

test("loader rejects missing files and symbolic links", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-b0-matrix-"));
  const target = path.join(directory, "matrix.json");
  const link = path.join(directory, "matrix-link.json");
  try {
    assert.throws(
      () => loadB0CapabilityMatrix(target),
      (error) =>
        error instanceof B0CapabilityGateError &&
        error.code === "B0_MATRIX_UNAVAILABLE"
    );
    fs.writeFileSync(
      target,
      matrix([passingDevice("handheld"), passingDevice("station")]),
      { mode: 0o600 }
    );
    fs.symlinkSync(target, link);
    assert.throws(
      () => loadB0CapabilityMatrix(link),
      (error) =>
        error instanceof B0CapabilityGateError &&
        error.code === "B0_MATRIX_UNAVAILABLE"
    );
    assert.equal(loadB0CapabilityMatrix(target).devices.length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("loader requires mode 0600 and one link when private evidence is present", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-b0-private-"));
  const securePath = path.join(directory, "secure.json");
  const loosePath = path.join(directory, "loose.json");
  const linkedPath = path.join(directory, "linked.json");
  const privateMatrix = matrix([
    passingDevice("handheld", "FORMAL", {
      privateEvidence: { serial: "PRIVATE" }
    }),
    passingDevice("station")
  ]);
  try {
    fs.writeFileSync(securePath, privateMatrix, { mode: 0o600 });
    fs.chmodSync(securePath, 0o600);
    assert.equal(loadB0CapabilityMatrix(securePath).hasPrivateEvidence, true);

    fs.writeFileSync(loosePath, privateMatrix, { mode: 0o644 });
    fs.chmodSync(loosePath, 0o644);
    assert.throws(
      () => loadB0CapabilityMatrix(loosePath),
      (error) =>
        error instanceof B0CapabilityGateError &&
        error.code === "B0_MATRIX_INSECURE"
    );

    fs.linkSync(securePath, linkedPath);
    assert.throws(
      () => loadB0CapabilityMatrix(securePath),
      (error) =>
        error instanceof B0CapabilityGateError &&
        error.code === "B0_MATRIX_INSECURE"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("matrix parser rejects unexpected fields without reflecting values", () => {
  const invalid = JSON.parse(
    matrix([passingDevice("handheld"), passingDevice("station")])
  );
  invalid.devices[0].serial = "PRIVATE_SERIAL";
  assert.throws(
    () => parseB0CapabilityMatrix(JSON.stringify(invalid)),
    (error) =>
      error instanceof B0CapabilityGateError &&
      error.code === "B0_MATRIX_INVALID" &&
      !error.message.includes("PRIVATE_SERIAL")
  );
});

test("CLI returns 0 only for PASS and 2 for PENDING", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-b0-cli-"));
  const passingPath = path.join(directory, "passing.json");
  const pendingPath = path.join(directory, "pending.json");
  try {
    fs.writeFileSync(
      passingPath,
      matrix([passingDevice("handheld"), passingDevice("station")]),
      { mode: 0o600 }
    );
    fs.writeFileSync(
      pendingPath,
      matrix([
        passingDevice("handheld"),
        passingDevice("station", "FORMAL", { gattServer: "UNKNOWN" })
      ]),
      { mode: 0o600 }
    );
    const passing = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--matrix", passingPath],
      { encoding: "utf8" }
    );
    const pending = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--matrix", pendingPath],
      { encoding: "utf8" }
    );
    assert.equal(passing.status, 0, passing.stderr);
    assert.equal(JSON.parse(passing.stdout).gate, "PASS");
    assert.equal(pending.status, 2, pending.stderr);
    assert.equal(JSON.parse(pending.stdout).gate, "PENDING");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI argument parser rejects unknown, duplicate and valueless options", () => {
  assert.deepEqual(parseArguments([]), { root: ".", matrix: null });
  for (const argv of [
    ["--unknown", "value"],
    ["--root"],
    ["--root", "--matrix"],
    ["--matrix", "one", "--matrix", "two"]
  ]) {
    assert.throws(
      () => parseArguments(argv),
      (error) =>
        error instanceof B0CapabilityGateError &&
        error.code === "B0_ARGUMENT_INVALID"
    );
  }
});

test("matrix, report and runner keep the seven required checks aligned", () => {
  const matrixSchema = JSON.parse(fs.readFileSync(MATRIX_SCHEMA_PATH, "utf8"));
  const reportSchema = JSON.parse(fs.readFileSync(REPORT_SCHEMA_PATH, "utf8"));
  const matrixRequired = matrixSchema.$defs.device.required.filter((field) =>
    B0_REQUIRED_CHECKS.includes(field)
  );
  assert.deepEqual(matrixRequired, B0_REQUIRED_CHECKS);
  assert.deepEqual(
    reportSchema.properties.requiredChecks.const,
    B0_REQUIRED_CHECKS
  );
  assert.deepEqual(
    reportSchema.$defs.redactedDevice.properties.checks.required,
    B0_REQUIRED_CHECKS
  );
});
