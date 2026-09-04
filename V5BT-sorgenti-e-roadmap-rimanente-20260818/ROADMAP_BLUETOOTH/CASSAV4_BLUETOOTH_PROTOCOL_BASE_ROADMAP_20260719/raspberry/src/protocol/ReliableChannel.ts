import { randomBytes } from "node:crypto";

import {
  RELIABLE_FRAME_FLAGS,
  RELIABLE_FRAME_TYPES,
  ReliableFrameError,
  ReliableFrameReassemblerV1,
  decodeReliableMessageV1,
  encodeReliableMessageV1,
  type ReliableFrameType,
  type ReliableMessageV1
} from "./FrameCodec.js";
import { isPeerTrustIdV1 } from "../../../shared/provisioning/peer-trust-directory-v1.mjs";

export const RELIABLE_CHANNEL_DEFAULT_TTL_MS = 60_000;
export const RELIABLE_CHANNEL_MINIMUM_TTL_MS = 1_000;
export const RELIABLE_CHANNEL_MAXIMUM_TTL_MS = 24 * 60 * 60 * 1_000;
export const RELIABLE_CHANNEL_DEFAULT_MAX_ATTEMPTS = 5;
export const RELIABLE_CHANNEL_DEFAULT_BASE_RETRY_MS = 250;
export const RELIABLE_CHANNEL_DEFAULT_MAX_RETRY_MS = 8_000;

export interface ReliableOutboxRecordV1 {
  readonly peerTrustId: string;
  readonly messageId: string;
  readonly type: ReliableFrameType;
  readonly flags: number;
  readonly payload: Buffer;
  readonly createdAtEpochMs: number;
  readonly expiresAtEpochMs: number;
}

export interface ReliableChannelStoreV1 {
  reserveOutboundSequence(): number;
  enqueueOutbox(record: ReliableOutboxRecordV1): void;
  completeOutbox(peerTrustId: string, messageId: string): void;
  listOutbox(
    peerTrustId: string,
    nowEpochMs: number
  ): readonly ReliableOutboxRecordV1[];
  hasInbox(peerTrustId: string, messageId: string, nowEpochMs: number): boolean;
  rememberInbox(
    peerTrustId: string,
    messageId: string,
    expiresAtEpochMs: number
  ): void;
  forgetInbox(peerTrustId: string, messageId: string): void;
  prune(nowEpochMs: number): Readonly<{
    expiredOutbox: number;
    expiredInbox: number;
  }>;
  snapshot(): Readonly<{ outboxDepth: number; inboxDedupDepth: number }>;
}

export interface ReliableChannelTransportV1 {
  send(frame: Uint8Array): Promise<void>;
}

export interface ReliableChannelMetricsV1 {
  readonly framesTx: number;
  readonly framesRx: number;
  readonly messagesTx: number;
  readonly messagesRx: number;
  readonly acknowledgementsTx: number;
  readonly acknowledgementsRx: number;
  readonly retries: number;
  readonly duplicates: number;
  readonly expired: number;
  readonly deliveryFailures: number;
  readonly pendingMessages: number;
  readonly suspendedMessages: number;
  readonly outboxDepth: number;
  readonly inboxDedupDepth: number;
  readonly reassemblyOpenMessages: number;
  readonly reassemblyBufferedBytes: number;
}

export class ReliableChannelError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReliableChannelError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ReliableChannelError(
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
    fail("INVALID_CHANNEL_CONFIG", `${field} is outside its canonical range`);
  }
}

function validateMessageId(value: string): string {
  if (!/^[0-9a-f]{32}$/.test(value)) {
    fail("INVALID_MESSAGE_ID", "messageId must be canonical lowercase hex");
  }
  return value;
}

function validatePeerTrustId(value: string): string {
  if (!isPeerTrustIdV1(value)) {
    fail(
      "INVALID_PEER_TRUST_ID",
      "peerTrustId must be a canonical V1 trust commitment"
    );
  }
  return value;
}

function recordKey(peerTrustId: string, messageId: string): string {
  return `${validatePeerTrustId(peerTrustId)}:${validateMessageId(messageId)}`;
}

function cloneRecord(record: ReliableOutboxRecordV1): ReliableOutboxRecordV1 {
  return Object.freeze({ ...record, payload: Buffer.from(record.payload) });
}

export class InMemoryReliableChannelStoreV1 implements ReliableChannelStoreV1 {
  #sequence = 0;
  readonly #outbox = new Map<string, ReliableOutboxRecordV1>();
  readonly #inbox = new Map<string, number>();

  reserveOutboundSequence(): number {
    if (this.#sequence >= 0xffff_ffff) {
      fail("SEQUENCE_EXHAUSTED", "outbound sequence space is exhausted");
    }
    this.#sequence += 1;
    return this.#sequence;
  }

  enqueueOutbox(record: ReliableOutboxRecordV1): void {
    const key = recordKey(record.peerTrustId, record.messageId);
    if (this.#outbox.has(key)) {
      fail("OUTBOX_CONFLICT", "messageId already exists in the outbox");
    }
    this.#outbox.set(key, cloneRecord(record));
  }

  completeOutbox(peerTrustId: string, messageId: string): void {
    const key = recordKey(peerTrustId, messageId);
    const record = this.#outbox.get(key);
    record?.payload.fill(0);
    this.#outbox.delete(key);
  }

  listOutbox(
    peerTrustId: string,
    nowEpochMs: number
  ): readonly ReliableOutboxRecordV1[] {
    const normalizedPeerTrustId = validatePeerTrustId(peerTrustId);
    return Object.freeze(
      [...this.#outbox.values()]
        .filter(
          (record) =>
            record.peerTrustId === normalizedPeerTrustId &&
            record.expiresAtEpochMs > nowEpochMs
        )
        .sort((left, right) =>
          left.createdAtEpochMs - right.createdAtEpochMs ||
          left.messageId.localeCompare(right.messageId)
        )
        .map(cloneRecord)
    );
  }

  hasInbox(
    peerTrustId: string,
    messageId: string,
    nowEpochMs: number
  ): boolean {
    const expiresAt = this.#inbox.get(recordKey(peerTrustId, messageId));
    return expiresAt !== undefined && expiresAt > nowEpochMs;
  }

  rememberInbox(
    peerTrustId: string,
    messageId: string,
    expiresAtEpochMs: number
  ): void {
    this.#inbox.set(recordKey(peerTrustId, messageId), expiresAtEpochMs);
  }

  forgetInbox(peerTrustId: string, messageId: string): void {
    this.#inbox.delete(recordKey(peerTrustId, messageId));
  }

  prune(nowEpochMs: number): Readonly<{
    expiredOutbox: number;
    expiredInbox: number;
  }> {
    let expiredOutbox = 0;
    let expiredInbox = 0;
    for (const [messageId, record] of this.#outbox) {
      if (record.expiresAtEpochMs <= nowEpochMs) {
        record.payload.fill(0);
        this.#outbox.delete(messageId);
        expiredOutbox += 1;
      }
    }
    for (const [messageId, expiresAt] of this.#inbox) {
      if (expiresAt <= nowEpochMs) {
        this.#inbox.delete(messageId);
        expiredInbox += 1;
      }
    }
    return Object.freeze({ expiredOutbox, expiredInbox });
  }

  snapshot(): Readonly<{ outboxDepth: number; inboxDedupDepth: number }> {
    return Object.freeze({
      outboxDepth: this.#outbox.size,
      inboxDedupDepth: this.#inbox.size
    });
  }

  close(): void {
    for (const record of this.#outbox.values()) record.payload.fill(0);
    this.#outbox.clear();
    this.#inbox.clear();
  }
}

interface PendingMessageV1 {
  readonly record: ReliableOutboxRecordV1;
  sequence: number;
  frames: readonly Buffer[];
  attempts: number;
  nextAttemptAtEpochMs: number | null;
  suspended: boolean;
}

export class ReliableChannelV1 {
  readonly #transport: ReliableChannelTransportV1;
  readonly #store: ReliableChannelStoreV1;
  readonly #peerTrustId: string;
  readonly #mtu: number;
  readonly #txKey: Buffer;
  readonly #rxKey: Buffer;
  readonly #txNoncePrefix: Buffer;
  readonly #rxNoncePrefix: Buffer;
  readonly #maxAttempts: number;
  readonly #baseRetryMs: number;
  readonly #maxRetryMs: number;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #onMessage: (message: ReliableMessageV1) => void | Promise<void>;
  readonly #reassembler = new ReliableFrameReassemblerV1();
  readonly #pending = new Map<string, PendingMessageV1>();
  #operation: Promise<unknown> = Promise.resolve();
  #closePromise: Promise<void> | null = null;
  #closing = false;
  #closed = false;
  #lastNowEpochMs = 0;
  #framesTx = 0;
  #framesRx = 0;
  #messagesTx = 0;
  #messagesRx = 0;
  #acknowledgementsTx = 0;
  #acknowledgementsRx = 0;
  #retries = 0;
  #duplicates = 0;
  #expired = 0;
  #deliveryFailures = 0;

  constructor(input: {
    readonly transport: ReliableChannelTransportV1;
    readonly store?: ReliableChannelStoreV1;
    readonly peerTrustId: string;
    readonly mtu: number;
    readonly txKey: Uint8Array;
    readonly rxKey: Uint8Array;
    readonly txNoncePrefix: Uint8Array;
    readonly rxNoncePrefix: Uint8Array;
    readonly onMessage: (message: ReliableMessageV1) => void | Promise<void>;
    readonly maxAttempts?: number;
    readonly baseRetryMs?: number;
    readonly maxRetryMs?: number;
    readonly random?: () => number;
    readonly now?: () => number;
  }) {
    this.#transport = input.transport;
    this.#store = input.store ?? new InMemoryReliableChannelStoreV1();
    this.#peerTrustId = validatePeerTrustId(input.peerTrustId);
    this.#mtu = input.mtu;
    this.#txKey = Buffer.from(input.txKey);
    this.#rxKey = Buffer.from(input.rxKey);
    this.#txNoncePrefix = Buffer.from(input.txNoncePrefix);
    this.#rxNoncePrefix = Buffer.from(input.rxNoncePrefix);
    this.#onMessage = input.onMessage;
    this.#maxAttempts =
      input.maxAttempts ?? RELIABLE_CHANNEL_DEFAULT_MAX_ATTEMPTS;
    this.#baseRetryMs =
      input.baseRetryMs ?? RELIABLE_CHANNEL_DEFAULT_BASE_RETRY_MS;
    this.#maxRetryMs =
      input.maxRetryMs ?? RELIABLE_CHANNEL_DEFAULT_MAX_RETRY_MS;
    this.#random = input.random ?? Math.random;
    this.#now = input.now ?? Date.now;
    assertInteger(this.#mtu, 23, 517, "mtu");
    assertInteger(this.#maxAttempts, 1, 20, "maxAttempts");
    assertInteger(this.#baseRetryMs, 10, 60_000, "baseRetryMs");
    assertInteger(this.#maxRetryMs, this.#baseRetryMs, 300_000, "maxRetryMs");
    if (
      this.#txKey.byteLength !== 32 ||
      this.#rxKey.byteLength !== 32 ||
      this.#txNoncePrefix.byteLength !== 8 ||
      this.#rxNoncePrefix.byteLength !== 8
    ) {
      this.#wipeKeys();
      fail("INVALID_KEY_MATERIAL", "channel keys or nonce prefixes are invalid");
    }
  }

  send(input: {
    readonly type: ReliableFrameType;
    readonly payload: Uint8Array;
    readonly durable?: boolean;
    readonly ttlMs?: number;
    readonly messageId?: string;
  }): Promise<Readonly<{ messageId: string; durableCommitted: boolean }>> {
    return this.#serialize(async () => {
      this.#assertOpen();
      if (input.type === RELIABLE_FRAME_TYPES.ACK) {
        fail("ACK_RESERVED", "ACK messages are created only by the channel");
      }
      const now = this.#checkedNow();
      const ttlMs = input.ttlMs ?? RELIABLE_CHANNEL_DEFAULT_TTL_MS;
      assertInteger(
        ttlMs,
        RELIABLE_CHANNEL_MINIMUM_TTL_MS,
        RELIABLE_CHANNEL_MAXIMUM_TTL_MS,
        "ttlMs"
      );
      const messageId = validateMessageId(
        input.messageId ?? randomBytes(16).toString("hex")
      );
      if (this.#pending.has(messageId)) {
        fail(
          "OUTBOX_CONFLICT",
          "messageId is already pending in this reliable channel"
        );
      }
      const durable = input.durable === true;
      const record = cloneRecord({
        peerTrustId: this.#peerTrustId,
        messageId,
        type: input.type,
        flags: durable ? RELIABLE_FRAME_FLAGS.DURABLE : 0,
        payload: Buffer.from(input.payload),
        createdAtEpochMs: now,
        expiresAtEpochMs: now + ttlMs
      });
      try {
        if (durable) this.#store.enqueueOutbox(record);
        const pending = this.#prepare(record);
        this.#pending.set(messageId, pending);
        try {
          await this.#transmit(pending, now, false);
        } catch (error) {
          if (!durable && pending.attempts >= this.#maxAttempts) {
            this.#discardPending(messageId);
          }
          throw error;
        }
        return Object.freeze({ messageId, durableCommitted: durable });
      } finally {
        record.payload.fill(0);
      }
    });
  }

  restoreDurableOutbox(): Promise<number> {
    return this.#serialize(async () => {
      this.#assertOpen();
      const now = this.#checkedNow();
      const records = this.#store.listOutbox(this.#peerTrustId, now);
      let restored = 0;
      for (const record of records) {
        try {
          if (record.peerTrustId !== this.#peerTrustId) {
            fail(
              "PEER_TRUST_MISMATCH",
              "durable record is bound to another peer trust context"
            );
          }
          if (this.#pending.has(record.messageId)) continue;
          const pending = this.#prepare(record);
          this.#pending.set(record.messageId, pending);
          await this.#transmit(pending, now, false);
          restored += 1;
        } finally {
          record.payload.fill(0);
        }
      }
      return restored;
    });
  }

  receiveFragment(frame: Uint8Array): Promise<Readonly<{
    complete: boolean;
    delivered: boolean;
    duplicate: boolean;
  }>> {
    return this.#serialize(async () => {
      this.#assertOpen();
      const now = this.#checkedNow();
      this.#framesRx += 1;
      const fragments = this.#reassembler.accept(frame, now);
      if (fragments === null) {
        return Object.freeze({ complete: false, delivered: false, duplicate: false });
      }
      let message: Readonly<ReliableMessageV1>;
      try {
        message = decodeReliableMessageV1({
          fragments,
          key: this.#rxKey,
          noncePrefix: this.#rxNoncePrefix,
          nowEpochMs: now
        });
      } catch (error) {
        if (
          error instanceof ReliableFrameError &&
          error.code === "MESSAGE_EXPIRED"
        ) {
          this.#expired += 1;
        }
        throw error;
      } finally {
        for (const value of fragments) value.fill(0);
      }
      try {
        if (message.type === RELIABLE_FRAME_TYPES.ACK) {
          this.#acceptAcknowledgement(message);
          return Object.freeze({ complete: true, delivered: false, duplicate: false });
        }
        if (this.#store.hasInbox(this.#peerTrustId, message.messageId, now)) {
          this.#duplicates += 1;
          await this.#sendAcknowledgement(
            message.messageId,
            message.expiresAtEpochMs
          );
          return Object.freeze({ complete: true, delivered: false, duplicate: true });
        }
        this.#store.rememberInbox(
          this.#peerTrustId,
          message.messageId,
          message.expiresAtEpochMs
        );
        try {
          await this.#onMessage(message);
        } catch (error) {
          this.#store.forgetInbox(this.#peerTrustId, message.messageId);
          this.#deliveryFailures += 1;
          fail(
            "DELIVERY_FAILED",
            "upper-layer delivery rejected the message",
            error
          );
        }
        this.#messagesRx += 1;
        await this.#sendAcknowledgement(
          message.messageId,
          message.expiresAtEpochMs
        );
        return Object.freeze({ complete: true, delivered: true, duplicate: false });
      } finally {
        message.payload.fill(0);
      }
    });
  }

  tick(): Promise<Readonly<{
    retried: number;
    suspended: number;
    expired: number;
  }>> {
    return this.#serialize(async () => {
      this.#assertOpen();
      const now = this.#checkedNow();
      const pruned = this.#store.prune(now);
      this.#expired += pruned.expiredOutbox + pruned.expiredInbox;
      this.#reassembler.prune(now);
      let retried = 0;
      let suspended = 0;
      let expired = 0;
      for (const [messageId, pending] of [...this.#pending]) {
        if (pending.record.expiresAtEpochMs <= now) {
          if ((pending.record.flags & RELIABLE_FRAME_FLAGS.DURABLE) !== 0) {
            this.#store.completeOutbox(this.#peerTrustId, messageId);
          }
          this.#discardPending(messageId);
          this.#expired += 1;
          expired += 1;
          continue;
        }
        if (pending.suspended || pending.nextAttemptAtEpochMs === null) continue;
        if (pending.nextAttemptAtEpochMs > now) continue;
        if (pending.attempts >= this.#maxAttempts) {
          pending.suspended = true;
          pending.nextAttemptAtEpochMs = null;
          this.#deliveryFailures += 1;
          suspended += 1;
          if ((pending.record.flags & RELIABLE_FRAME_FLAGS.DURABLE) === 0) {
            this.#discardPending(messageId);
          }
          continue;
        }
        await this.#transmit(pending, now, true);
        retried += 1;
      }
      return Object.freeze({ retried, suspended, expired });
    });
  }

  resumeSuspended(): Promise<number> {
    return this.#serialize(async () => {
      this.#assertOpen();
      const now = this.#checkedNow();
      let resumed = 0;
      for (const pending of this.#pending.values()) {
        if (!pending.suspended) continue;
        pending.suspended = false;
        pending.attempts = 0;
        pending.nextAttemptAtEpochMs = now;
        resumed += 1;
      }
      return resumed;
    });
  }

  snapshot(): Readonly<ReliableChannelMetricsV1> {
    const store = this.#store.snapshot();
    const reassembly = this.#reassembler.snapshot();
    return Object.freeze({
      framesTx: this.#framesTx,
      framesRx: this.#framesRx,
      messagesTx: this.#messagesTx,
      messagesRx: this.#messagesRx,
      acknowledgementsTx: this.#acknowledgementsTx,
      acknowledgementsRx: this.#acknowledgementsRx,
      retries: this.#retries,
      duplicates: this.#duplicates,
      expired: this.#expired,
      deliveryFailures: this.#deliveryFailures,
      pendingMessages: this.#pending.size,
      suspendedMessages: [...this.#pending.values()].filter(
        (pending) => pending.suspended
      ).length,
      outboxDepth: store.outboxDepth,
      inboxDedupDepth: store.inboxDedupDepth,
      reassemblyOpenMessages: reassembly.openMessages,
      reassemblyBufferedBytes: reassembly.bufferedBytes
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closing = true;
    const finish = (): void => {
      if (this.#closed) return;
      this.#closed = true;
      this.#reassembler.clear();
      for (const messageId of [...this.#pending.keys()]) {
        this.#discardPending(messageId);
      }
      this.#wipeKeys();
    };
    this.#closePromise = this.#operation.then(finish, finish);
    this.#operation = this.#closePromise.then(
      () => undefined,
      () => undefined
    );
    return this.#closePromise;
  }

  #prepare(record: ReliableOutboxRecordV1): PendingMessageV1 {
    const sequence = this.#store.reserveOutboundSequence();
    const frames = encodeReliableMessageV1({
      type: record.type,
      flags: record.flags,
      sequence,
      messageId: record.messageId,
      expiresAtEpochMs: record.expiresAtEpochMs,
      payload: record.payload,
      mtu: this.#mtu,
      key: this.#txKey,
      noncePrefix: this.#txNoncePrefix
    });
    return {
      record: cloneRecord(record),
      sequence,
      frames,
      attempts: 0,
      nextAttemptAtEpochMs: record.createdAtEpochMs,
      suspended: false
    };
  }

  async #transmit(
    pending: PendingMessageV1,
    now: number,
    retry: boolean
  ): Promise<void> {
    pending.attempts += 1;
    if (retry) this.#retries += 1;
    try {
      for (const frame of pending.frames) {
        await this.#transport.send(frame);
        this.#framesTx += 1;
      }
      if (!retry) this.#messagesTx += 1;
    } finally {
      pending.nextAttemptAtEpochMs = now + this.#retryDelay(pending.attempts);
    }
  }

  async #sendAcknowledgement(
    acknowledgedMessageId: string,
    remoteExpiry: number
  ): Promise<void> {
    const now = this.#checkedNow();
    const ttlExpiry = Math.max(now + 1_000, remoteExpiry);
    const ackId = randomBytes(16).toString("hex");
    const sequence = this.#store.reserveOutboundSequence();
    const ackPayload = Buffer.from(acknowledgedMessageId, "hex");
    let frames: readonly Buffer[] = [];
    try {
      frames = encodeReliableMessageV1({
        type: RELIABLE_FRAME_TYPES.ACK,
        sequence,
        messageId: ackId,
        expiresAtEpochMs: ttlExpiry,
        payload: ackPayload,
        mtu: this.#mtu,
        key: this.#txKey,
        noncePrefix: this.#txNoncePrefix
      });
      for (const frame of frames) {
        await this.#transport.send(frame);
        this.#framesTx += 1;
      }
      this.#acknowledgementsTx += 1;
    } finally {
      ackPayload.fill(0);
      for (const frame of frames) frame.fill(0);
    }
  }

  #acceptAcknowledgement(message: ReliableMessageV1): void {
    try {
      if (message.payload.byteLength !== 16) {
        fail("INVALID_ACK", "ACK payload must contain exactly one messageId");
      }
      const acknowledgedMessageId = message.payload.toString("hex");
      const pending = this.#pending.get(acknowledgedMessageId);
      if (pending === undefined) {
        this.#duplicates += 1;
        return;
      }
      if ((pending.record.flags & RELIABLE_FRAME_FLAGS.DURABLE) !== 0) {
        this.#store.completeOutbox(
          this.#peerTrustId,
          acknowledgedMessageId
        );
      }
      this.#discardPending(acknowledgedMessageId);
      this.#acknowledgementsRx += 1;
    } finally {
      message.payload.fill(0);
    }
  }

  #retryDelay(attempts: number): number {
    const exponential = Math.min(
      this.#maxRetryMs,
      this.#baseRetryMs * 2 ** Math.max(0, attempts - 1)
    );
    const random = this.#random();
    if (!Number.isFinite(random) || random < 0 || random >= 1) {
      fail("INVALID_RANDOM_SOURCE", "retry random source must return [0,1)");
    }
    return exponential + Math.floor(exponential * 0.25 * random);
  }

  #discardPending(messageId: string): void {
    const pending = this.#pending.get(messageId);
    if (pending === undefined) return;
    this.#pending.delete(messageId);
    pending.record.payload.fill(0);
    for (const frame of pending.frames) frame.fill(0);
  }

  #checkedNow(): number {
    const now = this.#now();
    assertInteger(now, 0, Number.MAX_SAFE_INTEGER, "clock");
    if (now < this.#lastNowEpochMs) {
      fail("CLOCK_REGRESSION", "channel clock moved backwards");
    }
    this.#lastNowEpochMs = now;
    return now;
  }

  #assertOpen(): void {
    if (this.#closing || this.#closed) {
      fail("CHANNEL_CLOSED", "reliable channel is closed");
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  #wipeKeys(): void {
    this.#txKey.fill(0);
    this.#rxKey.fill(0);
    this.#txNoncePrefix.fill(0);
    this.#rxNoncePrefix.fill(0);
  }
}
