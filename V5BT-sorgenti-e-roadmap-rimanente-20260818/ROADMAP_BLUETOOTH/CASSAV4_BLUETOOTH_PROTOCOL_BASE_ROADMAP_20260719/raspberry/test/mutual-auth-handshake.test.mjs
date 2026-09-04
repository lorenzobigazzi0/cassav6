import assert from "node:assert/strict";
import {
  createHmac,
  generateKeyPairSync,
  sign,
  timingSafeEqual,
  verify
} from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAuthFinishProofMessageV1,
  buildClientAuthProofMessageV1,
  buildServerAuthProofMessageV1
} from "../../shared/protocol/mutual-auth-v1.mjs";
import {
  DeviceRegistryV2
} from "../../shared/provisioning/device-registry-v2.mjs";
import {
  MutualAuthHandshakeError,
  MutualAuthHandshakeV1
} from "../dist/security/Handshake.js";

const CERTIFICATE_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_ORDER = P256_ORDER >> 1n;
const BINDING = Object.freeze({
  clientHello: Object.freeze({
    protocolVersion: 1,
    sessionId: "AbCdEfGhIjKlMnOpQrStUg",
    nodeId: "550e8400-e29b-41d4-a716-446655440000",
    bootId: 17,
    capabilities: 47,
    nonce: "AAECAwQFBgcICQoLDA0ODw"
  }),
  serverHello: Object.freeze({
    protocolVersion: 1,
    sessionId: "AbCdEfGhIjKlMnOpQrStUg",
    nodeId: "123e4567-e89b-12d3-a456-426614174000",
    bootId: 54,
    capabilities: 72,
    nonce: "ICEiIyQlJicoKSorLC0uLw"
  }),
  deviceCertificateId: CERTIFICATE_ID
});

function cryptoPort(publicKey, aliasKey, options = {}) {
  return {
    async verifyAuthorizedDeviceSignature(input) {
      if (options.revoked) throw new Error("REVOKED_NODE");
      assert.equal(input.nodeId, BINDING.clientHello.nodeId);
      assert.equal(input.certificateId, CERTIFICATE_ID);
      return verify(null, input.message, publicKey, input.signature);
    },
    async createAuthorizedDeviceMac(input) {
      if (options.revoked) throw new Error("REVOKED_NODE");
      return createHmac("sha256", aliasKey).update(input.message).digest();
    },
    async verifyAuthorizedDeviceMac(input) {
      if (options.revoked) throw new Error("REVOKED_NODE");
      const expected = createHmac("sha256", aliasKey)
        .update(input.message)
        .digest();
      return timingSafeEqual(expected, Buffer.from(input.proof));
    }
  };
}

function scalar(bytes) {
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
}

function canonicalP256Signature(signature) {
  const result = Buffer.from(signature);
  const s = scalar(result.subarray(32));
  if (s <= P256_HALF_ORDER) return result;
  let normalized = P256_ORDER - s;
  for (let index = result.byteLength - 1; index >= 32; index -= 1) {
    result[index] = Number(normalized & 0xffn);
    normalized >>= 8n;
  }
  return result;
}

test("handshake verifies Android then proves Raspberry and the client finish", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const aliasKey = Buffer.alloc(32, 0x37);
  const handshake = new MutualAuthHandshakeV1(
    cryptoPort(publicKey, aliasKey)
  );
  const clientMessage = buildClientAuthProofMessageV1(BINDING);
  const signature = sign(null, clientMessage, privateKey);
  const serverProof = await handshake.verifyClientAndCreateServerProof({
    binding: BINDING,
    clientSignature: signature
  });
  const serverMessage = buildServerAuthProofMessageV1(BINDING, signature);
  assert.deepEqual(
    serverProof,
    createHmac("sha256", aliasKey).update(serverMessage).digest()
  );
  const finishMessage = buildAuthFinishProofMessageV1(
    BINDING,
    signature,
    serverProof
  );
  const finishProof = createHmac("sha256", aliasKey)
    .update(finishMessage)
    .digest();
  await handshake.verifyClientFinish({
    binding: BINDING,
    clientSignature: signature,
    serverProof,
    finishProof
  });
});

test("handshake rejects tampered signatures, finish proofs and revoked identities", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const aliasKey = Buffer.alloc(32, 0x48);
  const handshake = new MutualAuthHandshakeV1(
    cryptoPort(publicKey, aliasKey)
  );
  const message = buildClientAuthProofMessageV1(BINDING);
  const signature = sign(null, message, privateKey);
  const tamperedSignature = Buffer.from(signature);
  tamperedSignature[0] ^= 0x01;
  await assert.rejects(
    handshake.verifyClientAndCreateServerProof({
      binding: BINDING,
      clientSignature: tamperedSignature
    }),
    (error) =>
      error instanceof MutualAuthHandshakeError &&
      error.code === "CLIENT_SIGNATURE_INVALID"
  );

  const serverProof = await handshake.verifyClientAndCreateServerProof({
    binding: BINDING,
    clientSignature: signature
  });
  await assert.rejects(
    handshake.verifyClientFinish({
      binding: BINDING,
      clientSignature: signature,
      serverProof,
      finishProof: Buffer.alloc(32)
    }),
    (error) =>
      error instanceof MutualAuthHandshakeError &&
      error.code === "FINISH_PROOF_INVALID"
  );

  const revoked = new MutualAuthHandshakeV1(
    cryptoPort(publicKey, aliasKey, { revoked: true })
  );
  await assert.rejects(
    revoked.verifyClientAndCreateServerProof({
      binding: BINDING,
      clientSignature: signature
    }),
    (error) =>
      error instanceof MutualAuthHandshakeError &&
      error.code === "DEVICE_IDENTITY_REJECTED"
  );
});

test("handshake v1 wire authenticates an enrolled API31 P-256 identity", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "cassav5bt-p256-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new DeviceRegistryV2(path.join(directory, "devices.json"));
  await registry.initialize();
  const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const issued = await registry.issueEnrollmentToken({
    protocolVersion: 2,
    enrollmentEndpointId: "raspberry-lab-v5bt"
  });
  const provisioned = await registry.enrollDevice({
    protocolVersion: 2,
    enrollmentEndpointId: issued.qr.enrollmentEndpointId,
    token: issued.qr.token,
    nodeId: BINDING.clientHello.nodeId,
    publicKeyAlgorithm: "EC-P256",
    publicKey: keyPair.publicKey
  });
  const binding = {
    ...BINDING,
    deviceCertificateId: provisioned.certificateId
  };
  const handshake = new MutualAuthHandshakeV1(registry);
  const clientMessage = buildClientAuthProofMessageV1(binding);
  const signature = canonicalP256Signature(sign(
    "sha256",
    clientMessage,
    { key: keyPair.privateKey, dsaEncoding: "ieee-p1363" }
  ));
  const serverProof = await handshake.verifyClientAndCreateServerProof({
    binding,
    clientSignature: signature
  });
  const aliasKey = Buffer.from(provisioned.aliasKeyBase64url, "base64url");
  const finishMessage = buildAuthFinishProofMessageV1(
    binding,
    signature,
    serverProof
  );
  const finishProof = createHmac("sha256", aliasKey)
    .update(finishMessage)
    .digest();
  await handshake.verifyClientFinish({
    binding,
    clientSignature: signature,
    serverProof,
    finishProof
  });
  aliasKey.fill(0);
});
