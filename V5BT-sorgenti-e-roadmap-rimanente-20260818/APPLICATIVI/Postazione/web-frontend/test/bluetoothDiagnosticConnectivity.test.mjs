import assert from "node:assert/strict";
import test from "node:test";
import {
  BLUETOOTH_CONNECTIVITY_EVENT,
  parseBluetoothConnectivitySnapshot,
  subscribeToBluetoothConnectivity,
} from "../src/bluetoothDiagnosticConnectivity.js";

const snapshot = (sequence = 0, state = "DISCOVERING") => ({
  schemaVersion: 1,
  source: "V5BT_ANDROID_CONNECTIVITY_AGENT",
  sequence,
  state,
});

class FakeWindow {
  listeners = new Map();

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name, listener) {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name, detail) {
    this.listeners.get(name)?.forEach((listener) => listener({ detail }));
  }
}

test("Bluetooth diagnostic parser accepts only the exact bounded redacted contract", () => {
  assert.deepEqual(
    parseBluetoothConnectivitySnapshot(
      JSON.stringify(snapshot(7, "PEER_CONNECTED")),
    ),
    snapshot(7, "PEER_CONNECTED"),
  );
  assert.deepEqual(
    parseBluetoothConnectivitySnapshot(snapshot(8, "DIRECT_SERVER")),
    snapshot(8, "DIRECT_SERVER"),
  );

  assert.equal(
    parseBluetoothConnectivitySnapshot({
      ...snapshot(),
      nodeId: "forbidden",
    }),
    null,
  );
  assert.equal(
    parseBluetoothConnectivitySnapshot({ ...snapshot(), source: "OTHER" }),
    null,
  );
  assert.equal(
    parseBluetoothConnectivitySnapshot({ ...snapshot(), schemaVersion: 2 }),
    null,
  );
  assert.equal(
    parseBluetoothConnectivitySnapshot({ ...snapshot(), sequence: -1 }),
    null,
  );
  assert.equal(
    parseBluetoothConnectivitySnapshot({
      ...snapshot(),
      sequence: Number.MAX_SAFE_INTEGER + 1,
    }),
    null,
  );
  assert.equal(
    parseBluetoothConnectivitySnapshot({ ...snapshot(), state: "ONLINE" }),
    null,
  );
  assert.equal(
    parseBluetoothConnectivitySnapshot(
      `{"padding":"${"x".repeat(513)}"}`,
    ),
    null,
  );
  assert.equal(
    parseBluetoothConnectivitySnapshot(
      new Proxy(snapshot(), {
        ownKeys: () => {
          throw new Error("hostile payload");
        },
      }),
    ),
    null,
  );
});

test("Bluetooth diagnostic subscription fails closed when the feature bridge is absent", () => {
  const target = new FakeWindow();
  const received = [];
  const unsubscribe = subscribeToBluetoothConnectivity(
    (value) => received.push(value),
    target,
  );

  assert.deepEqual(received, [null]);
  assert.equal(target.listeners.size, 0);
  unsubscribe();
});

test("Bluetooth diagnostic subscription fails closed without the native event surface", () => {
  const received = [];
  const target = {
    V5BTBluetoothState: {
      getState: () => JSON.stringify(snapshot()),
    },
  };
  const unsubscribe = subscribeToBluetoothConnectivity(
    (value) => received.push(value),
    target,
  );

  assert.deepEqual(received, [null]);
  unsubscribe();
});

test("Bluetooth diagnostic subscription handles events, stale sequence and cleanup", () => {
  const target = new FakeWindow();
  target.V5BTBluetoothState = {
    getState: () => JSON.stringify(snapshot(2, "DISCOVERING")),
  };
  const received = [];
  const unsubscribe = subscribeToBluetoothConnectivity(
    (value) => received.push(value),
    target,
  );

  assert.deepEqual(received, [snapshot(2, "DISCOVERING")]);
  target.dispatch(BLUETOOTH_CONNECTIVITY_EVENT, snapshot(1, "STOPPED"));
  assert.equal(received.length, 1);

  target.dispatch(BLUETOOTH_CONNECTIVITY_EVENT, snapshot(3, "DEGRADED"));
  assert.deepEqual(received.at(-1), snapshot(3, "DEGRADED"));

  target.dispatch(BLUETOOTH_CONNECTIVITY_EVENT, {
    ...snapshot(4),
    mac: "forbidden",
  });
  assert.equal(received.at(-1), null);

  unsubscribe();
  unsubscribe();
  assert.equal(target.listeners.get(BLUETOOTH_CONNECTIVITY_EVENT)?.size, 0);
  target.dispatch(BLUETOOTH_CONNECTIVITY_EVENT, snapshot(5, "PEER_CONNECTED"));
  assert.equal(received.at(-1), null);
});

test("Bluetooth diagnostic subscription hides bridge errors and malformed initial state", () => {
  const target = new FakeWindow();
  target.V5BTBluetoothState = {
    getState: () => {
      throw new Error("bridge unavailable");
    },
  };
  const received = [];
  const unsubscribe = subscribeToBluetoothConnectivity(
    (value) => received.push(value),
    target,
  );

  assert.deepEqual(received, [null]);
  unsubscribe();
});
