import {
  systemBus,
  Variant
} from "@jellybrick/dbus-next";

import {
  BluezDbusProtocolError,
  decodeBluezDevicePropertyPatch,
  type BluezDbusEventHandlers,
  type BluezDbusInterfaces,
  type BluezDbusManagedObjects,
  type BluezDbusPort,
  type BluezDbusPortSnapshot,
  type BluezDbusProperties
} from "./BluezDbusPort.js";

const BLUEZ_BUS_NAME = "org.bluez";
const DBUS_BUS_NAME = "org.freedesktop.DBus";
const DBUS_BUS_PATH = "/org/freedesktop/DBus";
const DBUS_INTERFACE = "org.freedesktop.DBus";
const OBJECT_MANAGER_INTERFACE = "org.freedesktop.DBus.ObjectManager";
const PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";
const ADAPTER_INTERFACE = "org.bluez.Adapter1";
const DEVICE_INTERFACE = "org.bluez.Device1";

const NAME_OWNER_RULE =
  "type='signal',sender='org.freedesktop.DBus'," +
  "interface='org.freedesktop.DBus',member='NameOwnerChanged'," +
  "arg0='org.bluez'";

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
  disconnect(): void;
}

export interface DbusNextBluezPortOptions {
  readonly busFactory?: () => DbusMessageBusLike;
  readonly variantFactory?: (
    signature: string,
    value: unknown
  ) => unknown;
}

function defaultBusFactory(): DbusMessageBusLike {
  return systemBus() as unknown as DbusMessageBusLike;
}

function defaultVariantFactory(signature: string, value: unknown): unknown {
  return new Variant(signature, value);
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function readBooleanVariant(
  properties: BluezDbusProperties,
  propertyName: string
): boolean {
  const property = properties[propertyName];
  if (
    typeof property !== "object" ||
    property === null ||
    typeof property.value !== "boolean"
  ) {
    throw new BluezDbusProtocolError(
      "INVALID_ADAPTER_PROPERTIES",
      `${propertyName} is missing or is not boolean`
    );
  }
  return property.value;
}

async function callMethod<T>(
  dbusInterface: DbusInterfaceLike,
  methodName: string,
  ...args: readonly unknown[]
): Promise<T> {
  const candidate = dbusInterface[methodName];
  if (typeof candidate !== "function") {
    throw new BluezDbusProtocolError(
      "MISSING_DBUS_METHOD",
      `${methodName} is not available on the D-Bus interface`
    );
  }
  return (await candidate.apply(dbusInterface, args)) as T;
}

function bluezSignalRules(adapterPath: string): readonly string[] {
  return Object.freeze([
    "type='signal',sender='org.bluez'," +
      "interface='org.freedesktop.DBus.ObjectManager'," +
      "member='InterfacesAdded'",
    "type='signal',sender='org.bluez'," +
      "interface='org.freedesktop.DBus.ObjectManager'," +
      "member='InterfacesRemoved'",
    "type='signal',sender='org.bluez'," +
      "interface='org.freedesktop.DBus.Properties'," +
      "member='PropertiesChanged'," +
      `path_namespace='${adapterPath}'`
  ]);
}

function isDevicePath(path: unknown, adapterPath: string | null): path is string {
  return (
    typeof path === "string" &&
    adapterPath !== null &&
    path.startsWith(`${adapterPath}/dev_`)
  );
}

export class DbusNextBluezPort implements BluezDbusPort {
  readonly #busFactory: () => DbusMessageBusLike;
  readonly #variantFactory: (
    signature: string,
    value: unknown
  ) => unknown;
  readonly #activeMatchRules = new Set<string>();
  #bus: DbusMessageBusLike | null = null;
  #dbusInterface: DbusInterfaceLike | null = null;
  #adapterInterface: DbusInterfaceLike | null = null;
  #handlers: BluezDbusEventHandlers | null = null;
  #adapterPath: string | null = null;
  #bluezOwnerAvailable = false;
  #discoverySessionAcquired = false;
  #signalsTotal = 0;
  #deviceUpdatesTotal = 0;
  #ownerChangesTotal = 0;
  #errorsTotal = 0;
  #lastErrorCategory: string | null = null;
  #lastErrorCode: string | null = null;
  #startDiscoveryCallsTotal = 0;
  #stopDiscoveryCallsTotal = 0;

  constructor(options: DbusNextBluezPortOptions = {}) {
    this.#busFactory = options.busFactory ?? defaultBusFactory;
    this.#variantFactory =
      options.variantFactory ?? defaultVariantFactory;
  }

  readonly #handleMessage = (message: DbusMessageLike): void => {
    this.#signalsTotal += 1;
    try {
      if (
        message.path === DBUS_BUS_PATH &&
        message.interface === DBUS_INTERFACE &&
        message.member === "NameOwnerChanged"
      ) {
        this.#handleNameOwnerChanged(message.body);
        return;
      }

      if (
        !this.#discoverySessionAcquired ||
        !this.#bluezOwnerAvailable
      ) {
        return;
      }

      if (
        message.interface === OBJECT_MANAGER_INTERFACE &&
        message.member === "InterfacesAdded"
      ) {
        this.#handleInterfacesAdded(message.body);
        return;
      }
      if (
        message.interface === OBJECT_MANAGER_INTERFACE &&
        message.member === "InterfacesRemoved"
      ) {
        this.#handleInterfacesRemoved(message.body);
        return;
      }
      if (
        message.interface === PROPERTIES_INTERFACE &&
        message.member === "PropertiesChanged" &&
        isDevicePath(message.path, this.#adapterPath)
      ) {
        this.#handlePropertiesChanged(message.path, message.body);
      }
    } catch (error) {
      this.#recordError(error, "invalid BlueZ D-Bus signal");
    }
  };

  #recordError(error: unknown, fallback: string): void {
    const normalizedError = asError(error, fallback);
    this.#errorsTotal += 1;
    this.#lastErrorCategory = fallback;
    this.#lastErrorCode =
      "code" in normalizedError &&
      typeof normalizedError.code === "string"
        ? normalizedError.code
        : normalizedError.name;
    this.#handlers?.onError(normalizedError);
  }

  #handleNameOwnerChanged(body: readonly unknown[] | undefined): void {
    if (
      !Array.isArray(body) ||
      body.length < 1 ||
      typeof body[0] !== "string"
    ) {
      throw new BluezDbusProtocolError(
        "INVALID_OWNER_SIGNAL",
        "D-Bus NameOwnerChanged signal is invalid"
      );
    }
    if (body[0] !== BLUEZ_BUS_NAME) {
      return;
    }
    if (body.length < 3 || typeof body[2] !== "string") {
      throw new BluezDbusProtocolError(
        "INVALID_OWNER_SIGNAL",
        "BlueZ NameOwnerChanged signal is invalid"
      );
    }

    const available = body[2].length > 0;
    if (available === this.#bluezOwnerAvailable) {
      return;
    }

    this.#bluezOwnerAvailable = available;
    this.#ownerChangesTotal += 1;
    if (!available) {
      // bluetoothd owns the discovery session, so its exit releases it.
      this.#discoverySessionAcquired = false;
      this.#adapterInterface = null;
    }

    try {
      const result = this.#handlers?.onOwnerChanged(available);
      if (result instanceof Promise) {
        void result.catch((error) => {
          this.#recordError(error, "BlueZ owner callback failed");
        });
      }
    } catch (error) {
      this.#recordError(error, "BlueZ owner callback failed");
    }
  }

  #handleInterfacesAdded(body: readonly unknown[] | undefined): void {
    if (
      !Array.isArray(body) ||
      body.length < 2 ||
      !isDevicePath(body[0], this.#adapterPath) ||
      typeof body[1] !== "object" ||
      body[1] === null
    ) {
      return;
    }
    const interfaces = body[1] as BluezDbusInterfaces;
    const deviceProperties = interfaces[DEVICE_INTERFACE];
    if (deviceProperties === undefined) {
      return;
    }
    this.#emitDevicePatch(body[0], deviceProperties, []);
  }

  #handleInterfacesRemoved(body: readonly unknown[] | undefined): void {
    if (
      !Array.isArray(body) ||
      body.length < 2 ||
      !isDevicePath(body[0], this.#adapterPath) ||
      !Array.isArray(body[1]) ||
      !body[1].includes(DEVICE_INTERFACE)
    ) {
      return;
    }
    this.#handlers?.onDeviceRemoved(body[0]);
  }

  #handlePropertiesChanged(
    objectPath: string,
    body: readonly unknown[] | undefined
  ): void {
    if (
      !Array.isArray(body) ||
      body.length < 3 ||
      body[0] !== DEVICE_INTERFACE
    ) {
      return;
    }
    this.#emitDevicePatch(objectPath, body[1], body[2]);
  }

  #emitDevicePatch(
    objectPath: string,
    changedProperties: unknown,
    invalidatedProperties: unknown
  ): void {
    const patch = decodeBluezDevicePropertyPatch({
      objectPath,
      changedProperties,
      invalidatedProperties
    });
    if (
      patch.rssiDbm === undefined &&
      patch.serviceData === undefined
    ) {
      return;
    }
    this.#deviceUpdatesTotal += 1;
    this.#handlers?.onDeviceUpdate(patch);
  }

  async #addMatchRule(rule: string): Promise<void> {
    if (this.#activeMatchRules.has(rule)) {
      return;
    }
    if (this.#dbusInterface === null) {
      throw new Error("D-Bus interface is not connected");
    }
    await callMethod<void>(this.#dbusInterface, "AddMatch", rule);
    this.#activeMatchRules.add(rule);
  }

  async #removeMatchRule(rule: string): Promise<void> {
    if (!this.#activeMatchRules.has(rule)) {
      return;
    }
    if (this.#dbusInterface === null) {
      this.#activeMatchRules.delete(rule);
      return;
    }
    await callMethod<void>(this.#dbusInterface, "RemoveMatch", rule);
    this.#activeMatchRules.delete(rule);
  }

  async connect(handlers: BluezDbusEventHandlers): Promise<void> {
    if (this.#bus !== null) {
      if (this.#handlers !== handlers) {
        throw new Error("BlueZ D-Bus port is already connected");
      }
      return;
    }

    this.#handlers = handlers;
    const bus = this.#busFactory();
    this.#bus = bus;
    bus.on("message", this.#handleMessage);

    try {
      const dbusObject = await bus.getProxyObject(
        DBUS_BUS_NAME,
        DBUS_BUS_PATH
      );
      this.#dbusInterface = dbusObject.getInterface(DBUS_INTERFACE);
      await this.#addMatchRule(NAME_OWNER_RULE);
      this.#bluezOwnerAvailable = await callMethod<boolean>(
        this.#dbusInterface,
        "NameHasOwner",
        BLUEZ_BUS_NAME
      );
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async openDiscovery(input: {
    readonly adapterPath: string;
    readonly serviceUuid: string;
  }): Promise<void> {
    if (this.#bus === null || this.#dbusInterface === null) {
      throw new Error("BlueZ D-Bus port is not connected");
    }
    if (this.#discoverySessionAcquired) {
      if (this.#adapterPath !== input.adapterPath) {
        throw new Error("a different BlueZ adapter is already active");
      }
      return;
    }
    if (!this.#bluezOwnerAvailable) {
      throw new BluezDbusProtocolError(
        "BLUEZ_UNAVAILABLE",
        "org.bluez has no owner on the system bus"
      );
    }

    this.#adapterPath = input.adapterPath;
    for (const rule of bluezSignalRules(input.adapterPath)) {
      await this.#addMatchRule(rule);
    }

    const rootObject = await this.#bus.getProxyObject(BLUEZ_BUS_NAME, "/");
    const objectManager = rootObject.getInterface(
      OBJECT_MANAGER_INTERFACE
    );
    const managedObjects = await callMethod<BluezDbusManagedObjects>(
      objectManager,
      "GetManagedObjects"
    );
    if (managedObjects[input.adapterPath]?.[ADAPTER_INTERFACE] === undefined) {
      throw new BluezDbusProtocolError(
        "BLUEZ_ADAPTER_NOT_FOUND",
        `BlueZ adapter ${input.adapterPath} is not present`
      );
    }

    const adapterObject = await this.#bus.getProxyObject(
      BLUEZ_BUS_NAME,
      input.adapterPath
    );
    const adapterInterface = adapterObject.getInterface(ADAPTER_INTERFACE);
    const propertiesInterface = adapterObject.getInterface(
      PROPERTIES_INTERFACE
    );
    const adapterProperties = await callMethod<BluezDbusProperties>(
      propertiesInterface,
      "GetAll",
      ADAPTER_INTERFACE
    );
    if (!readBooleanVariant(adapterProperties, "Powered")) {
      throw new BluezDbusProtocolError(
        "BLUEZ_ADAPTER_NOT_POWERED",
        `BlueZ adapter ${input.adapterPath} is not powered`
      );
    }

    await callMethod<void>(
      adapterInterface,
      "SetDiscoveryFilter",
      {
        // BlueZ does not match UUID filters against service-data-only
        // advertisements consistently. BluezAdapter filters ServiceData.
        Transport: this.#variantFactory("s", "le"),
        DuplicateData: this.#variantFactory("b", true)
      }
    );
    this.#startDiscoveryCallsTotal += 1;
    await callMethod<void>(adapterInterface, "StartDiscovery");
    this.#adapterInterface = adapterInterface;
    this.#discoverySessionAcquired = true;
  }

  async closeDiscovery(): Promise<void> {
    const hadSession = this.#discoverySessionAcquired;
    const adapterInterface = this.#adapterInterface;
    this.#discoverySessionAcquired = false;
    this.#adapterInterface = null;

    let stopError: unknown = null;
    if (
      hadSession &&
      this.#bluezOwnerAvailable &&
      adapterInterface !== null
    ) {
      try {
        this.#stopDiscoveryCallsTotal += 1;
        await callMethod<void>(adapterInterface, "StopDiscovery");
      } catch (error) {
        stopError = error;
      }
    }

    if (this.#adapterPath !== null) {
      for (const rule of bluezSignalRules(this.#adapterPath)) {
        try {
          await this.#removeMatchRule(rule);
        } catch (error) {
          this.#recordError(error, "failed to remove BlueZ match rule");
        }
      }
    }
    this.#adapterPath = null;

    if (stopError !== null) {
      throw stopError;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.closeDiscovery();
    } catch (error) {
      this.#recordError(error, "failed to close BlueZ discovery");
    }

    for (const rule of [...this.#activeMatchRules]) {
      try {
        await this.#removeMatchRule(rule);
      } catch (error) {
        this.#recordError(error, "failed to remove D-Bus match rule");
      }
    }

    const bus = this.#bus;
    if (bus !== null) {
      bus.off("message", this.#handleMessage);
      bus.disconnect();
    }
    this.#bus = null;
    this.#dbusInterface = null;
    this.#handlers = null;
    this.#adapterPath = null;
    this.#bluezOwnerAvailable = false;
    this.#discoverySessionAcquired = false;
  }

  snapshot(): Readonly<BluezDbusPortSnapshot> {
    return Object.freeze({
      transport: "@jellybrick/dbus-next",
      busConnected: this.#bus !== null,
      bluezOwnerAvailable: this.#bluezOwnerAvailable,
      discoverySessionAcquired: this.#discoverySessionAcquired,
      activeMatchRules: this.#activeMatchRules.size,
      signalsTotal: this.#signalsTotal,
      deviceUpdatesTotal: this.#deviceUpdatesTotal,
      ownerChangesTotal: this.#ownerChangesTotal,
      errorsTotal: this.#errorsTotal,
      lastErrorCategory: this.#lastErrorCategory,
      lastErrorCode: this.#lastErrorCode,
      startDiscoveryCallsTotal: this.#startDiscoveryCallsTotal,
      stopDiscoveryCallsTotal: this.#stopDiscoveryCallsTotal
    });
  }
}
