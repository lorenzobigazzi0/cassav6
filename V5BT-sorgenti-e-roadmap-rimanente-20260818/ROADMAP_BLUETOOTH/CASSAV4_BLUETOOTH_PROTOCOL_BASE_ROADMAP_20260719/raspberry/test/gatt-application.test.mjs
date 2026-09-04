import assert from "node:assert/strict";
import test from "node:test";

import { DBusError, Variant } from "@jellybrick/dbus-next";

import { CAPABILITY_BITS } from "../../shared/protocol/advertisement-v1.mjs";
import {
  decodeHelloV1,
  encodeHelloV1
} from "../../shared/protocol/hello-v1.mjs";
import {
  decodeAuthServerProofV1,
  encodeAuthClientProofV1,
  encodeAuthFinishV1
} from "../../shared/protocol/mutual-auth-v1.mjs";

import {
  BLUEZ_GATT_CHARACTERISTIC_INTERFACE,
  BLUEZ_GATT_SERVICE_INTERFACE,
  DBUS_OBJECT_MANAGER_INTERFACE,
  GattApplication
} from "../dist/bluez/GattApplication.js";
import {
  CassaGattService,
  DEFAULT_GATT_APPLICATION_PATH
} from "../dist/gatt/CassaGattService.js";
import { MutualAuthHandshakeV1 } from "../dist/security/Handshake.js";
import { GattHelloExchangeV1 } from "../dist/session/GattHelloExchangeV1.js";

test("CASSA GATT application exports one exact service tree", () => {
  const service = new CassaGattService();
  const application = new GattApplication(service);
  const exports = application.exports();
  const objects = application.managedObjects();

  assert.equal(application.applicationPath, DEFAULT_GATT_APPLICATION_PATH);
  assert.equal(exports.length, 9);
  assert.equal(exports[0].path, DEFAULT_GATT_APPLICATION_PATH);
  assert.equal(exports[0].interface.$name, DBUS_OBJECT_MANAGER_INTERFACE);
  assert.equal(exports[1].path, service.servicePath);
  assert.equal(exports[1].interface.$name, BLUEZ_GATT_SERVICE_INTERFACE);
  assert.deepEqual(
    exports[0].interface
      .$introspect()
      .method.map(({ $ }) => $.name),
    ["GetManagedObjects"]
  );
  assert.deepEqual(
    exports[1].interface
      .$introspect()
      .property.map(({ $ }) => $.name),
    ["UUID", "Primary"]
  );
  assert.deepEqual(
    exports[2].interface
      .$introspect()
      .property.map(({ $ }) => $.name),
    ["UUID", "Service", "Flags", "Value", "Notifying"]
  );
  assert.deepEqual(
    exports[2].interface
      .$introspect()
      .method.map(({ $ }) => $.name),
    ["ReadValue", "WriteValue", "StartNotify", "StopNotify"]
  );
  assert.equal(Object.keys(objects).length, 8);
  assert.equal(
    objects[service.servicePath][BLUEZ_GATT_SERVICE_INTERFACE].UUID.value,
    service.uuid
  );
  assert.equal(
    objects[service.servicePath][BLUEZ_GATT_SERVICE_INTERFACE].Primary.value,
    true
  );

  for (const [index, characteristic] of service.characteristics.entries()) {
    const exported = exports[index + 2];
    assert.equal(exported.path, characteristic.path);
    assert.equal(
      exported.interface.$name,
      BLUEZ_GATT_CHARACTERISTIC_INTERFACE
    );
    const properties =
      objects[characteristic.path][BLUEZ_GATT_CHARACTERISTIC_INTERFACE];
    assert.equal(properties.UUID.value, characteristic.uuid);
    assert.equal(properties.Service.value, service.servicePath);
    assert.deepEqual(properties.Flags.value, characteristic.flags);
    assert.deepEqual(properties.Value.value, Buffer.alloc(0));
    assert.equal(properties.Notifying.value, false);
  }

  assert.equal(application.snapshot().managedObjectRequestsTotal, 0);
  assert.deepEqual(exports[0].interface.GetManagedObjects(), objects);
  assert.equal(application.snapshot().managedObjectRequestsTotal, 1);
  assert.deepEqual(application.snapshot().access, {
    readDeniedTotal: 0,
    writeDeniedTotal: 0,
    notifyDeniedTotal: 0
  });
});

test("all GATT data access remains fail-closed before the session adapter", () => {
  const application = new GattApplication();
  const characteristic = application.exports()[2].interface;
  const isNotAuthorized = (error) =>
    error instanceof DBusError &&
    error.type === "org.bluez.Error.NotAuthorized";

  assert.throws(() => characteristic.ReadValue({}), isNotAuthorized);
  assert.throws(
    () => characteristic.WriteValue(new Uint8Array([1, 2, 3]), {}),
    isNotAuthorized
  );
  assert.throws(() => characteristic.StartNotify(), isNotAuthorized);
  assert.throws(() => characteristic.StopNotify(), isNotAuthorized);

  assert.deepEqual(application.snapshot().access, {
    readDeniedTotal: 1,
    writeDeniedTotal: 1,
    notifyDeniedTotal: 2
  });
  assert.equal(
    JSON.stringify(application.snapshot()).includes("1,2,3"),
    false
  );
});

test("stopping control notifications resets every reliable transmitter", () => {
  const subscriptions = new Set();
  let resets = 0;
  const dataPlane = {
    enabled: true,
    setPublisher() {},
    setSubscription(transmitter, enabled) {
      if (enabled) subscriptions.add(transmitter);
      else subscriptions.delete(transmitter);
    },
    reset() {
      resets += 1;
      subscriptions.clear();
    },
    snapshot() {
      return {};
    }
  };
  const exchange = new GattHelloExchangeV1({
    enabled: true,
    mutualAuthEnabled: true,
    handshake: new MutualAuthHandshakeV1({
      async verifyAuthorizedDeviceSignature() {
        return true;
      },
      async createAuthorizedDeviceMac() {
        return Buffer.alloc(32, 0x41);
      },
      async verifyAuthorizedDeviceMac() {
        return true;
      }
    }),
    identity: {
      nodeId: "123e4567-e89b-12d3-a456-426614174000",
      bootId: 54,
      capabilities: CAPABILITY_BITS.GATT_SERVER
    }
  });
  const application = new GattApplication(
    new CassaGattService(),
    exchange,
    dataPlane
  );
  const controlTx = application.exports()[4].interface;
  const dataTx = application.exports()[6].interface;
  const ackTx = application.exports()[7].interface;

  controlTx.StartNotify();
  dataTx.StartNotify();
  ackTx.StartNotify();
  assert.equal(controlTx.Notifying, true);
  assert.equal(dataTx.Notifying, true);
  assert.equal(ackTx.Notifying, true);
  assert.deepEqual([...subscriptions].sort(), ["ackTx", "dataTx"]);

  controlTx.StopNotify();

  assert.equal(controlTx.Notifying, false);
  assert.equal(dataTx.Notifying, false);
  assert.equal(ackTx.Notifying, false);
  assert.equal(subscriptions.size, 0);
  assert.equal(resets, 1);
});

test("only HELLO read and write are opened by the dedicated B5.5 adapter", () => {
  const exchange = new GattHelloExchangeV1({
    enabled: true,
    identity: {
      nodeId: "123e4567-e89b-12d3-a456-426614174000",
      bootId: 54,
      capabilities: CAPABILITY_BITS.GATT_SERVER
    },
    randomBytes: (length) =>
      Uint8Array.from({ length }, (_, index) => index + 1)
  });
  const application = new GattApplication(new CassaGattService(), exchange);
  const hello = application.exports()[2].interface;
  const command = application.exports()[3].interface;
  const options = {
    device: new Variant(
      "o",
      "/org/bluez/hci0/dev_00_11_22_33_44_55"
    ),
    mtu: new Variant("q", 247),
    offset: new Variant("q", 0)
  };
  const request = {
    protocolVersion: 1,
    sessionId: "AbCdEfGhIjKlMnOpQrStUg",
    nodeId: "550e8400-e29b-41d4-a716-446655440000",
    bootId: 17,
    capabilities: CAPABILITY_BITS.GATT_CLIENT,
    nonce: "AAECAwQFBgcICQoLDA0ODw"
  };

  hello.WriteValue(encodeHelloV1(request), options);
  const response = decodeHelloV1(hello.ReadValue(options));
  assert.equal(response.sessionId, request.sessionId);
  assert.equal(
    response.nodeId,
    "123e4567-e89b-12d3-a456-426614174000"
  );
  assert.throws(
    () => command.WriteValue(Buffer.alloc(0), options),
    (error) =>
      error instanceof DBusError &&
      error.type === "org.bluez.Error.NotAuthorized"
  );
  assert.throws(
    () => command.ReadValue(options),
    (error) =>
      error instanceof DBusError &&
      error.type === "org.bluez.Error.NotAuthorized"
  );

  const snapshot = application.snapshot();
  assert.equal(snapshot.hello.helloExchangedTotal, 1);
  assert.equal(snapshot.hello.authenticatedSessionCount, 0);
  assert.equal(snapshot.access.writeDeniedTotal, 1);
  assert.equal(snapshot.access.readDeniedTotal, 1);
});

test("B5.6 opens only the bound mutual-auth control path", async () => {
  const serverProof = Buffer.alloc(32, 0x5a);
  const exchange = new GattHelloExchangeV1({
    enabled: true,
    mutualAuthEnabled: true,
    handshake: new MutualAuthHandshakeV1({
      async verifyAuthorizedDeviceSignature() {
        return true;
      },
      async createAuthorizedDeviceMac() {
        return Buffer.from(serverProof);
      },
      async verifyAuthorizedDeviceMac() {
        return true;
      }
    }),
    identity: {
      nodeId: "123e4567-e89b-12d3-a456-426614174000",
      bootId: 54,
      capabilities: CAPABILITY_BITS.GATT_SERVER
    },
    randomBytes: (length) => Buffer.alloc(length, 0x31)
  });
  const service = new CassaGattService();
  const application = new GattApplication(service, exchange);
  const hello = application.exports()[2].interface;
  const controlRx = application.exports()[3].interface;
  const controlTx = application.exports()[4].interface;
  const dataRx = application.exports()[5].interface;
  const options = {
    device: new Variant(
      "o",
      "/org/bluez/hci0/dev_00_11_22_33_44_55"
    ),
    mtu: new Variant("q", 247),
    offset: new Variant("q", 0)
  };
  const request = {
    protocolVersion: 1,
    sessionId: "AbCdEfGhIjKlMnOpQrStUg",
    nodeId: "550e8400-e29b-41d4-a716-446655440000",
    bootId: 17,
    capabilities: CAPABILITY_BITS.GATT_CLIENT,
    nonce: "AAECAwQFBgcICQoLDA0ODw"
  };

  hello.WriteValue(encodeHelloV1(request), options);
  hello.ReadValue(options);
  await assert.rejects(
    controlRx.WriteValue(Buffer.alloc(98), options),
    (error) =>
      error instanceof DBusError &&
      error.type === "org.bluez.Error.NotPermitted"
  );

  controlTx.StartNotify();
  assert.equal(controlTx.Notifying, true);
  const certificateId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  await controlRx.WriteValue(
    encodeAuthClientProofV1({
      sessionId: request.sessionId,
      deviceCertificateId: certificateId,
      signature: Buffer.alloc(64, 0x41)
    }),
    options
  );
  const response = decodeAuthServerProofV1(controlTx.Value);
  assert.equal(response.sessionId, request.sessionId);
  assert.equal(response.deviceCertificateId, certificateId);
  assert.deepEqual(response.proof, serverProof);

  await controlRx.WriteValue(
    encodeAuthFinishV1({
      sessionId: request.sessionId,
      proof: Buffer.alloc(32, 0x42)
    }),
    options
  );
  assert.equal(application.snapshot().hello.authenticatedSessionCount, 1);
  assert.throws(
    () => dataRx.WriteValue(Buffer.alloc(1), options),
    (error) =>
      error instanceof DBusError &&
      error.type === "org.bluez.Error.NotAuthorized"
  );
  assert.throws(
    () => controlTx.ReadValue(options),
    (error) =>
      error instanceof DBusError &&
      error.type === "org.bluez.Error.NotAuthorized"
  );

  const objects = application.managedObjects();
  const txProperties =
    objects[service.characteristics[2].path][
      BLUEZ_GATT_CHARACTERISTIC_INTERFACE
    ];
  assert.equal(txProperties.Notifying.value, true);
  assert.deepEqual(txProperties.Value.value, controlTx.Value);

  application.resetDirectSessions();
  assert.equal(controlTx.Notifying, false);
  assert.deepEqual(controlTx.Value, Buffer.alloc(0));
  assert.equal(application.snapshot().hello.activeExchangeCount, 0);
});

test("CASSA GATT service rejects non-canonical application paths", () => {
  for (const path of [
    "",
    "/",
    "com/cassav5bt/gatt",
    "/com/cassav5bt/gatt/",
    "/com/cassa-v5bt/gatt",
    "/com/cassav5bt/../gatt"
  ]) {
    assert.throws(
      () => new CassaGattService(path),
      /canonical D-Bus object path/
    );
  }
});
