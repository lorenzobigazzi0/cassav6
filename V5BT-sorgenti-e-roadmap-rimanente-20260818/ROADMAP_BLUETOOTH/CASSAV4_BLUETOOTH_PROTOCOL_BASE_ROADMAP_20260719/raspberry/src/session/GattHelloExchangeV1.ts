import {
  createHash,
  randomBytes as cryptoRandomBytes
} from "node:crypto";

import { CAPABILITY_BITS } from "../../../shared/protocol/advertisement-v1.mjs";
import {
  HELLO_V1_MAX_CAPABILITIES,
  HELLO_V1_MINIMUM_MTU,
  HELLO_V1_NODE_ID_PATTERN_SOURCE,
  HELLO_V1_PROTOCOL_VERSION,
  HelloV1Error,
  decodeHelloV1,
  encodeHelloV1,
  generateHelloNonceV1,
  type HelloV1
} from "../../../shared/protocol/hello-v1.mjs";
import {
  MUTUAL_AUTH_V1_MESSAGE_TYPES,
  MUTUAL_AUTH_V1_MINIMUM_MTU,
  MutualAuthV1Error,
  decodeAuthClientProofV1,
  decodeAuthFinishV1,
  encodeAuthServerProofV1,
  type MutualAuthBindingV1
} from "../../../shared/protocol/mutual-auth-v1.mjs";
import {
  DIRECT_CONTROL_V1_CLOSE_REASONS,
  DIRECT_CONTROL_V1_MAX_SEQUENCE,
  DIRECT_CONTROL_V1_MESSAGE_TYPES,
  DIRECT_CONTROL_V1_MINIMUM_MTU,
  type DirectControlCloseReasonV1
} from "../../../shared/protocol/direct-control-v1.mjs";
import {
  DIRECT_SESSION_EVENTS,
  DIRECT_SESSION_ROLES,
  DIRECT_SESSION_STATES,
  DirectSessionV1
} from "../../../shared/session/direct-session-v1.mjs";
import {
  MutualAuthHandshakeError,
  type MutualAuthHandshakeV1
} from "../security/Handshake.js";
import {
  DirectControlHandshakeError,
  type DirectControlHandshakeV1,
  type DirectControlReliableChannelMaterialV1,
  type DirectControlServerSessionV1
} from "../security/DirectControlHandshakeV1.js";

export const DEFAULT_HELLO_EXCHANGE_TTL_MS = 30_000;
export const DEFAULT_MAX_HELLO_EXCHANGES = 32;
export const DEFAULT_DIRECT_CONTROL_HEARTBEAT_INTERVAL_MS = 3_000;
export const DEFAULT_DIRECT_CONTROL_HEARTBEAT_MISSES_BEFORE_CLOSE = 3;
export const DEFAULT_DIRECT_CONTROL_ACTIVE_IDLE_TTL_MS = 120_000;
export const DEFAULT_DIRECT_CONTROL_CLOSE_GRACE_MS = 2_500;

const DEVICE_PATH_PATTERN =
  /^\/org\/bluez\/hci[0-9]+\/dev_(?:[0-9A-Fa-f]{2}_){5}[0-9A-Fa-f]{2}$/;
const NODE_ID_PATTERN = new RegExp(HELLO_V1_NODE_ID_PATTERN_SOURCE);

export const GATT_HELLO_EXCHANGE_STATES = Object.freeze({
  RESPONSE_READY: "RESPONSE_READY",
  RESPONSE_DELIVERED: "RESPONSE_DELIVERED",
  FAILED: "FAILED"
} as const);

export const GATT_MUTUAL_AUTH_STATES = Object.freeze({
  HELLO_ONLY: "HELLO_ONLY",
  VERIFYING_CLIENT: "VERIFYING_CLIENT",
  SERVER_PROOF_READY: "SERVER_PROOF_READY",
  VERIFYING_FINISH: "VERIFYING_FINISH",
  AUTHENTICATED: "AUTHENTICATED",
  FAILED: "FAILED"
} as const);

export const GATT_DIRECT_CONTROL_STATES = Object.freeze({
  DISABLED: "DISABLED",
  AWAITING_CLIENT_SHARE: "AWAITING_CLIENT_SHARE",
  VERIFYING_CLIENT_SHARE: "VERIFYING_CLIENT_SHARE",
  AWAITING_CLIENT_CONFIRMATION: "AWAITING_CLIENT_CONFIRMATION",
  ACTIVATING: "ACTIVATING",
  ACTIVE: "ACTIVE",
  CLOSING: "CLOSING",
  FAILED: "FAILED"
} as const);

export type GattMutualAuthState =
  (typeof GATT_MUTUAL_AUTH_STATES)[keyof typeof GATT_MUTUAL_AUTH_STATES];

export type GattHelloExchangeState =
  (typeof GATT_HELLO_EXCHANGE_STATES)[keyof typeof GATT_HELLO_EXCHANGE_STATES];

export type GattDirectControlState =
  (typeof GATT_DIRECT_CONTROL_STATES)[keyof typeof GATT_DIRECT_CONTROL_STATES];

export interface GattHelloServerIdentityV1 {
  readonly nodeId: string;
  readonly bootId: number;
  readonly capabilities: number;
}

export interface GattHelloExchangeInput {
  readonly devicePath: string;
  readonly mtu: number;
  readonly value: Uint8Array;
}

export interface GattHelloReadInput {
  readonly devicePath: string;
  readonly offset: number;
}

export interface GattAuthWriteInput {
  readonly devicePath: string;
  readonly value: Uint8Array;
}

export interface GattControlOutputV1 {
  readonly devicePath: string;
  readonly value: Buffer;
}

export interface GattControlSchedulerV1 {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface GattHelloExchangeSnapshotV1 {
  readonly enabled: boolean;
  readonly activeExchangeCount: number;
  readonly responseReadyCount: number;
  readonly responseDeliveredCount: number;
  readonly failedExchangeCount: number;
  readonly writesAcceptedTotal: number;
  readonly readsDeliveredTotal: number;
  readonly helloExchangedTotal: number;
  readonly duplicateWritesTotal: number;
  readonly duplicateReadsTotal: number;
  readonly bindingConflictsTotal: number;
  readonly capacityRejectedTotal: number;
  readonly expiredTotal: number;
  readonly failuresTotal: number;
  readonly resetsTotal: number;
  readonly mutualAuthEnabled: boolean;
  readonly authStartedTotal: number;
  readonly clientProofsVerifiedTotal: number;
  readonly serverProofsIssuedTotal: number;
  readonly finishProofsVerifiedTotal: number;
  readonly authDuplicateWritesTotal: number;
  readonly authReplayRejectedTotal: number;
  readonly authFailuresTotal: number;
  readonly authenticatedSessionCount: number;
  readonly directControlEnabled: boolean;
  readonly clientKeySharesAcceptedTotal: number;
  readonly serverKeySharesIssuedTotal: number;
  readonly clientKeyConfirmationsVerifiedTotal: number;
  readonly keyEstablishedTotal: number;
  readonly heartbeatStartedTotal: number;
  readonly pingsSentTotal: number;
  readonly pongsVerifiedTotal: number;
  readonly heartbeatMissesTotal: number;
  readonly activeSessionsTotal: number;
  readonly cleanClosesTotal: number;
  readonly heartbeatTimeoutClosesTotal: number;
  readonly forcedClosesTotal: number;
  readonly directControlDuplicateWritesTotal: number;
  readonly directControlFailuresTotal: number;
  readonly keyEstablishedSessionCount: number;
  readonly activeSessionCount: number;
  readonly closingSessionCount: number;
  readonly activeTimerCount: number;
  readonly retainedSecretBufferCount: number;
}

export class GattHelloExchangeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GattHelloExchangeError";
    this.code = code;
  }
}

interface ExchangeEntry {
  readonly requestFingerprint: string;
  readonly request: Readonly<HelloV1>;
  readonly responseHello: Readonly<HelloV1>;
  readonly response: Buffer;
  readonly session: DirectSessionV1;
  readonly sessionId: string;
  readonly mtu: number;
  expiresAtMs: number;
  state: GattHelloExchangeState;
  authState: GattMutualAuthState;
  authRequestFingerprint: string | null;
  finishFingerprint: string | null;
  certificateId: string | null;
  peerTrustId: string | null;
  clientSignature: Buffer | null;
  serverProof: Buffer | null;
  serverProofResponse: Buffer | null;
  directControlState: GattDirectControlState;
  directControlContext: DirectControlServerSessionV1 | null;
  keyShareFingerprint: string | null;
  keyShareResponse: Buffer | null;
  keyConfirmFingerprint: string | null;
  pendingPingSequence: number | null;
  pendingPingWire: Buffer | null;
  lastAcceptedPongFingerprint: string | null;
  nextPingSequence: number;
  heartbeatMisses: number;
  heartbeatTimer: unknown | null;
  closingSequence: number | null;
  closingReason: DirectControlCloseReasonV1 | null;
  serverClosePending: boolean;
  closeTimer: unknown | null;
}

export interface GattHelloExchangeOptions {
  readonly enabled: boolean;
  readonly identity?: Readonly<GattHelloServerIdentityV1>;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly clock?: () => number;
  readonly exchangeTtlMs?: number;
  readonly maxActiveExchanges?: number;
  readonly mutualAuthEnabled?: boolean;
  readonly handshake?: MutualAuthHandshakeV1;
  readonly directControlEnabled?: boolean;
  readonly directControlHandshake?: DirectControlHandshakeV1;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatMissesBeforeClose?: number;
  readonly activeSessionIdleTtlMs?: number;
  readonly closeGraceMs?: number;
  readonly scheduler?: GattControlSchedulerV1;
}

const DEFAULT_CONTROL_SCHEDULER: GattControlSchedulerV1 = Object.freeze({
  set(callback: () => void, delayMs: number): unknown {
    return setTimeout(callback, delayMs);
  },
  clear(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
});

function fail(
  code: string,
  message: string,
  cause?: unknown
): never {
  throw new GattHelloExchangeError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function increment(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function validateInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(
      `INVALID_${field.toUpperCase()}`,
      `${field} must be an integer from ${minimum} to ${maximum}`
    );
  }
  return value;
}

function validateIdentity(
  enabled: boolean,
  value: Readonly<GattHelloServerIdentityV1> | undefined
): Readonly<GattHelloServerIdentityV1> | null {
  if (!enabled) {
    return null;
  }
  if (
    value === undefined ||
    !NODE_ID_PATTERN.test(value.nodeId) ||
    !Number.isSafeInteger(value.bootId) ||
    value.bootId < 1 ||
    value.bootId > 255 ||
    !Number.isSafeInteger(value.capabilities) ||
    value.capabilities < 0 ||
    value.capabilities > HELLO_V1_MAX_CAPABILITIES ||
    (value.capabilities & CAPABILITY_BITS.GATT_SERVER) === 0
  ) {
    fail(
      "INVALID_SERVER_IDENTITY",
      "enabled HELLO requires canonical server identity and GATT_SERVER capability"
    );
  }
  return Object.freeze({ ...value });
}

function validateDevicePath(value: string): string {
  if (typeof value !== "string" || !DEVICE_PATH_PATTERN.test(value)) {
    fail(
      "INVALID_DEVICE_CONTEXT",
      "HELLO requires a canonical BlueZ device context"
    );
  }
  return value;
}

function requestFingerprint(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeClock(clock: () => number): number {
  const nowMs = clock();
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    fail("INVALID_MONOTONIC_CLOCK", "HELLO clock must be monotonic");
  }
  return nowMs;
}

export class GattHelloExchangeV1 {
  readonly #enabled: boolean;
  readonly #identity: Readonly<GattHelloServerIdentityV1> | null;
  readonly #randomBytes: (length: number) => Uint8Array;
  readonly #clock: () => number;
  readonly #exchangeTtlMs: number;
  readonly #maxActiveExchanges: number;
  readonly #mutualAuthEnabled: boolean;
  readonly #handshake: MutualAuthHandshakeV1 | null;
  readonly #directControlEnabled: boolean;
  readonly #directControlHandshake: DirectControlHandshakeV1 | null;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatMissesBeforeClose: number;
  readonly #activeSessionIdleTtlMs: number;
  readonly #closeGraceMs: number;
  readonly #scheduler: GattControlSchedulerV1;
  readonly #entries = new Map<string, ExchangeEntry>();
  #controlPublisher: ((output: Readonly<GattControlOutputV1>) => void) | null =
    null;
  #lastClockMs: number | null = null;
  #writesAcceptedTotal = 0;
  #readsDeliveredTotal = 0;
  #helloExchangedTotal = 0;
  #duplicateWritesTotal = 0;
  #duplicateReadsTotal = 0;
  #bindingConflictsTotal = 0;
  #capacityRejectedTotal = 0;
  #expiredTotal = 0;
  #failuresTotal = 0;
  #resetsTotal = 0;
  #authStartedTotal = 0;
  #clientProofsVerifiedTotal = 0;
  #serverProofsIssuedTotal = 0;
  #finishProofsVerifiedTotal = 0;
  #authDuplicateWritesTotal = 0;
  #authReplayRejectedTotal = 0;
  #authFailuresTotal = 0;
  #clientKeySharesAcceptedTotal = 0;
  #serverKeySharesIssuedTotal = 0;
  #clientKeyConfirmationsVerifiedTotal = 0;
  #keyEstablishedTotal = 0;
  #heartbeatStartedTotal = 0;
  #pingsSentTotal = 0;
  #pongsVerifiedTotal = 0;
  #heartbeatMissesTotal = 0;
  #activeSessionsTotal = 0;
  #cleanClosesTotal = 0;
  #heartbeatTimeoutClosesTotal = 0;
  #forcedClosesTotal = 0;
  #directControlDuplicateWritesTotal = 0;
  #directControlFailuresTotal = 0;

  constructor(options: GattHelloExchangeOptions) {
    this.#enabled = options.enabled;
    this.#identity = validateIdentity(options.enabled, options.identity);
    this.#randomBytes = options.randomBytes ?? cryptoRandomBytes;
    this.#clock = options.clock ?? (() => performance.now());
    this.#exchangeTtlMs = validateInteger(
      options.exchangeTtlMs ?? DEFAULT_HELLO_EXCHANGE_TTL_MS,
      1_000,
      300_000,
      "exchangeTtlMs"
    );
    const configuredMaxActiveExchanges = validateInteger(
      options.maxActiveExchanges ?? DEFAULT_MAX_HELLO_EXCHANGES,
      1,
      256,
      "maxActiveExchanges"
    );
    this.#mutualAuthEnabled = options.mutualAuthEnabled ?? false;
    this.#handshake = options.handshake ?? null;
    this.#directControlEnabled = options.directControlEnabled ?? false;
    this.#directControlHandshake = options.directControlHandshake ?? null;
    this.#maxActiveExchanges = this.#directControlEnabled
      ? 1
      : configuredMaxActiveExchanges;
    this.#heartbeatIntervalMs = validateInteger(
      options.heartbeatIntervalMs ??
        DEFAULT_DIRECT_CONTROL_HEARTBEAT_INTERVAL_MS,
      1,
      300_000,
      "heartbeatIntervalMs"
    );
    this.#heartbeatMissesBeforeClose = validateInteger(
      options.heartbeatMissesBeforeClose ??
        DEFAULT_DIRECT_CONTROL_HEARTBEAT_MISSES_BEFORE_CLOSE,
      1,
      100,
      "heartbeatMissesBeforeClose"
    );
    this.#activeSessionIdleTtlMs = validateInteger(
      options.activeSessionIdleTtlMs ??
        DEFAULT_DIRECT_CONTROL_ACTIVE_IDLE_TTL_MS,
      1_000,
      3_600_000,
      "activeSessionIdleTtlMs"
    );
    this.#closeGraceMs = validateInteger(
      options.closeGraceMs ?? DEFAULT_DIRECT_CONTROL_CLOSE_GRACE_MS,
      1,
      60_000,
      "closeGraceMs"
    );
    this.#scheduler = options.scheduler ?? DEFAULT_CONTROL_SCHEDULER;
    if (
      typeof this.#scheduler.set !== "function" ||
      typeof this.#scheduler.clear !== "function"
    ) {
      fail(
        "INVALID_CONTROL_SCHEDULER",
        "direct-control scheduler must provide set and clear"
      );
    }
    if (
      this.#mutualAuthEnabled &&
      (!this.#enabled || this.#handshake === null)
    ) {
      fail(
        "INVALID_AUTH_CONFIGURATION",
        "mutual auth requires enabled HELLO and a handshake adapter"
      );
    }
    if (
      this.#directControlEnabled &&
      (!this.#mutualAuthEnabled || this.#directControlHandshake === null)
    ) {
      fail(
        "INVALID_DIRECT_CONTROL_CONFIGURATION",
        "direct control requires mutual auth and a direct-control handshake adapter"
      );
    }
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get mutualAuthEnabled(): boolean {
    return this.#mutualAuthEnabled;
  }

  get directControlEnabled(): boolean {
    return this.#directControlEnabled;
  }

  setControlPublisher(
    publisher: ((output: Readonly<GattControlOutputV1>) => void) | null
  ): void {
    if (publisher !== null && typeof publisher !== "function") {
      fail("INVALID_CONTROL_PUBLISHER", "control publisher must be a function");
    }
    this.#controlPublisher = publisher;
  }

  reliableChannelContext(devicePathValue: string): Readonly<{
    peerTrustId: string;
    mtu: number;
    material: DirectControlReliableChannelMaterialV1;
  }> {
    this.#assertDirectControlEnabled();
    const devicePath = validateDevicePath(devicePathValue);
    const nowMs = this.#readNow();
    this.#pruneExpired(nowMs);
    const entry = this.#entries.get(devicePath);
    if (
      entry === undefined ||
      entry.directControlState !== GATT_DIRECT_CONTROL_STATES.ACTIVE ||
      entry.directControlContext === null ||
      entry.peerTrustId === null ||
      entry.session.state !== DIRECT_SESSION_STATES.ACTIVE
    ) {
      fail(
        "RELIABLE_CHANNEL_NOT_AUTHORIZED",
        "reliable data plane requires one active authenticated session"
      );
    }
    return Object.freeze({
      peerTrustId: entry.peerTrustId,
      mtu: entry.mtu,
      material: entry.directControlContext.exportReliableChannelMaterial()
    });
  }

  requestClose(
    devicePathValue: string,
    reason: DirectControlCloseReasonV1 =
      DIRECT_CONTROL_V1_CLOSE_REASONS.NORMAL
  ): void {
    this.#assertDirectControlEnabled();
    const devicePath = validateDevicePath(devicePathValue);
    if (!(Object.values(DIRECT_CONTROL_V1_CLOSE_REASONS) as number[]).includes(reason)) {
      fail("INVALID_CLOSE_REASON", "direct-control close reason is invalid");
    }
    const nowMs = this.#readNow();
    this.#pruneExpired(nowMs);
    const entry = this.#entries.get(devicePath);
    if (entry === undefined) {
      fail(
        "DIRECT_CONTROL_CONTEXT_NOT_READY",
        "no direct-control session is bound to this device"
      );
    }
    if (
      entry.directControlState === GATT_DIRECT_CONTROL_STATES.CLOSING &&
      entry.serverClosePending &&
      entry.closingReason === reason
    ) {
      return;
    }
    if (
      entry.directControlState !== GATT_DIRECT_CONTROL_STATES.ACTIVE ||
      entry.directControlContext === null
    ) {
      fail(
        "DIRECT_CONTROL_NOT_ACTIVE",
        "server close requires an active direct-control session"
      );
    }
    this.#beginServerClose(devicePath, entry, reason);
  }

  requestSingleActiveClose(
    reason: DirectControlCloseReasonV1 =
      DIRECT_CONTROL_V1_CLOSE_REASONS.NORMAL
  ): void {
    this.#assertDirectControlEnabled();
    if (!(Object.values(DIRECT_CONTROL_V1_CLOSE_REASONS) as number[]).includes(reason)) {
      fail("INVALID_CLOSE_REASON", "direct-control close reason is invalid");
    }
    const nowMs = this.#readNow();
    this.#pruneExpired(nowMs);
    const active = [...this.#entries.entries()].filter(
      ([, entry]) =>
        entry.directControlState === GATT_DIRECT_CONTROL_STATES.ACTIVE &&
        entry.directControlContext !== null
    );
    if (active.length !== 1) {
      fail(
        "DIRECT_CONTROL_SINGLE_ACTIVE_REQUIRED",
        "server close requires exactly one active direct-control session"
      );
    }
    const [devicePath, entry] = active[0];
    this.#beginServerClose(devicePath, entry, reason);
  }

  #readNow(): number {
    const nowMs = safeClock(this.#clock);
    if (this.#lastClockMs !== null && nowMs < this.#lastClockMs) {
      this.#failuresTotal = increment(this.#failuresTotal);
      this.reset();
      fail("MONOTONIC_CLOCK_REGRESSION", "HELLO clock moved backwards");
    }
    this.#lastClockMs = nowMs;
    return nowMs;
  }

  #pruneExpired(nowMs: number): void {
    for (const [devicePath, entry] of this.#entries) {
      if (entry.expiresAtMs <= nowMs) {
        const hadControlKeys = entry.directControlContext !== null;
        this.#disposeEntry(entry);
        this.#entries.delete(devicePath);
        this.#expiredTotal = increment(this.#expiredTotal);
        if (hadControlKeys) {
          this.#forcedClosesTotal = increment(this.#forcedClosesTotal);
        }
      }
    }
  }

  #disposeEntry(entry: ExchangeEntry): void {
    this.#cancelHeartbeatTimer(entry);
    this.#cancelCloseTimer(entry);
    entry.response.fill(0);
    entry.clientSignature?.fill(0);
    entry.serverProof?.fill(0);
    entry.serverProofResponse?.fill(0);
    entry.clientSignature = null;
    entry.serverProof = null;
    entry.serverProofResponse = null;
    entry.peerTrustId = null;
    entry.keyShareResponse?.fill(0);
    entry.pendingPingWire?.fill(0);
    entry.keyShareResponse = null;
    entry.pendingPingWire = null;
    entry.directControlContext?.clear();
    entry.directControlContext = null;
    entry.pendingPingSequence = null;
    entry.lastAcceptedPongFingerprint = null;
    entry.closingSequence = null;
    entry.closingReason = null;
    entry.serverClosePending = false;
  }

  #cancelHeartbeatTimer(entry: ExchangeEntry): void {
    if (entry.heartbeatTimer === null) return;
    this.#scheduler.clear(entry.heartbeatTimer);
    entry.heartbeatTimer = null;
  }

  #cancelCloseTimer(entry: ExchangeEntry): void {
    if (entry.closeTimer === null) return;
    this.#scheduler.clear(entry.closeTimer);
    entry.closeTimer = null;
  }

  #recordFailure(): void {
    this.#failuresTotal = increment(this.#failuresTotal);
  }

  #assertEnabled(): Readonly<GattHelloServerIdentityV1> {
    if (!this.#enabled || this.#identity === null) {
      fail("FEATURE_DISABLED", "HELLO exchange is disabled");
    }
    return this.#identity;
  }

  #assertAuthEnabled(): MutualAuthHandshakeV1 {
    this.#assertEnabled();
    if (!this.#mutualAuthEnabled || this.#handshake === null) {
      fail("AUTH_FEATURE_DISABLED", "mutual authentication is disabled");
    }
    return this.#handshake;
  }

  #assertDirectControlEnabled(): DirectControlHandshakeV1 {
    this.#assertAuthEnabled();
    if (!this.#directControlEnabled || this.#directControlHandshake === null) {
      fail("DIRECT_CONTROL_FEATURE_DISABLED", "direct control is disabled");
    }
    return this.#directControlHandshake;
  }

  #failAuthEntry(
    entry: ExchangeEntry,
    code: string,
    message: string,
    cause?: unknown
  ): never {
    if (entry.session.state !== DIRECT_SESSION_STATES.FAILED) {
      entry.session.dispatch({
        type: DIRECT_SESSION_EVENTS.FAIL,
        code: code.replaceAll(/[^A-Z0-9_]/g, "_").slice(0, 64)
      });
    }
    entry.state = GATT_HELLO_EXCHANGE_STATES.FAILED;
    entry.authState = GATT_MUTUAL_AUTH_STATES.FAILED;
    entry.directControlState = GATT_DIRECT_CONTROL_STATES.FAILED;
    entry.clientSignature?.fill(0);
    entry.serverProof?.fill(0);
    entry.serverProofResponse?.fill(0);
    entry.clientSignature = null;
    entry.serverProof = null;
    entry.serverProofResponse = null;
    entry.peerTrustId = null;
    this.#cancelHeartbeatTimer(entry);
    this.#cancelCloseTimer(entry);
    entry.keyShareResponse?.fill(0);
    entry.pendingPingWire?.fill(0);
    entry.keyShareResponse = null;
    entry.pendingPingWire = null;
    entry.directControlContext?.clear();
    entry.directControlContext = null;
    entry.pendingPingSequence = null;
    entry.lastAcceptedPongFingerprint = null;
    entry.closingSequence = null;
    entry.closingReason = null;
    entry.serverClosePending = false;
    this.#authFailuresTotal = increment(this.#authFailuresTotal);
    this.#recordFailure();
    fail(code, message, cause);
  }

  #failDirectEntry(
    entry: ExchangeEntry,
    code: string,
    message: string,
    cause?: unknown
  ): never {
    if (
      entry.session.state !== DIRECT_SESSION_STATES.FAILED &&
      entry.session.state !== DIRECT_SESSION_STATES.CLOSED
    ) {
      entry.session.dispatch({
        type: DIRECT_SESSION_EVENTS.FAIL,
        code: code.replaceAll(/[^A-Z0-9_]/g, "_").slice(0, 64)
      });
    }
    entry.state = GATT_HELLO_EXCHANGE_STATES.FAILED;
    entry.authState = GATT_MUTUAL_AUTH_STATES.FAILED;
    entry.directControlState = GATT_DIRECT_CONTROL_STATES.FAILED;
    entry.clientSignature?.fill(0);
    entry.serverProof?.fill(0);
    entry.serverProofResponse?.fill(0);
    entry.clientSignature = null;
    entry.serverProof = null;
    entry.serverProofResponse = null;
    entry.peerTrustId = null;
    this.#cancelHeartbeatTimer(entry);
    this.#cancelCloseTimer(entry);
    entry.keyShareResponse?.fill(0);
    entry.pendingPingWire?.fill(0);
    entry.keyShareResponse = null;
    entry.pendingPingWire = null;
    entry.directControlContext?.clear();
    entry.directControlContext = null;
    entry.pendingPingSequence = null;
    entry.lastAcceptedPongFingerprint = null;
    entry.closingSequence = null;
    entry.closingReason = null;
    entry.serverClosePending = false;
    this.#directControlFailuresTotal = increment(
      this.#directControlFailuresTotal
    );
    this.#recordFailure();
    fail(code, message, cause);
  }

  #authBinding(
    entry: ExchangeEntry,
    certificateId: string
  ): MutualAuthBindingV1 {
    return {
      clientHello: entry.request,
      serverHello: entry.responseHello,
      deviceCertificateId: certificateId
    };
  }

  write(input: GattHelloExchangeInput): void {
    const identity = this.#assertEnabled();
    const devicePath = validateDevicePath(input.devicePath);
    const mtu = validateInteger(input.mtu, 23, 517, "mtu");
    if (!(input.value instanceof Uint8Array)) {
      this.#recordFailure();
      fail("INVALID_HELLO", "HELLO request must be a byte array");
    }
    if (mtu < HELLO_V1_MINIMUM_MTU) {
      this.#recordFailure();
      fail(
        "HELLO_MTU_TOO_SMALL",
        `HELLO requires an MTU of at least ${HELLO_V1_MINIMUM_MTU}`
      );
    }
    const nowMs = this.#readNow();
    this.#pruneExpired(nowMs);
    const fingerprint = requestFingerprint(input.value);
    const existing = this.#entries.get(devicePath);
    if (existing !== undefined) {
      if (
        existing.state !== GATT_HELLO_EXCHANGE_STATES.FAILED &&
        existing.requestFingerprint === fingerprint
      ) {
        this.#duplicateWritesTotal = increment(this.#duplicateWritesTotal);
        return;
      }
      existing.session.dispatch({
        type: DIRECT_SESSION_EVENTS.FAIL,
        code: "HELLO_BINDING_CONFLICT"
      });
      existing.state = GATT_HELLO_EXCHANGE_STATES.FAILED;
      existing.response.fill(0);
      this.#bindingConflictsTotal = increment(this.#bindingConflictsTotal);
      this.#recordFailure();
      fail(
        "HELLO_BINDING_CONFLICT",
        "device attempted to replace an active HELLO binding"
      );
    }
    if (this.#entries.size >= this.#maxActiveExchanges) {
      this.#capacityRejectedTotal = increment(this.#capacityRejectedTotal);
      this.#recordFailure();
      fail("HELLO_CAPACITY_REACHED", "HELLO exchange capacity is full");
    }

    let request: Readonly<HelloV1>;
    try {
      request = decodeHelloV1(input.value);
    } catch (error) {
      this.#recordFailure();
      if (error instanceof HelloV1Error) {
        fail(error.code, "HELLO request is invalid", error);
      }
      fail("INVALID_HELLO", "HELLO request is invalid", error);
    }
    if (
      (request.capabilities & CAPABILITY_BITS.GATT_CLIENT) === 0 ||
      request.nodeId === identity.nodeId
    ) {
      this.#recordFailure();
      fail(
        "INVALID_CLIENT_BINDING",
        "HELLO client role or identity binding is invalid"
      );
    }
    if (
      [...this.#entries.values()].some(
        (entry) =>
          entry.state !== GATT_HELLO_EXCHANGE_STATES.FAILED &&
          entry.sessionId === request.sessionId
      )
    ) {
      this.#bindingConflictsTotal = increment(this.#bindingConflictsTotal);
      this.#recordFailure();
      fail(
        "DUPLICATE_SESSION",
        "HELLO session identifier is already bound"
      );
    }

    const session = new DirectSessionV1({
      role: DIRECT_SESSION_ROLES.RASPBERRY_SERVER,
      clock: () => this.#readNow(),
      heartbeatMissesBeforeClose: this.#heartbeatMissesBeforeClose
    });
    let response: Buffer | null = null;
    try {
      session.dispatch({ type: DIRECT_SESSION_EVENTS.GATT_CONNECTED });
      session.dispatch({
        type: DIRECT_SESSION_EVENTS.MTU_NEGOTIATED,
        mtu
      });
      session.dispatch({
        type: DIRECT_SESSION_EVENTS.HELLO_ACCEPTED,
        protocolVersion: HELLO_V1_PROTOCOL_VERSION,
        sessionId: request.sessionId
      });
      if (session.state !== DIRECT_SESSION_STATES.HELLO_EXCHANGED) {
        fail("HELLO_STATE_INVALID", "server session did not accept HELLO");
      }
      const responseHello = Object.freeze({
        protocolVersion: HELLO_V1_PROTOCOL_VERSION,
        sessionId: request.sessionId,
        nodeId: identity.nodeId,
        bootId: identity.bootId,
        capabilities: identity.capabilities,
        nonce: generateHelloNonceV1(this.#randomBytes)
      });
      response = encodeHelloV1(responseHello);
      this.#entries.set(devicePath, {
        requestFingerprint: fingerprint,
        request,
        responseHello,
        response,
        session,
        sessionId: request.sessionId,
        mtu,
        expiresAtMs: nowMs + this.#exchangeTtlMs,
        state: GATT_HELLO_EXCHANGE_STATES.RESPONSE_READY,
        authState: GATT_MUTUAL_AUTH_STATES.HELLO_ONLY,
        authRequestFingerprint: null,
        finishFingerprint: null,
        certificateId: null,
        peerTrustId: null,
        clientSignature: null,
        serverProof: null,
        serverProofResponse: null,
        directControlState: this.#directControlEnabled
          ? GATT_DIRECT_CONTROL_STATES.AWAITING_CLIENT_SHARE
          : GATT_DIRECT_CONTROL_STATES.DISABLED,
        directControlContext: null,
        keyShareFingerprint: null,
        keyShareResponse: null,
        keyConfirmFingerprint: null,
        pendingPingSequence: null,
        pendingPingWire: null,
        lastAcceptedPongFingerprint: null,
        nextPingSequence: 0,
        heartbeatMisses: 0,
        heartbeatTimer: null,
        closingSequence: null,
        closingReason: null,
        serverClosePending: false,
        closeTimer: null
      });
      response = null;
      this.#writesAcceptedTotal = increment(this.#writesAcceptedTotal);
      this.#helloExchangedTotal = increment(this.#helloExchangedTotal);
    } catch (error) {
      response?.fill(0);
      this.#recordFailure();
      if (error instanceof GattHelloExchangeError) {
        throw error;
      }
      fail("HELLO_STATE_INVALID", "server HELLO state failed", error);
    }
  }

  read(input: GattHelloReadInput): Buffer {
    this.#assertEnabled();
    const devicePath = validateDevicePath(input.devicePath);
    if (input.offset !== 0) {
      this.#recordFailure();
      fail("INVALID_OFFSET", "B5.5 HELLO supports offset zero only");
    }
    const nowMs = this.#readNow();
    this.#pruneExpired(nowMs);
    const entry = this.#entries.get(devicePath);
    if (
      entry === undefined ||
      entry.state === GATT_HELLO_EXCHANGE_STATES.FAILED
    ) {
      this.#recordFailure();
      fail(
        "HELLO_RESPONSE_NOT_READY",
        "HELLO response is not ready for this connection"
      );
    }
    if (entry.state === GATT_HELLO_EXCHANGE_STATES.RESPONSE_DELIVERED) {
      this.#duplicateReadsTotal = increment(this.#duplicateReadsTotal);
    } else {
      entry.state = GATT_HELLO_EXCHANGE_STATES.RESPONSE_DELIVERED;
      this.#readsDeliveredTotal = increment(this.#readsDeliveredTotal);
    }
    return Buffer.from(entry.response);
  }

  async writeControl(input: GattAuthWriteInput): Promise<Buffer | null> {
    const handshake = this.#assertAuthEnabled();
    const devicePath = validateDevicePath(input.devicePath);
    if (!(input.value instanceof Uint8Array) || input.value.byteLength < 2) {
      this.#recordFailure();
      fail("INVALID_AUTH_WIRE", "auth request must be a byte array");
    }
    const nowMs = this.#readNow();
    this.#pruneExpired(nowMs);
    const entry = this.#entries.get(devicePath);
    if (
      entry === undefined ||
      entry.state !== GATT_HELLO_EXCHANGE_STATES.RESPONSE_DELIVERED
    ) {
      this.#recordFailure();
      fail(
        "AUTH_CONTEXT_NOT_READY",
        "auth requires a delivered HELLO response on this connection"
      );
    }
    if (entry.mtu < MUTUAL_AUTH_V1_MINIMUM_MTU) {
      this.#failAuthEntry(
        entry,
        "AUTH_MTU_TOO_SMALL",
        `mutual auth requires an MTU of at least ${MUTUAL_AUTH_V1_MINIMUM_MTU}`
      );
    }

    const type = input.value[1];
    if (type === MUTUAL_AUTH_V1_MESSAGE_TYPES.CLIENT_PROOF) {
      const response = await this.#writeClientProof(
        devicePath,
        entry,
        input.value,
        handshake
      );
      entry.expiresAtMs = this.#readNow() + this.#exchangeTtlMs;
      return response;
    }
    if (type === MUTUAL_AUTH_V1_MESSAGE_TYPES.FINISH) {
      await this.#writeFinish(devicePath, entry, input.value, handshake);
      entry.expiresAtMs = this.#readNow() + this.#exchangeTtlMs;
      return null;
    }
    if (!this.#directControlEnabled) {
      this.#failAuthEntry(
        entry,
        "INVALID_AUTH_MESSAGE_TYPE",
        "client wrote an unsupported auth message"
      );
    }
    const directHandshake = this.#assertDirectControlEnabled();
    if (entry.mtu < DIRECT_CONTROL_V1_MINIMUM_MTU) {
      this.#failDirectEntry(
        entry,
        "DIRECT_CONTROL_MTU_TOO_SMALL",
        `direct control requires an MTU of at least ${DIRECT_CONTROL_V1_MINIMUM_MTU}`
      );
    }
    if (type === DIRECT_CONTROL_V1_MESSAGE_TYPES.CLIENT_KEY_SHARE) {
      const response = await this.#writeClientKeyShare(
        devicePath,
        entry,
        input.value,
        directHandshake
      );
      entry.expiresAtMs = this.#readNow() + this.#exchangeTtlMs;
      return response;
    }
    if (type === DIRECT_CONTROL_V1_MESSAGE_TYPES.CLIENT_KEY_CONFIRM) {
      const response = this.#writeClientKeyConfirm(
        devicePath,
        entry,
        input.value,
        directHandshake
      );
      entry.expiresAtMs = this.#readNow() + this.#activeSessionIdleTtlMs;
      return response;
    }
    if (type === DIRECT_CONTROL_V1_MESSAGE_TYPES.PONG) {
      this.#writePong(devicePath, entry, input.value);
      return null;
    }
    if (type === DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE) {
      return this.#writeClientClose(devicePath, entry, input.value);
    }
    if (type === DIRECT_CONTROL_V1_MESSAGE_TYPES.CLOSE_ACK) {
      this.#writeServerCloseAck(devicePath, entry, input.value);
      return null;
    }
    this.#failDirectEntry(
      entry,
      "INVALID_CONTROL_MESSAGE_TYPE",
      "client wrote an unsupported direct-control message"
    );
  }

  async writeAuth(input: GattAuthWriteInput): Promise<Buffer | null> {
    return this.writeControl(input);
  }

  async #writeClientKeyShare(
    devicePath: string,
    entry: ExchangeEntry,
    value: Uint8Array,
    handshake: DirectControlHandshakeV1
  ): Promise<Buffer> {
    const fingerprint = requestFingerprint(value);
    if (
      entry.directControlState ===
        GATT_DIRECT_CONTROL_STATES.AWAITING_CLIENT_CONFIRMATION &&
      entry.keyShareFingerprint === fingerprint &&
      entry.keyShareResponse !== null
    ) {
      this.#directControlDuplicateWritesTotal = increment(
        this.#directControlDuplicateWritesTotal
      );
      return Buffer.from(entry.keyShareResponse);
    }
    if (
      entry.directControlState ===
      GATT_DIRECT_CONTROL_STATES.VERIFYING_CLIENT_SHARE
    ) {
      fail(
        "DIRECT_CONTROL_IN_PROGRESS",
        "direct-control key verification is already running"
      );
    }
    if (
      entry.authState !== GATT_MUTUAL_AUTH_STATES.AUTHENTICATED ||
      entry.certificateId === null ||
      entry.directControlState !==
        GATT_DIRECT_CONTROL_STATES.AWAITING_CLIENT_SHARE
    ) {
      this.#failDirectEntry(
        entry,
        "DIRECT_CONTROL_AUTH_REQUIRED",
        "key establishment requires the authenticated HELLO owner"
      );
    }

    entry.directControlState =
      GATT_DIRECT_CONTROL_STATES.VERIFYING_CLIENT_SHARE;
    try {
      const accepted = await handshake.acceptClientShare({
        binding: this.#authBinding(entry, entry.certificateId),
        sessionId: entry.sessionId,
        wire: value
      });
      if (
        this.#entries.get(devicePath) !== entry ||
        entry.directControlState !==
          GATT_DIRECT_CONTROL_STATES.VERIFYING_CLIENT_SHARE
      ) {
        accepted.response.fill(0);
        accepted.context.clear();
        fail(
          "DIRECT_CONTROL_CONTEXT_LOST",
          "direct-control context changed during key verification"
        );
      }
      entry.directControlContext = accepted.context;
      entry.keyShareFingerprint = fingerprint;
      entry.keyShareResponse = Buffer.from(accepted.response);
      accepted.response.fill(0);
      entry.directControlState =
        GATT_DIRECT_CONTROL_STATES.AWAITING_CLIENT_CONFIRMATION;
      this.#clientKeySharesAcceptedTotal = increment(
        this.#clientKeySharesAcceptedTotal
      );
      this.#serverKeySharesIssuedTotal = increment(
        this.#serverKeySharesIssuedTotal
      );
      return Buffer.from(entry.keyShareResponse);
    } catch (error) {
      if (this.#entries.get(devicePath) === entry) {
        this.#failDirectEntry(
          entry,
          error instanceof DirectControlHandshakeError
            ? error.code
            : error instanceof GattHelloExchangeError
              ? error.code
              : "CLIENT_KEY_SHARE_REJECTED",
          "client key share was rejected",
          error
        );
      }
      fail(
        "DIRECT_CONTROL_CONTEXT_LOST",
        "direct-control context changed during key verification",
        error
      );
    }
  }

  #writeClientKeyConfirm(
    devicePath: string,
    entry: ExchangeEntry,
    value: Uint8Array,
    handshake: DirectControlHandshakeV1
  ): Buffer {
    const fingerprint = requestFingerprint(value);
    if (
      entry.directControlState === GATT_DIRECT_CONTROL_STATES.ACTIVATING &&
      entry.keyConfirmFingerprint === fingerprint &&
      entry.pendingPingSequence === 0 &&
      entry.pendingPingWire !== null
    ) {
      this.#directControlDuplicateWritesTotal = increment(
        this.#directControlDuplicateWritesTotal
      );
      return Buffer.from(entry.pendingPingWire);
    }
    if (
      entry.authState !== GATT_MUTUAL_AUTH_STATES.AUTHENTICATED ||
      entry.directControlState !==
        GATT_DIRECT_CONTROL_STATES.AWAITING_CLIENT_CONFIRMATION ||
      entry.directControlContext === null
    ) {
      this.#failDirectEntry(
        entry,
        "DIRECT_CONTROL_KEY_ORDER_INVALID",
        "client key confirmation arrived out of order"
      );
    }
    try {
      const keySnapshot = handshake.acceptClientConfirm(
        entry.directControlContext,
        value
      );
      if (!keySnapshot.keyEstablished || !keySnapshot.controlKeysReady) {
        this.#failDirectEntry(
          entry,
          "DIRECT_CONTROL_KEY_NOT_ESTABLISHED",
          "client key confirmation did not establish control keys"
        );
      }
      entry.session.dispatch({
        type: DIRECT_SESSION_EVENTS.SESSION_KEY_ESTABLISHED
      });
      if (entry.session.state !== DIRECT_SESSION_STATES.KEY_ESTABLISHED) {
        this.#failDirectEntry(
          entry,
          "DIRECT_CONTROL_STATE_INVALID",
          "session did not accept established control keys"
        );
      }
      entry.keyConfirmFingerprint = fingerprint;
      entry.keyShareResponse?.fill(0);
      entry.keyShareResponse = null;
      entry.directControlState = GATT_DIRECT_CONTROL_STATES.ACTIVATING;
      entry.pendingPingSequence = 0;
      entry.nextPingSequence = 1;
      entry.heartbeatMisses = 0;
      entry.pendingPingWire = entry.directControlContext.encodePing(0);
      this.#clientKeyConfirmationsVerifiedTotal = increment(
        this.#clientKeyConfirmationsVerifiedTotal
      );
      this.#keyEstablishedTotal = increment(this.#keyEstablishedTotal);
      this.#pingsSentTotal = increment(this.#pingsSentTotal);
      this.#scheduleHeartbeat(devicePath, entry);
      return Buffer.from(entry.pendingPingWire);
    } catch (error) {
      if (
        this.#entries.get(devicePath) === entry &&
        entry.state !== GATT_HELLO_EXCHANGE_STATES.FAILED
      ) {
        this.#failDirectEntry(
          entry,
          error instanceof DirectControlHandshakeError
            ? error.code
            : error instanceof GattHelloExchangeError
              ? error.code
              : "CLIENT_KEY_CONFIRMATION_REJECTED",
          "client key confirmation was rejected",
          error
        );
      }
      throw error;
    }
  }

  #writePong(
    devicePath: string,
    entry: ExchangeEntry,
    value: Uint8Array
  ): void {
    const fingerprint = requestFingerprint(value);
    if (
      (entry.directControlState === GATT_DIRECT_CONTROL_STATES.ACTIVE ||
        entry.directControlState === GATT_DIRECT_CONTROL_STATES.CLOSING) &&
      entry.lastAcceptedPongFingerprint === fingerprint
    ) {
      this.#directControlDuplicateWritesTotal = increment(
        this.#directControlDuplicateWritesTotal
      );
      return;
    }
    if (
      (entry.directControlState !== GATT_DIRECT_CONTROL_STATES.ACTIVATING &&
        entry.directControlState !== GATT_DIRECT_CONTROL_STATES.ACTIVE) ||
      entry.directControlContext === null ||
      entry.pendingPingSequence === null
    ) {
      this.#failDirectEntry(
        entry,
        "UNSOLICITED_CONTROL_PONG",
        "PONG does not match a pending Raspberry heartbeat"
      );
    }
    try {
      const sequence = entry.directControlContext.acceptPong(
        value,
        entry.pendingPingSequence
      );
      entry.lastAcceptedPongFingerprint = fingerprint;
      this.#cancelHeartbeatTimer(entry);
      entry.pendingPingWire?.fill(0);
      entry.pendingPingWire = null;
      entry.pendingPingSequence = null;
      entry.heartbeatMisses = 0;
      this.#pongsVerifiedTotal = increment(this.#pongsVerifiedTotal);
      if (
        entry.directControlState === GATT_DIRECT_CONTROL_STATES.ACTIVATING
      ) {
        entry.session.dispatch({ type: DIRECT_SESSION_EVENTS.HEARTBEAT_STARTED });
        if (entry.session.state !== DIRECT_SESSION_STATES.ACTIVE) {
          this.#failDirectEntry(
            entry,
            "DIRECT_CONTROL_ACTIVATION_FAILED",
            "PONG0 did not activate the direct session"
          );
        }
        entry.directControlState = GATT_DIRECT_CONTROL_STATES.ACTIVE;
        this.#heartbeatStartedTotal = increment(this.#heartbeatStartedTotal);
        this.#activeSessionsTotal = increment(this.#activeSessionsTotal);
      } else {
        entry.session.dispatch({
          type: DIRECT_SESSION_EVENTS.PONG_RECEIVED,
          sequence
        });
        if (entry.session.state !== DIRECT_SESSION_STATES.ACTIVE) {
          this.#failDirectEntry(
            entry,
            "DIRECT_CONTROL_HEARTBEAT_FAILED",
            "session rejected the verified PONG"
          );
        }
      }
      entry.expiresAtMs = this.#readNow() + this.#activeSessionIdleTtlMs;
      this.#scheduleHeartbeat(devicePath, entry);
    } catch (error) {
      if (
        this.#entries.get(devicePath) === entry &&
        entry.state !== GATT_HELLO_EXCHANGE_STATES.FAILED
      ) {
        this.#failDirectEntry(
          entry,
          error instanceof DirectControlHandshakeError
            ? error.code
            : error instanceof GattHelloExchangeError
              ? error.code
              : "PONG_VERIFICATION_FAILED",
          "authenticated PONG was rejected",
          error
        );
      }
      throw error;
    }
  }

  #writeClientClose(
    devicePath: string,
    entry: ExchangeEntry,
    value: Uint8Array
  ): Buffer {
    if (
      entry.directControlState !== GATT_DIRECT_CONTROL_STATES.ACTIVE ||
      entry.directControlContext === null
    ) {
      this.#failDirectEntry(
        entry,
        "DIRECT_CONTROL_CLOSE_ORDER_INVALID",
        "client CLOSE requires an active direct session"
      );
    }
    try {
      const close = entry.directControlContext.acceptClose(value);
      this.#cancelHeartbeatTimer(entry);
      entry.pendingPingWire?.fill(0);
      entry.pendingPingWire = null;
      entry.pendingPingSequence = null;
      entry.session.dispatch({
        type: DIRECT_SESSION_EVENTS.CLOSE_REQUESTED,
        reason: "REMOTE_CLOSE"
      });
      entry.directControlState = GATT_DIRECT_CONTROL_STATES.CLOSING;
      entry.closingSequence = close.sequence;
      entry.closingReason = close.reason;
      entry.serverClosePending = false;
      const response = entry.directControlContext.encodeCloseAck(
        close.sequence,
        close.reason
      );
      this.#scheduleClose(devicePath, entry, true);
      return response;
    } catch (error) {
      if (
        this.#entries.get(devicePath) === entry &&
        entry.state !== GATT_HELLO_EXCHANGE_STATES.FAILED
      ) {
        this.#failDirectEntry(
          entry,
          error instanceof DirectControlHandshakeError
            ? error.code
            : "CLIENT_CLOSE_REJECTED",
          "authenticated client CLOSE was rejected",
          error
        );
      }
      throw error;
    }
  }

  #writeServerCloseAck(
    devicePath: string,
    entry: ExchangeEntry,
    value: Uint8Array
  ): void {
    if (
      entry.directControlState !== GATT_DIRECT_CONTROL_STATES.CLOSING ||
      !entry.serverClosePending ||
      entry.directControlContext === null ||
      entry.closingSequence === null ||
      entry.closingReason === null
    ) {
      this.#failDirectEntry(
        entry,
        "DIRECT_CONTROL_CLOSE_ACK_ORDER_INVALID",
        "CLOSE_ACK does not match a Raspberry CLOSE"
      );
    }
    try {
      entry.directControlContext.acceptCloseAck(
        value,
        entry.closingSequence,
        entry.closingReason
      );
      this.#finalizeClose(devicePath, entry, true);
    } catch (error) {
      if (
        this.#entries.get(devicePath) === entry &&
        entry.state !== GATT_HELLO_EXCHANGE_STATES.FAILED
      ) {
        this.#failDirectEntry(
          entry,
          error instanceof DirectControlHandshakeError
            ? error.code
            : "CLOSE_ACK_REJECTED",
          "authenticated CLOSE_ACK was rejected",
          error
        );
      }
      throw error;
    }
  }

  #scheduleHeartbeat(devicePath: string, entry: ExchangeEntry): void {
    this.#cancelHeartbeatTimer(entry);
    entry.heartbeatTimer = this.#scheduler.set(() => {
      entry.heartbeatTimer = null;
      try {
        this.#heartbeatTick(devicePath, entry);
      } catch (error) {
        this.#handleScheduledFailure(devicePath, entry, error);
      }
    }, this.#heartbeatIntervalMs);
  }

  #heartbeatTick(devicePath: string, entry: ExchangeEntry): void {
    if (this.#entries.get(devicePath) !== entry) return;
    const nowMs = this.#readNow();
    if (
      entry.directControlState !== GATT_DIRECT_CONTROL_STATES.ACTIVATING &&
      entry.directControlState !== GATT_DIRECT_CONTROL_STATES.ACTIVE
    ) {
      return;
    }
    if (entry.expiresAtMs <= nowMs) {
      this.#beginServerClose(
        devicePath,
        entry,
        DIRECT_CONTROL_V1_CLOSE_REASONS.HEARTBEAT_TIMEOUT
      );
      return;
    }
    if (entry.pendingPingSequence !== null) {
      entry.heartbeatMisses += 1;
      this.#heartbeatMissesTotal = increment(this.#heartbeatMissesTotal);
      if (entry.directControlState === GATT_DIRECT_CONTROL_STATES.ACTIVE) {
        entry.session.dispatch({ type: DIRECT_SESSION_EVENTS.HEARTBEAT_MISSED });
      }
      if (entry.heartbeatMisses >= this.#heartbeatMissesBeforeClose) {
        this.#beginServerClose(
          devicePath,
          entry,
          DIRECT_CONTROL_V1_CLOSE_REASONS.HEARTBEAT_TIMEOUT
        );
        return;
      }
      if (entry.pendingPingWire === null) {
        this.#failDirectEntry(
          entry,
          "DIRECT_CONTROL_PING_CONTEXT_LOST",
          "pending heartbeat wire is unavailable"
        );
      }
      this.#pingsSentTotal = increment(this.#pingsSentTotal);
      this.#publishControl(devicePath, entry.pendingPingWire);
      this.#scheduleHeartbeat(devicePath, entry);
      return;
    }
    if (entry.directControlState !== GATT_DIRECT_CONTROL_STATES.ACTIVE) {
      this.#failDirectEntry(
        entry,
        "DIRECT_CONTROL_ACTIVATION_CONTEXT_LOST",
        "activation heartbeat is unavailable"
      );
    }
    if (entry.nextPingSequence >= DIRECT_CONTROL_V1_MAX_SEQUENCE) {
      this.#beginServerClose(
        devicePath,
        entry,
        DIRECT_CONTROL_V1_CLOSE_REASONS.NORMAL
      );
      return;
    }
    const sequence = entry.nextPingSequence;
    entry.nextPingSequence += 1;
    entry.session.dispatch({
      type: DIRECT_SESSION_EVENTS.PING_SENT,
      sequence
    });
    if (entry.directControlContext === null) {
      this.#failDirectEntry(
        entry,
        "DIRECT_CONTROL_KEY_CONTEXT_LOST",
        "heartbeat keys are unavailable"
      );
    }
    entry.pendingPingSequence = sequence;
    entry.pendingPingWire = entry.directControlContext.encodePing(sequence);
    entry.heartbeatMisses = 0;
    this.#pingsSentTotal = increment(this.#pingsSentTotal);
    this.#publishControl(devicePath, entry.pendingPingWire);
    this.#scheduleHeartbeat(devicePath, entry);
  }

  #beginServerClose(
    devicePath: string,
    entry: ExchangeEntry,
    reason: DirectControlCloseReasonV1
  ): void {
    if (this.#entries.get(devicePath) !== entry) return;
    if (entry.directControlContext === null) {
      this.#finalizeClose(devicePath, entry, false);
      return;
    }
    this.#cancelHeartbeatTimer(entry);
    entry.pendingPingWire?.fill(0);
    entry.pendingPingWire = null;
    entry.pendingPingSequence = null;
    if (entry.session.state !== DIRECT_SESSION_STATES.CLOSING) {
      entry.session.dispatch({
        type: DIRECT_SESSION_EVENTS.CLOSE_REQUESTED,
        reason:
          reason === DIRECT_CONTROL_V1_CLOSE_REASONS.HEARTBEAT_TIMEOUT
            ? "HEARTBEAT_TIMEOUT"
            : reason === DIRECT_CONTROL_V1_CLOSE_REASONS.SERVICE_STOP
              ? "SERVICE_STOP"
              : reason === DIRECT_CONTROL_V1_CLOSE_REASONS.PROTOCOL_ERROR
                ? "PROTOCOL_ERROR"
                : "LOCAL_CLOSE"
      });
    }
    const sequence = Math.min(
      entry.nextPingSequence,
      DIRECT_CONTROL_V1_MAX_SEQUENCE
    );
    const closeWire = entry.directControlContext.encodeClose(sequence, reason);
    entry.directControlState = GATT_DIRECT_CONTROL_STATES.CLOSING;
    entry.closingSequence = sequence;
    entry.closingReason = reason;
    entry.serverClosePending = true;
    if (reason === DIRECT_CONTROL_V1_CLOSE_REASONS.HEARTBEAT_TIMEOUT) {
      this.#heartbeatTimeoutClosesTotal = increment(
        this.#heartbeatTimeoutClosesTotal
      );
    }
    try {
      this.#publishControl(devicePath, closeWire);
      this.#scheduleClose(devicePath, entry, false);
    } catch (error) {
      this.#finalizeClose(devicePath, entry, false);
      throw error;
    } finally {
      closeWire.fill(0);
    }
  }

  #scheduleClose(
    devicePath: string,
    entry: ExchangeEntry,
    cleanOnTimeout: boolean
  ): void {
    this.#cancelCloseTimer(entry);
    entry.closeTimer = this.#scheduler.set(() => {
      entry.closeTimer = null;
      try {
        this.#finalizeClose(devicePath, entry, cleanOnTimeout);
      } catch (error) {
        this.#handleScheduledFailure(devicePath, entry, error);
      }
    }, this.#closeGraceMs);
  }

  #finalizeClose(
    devicePath: string,
    entry: ExchangeEntry,
    clean: boolean
  ): void {
    if (this.#entries.get(devicePath) !== entry) return;
    this.#cancelHeartbeatTimer(entry);
    this.#cancelCloseTimer(entry);
    if (
      entry.session.state !== DIRECT_SESSION_STATES.CLOSED &&
      entry.session.state !== DIRECT_SESSION_STATES.FAILED
    ) {
      entry.session.dispatch({
        type: DIRECT_SESSION_EVENTS.TRANSPORT_CLOSED,
        reason: clean ? "CLEAN_CLOSE" : "CLOSE_TIMEOUT"
      });
    }
    this.#disposeEntry(entry);
    this.#entries.delete(devicePath);
    if (clean) {
      this.#cleanClosesTotal = increment(this.#cleanClosesTotal);
    } else {
      this.#forcedClosesTotal = increment(this.#forcedClosesTotal);
    }
  }

  #publishControl(devicePath: string, value: Uint8Array): void {
    if (this.#controlPublisher === null) {
      fail(
        "CONTROL_NOTIFICATION_NOT_READY",
        "controlTx publisher is unavailable"
      );
    }
    const output = Buffer.from(value);
    try {
      this.#controlPublisher(
        Object.freeze({ devicePath, value: output })
      );
    } finally {
      output.fill(0);
    }
  }

  #handleScheduledFailure(
    devicePath: string,
    entry: ExchangeEntry,
    error: unknown
  ): void {
    if (
      this.#entries.get(devicePath) !== entry ||
      entry.directControlState === GATT_DIRECT_CONTROL_STATES.FAILED
    ) {
      return;
    }
    try {
      this.#failDirectEntry(
        entry,
        error instanceof GattHelloExchangeError
          ? error.code
          : error instanceof DirectControlHandshakeError
            ? error.code
            : "DIRECT_CONTROL_TIMER_FAILED",
        "scheduled direct-control operation failed",
        error
      );
    } catch {
      // Timer failures are represented by redacted counters and failed state.
    }
  }

  async #writeClientProof(
    devicePath: string,
    entry: ExchangeEntry,
    value: Uint8Array,
    handshake: MutualAuthHandshakeV1
  ): Promise<Buffer> {
    let request;
    try {
      request = decodeAuthClientProofV1(value);
    } catch (error) {
      this.#failAuthEntry(
        entry,
        error instanceof MutualAuthV1Error ? error.code : "INVALID_CLIENT_PROOF",
        "client auth proof is invalid",
        error
      );
    }
    const fingerprint = requestFingerprint(value);
    if (
      entry.authState === GATT_MUTUAL_AUTH_STATES.SERVER_PROOF_READY &&
      entry.authRequestFingerprint === fingerprint &&
      entry.serverProofResponse !== null
    ) {
      request.signature.fill(0);
      this.#authDuplicateWritesTotal = increment(
        this.#authDuplicateWritesTotal
      );
      return Buffer.from(entry.serverProofResponse);
    }
    if (
      entry.authState === GATT_MUTUAL_AUTH_STATES.VERIFYING_CLIENT ||
      entry.authState === GATT_MUTUAL_AUTH_STATES.VERIFYING_FINISH
    ) {
      request.signature.fill(0);
      fail("AUTH_IN_PROGRESS", "authentication operation is already running");
    }
    if (
      entry.authState !== GATT_MUTUAL_AUTH_STATES.HELLO_ONLY ||
      request.sessionId !== entry.sessionId
    ) {
      request.signature.fill(0);
      this.#authReplayRejectedTotal = increment(
        this.#authReplayRejectedTotal
      );
      this.#failAuthEntry(
        entry,
        "AUTH_BINDING_CONFLICT",
        "client auth proof does not match the active HELLO binding"
      );
    }

    entry.authState = GATT_MUTUAL_AUTH_STATES.VERIFYING_CLIENT;
    entry.session.dispatch({ type: DIRECT_SESSION_EVENTS.AUTH_STARTED });
    this.#authStartedTotal = increment(this.#authStartedTotal);
    const binding = this.#authBinding(entry, request.deviceCertificateId);
    let serverProof: Buffer | null = null;
    let serverResponse: Buffer | null = null;
    let peerTrustId: string | null = null;
    try {
      serverProof = await handshake.verifyClientAndCreateServerProof({
        binding,
        clientSignature: request.signature
      });
      peerTrustId = await handshake.resolveAuthorizedPeerTrustId(binding);
      if (
        this.#entries.get(devicePath) !== entry ||
        entry.authState !== GATT_MUTUAL_AUTH_STATES.VERIFYING_CLIENT
      ) {
        fail("AUTH_CONTEXT_LOST", "auth context changed during verification");
      }
      serverResponse = encodeAuthServerProofV1({
        sessionId: entry.sessionId,
        deviceCertificateId: request.deviceCertificateId,
        proof: serverProof
      });
      entry.authRequestFingerprint = fingerprint;
      entry.certificateId = request.deviceCertificateId;
      entry.peerTrustId = peerTrustId;
      entry.clientSignature = Buffer.from(request.signature);
      entry.serverProof = serverProof;
      serverProof = null;
      entry.serverProofResponse = serverResponse;
      serverResponse = null;
      entry.authState = GATT_MUTUAL_AUTH_STATES.SERVER_PROOF_READY;
      this.#clientProofsVerifiedTotal = increment(
        this.#clientProofsVerifiedTotal
      );
      this.#serverProofsIssuedTotal = increment(
        this.#serverProofsIssuedTotal
      );
      return Buffer.from(entry.serverProofResponse);
    } catch (error) {
      if (this.#entries.get(devicePath) === entry) {
        this.#failAuthEntry(
          entry,
          error instanceof MutualAuthHandshakeError
            ? error.code
            : error instanceof GattHelloExchangeError
              ? error.code
              : "AUTH_CLIENT_VERIFICATION_FAILED",
          "client authentication failed",
          error
        );
      }
      fail("AUTH_CONTEXT_LOST", "auth context changed during verification");
    } finally {
      request.signature.fill(0);
      serverProof?.fill(0);
      serverResponse?.fill(0);
    }
    fail("AUTH_UNREACHABLE", "client authentication did not produce a result");
  }

  async #writeFinish(
    devicePath: string,
    entry: ExchangeEntry,
    value: Uint8Array,
    handshake: MutualAuthHandshakeV1
  ): Promise<void> {
    let request;
    try {
      request = decodeAuthFinishV1(value);
    } catch (error) {
      this.#failAuthEntry(
        entry,
        error instanceof MutualAuthV1Error ? error.code : "INVALID_FINISH_PROOF",
        "client finish proof is invalid",
        error
      );
    }
    const fingerprint = requestFingerprint(value);
    if (
      entry.authState === GATT_MUTUAL_AUTH_STATES.AUTHENTICATED &&
      entry.finishFingerprint === fingerprint
    ) {
      request.proof.fill(0);
      this.#authDuplicateWritesTotal = increment(
        this.#authDuplicateWritesTotal
      );
      return;
    }
    if (
      entry.authState !== GATT_MUTUAL_AUTH_STATES.SERVER_PROOF_READY ||
      request.sessionId !== entry.sessionId ||
      entry.certificateId === null ||
      entry.clientSignature === null ||
      entry.serverProof === null
    ) {
      request.proof.fill(0);
      this.#authReplayRejectedTotal = increment(
        this.#authReplayRejectedTotal
      );
      this.#failAuthEntry(
        entry,
        "AUTH_FINISH_BINDING_CONFLICT",
        "finish proof does not match an issued server proof"
      );
    }

    entry.authState = GATT_MUTUAL_AUTH_STATES.VERIFYING_FINISH;
    const binding = this.#authBinding(entry, entry.certificateId);
    try {
      await handshake.verifyClientFinish({
        binding,
        clientSignature: entry.clientSignature,
        serverProof: entry.serverProof,
        finishProof: request.proof
      });
      if (
        this.#entries.get(devicePath) !== entry ||
        entry.authState !== GATT_MUTUAL_AUTH_STATES.VERIFYING_FINISH
      ) {
        fail("AUTH_CONTEXT_LOST", "auth context changed during finish");
      }
      entry.session.dispatch({ type: DIRECT_SESSION_EVENTS.AUTH_VERIFIED });
      if (entry.session.state !== DIRECT_SESSION_STATES.AUTHENTICATED) {
        fail("AUTH_STATE_INVALID", "session did not accept authentication");
      }
      entry.finishFingerprint = fingerprint;
      entry.authState = GATT_MUTUAL_AUTH_STATES.AUTHENTICATED;
      entry.clientSignature.fill(0);
      entry.serverProof.fill(0);
      entry.serverProofResponse?.fill(0);
      entry.clientSignature = null;
      entry.serverProof = null;
      entry.serverProofResponse = null;
      this.#finishProofsVerifiedTotal = increment(
        this.#finishProofsVerifiedTotal
      );
    } catch (error) {
      if (this.#entries.get(devicePath) === entry) {
        this.#failAuthEntry(
          entry,
          error instanceof MutualAuthHandshakeError
            ? error.code
            : error instanceof GattHelloExchangeError
              ? error.code
              : "AUTH_FINISH_VERIFICATION_FAILED",
          "mutual authentication finish failed",
          error
        );
      }
      fail("AUTH_CONTEXT_LOST", "auth context changed during finish");
    } finally {
      request.proof.fill(0);
    }
  }

  reset(): void {
    for (const entry of this.#entries.values()) {
      this.#disposeEntry(entry);
    }
    this.#entries.clear();
    this.#resetsTotal = increment(this.#resetsTotal);
  }

  snapshot(): Readonly<GattHelloExchangeSnapshotV1> {
    let responseReadyCount = 0;
    let responseDeliveredCount = 0;
    let failedExchangeCount = 0;
    let authenticatedSessionCount = 0;
    let keyEstablishedSessionCount = 0;
    let activeSessionCount = 0;
    let closingSessionCount = 0;
    let activeTimerCount = 0;
    let retainedSecretBufferCount = 0;
    for (const entry of this.#entries.values()) {
      if (entry.state === GATT_HELLO_EXCHANGE_STATES.RESPONSE_READY) {
        responseReadyCount += 1;
      } else if (
        entry.state === GATT_HELLO_EXCHANGE_STATES.RESPONSE_DELIVERED
      ) {
        responseDeliveredCount += 1;
      } else {
        failedExchangeCount += 1;
      }
      if (entry.authState === GATT_MUTUAL_AUTH_STATES.AUTHENTICATED) {
        authenticatedSessionCount += 1;
      }
      const controlSnapshot = entry.directControlContext?.snapshot();
      if (controlSnapshot?.keyEstablished === true) {
        keyEstablishedSessionCount += 1;
      }
      retainedSecretBufferCount +=
        controlSnapshot?.retainedSecretBufferCount ?? 0;
      if (entry.directControlState === GATT_DIRECT_CONTROL_STATES.ACTIVE) {
        activeSessionCount += 1;
      } else if (
        entry.directControlState === GATT_DIRECT_CONTROL_STATES.CLOSING
      ) {
        closingSessionCount += 1;
      }
      if (entry.heartbeatTimer !== null) activeTimerCount += 1;
      if (entry.closeTimer !== null) activeTimerCount += 1;
    }
    return Object.freeze({
      enabled: this.#enabled,
      activeExchangeCount: this.#entries.size,
      responseReadyCount,
      responseDeliveredCount,
      failedExchangeCount,
      writesAcceptedTotal: this.#writesAcceptedTotal,
      readsDeliveredTotal: this.#readsDeliveredTotal,
      helloExchangedTotal: this.#helloExchangedTotal,
      duplicateWritesTotal: this.#duplicateWritesTotal,
      duplicateReadsTotal: this.#duplicateReadsTotal,
      bindingConflictsTotal: this.#bindingConflictsTotal,
      capacityRejectedTotal: this.#capacityRejectedTotal,
      expiredTotal: this.#expiredTotal,
      failuresTotal: this.#failuresTotal,
      resetsTotal: this.#resetsTotal,
      mutualAuthEnabled: this.#mutualAuthEnabled,
      authStartedTotal: this.#authStartedTotal,
      clientProofsVerifiedTotal: this.#clientProofsVerifiedTotal,
      serverProofsIssuedTotal: this.#serverProofsIssuedTotal,
      finishProofsVerifiedTotal: this.#finishProofsVerifiedTotal,
      authDuplicateWritesTotal: this.#authDuplicateWritesTotal,
      authReplayRejectedTotal: this.#authReplayRejectedTotal,
      authFailuresTotal: this.#authFailuresTotal,
      authenticatedSessionCount,
      directControlEnabled: this.#directControlEnabled,
      clientKeySharesAcceptedTotal: this.#clientKeySharesAcceptedTotal,
      serverKeySharesIssuedTotal: this.#serverKeySharesIssuedTotal,
      clientKeyConfirmationsVerifiedTotal:
        this.#clientKeyConfirmationsVerifiedTotal,
      keyEstablishedTotal: this.#keyEstablishedTotal,
      heartbeatStartedTotal: this.#heartbeatStartedTotal,
      pingsSentTotal: this.#pingsSentTotal,
      pongsVerifiedTotal: this.#pongsVerifiedTotal,
      heartbeatMissesTotal: this.#heartbeatMissesTotal,
      activeSessionsTotal: this.#activeSessionsTotal,
      cleanClosesTotal: this.#cleanClosesTotal,
      heartbeatTimeoutClosesTotal: this.#heartbeatTimeoutClosesTotal,
      forcedClosesTotal: this.#forcedClosesTotal,
      directControlDuplicateWritesTotal:
        this.#directControlDuplicateWritesTotal,
      directControlFailuresTotal: this.#directControlFailuresTotal,
      keyEstablishedSessionCount,
      activeSessionCount,
      closingSessionCount,
      activeTimerCount,
      retainedSecretBufferCount
    });
  }
}
