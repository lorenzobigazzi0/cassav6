import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  timingSafeEqual
} from "node:crypto";

export const RELIABLE_FRAME_VERSION = 1;
export const RELIABLE_FRAME_HEADER_BYTES = 14;
export const RELIABLE_FRAME_AUTH_TAG_BYTES = 16;
export const RELIABLE_FRAME_MESSAGE_ID_BYTES = 16;
export const RELIABLE_FRAME_NONCE_PREFIX_BYTES = 8;
export const RELIABLE_FRAME_KEY_BYTES = 32;
export const RELIABLE_FRAME_MAX_FRAGMENTS = 4_096;
export const RELIABLE_FRAME_MAX_PAYLOAD_BYTES = 16_384;
export const RELIABLE_FRAME_MINIMUM_GATT_MTU = 23;
export const RELIABLE_FRAME_MAXIMUM_GATT_MTU = 517;

const ATT_HEADER_BYTES = 3;
const MAGIC_0 = 0xc5;
const MAGIC_1 = 0xb7;
const ENVELOPE_HEADER_BYTES = RELIABLE_FRAME_MESSAGE_ID_BYTES + 8 + 4;
const DATA_KEY_CONTEXT = Buffer.from(
  "CASSA_V6-BT-DATA-KEY-V1\0",
  "ascii"
);
const DATA_NONCE_CONTEXT = Buffer.from(
  "CASSA_V6-BT-DATA-NONCE-V1\0",
  "ascii"
);

export const RELIABLE_FRAME_TYPES = Object.freeze({
  DATA: 1,
  ACK: 2,
  CLOSE: 3,
  ERROR: 4,
  ROUTE_ADVERTISEMENT: 5,
  SHADOW_DIAGNOSTIC: 6
} as const);

export type ReliableFrameType =
  (typeof RELIABLE_FRAME_TYPES)[keyof typeof RELIABLE_FRAME_TYPES];

export const RELIABLE_FRAME_FLAGS = Object.freeze({
  DURABLE: 1 << 0
} as const);

export interface ReliableMessageV1 {
  readonly type: ReliableFrameType;
  readonly flags: number;
  readonly sequence: number;
  readonly messageId: string;
  readonly expiresAtEpochMs: number;
  readonly payload: Buffer;
}

export interface ReliableFragmentV1 {
  readonly type: ReliableFrameType;
  readonly flags: number;
  readonly sequence: number;
  readonly fragmentIndex: number;
  readonly fragmentCount: number;
  readonly payload: Buffer;
}

export class ReliableFrameError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReliableFrameError";
    this.code = code;
  }
}

export function deriveReliableChannelDirectionMaterialV1(
  directionControlKey: Uint8Array
): Readonly<{ key: Buffer; noncePrefix: Buffer }> {
  const controlKey = exactBytes(
    directionControlKey,
    RELIABLE_FRAME_KEY_BYTES,
    "directionControlKey"
  );
  let keyDigest: Buffer | null = null;
  let nonceDigest: Buffer | null = null;
  try {
    keyDigest = createHmac("sha256", controlKey)
      .update(DATA_KEY_CONTEXT)
      .digest();
    nonceDigest = createHmac("sha256", controlKey)
      .update(DATA_NONCE_CONTEXT)
      .digest();
    return Object.freeze({
      key: Buffer.from(keyDigest),
      noncePrefix: Buffer.from(
        nonceDigest.subarray(0, RELIABLE_FRAME_NONCE_PREFIX_BYTES)
      )
    });
  } finally {
    controlKey.fill(0);
    keyDigest?.fill(0);
    nonceDigest?.fill(0);
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ReliableFrameError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}

function exactBytes(value: Uint8Array, expected: number, field: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== expected) {
    fail("INVALID_KEY_MATERIAL", `${field} must be exactly ${expected} bytes`);
  }
  return Buffer.from(value);
}

function assertInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("INVALID_FRAME_FIELD", `${field} is outside its canonical range`);
  }
}

function assertType(value: number): asserts value is ReliableFrameType {
  if (!Object.values(RELIABLE_FRAME_TYPES).includes(value as ReliableFrameType)) {
    fail("INVALID_FRAME_TYPE", "frame type is not assigned in protocol v1");
  }
}

function assertFlags(value: number): void {
  assertInteger(value, 0, 0xff, "flags");
  if ((value & ~RELIABLE_FRAME_FLAGS.DURABLE) !== 0) {
    fail("INVALID_FRAME_FLAGS", "frame contains reserved flags");
  }
}

function messageIdBytes(value: string): Buffer {
  if (!/^[0-9a-f]{32}$/.test(value)) {
    fail(
      "INVALID_MESSAGE_ID",
      "messageId must be 128 bits encoded as lowercase hexadecimal"
    );
  }
  return Buffer.from(value, "hex");
}

function framePayloadBudget(mtu: number): number {
  assertInteger(
    mtu,
    RELIABLE_FRAME_MINIMUM_GATT_MTU,
    RELIABLE_FRAME_MAXIMUM_GATT_MTU,
    "mtu"
  );
  const budget = mtu - ATT_HEADER_BYTES - RELIABLE_FRAME_HEADER_BYTES;
  if (budget < 1) {
    fail("MTU_TOO_SMALL", "negotiated MTU cannot carry a protocol fragment");
  }
  return budget;
}

function buildHeader(input: {
  readonly type: ReliableFrameType;
  readonly flags: number;
  readonly sequence: number;
  readonly fragmentIndex: number;
  readonly fragmentCount: number;
}): Buffer {
  assertType(input.type);
  assertFlags(input.flags);
  assertInteger(input.sequence, 1, 0xffff_ffff, "sequence");
  assertInteger(
    input.fragmentCount,
    1,
    RELIABLE_FRAME_MAX_FRAGMENTS,
    "fragmentCount"
  );
  assertInteger(
    input.fragmentIndex,
    0,
    input.fragmentCount - 1,
    "fragmentIndex"
  );
  const header = Buffer.alloc(RELIABLE_FRAME_HEADER_BYTES);
  header[0] = MAGIC_0;
  header[1] = MAGIC_1;
  header[2] = RELIABLE_FRAME_VERSION;
  header[3] = input.type;
  header[4] = input.flags;
  header[5] = 0;
  header.writeUInt32BE(input.sequence, 6);
  header.writeUInt16BE(input.fragmentIndex, 10);
  header.writeUInt16BE(input.fragmentCount, 12);
  return header;
}

function buildAuthenticatedHeader(input: {
  readonly type: ReliableFrameType;
  readonly flags: number;
  readonly sequence: number;
  readonly fragmentCount: number;
}): Buffer {
  return buildHeader({ ...input, fragmentIndex: 0 });
}

function buildNonce(prefix: Uint8Array, sequence: number): Buffer {
  const noncePrefix = exactBytes(
    prefix,
    RELIABLE_FRAME_NONCE_PREFIX_BYTES,
    "noncePrefix"
  );
  const nonce = Buffer.alloc(12);
  noncePrefix.copy(nonce, 0);
  nonce.writeUInt32BE(sequence, 8);
  noncePrefix.fill(0);
  return nonce;
}

function encodeEnvelope(input: {
  readonly messageId: string;
  readonly expiresAtEpochMs: number;
  readonly payload: Uint8Array;
}): Buffer {
  const id = messageIdBytes(input.messageId);
  assertInteger(
    input.expiresAtEpochMs,
    1,
    Number.MAX_SAFE_INTEGER,
    "expiresAtEpochMs"
  );
  if (
    !(input.payload instanceof Uint8Array) ||
    input.payload.byteLength > RELIABLE_FRAME_MAX_PAYLOAD_BYTES
  ) {
    id.fill(0);
    fail("PAYLOAD_TOO_LARGE", "payload exceeds the protocol v1 limit");
  }
  const envelope = Buffer.alloc(ENVELOPE_HEADER_BYTES + input.payload.byteLength);
  id.copy(envelope, 0);
  envelope.writeBigUInt64BE(
    BigInt(input.expiresAtEpochMs),
    RELIABLE_FRAME_MESSAGE_ID_BYTES
  );
  envelope.writeUInt32BE(
    input.payload.byteLength,
    RELIABLE_FRAME_MESSAGE_ID_BYTES + 8
  );
  Buffer.from(input.payload).copy(envelope, ENVELOPE_HEADER_BYTES);
  id.fill(0);
  return envelope;
}

export function encodeReliableMessageV1(input: {
  readonly type: ReliableFrameType;
  readonly flags?: number;
  readonly sequence: number;
  readonly messageId: string;
  readonly expiresAtEpochMs: number;
  readonly payload: Uint8Array;
  readonly mtu: number;
  readonly key: Uint8Array;
  readonly noncePrefix: Uint8Array;
}): readonly Buffer[] {
  assertType(input.type);
  const flags = input.flags ?? 0;
  assertFlags(flags);
  assertInteger(input.sequence, 1, 0xffff_ffff, "sequence");
  const fragmentBudget = framePayloadBudget(input.mtu);
  const envelope = encodeEnvelope(input);
  const encryptedBytes = envelope.byteLength + RELIABLE_FRAME_AUTH_TAG_BYTES;
  const fragmentCount = Math.ceil(encryptedBytes / fragmentBudget);
  if (fragmentCount > RELIABLE_FRAME_MAX_FRAGMENTS) {
    envelope.fill(0);
    fail("TOO_MANY_FRAGMENTS", "message exceeds the fragment count limit");
  }
  const key = exactBytes(input.key, RELIABLE_FRAME_KEY_BYTES, "key");
  const nonce = buildNonce(input.noncePrefix, input.sequence);
  const aad = buildAuthenticatedHeader({
    type: input.type,
    flags,
    sequence: input.sequence,
    fragmentCount
  });
  let encrypted: Buffer;
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: RELIABLE_FRAME_AUTH_TAG_BYTES
    });
    cipher.setAAD(aad, { plaintextLength: envelope.byteLength });
    encrypted = Buffer.concat([
      cipher.update(envelope),
      cipher.final(),
      cipher.getAuthTag()
    ]);
  } catch (error) {
    fail("ENCRYPTION_FAILED", "reliable frame encryption failed", error);
  } finally {
    envelope.fill(0);
    key.fill(0);
    nonce.fill(0);
    aad.fill(0);
  }
  const fragments: Buffer[] = [];
  try {
    for (let index = 0; index < fragmentCount; index += 1) {
      const start = index * fragmentBudget;
      const end = Math.min(start + fragmentBudget, encrypted.byteLength);
      const header = buildHeader({
        type: input.type,
        flags,
        sequence: input.sequence,
        fragmentIndex: index,
        fragmentCount
      });
      fragments.push(Buffer.concat([header, encrypted.subarray(start, end)]));
    }
    return Object.freeze(fragments);
  } finally {
    encrypted.fill(0);
  }
}

export function decodeReliableFragmentV1(
  wire: Uint8Array
): Readonly<ReliableFragmentV1> {
  if (
    !(wire instanceof Uint8Array) ||
    wire.byteLength <= RELIABLE_FRAME_HEADER_BYTES
  ) {
    fail("INVALID_FRAME_LENGTH", "frame must contain a header and payload");
  }
  const value = Buffer.from(wire);
  if (value[0] !== MAGIC_0 || value[1] !== MAGIC_1) {
    fail("INVALID_FRAME_MAGIC", "frame magic does not match protocol v1");
  }
  if (value[2] !== RELIABLE_FRAME_VERSION) {
    fail("INVALID_FRAME_VERSION", "frame version is unsupported");
  }
  const type = value[3];
  assertType(type);
  const flags = value[4];
  assertFlags(flags);
  if (value[5] !== 0) {
    fail("INVALID_FRAME_RESERVED", "reserved frame header byte must be zero");
  }
  const sequence = value.readUInt32BE(6);
  const fragmentIndex = value.readUInt16BE(10);
  const fragmentCount = value.readUInt16BE(12);
  assertInteger(sequence, 1, 0xffff_ffff, "sequence");
  assertInteger(
    fragmentCount,
    1,
    RELIABLE_FRAME_MAX_FRAGMENTS,
    "fragmentCount"
  );
  assertInteger(fragmentIndex, 0, fragmentCount - 1, "fragmentIndex");
  return Object.freeze({
    type,
    flags,
    sequence,
    fragmentIndex,
    fragmentCount,
    payload: Buffer.from(value.subarray(RELIABLE_FRAME_HEADER_BYTES))
  });
}

export function decodeReliableMessageV1(input: {
  readonly fragments: readonly Uint8Array[];
  readonly key: Uint8Array;
  readonly noncePrefix: Uint8Array;
  readonly nowEpochMs: number;
}): Readonly<ReliableMessageV1> {
  if (!Array.isArray(input.fragments) || input.fragments.length < 1) {
    fail("MISSING_FRAGMENTS", "at least one fragment is required");
  }
  assertInteger(input.nowEpochMs, 0, Number.MAX_SAFE_INTEGER, "nowEpochMs");
  const decoded = input.fragments.map(decodeReliableFragmentV1);
  const first = decoded[0];
  if (
    decoded.length !== first.fragmentCount ||
    decoded.some(
      (fragment) =>
        fragment.type !== first.type ||
        fragment.flags !== first.flags ||
        fragment.sequence !== first.sequence ||
        fragment.fragmentCount !== first.fragmentCount
    )
  ) {
    fail("FRAGMENT_SET_MISMATCH", "fragment set is incomplete or inconsistent");
  }
  const ordered = [...decoded].sort(
    (left, right) => left.fragmentIndex - right.fragmentIndex
  );
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index].fragmentIndex !== index) {
      fail("FRAGMENT_SET_MISMATCH", "fragment index is missing or duplicated");
    }
  }
  const encrypted = Buffer.concat(ordered.map((fragment) => fragment.payload));
  if (encrypted.byteLength <= RELIABLE_FRAME_AUTH_TAG_BYTES) {
    encrypted.fill(0);
    fail("INVALID_CIPHERTEXT_LENGTH", "ciphertext is too short");
  }
  const ciphertext = encrypted.subarray(
    0,
    encrypted.byteLength - RELIABLE_FRAME_AUTH_TAG_BYTES
  );
  const authTag = encrypted.subarray(
    encrypted.byteLength - RELIABLE_FRAME_AUTH_TAG_BYTES
  );
  const key = exactBytes(input.key, RELIABLE_FRAME_KEY_BYTES, "key");
  const nonce = buildNonce(input.noncePrefix, first.sequence);
  const aad = buildAuthenticatedHeader({
    type: first.type,
    flags: first.flags,
    sequence: first.sequence,
    fragmentCount: first.fragmentCount
  });
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: RELIABLE_FRAME_AUTH_TAG_BYTES
    });
    decipher.setAAD(aad, { plaintextLength: ciphertext.byteLength });
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    fail("AUTHENTICATION_FAILED", "reliable frame authentication failed", error);
  } finally {
    encrypted.fill(0);
    key.fill(0);
    nonce.fill(0);
    aad.fill(0);
  }
  try {
    if (plaintext.byteLength < ENVELOPE_HEADER_BYTES) {
      fail("INVALID_ENVELOPE_LENGTH", "decrypted envelope is truncated");
    }
    const messageId = plaintext
      .subarray(0, RELIABLE_FRAME_MESSAGE_ID_BYTES)
      .toString("hex");
    const expiresBigInt = plaintext.readBigUInt64BE(
      RELIABLE_FRAME_MESSAGE_ID_BYTES
    );
    if (expiresBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail("INVALID_EXPIRY", "message expiry exceeds the safe clock range");
    }
    const expiresAtEpochMs = Number(expiresBigInt);
    const payloadLength = plaintext.readUInt32BE(
      RELIABLE_FRAME_MESSAGE_ID_BYTES + 8
    );
    if (
      payloadLength > RELIABLE_FRAME_MAX_PAYLOAD_BYTES ||
      plaintext.byteLength !== ENVELOPE_HEADER_BYTES + payloadLength
    ) {
      fail("INVALID_ENVELOPE_LENGTH", "payload length is not canonical");
    }
    if (expiresAtEpochMs <= input.nowEpochMs) {
      fail("MESSAGE_EXPIRED", "message TTL elapsed before delivery");
    }
    return Object.freeze({
      type: first.type,
      flags: first.flags,
      sequence: first.sequence,
      messageId,
      expiresAtEpochMs,
      payload: Buffer.from(plaintext.subarray(ENVELOPE_HEADER_BYTES))
    });
  } finally {
    plaintext.fill(0);
  }
}

export class ReliableFrameReassemblerV1 {
  readonly #maximumOpenMessages: number;
  readonly #maximumBufferedBytes: number;
  readonly #sets = new Map<
    string,
    {
      type: ReliableFrameType;
      flags: number;
      sequence: number;
      fragmentCount: number;
      createdAtEpochMs: number;
      totalBytes: number;
      fragments: Map<number, Buffer>;
    }
  >();
  #bufferedBytes = 0;

  constructor(input: {
    readonly maximumOpenMessages?: number;
    readonly maximumBufferedBytes?: number;
  } = {}) {
    this.#maximumOpenMessages = input.maximumOpenMessages ?? 32;
    this.#maximumBufferedBytes = input.maximumBufferedBytes ?? 256 * 1024;
    assertInteger(this.#maximumOpenMessages, 1, 256, "maximumOpenMessages");
    assertInteger(
      this.#maximumBufferedBytes,
      1_024,
      4 * 1024 * 1024,
      "maximumBufferedBytes"
    );
  }

  accept(wire: Uint8Array, nowEpochMs: number): readonly Buffer[] | null {
    assertInteger(nowEpochMs, 0, Number.MAX_SAFE_INTEGER, "nowEpochMs");
    const fragment = decodeReliableFragmentV1(wire);
    const key = `${fragment.type}:${fragment.sequence}`;
    let set = this.#sets.get(key);
    if (set === undefined) {
      if (this.#sets.size >= this.#maximumOpenMessages) {
        fail("REASSEMBLY_CAPACITY_REACHED", "too many incomplete messages");
      }
      set = {
        type: fragment.type,
        flags: fragment.flags,
        sequence: fragment.sequence,
        fragmentCount: fragment.fragmentCount,
        createdAtEpochMs: nowEpochMs,
        totalBytes: 0,
        fragments: new Map()
      };
      this.#sets.set(key, set);
    }
    if (
      set.flags !== fragment.flags ||
      set.fragmentCount !== fragment.fragmentCount
    ) {
      this.#drop(key, set);
      fail("FRAGMENT_SET_MISMATCH", "fragment conflicts with buffered metadata");
    }
    const existing = set.fragments.get(fragment.fragmentIndex);
    if (existing !== undefined) {
      if (
        existing.byteLength !== fragment.payload.byteLength ||
        !timingSafeEqual(existing, fragment.payload)
      ) {
        this.#drop(key, set);
        fail("FRAGMENT_CONFLICT", "duplicate fragment contains different bytes");
      }
      return null;
    }
    if (
      this.#bufferedBytes + fragment.payload.byteLength >
      this.#maximumBufferedBytes
    ) {
      this.#drop(key, set);
      fail("REASSEMBLY_BYTE_LIMIT", "incomplete messages exceed byte budget");
    }
    const copy = Buffer.from(fragment.payload);
    set.fragments.set(fragment.fragmentIndex, copy);
    set.totalBytes += copy.byteLength;
    this.#bufferedBytes += copy.byteLength;
    if (set.fragments.size !== set.fragmentCount) return null;
    const result: Buffer[] = [];
    for (let index = 0; index < set.fragmentCount; index += 1) {
      const payload = set.fragments.get(index);
      if (payload === undefined) {
        this.#drop(key, set);
        fail("FRAGMENT_SET_MISMATCH", "completed set has a missing fragment");
      }
      const header = buildHeader({
        type: set.type,
        flags: set.flags,
        sequence: set.sequence,
        fragmentIndex: index,
        fragmentCount: set.fragmentCount
      });
      result.push(Buffer.concat([header, payload]));
    }
    this.#drop(key, set, false);
    return Object.freeze(result);
  }

  prune(nowEpochMs: number, maximumAgeMs = 30_000): number {
    assertInteger(nowEpochMs, 0, Number.MAX_SAFE_INTEGER, "nowEpochMs");
    assertInteger(maximumAgeMs, 1, 300_000, "maximumAgeMs");
    let removed = 0;
    for (const [key, set] of this.#sets) {
      if (nowEpochMs - set.createdAtEpochMs >= maximumAgeMs) {
        this.#drop(key, set);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    for (const [key, set] of this.#sets) this.#drop(key, set);
  }

  snapshot(): Readonly<{ openMessages: number; bufferedBytes: number }> {
    return Object.freeze({
      openMessages: this.#sets.size,
      bufferedBytes: this.#bufferedBytes
    });
  }

  #drop(
    key: string,
    set: { totalBytes: number; fragments: Map<number, Buffer> },
    wipe = true
  ): void {
    this.#sets.delete(key);
    this.#bufferedBytes -= set.totalBytes;
    if (wipe) {
      for (const payload of set.fragments.values()) payload.fill(0);
    }
    set.fragments.clear();
  }
}
