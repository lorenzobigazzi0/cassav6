import {
  DBusError,
  Variant,
  interface as dbusInterface
} from "@jellybrick/dbus-next";

import {
  CassaGattService,
  type CassaGattCharacteristic
} from "../gatt/CassaGattService.js";
import {
  GattHelloExchangeError,
  GattHelloExchangeV1
} from "../session/GattHelloExchangeV1.js";
import {
  GATT_RELIABLE_TRANSMITTERS,
  GattReliableDataPlaneError,
  type GattReliableDataPlaneV1,
  type GattReliableTransmitter
} from "../session/GattReliableDataPlaneV1.js";
import type { ReliableFrameType } from "../protocol/FrameCodec.js";

export const DBUS_OBJECT_MANAGER_INTERFACE =
  "org.freedesktop.DBus.ObjectManager";
export const BLUEZ_GATT_SERVICE_INTERFACE = "org.bluez.GattService1";
export const BLUEZ_GATT_CHARACTERISTIC_INTERFACE =
  "org.bluez.GattCharacteristic1";

type DbusServiceInterface = InstanceType<typeof dbusInterface.Interface>;
type ManagedProperties = Readonly<Record<string, Variant>>;
type ManagedInterfaces = Readonly<Record<string, ManagedProperties>>;
export type GattManagedObjects = Readonly<
  Record<string, ManagedInterfaces>
>;

export interface GattApplicationExport {
  readonly path: string;
  readonly interface: DbusServiceInterface;
}

interface AccessMetrics {
  readDeniedTotal: number;
  writeDeniedTotal: number;
  notifyDeniedTotal: number;
}

function useConfiguredPrototypeMembers(
  dbusInterfaceInstance: DbusServiceInterface
): void {
  // The pinned D-Bus build creates empty own maps that shadow the maps
  // installed by configureMembers on each subclass prototype.
  delete dbusInterfaceInstance.$properties;
  delete dbusInterfaceInstance.$methods;
  delete dbusInterfaceInstance.$signals;
}

function deniedAccess(operation: string): DBusError {
  return new DBusError(
    "org.bluez.Error.NotAuthorized",
    `${operation} requires an authenticated B5 session`
  );
}

function helloAccessError(error: unknown): DBusError {
  if (!(error instanceof GattHelloExchangeError)) {
    return new DBusError(
      "org.bluez.Error.Failed",
      "HELLO exchange failed"
    );
  }
  const type = (() => {
    switch (error.code) {
      case "FEATURE_DISABLED":
      case "INVALID_CLIENT_BINDING":
      case "DUPLICATE_SESSION":
      case "HELLO_BINDING_CONFLICT":
        return "org.bluez.Error.NotAuthorized";
      case "INVALID_DEVICE_CONTEXT":
      case "INVALID_MTU":
      case "INVALID_OFFSET":
        return "org.bluez.Error.InvalidArguments";
      case "INVALID_WIRE_LENGTH":
        return "org.bluez.Error.InvalidValueLength";
      case "HELLO_MTU_TOO_SMALL":
        return "org.bluez.Error.NotSupported";
      case "HELLO_RESPONSE_NOT_READY":
        return "org.bluez.Error.NotPermitted";
      case "HELLO_CAPACITY_REACHED":
        return "org.bluez.Error.InProgress";
      default:
        return "org.bluez.Error.Failed";
    }
  })();
  return new DBusError(type, "HELLO exchange rejected");
}

function authAccessError(error: unknown): DBusError {
  if (error instanceof DBusError) {
    return error;
  }
  if (!(error instanceof GattHelloExchangeError)) {
    return new DBusError(
      "org.bluez.Error.Failed",
      "authentication exchange failed"
    );
  }
  const type = (() => {
    switch (error.code) {
      case "AUTH_FEATURE_DISABLED":
      case "AUTH_CONTEXT_NOT_READY":
      case "AUTH_BINDING_CONFLICT":
      case "AUTH_FINISH_BINDING_CONFLICT":
      case "CLIENT_SIGNATURE_INVALID":
      case "DEVICE_IDENTITY_REJECTED":
      case "DIRECT_CONTROL_FEATURE_DISABLED":
      case "DIRECT_CONTROL_AUTH_REQUIRED":
      case "CLIENT_KEY_BINDER_INVALID":
      case "CLIENT_KEY_CONFIRMATION_INVALID":
        return "org.bluez.Error.NotAuthorized";
      case "INVALID_DEVICE_CONTEXT":
      case "INVALID_OFFSET":
        return "org.bluez.Error.InvalidArguments";
      case "INVALID_AUTH_WIRE":
      case "INVALID_WIRE_LENGTH":
        return "org.bluez.Error.InvalidValueLength";
      case "AUTH_MTU_TOO_SMALL":
      case "DIRECT_CONTROL_MTU_TOO_SMALL":
        return "org.bluez.Error.NotSupported";
      case "AUTH_IN_PROGRESS":
      case "DIRECT_CONTROL_IN_PROGRESS":
        return "org.bluez.Error.InProgress";
      case "DIRECT_CONTROL_KEY_ORDER_INVALID":
      case "DIRECT_CONTROL_CLOSE_ORDER_INVALID":
      case "DIRECT_CONTROL_CLOSE_ACK_ORDER_INVALID":
      case "UNSOLICITED_CONTROL_PONG":
        return "org.bluez.Error.NotPermitted";
      default:
        return "org.bluez.Error.Failed";
    }
  })();
  return new DBusError(type, "authentication exchange rejected");
}

function dataAccessError(error: unknown): DBusError {
  if (error instanceof DBusError) return error;
  if (error instanceof GattReliableDataPlaneError) {
    const type = (() => {
      switch (error.code) {
        case "DATA_PLANE_DISABLED":
        case "ACK_SUBSCRIPTION_REQUIRED":
        case "DATA_SUBSCRIPTION_REQUIRED":
        case "TRANSMITTER_NOT_SUBSCRIBED":
        case "RELIABLE_CHANNEL_NOT_AUTHORIZED":
        case "RELIABLE_CHANNEL_NOT_BOUND":
        case "SESSION_ARBITRATION_CONFLICT":
          return "org.bluez.Error.NotAuthorized";
        case "ACK_RESERVED":
        case "INVALID_TRANSMITTER":
          return "org.bluez.Error.InvalidArguments";
        default:
          return "org.bluez.Error.Failed";
      }
    })();
    return new DBusError(type, "reliable data plane rejected the operation");
  }
  return new DBusError(
    "org.bluez.Error.Failed",
    "reliable data plane failed"
  );
}

function optionValue(
  options: Readonly<Record<string, Variant>>,
  name: string,
  signature: string
): unknown {
  const option = options[name];
  if (!(option instanceof Variant) || option.signature !== signature) {
    throw new GattHelloExchangeError(
      "INVALID_DEVICE_CONTEXT",
      `missing or invalid ${name} option`
    );
  }
  return option.value;
}

function optionalOffset(
  options: Readonly<Record<string, Variant>>
): number {
  const option = options.offset;
  if (option === undefined) {
    return 0;
  }
  if (
    !(option instanceof Variant) ||
    option.signature !== "q" ||
    !Number.isSafeInteger(option.value)
  ) {
    throw new GattHelloExchangeError(
      "INVALID_OFFSET",
      "invalid offset option"
    );
  }
  return option.value as number;
}

class ObjectManagerInterface extends dbusInterface.Interface {
  readonly #objects: () => GattManagedObjects;

  constructor(objects: () => GattManagedObjects) {
    super(DBUS_OBJECT_MANAGER_INTERFACE);
    useConfiguredPrototypeMembers(this);
    this.#objects = objects;
  }

  GetManagedObjects(): GattManagedObjects {
    return this.#objects();
  }
}

ObjectManagerInterface.configureMembers({
  methods: {
    GetManagedObjects: {
      inSignature: "",
      outSignature: "a{oa{sa{sv}}}"
    }
  }
});

class GattServiceInterface extends dbusInterface.Interface {
  readonly #service: CassaGattService;

  constructor(service: CassaGattService) {
    super(BLUEZ_GATT_SERVICE_INTERFACE);
    useConfiguredPrototypeMembers(this);
    this.#service = service;
  }

  get UUID(): string {
    return this.#service.uuid;
  }

  get Primary(): boolean {
    return this.#service.primary;
  }
}

GattServiceInterface.configureMembers({
  properties: {
    UUID: { signature: "s", access: dbusInterface.ACCESS_READ },
    Primary: { signature: "b", access: dbusInterface.ACCESS_READ }
  }
});

class GattCharacteristicInterface extends dbusInterface.Interface {
  readonly #characteristic: Readonly<CassaGattCharacteristic>;
  readonly #metrics: AccessMetrics;
  readonly #helloExchange: GattHelloExchangeV1;
  readonly #authTransmitter: () => GattCharacteristicInterface | null;
  readonly #dataPlane: GattReliableDataPlaneV1 | null;
  readonly #onControlStopped: () => void;
  #value = Buffer.alloc(0);
  #notifying = false;

  constructor(
    characteristic: Readonly<CassaGattCharacteristic>,
    metrics: AccessMetrics,
    helloExchange: GattHelloExchangeV1,
    authTransmitter: () => GattCharacteristicInterface | null,
    dataPlane: GattReliableDataPlaneV1 | null,
    onControlStopped: () => void
  ) {
    super(BLUEZ_GATT_CHARACTERISTIC_INTERFACE);
    useConfiguredPrototypeMembers(this);
    this.#characteristic = characteristic;
    this.#metrics = metrics;
    this.#helloExchange = helloExchange;
    this.#authTransmitter = authTransmitter;
    this.#dataPlane = dataPlane;
    this.#onControlStopped = onControlStopped;
  }

  get UUID(): string {
    return this.#characteristic.uuid;
  }

  get Service(): string {
    return this.#characteristic.path.slice(
      0,
      this.#characteristic.path.lastIndexOf("/")
    );
  }

  get Flags(): readonly string[] {
    return this.#characteristic.flags;
  }

  get Value(): Buffer {
    return ["controlTx", "dataTx", "ackTx"].includes(
      this.#characteristic.id
    )
      ? Buffer.from(this.#value)
      : Buffer.alloc(0);
  }

  get Notifying(): boolean {
    return ["controlTx", "dataTx", "ackTx"].includes(
      this.#characteristic.id
    ) && this.#notifying;
  }

  ReadValue(options: Readonly<Record<string, Variant>>): Buffer {
    if (
      this.#characteristic.id !== "hello" ||
      !this.#helloExchange.enabled
    ) {
      this.#metrics.readDeniedTotal += 1;
      throw deniedAccess("ReadValue");
    }
    try {
      return this.#helloExchange.read({
        devicePath: optionValue(options, "device", "o") as string,
        offset: optionalOffset(options)
      });
    } catch (error) {
      this.#metrics.readDeniedTotal += 1;
      throw helloAccessError(error);
    }
  }

  WriteValue(
    value: Uint8Array,
    options: Readonly<Record<string, Variant>>
  ): void | Promise<void> {
    if (
      this.#characteristic.id === "controlRx" &&
      this.#helloExchange.mutualAuthEnabled
    ) {
      return this.#writeControl(value, options);
    }
    if (
      this.#characteristic.id === "dataRx" &&
      this.#dataPlane?.enabled === true
    ) {
      return this.#writeData(value, options);
    }
    if (
      this.#characteristic.id !== "hello" ||
      !this.#helloExchange.enabled
    ) {
      this.#metrics.writeDeniedTotal += 1;
      throw deniedAccess("WriteValue");
    }
    try {
      if (optionalOffset(options) !== 0) {
        throw new GattHelloExchangeError(
          "INVALID_OFFSET",
          "B5.5 HELLO supports offset zero only"
        );
      }
      this.#helloExchange.write({
        devicePath: optionValue(options, "device", "o") as string,
        mtu: optionValue(options, "mtu", "q") as number,
        value
      });
    } catch (error) {
      this.#metrics.writeDeniedTotal += 1;
      throw helloAccessError(error);
    }
  }

  async #writeControl(
    value: Uint8Array,
    options: Readonly<Record<string, Variant>>
  ): Promise<void> {
    try {
      if (optionalOffset(options) !== 0) {
        throw new GattHelloExchangeError(
          "INVALID_OFFSET",
          "B5.6 authentication supports offset zero only"
        );
      }
      const transmitter = this.#authTransmitter();
      if (transmitter === null || !transmitter.Notifying) {
        throw new DBusError(
          "org.bluez.Error.NotPermitted",
          "subscribe to controlTx before authentication"
        );
      }
      const response = await this.#helloExchange.writeControl({
        devicePath: optionValue(options, "device", "o") as string,
        value
      });
      if (response !== null) {
        transmitter.publishControlResponse(response);
      }
    } catch (error) {
      this.#metrics.writeDeniedTotal += 1;
      throw authAccessError(error);
    }
  }

  async #writeData(
    value: Uint8Array,
    options: Readonly<Record<string, Variant>>
  ): Promise<void> {
    try {
      if (optionalOffset(options) !== 0) {
        throw new DBusError(
          "org.bluez.Error.InvalidArguments",
          "reliable data supports offset zero only"
        );
      }
      if (this.#dataPlane === null) {
        throw deniedAccess("WriteValue");
      }
      await this.#dataPlane.receive(
        optionValue(options, "device", "o") as string,
        value
      );
    } catch (error) {
      this.#metrics.writeDeniedTotal += 1;
      throw dataAccessError(error);
    }
  }

  #reliableTransmitter(): GattReliableTransmitter | null {
    if (this.#characteristic.id === "dataTx") {
      return GATT_RELIABLE_TRANSMITTERS.DATA;
    }
    if (this.#characteristic.id === "ackTx") {
      return GATT_RELIABLE_TRANSMITTERS.ACK;
    }
    return null;
  }

  StartNotify(): void {
    const reliableTransmitter = this.#reliableTransmitter();
    const controlAllowed =
      this.#characteristic.id === "controlTx" &&
      this.#helloExchange.mutualAuthEnabled;
    const reliableAllowed =
      reliableTransmitter !== null && this.#dataPlane?.enabled === true;
    if (!controlAllowed && !reliableAllowed) {
      this.#metrics.notifyDeniedTotal += 1;
      throw deniedAccess("StartNotify");
    }
    if (reliableTransmitter !== null) {
      this.#dataPlane?.setSubscription(reliableTransmitter, true);
    }
    if (this.#notifying) {
      return;
    }
    this.#notifying = true;
    dbusInterface.Interface.emitPropertiesChanged(this, {
      Notifying: true
    });
  }

  StopNotify(): void {
    const reliableTransmitter = this.#reliableTransmitter();
    const controlAllowed =
      this.#characteristic.id === "controlTx" &&
      this.#helloExchange.mutualAuthEnabled;
    const reliableAllowed =
      reliableTransmitter !== null && this.#dataPlane?.enabled === true;
    if (!controlAllowed && !reliableAllowed) {
      this.#metrics.notifyDeniedTotal += 1;
      throw deniedAccess("StopNotify");
    }
    if (!this.#notifying) {
      return;
    }
    this.#notifying = false;
    this.#clearValue();
    if (reliableTransmitter !== null) {
      this.#dataPlane?.setSubscription(reliableTransmitter, false);
    } else {
      this.#helloExchange.reset();
      this.#onControlStopped();
    }
    dbusInterface.Interface.emitPropertiesChanged(this, {
      Value: Buffer.alloc(0),
      Notifying: false
    });
  }

  publishControlResponse(value: Uint8Array): void {
    if (this.#characteristic.id !== "controlTx" || !this.#notifying) {
      throw new GattHelloExchangeError(
        "AUTH_NOTIFICATION_NOT_READY",
        "controlTx is not subscribed"
      );
    }
    this.#clearValue();
    this.#value = Buffer.from(value);
    dbusInterface.Interface.emitPropertiesChanged(this, {
      Value: Buffer.from(this.#value)
    });
  }

  publishAuthResponse(value: Uint8Array): void {
    this.publishControlResponse(value);
  }

  publishReliableResponse(value: Uint8Array): void {
    if (this.#reliableTransmitter() === null || !this.#notifying) {
      throw new GattReliableDataPlaneError(
        "TRANSMITTER_NOT_SUBSCRIBED",
        "reliable transmitter is not subscribed"
      );
    }
    this.#clearValue();
    this.#value = Buffer.from(value);
    dbusInterface.Interface.emitPropertiesChanged(this, {
      Value: Buffer.from(this.#value)
    });
  }

  resetAuthTransport(): void {
    if (!["controlTx", "dataTx", "ackTx"].includes(this.#characteristic.id)) {
      return;
    }
    const reliableTransmitter = this.#reliableTransmitter();
    if (reliableTransmitter !== null && this.#dataPlane?.enabled === true) {
      this.#dataPlane.setSubscription(reliableTransmitter, false);
    }
    const changed = this.#notifying || this.#value.byteLength > 0;
    this.#notifying = false;
    this.#clearValue();
    if (changed) {
      dbusInterface.Interface.emitPropertiesChanged(this, {
        Value: Buffer.alloc(0),
        Notifying: false
      });
    }
  }

  #clearValue(): void {
    this.#value.fill(0);
    this.#value = Buffer.alloc(0);
  }
}

GattCharacteristicInterface.configureMembers({
  properties: {
    UUID: { signature: "s", access: dbusInterface.ACCESS_READ },
    Service: { signature: "o", access: dbusInterface.ACCESS_READ },
    Flags: { signature: "as", access: dbusInterface.ACCESS_READ },
    Value: { signature: "ay", access: dbusInterface.ACCESS_READ },
    Notifying: { signature: "b", access: dbusInterface.ACCESS_READ }
  },
  methods: {
    ReadValue: { inSignature: "a{sv}", outSignature: "ay" },
    WriteValue: { inSignature: "aya{sv}", outSignature: "" },
    StartNotify: { inSignature: "", outSignature: "" },
    StopNotify: { inSignature: "", outSignature: "" }
  }
});

export class GattApplication {
  readonly #service: CassaGattService;
  readonly #helloExchange: GattHelloExchangeV1;
  readonly #dataPlane: GattReliableDataPlaneV1 | null;
  #managedObjectRequestsTotal = 0;
  readonly #metrics: AccessMetrics = {
    readDeniedTotal: 0,
    writeDeniedTotal: 0,
    notifyDeniedTotal: 0
  };
  readonly #serviceInterface: GattServiceInterface;
  readonly #characteristicInterfaces: readonly GattCharacteristicInterface[];
  readonly #objectManager: ObjectManagerInterface;
  readonly #exports: readonly Readonly<GattApplicationExport>[];

  constructor(
    service = new CassaGattService(),
    helloExchange = new GattHelloExchangeV1({ enabled: false }),
    dataPlane: GattReliableDataPlaneV1 | null = null
  ) {
    this.#service = service;
    this.#helloExchange = helloExchange;
    this.#dataPlane = dataPlane;
    this.#serviceInterface = new GattServiceInterface(service);
    let authTransmitter: GattCharacteristicInterface | null = null;
    this.#characteristicInterfaces = Object.freeze(
      service.characteristics.map((characteristic) => {
        const characteristicInterface = new GattCharacteristicInterface(
          characteristic,
          this.#metrics,
          this.#helloExchange,
          () => authTransmitter,
          this.#dataPlane,
          () => this.#resetReliableTransports()
        );
        if (characteristic.id === "controlTx") {
          authTransmitter = characteristicInterface;
        }
        return characteristicInterface;
      })
    );
    this.#helloExchange.setControlPublisher(({ value }) => {
      if (authTransmitter === null || !authTransmitter.Notifying) {
        throw new GattHelloExchangeError(
          "AUTH_NOTIFICATION_NOT_READY",
          "controlTx is not subscribed"
        );
      }
      authTransmitter.publishControlResponse(value);
    });
    this.#dataPlane?.setPublisher(({ transmitter, value }) => {
      const characteristicId =
        transmitter === GATT_RELIABLE_TRANSMITTERS.ACK ? "ackTx" : "dataTx";
      const definitionIndex = this.#service.characteristics.findIndex(
        (characteristic) => characteristic.id === characteristicId
      );
      const characteristic = this.#characteristicInterfaces[definitionIndex];
      if (definitionIndex < 0 || characteristic === undefined) {
        throw new GattReliableDataPlaneError(
          "TRANSMITTER_NOT_AVAILABLE",
          "reliable GATT transmitter is unavailable"
        );
      }
      characteristic.publishReliableResponse(value);
    });
    this.#objectManager = new ObjectManagerInterface(() => {
      this.#managedObjectRequestsTotal += 1;
      return this.managedObjects();
    });
    this.#exports = Object.freeze([
      Object.freeze({
        path: service.applicationPath,
        interface: this.#objectManager
      }),
      Object.freeze({
        path: service.servicePath,
        interface: this.#serviceInterface
      }),
      ...service.characteristics.map((characteristic, index) =>
        Object.freeze({
          path: characteristic.path,
          interface: this.#characteristicInterfaces[index]
        })
      )
    ]);
  }

  get applicationPath(): string {
    return this.#service.applicationPath;
  }

  exports(): readonly Readonly<GattApplicationExport>[] {
    return this.#exports;
  }

  resetHelloExchanges(): void {
    this.resetDirectSessions();
  }

  requestDirectClose(devicePath: string): void {
    this.#helloExchange.requestClose(devicePath);
  }

  requestSingleDirectClose(): void {
    this.#helloExchange.requestSingleActiveClose();
  }

  sendReliable(input: {
    readonly devicePath: string;
    readonly type: ReliableFrameType;
    readonly payload: Uint8Array;
    readonly durable?: boolean;
    readonly ttlMs?: number;
  }): Promise<Readonly<{ messageId: string; durableCommitted: boolean }>> {
    if (this.#dataPlane === null) {
      return Promise.reject(
        new GattReliableDataPlaneError(
          "DATA_PLANE_DISABLED",
          "reliable GATT data plane is disabled"
        )
      );
    }
    return this.#dataPlane.send(input);
  }

  resetDirectSessions(): void {
    for (const characteristic of this.#characteristicInterfaces) {
      characteristic.resetAuthTransport();
    }
    this.#dataPlane?.reset();
    this.#helloExchange.reset();
  }

  #resetReliableTransports(): void {
    for (const [index, characteristic] of this.#service.characteristics.entries()) {
      if (characteristic.id === "dataTx" || characteristic.id === "ackTx") {
        this.#characteristicInterfaces[index]?.resetAuthTransport();
      }
    }
    this.#dataPlane?.reset();
  }

  managedObjects(): GattManagedObjects {
    const objects: Record<string, Record<string, ManagedProperties>> = {
      [this.#service.servicePath]: {
        [BLUEZ_GATT_SERVICE_INTERFACE]: {
          UUID: new Variant("s", this.#service.uuid),
          Primary: new Variant("b", this.#service.primary)
        }
      }
    };

    this.#service.characteristics.forEach((characteristic, index) => {
      const characteristicInterface = this.#characteristicInterfaces[index];
      objects[characteristic.path] = {
        [BLUEZ_GATT_CHARACTERISTIC_INTERFACE]: {
          UUID: new Variant("s", characteristic.uuid),
          Service: new Variant("o", this.#service.servicePath),
          Flags: new Variant("as", [...characteristic.flags]),
          Value: new Variant("ay", characteristicInterface.Value),
          Notifying: new Variant("b", characteristicInterface.Notifying)
        }
      };
    });
    return Object.freeze(objects);
  }

  snapshot(): Readonly<{
    applicationPath: string;
    exportedInterfaceCount: number;
    managedObjectCount: number;
    managedObjectRequestsTotal: number;
    service: ReturnType<CassaGattService["snapshot"]>;
    access: Readonly<AccessMetrics>;
    hello: ReturnType<GattHelloExchangeV1["snapshot"]>;
    reliable: ReturnType<GattReliableDataPlaneV1["snapshot"]> | null;
  }> {
    return Object.freeze({
      applicationPath: this.applicationPath,
      exportedInterfaceCount: this.#exports.length,
      managedObjectCount: Object.keys(this.managedObjects()).length,
      managedObjectRequestsTotal: this.#managedObjectRequestsTotal,
      service: this.#service.snapshot(),
      access: Object.freeze({ ...this.#metrics }),
      hello: this.#helloExchange.snapshot(),
      reliable: this.#dataPlane?.snapshot() ?? null
    });
  }
}
