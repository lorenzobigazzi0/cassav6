import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  AndroidPeerAuthKeyScheduleV2,
  AndroidPeerAuthV2Error,
  buildAndroidPeerAuthTranscriptHashV2,
  buildAndroidPeerClientSignatureMessageV2,
  buildAndroidPeerServerSignatureMessageV2,
  computeAndroidPeerSharedSecretV2,
  createAndroidPeerEphemeralV2,
  decodeAndroidPeerClientFinishV2,
  decodeAndroidPeerClientInitV2,
  decodeAndroidPeerServerReplyV2,
  encodeAndroidPeerClientFinishV2,
  encodeAndroidPeerClientInitV2,
  encodeAndroidPeerServerReplyV2,
  verifyAndroidPeerIdentitySignatureV2
} from "./android-peer-auth-v2.mjs";

const ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const HALF_ORDER = ORDER >> 1n;

const binding = {
  clientHello: {
    protocolVersion: 1,
    sessionId: "AAECAwQFBgcICQoLDA0ODw",
    nodeId: "11111111-1111-4111-8111-111111111111",
    bootId: 7,
    capabilities: 3,
    nonce: "AAECAwQFBgcICQoLDA0ODw"
  },
  serverHello: {
    protocolVersion: 1,
    sessionId: "AAECAwQFBgcICQoLDA0ODw",
    nodeId: "33333333-3333-4333-8333-333333333333",
    bootId: 8,
    capabilities: 3,
    nonce: "ICEiIyQlJicoKSorLC0uLw"
  },
  clientCertificateId: "22222222-2222-4222-8222-222222222222",
  serverCertificateId: "44444444-4444-4444-8444-444444444444",
  aliasEpoch: 2_977_320,
  clientAlias: "001122334455",
  serverAlias: "8899aabbccdd",
  clientRole: "CLIENT",
  serverRole: "SERVER"
};

function scalar(bytes) {
  let output = 0n;
  for (const byte of bytes) output = (output << 8n) | BigInt(byte);
  return output;
}

function scalarBytes(value) {
  const output = Buffer.alloc(32);
  for (let index = 31, next = value; index >= 0; index -= 1, next >>= 8n) {
    output[index] = Number(next & 0xffn);
  }
  return output;
}

function signP256(key, message) {
  const signature = Buffer.from(sign("sha256", message, {
    key,
    dsaEncoding: "ieee-p1363"
  }));
  const s = scalar(signature.subarray(32));
  if (s > HALF_ORDER) scalarBytes(ORDER - s).copy(signature, 32);
  return signature;
}

test("A2 signs both HELLO, ordered peer identity, aliases, epoch, roles and ephemerals", () => {
  const ephemeral = createAndroidPeerEphemeralV2();
  const baseline = buildAndroidPeerClientSignatureMessageV2(
    binding,
    ephemeral.publicKeySpki
  );
  for (const mutation of [
    { clientAlias: "101122334455" },
    { aliasEpoch: binding.aliasEpoch + 1 },
    { clientRole: "SERVER" },
    { clientCertificateId: "55555555-5555-4555-8555-555555555555" },
    { clientHello: { ...binding.clientHello, bootId: 9 } }
  ]) {
    if (mutation.clientRole === "SERVER") {
      assert.throws(
        () => buildAndroidPeerClientSignatureMessageV2(
          { ...binding, ...mutation }, ephemeral.publicKeySpki
        ),
        AndroidPeerAuthV2Error
      );
    } else {
      assert.notDeepEqual(
        buildAndroidPeerClientSignatureMessageV2(
          { ...binding, ...mutation }, ephemeral.publicKeySpki
        ),
        baseline
      );
    }
  }
});

test("A2 P256 identities authenticate an X25519 transcript and round-trip fixed wires", () => {
  const clientIdentity = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const serverIdentity = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const clientEphemeral = createAndroidPeerEphemeralV2();
  const serverEphemeral = createAndroidPeerEphemeralV2();
  const clientMessage = buildAndroidPeerClientSignatureMessageV2(
    binding,
    clientEphemeral.publicKeySpki
  );
  const clientSignature = signP256(clientIdentity.privateKey, clientMessage);
  assert.equal(
    verifyAndroidPeerIdentitySignatureV2(
      "EC-P256",
      clientIdentity.publicKey.export({ format: "der", type: "spki" }),
      clientMessage,
      clientSignature
    ),
    true
  );
  const serverMessage = buildAndroidPeerServerSignatureMessageV2(
    binding,
    clientEphemeral.publicKeySpki,
    clientSignature,
    serverEphemeral.publicKeySpki
  );
  const serverSignature = signP256(serverIdentity.privateKey, serverMessage);
  assert.equal(
    verifyAndroidPeerIdentitySignatureV2(
      "EC-P256",
      serverIdentity.publicKey.export({ format: "der", type: "spki" }),
      serverMessage,
      serverSignature
    ),
    true
  );
  const transcript = buildAndroidPeerAuthTranscriptHashV2(
    binding,
    clientEphemeral.publicKeySpki,
    clientSignature,
    serverEphemeral.publicKeySpki,
    serverSignature
  );
  const clientSecret = computeAndroidPeerSharedSecretV2(
    clientEphemeral.privateKey,
    serverEphemeral.publicKeySpki
  );
  const serverSecret = computeAndroidPeerSharedSecretV2(
    serverEphemeral.privateKey,
    clientEphemeral.publicKeySpki
  );
  assert.deepEqual(clientSecret, serverSecret);
  const clientSchedule = new AndroidPeerAuthKeyScheduleV2(clientSecret, transcript);
  const serverSchedule = new AndroidPeerAuthKeyScheduleV2(serverSecret, transcript);
  assert.throws(
    () => clientSchedule.exportReliableChannelControlKeys(),
    (error) => error.code === "CONFIRMATION_REQUIRED"
  );
  const serverConfirmation = serverSchedule.createServerConfirmation();
  assert.equal(clientSchedule.verifyServerConfirmation(serverConfirmation), true);
  const clientConfirmation = clientSchedule.createClientConfirmation(serverConfirmation);
  assert.equal(
    serverSchedule.verifyClientConfirmation(serverConfirmation, clientConfirmation),
    true
  );
  clientSchedule.confirmClientFinishTransmitted();
  assert.deepEqual(
    clientSchedule.exportReliableChannelControlKeys(),
    serverSchedule.exportReliableChannelControlKeys()
  );

  const clientWire = encodeAndroidPeerClientInitV2({
    sessionId: binding.clientHello.sessionId,
    clientCertificateId: binding.clientCertificateId,
    serverCertificateId: binding.serverCertificateId,
    clientEphemeralSpki: clientEphemeral.publicKeySpki,
    clientSignature
  });
  assert.equal(clientWire.length, 158);
  assert.deepEqual(
    encodeAndroidPeerClientInitV2(decodeAndroidPeerClientInitV2(clientWire)),
    clientWire
  );
  const serverWire = encodeAndroidPeerServerReplyV2({
    sessionId: binding.clientHello.sessionId,
    clientCertificateId: binding.clientCertificateId,
    serverCertificateId: binding.serverCertificateId,
    serverEphemeralSpki: serverEphemeral.publicKeySpki,
    serverSignature,
    serverConfirmation
  });
  assert.equal(serverWire.length, 190);
  assert.deepEqual(
    encodeAndroidPeerServerReplyV2(decodeAndroidPeerServerReplyV2(serverWire)),
    serverWire
  );
  const finishWire = encodeAndroidPeerClientFinishV2({
    sessionId: binding.clientHello.sessionId,
    clientConfirmation
  });
  assert.equal(finishWire.length, 50);
  assert.deepEqual(
    encodeAndroidPeerClientFinishV2(decodeAndroidPeerClientFinishV2(finishWire)),
    finishWire
  );
  clientSchedule.close();
  serverSchedule.close();
});

test("A2 refuses wrong confirmation and never exposes material", () => {
  const schedule = new AndroidPeerAuthKeyScheduleV2(
    Buffer.alloc(32, 1),
    Buffer.alloc(32, 2)
  );
  const serverConfirmation = schedule.createServerConfirmation();
  assert.equal(schedule.verifyClientConfirmation(serverConfirmation, Buffer.alloc(32)), false);
  assert.throws(
    () => schedule.exportReliableChannelControlKeys(),
    (error) => error.code === "CONFIRMATION_REQUIRED"
  );
  schedule.close();
  assert.throws(
    () => schedule.createServerConfirmation(),
    (error) => error.code === "KEY_MATERIAL_CLEARED"
  );
});
