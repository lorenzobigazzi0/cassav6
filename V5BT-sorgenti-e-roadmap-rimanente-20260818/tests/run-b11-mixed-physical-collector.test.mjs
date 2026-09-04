import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ADVANCED_CERTIFICATION_TARGETS,
  ADVANCED_CERTIFICATION_TARGETS_BINDING
} from "../ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/scripts/advanced-certification-targets.mjs";

import {
  B11MixedPhysicalCollectorError,
  buildB11MixedPhysicalTestAttestation,
  parseB11MixedPhysicalCollectorArguments,
  runB11MixedPhysicalCollector,
  writeB11MixedPhysicalCollectorOutputs
} from "../scripts/run-b11-mixed-physical-collector.mjs";

function android(role, signingVerified = true) {
  const target = ADVANCED_CERTIFICATION_TARGETS.roles[role];
  return {
    role,
    connected: true,
    androidUserMatches: true,
    androidApi: 34,
    packageInstalled: true,
    packageStopped: false,
    versionName: target.versionName,
    versionCode: target.versionCode,
    versionNameMatches: true,
    versionCodeMatches: true,
    apkSha256Matches: true,
    expectedSigningCertificateSha256: target.signingCertificateSha256,
    signingCertificatePinCoveredByCertifiedApk: signingVerified,
    permissionsGranted: true,
    authenticatedSession: true,
    sessionIdentityDistinct: true,
    enrollmentReady: true,
    enrollmentIdentityDistinct: true,
    registryBindingMatches: true,
    enrollmentAttempt: "READY"
  };
}

function service(service, requirement) {
  return {
    service,
    requirement,
    expectedState: requirement === "OPERATIONAL_REQUIRED"
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

function summary({ stationSigningVerified = true } = {}) {
  return {
    schemaVersion: 1,
    product: "V5BT",
    certificationMatrixSha256:
      ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256,
    mode: "REDACTED_READ_ONLY_BENCH_INVENTORY",
    generatedAt: "2026-08-18T10:00:00.000Z",
    status: stationSigningVerified ? "COMPLETE" : "INCOMPLETE",
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
      connectedDevices: 3,
      unavailableDevices: 0,
      unexpectedConnectedDevices: 0
    },
    android: [
      android("handheld"),
      android("handheld"),
      android("station", stationSigningVerified)
    ],
    raspberry: {
      reachable: true,
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
      permissionsSecure: true,
      registry: {
        devices: 3,
        activeDevices: 3,
        revokedDevices: 0,
        enrollmentTokens: 0,
        pendingTokens: 0
      },
      services: [
        service("cassav5bt.service", "OPERATIONAL_REQUIRED"),
        service("bluetooth.service", "OPERATIONAL_REQUIRED"),
        service("cassav5bt-bluetooth-node.service", "OBSERVE_ONLY"),
        service("cassav5bt-bluetooth-enrollment.service", "OBSERVE_ONLY")
      ],
      enrollmentTransactions: { files: 0, allPrivate: true }
    },
    errors: []
  };
}

function collectorConfig() {
  return {
    schemaVersion: 1,
    raspberryHost: "raspberry.example.test",
    raspberryUser: "admin",
    sshPort: 22,
    android: [
      { label: "handheld-1", role: "handheld", serial: "HH-001", expectedUserId: 0 },
      { label: "handheld-2", role: "handheld", serial: "HH-002", expectedUserId: 0 },
      { label: "station-1", role: "station", serial: "ST-001", expectedUserId: 0 }
    ]
  };
}

test("test fixture attestation is explicitly non-live with all campaign work NOT_RUN", () => {
  const attestation = buildB11MixedPhysicalTestAttestation(summary());
  assert.equal(attestation.captureMode, "TEST_FIXTURE");
  assert.equal(attestation.fixtureUsed, true);
  assert.equal(attestation.hardwareAccess, false);
  assert.equal(attestation.adbExecuted, false);
  assert.equal(attestation.sshExecuted, false);
  assert.equal(attestation.captureScope, "INVENTORY_ONLY");
  assert.equal(attestation.radioWorkload.status, "NOT_RUN");
  assert.equal(attestation.physicalBusiness.status, "NOT_RUN");
  assert.equal(attestation.continuityMonitoring.status, "NOT_RUN");
  assert.equal(attestation.physicalSoak.status, "NOT_RUN");
  assert.equal(attestation.gateEligible, false);
});

test("station signature waiver is explicit but remains non-gate", () => {
  const attestation = buildB11MixedPhysicalTestAttestation(
    summary({ stationSigningVerified: false }),
    { stationSigningPolicy: "WAIVED_NON_GATE" }
  );
  assert.equal(
    attestation.readinessStatus,
    "MIXED_READY_WITH_NON_GATE_STATION_WAIVER"
  );
  assert.equal(attestation.stationSigningVerified, false);
  assert.equal(attestation.gateEligible, false);
});

test("station waiver covers only the signer and never version or APK mismatches", () => {
  for (const field of ["versionName", "versionCode", "apkSha256"]) {
    const source = summary({ stationSigningVerified: false });
    const station = source.android[2];
    if (field === "versionName") {
      station.versionName = "9.9.9";
      station.versionNameMatches = false;
    } else if (field === "versionCode") {
      station.versionCode = 999;
      station.versionCodeMatches = false;
    } else {
      station.apkSha256Matches = false;
    }
    const attestation = buildB11MixedPhysicalTestAttestation(source, {
      stationSigningPolicy: "WAIVED_NON_GATE"
    });
    assert.equal(attestation.functionalReadinessComplete, false, field);
    assert.equal(attestation.readinessStatus, "MIXED_PHYSICAL_INCOMPLETE", field);
    if (field === "versionName") assert.equal(attestation.inventory.android[2].versionName, null);
    if (field === "versionCode") assert.equal(attestation.inventory.android[2].versionCode, null);
  }
});

test("public attestation sanitizes uncertified versions and rejects leaked strings", async () => {
  const source = summary();
  source.android[2].versionName = "9.9.9";
  source.android[2].versionNameMatches = false;
  source.status = "INCOMPLETE";
  const sanitized = buildB11MixedPhysicalTestAttestation(source);
  assert.equal(sanitized.inventory.android[2].versionName, null);
  assert.doesNotMatch(JSON.stringify(sanitized), /9\.9\.9/u);

  const leaked = summary();
  leaked.status = "INCOMPLETE";
  leaked.errors.push({ probe: "192.0.2.1", code: "UNAVAILABLE" });
  assert.throws(
    () => buildB11MixedPhysicalTestAttestation(leaked),
    (error) =>
      error instanceof B11MixedPhysicalCollectorError &&
      error.code === "REDACTION_INVALID"
  );
});

test("CLI accepts exactly two handhelds and one station and forbids fixture mode", () => {
  const parsed = parseB11MixedPhysicalCollectorArguments([
    "--raspberry-host", "raspberry.example.test",
    "--handheld", "HH-001,0",
    "--handheld", "HH-002,0",
    "--station", "ST-001,0",
    "--station-signing-policy", "WAIVED_NON_GATE",
    "--private-output", "/tmp/private.json",
    "--attestation-output", "/tmp/attestation.json"
  ]);
  assert.deepEqual(parsed.config.android.map(({ role }) => role), [
    "handheld", "handheld", "station"
  ]);
  assert.equal(parsed.stationSigningPolicy, "WAIVED_NON_GATE");
  assert.throws(
    () => parseB11MixedPhysicalCollectorArguments(["--fixture", "fake.json"]),
    (error) =>
      error instanceof B11MixedPhysicalCollectorError &&
      error.code === "FIXTURE_FORBIDDEN"
  );
});

test("collector API cannot inject a fixture runner", async () => {
  await assert.rejects(
    () => runB11MixedPhysicalCollector(collectorConfig(), {
      runner: async () => ({ exitCode: 0, stdout: "", stderr: "" })
    }),
    (error) =>
      error instanceof B11MixedPhysicalCollectorError &&
      error.code === "INVALID_ARGUMENT"
  );
});

test("private inventory and redacted attestation publish 0600 without overwrite", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "v5bt-mixed-collector-"));
  try {
    const privateOutput = path.join(directory, "private.json");
    const attestationOutput = path.join(directory, "attestation.json");
    const attestation = buildB11MixedPhysicalTestAttestation(summary());
    await writeB11MixedPhysicalCollectorOutputs(
      { privateInventory: { private: "secret" }, attestation },
      privateOutput,
      attestationOutput
    );
    for (const output of [privateOutput, attestationOutput]) {
      const metadata = await lstat(output);
      assert.equal(metadata.isFile(), true);
      assert.equal(metadata.nlink, 1);
      assert.equal(metadata.mode & 0o777, 0o600);
    }
    assert.deepEqual(JSON.parse(await readFile(attestationOutput, "utf8")), attestation);
    await assert.rejects(
      () => writeB11MixedPhysicalCollectorOutputs(
        { privateInventory: {}, attestation },
        privateOutput,
        path.join(directory, "second.json")
      ),
      (error) =>
        error instanceof B11MixedPhysicalCollectorError &&
        error.code === "OUTPUT_EXISTS"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("collector output rejects a symlinked parent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "v5bt-mixed-symlink-"));
  try {
    const real = path.join(directory, "real");
    const alias = path.join(directory, "alias");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(real));
    await symlink(real, alias);
    const attestation = buildB11MixedPhysicalTestAttestation(summary());
    await assert.rejects(
      () => writeB11MixedPhysicalCollectorOutputs(
        { privateInventory: {}, attestation },
        path.join(alias, "private.json"),
        path.join(alias, "attestation.json")
      ),
      (error) =>
        error instanceof B11MixedPhysicalCollectorError &&
        error.code === "OUTPUT_PATH_INVALID"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
