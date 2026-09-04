export interface BluezDbusVariantLike {
  readonly signature?: unknown;
  readonly value: unknown;
}

export type BluezDbusProperties = Readonly<
  Record<string, BluezDbusVariantLike>
>;

export type BluezDbusInterfaces = Readonly<
  Record<string, BluezDbusProperties>
>;

export type BluezDbusManagedObjects = Readonly<
  Record<string, BluezDbusInterfaces>
>;

export interface BluezDevicePropertyPatch {
  readonly objectPath: string;
  readonly rssiDbm?: number | null;
  readonly serviceData?: ReadonlyMap<string, Uint8Array> | null;
}

export interface BluezDbusEventHandlers {
  readonly onOwnerChanged: (
    available: boolean
  ) => void | Promise<void>;
  readonly onDeviceUpdate: (patch: BluezDevicePropertyPatch) => void;
  readonly onDeviceRemoved: (objectPath: string) => void;
  readonly onError: (error: Error) => void;
}

export interface BluezDbusPortSnapshot {
  readonly transport: string;
  readonly busConnected: boolean;
  readonly bluezOwnerAvailable: boolean;
  readonly discoverySessionAcquired: boolean;
  readonly activeMatchRules: number;
  readonly signalsTotal: number;
  readonly deviceUpdatesTotal: number;
  readonly ownerChangesTotal: number;
  readonly errorsTotal: number;
  readonly lastErrorCategory: string | null;
  readonly lastErrorCode: string | null;
  readonly startDiscoveryCallsTotal: number;
  readonly stopDiscoveryCallsTotal: number;
}

export interface BluezDbusPort {
  connect(handlers: BluezDbusEventHandlers): Promise<void>;
  openDiscovery(input: {
    readonly adapterPath: string;
    readonly serviceUuid: string;
  }): Promise<void>;
  closeDiscovery(): Promise<void>;
  disconnect(): Promise<void>;
  snapshot(): Readonly<BluezDbusPortSnapshot>;
}

export class BluezDbusProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BluezDbusProtocolError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapVariant(value: unknown, propertyName: string): unknown {
  if (!isRecord(value) || !("value" in value)) {
    throw new BluezDbusProtocolError(
      "INVALID_VARIANT",
      `${propertyName} is not a D-Bus variant`
    );
  }
  return value.value;
}

function decodeRssi(value: unknown): number {
  const rssi = unwrapVariant(value, "RSSI");
  if (
    typeof rssi !== "number" ||
    !Number.isInteger(rssi) ||
    rssi < -32_768 ||
    rssi > 32_767
  ) {
    throw new BluezDbusProtocolError(
      "INVALID_RSSI",
      "RSSI is not a valid D-Bus int16"
    );
  }
  return rssi;
}

function toByteArray(value: unknown): Uint8Array {
  const bytes = unwrapVariant(value, "ServiceData entry");
  if (!(bytes instanceof Uint8Array)) {
    throw new BluezDbusProtocolError(
      "INVALID_SERVICE_DATA",
      "ServiceData entry is not a D-Bus byte array"
    );
  }
  return Uint8Array.from(bytes);
}

function decodeServiceData(
  value: unknown
): ReadonlyMap<string, Uint8Array> {
  const rawServiceData = unwrapVariant(value, "ServiceData");
  const entries: Iterable<readonly [unknown, unknown]> =
    rawServiceData instanceof Map
      ? rawServiceData.entries()
      : isRecord(rawServiceData)
        ? Object.entries(rawServiceData)
        : [];

  if (!(rawServiceData instanceof Map) && !isRecord(rawServiceData)) {
    throw new BluezDbusProtocolError(
      "INVALID_SERVICE_DATA",
      "ServiceData is not a D-Bus dictionary"
    );
  }

  const serviceData = new Map<string, Uint8Array>();
  for (const [rawUuid, rawPayload] of entries) {
    if (typeof rawUuid !== "string" || rawUuid.trim() === "") {
      throw new BluezDbusProtocolError(
        "INVALID_SERVICE_UUID",
        "ServiceData contains an invalid UUID key"
      );
    }
    serviceData.set(
      rawUuid.trim().toLowerCase(),
      toByteArray(rawPayload)
    );
  }
  return serviceData;
}

export function decodeBluezDevicePropertyPatch(input: {
  readonly objectPath: string;
  readonly changedProperties: unknown;
  readonly invalidatedProperties?: unknown;
}): Readonly<BluezDevicePropertyPatch> {
  if (
    typeof input.objectPath !== "string" ||
    !input.objectPath.startsWith("/")
  ) {
    throw new BluezDbusProtocolError(
      "INVALID_OBJECT_PATH",
      "Device update has an invalid D-Bus object path"
    );
  }
  if (!isRecord(input.changedProperties)) {
    throw new BluezDbusProtocolError(
      "INVALID_PROPERTIES",
      "Device update properties are not a D-Bus dictionary"
    );
  }

  const invalidated = input.invalidatedProperties ?? [];
  if (
    !Array.isArray(invalidated) ||
    invalidated.some((value) => typeof value !== "string")
  ) {
    throw new BluezDbusProtocolError(
      "INVALID_INVALIDATED_PROPERTIES",
      "Invalidated properties are not a string array"
    );
  }

  const patch: {
    objectPath: string;
    rssiDbm?: number | null;
    serviceData?: ReadonlyMap<string, Uint8Array> | null;
  } = {
    objectPath: input.objectPath
  };

  if (Object.prototype.hasOwnProperty.call(input.changedProperties, "RSSI")) {
    patch.rssiDbm = decodeRssi(input.changedProperties.RSSI);
  } else if (invalidated.includes("RSSI")) {
    patch.rssiDbm = null;
  }

  if (
    Object.prototype.hasOwnProperty.call(
      input.changedProperties,
      "ServiceData"
    )
  ) {
    patch.serviceData = decodeServiceData(
      input.changedProperties.ServiceData
    );
  } else if (invalidated.includes("ServiceData")) {
    patch.serviceData = null;
  }

  return Object.freeze(patch);
}
