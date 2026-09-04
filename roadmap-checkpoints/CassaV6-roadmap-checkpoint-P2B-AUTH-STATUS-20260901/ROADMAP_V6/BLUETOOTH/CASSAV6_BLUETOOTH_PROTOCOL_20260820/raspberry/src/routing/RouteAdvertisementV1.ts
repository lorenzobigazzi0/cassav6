export const ROUTE_ADVERTISEMENT_VERSION = 1;
export const ROUTE_ADVERTISEMENT_WIRE_BYTES = 12;
export const ROUTE_ADVERTISEMENT_MAX_AGE_SECONDS = 65_535;
export const ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET = 15;

export const ROUTE_ADVERTISEMENT_KINDS = Object.freeze({
  NONE: "NONE",
  WIFI: "WIFI",
  LAN: "LAN",
  BLE_DIRECT: "BLE_DIRECT"
} as const);

export type RouteAdvertisementKind =
  (typeof ROUTE_ADVERTISEMENT_KINDS)[keyof typeof ROUTE_ADVERTISEMENT_KINDS];

const ROUTE_KIND_CODES: Readonly<Record<RouteAdvertisementKind, number>> =
  Object.freeze({
    NONE: 0,
    WIFI: 1,
    LAN: 2,
    BLE_DIRECT: 3
  });

const ROUTE_CODE_KINDS = new Map<number, RouteAdvertisementKind>(
  Object.entries(ROUTE_KIND_CODES).map(([kind, code]) => [
    code,
    kind as RouteAdvertisementKind
  ])
);

export interface RouteAdvertisementV1 {
  readonly canReachServer: boolean;
  readonly routeKind: RouteAdvertisementKind;
  readonly serverRttBucket: number;
  readonly routeAgeSeconds: number;
  readonly queueDepthBucket: number;
  readonly batteryBucket: number;
  readonly sequence: number;
}

export class RouteAdvertisementError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RouteAdvertisementError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new RouteAdvertisementError(code, message);
}

function integer(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("INVALID_ROUTE_FIELD", `${field} is outside its canonical range`);
  }
}

function validRttBucket(value: number): boolean {
  return (value >= 0 && value <= 7) || value === ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET;
}

function validBatteryBucket(value: number): boolean {
  return (value >= 0 && value <= 10) || value === ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET;
}

function validate(value: RouteAdvertisementV1): void {
  if (!Object.values(ROUTE_ADVERTISEMENT_KINDS).includes(value.routeKind)) {
    fail("INVALID_ROUTE_KIND", "route kind is not assigned in protocol v1");
  }
  if (!validRttBucket(value.serverRttBucket)) {
    fail("INVALID_RTT_BUCKET", "server RTT bucket is reserved");
  }
  integer(
    value.routeAgeSeconds,
    0,
    ROUTE_ADVERTISEMENT_MAX_AGE_SECONDS,
    "routeAgeSeconds"
  );
  integer(value.queueDepthBucket, 0, 15, "queueDepthBucket");
  if (!validBatteryBucket(value.batteryBucket)) {
    fail("INVALID_BATTERY_BUCKET", "battery bucket is reserved");
  }
  integer(value.sequence, 1, 0xffff_ffff, "sequence");
  if (value.canReachServer && value.routeKind === ROUTE_ADVERTISEMENT_KINDS.NONE) {
    fail("INVALID_ROUTE_STATE", "NONE cannot claim server reachability");
  }
  if (
    value.canReachServer &&
    value.routeKind === ROUTE_ADVERTISEMENT_KINDS.BLE_DIRECT
  ) {
    fail(
      "MULTIHOP_NOT_ALLOWED",
      "B9 does not advertise server reachability through another BLE node"
    );
  }
  if (!value.canReachServer && value.serverRttBucket !== ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET) {
    fail("INVALID_ROUTE_STATE", "unreachable route must use unknown RTT bucket");
  }
}

export function encodeRouteAdvertisementV1(
  value: RouteAdvertisementV1
): Buffer {
  validate(value);
  const wire = Buffer.alloc(ROUTE_ADVERTISEMENT_WIRE_BYTES);
  wire[0] = ROUTE_ADVERTISEMENT_VERSION;
  wire[1] = value.canReachServer ? 1 : 0;
  wire[2] = ROUTE_KIND_CODES[value.routeKind];
  wire[3] = value.serverRttBucket;
  wire.writeUInt16BE(value.routeAgeSeconds, 4);
  wire[6] = value.queueDepthBucket;
  wire[7] = value.batteryBucket;
  wire.writeUInt32BE(value.sequence, 8);
  return wire;
}

export function decodeRouteAdvertisementV1(
  wire: Uint8Array
): Readonly<RouteAdvertisementV1> {
  if (
    !(wire instanceof Uint8Array) ||
    wire.byteLength !== ROUTE_ADVERTISEMENT_WIRE_BYTES
  ) {
    fail("INVALID_ROUTE_LENGTH", "route advertisement must be exactly 12 bytes");
  }
  const value = Buffer.from(wire);
  if (value[0] !== ROUTE_ADVERTISEMENT_VERSION) {
    fail("INVALID_ROUTE_VERSION", "route advertisement version is unsupported");
  }
  if (value[1] !== 0 && value[1] !== 1) {
    fail("INVALID_ROUTE_FLAGS", "route flags contain reserved bits");
  }
  const routeKind = ROUTE_CODE_KINDS.get(value[2]);
  if (routeKind === undefined) {
    fail("INVALID_ROUTE_KIND", "route kind code is not assigned");
  }
  const result = Object.freeze({
    canReachServer: value[1] === 1,
    routeKind,
    serverRttBucket: value[3],
    routeAgeSeconds: value.readUInt16BE(4),
    queueDepthBucket: value[6],
    batteryBucket: value[7],
    sequence: value.readUInt32BE(8)
  });
  validate(result);
  return result;
}

export function serverRttBucketV1(rttMs: number | null): number {
  if (rttMs === null) return ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET;
  if (!Number.isFinite(rttMs) || rttMs < 0) {
    fail("INVALID_RTT", "RTT must be finite and nonnegative");
  }
  const ceilings = [10, 25, 50, 100, 250, 500, 1_000];
  const index = ceilings.findIndex((ceiling) => rttMs <= ceiling);
  return index === -1 ? 7 : index;
}

export function queueDepthBucketV1(queueDepth: number): number {
  integer(queueDepth, 0, Number.MAX_SAFE_INTEGER, "queueDepth");
  if (queueDepth === 0) return 0;
  return Math.min(15, Math.floor(Math.log2(queueDepth)) + 1);
}

export function batteryBucketV1(percent: number | null): number {
  if (percent === null) return ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET;
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    fail("INVALID_BATTERY", "battery percent must be from zero to one hundred");
  }
  return Math.min(10, Math.floor(percent / 10));
}

export class RouteAdvertisementPublisherV1 {
  readonly #publishIntervalMs: number;
  readonly #sequenceStore: RouteAdvertisementSequenceStoreV1;
  #lastPublishedAtEpochMs: number | null = null;
  #lastClockEpochMs = 0;

  constructor(
    publishIntervalMs = 5_000,
    sequenceStore: RouteAdvertisementSequenceStoreV1 =
      new InMemoryRouteAdvertisementSequenceStoreV1()
  ) {
    integer(publishIntervalMs, 1_000, 5_000, "publishIntervalMs");
    this.#publishIntervalMs = publishIntervalMs;
    this.#sequenceStore = sequenceStore;
  }

  build(input: {
    readonly nowEpochMs: number;
    readonly force?: boolean;
    readonly canReachServer: boolean;
    readonly routeKind: RouteAdvertisementKind;
    readonly serverRttMs: number | null;
    readonly lastRouteChangeAtEpochMs: number;
    readonly queueDepth: number;
    readonly batteryPercent: number | null;
  }): Buffer | null {
    integer(input.nowEpochMs, 0, Number.MAX_SAFE_INTEGER, "nowEpochMs");
    integer(
      input.lastRouteChangeAtEpochMs,
      0,
      input.nowEpochMs,
      "lastRouteChangeAtEpochMs"
    );
    if (input.nowEpochMs < this.#lastClockEpochMs) {
      fail("CLOCK_REGRESSION", "route publisher clock moved backwards");
    }
    this.#lastClockEpochMs = input.nowEpochMs;
    if (
      input.force !== true &&
      this.#lastPublishedAtEpochMs !== null &&
      input.nowEpochMs - this.#lastPublishedAtEpochMs < this.#publishIntervalMs
    ) {
      return null;
    }
    const sequence = this.#sequenceStore.reserveRouteAdvertisementSequence();
    integer(sequence, 1, 0xffff_ffff, "sequence");
    this.#lastPublishedAtEpochMs = input.nowEpochMs;
    return encodeRouteAdvertisementV1({
      canReachServer: input.canReachServer,
      routeKind: input.routeKind,
      serverRttBucket: serverRttBucketV1(
        input.canReachServer ? input.serverRttMs : null
      ),
      routeAgeSeconds: Math.min(
        ROUTE_ADVERTISEMENT_MAX_AGE_SECONDS,
        Math.floor((input.nowEpochMs - input.lastRouteChangeAtEpochMs) / 1_000)
      ),
      queueDepthBucket: queueDepthBucketV1(input.queueDepth),
      batteryBucket: batteryBucketV1(input.batteryPercent),
      sequence
    });
  }

  snapshot(): Readonly<{
    sequence: number;
    hasPublished: boolean;
    publishIntervalMs: number;
  }> {
    return Object.freeze({
      sequence: this.#sequenceStore.routeAdvertisementSequenceHighWatermark(),
      hasPublished: this.#lastPublishedAtEpochMs !== null,
      publishIntervalMs: this.#publishIntervalMs
    });
  }
}

export interface RouteAdvertisementSequenceStoreV1 {
  reserveRouteAdvertisementSequence(): number;
  routeAdvertisementSequenceHighWatermark(): number;
}

export class InMemoryRouteAdvertisementSequenceStoreV1
implements RouteAdvertisementSequenceStoreV1 {
  #sequence: number;

  constructor(initialSequence = 0) {
    integer(initialSequence, 0, 0xffff_ffff, "initialSequence");
    this.#sequence = initialSequence;
  }

  reserveRouteAdvertisementSequence(): number {
    if (this.#sequence >= 0xffff_ffff) {
      fail("SEQUENCE_EXHAUSTED", "route advertisement sequence is exhausted");
    }
    this.#sequence += 1;
    return this.#sequence;
  }

  routeAdvertisementSequenceHighWatermark(): number {
    return this.#sequence;
  }
}
