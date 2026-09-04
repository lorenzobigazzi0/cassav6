import assert from "node:assert/strict";
import test from "node:test";

import {
  GATT_SERVICE_UUID,
  encodeNodeAdvertisement
} from "../../shared/protocol/advertisement-v1.mjs";
import { BluezAdapter } from "../dist/bluez/BluezAdapter.js";

class FakeDbusPort {
  handlers = null;
  connected = false;
  ownerAvailable = true;
  acquired = false;
  openCalls = [];
  closeCalls = 0;
  disconnectCalls = 0;
  failOpenCount = 0;

  async connect(handlers) {
    if (this.connected && this.handlers !== handlers) {
      throw new Error("already connected");
    }
    this.connected = true;
    this.handlers = handlers;
  }

  async openDiscovery(input) {
    this.openCalls.push(input);
    if (this.failOpenCount > 0) {
      this.failOpenCount -= 1;
      throw new Error("simulated discovery failure");
    }
    if (!this.ownerAvailable) {
      throw new Error("BlueZ unavailable");
    }
    this.acquired = true;
  }

  async closeDiscovery() {
    this.closeCalls += 1;
    this.acquired = false;
  }

  async disconnect() {
    this.disconnectCalls += 1;
    this.connected = false;
    this.acquired = false;
    this.handlers = null;
  }

  emitUpdate(patch) {
    this.handlers?.onDeviceUpdate(patch);
  }

  removeDevice(objectPath) {
    this.handlers?.onDeviceRemoved(objectPath);
  }

  async changeOwner(available) {
    this.ownerAvailable = available;
    if (!available) {
      this.acquired = false;
    }
    await this.handlers?.onOwnerChanged(available);
  }

  snapshot() {
    return Object.freeze({
      transport: "fake-dbus",
      busConnected: this.connected,
      bluezOwnerAvailable: this.ownerAvailable,
      discoverySessionAcquired: this.acquired,
      activeMatchRules: this.connected ? 1 : 0,
      signalsTotal: 0,
      deviceUpdatesTotal: 0,
      ownerChangesTotal: 0,
      errorsTotal: 0,
      lastErrorCategory: null,
      lastErrorCode: null,
      startDiscoveryCallsTotal: this.openCalls.length,
      stopDiscoveryCallsTotal: this.closeCalls
    });
  }
}

class FakeTimeouts {
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
    return [...this.entries.values()].map((entry) => entry.delayMs);
  }

  async runNext() {
    const next = this.entries.entries().next().value;
    assert.ok(next);
    const [id, entry] = next;
    this.entries.delete(id);
    entry.handler();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function payload(sequence = 1) {
  return encodeNodeAdvertisement({
    protocolVersion: 1,
    nodeKind: "handheld",
    rotatingAlias: "010203040506",
    bootId: 7,
    capabilities: 0x1f,
    serverReachable: true,
    sequence
  });
}

test("adapter merges ServiceData and RSSI without exposing foreign UUIDs", async () => {
  const dbusPort = new FakeDbusPort();
  const observations = [];
  const adapter = new BluezAdapter("hci0", { dbusPort });
  const objectPath = "/org/bluez/hci0/dev_PRIVATE";

  await adapter.startDiscovery((observation) => {
    observations.push(observation);
  });

  assert.deepEqual(dbusPort.openCalls, [
    {
      adapterPath: "/org/bluez/hci0",
      serviceUuid: GATT_SERVICE_UUID
    }
  ]);

  dbusPort.emitUpdate({
    objectPath,
    serviceData: new Map([[GATT_SERVICE_UUID.toUpperCase(), payload()]])
  });
  assert.equal(observations.length, 0);

  dbusPort.emitUpdate({ objectPath, rssiDbm: -51 });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].serviceUuid, GATT_SERVICE_UUID);
  assert.equal(observations[0].rssiDbm, -51);
  assert.deepEqual(observations[0].payload, payload());

  dbusPort.emitUpdate({
    objectPath,
    serviceData: new Map([
      ["00000000-0000-0000-0000-000000000000", new Uint8Array([1])]
    ])
  });
  dbusPort.emitUpdate({ objectPath, rssiDbm: -52 });
  assert.equal(observations.length, 1);

  dbusPort.emitUpdate({
    objectPath,
    serviceData: new Map([[GATT_SERVICE_UUID, payload(2)]])
  });
  assert.equal(observations.length, 2);
  assert.deepEqual(observations[1].payload, payload(2));

  dbusPort.emitUpdate({ objectPath, serviceData: null });
  dbusPort.emitUpdate({ objectPath, rssiDbm: -53 });
  assert.equal(observations.length, 2);

  dbusPort.removeDevice(objectPath);
  assert.equal(adapter.snapshot().trackedDevices, 0);

  await adapter.stopDiscovery();
  assert.equal(dbusPort.closeCalls, 1);
  assert.equal(dbusPort.disconnectCalls, 1);
  assert.equal(adapter.snapshot().observationHandlerAttached, false);
});

test("adapter recovers discovery after bluetoothd restart and clears stale device state", async () => {
  const dbusPort = new FakeDbusPort();
  const timeouts = new FakeTimeouts();
  const observations = [];
  const adapter = new BluezAdapter("hci0", {
    dbusPort,
    retryScheduler: timeouts,
    retryDelaysMs: [25, 50]
  });
  const objectPath = "/org/bluez/hci0/dev_PRIVATE";

  await adapter.startDiscovery((observation) => {
    observations.push(observation);
  });
  dbusPort.emitUpdate({
    objectPath,
    rssiDbm: -45,
    serviceData: new Map([[GATT_SERVICE_UUID, payload()]])
  });
  assert.equal(observations.length, 1);

  await dbusPort.changeOwner(false);
  let snapshot = adapter.snapshot();
  assert.equal(snapshot.discovering, false);
  assert.equal(snapshot.recovering, true);
  assert.equal(snapshot.trackedDevices, 0);

  dbusPort.failOpenCount = 1;
  await dbusPort.changeOwner(true);
  snapshot = adapter.snapshot();
  assert.equal(snapshot.retryScheduled, true);
  assert.deepEqual(timeouts.delays, [25]);
  assert.equal(snapshot.reconnectAttemptsTotal, 1);

  await timeouts.runNext();
  snapshot = adapter.snapshot();
  assert.equal(snapshot.discovering, true);
  assert.equal(snapshot.recovering, false);
  assert.equal(snapshot.reconnectAttemptsTotal, 2);
  assert.equal(snapshot.reconnectSuccessesTotal, 1);
  assert.equal(dbusPort.openCalls.length, 3);

  dbusPort.emitUpdate({ objectPath, rssiDbm: -46 });
  assert.equal(observations.length, 1);
  dbusPort.emitUpdate({
    objectPath,
    serviceData: new Map([[GATT_SERVICE_UUID, payload(2)]])
  });
  assert.equal(observations.length, 2);

  await adapter.stopDiscovery();
  assert.equal(timeouts.activeCount, 0);
});

test("stop cancels a pending recovery and remains idempotent", async () => {
  const dbusPort = new FakeDbusPort();
  const timeouts = new FakeTimeouts();
  const adapter = new BluezAdapter("hci0", {
    dbusPort,
    retryScheduler: timeouts,
    retryDelaysMs: [10]
  });

  await adapter.startDiscovery(() => {});
  await dbusPort.changeOwner(false);
  dbusPort.failOpenCount = 1;
  await dbusPort.changeOwner(true);
  assert.equal(timeouts.activeCount, 1);

  await adapter.stopDiscovery();
  await adapter.stopDiscovery();
  assert.equal(timeouts.activeCount, 0);
  assert.equal(dbusPort.disconnectCalls, 1);
  assert.equal(adapter.snapshot().retryScheduled, false);
});

test("startup failure disconnects D-Bus and detaches the handler", async () => {
  const dbusPort = new FakeDbusPort();
  dbusPort.failOpenCount = 1;
  const adapter = new BluezAdapter("hci0", { dbusPort });

  await assert.rejects(
    () => adapter.startDiscovery(() => {}),
    /simulated discovery failure/
  );
  const snapshot = adapter.snapshot();
  assert.equal(snapshot.discovering, false);
  assert.equal(snapshot.observationHandlerAttached, false);
  assert.equal(snapshot.dbus.busConnected, false);
  assert.equal(dbusPort.disconnectCalls, 1);
});

test("adapter validates adapter names and handler ownership", async () => {
  assert.throws(
    () => new BluezAdapter("../hci0"),
    /adapterName must match/
  );

  const dbusPort = new FakeDbusPort();
  const adapter = new BluezAdapter("hci0", { dbusPort });
  const firstHandler = () => {};
  await adapter.startDiscovery(firstHandler);
  await adapter.startDiscovery(firstHandler);
  await assert.rejects(
    () => adapter.startDiscovery(() => {}),
    /different observation handler/
  );
  await adapter.stopDiscovery();
});
