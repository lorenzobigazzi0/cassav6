import assert from "node:assert/strict";
import test from "node:test";

import { CAPABILITY_BITS } from "../../shared/protocol/advertisement-v1.mjs";
import { encodeHelloV1 } from "../../shared/protocol/hello-v1.mjs";
import {
  BLUEZ_GATT_SERVER_STATES,
  BluezGattServerError
} from "../dist/bluez/BluezGattServerPort.js";
import { DbusNextGattServerPort } from "../dist/bluez/DbusNextGattServerPort.js";
import { GattApplication } from "../dist/bluez/GattApplication.js";
import { GattHelloExchangeV1 } from "../dist/session/GattHelloExchangeV1.js";

const DBUS_INTERFACE = "org.freedesktop.DBus";
const GATT_MANAGER_INTERFACE = "org.bluez.GattManager1";
const ADAPTER_PATH = "/org/bluez/hci0";

class FakeBus {
  listeners = new Set();
  matches = new Set();
  exports = new Map();
  ownerAvailable = true;
  disconnected = false;
  registerCalls = [];
  unregisterCalls = [];
  failRegisterCount = 0;
  failUnregisterCount = 0;

  dbusInterface = {
    AddMatch: async (rule) => {
      this.matches.add(rule);
    },
    RemoveMatch: async (rule) => {
      this.matches.delete(rule);
    },
    NameHasOwner: async (name) => {
      assert.equal(name, "org.bluez");
      return this.ownerAvailable;
    }
  };

  gattManagerInterface = {
    RegisterApplication: async (applicationPath, options) => {
      this.registerCalls.push({ applicationPath, options });
      assert.equal(this.exports.size, 9);
      if (this.failRegisterCount > 0) {
        this.failRegisterCount -= 1;
        const error = new Error("simulated GATT registration failure");
        error.code = "REGISTER_FAILED";
        throw error;
      }
    },
    UnregisterApplication: async (applicationPath) => {
      this.unregisterCalls.push(applicationPath);
      if (this.failUnregisterCount > 0) {
        this.failUnregisterCount -= 1;
        throw new Error("simulated GATT unregister failure");
      }
    }
  };

  async getProxyObject(name, path) {
    if (name === "org.freedesktop.DBus") {
      assert.equal(path, "/org/freedesktop/DBus");
      return {
        getInterface: (interfaceName) => {
          assert.equal(interfaceName, DBUS_INTERFACE);
          return this.dbusInterface;
        }
      };
    }
    assert.equal(name, "org.bluez");
    assert.equal(path, ADAPTER_PATH);
    return {
      getInterface: (interfaceName) => {
        assert.equal(interfaceName, GATT_MANAGER_INTERFACE);
        return this.gattManagerInterface;
      }
    };
  }

  on(eventName, listener) {
    assert.equal(eventName, "message");
    this.listeners.add(listener);
    return this;
  }

  off(eventName, listener) {
    assert.equal(eventName, "message");
    this.listeners.delete(listener);
    return this;
  }

  export(path, dbusInterface) {
    assert.equal(this.exports.has(path), false);
    this.exports.set(path, dbusInterface);
  }

  unexport(path, dbusInterface) {
    assert.equal(this.exports.get(path), dbusInterface);
    this.exports.delete(path);
  }

  disconnect() {
    this.disconnected = true;
  }

  emitOwner(available) {
    this.ownerAvailable = available;
    for (const listener of [...this.listeners]) {
      listener({
        path: "/org/freedesktop/DBus",
        interface: DBUS_INTERFACE,
        member: "NameOwnerChanged",
        body: [
          "org.bluez",
          available ? "" : ":1.20",
          available ? ":1.21" : ""
        ]
      });
    }
  }
}

class FakeRetryScheduler {
  nextId = 1;
  entries = new Map();

  set(handler, delayMs) {
    const id = this.nextId++;
    this.entries.set(id, { handler, delayMs });
    return id;
  }

  clear(handle) {
    this.entries.delete(handle);
  }

  get activeCount() {
    return this.entries.size;
  }

  get delays() {
    return [...this.entries.values()].map(({ delayMs }) => delayMs);
  }

  async runNext() {
    const next = this.entries.entries().next().value;
    assert.ok(next);
    const [id, entry] = next;
    this.entries.delete(id);
    entry.handler();
    await settle();
  }
}

function createPort(
  bus,
  scheduler = new FakeRetryScheduler(),
  application = undefined
) {
  return {
    port: new DbusNextGattServerPort({
      busFactory: () => bus,
      retryScheduler: scheduler,
      retryDelaysMs: [10, 20],
      application
    }),
    scheduler
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("GATT server registers once and releases every D-Bus resource", async () => {
  const bus = new FakeBus();
  const { port } = createPort(bus);

  let snapshot = await port.start({ adapterName: "hci0" });
  assert.equal(snapshot.state, BLUEZ_GATT_SERVER_STATES.REGISTERED);
  assert.equal(snapshot.registered, true);
  assert.equal(snapshot.applicationExported, true);
  assert.equal(snapshot.exportedInterfaceCount, 9);
  assert.equal(snapshot.activeMatchRules, 1);
  assert.equal(bus.registerCalls.length, 1);
  assert.deepEqual(bus.registerCalls[0].options, {});

  snapshot = await port.start({ adapterName: "hci0" });
  assert.equal(snapshot.registrationsTotal, 1);
  assert.equal(bus.registerCalls.length, 1);
  await assert.rejects(
    () => port.start({ adapterName: "hci1" }),
    (error) =>
      error instanceof BluezGattServerError &&
      error.code === "GATT_SERVER_ALREADY_RUNNING"
  );

  snapshot = await port.stop();
  assert.equal(snapshot.state, BLUEZ_GATT_SERVER_STATES.STOPPED);
  assert.equal(snapshot.busConnected, false);
  assert.equal(snapshot.applicationExported, false);
  assert.equal(snapshot.registered, false);
  assert.equal(snapshot.unregistersTotal, 1);
  assert.equal(bus.exports.size, 0);
  assert.equal(bus.matches.size, 0);
  assert.equal(bus.listeners.size, 0);
  assert.equal(bus.disconnected, true);

  await port.stop();
  assert.equal(bus.unregisterCalls.length, 1);
});

test("initial registration failure rolls back exports, match and bus", async () => {
  const bus = new FakeBus();
  bus.failRegisterCount = 1;
  const { port } = createPort(bus);

  await assert.rejects(
    () => port.start({ adapterName: "hci0" }),
    /simulated GATT registration failure/
  );
  const snapshot = port.snapshot();
  assert.equal(snapshot.state, BLUEZ_GATT_SERVER_STATES.FAILED);
  assert.equal(snapshot.desiredRunning, false);
  assert.equal(snapshot.busConnected, false);
  assert.equal(snapshot.applicationExported, false);
  assert.equal(snapshot.registered, false);
  assert.equal(snapshot.registrationFailuresTotal, 1);
  assert.equal(snapshot.errorsTotal, 1);
  assert.equal(snapshot.lastErrorCode, "REGISTER_FAILED");
  assert.equal(bus.exports.size, 0);
  assert.equal(bus.matches.size, 0);
  assert.equal(bus.listeners.size, 0);
  assert.equal(bus.disconnected, true);
});

test("GATT server re-registers after bluetoothd owner recovery", async () => {
  const bus = new FakeBus();
  const { port, scheduler } = createPort(bus);
  await port.start({ adapterName: "hci0" });

  bus.emitOwner(false);
  await settle();
  let snapshot = port.snapshot();
  assert.equal(snapshot.state, BLUEZ_GATT_SERVER_STATES.RECOVERING);
  assert.equal(snapshot.registered, false);
  assert.equal(snapshot.ownerLossesTotal, 1);
  assert.equal(bus.exports.size, 9);

  bus.failRegisterCount = 1;
  bus.emitOwner(true);
  await settle();
  snapshot = port.snapshot();
  assert.equal(snapshot.state, BLUEZ_GATT_SERVER_STATES.RECOVERING);
  assert.equal(snapshot.retryScheduled, true);
  assert.equal(snapshot.registrationFailuresTotal, 1);
  assert.deepEqual(scheduler.delays, [10]);

  await scheduler.runNext();
  snapshot = port.snapshot();
  assert.equal(snapshot.state, BLUEZ_GATT_SERVER_STATES.REGISTERED);
  assert.equal(snapshot.registered, true);
  assert.equal(snapshot.retryScheduled, false);
  assert.equal(snapshot.recoveryAttemptsTotal, 2);
  assert.equal(snapshot.recoverySuccessesTotal, 1);
  assert.equal(bus.registerCalls.length, 3);

  await port.stop();
});

test("BlueZ owner loss clears every pending HELLO binding", async () => {
  const bus = new FakeBus();
  const hello = new GattHelloExchangeV1({
    enabled: true,
    identity: {
      nodeId: "123e4567-e89b-12d3-a456-426614174000",
      bootId: 54,
      capabilities: CAPABILITY_BITS.GATT_SERVER
    },
    randomBytes: (length) =>
      Uint8Array.from({ length }, (_, index) => index + 1)
  });
  const application = new GattApplication(undefined, hello);
  const { port } = createPort(
    bus,
    new FakeRetryScheduler(),
    application
  );
  await port.start({ adapterName: "hci0" });
  hello.write({
    devicePath: "/org/bluez/hci0/dev_00_11_22_33_44_55",
    mtu: 247,
    value: encodeHelloV1({
      protocolVersion: 1,
      sessionId: "AbCdEfGhIjKlMnOpQrStUg",
      nodeId: "550e8400-e29b-41d4-a716-446655440000",
      bootId: 17,
      capabilities: CAPABILITY_BITS.GATT_CLIENT,
      nonce: "AAECAwQFBgcICQoLDA0ODw"
    })
  });
  assert.equal(application.snapshot().hello.activeExchangeCount, 1);

  bus.emitOwner(false);
  await settle();
  assert.equal(application.snapshot().hello.activeExchangeCount, 0);
  assert.equal(application.snapshot().hello.resetsTotal, 1);
  await port.stop();
});

test("stop cancels pending recovery and does not re-register", async () => {
  const bus = new FakeBus();
  const { port, scheduler } = createPort(bus);
  await port.start({ adapterName: "hci0" });
  bus.emitOwner(false);
  await settle();
  bus.failRegisterCount = 1;
  bus.emitOwner(true);
  await settle();
  assert.equal(scheduler.activeCount, 1);

  await port.stop();
  assert.equal(scheduler.activeCount, 0);
  assert.equal(port.snapshot().state, BLUEZ_GATT_SERVER_STATES.STOPPED);
  assert.equal(bus.registerCalls.length, 2);
});

test("invalid adapter and unavailable BlueZ fail before registration", async () => {
  const invalid = createPort(new FakeBus()).port;
  await assert.rejects(
    () => invalid.start({ adapterName: "../hci0" }),
    (error) =>
      error instanceof BluezGattServerError &&
      error.code === "INVALID_ADAPTER"
  );

  const bus = new FakeBus();
  bus.ownerAvailable = false;
  const { port } = createPort(bus);
  await assert.rejects(
    () => port.start({ adapterName: "hci0" }),
    (error) =>
      error instanceof BluezGattServerError &&
      error.code === "BLUEZ_UNAVAILABLE"
  );
  assert.equal(bus.registerCalls.length, 0);
  assert.equal(port.snapshot().state, BLUEZ_GATT_SERVER_STATES.FAILED);
  assert.equal(port.snapshot().busConnected, false);
});
