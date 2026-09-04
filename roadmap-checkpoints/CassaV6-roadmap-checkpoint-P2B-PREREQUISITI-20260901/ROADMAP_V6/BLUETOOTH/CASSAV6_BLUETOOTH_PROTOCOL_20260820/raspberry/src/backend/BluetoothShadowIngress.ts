import {
  RELIABLE_FRAME_TYPES,
  type ReliableMessageV1
} from "../protocol/FrameCodec.js";

export const BLUETOOTH_SHADOW_SCHEMA_VERSION = 1;
export const BLUETOOTH_SHADOW_MAX_BODY_BYTES = 128;
export const BLUETOOTH_SHADOW_MAX_WIRE_BYTES = 512;
export const BLUETOOTH_SHADOW_KINDS = Object.freeze({
  HEALTH: "HEALTH",
  PING: "PING",
  TEST: "TEST"
} as const);

export type BluetoothShadowKind =
  (typeof BLUETOOTH_SHADOW_KINDS)[keyof typeof BLUETOOTH_SHADOW_KINDS];

export interface BluetoothShadowMessageV1 {
  readonly schemaVersion: 1;
  readonly kind: BluetoothShadowKind;
  readonly correlationId: string;
  readonly sentAtEpochMs: number;
  readonly lanLatencyMs: number | null;
  readonly body: string;
}

export class BluetoothShadowIngressError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BluetoothShadowIngressError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new BluetoothShadowIngressError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function assertInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("INVALID_SHADOW_FIELD", `${field} is outside its canonical range`);
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validate(value: BluetoothShadowMessageV1): void {
  if (value.schemaVersion !== BLUETOOTH_SHADOW_SCHEMA_VERSION) {
    fail("INVALID_SHADOW_VERSION", "shadow message version is unsupported");
  }
  if (!Object.values(BLUETOOTH_SHADOW_KINDS).includes(value.kind)) {
    fail("BUSINESS_MESSAGE_REJECTED", "only health, ping and test are allowed");
  }
  if (!/^[0-9a-f]{32}$/.test(value.correlationId)) {
    fail("INVALID_CORRELATION_ID", "correlationId must be canonical lowercase hex");
  }
  assertInteger(value.sentAtEpochMs, 0, Number.MAX_SAFE_INTEGER, "sentAtEpochMs");
  if (value.lanLatencyMs !== null) {
    assertInteger(value.lanLatencyMs, 0, 60_000, "lanLatencyMs");
  }
  if (
    typeof value.body !== "string" ||
    hasUnpairedSurrogate(value.body) ||
    Buffer.byteLength(value.body, "utf8") > BLUETOOTH_SHADOW_MAX_BODY_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value.body)
  ) {
    fail("INVALID_SHADOW_BODY", "shadow body is not canonical printable UTF-8");
  }
}

export function encodeBluetoothShadowMessageV1(
  value: BluetoothShadowMessageV1
): Buffer {
  validate(value);
  const wire = Buffer.from(
    JSON.stringify({
      schemaVersion: BLUETOOTH_SHADOW_SCHEMA_VERSION,
      kind: value.kind,
      correlationId: value.correlationId,
      sentAtEpochMs: value.sentAtEpochMs,
      lanLatencyMs: value.lanLatencyMs,
      body: value.body
    }),
    "utf8"
  );
  if (wire.byteLength > BLUETOOTH_SHADOW_MAX_WIRE_BYTES) {
    wire.fill(0);
    fail("SHADOW_WIRE_TOO_LARGE", "shadow message exceeds its wire budget");
  }
  return wire;
}

export function decodeBluetoothShadowMessageV1(
  wire: Uint8Array
): Readonly<BluetoothShadowMessageV1> {
  if (
    !(wire instanceof Uint8Array) ||
    wire.byteLength < 2 ||
    wire.byteLength > BLUETOOTH_SHADOW_MAX_WIRE_BYTES
  ) {
    fail("INVALID_SHADOW_WIRE", "shadow wire length is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(wire).toString("utf8"));
  } catch (error) {
    fail("INVALID_SHADOW_JSON", "shadow wire is not valid JSON", error);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("INVALID_SHADOW_JSON", "shadow JSON must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const allowedKeys = [
    "body",
    "correlationId",
    "kind",
    "lanLatencyMs",
    "schemaVersion",
    "sentAtEpochMs"
  ];
  if (
    Object.keys(record).sort().join("\0") !== allowedKeys.join("\0")
  ) {
    fail("INVALID_SHADOW_KEYS", "shadow JSON fields are not exact");
  }
  const value = Object.freeze({
    schemaVersion: record.schemaVersion as 1,
    kind: record.kind as BluetoothShadowKind,
    correlationId: record.correlationId as string,
    sentAtEpochMs: record.sentAtEpochMs as number,
    lanLatencyMs: record.lanLatencyMs as number | null,
    body: record.body as string
  });
  validate(value);
  const canonical = encodeBluetoothShadowMessageV1(value);
  try {
    const candidate = Buffer.from(wire);
    if (
      canonical.byteLength !== candidate.byteLength ||
      !canonical.equals(candidate)
    ) {
      fail("NON_CANONICAL_SHADOW_JSON", "shadow JSON serialization is not canonical");
    }
  } finally {
    canonical.fill(0);
  }
  return value;
}

export interface BluetoothShadowIngressMetricsV1 {
  readonly enabled: boolean;
  readonly received: number;
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly handlerFailures: number;
  readonly bleLatencyAverageMs: number | null;
  readonly lanLatencyAverageMs: number | null;
  readonly latencyDeltaAverageMs: number | null;
  readonly businessMessagesForwarded: 0;
}

export class BluetoothShadowIngressV1 {
  readonly #enabled: boolean;
  readonly #maximumClockSkewMs: number;
  readonly #dedupTtlMs: number;
  readonly #now: () => number;
  readonly #handler: (
    message: BluetoothShadowMessageV1
  ) => void | Promise<void>;
  readonly #seen = new Map<string, number>();
  #received = 0;
  #accepted = 0;
  #duplicates = 0;
  #rejected = 0;
  #handlerFailures = 0;
  #bleLatencyTotalMs = 0;
  #lanLatencyTotalMs = 0;
  #latencySamples = 0;
  #lanLatencySamples = 0;
  #lastNowEpochMs = 0;

  constructor(input: {
    readonly enabled?: boolean;
    readonly maximumClockSkewMs?: number;
    readonly dedupTtlMs?: number;
    readonly now?: () => number;
    readonly handler: (
      message: BluetoothShadowMessageV1
    ) => void | Promise<void>;
  }) {
    this.#enabled = input.enabled === true;
    this.#maximumClockSkewMs = input.maximumClockSkewMs ?? 30_000;
    this.#dedupTtlMs = input.dedupTtlMs ?? 5 * 60_000;
    this.#now = input.now ?? Date.now;
    this.#handler = input.handler;
    assertInteger(this.#maximumClockSkewMs, 1_000, 300_000, "maximumClockSkewMs");
    assertInteger(this.#dedupTtlMs, 1_000, 3_600_000, "dedupTtlMs");
  }

  async accept(input: {
    readonly authenticated: boolean;
    readonly message: ReliableMessageV1;
  }): Promise<Readonly<{ accepted: boolean; duplicate: boolean }>> {
    this.#received += 1;
    if (!this.#enabled) {
      this.#rejected += 1;
      fail("SHADOW_DISABLED", "Bluetooth command-bus shadow is disabled");
    }
    if (!input.authenticated) {
      this.#rejected += 1;
      fail("UNAUTHENTICATED_SHADOW", "shadow ingress requires an authenticated session");
    }
    if (input.message.type !== RELIABLE_FRAME_TYPES.SHADOW_DIAGNOSTIC) {
      this.#rejected += 1;
      fail("BUSINESS_MESSAGE_REJECTED", "non-diagnostic reliable type is forbidden");
    }
    const now = this.#checkedNow();
    this.#prune(now);
    let decoded: Readonly<BluetoothShadowMessageV1>;
    try {
      decoded = decodeBluetoothShadowMessageV1(input.message.payload);
    } catch (error) {
      this.#rejected += 1;
      throw error;
    }
    const latency = now - decoded.sentAtEpochMs;
    if (latency < 0 || latency > this.#maximumClockSkewMs) {
      this.#rejected += 1;
      fail("SHADOW_CLOCK_SKEW", "shadow message falls outside the clock window");
    }
    const seenUntil = this.#seen.get(decoded.correlationId);
    if (seenUntil !== undefined && seenUntil > now) {
      this.#duplicates += 1;
      return Object.freeze({ accepted: false, duplicate: true });
    }
    this.#seen.set(decoded.correlationId, now + this.#dedupTtlMs);
    try {
      await this.#handler(decoded);
    } catch (error) {
      this.#seen.delete(decoded.correlationId);
      this.#handlerFailures += 1;
      fail("SHADOW_HANDLER_FAILED", "diagnostic shadow handler failed", error);
    }
    this.#accepted += 1;
    this.#latencySamples += 1;
    this.#bleLatencyTotalMs += latency;
    if (decoded.lanLatencyMs !== null) {
      this.#lanLatencySamples += 1;
      this.#lanLatencyTotalMs += decoded.lanLatencyMs;
    }
    return Object.freeze({ accepted: true, duplicate: false });
  }

  snapshot(): Readonly<BluetoothShadowIngressMetricsV1> {
    const bleAverage =
      this.#latencySamples === 0
        ? null
        : this.#bleLatencyTotalMs / this.#latencySamples;
    const lanAverage =
      this.#lanLatencySamples === 0
        ? null
        : this.#lanLatencyTotalMs / this.#lanLatencySamples;
    return Object.freeze({
      enabled: this.#enabled,
      received: this.#received,
      accepted: this.#accepted,
      duplicates: this.#duplicates,
      rejected: this.#rejected,
      handlerFailures: this.#handlerFailures,
      bleLatencyAverageMs: bleAverage,
      lanLatencyAverageMs: lanAverage,
      latencyDeltaAverageMs:
        bleAverage === null || lanAverage === null
          ? null
          : bleAverage - lanAverage,
      businessMessagesForwarded: 0
    });
  }

  #checkedNow(): number {
    const now = this.#now();
    assertInteger(now, 0, Number.MAX_SAFE_INTEGER, "clock");
    if (now < this.#lastNowEpochMs) {
      fail("CLOCK_REGRESSION", "shadow ingress clock moved backwards");
    }
    this.#lastNowEpochMs = now;
    return now;
  }

  #prune(now: number): void {
    for (const [correlationId, expiresAt] of this.#seen) {
      if (expiresAt <= now) this.#seen.delete(correlationId);
    }
  }
}
