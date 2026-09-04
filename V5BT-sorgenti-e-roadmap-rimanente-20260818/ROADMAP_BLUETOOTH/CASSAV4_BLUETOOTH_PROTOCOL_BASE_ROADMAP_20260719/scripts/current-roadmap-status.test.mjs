import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ADVANCED_CERTIFICATION_TARGETS_BINDING
} from "./advanced-certification-targets.mjs";
import {
  CURRENT_ROADMAP_STATUS,
  CurrentRoadmapStatusError,
  isRoadmapPromotionAllowed,
  loadCurrentRoadmapStatus,
  loadCurrentRoadmapStatusSchema,
  parseCurrentRoadmapStatus,
  validateCurrentRoadmapStatusSchema
} from "./current-roadmap-status.mjs";

const STATUS_PATH = new URL(
  "../configs/current-roadmap-status.json",
  import.meta.url
);
const SCHEMA_PATH = new URL(
  "../contracts/current-roadmap-status-v1.schema.json",
  import.meta.url
);
const SCRIPT_PATH = fileURLToPath(
  new URL("./current-roadmap-status.mjs", import.meta.url)
);
const VALID_STATUS = JSON.parse(fs.readFileSync(STATUS_PATH, "utf8"));

function expectInvalid(mutator, code = "CURRENT_ROADMAP_STATUS_INVALID") {
  const changed = structuredClone(VALID_STATUS);
  mutator(changed);
  assert.throws(
    () => parseCurrentRoadmapStatus(JSON.stringify(changed)),
    (error) =>
      error instanceof CurrentRoadmapStatusError && error.code === code
  );
}

test("loads and freezes the exact current non-promoting roadmap status", () => {
  assert.equal(CURRENT_ROADMAP_STATUS.officialProgressPercent, 49);
  assert.deepEqual(CURRENT_ROADMAP_STATUS.b4, {
    gateStatus: "PENDING",
    evidenceClass: "NON_GATE_EVIDENCE",
    requiredPhysicalDevices: 10,
    recordedPhysicalDevices: 2,
    remainingPhysicalDevices: 8,
    simulatedDevices: 8,
    simulatedDevicesCountedTowardGate: 0
  });
  assert.equal(CURRENT_ROADMAP_STATUS.b5.diagnosticPilotAuthorized, false);
  assert.equal(CURRENT_ROADMAP_STATUS.b5.officialCampaignAuthorized, false);
  assert.deepEqual(CURRENT_ROADMAP_STATUS.b6, {
    gateStatus: "PENDING",
    startAuthorization: "BLOCKED"
  });
  assert.deepEqual(CURRENT_ROADMAP_STATUS.applicationLoad, {
    micro: "PASS",
    smoke: "FAIL",
    full: "NOT_RUN"
  });
  assert.equal(Object.isFrozen(CURRENT_ROADMAP_STATUS), true);
  assert.equal(Object.isFrozen(CURRENT_ROADMAP_STATUS.b4), true);
});

test("roadmap promotion requires package, evidence and both official flags", () => {
  const eligibleStatus = {
    promotion: {
      physicalGatePromotionAllowed: true,
      officialProgressIncreaseAllowed: true
    }
  };
  const evaluate = (overrides = {}) =>
    isRoadmapPromotionAllowed({
      packageValid: true,
      externalEvidenceBlockers: [],
      currentRoadmapStatus: eligibleStatus,
      ...overrides
    });

  assert.equal(evaluate(), true);
  assert.equal(
    evaluate({ currentRoadmapStatus: CURRENT_ROADMAP_STATUS }),
    false
  );
  assert.equal(evaluate({ packageValid: false }), false);
  assert.equal(evaluate({ packageValid: 1 }), false);
  assert.equal(evaluate({ externalEvidenceBlockers: [{}] }), false);
  assert.equal(evaluate({ externalEvidenceBlockers: undefined }), false);
  assert.equal(
    evaluate({
      currentRoadmapStatus: {
        promotion: {
          physicalGatePromotionAllowed: false,
          officialProgressIncreaseAllowed: true
        }
      }
    }),
    false
  );
  assert.equal(
    evaluate({
      currentRoadmapStatus: {
        promotion: {
          physicalGatePromotionAllowed: true,
          officialProgressIncreaseAllowed: false
        }
      }
    }),
    false
  );
  assert.equal(
    evaluate({
      currentRoadmapStatus: {
        promotion: {
          physicalGatePromotionAllowed: 1,
          officialProgressIncreaseAllowed: true
        }
      }
    }),
    false
  );
  assert.equal(
    evaluate({
      currentRoadmapStatus: {
        promotion: { physicalGatePromotionAllowed: true }
      }
    }),
    false
  );
  assert.equal(evaluate({ currentRoadmapStatus: null }), false);
});

test("binds fail-closed to the canonical Advanced certification matrix", () => {
  assert.equal(
    CURRENT_ROADMAP_STATUS.certificationMatrix.matrixSha256,
    ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256
  );
  expectInvalid(
    (status) => {
      status.certificationMatrix.matrixSha256 = "f".repeat(64);
    },
    "CURRENT_ROADMAP_MATRIX_MISMATCH"
  );
  assert.throws(
    () =>
      parseCurrentRoadmapStatus(JSON.stringify(VALID_STATUS), {
        matrixBinding: {
          ...ADVANCED_CERTIFICATION_TARGETS_BINDING,
          matrixSha256: "e".repeat(64)
        }
      }),
    (error) =>
      error instanceof CurrentRoadmapStatusError &&
      error.code === "CURRENT_ROADMAP_MATRIX_MISMATCH"
  );
});

test("rejects missing, extra and stale top-level facts", () => {
  expectInvalid((status) => {
    status.unexpected = true;
  });
  expectInvalid((status) => {
    delete status.b5;
  });
  expectInvalid((status) => {
    status.officialProgressPercent = 50;
  });
  expectInvalid((status) => {
    status.statusAsOf = "2026-08-09";
  });
});

test("never counts simulated devices or promotes B4, B5 or B6", () => {
  const mutations = [
    (status) => { status.b4.simulatedDevicesCountedTowardGate = 8; },
    (status) => { status.b4.recordedPhysicalDevices = 10; },
    (status) => { status.b4.gateStatus = "PASS"; },
    (status) => { status.b5.gateStatus = "PASS"; },
    (status) => { status.b5.diagnosticPilotAuthorized = true; },
    (status) => { status.b5.officialCampaignAuthorized = true; },
    (status) => { status.b6.startAuthorization = "ALLOWED"; },
    (status) => { status.promotion.physicalGatePromotionAllowed = true; },
    (status) => { status.promotion.officialProgressIncreaseAllowed = true; }
  ];
  for (const mutation of mutations) expectInvalid(mutation);
});

test("freezes the current application load classification", () => {
  expectInvalid((status) => {
    status.applicationLoad.micro = "PENDING";
  });
  expectInvalid((status) => {
    status.applicationLoad.smoke = "PASS";
  });
  expectInvalid((status) => {
    status.applicationLoad.full = "PASS";
  });
});

test("schema v1 mirrors the exact public status contract", () => {
  const schema = loadCurrentRoadmapStatusSchema(SCHEMA_PATH);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.equal(schema.properties.statusAsOf.const, "2026-08-10");
  assert.equal(schema.properties.officialProgressPercent.const, 49);
  assert.equal(schema.properties.b4.properties.recordedPhysicalDevices.const, 2);
  assert.equal(
    schema.properties.b4.properties.simulatedDevicesCountedTowardGate.const,
    0
  );
  assert.equal(schema.properties.b5.properties.gateStatus.const, "PENDING");
  assert.equal(schema.properties.b6.properties.startAuthorization.const, "BLOCKED");
  assert.equal(schema.properties.applicationLoad.properties.micro.const, "PASS");
  assert.equal(schema.properties.applicationLoad.properties.smoke.const, "FAIL");
  assert.equal(schema.properties.applicationLoad.properties.full.const, "NOT_RUN");
  assert.equal(validateCurrentRoadmapStatusSchema(VALID_STATUS, schema), true);
});

test("schema validation rejects divergent constants and incomplete topology", () => {
  const divergent = structuredClone(loadCurrentRoadmapStatusSchema(SCHEMA_PATH));
  divergent.properties.b4.properties.remainingPhysicalDevices.const = 7;
  assert.throws(
    () => validateCurrentRoadmapStatusSchema(VALID_STATUS, divergent),
    (error) =>
      error instanceof CurrentRoadmapStatusError &&
      error.code === "CURRENT_ROADMAP_STATUS_SCHEMA_MISMATCH"
  );

  const incomplete = structuredClone(loadCurrentRoadmapStatusSchema(SCHEMA_PATH));
  delete incomplete.properties.b5.properties.recordedOfficialSessions;
  assert.throws(
    () => validateCurrentRoadmapStatusSchema(VALID_STATUS, incomplete),
    (error) =>
      error instanceof CurrentRoadmapStatusError &&
      error.code === "CURRENT_ROADMAP_SCHEMA_INVALID"
  );
});

test("schema validation fails closed on unsupported keywords", () => {
  const schema = structuredClone(loadCurrentRoadmapStatusSchema(SCHEMA_PATH));
  schema.properties.officialProgressPercent.minimum = 0;
  assert.throws(
    () => validateCurrentRoadmapStatusSchema(VALID_STATUS, schema),
    (error) =>
      error instanceof CurrentRoadmapStatusError &&
      error.code === "CURRENT_ROADMAP_SCHEMA_INVALID"
  );
});

test("loader rejects missing files, symlinks and malformed content", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v5bt-current-roadmap-status-")
  );
  const target = path.join(directory, "status.json");
  const link = path.join(directory, "status-link.json");
  try {
    assert.throws(
      () => loadCurrentRoadmapStatus(path.join(directory, "missing.json")),
      (error) =>
        error instanceof CurrentRoadmapStatusError &&
        error.code === "CURRENT_ROADMAP_STATUS_UNAVAILABLE"
    );
    fs.writeFileSync(target, JSON.stringify(VALID_STATUS), { mode: 0o600 });
    fs.symlinkSync(target, link);
    assert.throws(
      () => loadCurrentRoadmapStatus(link),
      (error) =>
        error instanceof CurrentRoadmapStatusError &&
        error.code === "CURRENT_ROADMAP_STATUS_UNAVAILABLE"
    );
    assert.deepEqual(loadCurrentRoadmapStatus(target), CURRENT_ROADMAP_STATUS);
    fs.writeFileSync(target, "{}", { mode: 0o600 });
    assert.throws(
      () => loadCurrentRoadmapStatus(target),
      (error) =>
        error instanceof CurrentRoadmapStatusError &&
        error.code === "CURRENT_ROADMAP_STATUS_INVALID"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI validates the default status and rejects unsafe overrides", () => {
  const success = spawnSync(process.execPath, [SCRIPT_PATH], {
    encoding: "utf8"
  });
  assert.equal(success.status, 0, success.stderr);
  const report = JSON.parse(success.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.officialProgressPercent, 49);
  assert.equal(report.b4.simulatedDevicesCountedTowardGate, 0);
  assert.equal(report.b6.startAuthorization, "BLOCKED");

  const failure = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "--unknown"],
    { encoding: "utf8" }
  );
  assert.notEqual(failure.status, 0);
  assert.equal(JSON.parse(failure.stderr).ok, false);
});
