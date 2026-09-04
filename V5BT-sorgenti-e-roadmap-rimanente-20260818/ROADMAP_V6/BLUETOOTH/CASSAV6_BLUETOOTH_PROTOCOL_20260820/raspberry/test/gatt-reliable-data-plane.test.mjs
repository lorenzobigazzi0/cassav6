import assert from "node:assert/strict";
import test from "node:test";

import { RELIABLE_FRAME_TYPES } from "../dist/protocol/FrameCodec.js";
import {
  InMemoryReliableChannelStoreV1,
  ReliableChannelV1
} from "../dist/protocol/ReliableChannel.js";
import {
  GATT_RELIABLE_TRANSMITTERS,
  GattReliableDataPlaneError,
  GattReliableDataPlaneV1
} from "../dist/session/GattReliableDataPlaneV1.js";

const NOW = 1_800_000_000_000;
const CLIENT_TO_SERVER_KEY = Buffer.alloc(32, 0x61);
const SERVER_TO_CLIENT_KEY = Buffer.alloc(32, 0x62);
const CLIENT_TO_SERVER_NONCE = Buffer.from("0102030405060708", "hex");
const SERVER_TO_CLIENT_NONCE = Buffer.from("1112131415161718", "hex");
const PEER_TRUST_CLIENT = "a".repeat(64);
const PEER_TRUST_SERVER = "b".repeat(64);

function fakeHello(peerTrustId = PEER_TRUST_CLIENT) {
  return {
    directControlEnabled: true,
    reliableChannelContext() {
      return {
        peerTrustId:
          typeof peerTrustId === "function" ? peerTrustId() : peerTrustId,
        mtu: 23,
        material: {
          clientToServer: {
            key: Buffer.from(CLIENT_TO_SERVER_KEY),
            noncePrefix: Buffer.from(CLIENT_TO_SERVER_NONCE)
          },
          serverToClient: {
            key: Buffer.from(SERVER_TO_CLIENT_KEY),
            noncePrefix: Buffer.from(SERVER_TO_CLIENT_NONCE)
          }
        }
      };
    }
  };
}

test("authenticated GATT data plane carries DATA and ACK on separate transmitters", async () => {
  const clientToServer = [];
  const serverToClient = [];
  const clientDelivered = [];
  const serverDelivered = [];
  const client = new ReliableChannelV1({
    transport: {
      async send(frame) {
        clientToServer.push(Buffer.from(frame));
      }
    },
    store: new InMemoryReliableChannelStoreV1(),
    peerTrustId: PEER_TRUST_SERVER,
    mtu: 23,
    txKey: CLIENT_TO_SERVER_KEY,
    rxKey: SERVER_TO_CLIENT_KEY,
    txNoncePrefix: CLIENT_TO_SERVER_NONCE,
    rxNoncePrefix: SERVER_TO_CLIENT_NONCE,
    onMessage(message) {
      clientDelivered.push({
        type: message.type,
        payload: Buffer.from(message.payload)
      });
    },
    now: () => NOW,
    random: () => 0
  });
  const dataPlane = new GattReliableDataPlaneV1({
    enabled: true,
    helloExchange: fakeHello(),
    store: new InMemoryReliableChannelStoreV1(),
    async publish(output) {
      serverToClient.push({
        transmitter: output.transmitter,
        value: Buffer.from(output.value)
      });
    },
    onMessage(message) {
      serverDelivered.push({
        type: message.type,
        payload: Buffer.from(message.payload)
      });
    },
    now: () => NOW
  });
  dataPlane.setSubscription(GATT_RELIABLE_TRANSMITTERS.ACK, true);
  dataPlane.setSubscription(GATT_RELIABLE_TRANSMITTERS.DATA, true);

  await client.send({
    type: RELIABLE_FRAME_TYPES.DATA,
    payload: Buffer.from("client diagnostic"),
    messageId: "00112233445566778899aabbccddeeff"
  });
  for (const frame of clientToServer.splice(0)) {
    await dataPlane.receive("/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF", frame);
  }
  assert.deepEqual(serverDelivered, [
    {
      type: RELIABLE_FRAME_TYPES.DATA,
      payload: Buffer.from("client diagnostic")
    }
  ]);
  assert.ok(
    serverToClient.every(
      (entry) => entry.transmitter === GATT_RELIABLE_TRANSMITTERS.ACK
    )
  );
  for (const entry of serverToClient.splice(0)) {
    await client.receiveFragment(entry.value);
  }
  assert.equal(client.snapshot().pendingMessages, 0);

  await dataPlane.send({
    devicePath: "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF",
    type: RELIABLE_FRAME_TYPES.ROUTE_ADVERTISEMENT,
    payload: Buffer.from("server route")
  });
  assert.ok(
    serverToClient.every(
      (entry) => entry.transmitter === GATT_RELIABLE_TRANSMITTERS.DATA
    )
  );
  for (const entry of serverToClient.splice(0)) {
    await client.receiveFragment(entry.value);
  }
  assert.deepEqual(clientDelivered, [
    {
      type: RELIABLE_FRAME_TYPES.ROUTE_ADVERTISEMENT,
      payload: Buffer.from("server route")
    }
  ]);
  for (const frame of clientToServer.splice(0)) {
    await dataPlane.receive("/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF", frame);
  }
  assert.equal(dataPlane.snapshot().channel.pendingMessages, 0);
  assert.equal(dataPlane.snapshot().sessionBinds, 1);
  assert.equal(JSON.stringify(dataPlane.snapshot()).includes("dev_AA"), false);
  dataPlane.reset();
  client.close();
});

test("subscriptions, authorization and one-peer arbitration fail closed", async () => {
  const dataPlane = new GattReliableDataPlaneV1({
    enabled: true,
    helloExchange: fakeHello(),
    store: new InMemoryReliableChannelStoreV1(),
    publish() {},
    onMessage() {},
    now: () => NOW
  });
  await assert.rejects(
    () =>
      dataPlane.receive(
        "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF",
        Buffer.alloc(20)
      ),
    (error) =>
      error instanceof GattReliableDataPlaneError &&
      error.code === "ACK_SUBSCRIPTION_REQUIRED"
  );
  dataPlane.setSubscription(GATT_RELIABLE_TRANSMITTERS.ACK, true);
  dataPlane.setSubscription(GATT_RELIABLE_TRANSMITTERS.DATA, true);
  await dataPlane.send({
    devicePath: "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF",
    type: RELIABLE_FRAME_TYPES.DATA,
    payload: Buffer.from("bind")
  });
  await assert.rejects(
    () =>
      dataPlane.send({
        devicePath: "/org/bluez/hci0/dev_11_22_33_44_55_66",
        type: RELIABLE_FRAME_TYPES.DATA,
        payload: Buffer.from("conflict")
      }),
    (error) =>
      error instanceof GattReliableDataPlaneError &&
      error.code === "SESSION_ARBITRATION_CONFLICT"
  );
  dataPlane.reset();

  const disabled = new GattReliableDataPlaneV1({
    enabled: false,
    helloExchange: { directControlEnabled: false },
    store: new InMemoryReliableChannelStoreV1(),
    publish() {},
    onMessage() {}
  });
  await assert.rejects(
    () =>
      disabled.sendBound({
        type: RELIABLE_FRAME_TYPES.DATA,
        payload: Buffer.from("not-bound")
      }),
    (error) =>
      error instanceof GattReliableDataPlaneError &&
      error.code === "DATA_PLANE_DISABLED"
  );
  assert.throws(
    () => disabled.setSubscription(GATT_RELIABLE_TRANSMITTERS.DATA, true),
    (error) =>
      error instanceof GattReliableDataPlaneError &&
      error.code === "DATA_PLANE_DISABLED"
  );
});

test("authorization revalidation rejects a changed peer trust context", async () => {
  let peerTrustId = PEER_TRUST_CLIENT;
  const dataPlane = new GattReliableDataPlaneV1({
    enabled: true,
    helloExchange: fakeHello(() => peerTrustId),
    store: new InMemoryReliableChannelStoreV1(),
    publish() {},
    onMessage() {},
    now: () => NOW
  });
  dataPlane.setSubscription(GATT_RELIABLE_TRANSMITTERS.ACK, true);
  dataPlane.setSubscription(GATT_RELIABLE_TRANSMITTERS.DATA, true);
  const devicePath = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF";
  await dataPlane.send({
    devicePath,
    type: RELIABLE_FRAME_TYPES.DATA,
    payload: Buffer.from("bind")
  });
  peerTrustId = "c".repeat(64);
  await assert.rejects(
    () =>
      dataPlane.send({
        devicePath,
        type: RELIABLE_FRAME_TYPES.DATA,
        payload: Buffer.from("wrong peer")
      }),
    (error) =>
      error instanceof GattReliableDataPlaneError &&
      error.code === "PEER_TRUST_MISMATCH"
  );
  assert.equal(dataPlane.snapshot().bound, false);
});
