import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validB5AndroidContinuityAttestationFixture } from "../../scripts/run-b5-android-continuity-monitor.mjs";
import { validB5RaspberryContinuityAttestationFixture } from "../../scripts/run-b5-raspberry-continuity-monitor.mjs";
import {
  sha256Hex,
  validB5CampaignAuthorizationFixture,
  validB5ReviewAttestationFixture
} from "../../scripts/b5-campaign-governance.mjs";
import {
  aggregateValidatedSessionReports,
  validCollectorCampaignStateFixture,
  validPhysicalReportFixture
} from "../scripts/run-b5-hundred-session-gate.mjs";
import { validB5CampaignSupervisorLedgerFixture } from "../scripts/run-b5-campaign-supervisor.mjs";
import {
  createB5TechnicalReceipt,
  parseB5TechnicalReceipt
} from "../../scripts/b5-technical-receipt.mjs";
import {
  B5PromotionGateError,
  parseTechnicalAggregate,
  promoteTechnicalAggregate
} from "../scripts/run-b5-promotion-gate.mjs";
import {
  validB5AccountDeviceBindingFixture
} from "../../scripts/b5-account-device-commitment.mjs";

const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000001";
const MATRIX_PATH = fileURLToPath(
  new URL("../../configs/advanced-certification-targets.json", import.meta.url)
);
const PROMOTION_SCRIPT = fileURLToPath(
  new URL("../scripts/run-b5-promotion-gate.mjs", import.meta.url)
);
const RAW_SOURCE_FILES = Object.freeze({
  attempt: "attempt.json",
  android: "android.json",
  raspberry: "raspberry.json"
});

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const records = Array.from({ length: 100 }, (_, index) => {
    const sequence = index + 1;
    const report = validPhysicalReportFixture(sequence);
    return {
      sequence,
      sourceReportSha256: digest(JSON.stringify(report)),
      report
    };
  });
  const campaignState = validCollectorCampaignStateFixture(records, {
    campaignRunId: CAMPAIGN_ID
  });
  const accountDeviceBinding = validB5AccountDeviceBindingFixture({
    campaignId: CAMPAIGN_ID
  });
  const matrixBytes = fs.readFileSync(MATRIX_PATH);
  const matrixSha256 = sha256Hex(matrixBytes);
  const authorization = validB5CampaignAuthorizationFixture({
    campaignId: CAMPAIGN_ID,
    certificationMatrixSha256: matrixSha256
  });
  const attemptState = validB5CampaignSupervisorLedgerFixture({
    campaignRunId: CAMPAIGN_ID
  });
  const androidAttestation = validB5AndroidContinuityAttestationFixture({
    campaignId: CAMPAIGN_ID,
    monitoredFrom: "2026-07-21T00:00:00.000Z",
    requiredDurationMs: 6_101_000,
    pollIntervalMs: 5_000
  });
  const raspberryAttestation = validB5RaspberryContinuityAttestationFixture({
    campaignId: CAMPAIGN_ID,
    monitoredFrom: "2026-07-21T00:00:00.000Z",
    requiredDurationMs: 6_101_000,
    pollIntervalMs: 5_000
  });
  const attemptStateBytes = Buffer.from(
    `${JSON.stringify(attemptState, null, 2)}\n`
  );
  const androidAttestationBytes = Buffer.from(
    `${JSON.stringify(androidAttestation, null, 2)}\n`
  );
  const raspberryAttestationBytes = Buffer.from(
    `${JSON.stringify(raspberryAttestation, null, 2)}\n`
  );
  const technical = aggregateValidatedSessionReports(records, {
    generatedAt: "2026-07-22T00:00:00.000Z",
    campaignState,
    attemptState,
    attemptStateBytes,
    accountDeviceBinding,
    androidAttestation,
    androidAttestationBytes,
    raspberryAttestation,
    raspberryAttestationBytes,
    campaignAuthorization: authorization,
    certificationMatrixSha256: matrixSha256
  });
  const technicalBytes = Buffer.from(`${JSON.stringify(technical, null, 2)}\n`);
  const stateBytes = Buffer.from(`${JSON.stringify(campaignState, null, 2)}\n`);
  const authorizationBytes = Buffer.from(`${JSON.stringify(authorization, null, 2)}\n`);
  const receipt = createB5TechnicalReceipt({
    issuedAt: technical.generatedAt,
    technicalAggregateBytes: technicalBytes,
    collectorStateBytes: stateBytes,
    campaignAuthorizationBytes: authorizationBytes,
    certificationMatrixBytes: matrixBytes,
    campaignIdCommitmentSha256: campaignState.campaignRunId === CAMPAIGN_ID
      ? sha256Hex(Buffer.from(CAMPAIGN_ID))
      : "0".repeat(64),
    accountDeviceCommitmentSha256:
      campaignState.accountDeviceCommitmentSha256,
    collectionCommitmentSha256: campaignState.collectionCommitmentSha256,
    attemptLedgerHeadSha256: attemptState.headSha256,
    prerequisiteEvidenceBundleSha256:
      authorization.prerequisiteEvidenceBundleSha256,
    operatorCommitmentSha256: authorization.operatorCommitmentSha256,
    androidAttestationBytes,
    raspberryAttestationBytes,
    technicalGeneratedAtMs: Date.parse(technical.generatedAt)
  });
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const review = validB5ReviewAttestationFixture({
    technicalAggregateSha256: sha256Hex(technicalBytes),
    prerequisiteEvidenceBundleSha256:
      authorization.prerequisiteEvidenceBundleSha256,
    operatorCommitmentSha256: authorization.operatorCommitmentSha256
  });
  return {
    technical,
    technicalBytes,
    receipt,
    receiptBytes,
    campaignState,
    stateBytes,
    attemptState,
    attemptStateBytes,
    androidAttestation,
    androidAttestationBytes,
    raspberryAttestation,
    raspberryAttestationBytes,
    matrixSha256,
    matrixBytes,
    authorization,
    authorizationBytes,
    review
  };
}

function sourceEvidence(values) {
  return {
    attemptState: values.attemptStateBytes,
    androidAttestation: values.androidAttestationBytes,
    raspberryAttestation: values.raspberryAttestationBytes
  };
}

function assertCode(code) {
  return (error) => error instanceof B5PromotionGateError && error.code === code;
}

function writePromotionInputs(directory, values, review = values.review) {
  for (const [name, value] of [
    ["technical.json", values.technicalBytes],
    ["receipt.json", values.receiptBytes],
    ["state.json", values.stateBytes],
    ["attempt.json", values.attemptStateBytes],
    ["android.json", values.androidAttestationBytes],
    ["raspberry.json", values.raspberryAttestationBytes],
    ["authorization.json", values.authorizationBytes],
    ["review.json", `${JSON.stringify(review)}\n`]
  ]) {
    fs.writeFileSync(path.join(directory, name), value, { mode: 0o600 });
  }
}

function runPromotion(
  directory,
  {
    includeReview = true,
    includeReceipt = true,
    omittedSource = null,
    output = "promotion.json"
  } = {}
) {
  const argumentsList = [
    PROMOTION_SCRIPT,
    "--technical-aggregate",
    path.join(directory, "technical.json")
  ];
  if (includeReceipt) {
    argumentsList.push(
      "--technical-receipt",
      path.join(directory, "receipt.json")
    );
  }
  argumentsList.push(
    "--campaign-state",
    path.join(directory, "state.json")
  );
  for (const [name, argument, file] of [
    ["attempt", "--attempt-state", "attempt.json"],
    ["android", "--android-attestation", "android.json"],
    ["raspberry", "--raspberry-attestation", "raspberry.json"]
  ]) {
    if (omittedSource !== name) {
      argumentsList.push(argument, path.join(directory, file));
    }
  }
  argumentsList.push(
    "--campaign-authorization",
    path.join(directory, "authorization.json")
  );
  if (includeReview) {
    argumentsList.push("--review-attestation", path.join(directory, "review.json"));
  }
  argumentsList.push("--output", path.join(directory, output));
  return spawnSync(process.execPath, argumentsList, { encoding: "utf8" });
}

test("B5 technical aggregate stays review-pending", () => {
  const values = fixture();
  const { technical } = values;
  const parsed = parseTechnicalAggregate(technical);
  assert.equal(parsed.value.verdict, "TECHNICAL_PASS");
  assert.equal(parsed.value.gate.b5TechnicalGate, "PASS");
  assert.equal(parsed.value.gate.b5HundredSessionGate, "PENDING_REVIEW");
  assert.equal(parsed.value.gate.b6, "PENDING");
  assert.equal(parsed.attemptLedgerHeadSha256, values.attemptState.headSha256);
  assert.equal(
    parsed.androidAttestationSha256,
    sha256Hex(values.androidAttestationBytes)
  );
  assert.equal(
    parsed.raspberryAttestationSha256,
    sha256Hex(values.raspberryAttestationBytes)
  );
});

test("B5 technical aggregate parser rejects minimal and extended schemas", () => {
  const values = fixture();
  assert.throws(
    () => parseTechnicalAggregate({
      schemaVersion: 1,
      harnessVersion: values.technical.harnessVersion,
      product: "V5BT",
      phase: "B5",
      mode: "PHYSICAL_HUNDRED_SESSION_TECHNICAL_AGGREGATE",
      verdict: "TECHNICAL_PASS"
    }),
    assertCode("TECHNICAL_AGGREGATE_INVALID")
  );
  const extended = structuredClone(values.technical);
  extended.unreviewedExtension = true;
  assert.throws(
    () => parseTechnicalAggregate(extended),
    assertCode("TECHNICAL_AGGREGATE_INVALID")
  );
  const extendedTotals = structuredClone(values.technical);
  extendedTotals.totals.hiddenCounter = 0;
  assert.throws(
    () => parseTechnicalAggregate(extendedTotals),
    assertCode("TECHNICAL_AGGREGATE_INVALID")
  );

  const historical = structuredClone(values.technical);
  historical.harnessVersion = "1.3.0";
  delete historical.accountDeviceCommitmentSha256;
  delete historical.checks.accountDeviceCommitment;
  historical.campaign.collectorStateSchemaVersion = 2;
  historical.privacy.campaignCommitmentsIncluded = false;
  assert.throws(
    () => parseTechnicalAggregate(historical),
    assertCode("ACCOUNT_DEVICE_COMMITMENT_REQUIRED")
  );

  const priorBound = structuredClone(values.technical);
  priorBound.harnessVersion = "1.4.0";
  delete priorBound.attemptLedgerHeadSha256;
  delete priorBound.androidAttestationSha256;
  delete priorBound.raspberryAttestationSha256;
  assert.throws(
    () => parseTechnicalAggregate(priorBound),
    assertCode("SOURCE_EVIDENCE_COMMITMENTS_REQUIRED")
  );
});

test("B5 promotion rejects every mutated aggregate source commitment", () => {
  const values = fixture();
  for (const field of [
    "attemptLedgerHeadSha256",
    "androidAttestationSha256",
    "raspberryAttestationSha256"
  ]) {
    const changed = structuredClone(values.technical);
    changed[field] = changed[field] === "a".repeat(64)
      ? "b".repeat(64)
      : "a".repeat(64);
    assert.throws(
      () =>
        promoteTechnicalAggregate({
          technicalAggregateBytes: Buffer.from(JSON.stringify(changed)),
          technicalReceipt: values.receiptBytes,
          campaignState: values.stateBytes,
          ...sourceEvidence(values),
          campaignAuthorization: values.authorizationBytes,
          reviewAttestation: values.review,
          certificationMatrixSha256: values.matrixSha256
        }),
      assertCode("TECHNICAL_AGGREGATE_BINDING_INVALID"),
      field
    );
  }
});

test("B5 promotion derives source commitments from raw evidence", () => {
  const values = fixture();
  const alternateAttempt = validB5CampaignSupervisorLedgerFixture({
    campaignRunId: CAMPAIGN_ID,
    spacingMs: 61_001,
    durationMs: 60_750
  });
  const mutations = [
    {
      attemptState: Buffer.from(`${JSON.stringify(alternateAttempt, null, 2)}\n`)
    },
    {
      androidAttestation: Buffer.concat([
        values.androidAttestationBytes,
        Buffer.from("\n")
      ])
    },
    {
      raspberryAttestation: Buffer.concat([
        values.raspberryAttestationBytes,
        Buffer.from("\n")
      ])
    }
  ];
  for (const mutation of mutations) {
    assert.throws(
      () =>
        promoteTechnicalAggregate({
          technicalAggregateBytes: values.technicalBytes,
          technicalReceipt: values.receiptBytes,
          campaignState: values.stateBytes,
          ...sourceEvidence(values),
          ...mutation,
          campaignAuthorization: values.authorizationBytes,
          reviewAttestation: values.review,
          certificationMatrixSha256: values.matrixSha256
        }),
      assertCode("TECHNICAL_AGGREGATE_BINDING_INVALID")
    );
  }

  const historicalAndroid = structuredClone(values.androidAttestation);
  historicalAndroid.harnessVersion = "1.0.0";
  delete historicalAndroid.accountDeviceCommitmentSha256;
  delete historicalAndroid.privacy.accountDeviceCommitmentIncluded;
  assert.throws(
    () =>
      promoteTechnicalAggregate({
        technicalAggregateBytes: values.technicalBytes,
        technicalReceipt: values.receiptBytes,
        campaignState: values.stateBytes,
        ...sourceEvidence(values),
        androidAttestation: Buffer.from(JSON.stringify(historicalAndroid)),
        campaignAuthorization: values.authorizationBytes,
        reviewAttestation: values.review,
        certificationMatrixSha256: values.matrixSha256
      }),
    assertCode("ACCOUNT_DEVICE_COMMITMENT_REQUIRED")
  );
});

test("B5 promotion requires a bound independent review", () => {
  const values = fixture();
  const promoted = promoteTechnicalAggregate({
    technicalAggregateBytes: values.technicalBytes,
    technicalReceipt: values.receiptBytes,
    campaignState: values.stateBytes,
    ...sourceEvidence(values),
    campaignAuthorization: values.authorizationBytes,
    reviewAttestation: values.review,
    certificationMatrixSha256: values.matrixSha256,
    generatedAt: "2026-07-22T00:02:00.000Z"
  });
  assert.equal(promoted.verdict, "PASS");
  assert.equal(promoted.gate.b5HundredSessionGate, "PASS");
  assert.equal(promoted.gate.b6, "PENDING");
  assert.equal(promoted.checks.technicalReceipt, "PASS");
  assert.equal(promoted.checks.independentReview, "PASS");
  assert.equal(JSON.stringify(promoted).includes(CAMPAIGN_ID), false);
  assert.equal(
    JSON.stringify(promoted).includes(values.authorization.operatorCommitmentSha256),
    false
  );
});

test("B5 promotion rejects missing, altered and mismatched receipts", () => {
  const values = fixture();
  const base = {
    technicalAggregateBytes: values.technicalBytes,
    campaignState: values.stateBytes,
    ...sourceEvidence(values),
    campaignAuthorization: values.authorizationBytes,
    reviewAttestation: values.review,
    certificationMatrixSha256: values.matrixSha256
  };
  assert.throws(
    () => promoteTechnicalAggregate({ ...base, technicalReceipt: undefined }),
    assertCode("TECHNICAL_RECEIPT_INVALID")
  );

  const commitmentMissing = structuredClone(values.receipt);
  delete commitmentMissing.accountDeviceCommitmentSha256;
  assert.throws(
    () =>
      promoteTechnicalAggregate({
        ...base,
        technicalReceipt: commitmentMissing
      }),
    assertCode("TECHNICAL_RECEIPT_INVALID")
  );

  const altered = structuredClone(values.receipt);
  altered.collectionCommitmentSha256 = "a".repeat(64);
  assert.throws(
    () => promoteTechnicalAggregate({ ...base, technicalReceipt: altered }),
    assertCode("TECHNICAL_RECEIPT_BINDING_INVALID")
  );

  const accountDeviceAltered = structuredClone(values.receipt);
  accountDeviceAltered.accountDeviceCommitmentSha256 = "b".repeat(64);
  assert.throws(
    () =>
      promoteTechnicalAggregate({
        ...base,
        technicalReceipt: accountDeviceAltered
      }),
    assertCode("TECHNICAL_RECEIPT_BINDING_INVALID")
  );

  for (const field of [
    "attemptLedgerHeadSha256",
    "androidAttestationSha256",
    "raspberryAttestationSha256"
  ]) {
    const sourceAltered = structuredClone(values.receipt);
    sourceAltered[field] = sourceAltered[field] === "a".repeat(64)
      ? "b".repeat(64)
      : "a".repeat(64);
    assert.throws(
      () =>
        promoteTechnicalAggregate({
          ...base,
          technicalReceipt: sourceAltered
        }),
      assertCode("TECHNICAL_RECEIPT_BINDING_INVALID"),
      field
    );
  }

  const stale = structuredClone(values.receipt);
  stale.issuedAt = "2026-07-21T23:59:59.999Z";
  assert.throws(
    () => promoteTechnicalAggregate({ ...base, technicalReceipt: stale }),
    assertCode("TECHNICAL_RECEIPT_BINDING_INVALID")
  );

  const changedTechnical = structuredClone(values.technical);
  changedTechnical.totals.pingsSent += 1;
  const changedTechnicalBytes = Buffer.from(
    `${JSON.stringify(changedTechnical, null, 2)}\n`
  );
  assert.throws(
    () => promoteTechnicalAggregate({
      ...base,
      technicalAggregateBytes: changedTechnicalBytes,
      technicalReceipt: values.receiptBytes
    }),
    assertCode("TECHNICAL_RECEIPT_BINDING_INVALID")
  );
});

test("B5 promotion requires one matching account/device commitment everywhere", () => {
  const values = fixture();
  const base = {
    technicalAggregateBytes: values.technicalBytes,
    technicalReceipt: values.receiptBytes,
    campaignState: values.stateBytes,
    ...sourceEvidence(values),
    campaignAuthorization: values.authorizationBytes,
    reviewAttestation: values.review,
    certificationMatrixSha256: values.matrixSha256
  };

  const changedTechnical = structuredClone(values.technical);
  changedTechnical.accountDeviceCommitmentSha256 = "c".repeat(64);
  assert.throws(
    () =>
      promoteTechnicalAggregate({
        ...base,
        technicalAggregateBytes: Buffer.from(JSON.stringify(changedTechnical))
      }),
    assertCode("ACCOUNT_DEVICE_COMMITMENT_MISMATCH")
  );

  const historicalState = structuredClone(values.campaignState);
  historicalState.schemaVersion = 2;
  historicalState.harnessVersion = "1.1.0";
  delete historicalState.accountDeviceCommitmentSha256;
  for (const record of historicalState.records) {
    delete record.accountDeviceCommitmentSha256;
  }
  assert.throws(
    () =>
      promoteTechnicalAggregate({
        ...base,
        campaignState: Buffer.from(JSON.stringify(historicalState))
      }),
    assertCode("ACCOUNT_DEVICE_COMMITMENT_REQUIRED")
  );

  const historicalReceipt = structuredClone(values.receipt);
  historicalReceipt.receiptVersion = "1.0.0";
  delete historicalReceipt.accountDeviceCommitmentSha256;
  assert.equal(
    parseB5TechnicalReceipt(historicalReceipt).accountDeviceBound,
    false
  );
  assert.throws(
    () =>
      promoteTechnicalAggregate({
        ...base,
        technicalReceipt: historicalReceipt
      }),
    assertCode("ACCOUNT_DEVICE_COMMITMENT_REQUIRED")
  );
});

test("B5 receipt prevents state, authorization and campaign substitution", () => {
  const values = fixture();
  const changedState = structuredClone(values.campaignState);
  changedState.campaignRunId = "00000000-0000-4000-8000-000000000002";
  const changedStateBytes = Buffer.from(`${JSON.stringify(changedState, null, 2)}\n`);
  assert.throws(
    () => promoteTechnicalAggregate({
      technicalAggregateBytes: values.technicalBytes,
      technicalReceipt: values.receiptBytes,
      campaignState: changedStateBytes,
      ...sourceEvidence(values),
      campaignAuthorization: values.authorizationBytes,
      reviewAttestation: values.review,
      certificationMatrixSha256: values.matrixSha256
    }),
    assertCode("SOURCE_EVIDENCE_BINDING_INVALID")
  );

  const changedAuthorization = structuredClone(values.authorization);
  changedAuthorization.operatorCommitmentSha256 = "9".repeat(64);
  const changedAuthorizationBytes = Buffer.from(
    `${JSON.stringify(changedAuthorization, null, 2)}\n`
  );
  assert.throws(
    () => promoteTechnicalAggregate({
      technicalAggregateBytes: values.technicalBytes,
      technicalReceipt: values.receiptBytes,
      campaignState: values.stateBytes,
      ...sourceEvidence(values),
      campaignAuthorization: changedAuthorizationBytes,
      reviewAttestation: values.review,
      certificationMatrixSha256: values.matrixSha256
    }),
    assertCode("TECHNICAL_RECEIPT_BINDING_INVALID")
  );
});

test("B5 promotion rejects review mismatch and non-independent reviewer", () => {
  const values = fixture();
  const mismatch = structuredClone(values.review);
  mismatch.technicalAggregateSha256 = "a".repeat(64);
  assert.throws(
    () =>
      promoteTechnicalAggregate({
        technicalAggregateBytes: values.technicalBytes,
        technicalReceipt: values.receiptBytes,
        campaignState: values.stateBytes,
        ...sourceEvidence(values),
        campaignAuthorization: values.authorizationBytes,
        reviewAttestation: mismatch,
        certificationMatrixSha256: values.matrixSha256
      }),
    assertCode("REVIEW_BINDING_INVALID")
  );

  const samePerson = structuredClone(values.review);
  samePerson.reviewerCommitmentSha256 = samePerson.operatorCommitmentSha256;
  assert.throws(
    () =>
      promoteTechnicalAggregate({
        technicalAggregateBytes: values.technicalBytes,
        technicalReceipt: values.receiptBytes,
        campaignState: values.stateBytes,
        ...sourceEvidence(values),
        campaignAuthorization: values.authorizationBytes,
        reviewAttestation: samePerson,
        certificationMatrixSha256: values.matrixSha256
      }),
    assertCode("REVIEW_NOT_INDEPENDENT")
  );
});

test("B5 promotion report fixture remains private-file compatible", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-promotion-fixture-"));
  try {
    const values = fixture();
    for (const [name, value] of [
      ["technical.json", values.technicalBytes],
      ["receipt.json", values.receiptBytes],
      ["state.json", values.stateBytes],
      ["attempt.json", values.attemptStateBytes],
      ["android.json", values.androidAttestationBytes],
      ["raspberry.json", values.raspberryAttestationBytes],
      ["authorization.json", values.authorizationBytes],
      ["review.json", `${JSON.stringify(values.review)}\n`]
    ]) {
      fs.writeFileSync(path.join(directory, name), value, { mode: 0o600 });
      assert.equal(fs.statSync(path.join(directory, name)).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("B5 promotion CLI leaves the gate pending without a sign-off", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-promotion-missing-"));
  try {
    const values = fixture();
    writePromotionInputs(directory, values);
    const child = runPromotion(directory, { includeReview: false });
    assert.equal(child.status, 1, child.stderr || child.stdout);
    const report = JSON.parse(child.stdout);
    assert.equal(report.verdict, "FAIL");
    assert.equal(report.gate.b5HundredSessionGate, "PENDING");
    assert.equal(report.gate.b6, "PENDING");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("B5 promotion CLI requires the private technical receipt", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-promotion-no-receipt-"));
  try {
    const values = fixture();
    writePromotionInputs(directory, values);
    const child = runPromotion(directory, { includeReceipt: false });
    assert.equal(child.status, 1, child.stderr || child.stdout);
    const report = JSON.parse(child.stdout);
    assert.equal(report.failure.code, "INVALID_ARGUMENT");
    assert.equal(report.gate.b5HundredSessionGate, "PENDING");
    assert.equal(report.gate.b6, "PENDING");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("B5 promotion CLI requires every raw source input", () => {
  for (const source of Object.keys(RAW_SOURCE_FILES)) {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), `v5bt-promotion-no-${source}-`)
    );
    try {
      const values = fixture();
      writePromotionInputs(directory, values);
      const child = runPromotion(directory, { omittedSource: source });
      assert.equal(child.status, 1, child.stderr || child.stdout);
      assert.equal(JSON.parse(child.stdout).failure.code, "INVALID_ARGUMENT");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("B5 promotion CLI rejects modified raw source files", () => {
  for (const [source, file] of Object.entries(RAW_SOURCE_FILES)) {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), `v5bt-promotion-modified-${source}-`)
    );
    try {
      const values = fixture();
      writePromotionInputs(directory, values);
      fs.chmodSync(path.join(directory, file), 0o640);
      const child = runPromotion(directory);
      assert.equal(child.status, 1, child.stderr || child.stdout);
      assert.equal(JSON.parse(child.stdout).failure.code, "EVIDENCE_INVALID");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("B5 promotion CLI rejects symlinked and multiply-linked raw sources", () => {
  for (const linkType of ["symlink", "hardlink"]) {
    for (const [source, file] of Object.entries(RAW_SOURCE_FILES)) {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), `v5bt-promotion-${linkType}-${source}-`)
      );
      try {
        const values = fixture();
        writePromotionInputs(directory, values);
        const sourcePath = path.join(directory, file);
        const backingPath = path.join(directory, `${source}.backing.json`);
        if (linkType === "symlink") {
          fs.renameSync(sourcePath, backingPath);
          fs.symlinkSync(backingPath, sourcePath);
        } else {
          fs.linkSync(sourcePath, backingPath);
        }
        const child = runPromotion(directory);
        assert.equal(child.status, 1, child.stderr || child.stdout);
        assert.equal(JSON.parse(child.stdout).failure.code, "EVIDENCE_INVALID");
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  }
});

test("B5 promotion CLI rejects substituted raw source content", () => {
  const replacements = {
    attempt: (values) =>
      Buffer.from(
        `${JSON.stringify(
          validB5CampaignSupervisorLedgerFixture({
            campaignRunId: CAMPAIGN_ID,
            spacingMs: 61_001,
            durationMs: 60_750
          }),
          null,
          2
        )}\n`
      ),
    android: (values) => Buffer.concat([
      values.androidAttestationBytes,
      Buffer.from("\n")
    ]),
    raspberry: (values) => Buffer.concat([
      values.raspberryAttestationBytes,
      Buffer.from("\n")
    ])
  };
  for (const [source, file] of Object.entries(RAW_SOURCE_FILES)) {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), `v5bt-promotion-substitute-${source}-`)
    );
    try {
      const values = fixture();
      writePromotionInputs(directory, values);
      fs.writeFileSync(path.join(directory, file), replacements[source](values), {
        mode: 0o600
      });
      const child = runPromotion(directory);
      assert.equal(child.status, 1, child.stderr || child.stdout);
      assert.equal(
        JSON.parse(child.stdout).failure.code,
        "TECHNICAL_AGGREGATE_BINDING_INVALID"
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("B5 promotion CLI rejects a tampered technical receipt", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-promotion-receipt-tamper-"));
  try {
    const values = fixture();
    writePromotionInputs(directory, values);
    const receipt = parseB5TechnicalReceipt(values.receiptBytes).value;
    const altered = structuredClone(receipt);
    altered.technicalAggregateSha256 = "a".repeat(64);
    fs.writeFileSync(
      path.join(directory, "receipt.json"),
      `${JSON.stringify(altered, null, 2)}\n`,
      { mode: 0o600 }
    );
    const child = runPromotion(directory);
    assert.equal(child.status, 1, child.stderr || child.stdout);
    const report = JSON.parse(child.stdout);
    assert.equal(report.failure.code, "TECHNICAL_RECEIPT_BINDING_INVALID");
    assert.equal(report.gate.b5HundredSessionGate, "PENDING");
    assert.equal(report.gate.b6, "PENDING");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("B5 promotion CLI leaves the gate pending on sign-off mismatch", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-promotion-mismatch-"));
  try {
    const values = fixture();
    const mismatch = structuredClone(values.review);
    mismatch.technicalAggregateSha256 = "a".repeat(64);
    writePromotionInputs(directory, values, mismatch);
    const child = runPromotion(directory);
    assert.equal(child.status, 1, child.stderr || child.stdout);
    const stdoutReport = JSON.parse(child.stdout);
    const storedReport = JSON.parse(
      fs.readFileSync(path.join(directory, "promotion.json"), "utf8")
    );
    assert.deepEqual(storedReport, stdoutReport);
    assert.equal(storedReport.failure.code, "REVIEW_BINDING_INVALID");
    assert.equal(storedReport.gate.b5HundredSessionGate, "PENDING");
    assert.equal(storedReport.gate.b6, "PENDING");
    assert.equal(fs.statSync(path.join(directory, "promotion.json")).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("B5 promotion CLI emits PASS only with the bound independent sign-off", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-promotion-pass-"));
  try {
    const values = fixture();
    writePromotionInputs(directory, values);
    const child = runPromotion(directory);
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const stdoutReport = JSON.parse(child.stdout);
    const outputPath = path.join(directory, "promotion.json");
    const storedReport = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.deepEqual(storedReport, stdoutReport);
    assert.equal(storedReport.verdict, "PASS");
    assert.equal(storedReport.gate.b5HundredSessionGate, "PASS");
    assert.equal(storedReport.gate.b6, "PENDING");
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(outputPath).nlink, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
