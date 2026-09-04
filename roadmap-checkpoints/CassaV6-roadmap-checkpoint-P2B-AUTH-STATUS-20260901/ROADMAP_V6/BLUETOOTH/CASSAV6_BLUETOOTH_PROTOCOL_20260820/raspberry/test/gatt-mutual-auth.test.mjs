import assert from "node:assert/strict";
import {
  createHmac,
  generateKeyPairSync,
  sign,
  timingSafeEqual,
  verify
} from "node:crypto";
import test from "node:test";

import { CAPABILITY_BITS } from "../../shared/protocol/advertisement-v1.mjs";
import { decodeHelloV1, encodeHelloV1 } from "../../shared/protocol/hello-v1.mjs";
import {
  buildAuthFinishProofMessageV1,
  buildClientAuthProofMessageV1,
  buildServerAuthProofMessageV1,
  decodeAuthServerProofV1,
  encodeAuthClientProofV1,
  encodeAuthFinishV1
} from "../../shared/protocol/mutual-auth-v1.mjs";
import { MutualAuthHandshakeV1 } from "../dist/security/Handshake.js";
import {
  GattHelloExchangeError,
  GattHelloExchangeV1
} from "../dist/session/GattHelloExchangeV1.js";

const DEVICE = "/org/bluez/hci0/dev_00_11_22_33_44_55";
const CERTIFICATE_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const CLIENT_HELLO = Object.freeze({
  protocolVersion: 1,
  sessionId: "AbCdEfGhIjKlMnOpQrStUg",
  nodeId: "550e8400-e29b-41d4-a716-446655440000",
  bootId: 17,
  capabilities:
    CAPABILITY_BITS.SCAN |
    CAPABILITY_BITS.ADVERTISE |
    CAPABILITY_BITS.GATT_CLIENT |
    CAPABILITY_BITS.LOCAL_DURABILITY,
  nonce: "AAECAwQFBgcICQoLDA0ODw"
});
const SERVER_IDENTITY = Object.freeze({
  nodeId: "123e4567-e89b-12d3-a456-426614174000",
  bootId: 54,
  capabilities:
    CAPABILITY_BITS.GATT_SERVER | CAPABILITY_BITS.BACKEND_BRIDGE
});

function authFixture(options = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const aliasKey = Buffer.alloc(32, 0x6b);
  const registry = {
    async verifyAuthorizedDeviceSignature(input) {
      if (options.revoked) throw new Error("REVOKED_NODE");
      if (
        input.nodeId !== CLIENT_HELLO.nodeId ||
        input.certificateId !== CERTIFICATE_ID
      ) {
        throw new Error("PEER_BINDING_MISMATCH");
      }
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
  const exchange = new GattHelloExchangeV1({
    enabled: true,
    mutualAuthEnabled: true,
    handshake: new MutualAuthHandshakeV1(registry),
    identity: SERVER_IDENTITY,
    randomBytes: (length) =>
      Uint8Array.from({ length }, (_, index) => index + 0x20)
  });
  exchange.write({
    devicePath: DEVICE,
    mtu: 247,
    value: encodeHelloV1(CLIENT_HELLO)
  });
  const serverHello = decodeHelloV1(
    exchange.read({ devicePath: DEVICE, offset: 0 })
  );
  const binding = {
    clientHello: CLIENT_HELLO,
    serverHello,
    deviceCertificateId: CERTIFICATE_ID
  };
  return { exchange, privateKey, aliasKey, binding };
}

async function authenticate(fixture) {
  const clientMessage = buildClientAuthProofMessageV1(fixture.binding);
  const signature = sign(null, clientMessage, fixture.privateKey);
  const clientWire = encodeAuthClientProofV1({
    sessionId: CLIENT_HELLO.sessionId,
    deviceCertificateId: CERTIFICATE_ID,
    signature
  });
  const serverWire = await fixture.exchange.writeAuth({
    devicePath: DEVICE,
    value: clientWire
  });
  const server = decodeAuthServerProofV1(serverWire);
  const serverMessage = buildServerAuthProofMessageV1(
    fixture.binding,
    signature
  );
  assert.deepEqual(
    server.proof,
    createHmac("sha256", fixture.aliasKey).update(serverMessage).digest()
  );
  const finishMessage = buildAuthFinishProofMessageV1(
    fixture.binding,
    signature,
    server.proof
  );
  const finishProof = createHmac("sha256", fixture.aliasKey)
    .update(finishMessage)
    .digest();
  const finishWire = encodeAuthFinishV1({
    sessionId: CLIENT_HELLO.sessionId,
    proof: finishProof
  });
  await fixture.exchange.writeAuth({ devicePath: DEVICE, value: finishWire });
  return { clientWire, serverWire, finishWire };
}

function assertCode(code) {
  return (error) =>
    error instanceof GattHelloExchangeError && error.code === code;
}

test("HELLO owner reaches AUTHENTICATED only after all three bound proofs", async () => {
  const fixture = authFixture();
  const wires = await authenticate(fixture);
  const snapshot = fixture.exchange.snapshot();
  assert.equal(snapshot.authStartedTotal, 1);
  assert.equal(snapshot.clientProofsVerifiedTotal, 1);
  assert.equal(snapshot.serverProofsIssuedTotal, 1);
  assert.equal(snapshot.finishProofsVerifiedTotal, 1);
  assert.equal(snapshot.authenticatedSessionCount, 1);
  assert.equal(snapshot.authFailuresTotal, 0);

  await fixture.exchange.writeAuth({
    devicePath: DEVICE,
    value: wires.finishWire
  });
  assert.equal(fixture.exchange.snapshot().authDuplicateWritesTotal, 1);
});

test("client-proof retry is idempotent before finish while replay after finish fails closed", async () => {
  const fixture = authFixture();
  const clientMessage = buildClientAuthProofMessageV1(fixture.binding);
  const signature = sign(null, clientMessage, fixture.privateKey);
  const clientWire = encodeAuthClientProofV1({
    sessionId: CLIENT_HELLO.sessionId,
    deviceCertificateId: CERTIFICATE_ID,
    signature
  });
  const first = await fixture.exchange.writeAuth({
    devicePath: DEVICE,
    value: clientWire
  });
  const duplicate = await fixture.exchange.writeAuth({
    devicePath: DEVICE,
    value: clientWire
  });
  assert.deepEqual(duplicate, first);
  assert.equal(fixture.exchange.snapshot().authDuplicateWritesTotal, 1);

  const server = decodeAuthServerProofV1(first);
  const finishMessage = buildAuthFinishProofMessageV1(
    fixture.binding,
    signature,
    server.proof
  );
  const finishWire = encodeAuthFinishV1({
    sessionId: CLIENT_HELLO.sessionId,
    proof: createHmac("sha256", fixture.aliasKey)
      .update(finishMessage)
      .digest()
  });
  await fixture.exchange.writeAuth({ devicePath: DEVICE, value: finishWire });
  await assert.rejects(
    fixture.exchange.writeAuth({ devicePath: DEVICE, value: clientWire }),
    assertCode("AUTH_BINDING_CONFLICT")
  );
  assert.equal(fixture.exchange.snapshot().authenticatedSessionCount, 0);
  assert.equal(fixture.exchange.snapshot().authReplayRejectedTotal, 1);
});

test("invalid signature, peer certificate and revoked identity fail closed", async () => {
  for (const scenario of ["signature", "certificate", "revoked"]) {
    const fixture = authFixture({ revoked: scenario === "revoked" });
    const message = buildClientAuthProofMessageV1(fixture.binding);
    const signature = sign(null, message, fixture.privateKey);
    if (scenario === "signature") signature[0] ^= 0x01;
    const certificateId =
      scenario === "certificate"
        ? "123e4567-e89b-12d3-a456-426614174000"
        : CERTIFICATE_ID;
    const wire = encodeAuthClientProofV1({
      sessionId: CLIENT_HELLO.sessionId,
      deviceCertificateId: certificateId,
      signature
    });
    await assert.rejects(
      fixture.exchange.writeAuth({ devicePath: DEVICE, value: wire }),
      (error) =>
        error instanceof GattHelloExchangeError &&
        [
          "CLIENT_SIGNATURE_INVALID",
          "DEVICE_IDENTITY_REJECTED"
        ].includes(error.code)
    );
    const snapshot = fixture.exchange.snapshot();
    assert.equal(snapshot.authenticatedSessionCount, 0);
    assert.equal(snapshot.authFailuresTotal, 1);
    assert.equal(snapshot.failedExchangeCount, 1);
  }
});

test("mutual auth remains disabled and enforces its larger MTU independently", async () => {
  const disabled = new GattHelloExchangeV1({
    enabled: true,
    identity: SERVER_IDENTITY
  });
  await assert.rejects(
    disabled.writeAuth({ devicePath: DEVICE, value: Buffer.alloc(98) }),
    assertCode("AUTH_FEATURE_DISABLED")
  );

  const fixture = authFixture();
  const small = new GattHelloExchangeV1({
    enabled: true,
    mutualAuthEnabled: true,
    handshake: new MutualAuthHandshakeV1({
      async verifyAuthorizedDeviceSignature() {
        return true;
      },
      async createAuthorizedDeviceMac() {
        return Buffer.alloc(32);
      },
      async verifyAuthorizedDeviceMac() {
        return true;
      }
    }),
    identity: SERVER_IDENTITY
  });
  small.write({
    devicePath: DEVICE,
    mtu: 54,
    value: encodeHelloV1(CLIENT_HELLO)
  });
  small.read({ devicePath: DEVICE, offset: 0 });
  const signature = sign(
    null,
    buildClientAuthProofMessageV1(fixture.binding),
    fixture.privateKey
  );
  await assert.rejects(
    small.writeAuth({
      devicePath: DEVICE,
      value: encodeAuthClientProofV1({
        sessionId: CLIENT_HELLO.sessionId,
        deviceCertificateId: CERTIFICATE_ID,
        signature
      })
    }),
    assertCode("AUTH_MTU_TOO_SMALL")
  );
});
