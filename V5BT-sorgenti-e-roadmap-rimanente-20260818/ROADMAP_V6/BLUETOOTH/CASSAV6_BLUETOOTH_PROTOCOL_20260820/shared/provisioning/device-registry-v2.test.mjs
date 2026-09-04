import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  generateKeyPairSync,
  sign
} from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DeviceRegistryV1 } from "./device-registry-v1.mjs";
import {
  DeviceRegistryV2,
  DEVICE_REGISTRY_KIND,
  DEVICE_REGISTRY_SCHEMA_VERSION
} from "./device-registry-v2.mjs";

const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_ORDER = P256_ORDER >> 1n;
const CLI_PATH = fileURLToPath(
  new URL("../../raspberry/scripts/device-registry.mjs", import.meta.url)
);

function scalar(bytes) {
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
}

function writeScalar(value, output) {
  let remaining = value;
  for (let index = output.byteLength - 1; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

function lowS(signature) {
  const canonical = Buffer.from(signature);
  const s = scalar(canonical.subarray(32));
  if (s > P256_HALF_ORDER) {
    writeScalar(P256_ORDER - s, canonical.subarray(32));
  }
  return canonical;
}

function nodeId(index) {
  return `550e8400-e29b-41d4-a716-${index.toString(16).padStart(12, "0")}`;
}

async function temporaryRegistry(t, name = "cassav6-registry-v2-") {
  const directory = await mkdtemp(path.join(tmpdir(), name));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "devices.json");
}

test("v2 registry initializes privately with the new stable schema", async (t) => {
  const registryPath = await temporaryRegistry(t);
  const registry = new DeviceRegistryV2(registryPath);
  const initialized = await registry.initialize();
  assert.equal(initialized.schemaVersion, DEVICE_REGISTRY_SCHEMA_VERSION);
  assert.equal(initialized.kind, DEVICE_REGISTRY_KIND);
  assert.equal((await stat(registryPath)).mode & 0o777, 0o600);
  const stored = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.kind, "cassav6.bluetooth.device-registry");
});

test("mixed registry enrolls v1 Ed25519 and v2 P-256 without ambiguity", async (t) => {
  const registryPath = await temporaryRegistry(t);
  const registry = new DeviceRegistryV2(registryPath);
  await registry.initialize();
  const ed = generateKeyPairSync("ed25519");
  const p256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

  const v1Token = await registry.issueEnrollmentToken({
    protocolVersion: 1,
    enrollmentEndpointId: "raspberry-lab-cassav6"
  });
  const v2Token = await registry.issueEnrollmentToken({
    protocolVersion: 2,
    enrollmentEndpointId: "raspberry-lab-cassav6"
  });
  assert.equal(v1Token.qr.version, 1);
  assert.match(v1Token.qr.token, /^c6e1_/);
  assert.equal(v2Token.qr.version, 2);
  assert.match(v2Token.qr.token, /^c6e2_/);
  assert.equal(v2Token.qrPayload, JSON.stringify(v2Token.qr));

  const edDevice = await registry.enrollDevice({
    protocolVersion: 1,
    enrollmentEndpointId: v1Token.qr.enrollmentEndpointId,
    token: v1Token.qr.token,
    nodeId: nodeId(1),
    publicKeyAlgorithm: "Ed25519",
    publicKey: ed.publicKey
  });
  const ecDevice = await registry.enrollDevice({
    protocolVersion: 2,
    enrollmentEndpointId: v2Token.qr.enrollmentEndpointId,
    token: v2Token.qr.token,
    nodeId: nodeId(2),
    publicKeyAlgorithm: "EC-P256",
    publicKey: p256.publicKey
  });
  assert.equal(edDevice.protocolVersion, 1);
  assert.equal(edDevice.publicKeyAlgorithm, "Ed25519");
  assert.equal(ecDevice.protocolVersion, 2);
  assert.equal(ecDevice.publicKeyAlgorithm, "EC-P256");

  const inspected = await registry.inspect();
  assert.deepEqual(
    inspected.devices.map((device) => device.publicKeyAlgorithm).sort(),
    ["EC-P256", "Ed25519"]
  );
  assert.deepEqual(
    inspected.enrollmentTokens.map((token) => token.protocolVersion).sort(),
    [1, 2]
  );
});

test("protocol-to-key binding rejects downgrade and cross-algorithm enrollment", async (t) => {
  const registryPath = await temporaryRegistry(t);
  const registry = new DeviceRegistryV2(registryPath);
  await registry.initialize();
  const ed = generateKeyPairSync("ed25519");
  const p256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const v1 = await registry.issueEnrollmentToken({
    protocolVersion: 1,
    enrollmentEndpointId: "raspberry-lab-cassav6"
  });
  const v2 = await registry.issueEnrollmentToken({
    protocolVersion: 2,
    enrollmentEndpointId: "raspberry-lab-cassav6"
  });

  await assert.rejects(
    registry.enrollDevice({
      protocolVersion: 2,
      enrollmentEndpointId: v2.qr.enrollmentEndpointId,
      token: v2.qr.token,
      nodeId: nodeId(3),
      publicKeyAlgorithm: "Ed25519",
      publicKey: ed.publicKey
    }),
    (error) => error?.code === "ENROLLMENT_PROTOCOL_MISMATCH"
  );
  await assert.rejects(
    registry.enrollDevice({
      protocolVersion: 1,
      enrollmentEndpointId: v1.qr.enrollmentEndpointId,
      token: v1.qr.token,
      nodeId: nodeId(4),
      publicKeyAlgorithm: "EC-P256",
      publicKey: p256.publicKey
    }),
    (error) => error?.code === "ENROLLMENT_PROTOCOL_MISMATCH"
  );
});

test("mixed authentication verifies Ed25519 and canonical P-256 signatures", async (t) => {
  const registryPath = await temporaryRegistry(t);
  const registry = new DeviceRegistryV2(registryPath);
  await registry.initialize();
  const ed = generateKeyPairSync("ed25519");
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const credentials = [];
  for (const [index, protocolVersion, algorithm, key] of [
    [5, 1, "Ed25519", ed],
    [6, 2, "EC-P256", ec]
  ]) {
    const issued = await registry.issueEnrollmentToken({
      protocolVersion,
      enrollmentEndpointId: "raspberry-lab-cassav6"
    });
    credentials.push(await registry.enrollDevice({
      protocolVersion,
      enrollmentEndpointId: issued.qr.enrollmentEndpointId,
      token: issued.qr.token,
      nodeId: nodeId(index),
      publicKeyAlgorithm: algorithm,
      publicKey: key.publicKey
    }));
  }

  const message = Buffer.from("mutual-auth-v1-transcript");
  const edSignature = sign(null, message, ed.privateKey);
  assert.equal(await registry.verifyAuthorizedDeviceSignature({
    nodeId: credentials[0].nodeId,
    certificateId: credentials[0].certificateId,
    message,
    signature: edSignature
  }), true);

  const ecSignature = lowS(sign(
    "sha256",
    message,
    { key: ec.privateKey, dsaEncoding: "ieee-p1363" }
  ));
  assert.equal(await registry.verifyAuthorizedDeviceSignature({
    nodeId: credentials[1].nodeId,
    certificateId: credentials[1].certificateId,
    message,
    signature: ecSignature
  }), true);

  const highS = Buffer.from(ecSignature);
  writeScalar(
    P256_ORDER - scalar(highS.subarray(32)),
    highS.subarray(32)
  );
  await assert.rejects(
    registry.verifyAuthorizedDeviceSignature({
      nodeId: credentials[1].nodeId,
      certificateId: credentials[1].certificateId,
      message,
      signature: highS
    }),
    (error) => error?.code === "INVALID_AUTH_INPUT"
  );
});

test("initialize atomically migrates a valid v1 registry and preserves credentials", async (t) => {
  const registryPath = await temporaryRegistry(t, "cassav6-migrate-v1-");
  const legacy = new DeviceRegistryV1(registryPath, {
    clock: () => new Date("2026-08-17T10:00:00.000Z")
  });
  await legacy.initialize();
  const ed = generateKeyPairSync("ed25519");
  const token = await legacy.issueEnrollmentToken({
    enrollmentEndpointId: "raspberry-lab-cassav6"
  });
  const credential = await legacy.enrollDevice({
    enrollmentEndpointId: token.qr.enrollmentEndpointId,
    token: token.qr.token,
    nodeId: nodeId(7),
    publicKey: ed.publicKey
  });
  const before = JSON.parse(await readFile(registryPath, "utf8"));

  const registry = new DeviceRegistryV2(registryPath, {
    clock: () => new Date("2026-08-17T10:01:00.000Z")
  });
  await assert.rejects(
    registry.inspect(),
    (error) => error?.code === "REGISTRY_MIGRATION_REQUIRED"
  );
  const migrated = await registry.initialize();
  assert.equal(migrated.schemaVersion, 2);
  const after = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(after.schemaVersion, 2);
  assert.equal(after.kind, "cassav6.bluetooth.device-registry");
  assert.equal(after.createdAt, before.createdAt);
  assert.deepEqual(after.devices, before.devices);
  assert.deepEqual(
    after.enrollmentTokens,
    before.enrollmentTokens.map((record) => ({
      tokenId: record.tokenId,
      enrollmentEndpointId: record.enrollmentEndpointId,
      protocolVersion: 1,
      tokenHashAlgorithm: record.tokenHashAlgorithm,
      tokenHashBase64: record.tokenHashBase64,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      consumedAt: record.consumedAt,
      consumedByNodeId: record.consumedByNodeId
    }))
  );
  const message = Buffer.from("legacy-credential-still-authorized");
  assert.equal(await registry.verifyAuthorizedDeviceSignature({
    nodeId: credential.nodeId,
    certificateId: credential.certificateId,
    message,
    signature: sign(null, message, ed.privateKey)
  }), true);
  assert.equal((await stat(registryPath)).mode & 0o777, 0o600);
});

test("migration refuses clock regression and leaves the legacy bytes untouched", async (t) => {
  const registryPath = await temporaryRegistry(t, "cassav6-migrate-clock-");
  const legacy = new DeviceRegistryV1(registryPath, {
    clock: () => new Date("2026-08-17T10:00:00.000Z")
  });
  await legacy.initialize();
  const original = await readFile(registryPath);
  const registry = new DeviceRegistryV2(registryPath, {
    clock: () => new Date("2026-08-17T09:59:59.999Z")
  });
  await assert.rejects(
    registry.initialize(),
    (error) => error?.code === "REGISTRY_CLOCK_ROLLBACK"
  );
  assert.deepEqual(await readFile(registryPath), original);
});

test("an unconsumed v1 token remains consumable exactly once after migration", async (t) => {
  const registryPath = await temporaryRegistry(t, "cassav6-migrate-token-");
  const legacy = new DeviceRegistryV1(registryPath, {
    clock: () => new Date("2026-08-17T10:00:00.000Z")
  });
  await legacy.initialize();
  const issued = await legacy.issueEnrollmentToken({
    enrollmentEndpointId: "raspberry-lab-cassav6",
    ttlSeconds: 600
  });
  const registry = new DeviceRegistryV2(registryPath, {
    clock: () => new Date("2026-08-17T10:01:00.000Z")
  });
  await registry.initialize();
  const keyPair = generateKeyPairSync("ed25519");
  const enrolled = await registry.enrollDevice({
    protocolVersion: 1,
    enrollmentEndpointId: issued.qr.enrollmentEndpointId,
    token: issued.qr.token,
    nodeId: nodeId(9),
    publicKeyAlgorithm: "Ed25519",
    publicKey: keyPair.publicKey
  });
  assert.equal(enrolled.protocolVersion, 1);
  await assert.rejects(
    registry.enrollDevice({
      protocolVersion: 1,
      enrollmentEndpointId: issued.qr.enrollmentEndpointId,
      token: issued.qr.token,
      nodeId: nodeId(10),
      publicKeyAlgorithm: "Ed25519",
      publicKey: generateKeyPairSync("ed25519").publicKey
    }),
    (error) => error?.code === "ENROLLMENT_TOKEN_REPLAY"
  );
});

test("v2 QR and response contracts encode the exact public constants", async () => {
  for (const relative of [
    "../../contracts/enrollment-qr-v2.schema.json",
    "../../contracts/enrollment-request-v2.schema.json",
    "../../contracts/enrollment-response-v2.schema.json",
    "../../contracts/device-registry-v2.schema.json"
  ]) {
    const schema = JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.additionalProperties, false);
  }
  const qr = JSON.parse(await readFile(
    new URL("../../contracts/enrollment-qr-v2.schema.json", import.meta.url),
    "utf8"
  ));
  assert.equal(qr.properties.version.const, 2);
  assert.match(`c6e2_${Buffer.alloc(32).toString("base64url")}`, new RegExp(
    qr.properties.token.pattern
  ));
});

test("schema v2 CLI issues and consumes both v1 Ed25519 and v2 P-256", async (t) => {
  const registryPath = await temporaryRegistry(t, "cassav6-cli-v2-");
  const directory = path.dirname(registryPath);
  const tokenV1Path = path.join(directory, "token-v1.json");
  const tokenPath = path.join(directory, "token-v2.json");
  const edKeyPath = path.join(directory, "android-ed25519-public.pem");
  const keyPath = path.join(directory, "android-p256-public.pem");
  const provisioningV1Path = path.join(directory, "provisioning-v1.json");
  const provisioningPath = path.join(directory, "provisioning-v2.json");
  const edKeyPair = generateKeyPairSync("ed25519");
  const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await writeFile(
    edKeyPath,
    edKeyPair.publicKey.export({ format: "pem", type: "spki" }),
    { mode: 0o600 }
  );
  await writeFile(
    keyPath,
    keyPair.publicKey.export({ format: "pem", type: "spki" }),
    { mode: 0o600 }
  );

  const run = (...arguments_) => spawnSync(
    process.execPath,
    [CLI_PATH, ...arguments_],
    { encoding: "utf8" }
  );
  const initialized = run(
    "init",
    "--registry", registryPath,
    "--protocol-version", "2"
  );
  assert.equal(initialized.status, 0, initialized.stderr);
  const issuedV1 = run(
    "issue-token",
    "--registry", registryPath,
    "--endpoint-id", "raspberry-lab-cassav6",
    "--protocol-version", "1",
    "--output", tokenV1Path
  );
  assert.equal(issuedV1.status, 0, issuedV1.stderr);
  const issued = run(
    "issue-token",
    "--registry", registryPath,
    "--endpoint-id", "raspberry-lab-cassav6",
    "--protocol-version", "2",
    "--output", tokenPath
  );
  assert.equal(issued.status, 0, issued.stderr);
  const token = JSON.parse(await readFile(tokenPath, "utf8"));
  assert.equal(token.qr.version, 2);
  assert.match(token.qr.token, /^c6e2_/);
  assert.equal(issued.stdout.includes(token.qr.token), false);
  const tokenV1 = JSON.parse(await readFile(tokenV1Path, "utf8"));
  assert.equal(tokenV1.qr.version, 1);
  assert.match(tokenV1.qr.token, /^c6e1_/);
  assert.equal(issuedV1.stdout.includes(tokenV1.qr.token), false);

  const enrolledV1 = run(
    "enroll",
    "--registry", registryPath,
    "--token-file", tokenV1Path,
    "--public-key-file", edKeyPath,
    "--node-id", nodeId(8),
    "--output", provisioningV1Path
  );
  assert.equal(enrolledV1.status, 0, enrolledV1.stderr);
  const provisioningV1 = JSON.parse(
    await readFile(provisioningV1Path, "utf8")
  );
  assert.equal(provisioningV1.protocolVersion, 1);
  assert.equal(provisioningV1.publicKeyAlgorithm, "Ed25519");
  assert.equal(
    enrolledV1.stdout.includes(provisioningV1.aliasKeyBase64url),
    false
  );

  const enrolled = run(
    "enroll",
    "--registry", registryPath,
    "--token-file", tokenPath,
    "--public-key-file", keyPath,
    "--node-id", nodeId(9),
    "--output", provisioningPath
  );
  assert.equal(enrolled.status, 0, enrolled.stderr);
  const provisioning = JSON.parse(await readFile(provisioningPath, "utf8"));
  assert.equal(provisioning.protocolVersion, 2);
  assert.equal(provisioning.publicKeyAlgorithm, "EC-P256");
  assert.equal(enrolled.stdout.includes(provisioning.aliasKeyBase64url), false);
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
  assert.equal((await stat(tokenV1Path)).mode & 0o777, 0o600);
  assert.equal((await stat(provisioningPath)).mode & 0o777, 0o600);
  assert.equal((await stat(provisioningV1Path)).mode & 0o777, 0o600);

  const inspection = await new DeviceRegistryV2(registryPath).inspect();
  assert.deepEqual(
    inspection.devices.map((device) => device.publicKeyAlgorithm).sort(),
    ["EC-P256", "Ed25519"]
  );
  assert.deepEqual(
    inspection.enrollmentTokens.map((tokenRecord) =>
      tokenRecord.protocolVersion
    ).sort(),
    [1, 2]
  );
});

test("schema v1 CLI stays v1 until explicit v2 init migration", async (t) => {
  const registryPath = await temporaryRegistry(t, "cassav6-cli-v1-stable-");
  const directory = path.dirname(registryPath);
  const tokenV1Path = path.join(directory, "token-v1.json");
  const rejectedV2Path = path.join(directory, "token-v2.json");
  const keyPath = path.join(directory, "android-ed25519-public.pem");
  const provisioningPath = path.join(directory, "provisioning-v1.json");
  const keyPair = generateKeyPairSync("ed25519");
  await writeFile(
    keyPath,
    keyPair.publicKey.export({ format: "pem", type: "spki" }),
    { mode: 0o600 }
  );
  const run = (...arguments_) => spawnSync(
    process.execPath,
    [CLI_PATH, ...arguments_],
    { encoding: "utf8" }
  );

  const initialized = run("init", "--registry", registryPath);
  assert.equal(initialized.status, 0, initialized.stderr);
  const beforeRejectedV2 = await readFile(registryPath);
  const rejectedV2 = run(
    "issue-token",
    "--registry", registryPath,
    "--endpoint-id", "raspberry-lab-cassav6",
    "--protocol-version", "2",
    "--output", rejectedV2Path
  );
  assert.equal(rejectedV2.status, 1, rejectedV2.stdout);
  assert.equal(
    JSON.parse(rejectedV2.stderr).code,
    "REGISTRY_MIGRATION_REQUIRED"
  );
  assert.deepEqual(await readFile(registryPath), beforeRejectedV2);
  await assert.rejects(
    stat(rejectedV2Path),
    (error) => error?.code === "ENOENT"
  );

  const issuedV1 = run(
    "issue-token",
    "--registry", registryPath,
    "--endpoint-id", "raspberry-lab-cassav6",
    "--protocol-version", "1",
    "--output", tokenV1Path
  );
  assert.equal(issuedV1.status, 0, issuedV1.stderr);
  const tokenV1 = JSON.parse(await readFile(tokenV1Path, "utf8"));
  assert.equal(tokenV1.qr.version, 1);

  const enrolledV1 = run(
    "enroll",
    "--registry", registryPath,
    "--token-file", tokenV1Path,
    "--public-key-file", keyPath,
    "--node-id", nodeId(10),
    "--output", provisioningPath
  );
  assert.equal(enrolledV1.status, 0, enrolledV1.stderr);
  const provisioning = JSON.parse(await readFile(provisioningPath, "utf8"));
  assert.equal(provisioning.protocolVersion, 1);
  assert.equal(provisioning.publicKeyAlgorithm, "Ed25519");
  const stored = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(stored.schemaVersion, 1);

  const migrated = run(
    "init",
    "--registry", registryPath,
    "--protocol-version", "2"
  );
  assert.equal(migrated.status, 0, migrated.stderr);
  const migratedStored = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(migratedStored.schemaVersion, 2);
  assert.equal(migratedStored.devices.length, 1);
});
