import type { GattApplication } from "./GattApplication.js";

export const BLUEZ_GATT_SERVER_STATES = Object.freeze({
  STOPPED: "STOPPED",
  STARTING: "STARTING",
  REGISTERED: "REGISTERED",
  RECOVERING: "RECOVERING",
  STOPPING: "STOPPING",
  FAILED: "FAILED"
} as const);

export type BluezGattServerState =
  (typeof BLUEZ_GATT_SERVER_STATES)[keyof typeof BLUEZ_GATT_SERVER_STATES];

export interface BluezGattServerSnapshot {
  readonly state: BluezGattServerState;
  readonly desiredRunning: boolean;
  readonly adapterName: string | null;
  readonly adapterPath: string | null;
  readonly busConnected: boolean;
  readonly bluezOwnerAvailable: boolean;
  readonly applicationExported: boolean;
  readonly registered: boolean;
  readonly retryScheduled: boolean;
  readonly activeMatchRules: number;
  readonly exportedInterfaceCount: number;
  readonly registrationAttemptsTotal: number;
  readonly registrationsTotal: number;
  readonly registrationFailuresTotal: number;
  readonly unregisterAttemptsTotal: number;
  readonly unregistersTotal: number;
  readonly unregisterFailuresTotal: number;
  readonly ownerLossesTotal: number;
  readonly recoveryAttemptsTotal: number;
  readonly recoverySuccessesTotal: number;
  readonly errorsTotal: number;
  readonly lastErrorCode: string | null;
  readonly application: ReturnType<GattApplication["snapshot"]>;
}

export interface BluezGattServerPort {
  start(input: {
    readonly adapterName: string;
  }): Promise<Readonly<BluezGattServerSnapshot>>;
  stop(): Promise<Readonly<BluezGattServerSnapshot>>;
  snapshot(): Readonly<BluezGattServerSnapshot>;
}

export class BluezGattServerError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BluezGattServerError";
    this.code = code;
  }
}

