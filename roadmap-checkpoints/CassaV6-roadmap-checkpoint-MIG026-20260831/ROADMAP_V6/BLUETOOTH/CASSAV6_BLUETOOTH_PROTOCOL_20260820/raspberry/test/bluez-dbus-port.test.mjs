import assert from "node:assert/strict";
import test from "node:test";

import { GATT_SERVICE_UUID } from "../../shared/protocol/advertisement-v1.mjs";
import {
  BluezDbusProtocolError,
  decodeBluezDevicePropertyPatch
} from "../dist/bluez/BluezDbusPort.js";
import { DbusNextBluezPort } from "../dist/bluez/DbusNextBluezPort.js";

const DBUS_INTERFACE = "org.freedesktop.DBus";
const OBJECT_MANAGER_INTERFACE = "org.freedesktop.DBus.ObjectManager";
const PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";
const ADAPTER_INTERFACE = "org.bluez.Adapter1";
const DEVICE_INTERFACE = "org.bluez.Device1";
const ADAPTER_PATH = "/org/bluez/hci0";

function variant(signature, value) {
  return { signature, value };
}

class FakeBus {
  listeners = new Set();
  matches = new Set();
  disconnected = false;
  ownerAvailable = true;
  powered = true;
  adapterPresent = true;
  startCalls = 0;
  stopCalls = 0;
  discoveryFilter = null;

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

  objectManagerInterface = {
    GetManagedObjects: async () =>
      this.adapterPresent
        ? {
            [ADAPTER_PATH]: {
              [ADAPTER_INTERFACE]: {}
            }
          }
        : {}
  };

  adapterInterface = {
    SetDiscoveryFilter: async (filter) => {
      this.discoveryFilter = filter;
    },
    StartDiscovery: async () => {
      this.startCalls += 1;
    },
    StopDiscovery: async () => {
      this.stopCalls += 1;
    }
  };

  propertiesInterface = {
    GetAll: async (interfaceName) => {
      assert.equal(interfaceName, ADAPTER_INTERFACE);
      return {
        Powered: variant("b", this.powered)
      };
    }
  };

  async getProxyObject(name, path) {
    if (name === "org.freedesktop.DBus" && path === "/org/freedesktop/DBus") {
      return {
        getInterface: (interfaceName) => {
          assert.equal(interfaceName, DBUS_INTERFACE);
          return this.dbusInterface;
        }
      };
    }
    assert.equal(name, "org.bluez");
    if (path === "/") {
      return {
        getInterface: (interfaceName) => {
          assert.equal(interfaceName, OBJECT_MANAGER_INTERFACE);
          return this.objectManagerInterface;
        }
      };
    }
    assert.equal(path, ADAPTER_PATH);
    return {
      getInterface: (interfaceName) => {
        if (interfaceName === ADAPTER_INTERFACE) {
          return this.adapterInterface;
        }
        assert.equal(interfaceName, PROPERTIES_INTERFACE);
        return this.propertiesInterface;
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

  disconnect() {
    this.disconnected = true;
  }

  emit(message) {
    for (const listener of [...this.listeners]) {
      listener(message);
    }
  }
}

function createPort(bus) {
  return new DbusNextBluezPort({
    busFactory: () => bus,
    variantFactory: variant
  });
}

test("D-Bus port configures LE discovery and normalizes BlueZ signals", async () => {
  const bus = new FakeBus();
  const updates = [];
  const removed = [];
  const owners = [];
  const errors = [];
  const port = createPort(bus);

  await port.connect({
    onOwnerChanged: (available) => owners.push(available),
    onDeviceUpdate: (patch) => updates.push(patch),
    onDeviceRemoved: (path) => removed.push(path),
    onError: (error) => errors.push(error)
  });
  await port.openDiscovery({
    adapterPath: ADAPTER_PATH,
    serviceUuid: GATT_SERVICE_UUID
  });

  assert.equal(bus.startCalls, 1);
  assert.equal(bus.matches.size, 4);
  assert.deepEqual(bus.discoveryFilter, {
    Transport: variant("s", "le"),
    DuplicateData: variant("b", true)
  });
  assert.equal(
    Object.hasOwn(bus.discoveryFilter, "UUIDs"),
    false,
    "service-data-only advertisements must not be hidden by BlueZ UUID filtering"
  );

  const objectPath = `${ADAPTER_PATH}/dev_PRIVATE`;
  bus.emit({
    path: "/",
    interface: OBJECT_MANAGER_INTERFACE,
    member: "InterfacesAdded",
    body: [
      objectPath,
      {
        [DEVICE_INTERFACE]: {
          RSSI: variant("n", -49),
          ServiceData: variant("a{sv}", {
            [GATT_SERVICE_UUID.toUpperCase()]: variant(
              "ay",
              Buffer.from([1, 2, 3])
            )
          })
        }
      }
    ]
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].rssiDbm, -49);
  assert.deepEqual(
    updates[0].serviceData.get(GATT_SERVICE_UUID),
    new Uint8Array([1, 2, 3])
  );

  bus.emit({
    path: objectPath,
    interface: PROPERTIES_INTERFACE,
    member: "PropertiesChanged",
    body: [
      DEVICE_INTERFACE,
      { RSSI: variant("n", -50) },
      ["ServiceData"]
    ]
  });
  assert.equal(updates.length, 2);
  assert.equal(updates[1].rssiDbm, -50);
  assert.equal(updates[1].serviceData, null);

  bus.emit({
    path: "/",
    interface: OBJECT_MANAGER_INTERFACE,
    member: "InterfacesRemoved",
    body: [objectPath, [DEVICE_INTERFACE]]
  });
  assert.deepEqual(removed, [objectPath]);
  assert.equal(errors.length, 0);

  bus.emit({
    path: "/org/freedesktop/DBus",
    interface: DBUS_INTERFACE,
    member: "NameOwnerChanged",
    body: [":1.99", ":1.99", ""]
  });
  assert.deepEqual(owners, []);
  assert.equal(errors.length, 0);

  bus.ownerAvailable = false;
  bus.emit({
    path: "/org/freedesktop/DBus",
    interface: DBUS_INTERFACE,
    member: "NameOwnerChanged",
    body: ["org.bluez", ":1.10", ""]
  });
  assert.deepEqual(owners, [false]);
  assert.equal(port.snapshot().discoverySessionAcquired, false);

  bus.ownerAvailable = true;
  bus.emit({
    path: "/org/freedesktop/DBus",
    interface: DBUS_INTERFACE,
    member: "NameOwnerChanged",
    body: ["org.bluez", "", ":1.11"]
  });
  assert.deepEqual(owners, [false, true]);
  await port.openDiscovery({
    adapterPath: ADAPTER_PATH,
    serviceUuid: GATT_SERVICE_UUID
  });
  assert.equal(bus.startCalls, 2);

  await port.closeDiscovery();
  assert.equal(bus.stopCalls, 1);
  assert.equal(bus.matches.size, 1);
  await port.disconnect();
  assert.equal(bus.matches.size, 0);
  assert.equal(bus.listeners.size, 0);
  assert.equal(bus.disconnected, true);
});

test("D-Bus port fails closed for missing and unpowered adapters", async () => {
  const missingBus = new FakeBus();
  missingBus.adapterPresent = false;
  const missingPort = createPort(missingBus);
  await missingPort.connect({
    onOwnerChanged: () => {},
    onDeviceUpdate: () => {},
    onDeviceRemoved: () => {},
    onError: () => {}
  });
  await assert.rejects(
    () =>
      missingPort.openDiscovery({
        adapterPath: ADAPTER_PATH,
        serviceUuid: GATT_SERVICE_UUID
      }),
    (error) =>
      error instanceof BluezDbusProtocolError &&
      error.code === "BLUEZ_ADAPTER_NOT_FOUND"
  );
  await missingPort.disconnect();

  const unpoweredBus = new FakeBus();
  unpoweredBus.powered = false;
  const unpoweredPort = createPort(unpoweredBus);
  await unpoweredPort.connect({
    onOwnerChanged: () => {},
    onDeviceUpdate: () => {},
    onDeviceRemoved: () => {},
    onError: () => {}
  });
  await assert.rejects(
    () =>
      unpoweredPort.openDiscovery({
        adapterPath: ADAPTER_PATH,
        serviceUuid: GATT_SERVICE_UUID
      }),
    (error) =>
      error instanceof BluezDbusProtocolError &&
      error.code === "BLUEZ_ADAPTER_NOT_POWERED"
  );
  await unpoweredPort.disconnect();
});

test("property decoder copies bytes and applies invalidation explicitly", () => {
  const source = Buffer.from([7, 8, 9]);
  const patch = decodeBluezDevicePropertyPatch({
    objectPath: `${ADAPTER_PATH}/dev_PRIVATE`,
    changedProperties: {
      RSSI: variant("n", -60),
      ServiceData: variant("a{sv}", {
        [GATT_SERVICE_UUID.toUpperCase()]: variant("ay", source)
      })
    },
    invalidatedProperties: []
  });
  source[0] = 0;

  assert.equal(patch.rssiDbm, -60);
  assert.deepEqual(
    patch.serviceData.get(GATT_SERVICE_UUID),
    new Uint8Array([7, 8, 9])
  );

  const invalidated = decodeBluezDevicePropertyPatch({
    objectPath: `${ADAPTER_PATH}/dev_PRIVATE`,
    changedProperties: {},
    invalidatedProperties: ["RSSI", "ServiceData"]
  });
  assert.equal(invalidated.rssiDbm, null);
  assert.equal(invalidated.serviceData, null);

  assert.throws(
    () =>
      decodeBluezDevicePropertyPatch({
        objectPath: `${ADAPTER_PATH}/dev_PRIVATE`,
        changedProperties: {
          RSSI: variant("n", "invalid")
        }
      }),
    /RSSI is not a valid/
  );
});
