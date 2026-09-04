import assert from "node:assert/strict";
import {
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  timingSafeEqual
} from "node:crypto";
import test from "node:test";

import {
  DIRECT_CONTROL_V1_CLOSE_REASONS,
  DIRECT_CONTROL_V1_MESSAGE_TYPES,
  buildClientKeyShareBinderMessageV1,
  buildSessionKeyBinderMessageV1,
  buildSessionTranscriptHashV1,
  createClientKeyConfirmationV1,
  decodeCloseV1,
  decodeHeartbeatV1,
  decodeServerKeyShareV1,
  deriveDirectControlKeysV1,
  encodeClientKeyConfirmV1,
  encodeClientKeyShareV1,
  encodeCloseV1,
  encodeHeartbeatV1,
  verifyServerKeyConfirmationV1
} from "../../shared/protocol/direct-control-v1.mjs";
import {
  DIRECT_CONTROL_SERVER_SESSION_STATES,
  DirectControlHandshakeError,
  DirectControlHandshakeV1
} from "../dist/security/DirectControlHandshakeV1.js";
import { deriveReliableChannelDirectionMaterialV1 } from "../dist/protocol/FrameCodec.js";

const CERTIFICATE_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
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

function registryPort(aliasKey, options = {}) {
  return {
    async createAuthorizedDeviceMac(input) {
      if (options.revoked) throw new Error("REVOKED_NODE");
      assert.equal(input.nodeId, BINDING.clientHello.nodeId);
      assert.equal(input.certificateId, CERTIFICATE_ID);
      if (options.invalidMacLength) return Buffer.alloc(31);
      return createHmac("sha256", aliasKey).update(input.message).digest();
    },
    async verifyAuthorizedDeviceMac(input) {
      if (options.revoked) throw new Error("REVOKED_NODE");
      assert.equal(input.nodeId, BINDING.clientHello.nodeId);
      assert.equal(input.certificateId, CERTIFICATE_ID);
      const expected = createHmac("sha256", aliasKey)
        .update(input.message)
        .digest();
      try {
        return timingSafeEqual(expected, Buffer.from(input.proof));
      } finally {
        expected.fill(0);
      }
    }
  };
}

function clientKeyShare(aliasKey, keyPair = generateKeyPairSync("x25519")) {
  const publicKeySpki = keyPair.publicKey.export({
    format: "der",
    type: "spki"
  });
  const message = buildClientKeyShareBinderMessageV1(BINDING, publicKeySpki);
  const clientBinder = createHmac("sha256", aliasKey).update(message).digest();
  message.fill(0);
  return { keyPair, publicKeySpki, clientBinder };
}

function encodeClientShare(client) {
  return encodeClientKeyShareV1({
    sessionId: BINDING.clientHello.sessionId,
    publicKeySpki: client.publicKeySpki,
    clientBinder: client.clientBinder
  });
}

function deriveClientResult(aliasKey, client, serverShare) {
  const binderMessage = buildSessionKeyBinderMessageV1(
    BINDING,
    client.publicKeySpki,
    client.clientBinder,
    serverShare.publicKeySpki
  );
  const sessionKeyBinder = createHmac("sha256", aliasKey)
    .update(binderMessage)
    .digest();
  binderMessage.fill(0);
  const transcriptHash = buildSessionTranscriptHashV1(
    BINDING,
    client.publicKeySpki,
    client.clientBinder,
    serverShare.publicKeySpki
  );
  const serverPublicKey = createPublicKey({
    key: serverShare.publicKeySpki,
    format: "der",
    type: "spki"
  });
  const sharedSecret = diffieHellman({
    privateKey: client.keyPair.privateKey,
    publicKey: serverPublicKey
  });
  const keys = deriveDirectControlKeysV1({
    sharedSecret,
    sessionKeyBinder,
    transcriptHash
  });
  sharedSecret.fill(0);
  sessionKeyBinder.fill(0);
  return { keys, transcriptHash };
}

function wipeClientResult(result) {
  result.transcriptHash.fill(0);
  result.keys.clientToServerControlKey.fill(0);
  result.keys.serverToClientControlKey.fill(0);
  result.keys.clientConfirmationKey.fill(0);
  result.keys.serverConfirmationKey.fill(0);
}

test("X25519 and HKDF establish only after reciprocal key confirmation", async () => {
  const aliasKey = Buffer.alloc(32, 0x37);
  const client = clientKeyShare(aliasKey);
  const handshake = new DirectControlHandshakeV1(registryPort(aliasKey));
  const clientShareWire = encodeClientShare(client);
  const accepted = await handshake.acceptClientShare({
    binding: BINDING,
    sessionId: BINDING.clientHello.sessionId,
    wire: clientShareWire
  });
  const session = accepted.context;
  assert.deepEqual(session.snapshot(), {
    state: DIRECT_CONTROL_SERVER_SESSION_STATES.AWAITING_CLIENT_CONFIRMATION,
    keyEstablished: false,
    controlKeysReady: true,
    retainedSecretBufferCount: 4
  });

  const serverShare = decodeServerKeyShareV1(accepted.response);
  assert.equal(serverShare.publicKeySpki.byteLength, 44);
  assert.equal(serverShare.confirmation.byteLength, 32);
  const clientResult = deriveClientResult(aliasKey, client, serverShare);
  assert.equal(
    verifyServerKeyConfirmationV1({
      serverConfirmationKey: clientResult.keys.serverConfirmationKey,
      transcriptHash: clientResult.transcriptHash,
      confirmation: serverShare.confirmation
    }),
    true
  );
  const clientConfirmation = createClientKeyConfirmationV1({
    clientConfirmationKey: clientResult.keys.clientConfirmationKey,
    transcriptHash: clientResult.transcriptHash,
    serverConfirmation: serverShare.confirmation
  });
  const clientConfirmWire = encodeClientKeyConfirmV1({
    sessionId: BINDING.clientHello.sessionId,
    confirmation: clientConfirmation
  });
  handshake.acceptClientConfirm(session, clientConfirmWire);
  assert.deepEqual(session.snapshot(), {
    state: DIRECT_CONTROL_SERVER_SESSION_STATES.KEY_ESTABLISHED,
    keyEstablished: true,
    controlKeysReady: true,
    retainedSecretBufferCount: 2
  });
  handshake.acceptClientConfirm(session, clientConfirmWire);
  assert.throws(
    () => session.serverKeyShare(),
    (error) =>
      error instanceof DirectControlHandshakeError &&
      error.code === "SERVER_KEY_SHARE_UNAVAILABLE"
  );

  const reliable = session.exportReliableChannelMaterial();
  const expectedClientToServer = deriveReliableChannelDirectionMaterialV1(
    clientResult.keys.clientToServerControlKey
  );
  const expectedServerToClient = deriveReliableChannelDirectionMaterialV1(
    clientResult.keys.serverToClientControlKey
  );
  assert.deepEqual(reliable.clientToServer, expectedClientToServer);
  assert.deepEqual(reliable.serverToClient, expectedServerToClient);
  reliable.clientToServer.key.fill(0);
  reliable.clientToServer.noncePrefix.fill(0);
  reliable.serverToClient.key.fill(0);
  reliable.serverToClient.noncePrefix.fill(0);
  expectedClientToServer.key.fill(0);
  expectedClientToServer.noncePrefix.fill(0);
  expectedServerToClient.key.fill(0);
  expectedServerToClient.noncePrefix.fill(0);

  const ping = session.encodePing(17);
  assert.deepEqual(
    decodeHeartbeatV1(ping, {
      authenticationKey: clientResult.keys.serverToClientControlKey,
      expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PING,
      expectedSequence: 17
    }),
    {
      protocolVersion: 1,
      messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PING,
      sessionId: BINDING.clientHello.sessionId,
      sequence: 17
    }
  );
  const pong = encodeHeartbeatV1({
    messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PONG,
    sessionId: BINDING.clientHello.sessionId,
    sequence: 17,
    authenticationKey: clientResult.keys.clientToServerControlKey
  });
  assert.equal(session.acceptPong(pong, 17), 17);

  const close = session.encodeClose(
    18,
    DIRECT_CONTROL_V1_CLOSE_REASONS.NORMAL
  );
  assert.equal(
    decodeCloseV1(close, {
      authenticationKey: clientResult.keys.serverToClientControlKey,
      expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE,
      expectedSequence: 18,
      expectedReason: DIRECT_CONTROL_V1_CLOSE_REASONS.NORMAL
    }).reason,
    DIRECT_CONTROL_V1_CLOSE_REASONS.NORMAL
  );
  const closeAck = encodeCloseV1({
    messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE_ACK,
    sessionId: BINDING.clientHello.sessionId,
    sequence: 18,
    reason: DIRECT_CONTROL_V1_CLOSE_REASONS.NORMAL,
    authenticationKey: clientResult.keys.clientToServerControlKey
  });
  assert.deepEqual(session.acceptCloseAck(closeAck, 18, 1), {
    sequence: 18,
    reason: DIRECT_CONTROL_V1_CLOSE_REASONS.NORMAL
  });
  const clientClose = encodeCloseV1({
    messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE,
    sessionId: BINDING.clientHello.sessionId,
    sequence: 19,
    reason: DIRECT_CONTROL_V1_CLOSE_REASONS.SERVICE_STOP,
    authenticationKey: clientResult.keys.clientToServerControlKey
  });
  assert.deepEqual(session.acceptClose(clientClose, 19), {
    sequence: 19,
    reason: DIRECT_CONTROL_V1_CLOSE_REASONS.SERVICE_STOP
  });
  const serverCloseAck = session.encodeCloseAck(
    19,
    DIRECT_CONTROL_V1_CLOSE_REASONS.SERVICE_STOP
  );
  assert.equal(
    decodeCloseV1(serverCloseAck, {
      authenticationKey: clientResult.keys.serverToClientControlKey,
      expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE_ACK,
      expectedSequence: 19,
      expectedReason: DIRECT_CONTROL_V1_CLOSE_REASONS.SERVICE_STOP
    }).reason,
    DIRECT_CONTROL_V1_CLOSE_REASONS.SERVICE_STOP
  );

  session.destroy();
  assert.deepEqual(session.snapshot(), {
    state: DIRECT_CONTROL_SERVER_SESSION_STATES.DESTROYED,
    keyEstablished: false,
    controlKeysReady: false,
    retainedSecretBufferCount: 0
  });
  assert.equal(
    JSON.stringify(session.snapshot()).includes(BINDING.clientHello.sessionId),
    false
  );
  clientConfirmation.fill(0);
  clientShareWire.fill(0);
  accepted.response.fill(0);
  clientConfirmWire.fill(0);
  ping.fill(0);
  pong.fill(0);
  close.fill(0);
  closeAck.fill(0);
  clientClose.fill(0);
  serverCloseAck.fill(0);
  serverShare.publicKeySpki.fill(0);
  serverShare.confirmation.fill(0);
  wipeClientResult(clientResult);
  client.publicKeySpki.fill(0);
  client.clientBinder.fill(0);
  aliasKey.fill(0);
});

test("client binder tampering and revoked registry identities fail closed", async () => {
  const aliasKey = Buffer.alloc(32, 0x48);
  const client = clientKeyShare(aliasKey);
  const tamperedBinder = Buffer.from(client.clientBinder);
  tamperedBinder[0] ^= 0x01;
  const tamperedWire = encodeClientKeyShareV1({
    sessionId: BINDING.clientHello.sessionId,
    publicKeySpki: client.publicKeySpki,
    clientBinder: tamperedBinder
  });
  await assert.rejects(
    new DirectControlHandshakeV1(registryPort(aliasKey)).acceptClientShare({
      binding: BINDING,
      sessionId: BINDING.clientHello.sessionId,
      wire: tamperedWire
    }),
    (error) =>
      error instanceof DirectControlHandshakeError &&
      error.code === "CLIENT_KEY_BINDER_INVALID"
  );
  const validWire = encodeClientShare(client);
  await assert.rejects(
    new DirectControlHandshakeV1(
      registryPort(aliasKey, { revoked: true })
    ).acceptClientShare({
      binding: BINDING,
      sessionId: BINDING.clientHello.sessionId,
      wire: validWire
    }),
    (error) =>
      error instanceof DirectControlHandshakeError &&
      error.code === "DEVICE_IDENTITY_REJECTED"
  );
  tamperedWire.fill(0);
  validWire.fill(0);
  tamperedBinder.fill(0);
  client.publicKeySpki.fill(0);
  client.clientBinder.fill(0);
  aliasKey.fill(0);
});

test("non-X25519 keys and malformed server binders are rejected", async () => {
  const aliasKey = Buffer.alloc(32, 0x59);
  const ed25519 = generateKeyPairSync("ed25519");
  const wrongClient = {
    publicKeySpki: ed25519.publicKey.export({ format: "der", type: "spki" }),
    clientBinder: Buffer.alloc(32)
  };
  const wrongWire = Buffer.alloc(94);
  wrongWire[0] = 1;
  wrongWire[1] = 4;
  Buffer.from(BINDING.clientHello.sessionId, "base64url").copy(wrongWire, 2);
  wrongClient.publicKeySpki.copy(wrongWire, 18);
  wrongClient.clientBinder.copy(wrongWire, 62);
  await assert.rejects(
    new DirectControlHandshakeV1(registryPort(aliasKey)).acceptClientShare({
      binding: BINDING,
      sessionId: BINDING.clientHello.sessionId,
      wire: wrongWire
    }),
    (error) =>
      error instanceof DirectControlHandshakeError &&
      error.code === "CLIENT_KEY_SHARE_REJECTED"
  );

  const validClient = clientKeyShare(aliasKey);
  const validWire = encodeClientShare(validClient);
  await assert.rejects(
    new DirectControlHandshakeV1(
      registryPort(aliasKey, { invalidMacLength: true })
    ).acceptClientShare({
      binding: BINDING,
      sessionId: BINDING.clientHello.sessionId,
      wire: validWire
    }),
    (error) =>
      error instanceof DirectControlHandshakeError &&
      error.code === "SERVER_KEY_BINDER_FAILED"
  );
  wrongWire.fill(0);
  validWire.fill(0);
  wrongClient.publicKeySpki.fill(0);
  wrongClient.clientBinder.fill(0);
  validClient.publicKeySpki.fill(0);
  validClient.clientBinder.fill(0);
  aliasKey.fill(0);
});

test("invalid client confirmation destroys every retained key", async () => {
  const aliasKey = Buffer.alloc(32, 0x6a);
  const client = clientKeyShare(aliasKey);
  const handshake = new DirectControlHandshakeV1(registryPort(aliasKey));
  const clientWire = encodeClientShare(client);
  const accepted = await handshake.acceptClientShare({
    binding: BINDING,
    sessionId: BINDING.clientHello.sessionId,
    wire: clientWire
  });
  const session = accepted.context;
  const invalidConfirm = encodeClientKeyConfirmV1({
    sessionId: BINDING.clientHello.sessionId,
    confirmation: Buffer.alloc(32)
  });
  await assert.rejects(
    async () => handshake.acceptClientConfirm(session, invalidConfirm),
    (error) =>
      error instanceof DirectControlHandshakeError &&
      error.code === "CLIENT_KEY_CONFIRMATION_INVALID"
  );
  assert.deepEqual(session.snapshot(), {
    state: DIRECT_CONTROL_SERVER_SESSION_STATES.FAILED,
    keyEstablished: false,
    controlKeysReady: false,
    retainedSecretBufferCount: 0
  });
  session.destroy();
  clientWire.fill(0);
  accepted.response.fill(0);
  invalidConfirm.fill(0);
  client.publicKeySpki.fill(0);
  client.clientBinder.fill(0);
  aliasKey.fill(0);
});
