import assert from "node:assert/strict";
import {
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  sign,
  timingSafeEqual,
  verify
} from "node:crypto";
import test from "node:test";

import { DBusError, Variant } from "@jellybrick/dbus-next";

import { CAPABILITY_BITS } from "../../shared/protocol/advertisement-v1.mjs";
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
import { decodeHelloV1, encodeHelloV1 } from "../../shared/protocol/hello-v1.mjs";
import {
  buildAuthFinishProofMessageV1,
  buildClientAuthProofMessageV1,
  buildServerAuthProofMessageV1,
  decodeAuthServerProofV1,
  encodeAuthClientProofV1,
  encodeAuthFinishV1
} from "../../shared/protocol/mutual-auth-v1.mjs";
import { GattApplication } from "../dist/bluez/GattApplication.js";
import { CassaGattService } from "../dist/gatt/CassaGattService.js";
import { DirectControlHandshakeV1 } from "../dist/security/DirectControlHandshakeV1.js";
import { MutualAuthHandshakeV1 } from "../dist/security/Handshake.js";
import {
  GattHelloExchangeError,
  GattHelloExchangeV1
} from "../dist/session/GattHelloExchangeV1.js";

const DEVICE = "/org/bluez/hci0/dev_00_11_22_33_44_55";
const SECOND_DEVICE = "/org/bluez/hci0/dev_66_77_88_99_AA_BB";
const CERTIFICATE_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const CLIENT_HELLO = Object.freeze({
  protocolVersion: 1,
  sessionId: "AbCdEfGhIjKlMnOpQrStUg",
  nodeId: "550e8400-e29b-41d4-a716-446655440000",
  bootId: 17,
  capabilities: CAPABILITY_BITS.GATT_CLIENT,
  nonce: "AAECAwQFBgcICQoLDA0ODw"
});
const SERVER_IDENTITY = Object.freeze({
  nodeId: "123e4567-e89b-12d3-a456-426614174000",
  bootId: 54,
  capabilities: CAPABILITY_BITS.GATT_SERVER
});

class FakeScheduler {
  now = 1_000;
  #nextId = 0;
  #tasks = new Map();

  set(callback, delayMs) {
    const id = ++this.#nextId;
    this.#tasks.set(id, {
      callback,
      dueAtMs: this.now + delayMs
    });
    return id;
  }

  clear(handle) {
    this.#tasks.delete(handle);
  }

  get size() {
    return this.#tasks.size;
  }

  runNext() {
    const next = [...this.#tasks.entries()].sort(
      ([leftId, left], [rightId, right]) =>
        left.dueAtMs - right.dueAtMs || leftId - rightId
    )[0];
    assert.ok(next, "expected one scheduled callback");
    const [id, task] = next;
    this.#tasks.delete(id);
    this.now = task.dueAtMs;
    task.callback();
  }
}

function registryPort(publicKey, aliasKey) {
  return {
    async verifyAuthorizedDeviceSignature(input) {
      return (
        input.nodeId === CLIENT_HELLO.nodeId &&
        input.certificateId === CERTIFICATE_ID &&
        verify(null, input.message, publicKey, input.signature)
      );
    },
    async createAuthorizedDeviceMac(input) {
      assert.equal(input.nodeId, CLIENT_HELLO.nodeId);
      assert.equal(input.certificateId, CERTIFICATE_ID);
      return createHmac("sha256", aliasKey).update(input.message).digest();
    },
    async verifyAuthorizedDeviceMac(input) {
      assert.equal(input.nodeId, CLIENT_HELLO.nodeId);
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

function createFixture() {
  const scheduler = new FakeScheduler();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const aliasKey = Buffer.alloc(32, 0x6b);
  const registry = registryPort(publicKey, aliasKey);
  const exchange = new GattHelloExchangeV1({
    enabled: true,
    mutualAuthEnabled: true,
    handshake: new MutualAuthHandshakeV1(registry),
    directControlEnabled: true,
    directControlHandshake: new DirectControlHandshakeV1(registry),
    identity: SERVER_IDENTITY,
    randomBytes: (length) => Buffer.alloc(length, 0x31),
    clock: () => scheduler.now,
    heartbeatIntervalMs: 10,
    heartbeatMissesBeforeClose: 3,
    activeSessionIdleTtlMs: 1_000,
    closeGraceMs: 5,
    scheduler
  });
  return { scheduler, privateKey, aliasKey, exchange };
}

async function openAndAuthenticate(fixture) {
  fixture.exchange.write({
    devicePath: DEVICE,
    mtu: 247,
    value: encodeHelloV1(CLIENT_HELLO)
  });
  const serverHello = decodeHelloV1(
    fixture.exchange.read({ devicePath: DEVICE, offset: 0 })
  );
  const binding = {
    clientHello: CLIENT_HELLO,
    serverHello,
    deviceCertificateId: CERTIFICATE_ID
  };
  const clientMessage = buildClientAuthProofMessageV1(binding);
  const signature = sign(null, clientMessage, fixture.privateKey);
  const serverWire = await fixture.exchange.writeControl({
    devicePath: DEVICE,
    value: encodeAuthClientProofV1({
      sessionId: CLIENT_HELLO.sessionId,
      deviceCertificateId: CERTIFICATE_ID,
      signature
    })
  });
  const server = decodeAuthServerProofV1(serverWire);
  const serverMessage = buildServerAuthProofMessageV1(binding, signature);
  const expectedServerProof = createHmac("sha256", fixture.aliasKey)
    .update(serverMessage)
    .digest();
  assert.deepEqual(server.proof, expectedServerProof);
  const finishMessage = buildAuthFinishProofMessageV1(
    binding,
    signature,
    server.proof
  );
  const finishProof = createHmac("sha256", fixture.aliasKey)
    .update(finishMessage)
    .digest();
  await fixture.exchange.writeControl({
    devicePath: DEVICE,
    value: encodeAuthFinishV1({
      sessionId: CLIENT_HELLO.sessionId,
      proof: finishProof
    })
  });
  return binding;
}

function createDirectClient(fixture, binding) {
  const keyPair = generateKeyPairSync("x25519");
  const publicKeySpki = keyPair.publicKey.export({
    format: "der",
    type: "spki"
  });
  const binderMessage = buildClientKeyShareBinderMessageV1(
    binding,
    publicKeySpki
  );
  const clientBinder = createHmac("sha256", fixture.aliasKey)
    .update(binderMessage)
    .digest();
  binderMessage.fill(0);
  return {
    keyPair,
    publicKeySpki,
    clientBinder,
    shareWire: encodeClientKeyShareV1({
      sessionId: CLIENT_HELLO.sessionId,
      publicKeySpki,
      clientBinder
    })
  };
}

function deriveClientKeys(fixture, binding, client, serverWire) {
  const server = decodeServerKeyShareV1(serverWire);
  const binderMessage = buildSessionKeyBinderMessageV1(
    binding,
    client.publicKeySpki,
    client.clientBinder,
    server.publicKeySpki
  );
  const sessionKeyBinder = createHmac("sha256", fixture.aliasKey)
    .update(binderMessage)
    .digest();
  const transcriptHash = buildSessionTranscriptHashV1(
    binding,
    client.publicKeySpki,
    client.clientBinder,
    server.publicKeySpki
  );
  const sharedSecret = diffieHellman({
    privateKey: client.keyPair.privateKey,
    publicKey: createPublicKey({
      key: server.publicKeySpki,
      format: "der",
      type: "spki"
    })
  });
  const keys = deriveDirectControlKeysV1({
    sharedSecret,
    sessionKeyBinder,
    transcriptHash
  });
  assert.equal(
    verifyServerKeyConfirmationV1({
      serverConfirmationKey: keys.serverConfirmationKey,
      transcriptHash,
      confirmation: server.confirmation
    }),
    true
  );
  const confirmation = createClientKeyConfirmationV1({
    clientConfirmationKey: keys.clientConfirmationKey,
    transcriptHash,
    serverConfirmation: server.confirmation
  });
  return {
    keys,
    confirmWire: encodeClientKeyConfirmV1({
      sessionId: CLIENT_HELLO.sessionId,
      confirmation
    })
  };
}

async function establishActive(fixture, binding) {
  const client = createDirectClient(fixture, binding);
  const serverWire = await fixture.exchange.writeControl({
    devicePath: DEVICE,
    value: client.shareWire
  });
  const direct = deriveClientKeys(fixture, binding, client, serverWire);
  const ping0 = await fixture.exchange.writeControl({
    devicePath: DEVICE,
    value: direct.confirmWire
  });
  assert.equal(
    decodeHeartbeatV1(ping0, {
      authenticationKey: direct.keys.serverToClientControlKey,
      expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PING,
      expectedSequence: 0
    }).sequence,
    0
  );
  assert.equal(fixture.exchange.snapshot().keyEstablishedSessionCount, 1);
  await fixture.exchange.writeControl({
    devicePath: DEVICE,
    value: encodeHeartbeatV1({
      messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PONG,
      sessionId: CLIENT_HELLO.sessionId,
      sequence: 0,
      authenticationKey: direct.keys.clientToServerControlKey
    })
  });
  assert.equal(fixture.exchange.snapshot().activeSessionCount, 1);
  return direct;
}

function assertCode(code) {
  return (error) =>
    error instanceof GattHelloExchangeError && error.code === code;
}

test("direct control activates only after PING0/PONG0 and closes cleanly", async () => {
  const fixture = createFixture();
  const outputs = [];
  fixture.exchange.setControlPublisher(({ value }) => {
    outputs.push(Buffer.from(value));
  });
  const binding = await openAndAuthenticate(fixture);
  const direct = await establishActive(fixture, binding);

  fixture.scheduler.runNext();
  assert.equal(outputs.length, 1);
  assert.equal(
    decodeHeartbeatV1(outputs[0], {
      authenticationKey: direct.keys.serverToClientControlKey,
      expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PING,
      expectedSequence: 1
    }).sequence,
    1
  );
  await fixture.exchange.writeControl({
    devicePath: DEVICE,
    value: encodeHeartbeatV1({
      messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PONG,
      sessionId: CLIENT_HELLO.sessionId,
      sequence: 1,
      authenticationKey: direct.keys.clientToServerControlKey
    })
  });
  const closeAck = await fixture.exchange.writeControl({
    devicePath: DEVICE,
    value: encodeCloseV1({
      messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE,
      sessionId: CLIENT_HELLO.sessionId,
      sequence: 2,
      reason: DIRECT_CONTROL_V1_CLOSE_REASONS.NORMAL,
      authenticationKey: direct.keys.clientToServerControlKey
    })
  });
  assert.equal(
    decodeCloseV1(closeAck, {
      authenticationKey: direct.keys.serverToClientControlKey,
      expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE_ACK,
      expectedSequence: 2,
      expectedReason: DIRECT_CONTROL_V1_CLOSE_REASONS.NORMAL
    }).reason,
    DIRECT_CONTROL_V1_CLOSE_REASONS.NORMAL
  );
  assert.equal(fixture.exchange.snapshot().closingSessionCount, 1);
  fixture.scheduler.runNext();

  const snapshot = fixture.exchange.snapshot();
  assert.equal(snapshot.clientKeySharesAcceptedTotal, 1);
  assert.equal(snapshot.serverKeySharesIssuedTotal, 1);
  assert.equal(snapshot.clientKeyConfirmationsVerifiedTotal, 1);
  assert.equal(snapshot.keyEstablishedTotal, 1);
  assert.equal(snapshot.heartbeatStartedTotal, 1);
  assert.equal(snapshot.pingsSentTotal, 2);
  assert.equal(snapshot.pongsVerifiedTotal, 2);
  assert.equal(snapshot.activeSessionsTotal, 1);
  assert.equal(snapshot.cleanClosesTotal, 1);
  assert.equal(snapshot.activeExchangeCount, 0);
  assert.equal(snapshot.keyEstablishedSessionCount, 0);
  assert.equal(snapshot.activeSessionCount, 0);
  assert.equal(snapshot.activeTimerCount, 0);
  assert.equal(snapshot.retainedSecretBufferCount, 0);
  assert.equal(fixture.scheduler.size, 0);
});

test("a delayed duplicate PONG is idempotent and does not destroy ACTIVE", async () => {
  const fixture = createFixture();
  const outputs = [];
  fixture.exchange.setControlPublisher(({ value }) => {
    outputs.push(Buffer.from(value));
  });
  const direct = await establishActive(
    fixture,
    await openAndAuthenticate(fixture)
  );
  const duplicatePong0 = encodeHeartbeatV1({
    messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PONG,
    sessionId: CLIENT_HELLO.sessionId,
    sequence: 0,
    authenticationKey: direct.keys.clientToServerControlKey
  });

  await fixture.exchange.writeControl({
    devicePath: DEVICE,
    value: duplicatePong0
  });
  let snapshot = fixture.exchange.snapshot();
  assert.equal(snapshot.activeSessionCount, 1);
  assert.equal(snapshot.pongsVerifiedTotal, 1);
  assert.equal(snapshot.directControlDuplicateWritesTotal, 1);
  assert.equal(snapshot.directControlFailuresTotal, 0);

  fixture.scheduler.runNext();
  assert.equal(outputs.length, 1);
  await fixture.exchange.writeControl({
    devicePath: DEVICE,
    value: encodeHeartbeatV1({
      messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PONG,
      sessionId: CLIENT_HELLO.sessionId,
      sequence: 1,
      authenticationKey: direct.keys.clientToServerControlKey
    })
  });
  snapshot = fixture.exchange.snapshot();
  assert.equal(snapshot.activeSessionCount, 1);
  assert.equal(snapshot.pongsVerifiedTotal, 2);
  assert.equal(snapshot.directControlFailuresTotal, 0);
});

test("wrong key message order fails closed without retained resources", async () => {
  const unauthenticated = createFixture();
  unauthenticated.exchange.write({
    devicePath: DEVICE,
    mtu: 247,
    value: encodeHelloV1(CLIENT_HELLO)
  });
  unauthenticated.exchange.read({ devicePath: DEVICE, offset: 0 });
  const fakeClient = generateKeyPairSync("x25519").publicKey.export({
    format: "der",
    type: "spki"
  });
  await assert.rejects(
    unauthenticated.exchange.writeControl({
      devicePath: DEVICE,
      value: encodeClientKeyShareV1({
        sessionId: CLIENT_HELLO.sessionId,
        publicKeySpki: fakeClient,
        clientBinder: Buffer.alloc(32)
      })
    }),
    assertCode("DIRECT_CONTROL_AUTH_REQUIRED")
  );
  assert.equal(
    unauthenticated.exchange.snapshot().retainedSecretBufferCount,
    0
  );
  assert.equal(unauthenticated.scheduler.size, 0);

  const missingShare = createFixture();
  await openAndAuthenticate(missingShare);
  await assert.rejects(
    missingShare.exchange.writeControl({
      devicePath: DEVICE,
      value: encodeClientKeyConfirmV1({
        sessionId: CLIENT_HELLO.sessionId,
        confirmation: Buffer.alloc(32)
      })
    }),
    assertCode("DIRECT_CONTROL_KEY_ORDER_INVALID")
  );
  const snapshot = missingShare.exchange.snapshot();
  assert.equal(snapshot.directControlFailuresTotal, 1);
  assert.equal(snapshot.activeTimerCount, 0);
  assert.equal(snapshot.retainedSecretBufferCount, 0);
});

test("three missed Raspberry heartbeats enter CLOSING until CLOSE_ACK", async () => {
  const fixture = createFixture();
  const outputs = [];
  fixture.exchange.setControlPublisher(({ value }) => {
    outputs.push(Buffer.from(value));
  });
  const direct = await establishActive(
    fixture,
    await openAndAuthenticate(fixture)
  );

  fixture.scheduler.runNext();
  fixture.scheduler.runNext();
  fixture.scheduler.runNext();
  fixture.scheduler.runNext();
  const closeWire = outputs.at(-1);
  const close = decodeCloseV1(closeWire, {
    authenticationKey: direct.keys.serverToClientControlKey,
    expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE,
    expectedReason: DIRECT_CONTROL_V1_CLOSE_REASONS.HEARTBEAT_TIMEOUT
  });
  let snapshot = fixture.exchange.snapshot();
  assert.equal(snapshot.heartbeatMissesTotal, 3);
  assert.equal(snapshot.heartbeatTimeoutClosesTotal, 1);
  assert.equal(snapshot.closingSessionCount, 1);
  assert.equal(snapshot.activeTimerCount, 1);

  await fixture.exchange.writeControl({
    devicePath: DEVICE,
    value: encodeCloseV1({
      messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE_ACK,
      sessionId: CLIENT_HELLO.sessionId,
      sequence: close.sequence,
      reason: close.reason,
      authenticationKey: direct.keys.clientToServerControlKey
    })
  });
  snapshot = fixture.exchange.snapshot();
  assert.equal(snapshot.cleanClosesTotal, 1);
  assert.equal(snapshot.activeExchangeCount, 0);
  assert.equal(snapshot.activeTimerCount, 0);
  assert.equal(snapshot.retainedSecretBufferCount, 0);
  assert.equal(fixture.scheduler.size, 0);
});

test("server requestClose deterministically publishes NORMAL CLOSE", async () => {
  const fixture = createFixture();
  const outputs = [];
  fixture.exchange.setControlPublisher(({ value }) => {
    outputs.push(Buffer.from(value));
  });
  const direct = await establishActive(
    fixture,
    await openAndAuthenticate(fixture)
  );

  fixture.exchange.requestSingleActiveClose();
  const close = decodeCloseV1(outputs.at(-1), {
    authenticationKey: direct.keys.serverToClientControlKey,
    expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE,
    expectedReason: DIRECT_CONTROL_V1_CLOSE_REASONS.NORMAL
  });
  assert.equal(fixture.exchange.snapshot().closingSessionCount, 1);
  fixture.exchange.requestClose(DEVICE);
  assert.equal(outputs.length, 1);
  await fixture.exchange.writeControl({
    devicePath: DEVICE,
    value: encodeHeartbeatV1({
      messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PONG,
      sessionId: CLIENT_HELLO.sessionId,
      sequence: 0,
      authenticationKey: direct.keys.clientToServerControlKey
    })
  });
  assert.equal(fixture.exchange.snapshot().closingSessionCount, 1);
  assert.equal(
    fixture.exchange.snapshot().directControlDuplicateWritesTotal,
    1
  );
  await fixture.exchange.writeControl({
    devicePath: DEVICE,
    value: encodeCloseV1({
      messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE_ACK,
      sessionId: CLIENT_HELLO.sessionId,
      sequence: close.sequence,
      reason: close.reason,
      authenticationKey: direct.keys.clientToServerControlKey
    })
  });
  const snapshot = fixture.exchange.snapshot();
  assert.equal(snapshot.cleanClosesTotal, 1);
  assert.equal(snapshot.activeExchangeCount, 0);
  assert.equal(snapshot.activeTimerCount, 0);
  assert.equal(snapshot.retainedSecretBufferCount, 0);
  assert.equal(fixture.scheduler.size, 0);
});

test("unacknowledged server CLOSE releases all resources after grace", async () => {
  const fixture = createFixture();
  fixture.exchange.setControlPublisher(() => {});
  await establishActive(fixture, await openAndAuthenticate(fixture));
  fixture.exchange.requestSingleActiveClose();
  assert.equal(fixture.exchange.snapshot().closingSessionCount, 1);

  fixture.scheduler.runNext();
  const snapshot = fixture.exchange.snapshot();
  assert.equal(snapshot.cleanClosesTotal, 0);
  assert.equal(snapshot.forcedClosesTotal, 1);
  assert.equal(snapshot.activeExchangeCount, 0);
  assert.equal(snapshot.activeTimerCount, 0);
  assert.equal(snapshot.retainedSecretBufferCount, 0);
  assert.equal(fixture.scheduler.size, 0);
});

test("direct mode admits one HELLO owner and reset clears keys and timers", async () => {
  const fixture = createFixture();
  await establishActive(fixture, await openAndAuthenticate(fixture));
  assert.throws(
    () =>
      fixture.exchange.write({
        devicePath: SECOND_DEVICE,
        mtu: 247,
        value: encodeHelloV1({
          ...CLIENT_HELLO,
          sessionId: "ICEiIyQlJicoKSorLC0uLw",
          nodeId: "7d444840-9dc0-11d1-b245-5ffdce74fad2"
        })
      }),
    assertCode("HELLO_CAPACITY_REACHED")
  );
  fixture.exchange.reset();
  const snapshot = fixture.exchange.snapshot();
  assert.equal(snapshot.activeExchangeCount, 0);
  assert.equal(snapshot.keyEstablishedSessionCount, 0);
  assert.equal(snapshot.activeSessionCount, 0);
  assert.equal(snapshot.activeTimerCount, 0);
  assert.equal(snapshot.retainedSecretBufferCount, 0);
  assert.equal(fixture.scheduler.size, 0);
});

test("GATT controlTx carries timer output and StopNotify releases the session", async () => {
  const fixture = createFixture();
  const binding = await openAndAuthenticate(fixture);
  const service = new CassaGattService();
  const application = new GattApplication(service, fixture.exchange);
  const controlRx = application.exports()[3].interface;
  const controlTx = application.exports()[4].interface;
  const dataRx = application.exports()[5].interface;
  const options = {
    device: new Variant("o", DEVICE),
    mtu: new Variant("q", 247),
    offset: new Variant("q", 0)
  };
  controlTx.StartNotify();
  const client = createDirectClient(fixture, binding);
  await controlRx.WriteValue(client.shareWire, options);
  const direct = deriveClientKeys(fixture, binding, client, controlTx.Value);
  await controlRx.WriteValue(direct.confirmWire, options);
  assert.equal(
    decodeHeartbeatV1(controlTx.Value, {
      authenticationKey: direct.keys.serverToClientControlKey,
      expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PING,
      expectedSequence: 0
    }).sequence,
    0
  );
  await controlRx.WriteValue(
    encodeHeartbeatV1({
      messageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PONG,
      sessionId: CLIENT_HELLO.sessionId,
      sequence: 0,
      authenticationKey: direct.keys.clientToServerControlKey
    }),
    options
  );
  fixture.scheduler.runNext();
  assert.equal(
    decodeHeartbeatV1(controlTx.Value, {
      authenticationKey: direct.keys.serverToClientControlKey,
      expectedMessageType: DIRECT_CONTROL_V1_MESSAGE_TYPES.PING,
      expectedSequence: 1
    }).sequence,
    1
  );
  assert.throws(
    () => dataRx.WriteValue(Buffer.alloc(1), options),
    (error) =>
      error instanceof DBusError &&
      error.type === "org.bluez.Error.NotAuthorized"
  );
  controlTx.StopNotify();
  assert.equal(controlTx.Notifying, false);
  assert.deepEqual(controlTx.Value, Buffer.alloc(0));
  const snapshot = application.snapshot().hello;
  assert.equal(snapshot.activeExchangeCount, 0);
  assert.equal(snapshot.activeTimerCount, 0);
  assert.equal(snapshot.retainedSecretBufferCount, 0);
  assert.equal(fixture.scheduler.size, 0);
});
