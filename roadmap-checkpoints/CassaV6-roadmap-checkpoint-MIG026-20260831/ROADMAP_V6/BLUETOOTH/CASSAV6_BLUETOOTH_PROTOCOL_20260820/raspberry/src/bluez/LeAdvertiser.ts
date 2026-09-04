import { createHmac, randomBytes as cryptoRandomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";

import {
  PROTOCOL_VERSION,
  encodeNodeAdvertisement,
  type NodeAdvertisementV1
} from "../../../shared/protocol/advertisement-v1.mjs";
import {
  ROUTE_ADVERTISEMENT_KINDS,
  ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET,
  type RouteAdvertisementKind
} from "../routing/RouteAdvertisementV1.js";
import { LE_ADVERTISEMENT_HEALTH_FRESHNESS_MS } from "../routing/RouteHealthBudgetV1.js";

const ALIAS_CONTEXT = Buffer.from("CASSA_V6-BT-ALIAS-V1\0", "utf8");
const ALIAS_KEY_BYTES = 32;
const ALIAS_EPOCH_SECONDS = 60;
const IDENTITY_SCHEMA_VERSION = 1;
const IDENTITY_KIND = "cassav6.bluetooth.raspberry-advertisement-identity";
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const NODE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ALIAS_PATTERN = /^[0-9a-f]{12}$/;
let temporaryFileCounter = 0;

export const LE_ADVERTISER_STATES = Object.freeze({
  IDLE: "IDLE",
  STARTING: "STARTING",
  ADVERTISING: "ADVERTISING",
  STOPPING: "STOPPING",
  STOPPED: "STOPPED",
  FAILED: "FAILED"
} as const);

export type LeAdvertiserState =
  (typeof LE_ADVERTISER_STATES)[keyof typeof LE_ADVERTISER_STATES];

export interface RaspberryRouteHealthV1 {
  readonly generation: number;
  readonly observedAtEpochMs: number;
  readonly canReachServer: boolean;
  readonly routeKind: RouteAdvertisementKind;
  readonly serverRttBucket: number;
  readonly queueDepthBucket: number;
  readonly batteryBucket: number;
}

export interface LeAdvertisementPortSnapshotV1 {
  readonly state: string;
  readonly desiredRunning: boolean;
  readonly registered: boolean;
  readonly bluezOwnerAvailable: boolean;
  readonly retryScheduled: boolean;
  readonly registrationsTotal: number;
  readonly replacementsTotal: number;
  readonly ownerLossesTotal: number;
  readonly errorsTotal: number;
  readonly lastErrorCode: string | null;
}

export interface LeAdvertisementPortV1 {
  start(input: Readonly<{
    adapterName: string;
    payload: Uint8Array;
  }>): Promise<Readonly<LeAdvertisementPortSnapshotV1>>;
  replace(payload: Uint8Array): Promise<Readonly<LeAdvertisementPortSnapshotV1>>;
  stop(): Promise<Readonly<LeAdvertisementPortSnapshotV1>>;
  snapshot(): Readonly<LeAdvertisementPortSnapshotV1>;
}

export interface LeAdvertiserSchedulerV1 {
  set(handler: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface RaspberryAdvertisementIdentityV1 {
  readonly bootId: number;
  deriveRotatingAlias(timestampSeconds: number): string;
}

interface StoredAdvertisementIdentityV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof IDENTITY_KIND;
  readonly nodeId: string;
  readonly aliasKeyBase64url: string;
  readonly lastBootId: number;
}

interface LoadedAdvertisementIdentityV1 {
  readonly value: Readonly<StoredAdvertisementIdentityV1>;
  readonly device: number;
  readonly inode: number;
}

const defaultScheduler: LeAdvertiserSchedulerV1 = Object.freeze({
  set(handler: () => void, delayMs: number) {
    return setTimeout(handler, delayMs);
  },
  clear(handle: unknown) {
    clearTimeout(handle as NodeJS.Timeout);
  }
});

export class LeAdvertiserError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LeAdvertiserError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new LeAdvertiserError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function modeBits(mode: number): number {
  return mode & 0o777;
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertSafeDirectory(path: string): void {
  const stat = lstatSync(path);
  const uid = currentUid();
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("UNSAFE_IDENTITY_DIRECTORY", "identity parent must be a real directory");
  }
  if (uid !== null && stat.uid !== uid) {
    fail("UNSAFE_IDENTITY_OWNER", "identity parent must be process-owned");
  }
  if (modeBits(stat.mode) !== DIRECTORY_MODE) {
    fail("UNSAFE_IDENTITY_MODE", "identity parent must have mode 0700");
  }
}

function assertSafeFile(path: string, descriptor: number): void {
  const descriptorStat = fstatSync(descriptor);
  const pathStat = lstatSync(path);
  const uid = currentUid();
  if (
    !descriptorStat.isFile() ||
    !pathStat.isFile() ||
    pathStat.isSymbolicLink() ||
    descriptorStat.dev !== pathStat.dev ||
    descriptorStat.ino !== pathStat.ino ||
    descriptorStat.nlink !== 1 ||
    pathStat.nlink !== 1
  ) {
    fail("UNSAFE_IDENTITY_FILE", "identity must be one regular unlinked file");
  }
  if (uid !== null && (descriptorStat.uid !== uid || pathStat.uid !== uid)) {
    fail("UNSAFE_IDENTITY_OWNER", "identity file must be process-owned");
  }
  if (modeBits(descriptorStat.mode) !== FILE_MODE || modeBits(pathStat.mode) !== FILE_MODE) {
    fail("UNSAFE_IDENTITY_MODE", "identity file must have mode 0600");
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  return (
    actual.length === normalizedExpected.length &&
    actual.every((key, index) => key === normalizedExpected[index])
  );
}

function decodeStoredIdentity(
  serialized: string,
  expectedNodeId: string
): Readonly<StoredAdvertisementIdentityV1> {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    fail("CORRUPT_IDENTITY", "advertisement identity is not valid JSON", error);
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "kind",
      "nodeId",
      "aliasKeyBase64url",
      "lastBootId"
    ])
  ) {
    fail("CORRUPT_IDENTITY", "advertisement identity has an invalid shape");
  }
  const candidate = value as Record<string, unknown>;
  const encodedKey = candidate.aliasKeyBase64url;
  const decodedKey =
    typeof encodedKey === "string"
      ? Buffer.from(encodedKey, "base64url")
      : Buffer.alloc(0);
  try {
    if (
      candidate.schemaVersion !== IDENTITY_SCHEMA_VERSION ||
      candidate.kind !== IDENTITY_KIND ||
      candidate.nodeId !== expectedNodeId ||
      typeof encodedKey !== "string" ||
      decodedKey.byteLength !== ALIAS_KEY_BYTES ||
      decodedKey.toString("base64url") !== encodedKey ||
      !Number.isSafeInteger(candidate.lastBootId) ||
      (candidate.lastBootId as number) < 1 ||
      (candidate.lastBootId as number) > 255
    ) {
      fail("CORRUPT_IDENTITY", "advertisement identity failed validation");
    }
    return Object.freeze({
      schemaVersion: IDENTITY_SCHEMA_VERSION,
      kind: IDENTITY_KIND,
      nodeId: expectedNodeId,
      aliasKeyBase64url: encodedKey,
      lastBootId: candidate.lastBootId as number
    });
  } finally {
    decodedKey.fill(0);
  }
}

function secureRandomBytes(
  source: (length: number) => Uint8Array,
  length: number,
  field: string
): Buffer {
  const value = Buffer.from(source(length));
  if (value.byteLength !== length) {
    value.fill(0);
    fail("INVALID_RANDOM_SOURCE", `${field} random source returned the wrong length`);
  }
  return value;
}

function chooseBootId(
  source: (length: number) => Uint8Array,
  previous: number
): number {
  const random = secureRandomBytes(source, 1, "bootId");
  try {
    const candidate = (random[0] % 255) + 1;
    return candidate === previous ? (candidate % 255) + 1 : candidate;
  } finally {
    random.fill(0);
  }
}

export class RaspberryAdvertisementIdentityStoreV1 {
  readonly #path: string;
  readonly #nodeId: string;
  readonly #randomBytes: (length: number) => Uint8Array;
  #aliasKey: Buffer | null = null;
  #bootId: number | null = null;

  constructor(input: Readonly<{
    path: string;
    nodeId: string;
    randomBytes?: (length: number) => Uint8Array;
  }>) {
    if (typeof input.path !== "string" || input.path.includes("\0")) {
      fail("INVALID_IDENTITY_PATH", "identity path is invalid");
    }
    if (!NODE_ID_PATTERN.test(input.nodeId)) {
      fail("INVALID_NODE_ID", "advertisement identity requires a canonical node UUID");
    }
    this.#path = resolve(input.path);
    this.#nodeId = input.nodeId;
    this.#randomBytes = input.randomBytes ?? cryptoRandomBytes;
  }

  beginBoot(): Readonly<RaspberryAdvertisementIdentityV1> {
    if (this.#aliasKey !== null || this.#bootId !== null) {
      fail("IDENTITY_ALREADY_ACTIVE", "advertisement identity lifecycle is already active");
    }
    const parent = dirname(this.#path);
    mkdirSync(parent, { recursive: true, mode: DIRECTORY_MODE });
    assertSafeDirectory(parent);

    const stored = this.#readExisting();
    const aliasKey =
      stored === null
        ? secureRandomBytes(this.#randomBytes, ALIAS_KEY_BYTES, "aliasKey")
        : Buffer.from(stored.value.aliasKeyBase64url, "base64url");
    const bootId = chooseBootId(
      this.#randomBytes,
      stored?.value.lastBootId ?? 0
    );
    try {
      this.#writeAtomic(
        {
          schemaVersion: IDENTITY_SCHEMA_VERSION,
          kind: IDENTITY_KIND,
          nodeId: this.#nodeId,
          aliasKeyBase64url: aliasKey.toString("base64url"),
          lastBootId: bootId
        },
        stored
      );
    } catch (error) {
      aliasKey.fill(0);
      throw error;
    }
    this.#aliasKey = aliasKey;
    this.#bootId = bootId;
    return Object.freeze({
      bootId,
      deriveRotatingAlias: (timestampSeconds: number) =>
        this.#deriveRotatingAlias(timestampSeconds)
    });
  }

  close(): void {
    this.#aliasKey?.fill(0);
    this.#aliasKey = null;
    this.#bootId = null;
  }

  snapshot(): Readonly<{
    active: boolean;
    schemaVersion: 1;
    exposesAliasKey: false;
    exposesBootId: false;
  }> {
    return Object.freeze({
      active: this.#aliasKey !== null,
      schemaVersion: IDENTITY_SCHEMA_VERSION,
      exposesAliasKey: false,
      exposesBootId: false
    });
  }

  toString(): string {
    return "RaspberryAdvertisementIdentityStoreV1(<redacted>)";
  }

  #readExisting(): Readonly<LoadedAdvertisementIdentityV1> | null {
    let descriptor: number;
    try {
      descriptor = openSync(
        this.#path,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
      );
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      fail("IDENTITY_OPEN_FAILED", "cannot open advertisement identity", error);
    }
    try {
      assertSafeFile(this.#path, descriptor);
      const stat = fstatSync(descriptor);
      const serialized = readFileSync(descriptor, "utf8");
      if (Buffer.byteLength(serialized, "utf8") > 4_096) {
        fail("CORRUPT_IDENTITY", "advertisement identity exceeds its size limit");
      }
      return Object.freeze({
        value: decodeStoredIdentity(serialized, this.#nodeId),
        device: stat.dev,
        inode: stat.ino
      });
    } finally {
      closeSync(descriptor);
    }
  }

  #writeAtomic(
    value: Readonly<StoredAdvertisementIdentityV1>,
    expected: Readonly<LoadedAdvertisementIdentityV1> | null
  ): void {
    const parent = dirname(this.#path);
    temporaryFileCounter += 1;
    const temporaryPath = `${this.#path}.tmp-${process.pid}-${temporaryFileCounter}`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(
        temporaryPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0),
        FILE_MODE
      );
      fchmodSync(descriptor, FILE_MODE);
      writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      this.#assertCommitTarget(expected);
      renameSync(temporaryPath, this.#path);
      const directoryDescriptor = openSync(
        parent,
        fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0)
      );
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
      const committed = openSync(
        this.#path,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
      );
      try {
        assertSafeFile(this.#path, committed);
      } finally {
        closeSync(committed);
      }
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The atomic destination, when present, is authoritative.
      }
      if (error instanceof LeAdvertiserError) throw error;
      fail("IDENTITY_COMMIT_FAILED", "cannot commit advertisement identity", error);
    }
  }

  #assertCommitTarget(
    expected: Readonly<LoadedAdvertisementIdentityV1> | null
  ): void {
    let stat;
    try {
      stat = lstatSync(this.#path);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        if (expected === null) return;
        fail(
          "IDENTITY_COMMIT_CONFLICT",
          "advertisement identity disappeared during commit"
        );
      }
      fail("IDENTITY_COMMIT_FAILED", "cannot inspect identity commit target", error);
    }
    if (
      expected === null ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.dev !== expected.device ||
      stat.ino !== expected.inode
    ) {
      fail(
        "IDENTITY_COMMIT_CONFLICT",
        "advertisement identity changed during commit"
      );
    }
  }

  #deriveRotatingAlias(timestampSeconds: number): string {
    const aliasKey = this.#aliasKey;
    if (aliasKey === null) {
      fail("IDENTITY_NOT_ACTIVE", "advertisement identity is not active");
    }
    if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
      fail("INVALID_CLOCK", "alias timestamp is outside its canonical range");
    }
    const epoch = Math.floor(timestampSeconds / ALIAS_EPOCH_SECONDS);
    const epochBytes = Buffer.alloc(8);
    epochBytes.writeBigUInt64BE(BigInt(epoch));
    const message = Buffer.concat([
      ALIAS_CONTEXT,
      Buffer.from(this.#nodeId, "utf8"),
      Buffer.from([0]),
      epochBytes
    ]);
    try {
      return createHmac("sha256", aliasKey)
        .update(message)
        .digest("hex")
        .slice(0, 12);
    } finally {
      epochBytes.fill(0);
      message.fill(0);
    }
  }
}

function validateInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("INVALID_ADVERTISER_INPUT", `${field} is outside its canonical range`);
  }
  return value;
}

function validateRouteHealth(value: Readonly<RaspberryRouteHealthV1>): void {
  validateInteger(value.generation, 1, Number.MAX_SAFE_INTEGER, "generation");
  validateInteger(
    value.observedAtEpochMs,
    0,
    Number.MAX_SAFE_INTEGER,
    "observedAtEpochMs"
  );
  if (!Object.values(ROUTE_ADVERTISEMENT_KINDS).includes(value.routeKind)) {
    fail("INVALID_ADVERTISER_INPUT", "routeKind is not assigned");
  }
  if (
    !((value.serverRttBucket >= 0 && value.serverRttBucket <= 7) ||
      value.serverRttBucket === ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET)
  ) {
    fail("INVALID_ADVERTISER_INPUT", "serverRttBucket is reserved");
  }
  validateInteger(value.queueDepthBucket, 0, 15, "queueDepthBucket");
  if (
    !((value.batteryBucket >= 0 && value.batteryBucket <= 10) ||
      value.batteryBucket === ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET)
  ) {
    fail("INVALID_ADVERTISER_INPUT", "batteryBucket is reserved");
  }
  if (
    value.canReachServer
      ? value.routeKind !== ROUTE_ADVERTISEMENT_KINDS.LAN ||
        value.serverRttBucket === ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET
      : value.routeKind !== ROUTE_ADVERTISEMENT_KINDS.NONE ||
        value.serverRttBucket !== ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET
  ) {
    fail("INVALID_ADVERTISER_INPUT", "route health fields are inconsistent");
  }
}

function sameDiscoveryState(
  first: Readonly<NodeAdvertisementV1>,
  second: Readonly<NodeAdvertisementV1>
): boolean {
  return (
    first.protocolVersion === second.protocolVersion &&
    first.nodeKind === second.nodeKind &&
    first.rotatingAlias === second.rotatingAlias &&
    first.bootId === second.bootId &&
    first.capabilities === second.capabilities &&
    first.serverReachable === second.serverReachable
  );
}

export class LeAdvertiser {
  readonly #adapterName: string;
  readonly #identity: Readonly<RaspberryAdvertisementIdentityV1>;
  readonly #capabilities: number;
  readonly #port: LeAdvertisementPortV1;
  readonly #scheduler: LeAdvertiserSchedulerV1;
  readonly #epochNow: () => number;
  readonly #monotonicNow: () => number;
  readonly #freshnessMs: number;
  readonly #onFatal: (error: unknown) => void;
  #state: LeAdvertiserState = LE_ADVERTISER_STATES.IDLE;
  #timer: unknown | null = null;
  #tail: Promise<void> = Promise.resolve();
  #current: Readonly<NodeAdvertisementV1> | null = null;
  #health: Readonly<RaspberryRouteHealthV1> | null = null;
  #healthReceivedAtMonotonicMs: number | null = null;
  #lastEpochMs = 0;
  #lastMonotonicMs = 0;
  #updatesTotal = 0;
  #healthUpdatesTotal = 0;
  #staleDowngradesTotal = 0;
  #fatalReported = false;

  constructor(input: Readonly<{
    adapterName: string;
    identity: Readonly<RaspberryAdvertisementIdentityV1>;
    capabilities: number;
    port: LeAdvertisementPortV1;
    scheduler?: LeAdvertiserSchedulerV1;
    epochNow?: () => number;
    monotonicNow?: () => number;
    freshnessMs?: number;
    onFatal?: (error: unknown) => void;
  }>) {
    if (!/^hci[0-9]+$/.test(input.adapterName)) {
      fail("INVALID_ADVERTISER_INPUT", "adapterName is invalid");
    }
    validateInteger(input.identity.bootId, 1, 255, "bootId");
    validateInteger(input.capabilities, 0, 0x7f, "capabilities");
    if (typeof input.identity.deriveRotatingAlias !== "function") {
      fail("INVALID_ADVERTISER_INPUT", "identity alias source is missing");
    }
    this.#adapterName = input.adapterName;
    this.#identity = input.identity;
    this.#capabilities = input.capabilities;
    this.#port = input.port;
    this.#scheduler = input.scheduler ?? defaultScheduler;
    this.#epochNow = input.epochNow ?? Date.now;
    this.#monotonicNow = input.monotonicNow ?? (() => performance.now());
    this.#freshnessMs =
      input.freshnessMs ?? LE_ADVERTISEMENT_HEALTH_FRESHNESS_MS;
    validateInteger(this.#freshnessMs, 1_000, 4_000, "freshnessMs");
    this.#onFatal = input.onFatal ?? (() => undefined);
  }

  start(): Promise<Readonly<ReturnType<LeAdvertiser["snapshot"]>>> {
    return this.#serialize(async () => {
      if (this.#state === LE_ADVERTISER_STATES.ADVERTISING) {
        return this.snapshot();
      }
      if (
        this.#state !== LE_ADVERTISER_STATES.IDLE &&
        this.#state !== LE_ADVERTISER_STATES.STOPPED
      ) {
        fail("ADVERTISER_NOT_STARTABLE", `cannot start advertiser from ${this.#state}`);
      }
      this.#state = LE_ADVERTISER_STATES.STARTING;
      try {
        const now = this.#checkedClocks();
        const current = this.#buildAdvertisement(now.epochMs, now.monotonicMs, 0);
        await this.#port.start({
          adapterName: this.#adapterName,
          payload: encodeNodeAdvertisement(current)
        });
        this.#current = current;
        this.#state = LE_ADVERTISER_STATES.ADVERTISING;
        this.#scheduleRefresh(now.epochMs, now.monotonicMs);
        return this.snapshot();
      } catch (error) {
        await this.#terminate(error);
        throw error;
      }
    });
  }

  updateRouteHealth(
    health: Readonly<RaspberryRouteHealthV1>
  ): Promise<Readonly<ReturnType<LeAdvertiser["snapshot"]>>> {
    return this.#serialize(async () => {
      try {
        validateRouteHealth(health);
        const now = this.#checkedClocks();
        if (
          health.observedAtEpochMs > now.epochMs ||
          (this.#health !== null &&
            (health.generation <= this.#health.generation ||
              health.observedAtEpochMs < this.#health.observedAtEpochMs))
        ) {
          fail(
            "HEALTH_SIGNAL_REGRESSION",
            "route health generation or clock regressed"
          );
        }
        this.#health = Object.freeze({ ...health });
        this.#healthReceivedAtMonotonicMs = now.monotonicMs;
        this.#healthUpdatesTotal += 1;
        if (this.#state === LE_ADVERTISER_STATES.ADVERTISING) {
          await this.#refresh(now.epochMs, now.monotonicMs);
        }
        return this.snapshot();
      } catch (error) {
        await this.#terminate(error);
        throw error;
      }
    });
  }

  stop(): Promise<Readonly<ReturnType<LeAdvertiser["snapshot"]>>> {
    return this.#serialize(async () => {
      this.#cancelRefresh();
      if (
        this.#state === LE_ADVERTISER_STATES.IDLE ||
        this.#state === LE_ADVERTISER_STATES.STOPPED
      ) {
        this.#state = LE_ADVERTISER_STATES.STOPPED;
        return this.snapshot();
      }
      this.#state = LE_ADVERTISER_STATES.STOPPING;
      try {
        await this.#port.stop();
        this.#current = null;
        this.#state = LE_ADVERTISER_STATES.STOPPED;
        return this.snapshot();
      } catch (error) {
        this.#state = LE_ADVERTISER_STATES.FAILED;
        this.#reportFatal(error);
        throw error;
      }
    });
  }

  snapshot(): Readonly<{
    state: LeAdvertiserState;
    serverReachable: boolean;
    healthFresh: boolean;
    routeKind: RouteAdvertisementKind;
    serverRttBucket: number;
    queueDepthBucket: number;
    batteryBucket: number;
    healthGeneration: number;
    updatesTotal: number;
    healthUpdatesTotal: number;
    staleDowngradesTotal: number;
    exposesRotatingAlias: false;
    exposesBootId: false;
    port: Readonly<LeAdvertisementPortSnapshotV1>;
  }> {
    let healthFresh = false;
    if (this.#healthReceivedAtMonotonicMs !== null) {
      const now = this.#monotonicNow();
      healthFresh =
        Number.isFinite(now) &&
        now >= this.#lastMonotonicMs &&
        now - this.#healthReceivedAtMonotonicMs <= this.#freshnessMs;
    }
    return Object.freeze({
      state: this.#state,
      serverReachable: this.#current?.serverReachable ?? false,
      healthFresh,
      routeKind: this.#health?.routeKind ?? ROUTE_ADVERTISEMENT_KINDS.NONE,
      serverRttBucket:
        this.#health?.serverRttBucket ?? ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET,
      queueDepthBucket: this.#health?.queueDepthBucket ?? 0,
      batteryBucket:
        this.#health?.batteryBucket ?? ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET,
      healthGeneration: this.#health?.generation ?? 0,
      updatesTotal: this.#updatesTotal,
      healthUpdatesTotal: this.#healthUpdatesTotal,
      staleDowngradesTotal: this.#staleDowngradesTotal,
      exposesRotatingAlias: false,
      exposesBootId: false,
      port: this.#port.snapshot()
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  #checkedClocks(): Readonly<{ epochMs: number; monotonicMs: number }> {
    const epochMs = this.#epochNow();
    const monotonicMs = this.#monotonicNow();
    if (
      !Number.isSafeInteger(epochMs) ||
      epochMs < this.#lastEpochMs ||
      !Number.isFinite(monotonicMs) ||
      monotonicMs < this.#lastMonotonicMs
    ) {
      fail("CLOCK_REGRESSION", "advertiser clock moved backwards");
    }
    this.#lastEpochMs = epochMs;
    this.#lastMonotonicMs = monotonicMs;
    return Object.freeze({ epochMs, monotonicMs });
  }

  #buildAdvertisement(
    epochMs: number,
    monotonicMs: number,
    sequence: number
  ): Readonly<NodeAdvertisementV1> {
    const alias = this.#identity.deriveRotatingAlias(Math.floor(epochMs / 1_000));
    if (!ALIAS_PATTERN.test(alias)) {
      fail("INVALID_ALIAS_SOURCE", "identity returned a non-canonical alias");
    }
    const healthFresh =
      this.#health !== null &&
      this.#healthReceivedAtMonotonicMs !== null &&
      monotonicMs - this.#healthReceivedAtMonotonicMs <= this.#freshnessMs;
    return Object.freeze({
      protocolVersion: PROTOCOL_VERSION,
      nodeKind: "raspberry",
      rotatingAlias: alias,
      bootId: this.#identity.bootId,
      capabilities: this.#capabilities,
      serverReachable:
        healthFresh &&
        this.#health?.canReachServer === true &&
        this.#health.routeKind === ROUTE_ADVERTISEMENT_KINDS.LAN,
      sequence
    });
  }

  async #refresh(epochMs: number, monotonicMs: number): Promise<void> {
    const current = this.#current;
    if (current === null) return;
    const candidate = this.#buildAdvertisement(
      epochMs,
      monotonicMs,
      current.sequence
    );
    if (sameDiscoveryState(candidate, current)) {
      this.#scheduleRefresh(epochMs, monotonicMs);
      return;
    }
    const next = Object.freeze({
      ...candidate,
      sequence: (current.sequence + 1) & 0xff
    });
    if (current.serverReachable && !next.serverReachable) {
      const age =
        this.#healthReceivedAtMonotonicMs === null
          ? Number.POSITIVE_INFINITY
          : monotonicMs - this.#healthReceivedAtMonotonicMs;
      if (age > this.#freshnessMs) this.#staleDowngradesTotal += 1;
    }
    await this.#port.replace(encodeNodeAdvertisement(next));
    this.#current = next;
    this.#updatesTotal += 1;
    this.#scheduleRefresh(epochMs, monotonicMs);
  }

  #scheduleRefresh(epochMs: number, monotonicMs: number): void {
    this.#cancelRefresh();
    if (this.#state !== LE_ADVERTISER_STATES.ADVERTISING) return;
    const timestampSeconds = Math.floor(epochMs / 1_000);
    const nextAliasEpochSeconds =
      (Math.floor(timestampSeconds / ALIAS_EPOCH_SECONDS) + 1) *
      ALIAS_EPOCH_SECONDS;
    let delayMs = Math.max(1, nextAliasEpochSeconds * 1_000 - epochMs);
    if (
      this.#health?.canReachServer === true &&
      this.#healthReceivedAtMonotonicMs !== null
    ) {
      delayMs = Math.min(
        delayMs,
        Math.max(
          1,
          this.#healthReceivedAtMonotonicMs + this.#freshnessMs - monotonicMs
        )
      );
    }
    this.#timer = this.#scheduler.set(() => {
      this.#timer = null;
      void this.#serialize(async () => {
        try {
          const now = this.#checkedClocks();
          await this.#refresh(now.epochMs, now.monotonicMs);
        } catch (error) {
          await this.#terminate(error);
        }
      });
    }, delayMs);
  }

  #cancelRefresh(): void {
    if (this.#timer === null) return;
    this.#scheduler.clear(this.#timer);
    this.#timer = null;
  }

  async #terminate(error: unknown): Promise<void> {
    this.#cancelRefresh();
    this.#state = LE_ADVERTISER_STATES.FAILED;
    this.#current = null;
    try {
      await this.#port.stop();
    } catch {
      // Disconnecting the D-Bus port is its own final fail-closed action.
    }
    this.#reportFatal(error);
  }

  #reportFatal(error: unknown): void {
    if (this.#fatalReported) return;
    this.#fatalReported = true;
    this.#onFatal(error);
  }
}
