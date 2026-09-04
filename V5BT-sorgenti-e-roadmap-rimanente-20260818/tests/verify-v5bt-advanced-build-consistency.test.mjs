import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  certifiedLabArtifactRelativePath,
  parseApksignerCertificateSha256,
  parseGradleIdentity,
  verifyAdvancedBuildConsistency,
} from "../scripts/verify-v5bt-advanced-build-consistency.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function gradleSource(packageId, versionName, versionCode, nodeKind) {
  return `
val applicationPackage = "${packageId}"
android {
  defaultConfig {
    applicationId = applicationPackage
    versionCode = ${versionCode}
    versionName = "${versionName}"
    buildConfigField("String", "BLUETOOTH_NODE_KIND", "\\\"${nodeKind}\\\"")
  }
}
`;
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v5bt-build-consistency-"));
  const roles = {
    handheld: {
      appRoot: "APPLICATIVI/Palmare/android-app/app",
      packageId: "com.example.handheld.advanced",
      versionName: "1.2.3",
      versionCode: 7,
      nodeKind: "handheld",
      apk: Buffer.from("handheld-apk-fixture"),
    },
    station: {
      appRoot: "APPLICATIVI/Postazione/android-app/app",
      packageId: "com.example.station.advanced",
      versionName: "2.3.4",
      versionCode: 9,
      nodeKind: "station",
      apk: Buffer.from("station-apk-fixture"),
    },
  };
  const matrix = { schemaVersion: 3, roles: {} };
  for (const [role, config] of Object.entries(roles)) {
    const main = path.join(config.appRoot, "src/main/java/com/sentrapa/webkiosk/bluetooth");
    const unit = path.join(config.appRoot, "src/test/java/com/sentrapa/webkiosk/bluetooth");
    const genericApk = path.join(config.appRoot, "build/outputs/apk/debug/app-debug.apk");
    const artifactRelativePath = path.join(
      "artifacts",
      `fixture-${role}-certified.apk`,
    );
    const artifact = path.join(root, artifactRelativePath);
    fs.mkdirSync(path.join(root, main), { recursive: true });
    fs.mkdirSync(path.join(root, unit), { recursive: true });
    fs.mkdirSync(path.join(root, path.dirname(genericApk)), { recursive: true });
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(path.join(root, config.appRoot, "build.gradle.kts"), gradleSource(
      config.packageId,
      config.versionName,
      config.versionCode,
      config.nodeKind,
    ));
    fs.writeFileSync(
      path.join(root, main, "BluetoothFailoverService.kt"),
      `${role}\nBuildConfig.BLUETOOTH_NODE_KIND\nBluetoothAdvertisementNodeKind.fromBuildConfig(BuildConfig.BLUETOOTH_NODE_KIND)\n`,
    );
    fs.writeFileSync(path.join(root, main, "BluetoothProtocol.kt"), "shared-main\n");
    fs.writeFileSync(path.join(root, unit, "BluetoothProtocolTest.kt"), "shared-test\n");
    fs.writeFileSync(path.join(root, genericApk), Buffer.from(`${role}-generic-output`));
    fs.writeFileSync(artifact, config.apk);
    config.artifactRelativePath = artifactRelativePath;
    config.signingCertificateSha256 = "3".repeat(64);
    matrix.roles[role] = {
      artifactRelativePath,
      packageId: config.packageId,
      versionName: config.versionName,
      versionCode: config.versionCode,
      sha256: crypto.createHash("sha256").update(config.apk).digest("hex"),
      signingCertificateSha256: config.signingCertificateSha256,
    };
  }
  const matrixPath = path.join(root, "certification-targets.json");
  fs.writeFileSync(matrixPath, `${JSON.stringify(matrix)}\n`);
  return { root, matrixPath, roles };
}

function verifyFixture(fixture, options = {}) {
  return verifyAdvancedBuildConsistency({
    root: fixture.root,
    matrixPath: fixture.matrixPath,
    signingCertificateInspector: (_apkPath, { role }) =>
      fixture.roles[role].signingCertificateSha256,
    ...options,
  });
}

test("the current certified Android builds and shared Bluetooth trees are consistent", () => {
  const result = verifyAdvancedBuildConsistency({ root: workspaceRoot });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.roles.handheld.packageId, "com.sentrapa.palmare.advanced");
  assert.equal(result.roles.station.packageId, "com.sentrapa.postazione.advanced");
  assert.equal(
    result.roles.handheld.signingCertificateSha256,
    result.roles.station.signingCertificateSha256,
  );
  assert.equal(result.checks.length, 10);
  assert.deepEqual(result.parity.allowedDifferenceFiles, ["BluetoothFailoverService.kt"]);
  assert.deepEqual(result.parity.actualDifferenceFiles, ["BluetoothFailoverService.kt"]);
  assert.ok(result.parity.mainFiles > 30);
  assert.ok(result.parity.testFiles > 20);
});

test("Gradle identity parsing binds package, version and role", () => {
  assert.deepEqual(
    parseGradleIdentity(gradleSource("com.example.handheld.advanced", "1.2.3", 7, "handheld"), "handheld"),
    {
      packageId: "com.example.handheld.advanced",
      versionName: "1.2.3",
      versionCode: 7,
      nodeKind: "handheld",
    },
  );
  assert.throws(
    () => parseGradleIdentity(gradleSource("com.example.handheld.advanced", "1.2.3", 7, "station"), "handheld"),
    /BLUETOOTH_NODE_KIND|node kind/i,
  );
});

test("apksigner output parser accepts one certificate and rejects ambiguity", () => {
  const digest = "a".repeat(64);
  assert.equal(
    parseApksignerCertificateSha256(
      `Signer #1 certificate DN: CN=Fixture\nSigner #1 certificate SHA-256 digest: ${digest}\n`,
    ),
    digest,
  );
  assert.throws(
    () => parseApksignerCertificateSha256(
      `Signer #1 certificate SHA-256 digest: ${digest}\nSigner #2 certificate SHA-256 digest: ${"b".repeat(64)}\n`,
    ),
    /exactly one signing certificate/i,
  );
});

test("the verifier binds the named Lab artifact and ignores generic build output", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const genericApk = path.join(
    fixture.root,
    fixture.roles.handheld.appRoot,
    "build/outputs/apk/debug/app-debug.apk",
  );
  fs.writeFileSync(genericApk, "different-overwritable-generic-output");

  const result = verifyFixture(fixture);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(
    result.roles.handheld.artifactRelativePath,
    certifiedLabArtifactRelativePath({
      artifactRelativePath: fixture.roles.handheld.artifactRelativePath,
    }),
  );
  assert.equal(
    result.roles.station.artifactRelativePath,
    certifiedLabArtifactRelativePath({
      artifactRelativePath: fixture.roles.station.artifactRelativePath,
    }),
  );
});

test("the verifier rejects symbolic links for an artifact and its parents", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const handheldArtifact = path.join(
    fixture.root,
    fixture.roles.handheld.artifactRelativePath,
  );
  const externalArtifact = path.join(fixture.root, "external-handheld.apk");
  fs.writeFileSync(externalArtifact, fixture.roles.handheld.apk);
  fs.unlinkSync(handheldArtifact);
  fs.symlinkSync(externalArtifact, handheldArtifact);
  const artifactLink = verifyFixture(fixture);
  assert.equal(artifactLink.ok, false);
  assert.equal(artifactLink.errors[0].code, "CERTIFIED_ARTIFACT_PATH_INVALID");

  fs.unlinkSync(handheldArtifact);
  const matrix = JSON.parse(fs.readFileSync(fixture.matrixPath, "utf8"));
  matrix.roles.handheld.artifactRelativePath =
    "artifacts/certified/fixture-handheld.apk";
  fs.writeFileSync(fixture.matrixPath, `${JSON.stringify(matrix)}\n`);
  const externalDirectory = path.join(fixture.root, "external-certified");
  fs.mkdirSync(externalDirectory);
  fs.writeFileSync(
    path.join(externalDirectory, "fixture-handheld.apk"),
    fixture.roles.handheld.apk,
  );
  fs.symlinkSync(externalDirectory, path.join(fixture.root, "artifacts/certified"));
  const parentLink = verifyFixture(fixture);
  assert.equal(parentLink.ok, false);
  assert.equal(parentLink.errors[0].code, "CERTIFIED_ARTIFACT_PATH_INVALID");
});

test("the verifier fails closed on an unsafe matrix artifact path", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const matrix = JSON.parse(fs.readFileSync(fixture.matrixPath, "utf8"));
  matrix.roles.handheld.artifactRelativePath =
    "artifacts/../external-handheld.apk";
  fs.writeFileSync(fixture.matrixPath, `${JSON.stringify(matrix)}\n`);

  const result = verifyFixture(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "CONSISTENCY_CHECK_FAILED");
});

test("the verifier rejects an altered named Lab artifact", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const baseline = verifyFixture(fixture);
  assert.equal(baseline.ok, true, JSON.stringify(baseline.errors));

  const apkPath = path.join(fixture.root, fixture.roles.handheld.artifactRelativePath);
  fs.appendFileSync(apkPath, "tamper");
  const apkFailure = verifyFixture(fixture);
  assert.equal(apkFailure.ok, false);
  assert.equal(apkFailure.errors[0].code, "CERTIFIED_APK_MISMATCH");
});

test("the verifier rejects a signing certificate outside the matrix pin", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = verifyFixture(fixture, {
    signingCertificateInspector: () => "4".repeat(64),
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.errors[0].code,
    "CERTIFIED_SIGNING_CERTIFICATE_MISMATCH",
  );
});

test("the verifier rejects non-allowlisted Bluetooth source drift", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const sourcePath = path.join(
    fixture.root,
    fixture.roles.station.appRoot,
    "src/main/java/com/sentrapa/webkiosk/bluetooth/BluetoothProtocol.kt",
  );
  fs.writeFileSync(sourcePath, "unexpected-station-drift\n");
  const sourceFailure = verifyFixture(fixture);
  assert.equal(sourceFailure.ok, false);
  assert.equal(sourceFailure.errors[0].code, "SOURCE_BYTE_MISMATCH");
});

test("the verifier rejects a wrong role binding even when the matrix matches", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const buildPath = path.join(fixture.root, fixture.roles.handheld.appRoot, "build.gradle.kts");
  fs.writeFileSync(
    buildPath,
    gradleSource(
      fixture.roles.handheld.packageId,
      fixture.roles.handheld.versionName,
      fixture.roles.handheld.versionCode,
      "station",
    ),
  );
  const result = verifyFixture(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "ROLE_BINDING_MISMATCH");
});

test("the CLI resolves a workspace path containing spaces independently of cwd", () => {
  const execution = spawnSync(process.execPath, [
    path.join(workspaceRoot, "scripts/verify-v5bt-advanced-build-consistency.mjs"),
    "--root",
    workspaceRoot,
  ], { cwd: os.tmpdir(), encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  assert.equal(JSON.parse(execution.stdout).ok, true);
});
