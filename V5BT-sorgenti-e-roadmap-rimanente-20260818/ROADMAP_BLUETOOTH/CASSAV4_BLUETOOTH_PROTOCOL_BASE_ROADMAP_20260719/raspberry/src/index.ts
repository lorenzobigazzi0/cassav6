import { BluezAdapter } from "./bluez/BluezAdapter.js";
import { DbusNextGattServerPort } from "./bluez/DbusNextGattServerPort.js";
import { DbusNextLeAdvertisementPortV1 } from "./bluez/DbusNextLeAdvertisementPort.js";
import { GattApplication } from "./bluez/GattApplication.js";
import {
  LeAdvertiser,
  RaspberryAdvertisementIdentityStoreV1
} from "./bluez/LeAdvertiser.js";
import { loadBluezNodeConfig } from "./config/NodeConfig.js";
import { BluetoothMetricsReporterV1 } from "./metrics/BluetoothMetricsReporterV1.js";
import { BackendHealthProbe } from "./backend/BackendHealthProbe.js";
import { BluetoothTransportRuntimeV1 } from "./node/BluetoothTransportRuntimeV1.js";
import { BACKEND_HEALTH_PROBE_TIMEOUT_MS } from "./routing/RouteHealthBudgetV1.js";
import { BluezNode } from "./node/BluezNode.js";
import { DirectControlHandshakeV1 } from "./security/DirectControlHandshakeV1.js";
import { MutualAuthHandshakeV1 } from "./security/Handshake.js";
import { GattHelloExchangeV1 } from "./session/GattHelloExchangeV1.js";
import { GattReliableDataPlaneV1 } from "./session/GattReliableDataPlaneV1.js";
import { BluetoothTransportStoreV1 } from "./storage/BluetoothTransportStore.js";
import { DeviceRegistryV2 } from "../../shared/provisioning/device-registry-v2.mjs";

function writeStatus(value: object): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const config = loadBluezNodeConfig();

if (!config.enabled) {
  writeStatus({
    component: "cassav5bt-bluetooth-node",
    state: "DISABLED",
    enabled: false,
    radioResourcesOpened: false,
    reason: "CASSA_BT_FEATURE_ENABLED is not 1"
  });
} else if (config.dryRun) {
  writeStatus({
    component: "cassav5bt-bluetooth-node",
    state: "DRY_RUN",
    enabled: true,
    radioResourcesOpened: false,
    adapterName: config.adapterName,
    gattServerEnabled: config.gattServerEnabled,
    helloExchangeEnabled: config.helloExchangeEnabled,
    mutualAuthEnabled: config.mutualAuthEnabled,
    directControlEnabled: config.directControlEnabled,
    reliableChannelEnabled: config.reliableChannelEnabled,
    routeAdvertisementEnabled: config.routeAdvertisementEnabled,
    commandBusShadowEnabled: config.commandBusShadowEnabled,
    deviceRegistryPath: config.deviceRegistryPath,
    nodeId: config.nodeId,
    storeId: config.storeId
  });
} else {
  const deviceRegistry = config.mutualAuthEnabled
    ? new DeviceRegistryV2(config.deviceRegistryPath)
    : null;
  const handshake =
    deviceRegistry === null
      ? undefined
      : new MutualAuthHandshakeV1(deviceRegistry);
  const directControlHandshake =
    config.directControlEnabled && deviceRegistry !== null
      ? new DirectControlHandshakeV1(deviceRegistry)
      : undefined;
  const transportStore = config.reliableChannelEnabled
    ? new BluetoothTransportStoreV1(config.transportStorePath)
    : null;
  const advertisementIdentityStore = config.routeAdvertisementEnabled
    ? new RaspberryAdvertisementIdentityStoreV1({
        path: `${config.transportStorePath}.advertisement-identity-v1.json`,
        nodeId: config.nodeId
      })
    : null;
  const advertisementIdentity = advertisementIdentityStore?.beginBoot() ?? null;
  const helloExchange = new GattHelloExchangeV1({
    enabled: config.helloExchangeEnabled,
    mutualAuthEnabled: config.mutualAuthEnabled,
    handshake,
    directControlEnabled: config.directControlEnabled,
    directControlHandshake,
    identity: config.helloExchangeEnabled
      ? {
          nodeId: config.nodeId,
          bootId: advertisementIdentity?.bootId ?? config.helloBootId,
          capabilities: config.helloCapabilities
        }
      : undefined
  });
  let shutdownHandler:
    | ((reason: NodeJS.Signals | "TRANSPORT_FAILED") => Promise<void>)
    | null = null;
  let transportRuntime: BluetoothTransportRuntimeV1 | null = null;
  let fatalReported = false;
  const handleFatal = (error: unknown): void => {
    if (fatalReported) return;
    fatalReported = true;
    process.stderr.write(
      `${JSON.stringify({
        component: "cassav5bt-bluetooth-node",
        state: "TRANSPORT_FAILED",
        errorCode:
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "TRANSPORT_RUNTIME_FAILURE"
      })}\n`
    );
    process.exitCode = 1;
    if (shutdownHandler !== null) {
      queueMicrotask(() => void shutdownHandler?.("TRANSPORT_FAILED"));
    }
  };
  const leAdvertiser =
    config.routeAdvertisementEnabled && advertisementIdentity !== null
      ? new LeAdvertiser({
          adapterName: config.adapterName,
          identity: advertisementIdentity,
          capabilities: config.helloCapabilities,
          port: new DbusNextLeAdvertisementPortV1(),
          onFatal: handleFatal
        })
      : null;
  if (transportStore !== null) {
    transportRuntime = new BluetoothTransportRuntimeV1({
      routeAdvertisementEnabled: config.routeAdvertisementEnabled,
      shadowEnabled: config.commandBusShadowEnabled,
      store: transportStore,
      healthProbe: new BackendHealthProbe({
        url: config.backendHealthUrl,
        timeoutMs: BACKEND_HEALTH_PROBE_TIMEOUT_MS
      }),
      shadowHandler: async () => {
        // B10 observes authenticated diagnostics only; business remains on LAN.
      },
      tickIntervalMs: config.transportTickIntervalMs,
      healthIntervalMs: config.backendHealthIntervalMs,
      onRouteHealth: async (health) => {
        await leAdvertiser?.updateRouteHealth(health);
      },
      onFatal: handleFatal
    });
  }
  const reliableDataPlane =
    transportRuntime !== null && transportStore !== null
      ? new GattReliableDataPlaneV1({
          enabled: true,
          helloExchange,
          store: transportStore,
          onMessage: (message) => transportRuntime?.handleMessage(message)
        })
      : null;
  if (transportRuntime !== null && reliableDataPlane !== null) {
    transportRuntime.attachDataPlane(reliableDataPlane);
  }
  const gattApplication = config.gattServerEnabled
    ? new GattApplication(
        undefined,
        helloExchange,
        reliableDataPlane
      )
    : undefined;
  const node = new BluezNode({
    config,
    adapter: new BluezAdapter(config.adapterName),
    gattServer: config.gattServerEnabled
      ? new DbusNextGattServerPort({ application: gattApplication })
      : undefined
  });
  const metricsReporter = new BluetoothMetricsReporterV1({
    intervalMs: config.metricsIntervalMs,
    nodeMetrics: () => node.metricsSnapshot(),
    transportMetrics: () => transportRuntime?.metricsSnapshot() ?? null,
    publish: writeStatus,
    onFatal: handleFatal
  });

  let storeClosed = false;
  const closeStore = (): void => {
    if (storeClosed) return;
    advertisementIdentityStore?.close();
    transportStore?.close();
    storeClosed = true;
  };
  const shutdown = async (
    signal: NodeJS.Signals | "TRANSPORT_FAILED"
  ): Promise<void> => {
    const errors: unknown[] = [];
    try {
      let nodeSnapshot: Awaited<ReturnType<BluezNode["stop"]>> | null = null;
      try {
        metricsReporter.stop();
      } catch (error) {
        errors.push(error);
      }
      try {
        await leAdvertiser?.stop();
      } catch (error) {
        errors.push(error);
      }
      try {
        nodeSnapshot = await node.stop();
      } catch (error) {
        errors.push(error);
      }
      try {
        await transportRuntime?.stop();
      } catch (error) {
        errors.push(error);
      }
      const transportSnapshot = transportRuntime?.snapshot() ?? null;
      closeStore();
      if (errors.length > 0 || nodeSnapshot === null) {
        throw new AggregateError(errors, "Bluetooth shutdown failed");
      }
      writeStatus({
        signal,
        ...nodeSnapshot,
        advertiser: leAdvertiser?.snapshot() ?? null,
        transport: transportSnapshot
      });
    } catch {
      process.stderr.write(
        `${JSON.stringify({
          component: "cassav5bt-bluetooth-node",
          signal,
          state: "FAILED",
          error: "Bluetooth resource cleanup failed"
        })}\n`
      );
      process.exitCode = 1;
      try {
        closeStore();
      } catch {
        // The original cleanup failure remains authoritative.
      }
    }
  };
  shutdownHandler = shutdown;

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    if (deviceRegistry !== null) {
      await deviceRegistry.initialize();
      await deviceRegistry.inspect();
    }
    transportRuntime?.start();
    const snapshot = await node.start();
    await leAdvertiser?.start();
    metricsReporter.start();
    writeStatus({
      ...snapshot,
      advertiser: leAdvertiser?.snapshot() ?? null,
      transport: transportRuntime?.snapshot() ?? null
    });
  } catch (error) {
    try {
      metricsReporter.stop();
    } catch {
      // Preserve the startup failure.
    }
    try {
      await leAdvertiser?.stop();
    } catch {
      // Preserve the startup failure.
    }
    try {
      await node.stop();
    } catch {
      // Preserve the startup failure.
    }
    try {
      await transportRuntime?.stop();
    } catch {
      // Preserve the startup failure.
    }
    try {
      closeStore();
    } catch {
      // Preserve the startup failure.
    }
    process.stderr.write(
      `${JSON.stringify({
        component: "cassav5bt-bluetooth-node",
        state: node.state,
        radioResourcesOpened: false,
        error: error instanceof Error ? error.message : "unknown startup error"
      })}\n`
    );
    process.exitCode = 1;
  }
}
