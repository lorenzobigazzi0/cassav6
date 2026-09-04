import { GATT_SERVICE_UUID } from "../../../shared/protocol/advertisement-v1.mjs";

import {
  type BluezDbusEventHandlers,
  type BluezDbusPort,
  type BluezDbusPortSnapshot,
  type BluezDevicePropertyPatch
} from "./BluezDbusPort.js";
import { DbusNextBluezPort } from "./DbusNextBluezPort.js";

export interface BluezServiceDataObservation {
  readonly serviceUuid: string;
  readonly payload: Uint8Array;
  readonly rssiDbm: number;
}

export type BluezObservationHandler = (
  observation: BluezServiceDataObservation
) => void;

export interface BluezAdapterSnapshot {
  readonly adapterName: string;
  readonly adapterPath: string;
  readonly transport: string;
  readonly discovering: boolean;
  readonly recovering: boolean;
  readonly retryScheduled: boolean;
  readonly observationHandlerAttached: boolean;
  readonly trackedDevices: number;
  readonly reconnectAttemptsTotal: number;
  readonly reconnectSuccessesTotal: number;
  readonly dbusErrorsTotal: number;
  readonly observationHandlerErrorsTotal: number;
  readonly dbus: Readonly<BluezDbusPortSnapshot>;
}

export interface BluezAdapterPort {
  readonly adapterName: string;
  startDiscovery(handler: BluezObservationHandler): Promise<void>;
  stopDiscovery(): Promise<void>;
  snapshot(): Readonly<BluezAdapterSnapshot>;
}

export interface TimeoutScheduler {
  set(handler: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface BluezAdapterOptions {
  readonly dbusPort?: BluezDbusPort;
  readonly retryScheduler?: TimeoutScheduler;
  readonly retryDelaysMs?: readonly number[];
}

interface DeviceObservationState {
  rssiDbm?: number;
  payload?: Uint8Array;
}

const ADAPTER_PATTERN = /^hci[0-9]+$/;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([
  250,
  500,
  1_000,
  2_000,
  5_000
]);

const defaultTimeoutScheduler: TimeoutScheduler = {
  set(handler, delayMs) {
    return setTimeout(handler, delayMs);
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  }
};

export class BluezAdapterConfigurationError extends Error {
  readonly code = "INVALID_BLUEZ_ADAPTER_CONFIGURATION";

  constructor(message: string) {
    super(message);
    this.name = "BluezAdapterConfigurationError";
  }
}

function validateRetryDelays(
  values: readonly number[]
): readonly number[] {
  if (
    values.length === 0 ||
    values.some(
      (value) =>
        !Number.isSafeInteger(value) || value < 0 || value > 60_000
    )
  ) {
    throw new BluezAdapterConfigurationError(
      "retryDelaysMs must contain integers from 0 to 60000"
    );
  }
  return Object.freeze([...values]);
}

export class BluezAdapter implements BluezAdapterPort {
  readonly adapterName: string;
  readonly #adapterPath: string;
  readonly #dbusPort: BluezDbusPort;
  readonly #retryScheduler: TimeoutScheduler;
  readonly #retryDelaysMs: readonly number[];
  readonly #devices = new Map<string, DeviceObservationState>();
  #handler: BluezObservationHandler | null = null;
  #desiredRunning = false;
  #discovering = false;
  #recovering = false;
  #retryHandle: unknown | null = null;
  #consecutiveRecoveryFailures = 0;
  #reconnectAttemptsTotal = 0;
  #reconnectSuccessesTotal = 0;
  #dbusErrorsTotal = 0;
  #observationHandlerErrorsTotal = 0;
  #operation: Promise<void> = Promise.resolve();

  constructor(adapterName: string, options: BluezAdapterOptions = {}) {
    if (!ADAPTER_PATTERN.test(adapterName)) {
      throw new BluezAdapterConfigurationError(
        `adapterName must match ${ADAPTER_PATTERN.source}`
      );
    }
    this.adapterName = adapterName;
    this.#adapterPath = `/org/bluez/${adapterName}`;
    this.#dbusPort = options.dbusPort ?? new DbusNextBluezPort();
    this.#retryScheduler =
      options.retryScheduler ?? defaultTimeoutScheduler;
    this.#retryDelaysMs = validateRetryDelays(
      options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    );
  }

  readonly #dbusHandlers: BluezDbusEventHandlers = {
    onOwnerChanged: (available) => this.#handleOwnerChanged(available),
    onDeviceUpdate: (patch) => this.#handleDeviceUpdate(patch),
    onDeviceRemoved: (objectPath) => {
      this.#devices.delete(objectPath);
    },
    onError: () => {
      this.#dbusErrorsTotal += 1;
    }
  };

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  #cancelRetry(): void {
    if (this.#retryHandle === null) {
      return;
    }
    this.#retryScheduler.clear(this.#retryHandle);
    this.#retryHandle = null;
  }

  #scheduleRetry(): void {
    if (
      !this.#desiredRunning ||
      this.#retryHandle !== null ||
      !this.#dbusPort.snapshot().bluezOwnerAvailable
    ) {
      return;
    }

    const delayIndex = Math.min(
      Math.max(0, this.#consecutiveRecoveryFailures - 1),
      this.#retryDelaysMs.length - 1
    );
    const delayMs = this.#retryDelaysMs[delayIndex];
    this.#retryHandle = this.#retryScheduler.set(() => {
      this.#retryHandle = null;
      void this.#serialize(async () => {
        await this.#attemptRecovery();
      }).catch(() => {
        // #attemptRecovery records the failure and owns the next retry.
      });
    }, delayMs);
  }

  async #attemptRecovery(): Promise<void> {
    if (
      !this.#desiredRunning ||
      this.#discovering ||
      !this.#dbusPort.snapshot().bluezOwnerAvailable
    ) {
      return;
    }

    this.#recovering = true;
    this.#reconnectAttemptsTotal += 1;
    try {
      await this.#dbusPort.openDiscovery({
        adapterPath: this.#adapterPath,
        serviceUuid: GATT_SERVICE_UUID
      });
      if (!this.#desiredRunning) {
        await this.#dbusPort.closeDiscovery();
        return;
      }
      this.#discovering = true;
      this.#recovering = false;
      this.#consecutiveRecoveryFailures = 0;
      this.#reconnectSuccessesTotal += 1;
    } catch (error) {
      this.#discovering = false;
      this.#recovering = true;
      this.#consecutiveRecoveryFailures += 1;
      this.#dbusErrorsTotal += 1;
      this.#scheduleRetry();
      throw error;
    }
  }

  #handleOwnerChanged(available: boolean): Promise<void> {
    return this.#serialize(async () => {
      if (!this.#desiredRunning) {
        return;
      }

      this.#devices.clear();
      if (!available) {
        this.#cancelRetry();
        this.#discovering = false;
        this.#recovering = true;
        return;
      }

      try {
        await this.#attemptRecovery();
      } catch {
        // Recovery continues through the bounded deterministic backoff.
      }
    });
  }

  #findServicePayload(
    serviceData: ReadonlyMap<string, Uint8Array>
  ): Uint8Array | undefined {
    const direct = serviceData.get(GATT_SERVICE_UUID);
    if (direct !== undefined) {
      return Uint8Array.from(direct);
    }
    for (const [uuid, payload] of serviceData) {
      if (uuid.trim().toLowerCase() === GATT_SERVICE_UUID) {
        return Uint8Array.from(payload);
      }
    }
    return undefined;
  }

  #handleDeviceUpdate(patch: BluezDevicePropertyPatch): void {
    if (!this.#desiredRunning || this.#handler === null) {
      return;
    }

    const state = this.#devices.get(patch.objectPath) ?? {};
    if (patch.rssiDbm !== undefined) {
      if (patch.rssiDbm === null) {
        delete state.rssiDbm;
      } else {
        state.rssiDbm = patch.rssiDbm;
      }
    }
    if (patch.serviceData !== undefined) {
      if (patch.serviceData === null) {
        delete state.payload;
      } else {
        const payload = this.#findServicePayload(patch.serviceData);
        if (payload === undefined) {
          delete state.payload;
        } else {
          state.payload = payload;
        }
      }
    }
    this.#devices.set(patch.objectPath, state);

    if (state.rssiDbm === undefined || state.payload === undefined) {
      return;
    }

    try {
      this.#handler({
        serviceUuid: GATT_SERVICE_UUID,
        payload: Uint8Array.from(state.payload),
        rssiDbm: state.rssiDbm
      });
    } catch {
      this.#observationHandlerErrorsTotal += 1;
    }
  }

  startDiscovery(handler: BluezObservationHandler): Promise<void> {
    return this.#serialize(async () => {
      if (this.#desiredRunning) {
        if (this.#handler !== handler) {
          throw new Error(
            "BlueZ discovery already has a different observation handler"
          );
        }
        return;
      }

      this.#desiredRunning = true;
      this.#handler = handler;
      this.#recovering = false;
      this.#devices.clear();

      try {
        await this.#dbusPort.connect(this.#dbusHandlers);
        await this.#dbusPort.openDiscovery({
          adapterPath: this.#adapterPath,
          serviceUuid: GATT_SERVICE_UUID
        });
        this.#discovering = true;
      } catch (error) {
        this.#desiredRunning = false;
        this.#discovering = false;
        this.#recovering = false;
        this.#handler = null;
        this.#devices.clear();
        this.#dbusErrorsTotal += 1;
        await this.#dbusPort.disconnect();
        throw error;
      }
    });
  }

  stopDiscovery(): Promise<void> {
    return this.#serialize(async () => {
      if (!this.#desiredRunning && this.#handler === null) {
        return;
      }

      this.#desiredRunning = false;
      this.#discovering = false;
      this.#recovering = false;
      this.#cancelRetry();
      this.#devices.clear();

      let closeError: unknown = null;
      try {
        await this.#dbusPort.closeDiscovery();
      } catch (error) {
        closeError = error;
        this.#dbusErrorsTotal += 1;
      }
      await this.#dbusPort.disconnect();
      this.#handler = null;

      if (closeError !== null) {
        throw closeError;
      }
    });
  }

  snapshot(): Readonly<BluezAdapterSnapshot> {
    const dbus = this.#dbusPort.snapshot();
    return Object.freeze({
      adapterName: this.adapterName,
      adapterPath: this.#adapterPath,
      transport: dbus.transport,
      discovering: this.#discovering,
      recovering: this.#recovering,
      retryScheduled: this.#retryHandle !== null,
      observationHandlerAttached: this.#handler !== null,
      trackedDevices: this.#devices.size,
      reconnectAttemptsTotal: this.#reconnectAttemptsTotal,
      reconnectSuccessesTotal: this.#reconnectSuccessesTotal,
      dbusErrorsTotal: this.#dbusErrorsTotal,
      observationHandlerErrorsTotal: this.#observationHandlerErrorsTotal,
      dbus
    });
  }
}
