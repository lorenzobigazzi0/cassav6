import { systemBus } from "@jellybrick/dbus-next";

import {
  BLUEZ_GATT_SERVER_STATES,
  BluezGattServerError,
  type BluezGattServerPort,
  type BluezGattServerSnapshot,
  type BluezGattServerState
} from "./BluezGattServerPort.js";
import {
  GattApplication,
  type GattApplicationExport
} from "./GattApplication.js";

const BLUEZ_BUS_NAME = "org.bluez";
const DBUS_BUS_NAME = "org.freedesktop.DBus";
const DBUS_BUS_PATH = "/org/freedesktop/DBus";
const DBUS_INTERFACE = "org.freedesktop.DBus";
const GATT_MANAGER_INTERFACE = "org.bluez.GattManager1";
const ADAPTER_PATTERN = /^hci[0-9]+$/;
const NAME_OWNER_RULE =
  "type='signal',sender='org.freedesktop.DBus'," +
  "interface='org.freedesktop.DBus',member='NameOwnerChanged'," +
  "arg0='org.bluez'";
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([
  250,
  500,
  1_000,
  2_000,
  5_000
]);

interface DbusInterfaceLike {
  readonly [memberName: string]: unknown;
}

interface DbusProxyObjectLike {
  getInterface(name: string): DbusInterfaceLike;
}

interface DbusMessageLike {
  readonly path?: string;
  readonly interface?: string;
  readonly member?: string;
  readonly body?: readonly unknown[];
}

interface DbusMessageBusLike {
  getProxyObject(
    name: string,
    path: string
  ): Promise<DbusProxyObjectLike>;
  on(eventName: "message", listener: (message: DbusMessageLike) => void): this;
  off(eventName: "message", listener: (message: DbusMessageLike) => void): this;
  export(path: string, dbusInterface: GattApplicationExport["interface"]): void;
  unexport(
    path: string,
    dbusInterface?: GattApplicationExport["interface"] | null
  ): void;
  disconnect(): void;
}

export interface GattRetryScheduler {
  set(handler: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface DbusNextGattServerPortOptions {
  readonly busFactory?: () => DbusMessageBusLike;
  readonly retryScheduler?: GattRetryScheduler;
  readonly retryDelaysMs?: readonly number[];
  readonly application?: GattApplication;
}

const defaultRetryScheduler: GattRetryScheduler = {
  set(handler, delayMs) {
    return setTimeout(handler, delayMs);
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  }
};

function defaultBusFactory(): DbusMessageBusLike {
  return systemBus() as unknown as DbusMessageBusLike;
}

async function callMethod<T>(
  dbusInterface: DbusInterfaceLike,
  methodName: string,
  ...args: readonly unknown[]
): Promise<T> {
  const candidate = dbusInterface[methodName];
  if (typeof candidate !== "function") {
    throw new BluezGattServerError(
      "MISSING_DBUS_METHOD",
      `${methodName} is not available on the D-Bus interface`
    );
  }
  return (await candidate.apply(dbusInterface, args)) as T;
}

function validateRetryDelays(values: readonly number[]): readonly number[] {
  if (
    values.length === 0 ||
    values.some(
      (value) =>
        !Number.isSafeInteger(value) || value < 0 || value > 60_000
    )
  ) {
    throw new BluezGattServerError(
      "INVALID_RETRY_POLICY",
      "retryDelaysMs must contain integers from 0 to 60000"
    );
  }
  return Object.freeze([...values]);
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name : "UNKNOWN_ERROR";
}

export class DbusNextGattServerPort implements BluezGattServerPort {
  readonly #busFactory: () => DbusMessageBusLike;
  readonly #retryScheduler: GattRetryScheduler;
  readonly #retryDelaysMs: readonly number[];
  readonly #application: GattApplication;
  #bus: DbusMessageBusLike | null = null;
  #dbusInterface: DbusInterfaceLike | null = null;
  #gattManagerInterface: DbusInterfaceLike | null = null;
  #state: BluezGattServerState = BLUEZ_GATT_SERVER_STATES.STOPPED;
  #desiredRunning = false;
  #adapterName: string | null = null;
  #adapterPath: string | null = null;
  #bluezOwnerAvailable = false;
  #registered = false;
  #activeMatchRule = false;
  #exportedInterfaces: GattApplicationExport[] = [];
  #retryHandle: unknown | null = null;
  #consecutiveRecoveryFailures = 0;
  #registrationAttemptsTotal = 0;
  #registrationsTotal = 0;
  #registrationFailuresTotal = 0;
  #unregisterAttemptsTotal = 0;
  #unregistersTotal = 0;
  #unregisterFailuresTotal = 0;
  #ownerLossesTotal = 0;
  #recoveryAttemptsTotal = 0;
  #recoverySuccessesTotal = 0;
  #errorsTotal = 0;
  #lastErrorCode: string | null = null;
  #operation: Promise<void> = Promise.resolve();

  constructor(options: DbusNextGattServerPortOptions = {}) {
    this.#busFactory = options.busFactory ?? defaultBusFactory;
    this.#retryScheduler =
      options.retryScheduler ?? defaultRetryScheduler;
    this.#retryDelaysMs = validateRetryDelays(
      options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    );
    this.#application = options.application ?? new GattApplication();
  }

  readonly #handleMessage = (message: DbusMessageLike): void => {
    if (
      message.path !== DBUS_BUS_PATH ||
      message.interface !== DBUS_INTERFACE ||
      message.member !== "NameOwnerChanged" ||
      !Array.isArray(message.body) ||
      message.body.length < 3 ||
      message.body[0] !== BLUEZ_BUS_NAME ||
      typeof message.body[2] !== "string"
    ) {
      return;
    }

    const available = message.body[2].length > 0;
    void this.#serialize(async () => {
      await this.#handleOwnerChanged(available);
    }).catch((error) => {
      this.#recordError(error);
    });
  };

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  #recordError(error: unknown): void {
    this.#errorsTotal += 1;
    this.#lastErrorCode = errorCode(error);
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
      !this.#bluezOwnerAvailable ||
      this.#registered ||
      this.#retryHandle !== null
    ) {
      return;
    }
    const delayIndex = Math.min(
      Math.max(0, this.#consecutiveRecoveryFailures - 1),
      this.#retryDelaysMs.length - 1
    );
    this.#retryHandle = this.#retryScheduler.set(() => {
      this.#retryHandle = null;
      void this.#serialize(async () => {
        if (
          !this.#desiredRunning ||
          !this.#bluezOwnerAvailable ||
          this.#registered
        ) {
          return;
        }
        try {
          await this.#registerApplication(true);
        } catch {
          this.#scheduleRetry();
        }
      });
    }, this.#retryDelaysMs[delayIndex]);
  }

  #exportApplication(): void {
    if (this.#bus === null || this.#exportedInterfaces.length > 0) {
      return;
    }
    try {
      for (const entry of this.#application.exports()) {
        this.#bus.export(entry.path, entry.interface);
        this.#exportedInterfaces.push(entry);
      }
    } catch (error) {
      this.#unexportApplication();
      throw error;
    }
  }

  #unexportApplication(): void {
    const bus = this.#bus;
    if (bus === null) {
      this.#exportedInterfaces = [];
      return;
    }
    for (const entry of [...this.#exportedInterfaces].reverse()) {
      try {
        bus.unexport(entry.path, entry.interface);
      } catch (error) {
        this.#recordError(error);
      }
    }
    this.#exportedInterfaces = [];
  }

  async #addOwnerMatch(): Promise<void> {
    if (this.#activeMatchRule) {
      return;
    }
    if (this.#dbusInterface === null) {
      throw new BluezGattServerError(
        "DBUS_NOT_CONNECTED",
        "D-Bus control interface is not connected"
      );
    }
    await callMethod<void>(
      this.#dbusInterface,
      "AddMatch",
      NAME_OWNER_RULE
    );
    this.#activeMatchRule = true;
  }

  async #removeOwnerMatch(): Promise<void> {
    if (!this.#activeMatchRule) {
      return;
    }
    if (this.#dbusInterface !== null) {
      await callMethod<void>(
        this.#dbusInterface,
        "RemoveMatch",
        NAME_OWNER_RULE
      );
    }
    this.#activeMatchRule = false;
  }

  async #resolveGattManager(): Promise<DbusInterfaceLike> {
    if (this.#bus === null || this.#adapterPath === null) {
      throw new BluezGattServerError(
        "GATT_PORT_NOT_READY",
        "GATT server bus or adapter is not ready"
      );
    }
    const adapterObject = await this.#bus.getProxyObject(
      BLUEZ_BUS_NAME,
      this.#adapterPath
    );
    return adapterObject.getInterface(GATT_MANAGER_INTERFACE);
  }

  async #registerApplication(recovery: boolean): Promise<void> {
    if (!this.#desiredRunning || this.#registered) {
      return;
    }
    if (!this.#bluezOwnerAvailable) {
      throw new BluezGattServerError(
        "BLUEZ_UNAVAILABLE",
        "org.bluez has no owner on the system bus"
      );
    }

    this.#registrationAttemptsTotal += 1;
    if (recovery) {
      this.#recoveryAttemptsTotal += 1;
    }
    try {
      const manager = await this.#resolveGattManager();
      await callMethod<void>(
        manager,
        "RegisterApplication",
        this.#application.applicationPath,
        {}
      );
      if (!this.#desiredRunning || !this.#bluezOwnerAvailable) {
        try {
          await callMethod<void>(
            manager,
            "UnregisterApplication",
            this.#application.applicationPath
          );
        } catch (error) {
          this.#recordError(error);
        }
        return;
      }
      this.#gattManagerInterface = manager;
      this.#registered = true;
      this.#state = BLUEZ_GATT_SERVER_STATES.REGISTERED;
      this.#consecutiveRecoveryFailures = 0;
      this.#registrationsTotal += 1;
      if (recovery) {
        this.#recoverySuccessesTotal += 1;
      }
    } catch (error) {
      this.#gattManagerInterface = null;
      this.#registered = false;
      this.#registrationFailuresTotal += 1;
      this.#consecutiveRecoveryFailures += 1;
      this.#recordError(error);
      if (recovery && this.#desiredRunning) {
        this.#state = BLUEZ_GATT_SERVER_STATES.RECOVERING;
      }
      throw error;
    }
  }

  async #unregisterApplication(): Promise<void> {
    if (!this.#registered) {
      return;
    }
    const manager = this.#gattManagerInterface;
    this.#registered = false;
    this.#gattManagerInterface = null;
    if (!this.#bluezOwnerAvailable || manager === null) {
      return;
    }

    this.#unregisterAttemptsTotal += 1;
    try {
      await callMethod<void>(
        manager,
        "UnregisterApplication",
        this.#application.applicationPath
      );
      this.#unregistersTotal += 1;
    } catch (error) {
      this.#unregisterFailuresTotal += 1;
      this.#recordError(error);
      throw error;
    }
  }

  async #handleOwnerChanged(available: boolean): Promise<void> {
    if (available === this.#bluezOwnerAvailable) {
      return;
    }
    this.#bluezOwnerAvailable = available;
    if (!this.#desiredRunning) {
      return;
    }

    if (!available) {
      this.#cancelRetry();
      this.#application.resetHelloExchanges();
      if (this.#registered) {
        this.#ownerLossesTotal += 1;
      }
      this.#registered = false;
      this.#gattManagerInterface = null;
      this.#state = BLUEZ_GATT_SERVER_STATES.RECOVERING;
      return;
    }

    this.#state = BLUEZ_GATT_SERVER_STATES.RECOVERING;
    try {
      await this.#registerApplication(true);
    } catch {
      this.#scheduleRetry();
    }
  }

  async #cleanupResources(): Promise<unknown | null> {
    let firstError: unknown | null = null;
    this.#cancelRetry();
    this.#application.resetHelloExchanges();
    try {
      await this.#unregisterApplication();
    } catch (error) {
      firstError = error;
    }
    this.#unexportApplication();
    try {
      await this.#removeOwnerMatch();
    } catch (error) {
      firstError ??= error;
      this.#recordError(error);
      this.#activeMatchRule = false;
    }

    const bus = this.#bus;
    if (bus !== null) {
      bus.off("message", this.#handleMessage);
      bus.disconnect();
    }
    this.#bus = null;
    this.#dbusInterface = null;
    this.#gattManagerInterface = null;
    this.#bluezOwnerAvailable = false;
    this.#registered = false;
    this.#adapterName = null;
    this.#adapterPath = null;
    this.#consecutiveRecoveryFailures = 0;
    return firstError;
  }

  start(input: {
    readonly adapterName: string;
  }): Promise<Readonly<BluezGattServerSnapshot>> {
    return this.#serialize(async () => {
      if (!ADAPTER_PATTERN.test(input.adapterName)) {
        throw new BluezGattServerError(
          "INVALID_ADAPTER",
          `adapterName must match ${ADAPTER_PATTERN.source}`
        );
      }
      if (this.#desiredRunning) {
        if (this.#adapterName !== input.adapterName) {
          throw new BluezGattServerError(
            "GATT_SERVER_ALREADY_RUNNING",
            "GATT server is already bound to a different adapter"
          );
        }
        return this.snapshot();
      }
      if (
        this.#state !== BLUEZ_GATT_SERVER_STATES.STOPPED &&
        this.#state !== BLUEZ_GATT_SERVER_STATES.FAILED
      ) {
        throw new BluezGattServerError(
          "INVALID_GATT_SERVER_STATE",
          `cannot start GATT server from ${this.#state}`
        );
      }

      this.#state = BLUEZ_GATT_SERVER_STATES.STARTING;
      this.#desiredRunning = true;
      this.#adapterName = input.adapterName;
      this.#adapterPath = `/org/bluez/${input.adapterName}`;
      const errorsBeforeStart = this.#errorsTotal;

      try {
        const bus = this.#busFactory();
        this.#bus = bus;
        bus.on("message", this.#handleMessage);
        const dbusObject = await bus.getProxyObject(
          DBUS_BUS_NAME,
          DBUS_BUS_PATH
        );
        this.#dbusInterface = dbusObject.getInterface(DBUS_INTERFACE);
        await this.#addOwnerMatch();
        this.#bluezOwnerAvailable = await callMethod<boolean>(
          this.#dbusInterface,
          "NameHasOwner",
          BLUEZ_BUS_NAME
        );
        if (!this.#bluezOwnerAvailable) {
          throw new BluezGattServerError(
            "BLUEZ_UNAVAILABLE",
            "org.bluez has no owner on the system bus"
          );
        }
        this.#exportApplication();
        await this.#registerApplication(false);
        return this.snapshot();
      } catch (error) {
        this.#desiredRunning = false;
        if (this.#errorsTotal === errorsBeforeStart) {
          this.#recordError(error);
        }
        await this.#cleanupResources();
        this.#state = BLUEZ_GATT_SERVER_STATES.FAILED;
        throw error;
      }
    });
  }

  stop(): Promise<Readonly<BluezGattServerSnapshot>> {
    return this.#serialize(async () => {
      if (
        !this.#desiredRunning &&
        this.#bus === null &&
        this.#exportedInterfaces.length === 0
      ) {
        this.#state = BLUEZ_GATT_SERVER_STATES.STOPPED;
        return this.snapshot();
      }

      this.#state = BLUEZ_GATT_SERVER_STATES.STOPPING;
      this.#desiredRunning = false;
      const cleanupError = await this.#cleanupResources();
      if (cleanupError !== null) {
        this.#state = BLUEZ_GATT_SERVER_STATES.FAILED;
        throw cleanupError;
      }
      this.#state = BLUEZ_GATT_SERVER_STATES.STOPPED;
      return this.snapshot();
    });
  }

  snapshot(): Readonly<BluezGattServerSnapshot> {
    return Object.freeze({
      state: this.#state,
      desiredRunning: this.#desiredRunning,
      adapterName: this.#adapterName,
      adapterPath: this.#adapterPath,
      busConnected: this.#bus !== null,
      bluezOwnerAvailable: this.#bluezOwnerAvailable,
      applicationExported: this.#exportedInterfaces.length > 0,
      registered: this.#registered,
      retryScheduled: this.#retryHandle !== null,
      activeMatchRules: this.#activeMatchRule ? 1 : 0,
      exportedInterfaceCount: this.#exportedInterfaces.length,
      registrationAttemptsTotal: this.#registrationAttemptsTotal,
      registrationsTotal: this.#registrationsTotal,
      registrationFailuresTotal: this.#registrationFailuresTotal,
      unregisterAttemptsTotal: this.#unregisterAttemptsTotal,
      unregistersTotal: this.#unregistersTotal,
      unregisterFailuresTotal: this.#unregisterFailuresTotal,
      ownerLossesTotal: this.#ownerLossesTotal,
      recoveryAttemptsTotal: this.#recoveryAttemptsTotal,
      recoverySuccessesTotal: this.#recoverySuccessesTotal,
      errorsTotal: this.#errorsTotal,
      lastErrorCode: this.#lastErrorCode,
      application: this.#application.snapshot()
    });
  }
}
