import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ADVANCED_CERTIFICATION_TARGETS,
  ADVANCED_CERTIFICATION_TARGETS_BINDING
} from "../../scripts/advanced-certification-targets.mjs";
import {
  B11MixedPhysicalVirtualError,
  composeB11MixedPhysicalVirtualReport,
  parseB11MixedPhysicalVirtualArguments,
  runB11MixedPhysicalVirtualNonGate,
  validateB11MixedPhysicalAttestation,
  validateB11MixedPhysicalVirtualReport,
  writeB11MixedPhysicalVirtualReport
} from "../scripts/run-b11-mixed-physical-virtual-non-gate.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const simulatedReportPath = path.join(
  packageRoot,
  "reports/V6_B11_MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE_20260818.json"
);
const fixedNow = new Date("2026-08-18T10:05:00.000Z");
const generatedAt = "2026-08-18T10:00:00.000Z";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function service(service, requirement = "OBSERVE_ONLY") {
  return {
    service,
    requirement,
    expectedState:
      requirement === "OPERATIONAL_REQUIRED"
        ? "LOADED_ACTIVE_ENABLED"
        : "ANY_OBSERVED_STATE",
    observed: true,
    expectationMet: true,
    loaded: true,
    active: true,
    subState: "running",
    enabled: true
  };
}

function android(role, { connected = true, signingVerified = true } = {}) {
  const target = ADVANCED_CERTIFICATION_TARGETS.roles[role];
  return {
    role,
    connected,
    androidUserMatches: connected,
    androidApi: connected ? 34 : null,
    packageInstalled: connected,
    packageStopped: connected ? false : null,
    versionName: connected ? target.versionName : null,
    versionCode: connected ? target.versionCode : null,
    versionNameMatches: connected,
    versionCodeMatches: connected,
    apkSha256Matches: connected,
    expectedSigningCertificateSha256: target.signingCertificateSha256,
    signingCertificatePinCoveredByCertifiedApk: connected && signingVerified,
    permissionsGranted: connected,
    authenticatedSession: connected,
    sessionIdentityDistinct: connected,
    enrollmentReady: connected,
    enrollmentIdentityDistinct: connected,
    registryBindingMatches: connected,
    enrollmentAttempt: connected ? "READY" : null
  };
}

function inventory({ stationConnected = true, stationSigningVerified = true } = {}) {
  const androidTargets = [
    android("handheld"),
    android("handheld"),
    android("station", {
      connected: stationConnected,
      signingVerified: stationSigningVerified
    })
  ];
  const connectedDevices = androidTargets.filter((entry) => entry.connected).length;
  const raspberryReachable = true;
  const complete =
    connectedDevices === 3 && stationSigningVerified && raspberryReachable;
  return {
    schemaVersion: 1,
    product: "V6",
    certificationMatrixSha256:
      ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256,
    mode: "REDACTED_READ_ONLY_BENCH_INVENTORY",
    generatedAt,
    status: complete ? "COMPLETE" : "INCOMPLETE",
    readOnly: true,
    commandPolicy: {
      shell: false,
      mutationAllowed: false,
      upsMode: "DISCOVERY_ONLY",
      fixedAllowlist: true,
      sshAuthentication: "PUBLIC_KEY",
      sudoReadOnly: false,
      passwordRecorded: false
    },
    limitations: [],
    redaction: {
      serialsExcluded: true,
      networkIdentifiersExcluded: true,
      registryIdentifiersExcluded: true,
      rawCommandOutputExcluded: true
    },
    roleCoverage: {
      requiredRoles: ["handheld", "station"],
      configuredRoles: ["handheld", "station"],
      missingRequiredRoles: [],
      complete: true
    },
    adb: {
      probeAvailable: true,
      expectedTargets: 3,
      connectedDevices,
      unavailableDevices: 0,
      unexpectedConnectedDevices: 0
    },
    android: androidTargets,
    raspberry: {
      reachable: raspberryReachable,
      architecture: "aarch64",
      bluez: {
        available: true,
        version: "5.79",
        powered: true,
        discovering: false
      },
      ntpSynchronized: true,
      ups: {
        discoveryOnly: true,
        probeAvailable: false,
        discoveredDevices: 0,
        serviceProbeAvailable: false,
        serviceUnitsObserved: 0
      },
      services: [
        service("cassav6.service", "OPERATIONAL_REQUIRED"),
        service("bluetooth.service", "OPERATIONAL_REQUIRED"),
        service("cassav6-bluetooth-node.service"),
        service("cassav6-bluetooth-enrollment.service")
      ],
      registry: {
        devices: 3,
        activeDevices: 3,
        revokedDevices: 0,
        enrollmentTokens: 0,
        pendingTokens: 0
      },
      enrollmentTransactions: { files: 0, allPrivate: true },
      permissionsSecure: true
    },
    errors: []
  };
}

function makeLiveAttestation({
  sourceInventory = inventory(),
  stationSigningPolicy = "CERTIFIED_REQUIRED",
  campaign = false
} = {}) {
  const station = sourceInventory.android.find((entry) => entry.role === "station");
  const observedPhysicalActors =
    sourceInventory.android.filter((entry) => entry.connected).length +
    (sourceInventory.raspberry.reachable ? 1 : 0);
  const stationSigningVerified =
    station.signingCertificatePinCoveredByCertifiedApk;
  const functionalReadinessComplete =
    observedPhysicalActors === 4 &&
    station.versionNameMatches &&
    station.versionCodeMatches &&
    station.apkSha256Matches &&
    (stationSigningVerified || stationSigningPolicy === "WAIVED_NON_GATE");
  const readinessStatus = functionalReadinessComplete
    ? stationSigningVerified
      ? "MIXED_READY_CERTIFIED"
      : "MIXED_READY_WITH_NON_GATE_STATION_WAIVER"
    : "MIXED_PHYSICAL_INCOMPLETE";
  const inventorySha256 = sha256(JSON.stringify(sourceInventory));
  const evidence = {
    radioWorkload: sha256("radio-workload"),
    physicalBusiness: sha256("physical-business"),
    continuityMonitoring: sha256("continuity-monitoring"),
    physicalSoak: sha256("physical-soak")
  };
  const withoutDigest = {
    schemaVersion: 1,
    harnessVersion: "1.0.0",
    product: "V6",
    phase: "B11",
    mode: "B11_MIXED_PHYSICAL_ATTESTATION",
    captureMode: "LIVE",
    fixtureUsed: false,
    generatedAt: sourceInventory.generatedAt,
    readinessStatus,
    stationSigningPolicy,
    stationSigningVerified,
    gateEligible: false,
    configuredPhysicalActors: 4,
    observedPhysicalActors,
    physicalPresenceComplete: observedPhysicalActors === 4,
    functionalReadinessComplete,
    captureScope: campaign
      ? "INVENTORY_AND_PHYSICAL_CAMPAIGN"
      : "INVENTORY_ONLY",
    hardwareAccess: true,
    adbExecuted: true,
    sshExecuted: true,
    readOnly: true,
    inventoryEncoding: "JSON_UTF8_COMPACT",
    inventorySha256,
    inventory: sourceInventory,
    radioWorkload: campaign
      ? {
          status: "PASS",
          evidenceSha256: evidence.radioWorkload,
          realRealLinkCount: 6,
          cyclesPerLink: 100,
          expectedCycles: 600,
          completedCycles: 600,
          helloCycles: 600,
          authenticatedCycles: 600,
          bidirectionalDataCycles: 600,
          cleanupCycles: 600
        }
      : {
          status: "NOT_RUN",
          evidenceSha256: null,
          realRealLinkCount: 6,
          cyclesPerLink: 100,
          expectedCycles: 600,
          completedCycles: 0,
          helloCycles: 0,
          authenticatedCycles: 0,
          bidirectionalDataCycles: 0,
          cleanupCycles: 0
        },
    physicalBusiness: campaign
      ? {
          status: "PASS",
          evidenceSha256: evidence.physicalBusiness,
          expectedActions: 600,
          completedActions: 600,
          expectedHandheldCommands: 160,
          completedHandheldCommands: 160
        }
      : {
          status: "NOT_RUN",
          evidenceSha256: null,
          expectedActions: 600,
          completedActions: 0,
          expectedHandheldCommands: 160,
          completedHandheldCommands: 0
        },
    continuityMonitoring: campaign
      ? {
          status: "PASS",
          evidenceSha256: evidence.continuityMonitoring,
          expectedActors: 4,
          monitoredActors: 4,
          continuous: true
        }
      : {
          status: "NOT_RUN",
          evidenceSha256: null,
          expectedActors: 4,
          monitoredActors: 0,
          continuous: false
        },
    physicalSoak: campaign
      ? {
          status: "PASS",
          evidenceSha256: evidence.physicalSoak,
          requiredDurationMs: 7_200_000,
          observedDurationMs: 7_200_000,
          wallClock: true
        }
      : {
          status: "NOT_RUN",
          evidenceSha256: null,
          requiredDurationMs: 7_200_000,
          observedDurationMs: 0,
          wallClock: false
        },
    campaignEvidenceCommitment: campaign
      ? sha256(JSON.stringify(evidence))
      : null
  };
  return {
    ...withoutDigest,
    attestationDigest: sha256(JSON.stringify(withoutDigest))
  };
}

function bytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
}

function resignAttestation(attestation) {
  attestation.inventorySha256 = sha256(JSON.stringify(attestation.inventory));
  const { attestationDigest: ignored, ...body } = attestation;
  attestation.attestationDigest = sha256(JSON.stringify(body));
  return attestation;
}

async function simulatedBytes() {
  return readFile(simulatedReportPath);
}

function throwsCode(fn, code) {
  assert.throws(
    fn,
    (error) =>
      error instanceof B11MixedPhysicalVirtualError && error.code === code
  );
}

test("inventory-only physical evidence composes an explicit incomplete report", async () => {
  const physical = bytes(makeLiveAttestation());
  const simulated = await simulatedBytes();
  const report = composeB11MixedPhysicalVirtualReport({
    physicalAttestationBytes: physical,
    simulatedReportBytes: simulated,
    now: fixedNow
  });
  assert.equal(report.verdict, "MIXED_NON_GATE_INCOMPLETE");
  assert.deepEqual(report.actorInventory, {
    totalActors: 16,
    physicalActors: 4,
    virtualActors: 12,
    roles: {
      HANDHELD: { total: 10, physical: 2, virtual: 8 },
      STATION: { total: 3, physical: 1, virtual: 2 },
      RASPBERRY: { total: 1, physical: 1, virtual: 0 },
      AUTOMATIC_CASH: { total: 1, physical: 0, virtual: 1 },
      FISCAL_RT: { total: 1, physical: 0, virtual: 1 }
    }
  });
  assert.equal(report.coveragePartition.realReal.completedPhysicalCycles, 0);
  assert.equal(report.coveragePartition.logicalCrossDomain.completedSoftwareCycles, 4000);
  assert.equal(report.coveragePartition.virtualOnly.completedSoftwareCycles, 4500);
  assert.equal(report.gateImpact, "NONE");
  assert.equal(report.b11Gate, "PENDING");
  validateB11MixedPhysicalVirtualReport(report);
  physical.fill(0);
  simulated.fill(0);
});

test("v3 schemas expose no executable physical PASS branch", async () => {
  const attestationSchema = JSON.parse(await readFile(path.join(
    packageRoot,
    "contracts/b11-mixed-physical-attestation-v1.schema.json"
  ), "utf8"));
  const reportSchema = JSON.parse(await readFile(path.join(
    packageRoot,
    "contracts/b11-mixed-physical-virtual-non-gate-v3.schema.json"
  ), "utf8"));
  assert.equal(attestationSchema.properties.captureScope.const, "INVENTORY_ONLY");
  assert.equal(attestationSchema.properties.radioWorkload.$ref, "#/$defs/radioNotRun");
  assert.equal(reportSchema.properties.verdict.const, "MIXED_NON_GATE_INCOMPLETE");
  assert.equal(
    reportSchema.$defs.physicalFunctionalCoverage.properties.radioWorkloadStatus.const,
    "NOT_RUN"
  );
  assert.doesNotMatch(
    JSON.stringify([attestationSchema, reportSchema]),
    /MIXED_NON_GATE_PASS|INVENTORY_AND_PHYSICAL_CAMPAIGN|"status":"PASS"/u
  );
});

test("fabricated complete campaign receipts are rejected even with recomputed digests", async () => {
  const physical = bytes(makeLiveAttestation({ campaign: true }));
  const simulated = await simulatedBytes();
  throwsCode(
    () => composeB11MixedPhysicalVirtualReport({
      physicalAttestationBytes: physical,
      simulatedReportBytes: simulated,
      now: fixedNow
    }),
    "INVALID_EVIDENCE"
  );
  physical.fill(0);
  simulated.fill(0);
});

test("absence, stale evidence and fixture provenance fail closed", async () => {
  const simulated = await simulatedBytes();
  throwsCode(
    () => composeB11MixedPhysicalVirtualReport({
      physicalAttestationBytes: Buffer.alloc(0),
      simulatedReportBytes: simulated,
      now: fixedNow
    }),
    "INVALID_ARGUMENT"
  );
  const stale = makeLiveAttestation();
  stale.generatedAt = "2026-08-18T09:00:00.000Z";
  stale.inventory.generatedAt = stale.generatedAt;
  stale.inventorySha256 = sha256(JSON.stringify(stale.inventory));
  const { attestationDigest: ignored, ...staleBody } = stale;
  stale.attestationDigest = sha256(JSON.stringify(staleBody));
  throwsCode(
    () => validateB11MixedPhysicalAttestation(stale, { now: fixedNow }),
    "PHYSICAL_ATTESTATION_STALE"
  );
  const fixture = makeLiveAttestation();
  fixture.captureMode = "TEST_FIXTURE";
  fixture.fixtureUsed = true;
  fixture.hardwareAccess = false;
  fixture.adbExecuted = false;
  fixture.sshExecuted = false;
  const { attestationDigest: fixtureDigest, ...fixtureBody } = fixture;
  fixture.attestationDigest = sha256(JSON.stringify(fixtureBody));
  throwsCode(
    () => validateB11MixedPhysicalAttestation(fixture, { now: fixedNow }),
    "INVALID_EVIDENCE"
  );
  simulated.fill(0);
});

test("mutated inventory or wrong physical role count cannot be hidden by a digest", () => {
  const mutated = makeLiveAttestation();
  mutated.inventory.android[0].connected = false;
  throwsCode(
    () => validateB11MixedPhysicalAttestation(mutated, { now: fixedNow }),
    "EVIDENCE_DIGEST_MISMATCH"
  );

  const wrongRoles = makeLiveAttestation();
  wrongRoles.inventory.android[2].role = "handheld";
  wrongRoles.inventorySha256 = sha256(JSON.stringify(wrongRoles.inventory));
  const { attestationDigest: ignored, ...body } = wrongRoles;
  wrongRoles.attestationDigest = sha256(JSON.stringify(body));
  throwsCode(
    () => validateB11MixedPhysicalAttestation(wrongRoles, { now: fixedNow }),
    "PHYSICAL_ROLE_COUNT_INVALID"
  );
});

test("certification values, correlations and redacted strings fail closed", () => {
  const badVersion = makeLiveAttestation();
  badVersion.inventory.android[2].versionName = "9.9.9";
  badVersion.inventory.android[2].versionNameMatches = false;
  resignAttestation(badVersion);
  throwsCode(
    () => validateB11MixedPhysicalAttestation(badVersion, { now: fixedNow }),
    "INVALID_EVIDENCE"
  );

  const falseMatch = makeLiveAttestation();
  falseMatch.inventory.android[0].versionCodeMatches = false;
  resignAttestation(falseMatch);
  throwsCode(
    () => validateB11MixedPhysicalAttestation(falseMatch, { now: fixedNow }),
    "INVALID_EVIDENCE"
  );

  const leakedProbe = makeLiveAttestation();
  leakedProbe.inventory.status = "INCOMPLETE";
  leakedProbe.inventory.errors.push({ probe: "192.0.2.1", code: "UNAVAILABLE" });
  resignAttestation(leakedProbe);
  throwsCode(
    () => validateB11MixedPhysicalAttestation(leakedProbe, { now: fixedNow }),
    "INVALID_EVIDENCE"
  );

  const leakedService = makeLiveAttestation();
  leakedService.inventory.raspberry.services[0].subState = "host.example.test";
  resignAttestation(leakedService);
  throwsCode(
    () => validateB11MixedPhysicalAttestation(leakedService, { now: fixedNow }),
    "INVALID_EVIDENCE"
  );
});

test("station waiver never bypasses APK, version name or version code", async () => {
  const simulated = await simulatedBytes();
  for (const field of ["apkSha256Matches", "versionNameMatches", "versionCodeMatches"]) {
    const sourceInventory = inventory({ stationSigningVerified: false });
    const station = sourceInventory.android[2];
    station[field] = false;
    if (field === "versionNameMatches") station.versionName = null;
    if (field === "versionCodeMatches") station.versionCode = null;
    sourceInventory.status = "INCOMPLETE";
    const physical = bytes(makeLiveAttestation({
      sourceInventory,
      stationSigningPolicy: "WAIVED_NON_GATE"
    }));
    const report = composeB11MixedPhysicalVirtualReport({
      physicalAttestationBytes: physical,
      simulatedReportBytes: simulated,
      now: fixedNow
    });
    assert.equal(report.verdict, "MIXED_NON_GATE_INCOMPLETE", field);
    assert.equal(report.physicalFunctionalCoverage.inventoryReadinessComplete, false, field);
    physical.fill(0);
  }
  simulated.fill(0);
});

test("an absent station remains incomplete and is never virtually substituted", async () => {
  const sourceInventory = inventory({ stationConnected: false });
  const physical = bytes(makeLiveAttestation({
    sourceInventory,
    stationSigningPolicy: "WAIVED_NON_GATE"
  }));
  const simulated = await simulatedBytes();
  const report = composeB11MixedPhysicalVirtualReport({
    physicalAttestationBytes: physical,
    simulatedReportBytes: simulated,
    now: fixedNow
  });
  assert.equal(report.verdict, "MIXED_NON_GATE_INCOMPLETE");
  assert.equal(report.physicalPresence.observedStations, 0);
  assert.equal(report.physicalPresence.virtualSubstitutionAllowed, false);
  assert.equal(report.checks.physicalPresenceComplete, false);
  physical.fill(0);
  simulated.fill(0);
});

test("station signing waiver is explicit and can never make the report gate-eligible", async () => {
  const sourceInventory = inventory({ stationSigningVerified: false });
  const physical = bytes(makeLiveAttestation({
    sourceInventory,
    stationSigningPolicy: "WAIVED_NON_GATE"
  }));
  const simulated = await simulatedBytes();
  const report = composeB11MixedPhysicalVirtualReport({
    physicalAttestationBytes: physical,
    simulatedReportBytes: simulated,
    now: fixedNow
  });
  assert.equal(
    report.physicalFunctionalCoverage.readinessStatus,
    "MIXED_READY_WITH_NON_GATE_STATION_WAIVER"
  );
  assert.equal(report.physicalFunctionalCoverage.stationSigningVerified, false);
  assert.equal(report.physicalFunctionalCoverage.gateEligible, false);
  assert.equal(report.verdict, "MIXED_NON_GATE_INCOMPLETE");
  physical.fill(0);
  simulated.fill(0);
});

test("promotion and fabricated PASS mutations fail after attacker digest recalculation", async () => {
  const physical = bytes(makeLiveAttestation());
  const simulated = await simulatedBytes();
  const report = composeB11MixedPhysicalVirtualReport({
    physicalAttestationBytes: physical,
    simulatedReportBytes: simulated,
    now: fixedNow
  });
  for (const patch of [
    { promotionAllowed: true },
    { officialEvidence: true },
    { gateImpact: "B11" },
    { b11Gate: "PASS" },
    { verdict: "MIXED_NON_GATE_PASS" }
  ]) {
    const candidate = { ...report, ...patch };
    const { reportDigest, ...body } = candidate;
    candidate.reportDigest = sha256(JSON.stringify(body));
    assert.throws(
      () => validateB11MixedPhysicalVirtualReport(candidate),
      B11MixedPhysicalVirtualError
    );
  }
  physical.fill(0);
  simulated.fill(0);
});

test("file runner requires 0600 regular evidence and binds exact source bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "v6-b11-mixed-test-"));
  try {
    const physicalPath = path.join(directory, "physical.json");
    const simulationPath = path.join(directory, "simulation.json");
    const outputPath = path.join(directory, "report.json");
    await writeFile(physicalPath, bytes(makeLiveAttestation()), { mode: 0o600 });
    await writeFile(simulationPath, await simulatedBytes(), { mode: 0o600 });
    await chmod(physicalPath, 0o600);
    await chmod(simulationPath, 0o600);
    const report = await runB11MixedPhysicalVirtualNonGate({
      physicalAttestationPath: physicalPath,
      simulatedReportPath: simulationPath,
      outputPath,
      now: fixedNow
    });
    assert.equal(report.verdict, "MIXED_NON_GATE_INCOMPLETE");
    assert.equal(
      report.sourceBindings.physicalAttestationSha256,
      sha256(await readFile(physicalPath))
    );
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), report);
    const outputMetadata = await lstat(outputPath);
    assert.equal(outputMetadata.isFile(), true);
    assert.equal(outputMetadata.nlink, 1);
    assert.equal(outputMetadata.mode & 0o777, 0o600);
    await chmod(physicalPath, 0o644);
    await assert.rejects(
      () => runB11MixedPhysicalVirtualNonGate({
        physicalAttestationPath: physicalPath,
        simulatedReportPath: simulationPath,
        outputPath: path.join(directory, "second-report.json"),
        now: fixedNow
      }),
      (error) =>
        error instanceof B11MixedPhysicalVirtualError &&
        error.code === "INPUT_PATH_INVALID"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("report output is atomic 0600 and rejects overwrite or symlink paths", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "v6-b11-mixed-output-"));
  const physical = bytes(makeLiveAttestation());
  const simulated = await simulatedBytes();
  try {
    const report = composeB11MixedPhysicalVirtualReport({
      physicalAttestationBytes: physical,
      simulatedReportBytes: simulated,
      now: fixedNow
    });
    const output = path.join(directory, "report.json");
    await writeB11MixedPhysicalVirtualReport(output, report);
    const metadata = await lstat(output);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.nlink, 1);
    assert.equal(metadata.mode & 0o777, 0o600);
    await assert.rejects(
      () => writeB11MixedPhysicalVirtualReport(output, report),
      (error) =>
        error instanceof B11MixedPhysicalVirtualError &&
        error.code === "OUTPUT_EXISTS"
    );

    const linkTarget = path.join(directory, "target.json");
    const outputLink = path.join(directory, "output-link.json");
    await writeFile(linkTarget, "{}\n", { mode: 0o600 });
    await symlink(linkTarget, outputLink);
    await assert.rejects(
      () => writeB11MixedPhysicalVirtualReport(outputLink, report),
      (error) =>
        error instanceof B11MixedPhysicalVirtualError &&
        error.code === "OUTPUT_EXISTS"
    );

    const realParent = path.join(directory, "real-parent");
    const aliasParent = path.join(directory, "alias-parent");
    await mkdir(realParent);
    await symlink(realParent, aliasParent);
    await assert.rejects(
      () => writeB11MixedPhysicalVirtualReport(
        path.join(aliasParent, "report.json"),
        report
      ),
      (error) =>
        error instanceof B11MixedPhysicalVirtualError &&
        error.code === "OUTPUT_PATH_INVALID"
    );
  } finally {
    physical.fill(0);
    simulated.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI parser requires absolute evidence and output paths", () => {
  assert.deepEqual(
    parseB11MixedPhysicalVirtualArguments([
      "--physical-attestation", "/tmp/physical.json",
      "--simulated-report", "/tmp/simulation.json",
      "--output", "/tmp/report.json"
    ]),
    {
      physicalAttestationPath: "/tmp/physical.json",
      simulatedReportPath: "/tmp/simulation.json",
      outputPath: "/tmp/report.json",
      help: false
    }
  );
  throwsCode(
    () => parseB11MixedPhysicalVirtualArguments([
      "--physical-attestation", "relative.json",
      "--simulated-report", "/tmp/simulation.json",
      "--output", "/tmp/report.json"
    ]),
    "INVALID_ARGUMENT"
  );
  throwsCode(
    () => parseB11MixedPhysicalVirtualArguments([
      "--physical-attestation", "/tmp/physical.json",
      "--simulated-report", "/tmp/simulation.json"
    ]),
    "INVALID_ARGUMENT"
  );
});

test("CLI writes the report and prints only a redacted summary", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "v6-b11-mixed-cli-"));
  try {
    const now = new Date();
    const sourceInventory = inventory();
    sourceInventory.generatedAt = now.toISOString();
    const attestation = makeLiveAttestation({ sourceInventory });
    const physicalPath = path.join(directory, "physical.json");
    const simulatedPath = path.join(directory, "simulation.json");
    const outputPath = path.join(directory, "report.json");
    await writeFile(physicalPath, bytes(attestation), { mode: 0o600 });
    await writeFile(simulatedPath, await simulatedBytes(), { mode: 0o600 });
    const scriptPath = path.join(
      packageRoot,
      "raspberry/scripts/run-b11-mixed-physical-virtual-non-gate.mjs"
    );
    const result = spawnSync(process.execPath, [
      scriptPath,
      "--physical-attestation", physicalPath,
      "--simulated-report", simulatedPath,
      "--output", outputPath
    ], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(summary).sort(), ["reportDigest", "verdict"]);
    assert.equal(summary.verdict, "MIXED_NON_GATE_INCOMPLETE");
    assert.doesNotMatch(result.stdout, /actorInventory|physicalPresence/u);
    const report = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(report.reportDigest, summary.reportDigest);
    const metadata = await lstat(outputPath);
    assert.equal(metadata.mode & 0o777, 0o600);
    assert.equal(metadata.nlink, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
