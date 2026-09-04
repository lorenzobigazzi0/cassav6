import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign, verify } from "node:crypto";
import test from "node:test";

import {
  MUTUAL_AUTH_V1_CLIENT_PROOF_WIRE_BYTES,
  MUTUAL_AUTH_V1_FINISH_WIRE_BYTES,
  MUTUAL_AUTH_V1_MINIMUM_MTU,
  MUTUAL_AUTH_V1_SERVER_PROOF_WIRE_BYTES,
  MutualAuthV1Error,
  buildAuthFinishProofMessageV1,
  buildClientAuthProofMessageV1,
  buildServerAuthProofMessageV1,
  decodeAuthClientProofV1,
  decodeAuthFinishV1,
  decodeAuthServerProofV1,
  encodeAuthClientProofV1,
  encodeAuthFinishV1,
  encodeAuthServerProofV1
} from "./mutual-auth-v1.mjs";

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
  deviceCertificateId: "f47ac10b-58cc-4372-a567-0e02b2c3d479"
});

function assertCode(code) {
  return (error) =>
    error instanceof MutualAuthV1Error && error.code === code;
}

test("mutual auth v1 uses fixed payloads that fit preferred MTU", () => {
  const signature = Buffer.alloc(64, 0x5a);
  const proof = Buffer.alloc(32, 0xa5);
  const clientWire = encodeAuthClientProofV1({
    sessionId: BINDING.clientHello.sessionId,
    deviceCertificateId: BINDING.deviceCertificateId,
    signature
  });
  const serverWire = encodeAuthServerProofV1({
    sessionId: BINDING.clientHello.sessionId,
    deviceCertificateId: BINDING.deviceCertificateId,
    proof
  });
  const finishWire = encodeAuthFinishV1({
    sessionId: BINDING.clientHello.sessionId,
    proof
  });

  assert.equal(clientWire.byteLength, MUTUAL_AUTH_V1_CLIENT_PROOF_WIRE_BYTES);
  assert.equal(serverWire.byteLength, MUTUAL_AUTH_V1_SERVER_PROOF_WIRE_BYTES);
  assert.equal(finishWire.byteLength, MUTUAL_AUTH_V1_FINISH_WIRE_BYTES);
  assert.equal(MUTUAL_AUTH_V1_MINIMUM_MTU, 101);
  assert.deepEqual(decodeAuthClientProofV1(clientWire).signature, signature);
  assert.deepEqual(decodeAuthServerProofV1(serverWire).proof, proof);
  assert.deepEqual(decodeAuthFinishV1(finishWire).proof, proof);
});

test("Ed25519 and both HMAC proofs bind the exact two HELLO messages", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const aliasKey = Buffer.from(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "hex"
  );
  const clientMessage = buildClientAuthProofMessageV1(BINDING);
  const clientSignature = sign(null, clientMessage, privateKey);
  assert.equal(verify(null, clientMessage, publicKey, clientSignature), true);

  const serverMessage = buildServerAuthProofMessageV1(
    BINDING,
    clientSignature
  );
  const serverProof = createHmac("sha256", aliasKey)
    .update(serverMessage)
    .digest();
  const finishMessage = buildAuthFinishProofMessageV1(
    BINDING,
    clientSignature,
    serverProof
  );
  const finishProof = createHmac("sha256", aliasKey)
    .update(finishMessage)
    .digest();

  assert.equal(serverProof.byteLength, 32);
  assert.equal(finishProof.byteLength, 32);

  const replayBinding = {
    ...BINDING,
    serverHello: {
      ...BINDING.serverHello,
      nonce: "MDEyMzQ1Njc4OTo7PD0-Pw"
    }
  };
  const replayMessage = buildClientAuthProofMessageV1(replayBinding);
  assert.equal(verify(null, replayMessage, publicKey, clientSignature), false);
});

test("codec rejects wrong type, length, session, certificate and role binding", () => {
  const signature = Buffer.alloc(64, 0x11);
  const encoded = encodeAuthClientProofV1({
    sessionId: BINDING.clientHello.sessionId,
    deviceCertificateId: BINDING.deviceCertificateId,
    signature
  });
  const wrongType = Buffer.from(encoded);
  wrongType[1] = 2;

  assert.throws(
    () => decodeAuthClientProofV1(wrongType),
    assertCode("INVALID_MESSAGE_TYPE")
  );
  assert.throws(
    () => decodeAuthClientProofV1(encoded.subarray(0, 97)),
    assertCode("INVALID_WIRE_LENGTH")
  );
  assert.throws(
    () =>
      encodeAuthClientProofV1({
        sessionId: `${BINDING.clientHello.sessionId}A`,
        deviceCertificateId: BINDING.deviceCertificateId,
        signature
      }),
    assertCode("INVALID_SESSIONID")
  );
  assert.throws(
    () =>
      encodeAuthClientProofV1({
        sessionId: BINDING.clientHello.sessionId,
        deviceCertificateId: BINDING.deviceCertificateId.toUpperCase(),
        signature
      }),
    assertCode("INVALID_DEVICECERTIFICATEID")
  );
  assert.throws(
    () =>
      buildClientAuthProofMessageV1({
        ...BINDING,
        serverHello: {
          ...BINDING.serverHello,
          capabilities: 0
        }
      }),
    assertCode("AUTH_BINDING_MISMATCH")
  );
});
