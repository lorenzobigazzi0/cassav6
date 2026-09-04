import assert from "node:assert/strict";
import test from "node:test";

import {
  GATT_SERVICE_UUID,
  encodeNodeAdvertisement
} from "../../shared/protocol/advertisement-v1.mjs";
import { loadBluezNodeConfig } from "../dist/config/NodeConfig.js";
import { PeerRegistry } from "../dist/discovery/PeerRegistry.js";
import {
  BLUEZ_NODE_STATES,
  BluezNode
} from "../dist/node/BluezNode.js";

function config(overrides = {}) {
  return Object.freeze({
    enabled: true,
    dryRun: false,
    gattServerEnabled: false,
    helloExchangeEnabled: false,
    mutualAuthEnabled: false,
    directControlEnabled: false,
    reliableChannelEnabled: false,
    routeAdvertisementEnabled: false,
    commandBusShadowEnabled: false,
    deviceRegistryPath: "/var/lib/cassav5bt-bluetooth/devices.json",
    transportStorePath: "/var/lib/cassav5bt-bluetooth/transport.sqlite",
    backendHealthUrl: "http://127.0.0.1:5381/api/health",
    helloBootId: 1,
    helloCapabilities: 8,
    adapterName: "hci0",
    nodeId: "raspberry-main",
    storeId: "store-1",
    maintenanceIntervalMs: 1_000,
    metricsIntervalMs: 10_000,
    transportTickIntervalMs: 250,
    backendHealthIntervalMs: 3_000,
    ...overrides
  });
}

class FakeBluezAdapter {
  adapterName = "hci0";
  handler = null;
  startCalls = 0;
  stopCalls = 0;
  failStart = false;

  async startDiscovery(handler) {
    this.startCalls += 1;
    if (this.failStart) {
      throw new Error("simulated BlueZ start failure");
    }
    assert.equal(this.handler, null);
    this.handler = handler;
  }

  async stopDiscovery() {
    this.stopCalls += 1;
    this.handler = null;
  }

  emit(observation) {
    this.handler?.(observation);
  }

  snapshot() {
    return Object.freeze({
      adapterName: this.adapterName,
      transport: "fake",
      discovering: this.handler !== null,
      observationHandlerAttached: this.handler !== null
    });
  }
}

class FakeIntervals {
  nextId = 1;
  handlers = new Map();

  set(handler) {
    const id = this.nextId++;
    this.handlers.set(id, handler);
    return id;
  }

  clear(handle) {
    this.handlers.delete(handle);
  }

  runAll() {
    for (const handler of [...this.handlers.values()]) {
      handler();
    }
  }

  get activeCount() {
    return this.handlers.size;
  }
}

class FakeGattServer {
  startCalls = [];
  stopCalls = 0;
  failStart = false;
  failStop = false;
  running = false;

  async start(input) {
    this.startCalls.push(input);
    if (this.failStart) {
      throw new Error("simulated GATT start failure");
    }
    this.running = true;
    return this.snapshot();
  }

  async stop() {
    this.stopCalls += 1;
    this.running = false;
    if (this.failStop) {
      throw new Error("simulated GATT stop failure");
    }
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      state: this.running ? "REGISTERED" : "STOPPED",
      registered: this.running
    });
  }
}

test("configuration is disabled and dry-run by default", () => {
  const result = loadBluezNodeConfig({});
  assert.equal(result.enabled, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.gattServerEnabled, false);
  assert.equal(result.helloExchangeEnabled, false);
  assert.equal(result.mutualAuthEnabled, false);
  assert.equal(result.directControlEnabled, false);
  assert.equal(result.reliableChannelEnabled, false);
  assert.equal(result.routeAdvertisementEnabled, false);
  assert.equal(result.commandBusShadowEnabled, false);
  assert.equal(
    result.deviceRegistryPath,
    "/var/lib/cassav5bt-bluetooth/devices.json"
  );
  assert.equal(result.adapterName, "hci0");
  assert.equal(
    result.transportStorePath,
    "/var/lib/cassav5bt-bluetooth/transport.sqlite"
  );
  assert.equal(result.backendHealthUrl, "http://127.0.0.1:5381/api/health");
  assert.equal(result.metricsIntervalMs, 10_000);
});

test("configuration rejects ambiguous flags and unsafe adapter names", () => {
  assert.throws(
    () => loadBluezNodeConfig({ CASSA_BT_FEATURE_ENABLED: "true" }),
    /must be exactly 0 or 1/
  );
  assert.throws(
    () =>
      loadBluezNodeConfig({
        CASSA_BT_FEATURE_ENABLED: "1",
        CASSA_BT_GATT_SERVER_ENABLED: "1",
        CASSA_BT_HELLO_ENABLED: "1"
      }),
    /canonical lowercase UUID/
  );
  assert.throws(
    () =>
      loadBluezNodeConfig({
        CASSA_BT_FEATURE_ENABLED: "1",
        CASSA_BT_GATT_SERVER_ENABLED: "1",
        CASSA_BT_HELLO_ENABLED: "1",
        CASSA_BT_NODE_ID: "123e4567-e89b-12d3-a456-426614174000",
        CASSA_BT_HELLO_CAPABILITIES: "64"
      }),
    /GATT_SERVER/
  );
  const hello = loadBluezNodeConfig({
    CASSA_BT_FEATURE_ENABLED: "1",
    CASSA_BT_GATT_SERVER_ENABLED: "1",
    CASSA_BT_HELLO_ENABLED: "1",
    CASSA_BT_NODE_ID: "123e4567-e89b-12d3-a456-426614174000",
    CASSA_BT_HELLO_BOOT_ID: "54",
    CASSA_BT_HELLO_CAPABILITIES: "72"
  });
  assert.equal(hello.helloExchangeEnabled, true);
  assert.equal(hello.helloBootId, 54);
  assert.equal(hello.helloCapabilities, 72);
  const mutualAuth = loadBluezNodeConfig({
    CASSA_BT_FEATURE_ENABLED: "1",
    CASSA_BT_GATT_SERVER_ENABLED: "1",
    CASSA_BT_HELLO_ENABLED: "1",
    CASSA_BT_MUTUAL_AUTH_ENABLED: "1",
    CASSA_BT_NODE_ID: "123e4567-e89b-12d3-a456-426614174000",
    CASSA_BT_DEVICE_REGISTRY_PATH: "/srv/cassav5bt/devices.json"
  });
  assert.equal(mutualAuth.mutualAuthEnabled, true);
  assert.equal(mutualAuth.directControlEnabled, false);
  assert.equal(
    mutualAuth.deviceRegistryPath,
    "/srv/cassav5bt/devices.json"
  );
  const directControl = loadBluezNodeConfig({
    CASSA_BT_FEATURE_ENABLED: "1",
    CASSA_BT_GATT_SERVER_ENABLED: "1",
    CASSA_BT_HELLO_ENABLED: "1",
    CASSA_BT_MUTUAL_AUTH_ENABLED: "1",
    CASSA_BT_DIRECT_CONTROL_ENABLED: "1",
    CASSA_BT_NODE_ID: "123e4567-e89b-12d3-a456-426614174000"
  });
  assert.equal(directControl.directControlEnabled, true);
  const reliable = loadBluezNodeConfig({
    CASSA_BT_FEATURE_ENABLED: "1",
    CASSA_BT_GATT_SERVER_ENABLED: "1",
    CASSA_BT_HELLO_ENABLED: "1",
    CASSA_BT_MUTUAL_AUTH_ENABLED: "1",
    CASSA_BT_DIRECT_CONTROL_ENABLED: "1",
    CASSA_BT_RELIABLE_CHANNEL_ENABLED: "1",
    CASSA_BT_ROUTE_ADVERTISEMENT_ENABLED: "1",
    CASSA_BT_COMMAND_BUS_SHADOW_ENABLED: "1",
    CASSA_BT_NODE_ID: "123e4567-e89b-12d3-a456-426614174000",
    CASSA_BT_TRANSPORT_STORE_PATH: "/srv/cassav5bt/transport.sqlite",
    CASSA_BT_BACKEND_HEALTH_URL: "http://localhost:5381/api/health"
  });
  assert.equal(reliable.reliableChannelEnabled, true);
  assert.equal(reliable.routeAdvertisementEnabled, true);
  assert.equal(reliable.commandBusShadowEnabled, true);
  assert.equal(reliable.transportStorePath, "/srv/cassav5bt/transport.sqlite");
  assert.equal(reliable.backendHealthUrl, "http://localhost:5381/api/health");
  const timingBoundary = loadBluezNodeConfig({
    CASSA_BT_FEATURE_ENABLED: "1",
    CASSA_BT_GATT_SERVER_ENABLED: "1",
    CASSA_BT_HELLO_ENABLED: "1",
    CASSA_BT_MUTUAL_AUTH_ENABLED: "1",
    CASSA_BT_DIRECT_CONTROL_ENABLED: "1",
    CASSA_BT_RELIABLE_CHANNEL_ENABLED: "1",
    CASSA_BT_ROUTE_ADVERTISEMENT_ENABLED: "1",
    CASSA_BT_NODE_ID: "123e4567-e89b-12d3-a456-426614174000",
    CASSA_BT_TRANSPORT_TICK_INTERVAL_MS: "250",
    CASSA_BT_BACKEND_HEALTH_INTERVAL_MS: "2750",
    CASSA_BT_METRICS_INTERVAL_MS: "1000"
  });
  assert.equal(timingBoundary.transportTickIntervalMs, 250);
  assert.equal(timingBoundary.backendHealthIntervalMs, 2_750);
  assert.equal(timingBoundary.metricsIntervalMs, 1_000);
  assert.throws(
    () => loadBluezNodeConfig({ CASSA_BT_METRICS_INTERVAL_MS: "999" }),
    /1000 to 60000/
  );
  assert.throws(
    () => loadBluezNodeConfig({ CASSA_BT_METRICS_INTERVAL_MS: "60001" }),
    /1000 to 60000/
  );
  assert.throws(
    () =>
      loadBluezNodeConfig({
        CASSA_BT_FEATURE_ENABLED: "1",
        CASSA_BT_GATT_SERVER_ENABLED: "1",
        CASSA_BT_HELLO_ENABLED: "1",
        CASSA_BT_MUTUAL_AUTH_ENABLED: "1",
        CASSA_BT_DIRECT_CONTROL_ENABLED: "1",
        CASSA_BT_RELIABLE_CHANNEL_ENABLED: "1",
        CASSA_BT_ROUTE_ADVERTISEMENT_ENABLED: "1",
        CASSA_BT_NODE_ID: "123e4567-e89b-12d3-a456-426614174000",
        CASSA_BT_TRANSPORT_TICK_INTERVAL_MS: "251",
        CASSA_BT_BACKEND_HEALTH_INTERVAL_MS: "2750"
      }),
    /4750 ms operational budget.*5000 ms fail-closed SLA/
  );
  assert.throws(
    () =>
      loadBluezNodeConfig({
        CASSA_BT_FEATURE_ENABLED: "1",
        CASSA_BT_GATT_SERVER_ENABLED: "1",
        CASSA_BT_HELLO_ENABLED: "1",
        CASSA_BT_DIRECT_CONTROL_ENABLED: "1",
        CASSA_BT_NODE_ID: "123e4567-e89b-12d3-a456-426614174000"
      }),
    /requires CASSA_BT_MUTUAL_AUTH_ENABLED=1/
  );
  assert.throws(
    () =>
      loadBluezNodeConfig({
        CASSA_BT_RELIABLE_CHANNEL_ENABLED: "1"
      }),
    /requires CASSA_BT_DIRECT_CONTROL_ENABLED=1/
  );
  assert.throws(
    () =>
      loadBluezNodeConfig({
        CASSA_BT_ROUTE_ADVERTISEMENT_ENABLED: "1"
      }),
    /requires CASSA_BT_RELIABLE_CHANNEL_ENABLED=1/
  );
  assert.throws(
    () =>
      loadBluezNodeConfig({
        CASSA_BT_COMMAND_BUS_SHADOW_ENABLED: "1"
      }),
    /requires CASSA_BT_RELIABLE_CHANNEL_ENABLED=1/
  );
  assert.throws(
    () =>
      loadBluezNodeConfig({
        CASSA_BT_FEATURE_ENABLED: "1",
        CASSA_BT_GATT_SERVER_ENABLED: "1",
        CASSA_BT_HELLO_ENABLED: "1",
        CASSA_BT_MUTUAL_AUTH_ENABLED: "1",
        CASSA_BT_DIRECT_CONTROL_ENABLED: "1",
        CASSA_BT_RELIABLE_CHANNEL_ENABLED: "1",
        CASSA_BT_COMMAND_BUS_SHADOW_ENABLED: "1",
        CASSA_BT_NODE_ID: "123e4567-e89b-12d3-a456-426614174000"
      }),
    /requires CASSA_BT_ROUTE_ADVERTISEMENT_ENABLED=1/
  );
  assert.throws(
    () =>
      loadBluezNodeConfig({
        CASSA_BT_FEATURE_ENABLED: "1",
        CASSA_BT_GATT_SERVER_ENABLED: "1",
        CASSA_BT_MUTUAL_AUTH_ENABLED: "1"
      }),
    /requires CASSA_BT_HELLO_ENABLED=1/
  );
  assert.throws(
    () =>
      loadBluezNodeConfig({
        CASSA_BT_DEVICE_REGISTRY_PATH: "../devices.json"
      }),
    /absolute filesystem path/
  );
  assert.throws(
    () =>
      loadBluezNodeConfig({
        CASSA_BT_BACKEND_HEALTH_URL: "http://192.168.1.79:5381/api/health"
      }),
    /loopback/
  );
  assert.throws(
    () => loadBluezNodeConfig({ CASSA_BT_ADAPTER: "../hci0" }),
    /CASSA_BT_ADAPTER/
  );
  assert.throws(
    () =>
      loadBluezNodeConfig({
        CASSA_BT_GATT_SERVER_ENABLED: "1"
      }),
    /requires CASSA_BT_FEATURE_ENABLED=1/
  );
  assert.throws(
    () =>
      loadBluezNodeConfig({
        CASSA_BT_FEATURE_ENABLED: "1",
        CASSA_BT_GATT_SERVER_ENABLED: "true"
      }),
    /must be exactly 0 or 1/
  );
});

test("disabled node opens no adapter or timer resources", async () => {
  const adapter = new FakeBluezAdapter();
  const intervals = new FakeIntervals();
  const node = new BluezNode({
    config: config({ enabled: false }),
    adapter,
    intervals
  });

  const snapshot = await node.start();
  assert.equal(snapshot.state, BLUEZ_NODE_STATES.DISABLED);
  assert.equal(adapter.startCalls, 0);
  assert.equal(intervals.activeCount, 0);
});

test("GATT server is required, started and stopped only behind its flag", async () => {
  const adapter = new FakeBluezAdapter();
  const intervals = new FakeIntervals();
  const unexpectedGattServer = new FakeGattServer();
  assert.throws(
    () =>
      new BluezNode({
        config: config({ gattServerEnabled: true }),
        adapter,
        intervals
      }),
    /provided exactly when/
  );
  assert.throws(
    () =>
      new BluezNode({
        config: config({ gattServerEnabled: false }),
        adapter,
        intervals,
        gattServer: unexpectedGattServer
      }),
    /provided exactly when/
  );
  assert.equal(unexpectedGattServer.startCalls.length, 0);
  assert.equal(unexpectedGattServer.stopCalls, 0);

  const gattServer = new FakeGattServer();
  const node = new BluezNode({
    config: config({ gattServerEnabled: true }),
    adapter,
    intervals,
    gattServer
  });
  let snapshot = await node.start();
  assert.deepEqual(gattServer.startCalls, [{ adapterName: "hci0" }]);
  assert.equal(snapshot.gattServerEnabled, true);
  assert.equal(snapshot.gattServer.registered, true);

  snapshot = await node.stop();
  assert.equal(gattServer.stopCalls, 1);
  assert.equal(snapshot.gattServer.registered, false);
  assert.equal(adapter.stopCalls, 1);
  assert.equal(intervals.activeCount, 0);
});

test("GATT startup failure rolls discovery back before failing closed", async () => {
  const adapter = new FakeBluezAdapter();
  const intervals = new FakeIntervals();
  const gattServer = new FakeGattServer();
  gattServer.failStart = true;
  const node = new BluezNode({
    config: config({ gattServerEnabled: true }),
    adapter,
    intervals,
    gattServer
  });

  await assert.rejects(
    () => node.start(),
    /simulated GATT start failure/
  );
  assert.equal(node.state, BLUEZ_NODE_STATES.FAILED);
  assert.equal(adapter.startCalls, 1);
  assert.equal(adapter.stopCalls, 1);
  assert.equal(gattServer.stopCalls, 1);
  assert.equal(intervals.activeCount, 0);
});

test("GATT stop failure still releases discovery and timers", async () => {
  const adapter = new FakeBluezAdapter();
  const intervals = new FakeIntervals();
  const gattServer = new FakeGattServer();
  const node = new BluezNode({
    config: config({ gattServerEnabled: true }),
    adapter,
    intervals,
    gattServer
  });
  await node.start();
  gattServer.failStop = true;

  await assert.rejects(
    () => node.stop(),
    /BlueZ node resource cleanup failed/
  );
  assert.equal(node.state, BLUEZ_NODE_STATES.FAILED);
  assert.equal(adapter.stopCalls, 1);
  assert.equal(intervals.activeCount, 0);
});

test("ten consecutive peers are discovered and all resources are released", async () => {
  let nowMs = 0;
  const adapter = new FakeBluezAdapter();
  const intervals = new FakeIntervals();
  const registry = new PeerRegistry({ clock: () => nowMs });
  const node = new BluezNode({
    config: config(),
    adapter,
    intervals,
    registry
  });

  await node.start();
  assert.equal(node.state, BLUEZ_NODE_STATES.DISCOVERING);
  assert.equal(adapter.startCalls, 1);
  assert.equal(intervals.activeCount, 1);

  for (let index = 1; index <= 10; index += 1) {
    nowMs = index * 100;
    adapter.emit({
      serviceUuid: GATT_SERVICE_UUID.toUpperCase(),
      payload: encodeNodeAdvertisement({
        protocolVersion: 1,
        nodeKind: index % 2 === 0 ? "station" : "handheld",
        rotatingAlias: index.toString(16).padStart(12, "0"),
        bootId: 1,
        capabilities: 0x1f,
        serverReachable: true,
        sequence: 1
      }),
      rssiDbm: -50 - index
    });
  }

  let snapshot = node.snapshot();
  assert.equal(snapshot.peers.streamCount, 10);
  assert.equal(snapshot.metrics.observationsTotal, 10);
  assert.equal(snapshot.metrics.observationsAcceptedTotal, 10);
  assert.equal(snapshot.metrics.observationsRejectedTotal, 0);
  assert.equal(snapshot.metrics.peerHighWatermark, 10);
  assert.deepEqual(node.metricsSnapshot(), snapshot.metrics);
  assert.doesNotMatch(
    JSON.stringify(node.metricsSnapshot()),
    /nodeId|storeId|macAddress|payload|secret|token/iu
  );

  nowMs += 15_001;
  intervals.runAll();
  snapshot = node.snapshot();
  assert.equal(snapshot.peers.streamCount, 0);
  assert.equal(snapshot.metrics.peersPrunedTotal, 10);
  assert.equal(snapshot.metrics.maintenanceFailuresTotal, 0);

  await node.stop();
  assert.equal(node.state, BLUEZ_NODE_STATES.STOPPED);
  assert.equal(adapter.stopCalls, 1);
  assert.equal(adapter.handler, null);
  assert.equal(intervals.activeCount, 0);

  await node.stop();
  assert.equal(adapter.stopCalls, 1);
  assert.equal(intervals.activeCount, 0);
});

test("unexpected service data is rejected before peer registration", async () => {
  const adapter = new FakeBluezAdapter();
  const intervals = new FakeIntervals();
  const node = new BluezNode({
    config: config(),
    adapter,
    intervals
  });

  await node.start();
  adapter.emit({
    serviceUuid: "00000000-0000-0000-0000-000000000000",
    payload: new Uint8Array(10),
    rssiDbm: -40
  });

  const snapshot = node.snapshot();
  assert.equal(snapshot.peers.streamCount, 0);
  assert.equal(snapshot.metrics.observationsRejectedTotal, 1);
  assert.equal(
    snapshot.metrics.lastObservationOutcome,
    "unexpected-service-uuid"
  );
  await node.stop();
});

test("adapter startup failure is visible and leaves no timer", async () => {
  const adapter = new FakeBluezAdapter();
  const intervals = new FakeIntervals();
  adapter.failStart = true;
  const node = new BluezNode({
    config: config(),
    adapter,
    intervals
  });

  await assert.rejects(() => node.start(), /simulated BlueZ start failure/);
  const snapshot = node.snapshot();
  assert.equal(snapshot.state, BLUEZ_NODE_STATES.FAILED);
  assert.equal(snapshot.metrics.startFailuresTotal, 1);
  assert.equal(snapshot.metrics.adapterErrorsTotal, 1);
  assert.equal(intervals.activeCount, 0);
});
