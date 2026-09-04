import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeNodeAdvertisement,
  encodeNodeAdvertisement
} from "../../shared/protocol/advertisement-v1.mjs";
import {
  BLUEZ_LE_ADVERTISEMENT_STATES,
  DbusNextLeAdvertisementPortV1
} from "../dist/bluez/DbusNextLeAdvertisementPort.js";

const DBUS_PATH = "/org/freedesktop/DBus";
const ADAPTER_PATH = "/org/bluez/hci0";

function payload({ reachable = false, sequence = 0 } = {}) {
  return encodeNodeAdvertisement({
    protocolVersion: 1,
    nodeKind: "raspberry",
    rotatingAlias: "001122334455",
    bootId: 23,
    capabilities: 0x48,
    serverReachable: reachable,
    sequence
  });
}

class FakeRetryScheduler {
  entries = new Set();
  set(handler) {
    this.entries.add(handler);
    return handler;
  }
  clear(handler) {
    this.entries.delete(handler);
  }
  run() {
    for (const handler of [...this.entries]) {
      this.entries.delete(handler);
      handler();
    }
  }
}

class FakeBus {
  listeners = new Set();
  exports = [];
  unexports = [];
  disconnected = false;
  ownerAvailable = true;
  addMatchCalls = 0;
  removeMatchCalls = 0;
  registerCalls = [];
  unregisterCalls = [];
  hangUnregister = false;

  dbus = {
    AddMatch: async () => { this.addMatchCalls += 1; },
    RemoveMatch: async () => { this.removeMatchCalls += 1; },
    NameHasOwner: async () => this.ownerAvailable
  };

  manager = {
    RegisterAdvertisement: async (path, options) => {
      this.registerCalls.push({ path, options });
    },
    UnregisterAdvertisement: async (path) => {
      this.unregisterCalls.push(path);
      if (this.hangUnregister) await new Promise(() => undefined);
    }
  };

  async getProxyObject(_name, path) {
    if (path === DBUS_PATH) {
      return { getInterface: () => this.dbus };
    }
    assert.equal(path, ADAPTER_PATH);
    return { getInterface: () => this.manager };
  }

  on(_event, listener) {
    this.listeners.add(listener);
    return this;
  }

  off(_event, listener) {
    this.listeners.delete(listener);
    return this;
  }

  export(path, serviceInterface) {
    this.exports.push({ path, serviceInterface });
  }

  unexport(path, serviceInterface) {
    this.unexports.push({ path, serviceInterface });
  }

  disconnect() {
    this.disconnected = true;
  }

  emitOwner(owner) {
    this.ownerAvailable = owner.length > 0;
    for (const listener of [...this.listeners]) {
      listener({
        path: DBUS_PATH,
        interface: "org.freedesktop.DBus",
        member: "NameOwnerChanged",
        body: ["org.bluez", owner.length > 0 ? "" : ":1.1", owner]
      });
    }
  }
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("D-Bus port registers exact ServiceData, replaces atomically and cleans up", async () => {
  const bus = new FakeBus();
  const port = new DbusNextLeAdvertisementPortV1({
    busFactory: () => bus,
    operationTimeoutMs: 100
  });
  let snapshot = await port.start({ adapterName: "hci0", payload: payload() });
  assert.equal(snapshot.state, BLUEZ_LE_ADVERTISEMENT_STATES.REGISTERED);
  assert.equal(snapshot.registered, true);
  assert.equal(bus.registerCalls.length, 1);
  const firstInterface = bus.exports.at(-1).serviceInterface;
  const firstServiceData = firstInterface.ServiceData;
  assert.deepEqual(Object.keys(firstServiceData), [
    "3c9734f1-46cb-5672-96e9-e7a03a710f95"
  ]);
  assert.equal(
    decodeNodeAdvertisement(Object.values(firstServiceData)[0].value).serverReachable,
    false
  );

  snapshot = await port.replace(payload({ reachable: true, sequence: 1 }));
  assert.equal(snapshot.registered, true);
  assert.equal(snapshot.replacementsTotal, 1);
  assert.equal(bus.unregisterCalls.length, 1);
  assert.equal(bus.registerCalls.length, 2);
  assert.equal(bus.unexports.length, 1);
  const secondInterface = bus.exports.at(-1).serviceInterface;
  assert.notEqual(secondInterface, firstInterface);
  assert.equal(
    decodeNodeAdvertisement(Object.values(secondInterface.ServiceData)[0].value)
      .serverReachable,
    true
  );

  snapshot = await port.stop();
  assert.equal(snapshot.state, BLUEZ_LE_ADVERTISEMENT_STATES.STOPPED);
  assert.equal(snapshot.registered, false);
  assert.equal(bus.unregisterCalls.length, 2);
  assert.equal(bus.removeMatchCalls, 1);
  assert.equal(bus.disconnected, true);
});

test("BlueZ owner loss is fail closed and recovery registers the latest payload", async () => {
  const bus = new FakeBus();
  const retries = new FakeRetryScheduler();
  const port = new DbusNextLeAdvertisementPortV1({
    busFactory: () => bus,
    retryScheduler: retries,
    retryDelaysMs: [0],
    operationTimeoutMs: 100
  });
  await port.start({ adapterName: "hci0", payload: payload() });
  bus.emitOwner("");
  await flush();
  assert.equal(port.snapshot().registered, false);
  assert.equal(port.snapshot().state, BLUEZ_LE_ADVERTISEMENT_STATES.RECOVERING);
  assert.equal(port.snapshot().ownerLossesTotal, 1);

  await port.replace(payload({ reachable: true, sequence: 1 }));
  assert.equal(port.snapshot().registered, false);
  assert.equal(bus.registerCalls.length, 1);
  bus.emitOwner(":1.2");
  await flush();
  assert.equal(port.snapshot().registered, true);
  assert.equal(bus.registerCalls.length, 2);
  const recovered = bus.exports.at(-1).serviceInterface;
  assert.equal(
    decodeNodeAdvertisement(Object.values(recovered.ServiceData)[0].value)
      .serverReachable,
    true
  );
  await port.stop();
});

test("unexpected BlueZ Release schedules a generation-safe recovery", async () => {
  const bus = new FakeBus();
  const retries = new FakeRetryScheduler();
  const port = new DbusNextLeAdvertisementPortV1({
    busFactory: () => bus,
    retryScheduler: retries,
    retryDelaysMs: [0],
    operationTimeoutMs: 100
  });
  await port.start({ adapterName: "hci0", payload: payload() });
  bus.exports.at(-1).serviceInterface.Release();
  await flush();
  assert.equal(port.snapshot().registered, false);
  assert.equal(port.snapshot().retryScheduled, true);
  retries.run();
  await flush();
  assert.equal(port.snapshot().registered, true);
  assert.equal(bus.registerCalls.length, 2);
  await port.stop();
});

test("replacement timeout disconnects the bus so stale true cannot remain", async () => {
  const bus = new FakeBus();
  const port = new DbusNextLeAdvertisementPortV1({
    busFactory: () => bus,
    operationTimeoutMs: 100
  });
  await port.start({
    adapterName: "hci0",
    payload: payload({ reachable: true })
  });
  bus.hangUnregister = true;
  await assert.rejects(
    () => port.replace(payload({ reachable: false, sequence: 1 })),
    /timed out/
  );
  assert.equal(port.snapshot().state, BLUEZ_LE_ADVERTISEMENT_STATES.FAILED);
  assert.equal(port.snapshot().registered, false);
  assert.equal(bus.disconnected, true);
  const serialized = JSON.stringify(port.snapshot());
  assert.equal(serialized.includes("001122334455"), false);
  assert.equal(serialized.includes("bootId"), false);
});
