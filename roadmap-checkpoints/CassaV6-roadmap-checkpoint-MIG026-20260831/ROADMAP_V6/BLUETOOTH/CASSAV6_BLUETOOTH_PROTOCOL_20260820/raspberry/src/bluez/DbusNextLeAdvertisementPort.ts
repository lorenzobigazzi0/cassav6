import {
  Variant,
  interface as dbusInterface,
  systemBus
} from "@jellybrick/dbus-next";

import {
  GATT_SERVICE_UUID,
  decodeNodeAdvertisement
} from "../../../shared/protocol/advertisement-v1.mjs";
import {
  LeAdvertiserError,
  type LeAdvertisementPortSnapshotV1,
  type LeAdvertisementPortV1
} from "./LeAdvertiser.js";
import { LE_ADVERTISEMENT_DBUS_OPERATION_TIMEOUT_MS } from "../routing/RouteHealthBudgetV1.js";

const BLUEZ_BUS_NAME = "org.bluez";
const DBUS_BUS_NAME = "org.freedesktop.DBus";
const DBUS_BUS_PATH = "/org/freedesktop/DBus";
const DBUS_INTERFACE = "org.freedesktop.DBus";
const LE_ADVERTISEMENT_INTERFACE = "org.bluez.LEAdvertisement1";
const LE_ADVERTISING_MANAGER_INTERFACE = "org.bluez.LEAdvertisingManager1";
const ADVERTISEMENT_PATH =
  "/com/cassav6/bluetooth/runtime/advertisement_v1";
const ADAPTER_PATTERN = /^hci[0-9]+$/;
const NAME_OWNER_RULE =
  "type='signal',sender='org.freedesktop.DBus'," +
  "interface='org.freedesktop.DBus',member='NameOwnerChanged'," +
  "arg0='org.bluez'";
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([250, 500, 1_000, 2_000, 5_000]);

export const BLUEZ_LE_ADVERTISEMENT_STATES = Object.freeze({
  STOPPED: "STOPPED",
  STARTING: "STARTING",
  REGISTERED: "REGISTERED",
  RECOVERING: "RECOVERING",
  STOPPING: "STOPPING",
  FAILED: "FAILED"
} as const);

type BluezLeAdvertisementState =
  (typeof BLUEZ_LE_ADVERTISEMENT_STATES)[keyof typeof BLUEZ_LE_ADVERTISEMENT_STATES];
type DbusServiceInterface = InstanceType<typeof dbusInterface.Interface>;

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
  getProxyObject(name: string, path: string): Promise<DbusProxyObjectLike>;
  on(eventName: "message", listener: (message: DbusMessageLike) => void): this;
  off(eventName: "message", listener: (message: DbusMessageLike) => void): this;
  export(path: string, serviceInterface: DbusServiceInterface): void;
  unexport(path: string, serviceInterface?: DbusServiceInterface | null): void;
  disconnect(): void;
}

export interface LeAdvertisementRetrySchedulerV1 {
  set(handler: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface DbusNextLeAdvertisementPortOptionsV1 {
  readonly busFactory?: () => DbusMessageBusLike;
  readonly retryScheduler?: LeAdvertisementRetrySchedulerV1;
  readonly retryDelaysMs?: readonly number[];
  readonly operationTimeoutMs?: number;
}

const defaultRetryScheduler: LeAdvertisementRetrySchedulerV1 = Object.freeze({
  set(handler: () => void, delayMs: number) {
    return setTimeout(handler, delayMs);
  },
  clear(handle: unknown) {
    clearTimeout(handle as NodeJS.Timeout);
  }
});

function defaultBusFactory(): DbusMessageBusLike {
  return systemBus() as unknown as DbusMessageBusLike;
}

function useConfiguredPrototypeMembers(value: DbusServiceInterface): void {
  // The pinned D-Bus build shadows configureMembers maps on instances.
  delete value.$properties;
  delete value.$methods;
  delete value.$signals;
}

function errorCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name : "UNKNOWN_ERROR";
}

function validatePayload(value: Uint8Array): Buffer {
  try {
    decodeNodeAdvertisement(value);
  } catch (error) {
    throw new LeAdvertiserError(
      "INVALID_ADVERTISEMENT_PAYLOAD",
      "BlueZ advertisement payload is not protocol v1",
      { cause: error }
    );
  }
  return Buffer.from(value);
}

function validateRetryDelays(values: readonly number[]): readonly number[] {
  if (
    values.length === 0 ||
    values.some(
      (value) => !Number.isSafeInteger(value) || value < 0 || value > 60_000
    )
  ) {
    throw new LeAdvertiserError(
      "INVALID_RETRY_POLICY",
      "retry delays must be integers from 0 to 60000"
    );
  }
  return Object.freeze([...values]);
}

class LeAdvertisementInterfaceV1 extends dbusInterface.Interface {
  readonly #generation: number;
  readonly #payload: Buffer;
  readonly #onRelease: (generation: number) => void;

  constructor(input: Readonly<{
    generation: number;
    payload: Uint8Array;
    onRelease: (generation: number) => void;
  }>) {
    super(LE_ADVERTISEMENT_INTERFACE);
    useConfiguredPrototypeMembers(this);
    this.#generation = input.generation;
    this.#payload = validatePayload(input.payload);
    this.#onRelease = input.onRelease;
  }

  get Type(): string {
    return "peripheral";
  }

  get ServiceData(): Readonly<Record<string, Variant>> {
    return Object.freeze({
      [GATT_SERVICE_UUID]: new Variant("ay", Buffer.from(this.#payload))
    });
  }

  get Discoverable(): boolean {
    return true;
  }

  get DiscoverableTimeout(): number {
    return 0;
  }

  Release(): void {
    this.#onRelease(this.#generation);
  }

  clear(): void {
    this.#payload.fill(0);
  }
}

LeAdvertisementInterfaceV1.configureMembers({
  properties: {
    Type: { signature: "s", access: dbusInterface.ACCESS_READ },
    ServiceData: { signature: "a{sv}", access: dbusInterface.ACCESS_READ },
    Discoverable: { signature: "b", access: dbusInterface.ACCESS_READ },
    DiscoverableTimeout: { signature: "q", access: dbusInterface.ACCESS_READ }
  },
  methods: {
    Release: { inSignature: "", outSignature: "" }
  }
});

export class DbusNextLeAdvertisementPortV1
implements LeAdvertisementPortV1 {
  readonly #busFactory: () => DbusMessageBusLike;
  readonly #retryScheduler: LeAdvertisementRetrySchedulerV1;
  readonly #retryDelaysMs: readonly number[];
  readonly #operationTimeoutMs: number;
  #bus: DbusMessageBusLike | null = null;
  #dbusInterface: DbusInterfaceLike | null = null;
  #managerInterface: DbusInterfaceLike | null = null;
  #advertisementInterface: LeAdvertisementInterfaceV1 | null = null;
  #state: BluezLeAdvertisementState = BLUEZ_LE_ADVERTISEMENT_STATES.STOPPED;
  #desiredRunning = false;
  #adapterName: string | null = null;
  #adapterPath: string | null = null;
  #bluezOwnerAvailable = false;
  #registered = false;
  #activeMatchRule = false;
  #retryHandle: unknown | null = null;
  #desiredPayload: Buffer | null = null;
  #interfaceGeneration = 0;
  #registeredGeneration: number | null = null;
  #consecutiveRecoveryFailures = 0;
  #registrationsTotal = 0;
  #replacementsTotal = 0;
  #ownerLossesTotal = 0;
  #errorsTotal = 0;
  #lastErrorCode: string | null = null;
  #operation: Promise<void> = Promise.resolve();

  constructor(options: DbusNextLeAdvertisementPortOptionsV1 = {}) {
    this.#busFactory = options.busFactory ?? defaultBusFactory;
    this.#retryScheduler = options.retryScheduler ?? defaultRetryScheduler;
    this.#retryDelaysMs = validateRetryDelays(
      options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    );
    this.#operationTimeoutMs =
      options.operationTimeoutMs ?? LE_ADVERTISEMENT_DBUS_OPERATION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#operationTimeoutMs) ||
      this.#operationTimeoutMs < 100 ||
      this.#operationTimeoutMs > 1_000
    ) {
      throw new LeAdvertiserError(
        "INVALID_OPERATION_TIMEOUT",
        "D-Bus operation timeout must be from 100 to 1000 ms"
      );
    }
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
    void this.#serialize(() => this.#handleOwnerChanged(available)).catch((error) => {
      this.#recordError(error);
    });
  };

  start(input: Readonly<{
    adapterName: string;
    payload: Uint8Array;
  }>): Promise<Readonly<LeAdvertisementPortSnapshotV1>> {
    return this.#serialize(async () => {
      if (!ADAPTER_PATTERN.test(input.adapterName)) {
        throw new LeAdvertiserError("INVALID_ADAPTER", "adapterName is invalid");
      }
      const payload = validatePayload(input.payload);
      if (this.#desiredRunning) {
        const same =
          this.#adapterName === input.adapterName &&
          this.#desiredPayload?.equals(payload) === true;
        payload.fill(0);
        if (!same) {
          throw new LeAdvertiserError(
            "ADVERTISEMENT_ALREADY_RUNNING",
            "advertisement is already running with another binding"
          );
        }
        return this.snapshot();
      }
      if (
        this.#state !== BLUEZ_LE_ADVERTISEMENT_STATES.STOPPED &&
        this.#state !== BLUEZ_LE_ADVERTISEMENT_STATES.FAILED
      ) {
        payload.fill(0);
        throw new LeAdvertiserError(
          "INVALID_ADVERTISEMENT_STATE",
          `cannot start advertisement from ${this.#state}`
        );
      }
      this.#state = BLUEZ_LE_ADVERTISEMENT_STATES.STARTING;
      this.#desiredRunning = true;
      this.#adapterName = input.adapterName;
      this.#adapterPath = `/org/bluez/${input.adapterName}`;
      this.#desiredPayload = payload;
      try {
        const bus = this.#busFactory();
        this.#bus = bus;
        bus.on("message", this.#handleMessage);
        const dbusObject = await this.#bounded(
          bus.getProxyObject(DBUS_BUS_NAME, DBUS_BUS_PATH),
          "DBUS_PROXY_TIMEOUT"
        );
        this.#dbusInterface = dbusObject.getInterface(DBUS_INTERFACE);
        await this.#addOwnerMatch();
        this.#bluezOwnerAvailable = await this.#call<boolean>(
          this.#dbusInterface,
          "NameHasOwner",
          BLUEZ_BUS_NAME
        );
        if (!this.#bluezOwnerAvailable) {
          throw new LeAdvertiserError(
            "BLUEZ_UNAVAILABLE",
            "org.bluez has no owner on the system bus"
          );
        }
        this.#exportAdvertisement();
        await this.#register(false);
        return this.snapshot();
      } catch (error) {
        this.#recordError(error);
        this.#desiredRunning = false;
        await this.#cleanup();
        this.#state = BLUEZ_LE_ADVERTISEMENT_STATES.FAILED;
        throw error;
      }
    });
  }

  replace(payloadValue: Uint8Array): Promise<Readonly<LeAdvertisementPortSnapshotV1>> {
    return this.#serialize(async () => {
      const payload = validatePayload(payloadValue);
      if (!this.#desiredRunning || this.#desiredPayload === null) {
        payload.fill(0);
        throw new LeAdvertiserError(
          "ADVERTISEMENT_NOT_RUNNING",
          "cannot replace a stopped advertisement"
        );
      }
      if (this.#desiredPayload.equals(payload)) {
        payload.fill(0);
        return this.snapshot();
      }
      try {
        if (this.#bluezOwnerAvailable && this.#registered) {
          await this.#unregister();
        }
        this.#unexportAdvertisement();
        this.#desiredPayload.fill(0);
        this.#desiredPayload = payload;
        this.#exportAdvertisement();
        if (this.#bluezOwnerAvailable) {
          await this.#register(false);
        } else {
          this.#state = BLUEZ_LE_ADVERTISEMENT_STATES.RECOVERING;
        }
        this.#replacementsTotal += 1;
        return this.snapshot();
      } catch (error) {
        this.#recordError(error);
        this.#desiredRunning = false;
        await this.#cleanup();
        this.#state = BLUEZ_LE_ADVERTISEMENT_STATES.FAILED;
        throw error;
      }
    });
  }

  stop(): Promise<Readonly<LeAdvertisementPortSnapshotV1>> {
    return this.#serialize(async () => {
      if (!this.#desiredRunning && this.#bus === null) {
        this.#state = BLUEZ_LE_ADVERTISEMENT_STATES.STOPPED;
        return this.snapshot();
      }
      this.#state = BLUEZ_LE_ADVERTISEMENT_STATES.STOPPING;
      this.#desiredRunning = false;
      const cleanupError = await this.#cleanup();
      if (cleanupError !== null) {
        this.#state = BLUEZ_LE_ADVERTISEMENT_STATES.FAILED;
        throw cleanupError;
      }
      this.#state = BLUEZ_LE_ADVERTISEMENT_STATES.STOPPED;
      return this.snapshot();
    });
  }

  snapshot(): Readonly<LeAdvertisementPortSnapshotV1> {
    return Object.freeze({
      state: this.#state,
      desiredRunning: this.#desiredRunning,
      registered: this.#registered,
      bluezOwnerAvailable: this.#bluezOwnerAvailable,
      retryScheduled: this.#retryHandle !== null,
      registrationsTotal: this.#registrationsTotal,
      replacementsTotal: this.#replacementsTotal,
      ownerLossesTotal: this.#ownerLossesTotal,
      errorsTotal: this.#errorsTotal,
      lastErrorCode: this.#lastErrorCode
    });
  }

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

  async #bounded<T>(promise: Promise<T>, code: string): Promise<T> {
    let timeout: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new LeAdvertiserError(code, "local D-Bus operation timed out"));
          }, this.#operationTimeoutMs);
        })
      ]);
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  }

  async #call<T>(
    target: DbusInterfaceLike,
    methodName: string,
    ...args: readonly unknown[]
  ): Promise<T> {
    const method = target[methodName];
    if (typeof method !== "function") {
      throw new LeAdvertiserError(
        "MISSING_DBUS_METHOD",
        `${methodName} is not available on D-Bus`
      );
    }
    return this.#bounded(
      Promise.resolve(method.apply(target, args) as T),
      "DBUS_OPERATION_TIMEOUT"
    );
  }

  async #addOwnerMatch(): Promise<void> {
    if (this.#activeMatchRule) return;
    if (this.#dbusInterface === null) {
      throw new LeAdvertiserError("DBUS_NOT_CONNECTED", "D-Bus is not connected");
    }
    await this.#call<void>(this.#dbusInterface, "AddMatch", NAME_OWNER_RULE);
    this.#activeMatchRule = true;
  }

  async #removeOwnerMatch(): Promise<void> {
    if (!this.#activeMatchRule) return;
    if (this.#dbusInterface !== null) {
      await this.#call<void>(this.#dbusInterface, "RemoveMatch", NAME_OWNER_RULE);
    }
    this.#activeMatchRule = false;
  }

  #exportAdvertisement(): void {
    if (
      this.#bus === null ||
      this.#desiredPayload === null ||
      this.#advertisementInterface !== null
    ) {
      return;
    }
    this.#interfaceGeneration += 1;
    const generation = this.#interfaceGeneration;
    const advertisement = new LeAdvertisementInterfaceV1({
      generation,
      payload: this.#desiredPayload,
      onRelease: (releasedGeneration) => this.#handleRelease(releasedGeneration)
    });
    this.#bus.export(ADVERTISEMENT_PATH, advertisement);
    this.#advertisementInterface = advertisement;
  }

  #unexportAdvertisement(): void {
    const advertisement = this.#advertisementInterface;
    if (advertisement === null) return;
    try {
      this.#bus?.unexport(ADVERTISEMENT_PATH, advertisement);
    } catch (error) {
      this.#recordError(error);
    }
    advertisement.clear();
    this.#advertisementInterface = null;
    this.#registeredGeneration = null;
  }

  async #resolveManager(): Promise<DbusInterfaceLike> {
    if (this.#bus === null || this.#adapterPath === null) {
      throw new LeAdvertiserError(
        "ADVERTISEMENT_PORT_NOT_READY",
        "advertisement bus or adapter is not ready"
      );
    }
    const adapterObject = await this.#bounded(
      this.#bus.getProxyObject(BLUEZ_BUS_NAME, this.#adapterPath),
      "DBUS_PROXY_TIMEOUT"
    );
    return adapterObject.getInterface(LE_ADVERTISING_MANAGER_INTERFACE);
  }

  async #register(recovery: boolean): Promise<void> {
    if (!this.#desiredRunning || this.#registered) return;
    if (!this.#bluezOwnerAvailable || this.#advertisementInterface === null) {
      throw new LeAdvertiserError(
        "BLUEZ_UNAVAILABLE",
        "BlueZ cannot register the advertisement"
      );
    }
    try {
      const manager = await this.#resolveManager();
      await this.#call<void>(
        manager,
        "RegisterAdvertisement",
        ADVERTISEMENT_PATH,
        {}
      );
      if (!this.#desiredRunning || !this.#bluezOwnerAvailable) {
        try {
          await this.#call<void>(
            manager,
            "UnregisterAdvertisement",
            ADVERTISEMENT_PATH
          );
        } catch (error) {
          this.#recordError(error);
        }
        return;
      }
      this.#managerInterface = manager;
      this.#registered = true;
      this.#registeredGeneration = this.#interfaceGeneration;
      this.#consecutiveRecoveryFailures = 0;
      this.#registrationsTotal += 1;
      this.#state = BLUEZ_LE_ADVERTISEMENT_STATES.REGISTERED;
    } catch (error) {
      this.#managerInterface = null;
      this.#registered = false;
      this.#registeredGeneration = null;
      this.#consecutiveRecoveryFailures += 1;
      this.#recordError(error);
      if (recovery && this.#desiredRunning) {
        this.#state = BLUEZ_LE_ADVERTISEMENT_STATES.RECOVERING;
      }
      throw error;
    }
  }

  async #unregister(): Promise<void> {
    if (!this.#registered) return;
    const manager = this.#managerInterface;
    this.#registered = false;
    this.#registeredGeneration = null;
    this.#managerInterface = null;
    if (!this.#bluezOwnerAvailable || manager === null) return;
    await this.#call<void>(
      manager,
      "UnregisterAdvertisement",
      ADVERTISEMENT_PATH
    );
  }

  #handleRelease(generation: number): void {
    void this.#serialize(async () => {
      if (
        generation !== this.#registeredGeneration ||
        !this.#registered ||
        !this.#desiredRunning
      ) {
        return;
      }
      this.#registered = false;
      this.#registeredGeneration = null;
      this.#managerInterface = null;
      this.#state = BLUEZ_LE_ADVERTISEMENT_STATES.RECOVERING;
      this.#scheduleRetry();
    });
  }

  async #handleOwnerChanged(available: boolean): Promise<void> {
    if (available === this.#bluezOwnerAvailable) return;
    this.#bluezOwnerAvailable = available;
    if (!this.#desiredRunning) return;
    if (!available) {
      this.#cancelRetry();
      if (this.#registered) this.#ownerLossesTotal += 1;
      this.#registered = false;
      this.#registeredGeneration = null;
      this.#managerInterface = null;
      this.#state = BLUEZ_LE_ADVERTISEMENT_STATES.RECOVERING;
      return;
    }
    this.#state = BLUEZ_LE_ADVERTISEMENT_STATES.RECOVERING;
    try {
      await this.#register(true);
    } catch {
      this.#scheduleRetry();
    }
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
    const index = Math.min(
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
          await this.#register(true);
        } catch {
          this.#scheduleRetry();
        }
      });
    }, this.#retryDelaysMs[index]);
  }

  #cancelRetry(): void {
    if (this.#retryHandle === null) return;
    this.#retryScheduler.clear(this.#retryHandle);
    this.#retryHandle = null;
  }

  async #cleanup(): Promise<unknown | null> {
    let firstError: unknown | null = null;
    this.#cancelRetry();
    try {
      await this.#unregister();
    } catch (error) {
      firstError = error;
      this.#recordError(error);
    }
    this.#unexportAdvertisement();
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
      try {
        bus.disconnect();
      } catch (error) {
        firstError ??= error;
        this.#recordError(error);
      }
    }
    this.#desiredPayload?.fill(0);
    this.#desiredPayload = null;
    this.#bus = null;
    this.#dbusInterface = null;
    this.#managerInterface = null;
    this.#adapterName = null;
    this.#adapterPath = null;
    this.#bluezOwnerAvailable = false;
    this.#registered = false;
    this.#registeredGeneration = null;
    this.#consecutiveRecoveryFailures = 0;
    return firstError;
  }
}
