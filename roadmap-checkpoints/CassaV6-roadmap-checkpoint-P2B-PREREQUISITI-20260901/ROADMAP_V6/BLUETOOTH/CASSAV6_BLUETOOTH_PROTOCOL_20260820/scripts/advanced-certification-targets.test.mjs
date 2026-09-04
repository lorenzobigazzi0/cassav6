import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ADVANCED_CERTIFICATION_TARGETS,
  ADVANCED_CERTIFICATION_TARGETS_BINDING,
  CertificationTargetsError,
  buildAdvancedCertificationTargetsBinding,
  canonicalizeAdvancedCertificationTargets,
  loadAdvancedCertificationTargets,
  parseAdvancedCertificationTargets
} from "./advanced-certification-targets.mjs";

const MATRIX_PATH = new URL(
  "../configs/advanced-certification-targets.json",
  import.meta.url
);
const VALID_MATRIX = JSON.stringify({
  schemaVersion: 3,
  roles: {
    handheld: {
      artifactRelativePath:
        "artifacts/fixture-handheld-9.8.7-debug.apk",
      packageId: "com.example.fixture.handheld",
      versionName: "9.8.7",
      versionCode: 987,
      sha256: "1".repeat(64),
      signingCertificateSha256: "3".repeat(64)
    },
    station: {
      artifactRelativePath:
        "artifacts/fixture-station-8.7.6-debug.apk",
      packageId: "com.example.fixture.station",
      versionName: "8.7.6",
      versionCode: 876,
      sha256: "2".repeat(64),
      signingCertificateSha256: "3".repeat(64)
    }
  }
});

test("loads the exact Advanced certification matrix without duplicating its values", () => {
  const matrixOnDisk = JSON.parse(fs.readFileSync(MATRIX_PATH, "utf8"));
  assert.equal(ADVANCED_CERTIFICATION_TARGETS.schemaVersion, 3);
  assert.deepEqual(ADVANCED_CERTIFICATION_TARGETS, matrixOnDisk);
  assert.equal(Object.isFrozen(ADVANCED_CERTIFICATION_TARGETS), true);
  assert.equal(Object.isFrozen(ADVANCED_CERTIFICATION_TARGETS.roles), true);
  assert.equal(Object.isFrozen(ADVANCED_CERTIFICATION_TARGETS.roles.handheld), true);
});

test("builds a canonical public SHA-256 binding from the validated matrix", () => {
  const canonical = canonicalizeAdvancedCertificationTargets(
    ADVANCED_CERTIFICATION_TARGETS
  );
  const expectedDigest = crypto
    .createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex");
  assert.deepEqual(
    JSON.parse(canonical),
    ADVANCED_CERTIFICATION_TARGETS
  );
  assert.deepEqual(
    ADVANCED_CERTIFICATION_TARGETS_BINDING.matrix,
    ADVANCED_CERTIFICATION_TARGETS
  );
  assert.equal(
    ADVANCED_CERTIFICATION_TARGETS_BINDING.matrixSha256,
    expectedDigest
  );
  assert.deepEqual(
    Object.keys(ADVANCED_CERTIFICATION_TARGETS_BINDING).sort(),
    [
      "canonicalization",
      "digestAlgorithm",
      "matrix",
      "matrixSha256",
      "schemaVersion"
    ]
  );
  assert.equal(Object.isFrozen(ADVANCED_CERTIFICATION_TARGETS_BINDING), true);
  assert.equal(Object.isFrozen(ADVANCED_CERTIFICATION_TARGETS_BINDING.matrix), true);
  assert.equal(
    Object.isFrozen(ADVANCED_CERTIFICATION_TARGETS_BINDING.matrix.roles.handheld),
    true
  );
});

test("canonical binding ignores JSON field order and rejects unvalidated input", () => {
  const valid = JSON.parse(VALID_MATRIX);
  const reordered = {
    roles: {
      station: {
        versionName: valid.roles.station.versionName,
        sha256: valid.roles.station.sha256,
        signingCertificateSha256:
          valid.roles.station.signingCertificateSha256,
        packageId: valid.roles.station.packageId,
        artifactRelativePath: valid.roles.station.artifactRelativePath,
        versionCode: valid.roles.station.versionCode
      },
      handheld: {
        versionCode: valid.roles.handheld.versionCode,
        artifactRelativePath: valid.roles.handheld.artifactRelativePath,
        packageId: valid.roles.handheld.packageId,
        versionName: valid.roles.handheld.versionName,
        sha256: valid.roles.handheld.sha256,
        signingCertificateSha256:
          valid.roles.handheld.signingCertificateSha256
      }
    },
    schemaVersion: valid.schemaVersion
  };
  assert.equal(
    buildAdvancedCertificationTargetsBinding(valid).matrixSha256,
    buildAdvancedCertificationTargetsBinding(reordered).matrixSha256
  );
  assert.throws(
    () => buildAdvancedCertificationTargetsBinding({ ...valid, privateData: true }),
    (error) =>
      error instanceof CertificationTargetsError &&
      error.code === "CERTIFICATION_TARGETS_INVALID"
  );
});

test("rejects unsafe, non-normalized and duplicate artifact paths", () => {
  const valid = JSON.parse(VALID_MATRIX);
  const invalidPaths = [
    "../outside.apk",
    "artifacts/../outside.apk",
    "artifacts//named.apk",
    "artifacts\\named.apk",
    "/artifacts/named.apk",
    "elsewhere/named.apk",
    "artifacts/not-an-apk.txt",
    "artifacts/unsafe name.apk"
  ];
  for (const artifactRelativePath of invalidPaths) {
    const changed = {
      ...valid,
      roles: {
        ...valid.roles,
        handheld: { ...valid.roles.handheld, artifactRelativePath }
      }
    };
    assert.throws(
      () => parseAdvancedCertificationTargets(JSON.stringify(changed)),
      (error) =>
        error instanceof CertificationTargetsError &&
        error.code === "CERTIFICATION_TARGETS_INVALID"
    );
  }

  const duplicate = {
    ...valid,
    roles: {
      ...valid.roles,
      station: {
        ...valid.roles.station,
        artifactRelativePath: valid.roles.handheld.artifactRelativePath
      }
    }
  };
  assert.throws(
    () => parseAdvancedCertificationTargets(JSON.stringify(duplicate)),
    (error) =>
      error instanceof CertificationTargetsError &&
      error.code === "CERTIFICATION_TARGETS_INVALID"
  );
});

test("rejects missing, extra and malformed target fields", () => {
  const valid = JSON.parse(VALID_MATRIX);
  for (const changed of [
    { ...valid, unexpected: true },
    {
      ...valid,
      roles: {
        ...valid.roles,
        handheld: { ...valid.roles.handheld, versionCode: 0 }
      }
    },
    {
      ...valid,
      roles: {
        ...valid.roles,
        station: { ...valid.roles.station, sha256: "A".repeat(64) }
      }
    },
    {
      ...valid,
      roles: {
        ...valid.roles,
        station: {
          ...valid.roles.station,
          signingCertificateSha256: "0".repeat(64)
        }
      }
    },
    {
      ...valid,
      roles: {
        handheld: { ...valid.roles.handheld },
        station: {
          ...valid.roles.station,
          packageId: valid.roles.handheld.packageId
        }
      }
    }
  ]) {
    assert.throws(
      () => parseAdvancedCertificationTargets(JSON.stringify(changed)),
      (error) =>
        error instanceof CertificationTargetsError &&
        error.code === "CERTIFICATION_TARGETS_INVALID"
    );
  }
});

test("fails closed when the matrix is absent or is a symbolic link", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "v6-certification-targets-")
  );
  const missing = path.join(directory, "missing.json");
  const target = path.join(directory, "targets.json");
  const link = path.join(directory, "targets-link.json");
  try {
    assert.throws(
      () => loadAdvancedCertificationTargets(missing),
      (error) =>
        error instanceof CertificationTargetsError &&
        error.code === "CERTIFICATION_TARGETS_UNAVAILABLE"
    );
    fs.writeFileSync(target, VALID_MATRIX, { mode: 0o600 });
    fs.symlinkSync(target, link);
    assert.throws(
      () => loadAdvancedCertificationTargets(link),
      (error) =>
        error instanceof CertificationTargetsError &&
        error.code === "CERTIFICATION_TARGETS_UNAVAILABLE"
    );
    assert.deepEqual(
      loadAdvancedCertificationTargets(target).roles,
      JSON.parse(VALID_MATRIX).roles
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
