import { GATT_SERVICE_UUID } from "../../../shared/protocol/advertisement-v1.mjs";
import type {
  BluezAdapterPort,
  BluezServiceDataObservation
} from "../bluez/BluezAdapter.js";
import { MetricsRegistry } from "../metrics/MetricsRegistry.js";
import { PeerRegistry } from "./PeerRegistry.js";

export const PEER_SCANNER_STATES = Object.freeze({
  STOPPED: "STOPPED",
  STARTING: "STARTING",
  RUNNING: "RUNNING",
  STOPPING: "STOPPING"
} as const);

export type PeerScannerState =
  (typeof PEER_SCANNER_STATES)[keyof typeof PEER_SCANNER_STATES];

export class PeerScanner {
  readonly #adapter: BluezAdapterPort;
  readonly #metrics: MetricsRegistry;
  readonly #registry: PeerRegistry;
  #state: PeerScannerState = PEER_SCANNER_STATES.STOPPED;

  constructor(input: {
    adapter: BluezAdapterPort;
    registry: PeerRegistry;
    metrics: MetricsRegistry;
  }) {
    this.#adapter = input.adapter;
    this.#registry = input.registry;
    this.#metrics = input.metrics;
  }

  get state(): PeerScannerState {
    return this.#state;
  }

  readonly #handleObservation = (
    observation: BluezServiceDataObservation
  ): void => {
    if (
      this.#state !== PEER_SCANNER_STATES.STARTING &&
      this.#state !== PEER_SCANNER_STATES.RUNNING
    ) {
      this.#metrics.recordLateObservation();
      return;
    }

    if (
      typeof observation.serviceUuid !== "string" ||
      observation.serviceUuid.trim().toLowerCase() !== GATT_SERVICE_UUID
    ) {
      this.#metrics.recordObservation({
        accepted: false,
        outcome: "unexpected-service-uuid",
        currentPeers: this.#registry.size
      });
      return;
    }

    try {
      const result = this.#registry.observe(
        observation.payload,
        observation.rssiDbm
      );
      this.#metrics.recordObservation({
        accepted: result.accepted,
        outcome: result.outcome,
        currentPeers: this.#registry.size
      });
    } catch {
      this.#metrics.recordScannerError();
    }
  };

  async start(): Promise<void> {
    if (this.#state === PEER_SCANNER_STATES.RUNNING) {
      return;
    }
    if (this.#state !== PEER_SCANNER_STATES.STOPPED) {
      throw new Error(`cannot start scanner from ${this.#state}`);
    }

    this.#state = PEER_SCANNER_STATES.STARTING;
    try {
      await this.#adapter.startDiscovery(this.#handleObservation);
      this.#state = PEER_SCANNER_STATES.RUNNING;
    } catch (error) {
      this.#state = PEER_SCANNER_STATES.STOPPED;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#state === PEER_SCANNER_STATES.STOPPED) {
      return;
    }

    this.#state = PEER_SCANNER_STATES.STOPPING;
    try {
      await this.#adapter.stopDiscovery();
    } finally {
      this.#state = PEER_SCANNER_STATES.STOPPED;
    }
  }

  snapshot(): Readonly<{
    state: PeerScannerState;
    adapter: ReturnType<BluezAdapterPort["snapshot"]>;
  }> {
    return Object.freeze({
      state: this.#state,
      adapter: this.#adapter.snapshot()
    });
  }
}
