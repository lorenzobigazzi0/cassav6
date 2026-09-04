import type { BluezAdapterPort } from "../bluez/BluezAdapter.js";
import type {
  BluezGattServerPort,
  BluezGattServerSnapshot
} from "../bluez/BluezGattServerPort.js";
import type { BluezNodeConfig } from "../config/NodeConfig.js";
import { PeerRegistry } from "../discovery/PeerRegistry.js";
import { PeerScanner } from "../discovery/PeerScanner.js";
import { MetricsRegistry } from "../metrics/MetricsRegistry.js";
import { BluetoothNodeRegistryProjection } from "../backend/BluetoothNodeRegistryProjection.js";

export const BLUEZ_NODE_STATES = Object.freeze({
  DISABLED: "DISABLED",
  IDLE: "IDLE",
  STARTING: "STARTING",
  DISCOVERING: "DISCOVERING",
  STOPPING: "STOPPING",
  STOPPED: "STOPPED",
  FAILED: "FAILED"
} as const);

export type BluezNodeState =
  (typeof BLUEZ_NODE_STATES)[keyof typeof BLUEZ_NODE_STATES];

export interface IntervalScheduler {
  set(handler: () => void, intervalMs: number): unknown;
  clear(handle: unknown): void;
}

const defaultIntervalScheduler: IntervalScheduler = {
  set(handler, intervalMs) {
    return setInterval(handler, intervalMs);
  },
  clear(handle) {
    clearInterval(handle as NodeJS.Timeout);
  }
};

function stateSet(...states: BluezNodeState[]): ReadonlySet<BluezNodeState> {
  return new Set<BluezNodeState>(states);
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<BluezNodeState, ReadonlySet<BluezNodeState>>
> = Object.freeze({
  DISABLED: stateSet(),
  IDLE: stateSet(BLUEZ_NODE_STATES.STARTING),
  STARTING: stateSet(
    BLUEZ_NODE_STATES.DISCOVERING,
    BLUEZ_NODE_STATES.FAILED
  ),
  DISCOVERING: stateSet(
    BLUEZ_NODE_STATES.STOPPING,
    BLUEZ_NODE_STATES.FAILED
  ),
  STOPPING: stateSet(
    BLUEZ_NODE_STATES.STOPPED,
    BLUEZ_NODE_STATES.FAILED
  ),
  STOPPED: stateSet(BLUEZ_NODE_STATES.STARTING),
  FAILED: stateSet(
    BLUEZ_NODE_STATES.STARTING,
    BLUEZ_NODE_STATES.STOPPING
  )
});

export class BluezNode {
  readonly #config: Readonly<BluezNodeConfig>;
  readonly #intervals: IntervalScheduler;
  readonly #metrics: MetricsRegistry;
  readonly #registry: PeerRegistry;
  readonly #scanner: PeerScanner;
  readonly #diagnosticProjection = new BluetoothNodeRegistryProjection();
  readonly #gattServer: BluezGattServerPort | null;
  #maintenanceHandle: unknown | null = null;
  #operation: Promise<void> = Promise.resolve();
  #state: BluezNodeState;

  constructor(input: {
    config: Readonly<BluezNodeConfig>;
    adapter: BluezAdapterPort;
    gattServer?: BluezGattServerPort;
    registry?: PeerRegistry;
    metrics?: MetricsRegistry;
    intervals?: IntervalScheduler;
  }) {
    this.#config = input.config;
    this.#registry = input.registry ?? new PeerRegistry();
    this.#metrics = input.metrics ?? new MetricsRegistry();
    this.#intervals = input.intervals ?? defaultIntervalScheduler;
    if (
      this.#config.gattServerEnabled !==
      (input.gattServer !== undefined)
    ) {
      throw new Error(
        "gattServer must be provided exactly when CASSA_BT_GATT_SERVER_ENABLED is active"
      );
    }
    this.#gattServer = input.gattServer ?? null;
    this.#scanner = new PeerScanner({
      adapter: input.adapter,
      registry: this.#registry,
      metrics: this.#metrics
    });
    this.#state = this.#config.enabled
      ? BLUEZ_NODE_STATES.IDLE
      : BLUEZ_NODE_STATES.DISABLED;
    this.#metrics.recordStateTransition(this.#state);
  }

  get state(): BluezNodeState {
    return this.#state;
  }

  #transition(nextState: BluezNodeState): void {
    if (!ALLOWED_TRANSITIONS[this.#state].has(nextState)) {
      throw new Error(
        `invalid BluezNode transition ${this.#state} -> ${nextState}`
      );
    }
    this.#state = nextState;
    this.#metrics.recordStateTransition(nextState);
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  #startMaintenance(): void {
    if (this.#maintenanceHandle !== null) {
      throw new Error("maintenance timer already active");
    }
    this.#maintenanceHandle = this.#intervals.set(() => {
      try {
        const result = this.#registry.pruneExpired();
        this.#metrics.recordMaintenance(result.removed, result.remaining);
      } catch {
        this.#metrics.recordMaintenanceFailure();
      }
    }, this.#config.maintenanceIntervalMs);
  }

  #stopMaintenance(): void {
    if (this.#maintenanceHandle === null) {
      return;
    }
    this.#intervals.clear(this.#maintenanceHandle);
    this.#maintenanceHandle = null;
  }

  start(): Promise<ReturnType<BluezNode["snapshot"]>> {
    return this.#serialize(async () => {
      if (this.#state === BLUEZ_NODE_STATES.DISABLED) {
        return this.snapshot();
      }
      if (this.#state === BLUEZ_NODE_STATES.DISCOVERING) {
        return this.snapshot();
      }

      this.#metrics.recordStartAttempt();
      this.#transition(BLUEZ_NODE_STATES.STARTING);
      try {
        await this.#scanner.start();
        if (this.#config.gattServerEnabled) {
          await this.#gattServer?.start({
            adapterName: this.#config.adapterName
          });
        }
        this.#startMaintenance();
        this.#transition(BLUEZ_NODE_STATES.DISCOVERING);
        this.#metrics.recordStarted();
        return this.snapshot();
      } catch (error) {
        this.#stopMaintenance();
        try {
          await this.#gattServer?.stop();
        } catch {
          this.#metrics.recordAdapterError();
        }
        try {
          await this.#scanner.stop();
        } catch {
          this.#metrics.recordScannerError();
        }
        this.#metrics.recordAdapterError();
        this.#metrics.recordStartFailure();
        this.#transition(BLUEZ_NODE_STATES.FAILED);
        throw error;
      }
    });
  }

  stop(): Promise<ReturnType<BluezNode["snapshot"]>> {
    return this.#serialize(async () => {
      if (
        this.#state === BLUEZ_NODE_STATES.DISABLED ||
        this.#state === BLUEZ_NODE_STATES.IDLE ||
        this.#state === BLUEZ_NODE_STATES.STOPPED
      ) {
        return this.snapshot();
      }

      this.#transition(BLUEZ_NODE_STATES.STOPPING);
      this.#stopMaintenance();
      const stopErrors: unknown[] = [];
      try {
        try {
          await this.#gattServer?.stop();
        } catch (error) {
          stopErrors.push(error);
          this.#metrics.recordAdapterError();
        }
        try {
          await this.#scanner.stop();
        } catch (error) {
          stopErrors.push(error);
          this.#metrics.recordScannerError();
        }
        if (stopErrors.length > 0) {
          throw new AggregateError(
            stopErrors,
            "BlueZ node resource cleanup failed"
          );
        }
        this.#transition(BLUEZ_NODE_STATES.STOPPED);
        this.#metrics.recordStopped();
        return this.snapshot();
      } catch (error) {
        this.#metrics.recordAdapterError();
        this.#transition(BLUEZ_NODE_STATES.FAILED);
        throw error;
      }
    });
  }

  metricsSnapshot(): ReturnType<MetricsRegistry["snapshot"]> {
    return this.#metrics.snapshot();
  }

  snapshot(): Readonly<{
    component: "cassav5bt-bluetooth-node";
    state: BluezNodeState;
    enabled: boolean;
    dryRun: boolean;
    gattServerEnabled: boolean;
    helloExchangeEnabled: boolean;
    mutualAuthEnabled: boolean;
    directControlEnabled: boolean;
    reliableChannelEnabled: boolean;
    routeAdvertisementEnabled: boolean;
    commandBusShadowEnabled: boolean;
    deviceRegistryPath: string;
    nodeId: string;
    storeId: string;
    scanner: ReturnType<PeerScanner["snapshot"]>;
    peers: ReturnType<PeerRegistry["snapshot"]>;
    peerMetrics: ReturnType<PeerRegistry["metrics"]>;
    diagnosticProjection: ReturnType<BluetoothNodeRegistryProjection["project"]>;
    metrics: ReturnType<MetricsRegistry["snapshot"]>;
    gattServer: Readonly<BluezGattServerSnapshot> | null;
  }> {
    const peers = this.#registry.snapshot();
    return Object.freeze({
      component: "cassav5bt-bluetooth-node",
      state: this.#state,
      enabled: this.#config.enabled,
      dryRun: this.#config.dryRun,
      gattServerEnabled: this.#config.gattServerEnabled,
      helloExchangeEnabled: this.#config.helloExchangeEnabled,
      mutualAuthEnabled: this.#config.mutualAuthEnabled,
      directControlEnabled: this.#config.directControlEnabled,
      reliableChannelEnabled: this.#config.reliableChannelEnabled,
      routeAdvertisementEnabled: this.#config.routeAdvertisementEnabled,
      commandBusShadowEnabled: this.#config.commandBusShadowEnabled,
      deviceRegistryPath: this.#config.deviceRegistryPath,
      nodeId: this.#config.nodeId,
      storeId: this.#config.storeId,
      scanner: this.#scanner.snapshot(),
      peers,
      peerMetrics: this.#registry.metrics(),
      diagnosticProjection: this.#diagnosticProjection.project(peers),
      metrics: this.#metrics.snapshot(),
      gattServer: this.#gattServer?.snapshot() ?? null
    });
  }
}
