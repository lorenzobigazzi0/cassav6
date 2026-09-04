import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  B5HundredSessionGateError,
  B5_REQUIRED_SESSION_REPORTS,
  aggregateValidatedSessionReports,
  assertAggregateReportRedacted,
  parseCollectorCampaignState,
  parseEvidenceManifest,
  runSelfTest,
  validCollectorCampaignStateFixture,
  validPhysicalReportFixture
} from "../scripts/run-b5-hundred-session-gate.mjs";
import {
  B5_ANDROID_CONTINUITY_MONITOR_VERSION,
  validB5AndroidContinuityAttestationFixture
} from "../../scripts/run-b5-android-continuity-monitor.mjs";
import { validB5RaspberryContinuityAttestationFixture } from "../../scripts/run-b5-raspberry-continuity-monitor.mjs";
import {
  sha256Hex,
  validB5CampaignAuthorizationFixture
} from "../../scripts/b5-campaign-governance.mjs";
import {
  appendB5CampaignSupervisorAttempt,
  appendB5CampaignSupervisorResume,
  createInitialB5CampaignSupervisorLedger,
  validB5CampaignSupervisorLedgerFixture
} from "../scripts/run-b5-campaign-supervisor.mjs";
import {
  parseB5TechnicalReceipt,
  technicalReceiptSha256
} from "../../scripts/b5-technical-receipt.mjs";
import {
  b5AccountDeviceSensitiveValues,
  validB5AccountDeviceBindingFixture
} from "../../scripts/b5-account-device-commitment.mjs";
import {
  ADVANCED_CERTIFICATION_TARGETS
} from "../../scripts/advanced-certification-targets.mjs";

const CAMPAIGN_RUN_ID = "00000000-0000-4000-8000-000000000001";

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function record(sequence) {
  const report = validPhysicalReportFixture(sequence);
  return {
    sequence,
    sourceReportSha256: digest(JSON.stringify(report)),
    report
  };
}

function records() {
  return Array.from(
    { length: B5_REQUIRED_SESSION_REPORTS },
    (_, index) => record(index + 1)
  );
}

function privateBaselineFixture(campaignId = CAMPAIGN_RUN_ID) {
  const target = ADVANCED_CERTIFICATION_TARGETS.roles.handheld;
  const nowMs = Date.parse("2026-07-20T00:00:00.000Z");
  return {
    schemaVersion: 1,
    harnessVersion: B5_ANDROID_CONTINUITY_MONITOR_VERSION,
    product: "V6",
    phase: "B5",
    mode: "PRIVATE_ANDROID_CONTINUITY_BASELINE",
    campaignId,
    createdAt: new Date(nowMs).toISOString(),
    binding: {
      serial: "V6-PHYSICAL-HANDHELD-001",
      role: "handheld",
      packageName: target.packageId,
      versionName: target.versionName,
      versionCode: target.versionCode,
      androidApi: 36,
      androidUserId: 0,
      appUid: 10_001,
      pid: 2_345,
      gattReporterStartedAtEpochMs: nowMs - 60_000,
      agentReporterStartedAtEpochMs: nowMs - 120_000,
      sessionHmacKeyBase64: Buffer.alloc(32, 7).toString("base64"),
      sessionBindingHmacSha256: "1".repeat(64),
      apkSha256: target.sha256
    },
    reporters: {
      gattSampleSequence: 10,
      gattSampledAtEpochMs: nowMs,
      agentSampleSequence: 20,
      agentSampledAtEpochMs: nowMs,
      agentStartCount: 1,
      agentStopCount: 0
    },
    exitInfo: { recordCommitmentsSha256: [] }
  };
}

function ledgerWithPreCommitTimeouts() {
  let ledger = createInitialB5CampaignSupervisorLedger({
    campaignRunId: CAMPAIGN_RUN_ID,
    now: "2026-07-20T23:57:59.000Z"
  });
  for (let index = 1; index <= 3; index += 1) {
    const startedAt = `2026-07-20T23:58:0${index * 2}.000Z`;
    ledger = appendB5CampaignSupervisorAttempt(ledger, {
      eventId: `10000000-0000-4${String(index).padStart(3, "0")}-8000-${String(index).padStart(12, "0")}`,
      startedAt,
      completedAt: new Date(Date.parse(startedAt) + 1_000).toISOString(),
      outcome: "RADIO_TIMEOUT",
      errorCode: "DIRECT_CONTROL_ORCHESTRATION_TIMEOUT",
      cleanupVerified: true,
      collectorCountBefore: 0,
      collectorCountAfter: 0
    });
  }
  ledger = appendB5CampaignSupervisorResume(ledger, {
    eventId: "10000000-0000-4004-8000-000000000004",
    resumedAt: "2026-07-20T23:58:08.000Z",
    collectorCount: 0
  });
  const firstStartedAtMs = Date.parse("2026-07-21T00:00:00.500Z");
  for (let sequence = 1; sequence <= 100; sequence += 1) {
    const startedAt = new Date(firstStartedAtMs + (sequence - 1) * 61_000).toISOString();
    ledger = appendB5CampaignSupervisorAttempt(ledger, {
      eventId: `20000000-0000-4${String(sequence).padStart(3, "0")}-8000-${String(sequence).padStart(12, "0")}`,
      startedAt,
      completedAt: new Date(Date.parse(startedAt) + 60_750).toISOString(),
      outcome: "COMMITTED",
      errorCode: null,
      cleanupVerified: true,
      collectorCountBefore: sequence - 1,
      collectorCountAfter: sequence
    });
  }
  return ledger;
}

function manifest(count = B5_REQUIRED_SESSION_REPORTS) {
  return {
    schemaVersion: 1,
    gate: "B5_HUNDRED_ANDROID_RASPBERRY_SESSIONS",
    reports: Array.from({ length: count }, (_, index) => ({
      slot: String(index + 1).padStart(3, "0"),
      report: `reports/b5-7-session-${String(index + 1).padStart(3, "0")}.json`
    }))
  };
}

const GATE_SCRIPT = fileURLToPath(
  new URL("../scripts/run-b5-hundred-session-gate.mjs", import.meta.url)
);
const MATRIX_PATH = fileURLToPath(
  new URL("../../configs/advanced-certification-targets.json", import.meta.url)
);
const MATRIX_SHA256 = sha256Hex(fs.readFileSync(MATRIX_PATH));

function runGate(
  manifestPath,
  outputPath,
  campaignStatePath = path.join(path.dirname(manifestPath), "campaign-state.json"),
  attemptStatePath = path.join(path.dirname(manifestPath), "attempt-state.json"),
  androidBaselinePath = path.join(
    path.dirname(manifestPath),
    "android-baseline.json"
  ),
  androidAttestationPath = path.join(
    path.dirname(manifestPath),
    "android-attestation.json"
  ),
  raspberryAttestationPath = path.join(
    path.dirname(manifestPath),
    "raspberry-attestation.json"
  ),
  campaignAuthorizationPath = path.join(
    path.dirname(manifestPath),
    "campaign-authorization.json"
  ),
  technicalReceiptPath = path.join(
    path.dirname(outputPath),
    "technical-receipt.json"
  )
) {
  return spawnSync(
    process.execPath,
    [
      GATE_SCRIPT,
      "--manifest",
      manifestPath,
      "--campaign-state",
      campaignStatePath,
      "--attempt-state",
      attemptStatePath,
      "--android-baseline",
      androidBaselinePath,
      "--android-attestation",
      androidAttestationPath,
      "--raspberry-attestation",
      raspberryAttestationPath,
      "--campaign-authorization",
      campaignAuthorizationPath,
      "--output",
      outputPath,
      "--technical-receipt",
      technicalReceiptPath
    ],
    { encoding: "utf8" }
  );
}

function writeFixtureCampaign(directory) {
  const reportsDirectory = path.join(directory, "reports");
  fs.mkdirSync(reportsDirectory, { recursive: true, mode: 0o700 });
  const evidenceRecords = [];
  for (let sequence = 1; sequence <= B5_REQUIRED_SESSION_REPORTS; sequence += 1) {
    const slot = String(sequence).padStart(3, "0");
    const report = validPhysicalReportFixture(sequence);
    const bytes = `${JSON.stringify(report, null, 2)}\n`;
    fs.writeFileSync(
      path.join(reportsDirectory, `b5-7-session-${slot}.json`),
      bytes,
      { mode: 0o600 }
    );
    evidenceRecords.push({
      sequence,
      sourceReportSha256: digest(bytes),
      report
    });
  }
  const manifestPath = path.join(directory, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest(), null, 2)}\n`, {
    mode: 0o600
  });
  const campaignState = validCollectorCampaignStateFixture(evidenceRecords, {
    campaignRunId: CAMPAIGN_RUN_ID
  });
  fs.writeFileSync(
    path.join(directory, "campaign-state.json"),
    `${JSON.stringify(campaignState, null, 2)}\n`,
    { mode: 0o600 }
  );
  const attemptState = validB5CampaignSupervisorLedgerFixture({
    campaignRunId: CAMPAIGN_RUN_ID
  });
  fs.writeFileSync(
    path.join(directory, "attempt-state.json"),
    `${JSON.stringify(attemptState, null, 2)}\n`,
    { mode: 0o600 }
  );
  fs.writeFileSync(
    path.join(directory, "android-baseline.json"),
    `${JSON.stringify(privateBaselineFixture(), null, 2)}\n`,
    { mode: 0o600 }
  );
  const androidAttestation = validB5AndroidContinuityAttestationFixture({
    campaignId: CAMPAIGN_RUN_ID,
    monitoredFrom: "2026-07-21T00:00:00.000Z",
    requiredDurationMs: 6_101_000,
    pollIntervalMs: 5_000
  });
  fs.writeFileSync(
    path.join(directory, "android-attestation.json"),
    `${JSON.stringify(androidAttestation, null, 2)}\n`,
    { mode: 0o600 }
  );
  const raspberryAttestation = validB5RaspberryContinuityAttestationFixture({
    campaignId: CAMPAIGN_RUN_ID,
    monitoredFrom: "2026-07-21T00:00:00.000Z",
    requiredDurationMs: 6_101_000,
    pollIntervalMs: 5_000
  });
  fs.writeFileSync(
    path.join(directory, "raspberry-attestation.json"),
    `${JSON.stringify(raspberryAttestation, null, 2)}\n`,
    { mode: 0o600 }
  );
  const campaignAuthorization = validB5CampaignAuthorizationFixture({
    campaignId: CAMPAIGN_RUN_ID,
    certificationMatrixSha256: MATRIX_SHA256
  });
  fs.writeFileSync(
    path.join(directory, "campaign-authorization.json"),
    `${JSON.stringify(campaignAuthorization, null, 2)}\n`,
    { mode: 0o600 }
  );
  return manifestPath;
}

function assertCode(code) {
  return (error) =>
    error instanceof B5HundredSessionGateError && error.code === code;
}

function aggregate(values = records(), options = {}) {
  const campaignState = options.campaignState ??
    validCollectorCampaignStateFixture(values, {
      campaignRunId: CAMPAIGN_RUN_ID
    });
  const androidAttestation = options.androidAttestation ??
    validB5AndroidContinuityAttestationFixture({
      campaignId: campaignState.campaignRunId,
      monitoredFrom: "2026-07-21T00:00:00.000Z",
      requiredDurationMs: 6_101_000,
      pollIntervalMs: 5_000
    });
  const attemptState = options.attemptState ??
    validB5CampaignSupervisorLedgerFixture({
      campaignRunId: campaignState.campaignRunId
    });
  const raspberryAttestation = options.raspberryAttestation ??
    validB5RaspberryContinuityAttestationFixture({
      campaignId: campaignState.campaignRunId,
      monitoredFrom: "2026-07-21T00:00:00.000Z",
      requiredDurationMs: 6_101_000,
      pollIntervalMs: 5_000
    });
  const campaignAuthorization = options.campaignAuthorization ??
    validB5CampaignAuthorizationFixture({
      campaignId: campaignState.campaignRunId,
      certificationMatrixSha256: MATRIX_SHA256
    });
  const accountDeviceBinding = options.accountDeviceBinding ??
    validB5AccountDeviceBindingFixture({
      campaignId: campaignState.campaignRunId
    });
  return aggregateValidatedSessionReports(values, {
    generatedAt: options.generatedAt ?? "2026-07-22T00:00:00.000Z",
    campaignState,
    attemptState,
    accountDeviceBinding,
    androidAttestation,
    raspberryAttestation,
    campaignAuthorization,
    certificationMatrixSha256: MATRIX_SHA256
  });
}

test("B5 manifest requires the exact ordered slots 001 through 100", () => {
  const parsed = parseEvidenceManifest(JSON.stringify(manifest()));
  assert.equal(parsed.reports.length, 100);
  assert.equal(parsed.reports[0].slot, "001");
  assert.equal(parsed.reports[99].slot, "100");
  assert.equal(parsed.reports[0].sequence, 1);
  assert.equal(parsed.reports[99].sequence, 100);

  assert.throws(
    () => parseEvidenceManifest(JSON.stringify(manifest(99))),
    assertCode("SESSION_COUNT_INVALID")
  );
  assert.throws(
    () => parseEvidenceManifest(JSON.stringify(manifest(101))),
    assertCode("SESSION_COUNT_INVALID")
  );

  const missingSlot = manifest();
  missingSlot.reports[49].slot = "051";
  assert.throws(
    () => parseEvidenceManifest(JSON.stringify(missingSlot)),
    assertCode("SESSION_SEQUENCE_INVALID")
  );
});

test("B5 manifest rejects reused locations, traversal and extra fields", () => {
  const duplicate = manifest();
  duplicate.reports[1].report = duplicate.reports[0].report;
  assert.throws(
    () => parseEvidenceManifest(JSON.stringify(duplicate)),
    assertCode("DUPLICATE_EVIDENCE")
  );

  const traversal = manifest();
  traversal.reports[0].report = "../b5-7-session-001.json";
  assert.throws(
    () => parseEvidenceManifest(JSON.stringify(traversal)),
    assertCode("MANIFEST_INVALID")
  );

  const extra = manifest();
  extra.reports[0].digest = digest("not-accepted-from-manifest");
  assert.throws(
    () => parseEvidenceManifest(JSON.stringify(extra)),
    assertCode("MANIFEST_INVALID")
  );
});

test("B5 collector state requires bound schema 3 and exactly 100 committed records", () => {
  const state = validCollectorCampaignStateFixture(records(), {
    campaignRunId: CAMPAIGN_RUN_ID
  });
  const parsed = parseCollectorCampaignState(JSON.stringify(state));
  assert.equal(parsed.state.schemaVersion, 3);
  assert.equal(parsed.records.length, 100);
  assert.equal(parsed.accountDeviceBound, true);
  assert.match(parsed.accountDeviceCommitmentSha256, /^[0-9a-f]{64}$/u);
  assert.match(parsed.collectionCommitmentSha256, /^[0-9a-f]{64}$/u);
  assert.match(parsed.campaignIdCommitmentSha256, /^[0-9a-f]{64}$/u);

  for (const invalid of [
    { ...structuredClone(state), schemaVersion: 1 },
    { ...structuredClone(state), records: state.records.slice(0, 99) },
    { ...structuredClone(state), collectionCommitmentSha256: "0".repeat(64) }
  ]) {
    assert.throws(
      () => parseCollectorCampaignState(invalid),
      assertCode("CAMPAIGN_STATE_INVALID")
    );
  }
});

test("B5 collector state keeps one account/device commitment across all 100 slots", () => {
  const values = records();
  const state = validCollectorCampaignStateFixture(values, {
    campaignRunId: CAMPAIGN_RUN_ID
  });
  assert.equal(
    state.records.every(
      (record) =>
        record.accountDeviceCommitmentSha256 ===
        state.accountDeviceCommitmentSha256
    ),
    true
  );

  const missing = structuredClone(state);
  delete missing.records[49].accountDeviceCommitmentSha256;
  assert.throws(
    () => parseCollectorCampaignState(missing),
    assertCode("CAMPAIGN_STATE_INVALID")
  );

  const missingStateCommitment = structuredClone(state);
  delete missingStateCommitment.accountDeviceCommitmentSha256;
  assert.throws(
    () => parseCollectorCampaignState(missingStateCommitment),
    assertCode("CAMPAIGN_STATE_INVALID")
  );

  const changed = structuredClone(state);
  changed.records[49].accountDeviceCommitmentSha256 = "9".repeat(64);
  assert.throws(
    () => parseCollectorCampaignState(changed),
    assertCode("CAMPAIGN_STATE_INVALID")
  );
});

test("B5 historical unbound state remains readable but non-promotable", () => {
  const values = records();
  const historical = structuredClone(
    validCollectorCampaignStateFixture(values, {
      campaignRunId: CAMPAIGN_RUN_ID
    })
  );
  historical.schemaVersion = 2;
  historical.harnessVersion = "1.1.0";
  delete historical.accountDeviceCommitmentSha256;
  for (const record of historical.records) {
    delete record.accountDeviceCommitmentSha256;
  }

  const parsed = parseCollectorCampaignState(historical);
  assert.equal(parsed.accountDeviceBound, false);
  assert.equal(parsed.accountDeviceCommitmentSha256, null);
  assert.throws(
    () => aggregate(values, { campaignState: historical }),
    assertCode("ACCOUNT_DEVICE_COMMITMENT_REQUIRED")
  );
});

test("B5 aggregation rejects a private account/device binding mismatch", () => {
  const values = records();
  const campaignState = validCollectorCampaignStateFixture(values, {
    campaignRunId: CAMPAIGN_RUN_ID
  });
  const mismatched = {
    ...validB5AccountDeviceBindingFixture({ campaignId: CAMPAIGN_RUN_ID }),
    deviceSerial: "V6-PHYSICAL-HANDHELD-002"
  };

  assert.throws(
    () => aggregate(values, { campaignState, accountDeviceBinding: mismatched }),
    assertCode("ACCOUNT_DEVICE_COMMITMENT_MISMATCH")
  );
});

test("B5 aggregation requires all private campaign bindings", () => {
  const values = records();
  assert.throws(
    () =>
      aggregateValidatedSessionReports(values, {
        generatedAt: "2026-07-22T00:00:00.000Z"
      }),
    assertCode("CAMPAIGN_STATE_REQUIRED")
  );
  const campaignState = validCollectorCampaignStateFixture(values, {
    campaignRunId: CAMPAIGN_RUN_ID
  });
  assert.throws(
    () =>
      aggregateValidatedSessionReports(values, {
        generatedAt: "2026-07-22T00:00:00.000Z",
        campaignState
      }),
    assertCode("ANDROID_ATTESTATION_REQUIRED")
  );
});

test("B5 binds every collector metadata record to its physical report", () => {
  const values = records();
  const campaignState = validCollectorCampaignStateFixture(values, {
    campaignRunId: CAMPAIGN_RUN_ID
  });
  campaignState.records[0].pingsSent += 1;
  assert.throws(
    () => aggregate(values, { campaignState }),
    assertCode("CAMPAIGN_STATE_EVIDENCE_MISMATCH")
  );

  const digestMismatch = validCollectorCampaignStateFixture(values, {
    campaignRunId: CAMPAIGN_RUN_ID
  });
  digestMismatch.records[0].reportSha256 = digest("different-report");
  digestMismatch.collectionCommitmentSha256 = digest(
    digestMismatch.records.map((entry) => entry.reportSha256).join("\n")
  );
  assert.throws(
    () => aggregate(values, { campaignState: digestMismatch }),
    assertCode("CAMPAIGN_STATE_EVIDENCE_MISMATCH")
  );
});

test("B5 binds Android continuity to the campaign and complete timeline", () => {
  const values = records();
  const campaignState = validCollectorCampaignStateFixture(values, {
    campaignRunId: CAMPAIGN_RUN_ID
  });
  const otherCampaign = validB5AndroidContinuityAttestationFixture({
    campaignId: "00000000-0000-4000-8000-000000000002",
    monitoredFrom: "2026-07-21T00:00:00.000Z",
    requiredDurationMs: 6_101_000,
    pollIntervalMs: 5_000
  });
  assert.throws(
    () => aggregate(values, { campaignState, androidAttestation: otherCampaign }),
    assertCode("ANDROID_CAMPAIGN_BINDING_INVALID")
  );

  const shortTimeline = validB5AndroidContinuityAttestationFixture({
    campaignId: CAMPAIGN_RUN_ID,
    monitoredFrom: "2026-07-21T00:00:00.000Z",
    requiredDurationMs: 6_099_000,
    pollIntervalMs: 5_000
  });
  assert.throws(
    () => aggregate(values, { campaignState, androidAttestation: shortTimeline }),
    assertCode("ANDROID_TIMELINE_INCOMPLETE")
  );

  const commitmentMismatch = structuredClone(
    validB5AndroidContinuityAttestationFixture({
      campaignId: CAMPAIGN_RUN_ID,
      monitoredFrom: "2026-07-21T00:00:00.000Z",
      requiredDurationMs: 6_101_000,
      pollIntervalMs: 5_000
    })
  );
  commitmentMismatch.accountDeviceCommitmentSha256 = "8".repeat(64);
  assert.throws(
    () => aggregate(values, { campaignState, androidAttestation: commitmentMismatch }),
    assertCode("ACCOUNT_DEVICE_COMMITMENT_MISMATCH")
  );

  const historical = structuredClone(
    validB5AndroidContinuityAttestationFixture({
      campaignId: CAMPAIGN_RUN_ID,
      monitoredFrom: "2026-07-21T00:00:00.000Z",
      requiredDurationMs: 6_101_000,
      pollIntervalMs: 5_000
    })
  );
  historical.harnessVersion = "1.0.0";
  delete historical.accountDeviceCommitmentSha256;
  delete historical.privacy.accountDeviceCommitmentIncluded;
  assert.throws(
    () => aggregate(values, { campaignState, androidAttestation: historical }),
    assertCode("ACCOUNT_DEVICE_COMMITMENT_REQUIRED")
  );
});

test("B5 rejects Android process, session or crash continuity failures", () => {
  const values = records();
  const campaignState = validCollectorCampaignStateFixture(values, {
    campaignRunId: CAMPAIGN_RUN_ID
  });
  for (const field of ["pidChanges", "sessionBindingChanges", "crashes", "anrs"]) {
    const attestation = structuredClone(
      validB5AndroidContinuityAttestationFixture({
        campaignId: CAMPAIGN_RUN_ID,
        monitoredFrom: "2026-07-21T00:00:00.000Z",
        requiredDurationMs: 6_101_000,
        pollIntervalMs: 5_000
      })
    );
    attestation.observed[field] = 1;
    assert.throws(
      () => aggregate(values, { campaignState, androidAttestation: attestation }),
      assertCode("ANDROID_ATTESTATION_INVALID")
    );
  }

  const stationAttestation = structuredClone(
    validB5AndroidContinuityAttestationFixture({
      campaignId: CAMPAIGN_RUN_ID,
      monitoredFrom: "2026-07-21T00:00:00.000Z",
      requiredDurationMs: 6_101_000,
      pollIntervalMs: 5_000
    })
  );
  const station = JSON.parse(fs.readFileSync(MATRIX_PATH, "utf8")).roles.station;
  Object.assign(stationAttestation.target, {
    role: "station",
    packageName: station.packageId,
    versionName: station.versionName,
    versionCode: station.versionCode
  });
  assert.throws(
    () => aggregate(values, { campaignState, androidAttestation: stationAttestation }),
    assertCode("ANDROID_TARGET_ROLE_INVALID")
  );
});

test("B5 binds the attempt ledger to the campaign and collector windows", () => {
  const values = records();
  const campaignState = validCollectorCampaignStateFixture(values, {
    campaignRunId: CAMPAIGN_RUN_ID
  });
  const otherCampaign = validB5CampaignSupervisorLedgerFixture({
    campaignRunId: "00000000-0000-4000-8000-000000000002"
  });
  assert.throws(
    () => aggregate(values, { campaignState, attemptState: otherCampaign }),
    assertCode("ATTEMPT_CAMPAIGN_BINDING_INVALID")
  );

  const altered = structuredClone(
    validB5CampaignSupervisorLedgerFixture({ campaignRunId: CAMPAIGN_RUN_ID })
  );
  altered.events[0].cleanupVerified = false;
  assert.throws(
    () => aggregate(values, { campaignState, attemptState: altered }),
    assertCode("ATTEMPT_STATE_INVALID")
  );
});

test("B5 binds Raspberry continuity to the campaign and full timeline", () => {
  const values = records();
  const campaignState = validCollectorCampaignStateFixture(values, {
    campaignRunId: CAMPAIGN_RUN_ID
  });
  const otherCampaign = validB5RaspberryContinuityAttestationFixture({
    campaignId: "00000000-0000-4000-8000-000000000002",
    monitoredFrom: "2026-07-21T00:00:00.000Z",
    requiredDurationMs: 6_101_000,
    pollIntervalMs: 5_000
  });
  assert.throws(
    () => aggregate(values, { campaignState, raspberryAttestation: otherCampaign }),
    assertCode("RASPBERRY_CAMPAIGN_BINDING_INVALID")
  );

  const shortTimeline = validB5RaspberryContinuityAttestationFixture({
    campaignId: CAMPAIGN_RUN_ID,
    monitoredFrom: "2026-07-21T00:00:00.000Z",
    requiredDurationMs: 6_099_000,
    pollIntervalMs: 5_000
  });
  assert.throws(
    () => aggregate(values, { campaignState, raspberryAttestation: shortTimeline }),
    assertCode("RASPBERRY_TIMELINE_INCOMPLETE")
  );
});

test("B5 requires a B0-B4 authorization bound to campaign and matrix", () => {
  const values = records();
  const campaignState = validCollectorCampaignStateFixture(values, {
    campaignRunId: CAMPAIGN_RUN_ID
  });
  const otherCampaign = validB5CampaignAuthorizationFixture({
    campaignId: "00000000-0000-4000-8000-000000000002",
    certificationMatrixSha256: MATRIX_SHA256
  });
  assert.throws(
    () => aggregate(values, { campaignState, campaignAuthorization: otherCampaign }),
    assertCode("CAMPAIGN_AUTHORIZATION_BINDING_INVALID")
  );

  const failedPrerequisite = validB5CampaignAuthorizationFixture({
    campaignId: CAMPAIGN_RUN_ID,
    certificationMatrixSha256: MATRIX_SHA256
  });
  failedPrerequisite.prerequisites.b4 = "PENDING";
  assert.throws(
    () => aggregate(values, { campaignState, campaignAuthorization: failedPrerequisite }),
    assertCode("CAMPAIGN_AUTHORIZATION_INVALID")
  );

  const lateAuthorization = validB5CampaignAuthorizationFixture({
    campaignId: CAMPAIGN_RUN_ID,
    certificationMatrixSha256: MATRIX_SHA256,
    issuedAt: "2026-07-21T00:00:00.600Z"
  });
  assert.throws(
    () => aggregate(values, { campaignState, campaignAuthorization: lateAuthorization }),
    assertCode("CAMPAIGN_AUTHORIZATION_TIMELINE_INVALID")
  );
});

test("B5 continuity covers timeout and resume attempts before the first commit", () => {
  const values = records();
  const campaignState = validCollectorCampaignStateFixture(values, {
    campaignRunId: CAMPAIGN_RUN_ID
  });
  const attemptState = ledgerWithPreCommitTimeouts();
  const earlyAuthorization = validB5CampaignAuthorizationFixture({
    campaignId: CAMPAIGN_RUN_ID,
    certificationMatrixSha256: MATRIX_SHA256,
    issuedAt: "2026-07-20T23:57:00.000Z"
  });
  assert.throws(
    () => aggregate(values, {
      campaignState,
      attemptState,
      campaignAuthorization: earlyAuthorization
    }),
    assertCode("ANDROID_TIMELINE_INCOMPLETE")
  );

  const androidAttestation = validB5AndroidContinuityAttestationFixture({
    campaignId: CAMPAIGN_RUN_ID,
    monitoredFrom: "2026-07-20T23:57:00.000Z",
    requiredDurationMs: 6_281_000,
    pollIntervalMs: 5_000
  });
  assert.throws(
    () => aggregate(values, {
      campaignState,
      attemptState,
      campaignAuthorization: earlyAuthorization,
      androidAttestation
    }),
    assertCode("RASPBERRY_TIMELINE_INCOMPLETE")
  );
});

test("B5 aggregates exactly 100 complete physical sessions", () => {
  const report = aggregate();
  assert.equal(report.verdict, "TECHNICAL_PASS");
  assert.equal(report.harnessVersion, "1.5.0");
  assert.equal(report.mode, "PHYSICAL_HUNDRED_SESSION_TECHNICAL_AGGREGATE");
  assert.equal(report.campaign.requiredReports, 100);
  assert.equal(report.campaign.acceptedReports, 100);
  assert.equal(report.campaign.collectorStateSchemaVersion, 3);
  assert.match(report.accountDeviceCommitmentSha256, /^[0-9a-f]{64}$/u);
  assert.match(report.attemptLedgerHeadSha256, /^[0-9a-f]{64}$/u);
  assert.match(report.androidAttestationSha256, /^[0-9a-f]{64}$/u);
  assert.match(report.raspberryAttestationSha256, /^[0-9a-f]{64}$/u);
  assert.equal(report.campaign.attemptLedgerSchemaVersion, 1);
  assert.equal(report.campaign.campaignAuthorizationSchemaVersion, 1);
  assert.equal(report.campaign.androidAttestationSchemaVersion, 1);
  assert.equal(report.campaign.raspberryAttestationSchemaVersion, 1);
  assert.equal(report.totals.sessionsOpened, 100);
  assert.equal(report.totals.sessionsActivated, 100);
  assert.equal(report.totals.sessionsClosedCleanly, 100);
  assert.equal(report.totals.pingsSent, 400);
  assert.equal(report.totals.pongsVerified, 400);
  assert.equal(report.totals.failures, 0);
  assert.equal(report.totals.resourceLeaks, 0);
  assert.equal(report.gate.b5TechnicalGate, "PASS");
  assert.equal(report.gate.b5HundredSessionGate, "PENDING_REVIEW");
  assert.equal(report.gate.b6, "PENDING");
  assert.equal(report.physicalEvidenceConsumed, true);
  for (const field of [
    "collectorStateSchema",
    "collectorCollectionCommitment",
    "collectorReportMetadata",
    "accountDeviceCommitment",
    "attemptLedgerIntegrity",
    "attemptCampaignBinding",
    "attemptRetryPolicy",
    "b0B4CampaignAuthorization",
    "androidCampaignBinding",
    "androidTimelineCoverage",
    "androidProcessContinuity",
    "androidSessionContinuity",
    "androidCrashAnrContinuity",
    "raspberryCampaignBinding",
    "raspberryTimelineCoverage",
    "raspberryServiceContinuity",
    "raspberryBootClockContinuity"
  ]) {
    assert.equal(report.checks[field], "PASS");
  }

  const encoded = JSON.stringify(report);
  assert.equal(encoded.includes("sourceReportSha256"), false);
  assert.equal(encoded.includes("b5-7-session-"), false);
  assert.equal(encoded.includes('"reports"'), false);
  assert.equal(encoded.includes("collectionCommitmentSha256"), false);
  assert.equal(encoded.includes("campaignIdCommitmentSha256"), false);
  assert.equal(encoded.includes("accountDeviceCommitmentSha256"), true);
  assert.equal(encoded.includes("evidenceRecordId"), false);
  assert.equal(encoded.includes("targetSignatureSha256"), false);
  assert.equal(report.privacy.campaignCommitmentsIncluded, true);
  assert.equal(report.privacy.privateRecordIdentifiersIncluded, false);
  for (const privateValue of b5AccountDeviceSensitiveValues(
    validB5AccountDeviceBindingFixture({ campaignId: CAMPAIGN_RUN_ID })
  )) {
    if (typeof privateValue === "string") {
      assert.equal(encoded.includes(privateValue), false, privateValue);
    }
  }
  assert.equal(assertAggregateReportRedacted(report), true);
});

test("B5 rejects incomplete and out-of-order report collections", () => {
  assert.throws(
    () => aggregate(records().slice(0, 99)),
    assertCode("SESSION_COUNT_INVALID")
  );

  const reordered = records();
  [reordered[20], reordered[21]] = [reordered[21], reordered[20]];
  assert.throws(
    () => aggregate(reordered),
    assertCode("SESSION_SEQUENCE_INVALID")
  );
});

test("B5 rejects identical report copies and duplicate physical timestamps", () => {
  const copied = records();
  copied[1] = {
    sequence: 2,
    sourceReportSha256: copied[0].sourceReportSha256,
    report: structuredClone(copied[0].report)
  };
  assert.throws(() => aggregate(copied), assertCode("DUPLICATE_EVIDENCE"));

  const duplicateTimestamp = records();
  duplicateTimestamp[1].report.generatedAt =
    duplicateTimestamp[0].report.generatedAt;
  duplicateTimestamp[1].report.observed.pingsSent = 5;
  duplicateTimestamp[1].sourceReportSha256 = digest(
    JSON.stringify(duplicateTimestamp[1].report)
  );
  assert.throws(
    () => aggregate(duplicateTimestamp),
    assertCode("DUPLICATE_EVIDENCE")
  );
});

test("B5 rejects overlapping windows and target changes", () => {
  const overlapping = records();
  overlapping[1].report.generatedAt = new Date(
    Date.parse(overlapping[0].report.generatedAt) + 30_000
  ).toISOString();
  overlapping[1].sourceReportSha256 = digest(
    JSON.stringify(overlapping[1].report)
  );
  assert.throws(
    () => aggregate(overlapping),
    assertCode("SESSION_WINDOWS_OVERLAP")
  );

  const targetChanged = records();
  targetChanged[99].report.target.nodeVersion = "v25.0.0";
  targetChanged[99].sourceReportSha256 = digest(
    JSON.stringify(targetChanged[99].report)
  );
  assert.throws(
    () => aggregate(targetChanged),
    assertCode("CAMPAIGN_TARGET_CHANGED")
  );
});

test("B5 accepts only PASS reports backed by physical radio", () => {
  for (const mutate of [
    (report) => { report.mode = "SELF_TEST"; },
    (report) => { report.verdict = "FAIL"; },
    (report) => { report.physicalRadioAccessed = false; },
    (report) => { report.v6ProductionServiceChanges = true; }
  ]) {
    const values = records();
    mutate(values[0].report);
    values[0].sourceReportSha256 = digest(JSON.stringify(values[0].report));
    assert.throws(
      () => aggregate(values),
      assertCode("REPORT_NOT_PHYSICAL_PASS")
    );
  }
});

test("B5 rejects a failed check or a pre-promoted source gate", () => {
  const failedCheck = records();
  failedCheck[0].report.checks.cleanClose = "FAIL";
  failedCheck[0].sourceReportSha256 = digest(
    JSON.stringify(failedCheck[0].report)
  );
  assert.throws(
    () => aggregate(failedCheck),
    assertCode("REPORT_CHECKS_INVALID")
  );

  const promotedSource = records();
  promotedSource[0].report.gate.hundredSessionCampaign = "PASS";
  promotedSource[0].sourceReportSha256 = digest(
    JSON.stringify(promotedSource[0].report)
  );
  assert.throws(
    () => aggregate(promotedSource),
    assertCode("REPORT_GATE_INVALID")
  );
});

test("B5 validates every privacy field and rejects identifying material", () => {
  const privacyFailure = records();
  privacyFailure[0].report.privacy.identifiersIncluded = true;
  privacyFailure[0].sourceReportSha256 = digest(
    JSON.stringify(privacyFailure[0].report)
  );
  assert.throws(
    () => aggregate(privacyFailure),
    assertCode("REPORT_PRIVACY_INVALID")
  );

  const identifier = records();
  identifier[0].report.target.architecture =
    "123e4567-e89b-12d3-a456-426614174000";
  identifier[0].sourceReportSha256 = digest(
    JSON.stringify(identifier[0].report)
  );
  assert.throws(
    () => aggregate(identifier),
    (error) =>
      error instanceof B5HundredSessionGateError &&
      ["REPORT_TARGET_INVALID", "REPORT_PRIVACY_INVALID"].includes(error.code)
  );
});

test("B5 rejects failed, incomplete and nonconforming lifecycle counters", () => {
  for (const [field, value, code] of [
    ["failures", 1, "SESSION_FAILURE_REPORTED"],
    ["helloExchanged", 0, "REPORT_COUNTERS_INVALID"],
    ["keyEstablishments", 0, "REPORT_COUNTERS_INVALID"],
    ["activeTransitions", 0, "REPORT_COUNTERS_INVALID"],
    ["cleanCloses", 0, "REPORT_COUNTERS_INVALID"],
    ["pingsSent", 3, "REPORT_COUNTERS_INVALID"],
    ["pongsVerified", 3, "REPORT_COUNTERS_INVALID"]
  ]) {
    const values = records();
    values[0].report.observed[field] = value;
    values[0].sourceReportSha256 = digest(JSON.stringify(values[0].report));
    assert.throws(() => aggregate(values), assertCode(code));
  }

  const impossibleHeartbeat = records();
  impossibleHeartbeat[0].report.observed.pongsVerified = 5;
  impossibleHeartbeat[0].sourceReportSha256 = digest(
    JSON.stringify(impossibleHeartbeat[0].report)
  );
  assert.throws(
    () => aggregate(impossibleHeartbeat),
    assertCode("REPORT_COUNTERS_INVALID")
  );
});

test("B5 rejects every active, timer and retained-secret leak counter", () => {
  for (const field of [
    "activeAfterClose",
    "timersAfterClose",
    "retainedSecretBuffersAfterClose",
    "activeAfterCleanup",
    "timersAfterCleanup",
    "retainedSecretBuffersAfterCleanup"
  ]) {
    const values = records();
    values[0].report.observed[field] = 1;
    values[0].sourceReportSha256 = digest(JSON.stringify(values[0].report));
    assert.throws(
      () => aggregate(values),
      assertCode("SESSION_RESOURCE_LEAK")
    );
  }
});

test("B5 aggregate redaction rejects source names and locations", () => {
  const report = aggregate();
  assert.throws(
    () =>
      assertAggregateReportRedacted({
        ...report,
        reportPath: "/tmp/b5-7-session-001.json"
      }),
    assertCode("AGGREGATE_PRIVACY_INVALID")
  );
  assert.throws(
    () => assertAggregateReportRedacted(report, [report.product]),
    assertCode("AGGREGATE_PRIVACY_INVALID")
  );
  assert.throws(
    () =>
      assertAggregateReportRedacted({
        ...report,
        collectionCommitmentSha256: "a".repeat(64)
      }),
    assertCode("AGGREGATE_PRIVACY_INVALID")
  );
});

test("B5 self-test validates logic but leaves the physical gate PENDING", () => {
  const report = runSelfTest();
  assert.equal(report.mode, "SELF_TEST");
  assert.equal(report.verdict, "PASS");
  assert.equal(report.syntheticReportsValidated, 100);
  assert.equal(report.syntheticCollectorStateValidated, true);
  assert.equal(report.syntheticAttemptLedgerValidated, true);
  assert.equal(report.syntheticCampaignAuthorizationValidated, true);
  assert.equal(report.syntheticAndroidAttestationValidated, true);
  assert.equal(report.syntheticRaspberryAttestationValidated, true);
  assert.equal(report.physicalEvidenceConsumed, false);
  assert.equal(report.gate.b5HundredSessionGate, "PENDING");
  assert.equal(report.gate.b6, "PENDING");
  assert.equal(assertAggregateReportRedacted(report), true);
});

test("B5 CLI requires every private campaign binding", () => {
  const child = spawnSync(
    process.execPath,
    [
      GATE_SCRIPT,
      "--manifest",
      "/missing/manifest.json",
      "--output",
      "/missing/output.json"
    ],
    { encoding: "utf8" }
  );
  assert.equal(child.status, 1, child.stderr || child.stdout);
  assert.equal(JSON.parse(child.stdout).failure.code, "INVALID_ARGUMENT");
});

test("B5 CLI aggregates 100 physical report files without source details", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "v6-b5-hundred-session-")
  );
  try {
    const manifestPath = writeFixtureCampaign(temporary);
    const outputPath = path.join(temporary, "aggregate.json");
    const receiptPath = path.join(temporary, "technical-receipt.json");
    const privateState = JSON.parse(
      fs.readFileSync(path.join(temporary, "campaign-state.json"), "utf8")
    );
    const privateAttestation = JSON.parse(
      fs.readFileSync(path.join(temporary, "android-attestation.json"), "utf8")
    );
    const privateAttemptState = JSON.parse(
      fs.readFileSync(path.join(temporary, "attempt-state.json"), "utf8")
    );
    const privateRaspberryAttestation = JSON.parse(
      fs.readFileSync(path.join(temporary, "raspberry-attestation.json"), "utf8")
    );
    const privateAuthorization = JSON.parse(
      fs.readFileSync(path.join(temporary, "campaign-authorization.json"), "utf8")
    );
    const child = runGate(manifestPath, outputPath);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const stdoutReport = JSON.parse(child.stdout);
    const stored = fs.readFileSync(outputPath, "utf8");
    const storedReport = JSON.parse(stored);
    const receiptBytes = fs.readFileSync(receiptPath);
    const receipt = parseB5TechnicalReceipt(receiptBytes).value;
    assert.deepEqual(storedReport, stdoutReport);
    assert.equal(storedReport.verdict, "TECHNICAL_PASS");
    assert.equal(storedReport.gate.b5TechnicalGate, "PASS");
    assert.equal(storedReport.gate.b5HundredSessionGate, "PENDING_REVIEW");
    assert.equal(storedReport.campaign.acceptedReports, 100);
    assert.equal(storedReport.physicalEvidenceConsumed, true);
    assert.equal(
      receipt.technicalAggregateSha256,
      technicalReceiptSha256(Buffer.from(stored))
    );
    assert.equal(
      receipt.collectorStateSha256,
      technicalReceiptSha256(fs.readFileSync(path.join(temporary, "campaign-state.json")))
    );
    assert.equal(
      receipt.campaignAuthorizationSha256,
      technicalReceiptSha256(fs.readFileSync(path.join(temporary, "campaign-authorization.json")))
    );
    assert.equal(
      receipt.androidAttestationSha256,
      technicalReceiptSha256(fs.readFileSync(path.join(temporary, "android-attestation.json")))
    );
    assert.equal(
      receipt.raspberryAttestationSha256,
      technicalReceiptSha256(fs.readFileSync(path.join(temporary, "raspberry-attestation.json")))
    );
    assert.equal(receipt.attemptLedgerHeadSha256, privateAttemptState.headSha256);
    assert.equal(storedReport.attemptLedgerHeadSha256, privateAttemptState.headSha256);
    assert.equal(
      storedReport.androidAttestationSha256,
      technicalReceiptSha256(fs.readFileSync(path.join(temporary, "android-attestation.json")))
    );
    assert.equal(
      storedReport.raspberryAttestationSha256,
      technicalReceiptSha256(fs.readFileSync(path.join(temporary, "raspberry-attestation.json")))
    );
    assert.equal(receipt.attemptLedgerHeadSha256, storedReport.attemptLedgerHeadSha256);
    assert.equal(receipt.androidAttestationSha256, storedReport.androidAttestationSha256);
    assert.equal(receipt.raspberryAttestationSha256, storedReport.raspberryAttestationSha256);
    assert.equal(receipt.campaignIdCommitmentSha256, privateAttestation.campaign.campaignIdCommitmentSha256);
    assert.equal(
      receipt.accountDeviceCommitmentSha256,
      storedReport.accountDeviceCommitmentSha256
    );
    assert.equal(receipt.gate.b5HundredSessionGate, "PENDING_REVIEW");
    assert.equal(receipt.gate.b6, "PENDING");
    assert.equal(receiptBytes.includes(Buffer.from(CAMPAIGN_RUN_ID)), false);
    assert.equal(stored.includes(temporary), false);
    assert.equal(stored.includes("b5-7-session-001.json"), false);
    assert.equal(stored.includes("sourceReportSha256"), false);
    assert.equal(stored.includes('"reports"'), false);
    assert.equal(stored.includes("campaignRunId"), false);
    assert.equal(stored.includes("campaignIdCommitmentSha256"), false);
    assert.equal(stored.includes("accountDeviceCommitmentSha256"), true);
    assert.equal(stored.includes("collectionCommitmentSha256"), false);
    assert.equal(stored.includes("evidenceRecordId"), false);
    assert.equal(stored.includes("targetSignatureSha256"), false);
    for (const privateValue of [
      privateState.campaignRunId,
      privateState.collectionCommitmentSha256,
      privateState.records[0].evidenceRecordId,
      privateState.records[0].reportSha256,
      privateState.records[0].targetSignatureSha256,
      privateAttemptState.events[0].eventId,
      privateAttestation.campaign.campaignIdCommitmentSha256,
      privateRaspberryAttestation.campaign.campaignIdCommitmentSha256,
      privateAuthorization.prerequisiteEvidenceBundleSha256,
      privateAuthorization.operatorCommitmentSha256
    ]) {
      assert.equal(stored.includes(privateValue), false);
    }
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(outputPath).nlink, 1);
    assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(receiptPath).nlink, 1);
    assert.deepEqual(
      fs.readdirSync(temporary).filter((name) => name.startsWith(".b5-technical-")),
      []
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("B5 CLI requires every private binding to be a 0600 file", () => {
  for (const fileName of [
    "campaign-state.json",
    "attempt-state.json",
    "android-baseline.json",
    "android-attestation.json",
    "raspberry-attestation.json",
    "campaign-authorization.json"
  ]) {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "v6-b5-private-bindings-")
    );
    try {
      const manifestPath = writeFixtureCampaign(temporary);
      const outputPath = path.join(temporary, "aggregate.json");
      fs.chmodSync(path.join(temporary, fileName), 0o644);
      const child = runGate(manifestPath, outputPath);
      assert.equal(child.status, 1, child.stderr || child.stdout);
      assert.equal(JSON.parse(child.stdout).failure.code, "EVIDENCE_INVALID");
      assert.equal(fs.existsSync(outputPath), false);
      assert.equal(
        fs.existsSync(path.join(temporary, "technical-receipt.json")),
        false
      );
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
});

test("B5 CLI rejects a symbolic-link report without following it", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "v6-b5-symlink-file-"));
  try {
    const reportsDirectory = path.join(temporary, "reports");
    fs.mkdirSync(reportsDirectory, { mode: 0o700 });
    const outside = path.join(temporary, "outside.json");
    const outsideBytes = `${JSON.stringify(validPhysicalReportFixture(1))}\n`;
    fs.writeFileSync(outside, outsideBytes, { mode: 0o600 });
    fs.symlinkSync(
      outside,
      path.join(reportsDirectory, "b5-7-session-001.json")
    );
    const manifestPath = path.join(temporary, "manifest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest())}\n`, {
      mode: 0o600
    });
    const outputPath = path.join(temporary, "aggregate.json");

    const child = runGate(manifestPath, outputPath);

    assert.equal(child.status, 1, child.stderr || child.stdout);
    assert.equal(JSON.parse(child.stdout).failure.code, "EVIDENCE_INVALID");
    assert.equal(fs.readFileSync(outside, "utf8"), outsideBytes);
    assert.equal(fs.existsSync(outputPath), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("B5 CLI rejects a symbolic-link directory below the manifest root", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "v6-b5-symlink-dir-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "v6-b5-outside-dir-"));
  try {
    fs.writeFileSync(
      path.join(outside, "b5-7-session-001.json"),
      `${JSON.stringify(validPhysicalReportFixture(1))}\n`,
      { mode: 0o600 }
    );
    fs.symlinkSync(outside, path.join(temporary, "reports"), "dir");
    const manifestPath = path.join(temporary, "manifest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest())}\n`, {
      mode: 0o600
    });
    const outputPath = path.join(temporary, "aggregate.json");

    const child = runGate(manifestPath, outputPath);

    assert.equal(child.status, 1, child.stderr || child.stdout);
    assert.equal(JSON.parse(child.stdout).failure.code, "EVIDENCE_INVALID");
    assert.equal(fs.existsSync(outputPath), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("B5 CLI rejects a symbolic-link manifest root", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "v6-b5-symlink-root-"));
  try {
    const actual = path.join(temporary, "actual");
    const alias = path.join(temporary, "alias");
    fs.mkdirSync(actual, { mode: 0o700 });
    fs.writeFileSync(
      path.join(actual, "manifest.json"),
      `${JSON.stringify(manifest())}\n`,
      { mode: 0o600 }
    );
    fs.symlinkSync(actual, alias, "dir");
    const outputPath = path.join(temporary, "aggregate.json");

    const child = runGate(path.join(alias, "manifest.json"), outputPath);

    assert.equal(child.status, 1, child.stderr || child.stdout);
    assert.equal(JSON.parse(child.stdout).failure.code, "EVIDENCE_INVALID");
    assert.equal(fs.existsSync(outputPath), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("B5 CLI atomically refuses to overwrite an existing output", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "v6-b5-output-exists-"));
  try {
    const manifestPath = writeFixtureCampaign(temporary);
    const outputPath = path.join(temporary, "aggregate.json");
    const sentinel = "existing-output-must-remain-intact\n";
    fs.writeFileSync(outputPath, sentinel, { mode: 0o600 });

    const child = runGate(manifestPath, outputPath);

    assert.equal(child.status, 1, child.stderr || child.stdout);
    assert.equal(fs.readFileSync(outputPath, "utf8"), sentinel);
    assert.deepEqual(
      fs.readdirSync(temporary).filter((name) => name.startsWith(".b5-technical-")),
      []
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("B5 CLI rolls back aggregate publication when the receipt destination conflicts", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "v6-b5-receipt-exists-"));
  try {
    const manifestPath = writeFixtureCampaign(temporary);
    const outputPath = path.join(temporary, "aggregate.json");
    const receiptPath = path.join(temporary, "technical-receipt.json");
    const sentinel = "existing-receipt-must-remain-intact\n";
    fs.writeFileSync(receiptPath, sentinel, { mode: 0o600 });

    const child = runGate(manifestPath, outputPath);

    assert.equal(child.status, 1, child.stderr || child.stdout);
    assert.equal(
      JSON.parse(child.stdout).failure.code,
      "TECHNICAL_PUBLICATION_EXISTS"
    );
    assert.equal(fs.existsSync(outputPath), false);
    assert.equal(fs.readFileSync(receiptPath, "utf8"), sentinel);
    assert.deepEqual(
      fs.readdirSync(temporary).filter((name) => name.startsWith(".b5-technical-")),
      []
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("B5 CLI does not replace an existing output symbolic link", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "v6-b5-output-link-"));
  try {
    const manifestPath = writeFixtureCampaign(temporary);
    const targetPath = path.join(temporary, "target.txt");
    const outputPath = path.join(temporary, "aggregate.json");
    const sentinel = "linked-target-must-remain-intact\n";
    fs.writeFileSync(targetPath, sentinel, { mode: 0o600 });
    fs.symlinkSync(targetPath, outputPath);

    const child = runGate(manifestPath, outputPath);

    assert.equal(child.status, 1, child.stderr || child.stdout);
    assert.equal(fs.lstatSync(outputPath).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(targetPath, "utf8"), sentinel);
    assert.deepEqual(
      fs.readdirSync(temporary).filter((name) => name.startsWith(".b5-technical-")),
      []
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("B5 CLI self-test emits only a redacted PENDING result", () => {
  const script = new URL(
    "../scripts/run-b5-hundred-session-gate.mjs",
    import.meta.url
  );
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(script), "--self-test"],
    { encoding: "utf8" }
  );
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.mode, "SELF_TEST");
  assert.equal(report.gate.b5HundredSessionGate, "PENDING");
  assert.equal(report.physicalEvidenceConsumed, false);
  for (const forbidden of [
    "sourceReportSha256",
    "campaignRunId",
    "campaignIdCommitmentSha256",
    "collectionCommitmentSha256",
    "evidenceRecordId"
  ]) {
    assert.equal(child.stdout.includes(forbidden), false);
  }
});

test("B5 gate module import does not execute its CLI", () => {
  const moduleUrl = new URL(
    "../scripts/run-b5-hundred-session-gate.mjs",
    import.meta.url
  ).href;
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(moduleUrl)});`
  ], {
    encoding: "utf8"
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
});
