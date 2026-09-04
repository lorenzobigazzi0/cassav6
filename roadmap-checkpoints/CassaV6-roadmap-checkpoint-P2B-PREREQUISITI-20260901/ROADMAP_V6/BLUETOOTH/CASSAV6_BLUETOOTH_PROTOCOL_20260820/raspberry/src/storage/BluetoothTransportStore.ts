import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ReliableChannelStoreV1,
  ReliableOutboxRecordV1
} from "../protocol/ReliableChannel.js";
import type { ReliableFrameType } from "../protocol/FrameCodec.js";

const STORE_SCHEMA_VERSION = 3;
const PEER_BOUND_STORE_SCHEMA_VERSION = 2;
const LEGACY_STORE_SCHEMA_VERSION = 1;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MESSAGE_ID_PATTERN = /^[0-9a-f]{32}$/;
const PEER_TRUST_ID_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export const ROUTE_KINDS_V1 = Object.freeze({
  WIFI: "WIFI",
  LAN: "LAN",
  BLE_DIRECT: "BLE_DIRECT",
  NONE: "NONE"
} as const);

export type RouteKindV1 =
  (typeof ROUTE_KINDS_V1)[keyof typeof ROUTE_KINDS_V1];

export interface StoredRouteAdvertisementV1 {
  readonly canReachServer: boolean;
  readonly routeKind: RouteKindV1;
  readonly serverRttBucket: number;
  readonly routeAgeSeconds: number;
  readonly queueDepthBucket: number;
  readonly batteryBucket: number;
  readonly sequence: number;
  readonly observedAtEpochMs: number;
}

export class BluetoothTransportStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BluetoothTransportStoreError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new BluetoothTransportStoreError(
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

function assertOwnedDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("UNSAFE_STORE_DIRECTORY", "store parent must be a real directory");
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    fail("UNSAFE_STORE_OWNER", "store parent must be owned by this process");
  }
  if (modeBits(stat.mode) !== DIRECTORY_MODE) {
    fail("UNSAFE_STORE_MODE", "store parent must have mode 0700");
  }
}

function prepareStoreFile(inputPath: string): string {
  if (inputPath.includes("\0")) {
    fail("INVALID_STORE_PATH", "store path contains a NUL byte");
  }
  const path = resolve(inputPath);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: DIRECTORY_MODE });
  assertOwnedDirectory(parent);

  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDWR |
        fsConstants.O_CREAT |
        (fsConstants.O_NOFOLLOW ?? 0),
      FILE_MODE
    );
  } catch (error) {
    fail("STORE_OPEN_FAILED", "cannot open Bluetooth transport store", error);
  }
  try {
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
      fail("UNSAFE_STORE_FILE", "store must be one regular unlinked file");
    }
    if (
      uid !== null &&
      (descriptorStat.uid !== uid || pathStat.uid !== uid)
    ) {
      fail("UNSAFE_STORE_OWNER", "store must be owned by this process");
    }
    fchmodSync(descriptor, FILE_MODE);
    if (modeBits(fstatSync(descriptor).mode) !== FILE_MODE) {
      fail("UNSAFE_STORE_MODE", "store file must have mode 0600");
    }
  } finally {
    closeSync(descriptor);
  }
  return path;
}

function assertSafeInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("INVALID_STORE_VALUE", `${field} is outside its canonical range`);
  }
}

function assertMessageId(value: string): string {
  if (!MESSAGE_ID_PATTERN.test(value)) {
    fail("INVALID_MESSAGE_ID", "messageId must be canonical lowercase hex");
  }
  return value;
}

function assertPeerTrustId(value: string): string {
  if (!PEER_TRUST_ID_PATTERN.test(value)) {
    fail(
      "INVALID_PEER_TRUST_ID",
      "peerTrustId must be a canonical V1 trust commitment"
    );
  }
  return value;
}

function assertIdentifier(value: string, field: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    fail("INVALID_IDENTIFIER", `${field} is not canonical`);
  }
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" && typeof value !== "bigint") {
    fail("CORRUPT_STORE", `${field} is not an integer`);
  }
  const number = Number(value);
  assertSafeInteger(number, 0, Number.MAX_SAFE_INTEGER, field);
  return number;
}

function withTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original failure. The store is closed by its owner.
    }
    throw error;
  }
}

export class BluetoothTransportStoreV1 implements ReliableChannelStoreV1 {
  readonly #path: string;
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    this.#path = prepareStoreFile(path);
    try {
      this.#database = new DatabaseSync(this.#path, {
        timeout: 5_000,
        readBigInts: true
      });
      this.#database.exec("PRAGMA foreign_keys=ON");
      this.#database.exec("PRAGMA journal_mode=DELETE");
      this.#database.exec("PRAGMA synchronous=FULL");
      this.#database.exec("PRAGMA secure_delete=ON");
      this.#database.exec("PRAGMA temp_store=MEMORY");
      this.#initialize();
    } catch (error) {
      fail("STORE_INITIALIZATION_FAILED", "transport store initialization failed", error);
    }
  }

  reserveOutboundSequence(): number {
    this.#assertOpen();
    return withTransaction(this.#database, () => {
      const row = this.#database
        .prepare("SELECT value FROM bluetooth_transport_meta WHERE key='outbound_sequence'")
        .get() as { value?: unknown } | undefined;
      const current = asNumber(row?.value ?? 0, "outbound_sequence");
      if (current >= 0xffff_ffff) {
        fail("SEQUENCE_EXHAUSTED", "outbound sequence space is exhausted");
      }
      const next = current + 1;
      this.#database
        .prepare("UPDATE bluetooth_transport_meta SET value=? WHERE key='outbound_sequence'")
        .run(next);
      return next;
    });
  }

  reserveRouteAdvertisementSequence(): number {
    this.#assertOpen();
    return withTransaction(this.#database, () => {
      const row = this.#database
        .prepare(
          "SELECT value FROM bluetooth_transport_meta " +
          "WHERE key='route_outbound_sequence'"
        )
        .get() as { value?: unknown } | undefined;
      const current = asNumber(row?.value ?? 0, "route_outbound_sequence");
      if (current >= 0xffff_ffff) {
        fail("SEQUENCE_EXHAUSTED", "route sequence space is exhausted");
      }
      const next = current + 1;
      const result = this.#database
        .prepare(
          "UPDATE bluetooth_transport_meta SET value=? " +
          "WHERE key='route_outbound_sequence' AND value=?"
        )
        .run(next, current);
      if (Number(result.changes) !== 1) {
        fail("CORRUPT_STORE", "route sequence high-watermark changed unexpectedly");
      }
      return next;
    });
  }

  routeAdvertisementSequenceHighWatermark(): number {
    this.#assertOpen();
    const row = this.#database
      .prepare(
        "SELECT value FROM bluetooth_transport_meta " +
        "WHERE key='route_outbound_sequence'"
      )
      .get() as { value?: unknown } | undefined;
    return asNumber(row?.value ?? 0, "route_outbound_sequence");
  }

  enqueueOutbox(record: ReliableOutboxRecordV1): void {
    this.#assertOpen();
    assertPeerTrustId(record.peerTrustId);
    assertMessageId(record.messageId);
    assertSafeInteger(record.type, 1, 255, "message type");
    assertSafeInteger(record.flags, 0, 255, "message flags");
    assertSafeInteger(record.createdAtEpochMs, 0, Number.MAX_SAFE_INTEGER, "createdAt");
    assertSafeInteger(record.expiresAtEpochMs, 1, Number.MAX_SAFE_INTEGER, "expiresAt");
    if (record.expiresAtEpochMs <= record.createdAtEpochMs) {
      fail("INVALID_STORE_VALUE", "outbox expiry must follow creation time");
    }
    try {
      this.#database
        .prepare(`
          INSERT INTO bluetooth_outbox(
            peer_trust_id, message_id, message_type, flags, payload,
            created_at_ms, expires_at_ms
          ) VALUES(?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          record.peerTrustId,
          record.messageId,
          record.type,
          record.flags,
          Buffer.from(record.payload),
          record.createdAtEpochMs,
          record.expiresAtEpochMs
        );
    } catch (error) {
      fail("OUTBOX_CONFLICT", "outbox record could not be committed", error);
    }
  }

  completeOutbox(peerTrustId: string, messageId: string): void {
    this.#assertOpen();
    this.#database
      .prepare(
        "DELETE FROM bluetooth_outbox WHERE peer_trust_id=? AND message_id=?"
      )
      .run(assertPeerTrustId(peerTrustId), assertMessageId(messageId));
  }

  listOutbox(
    peerTrustId: string,
    nowEpochMs: number
  ): readonly ReliableOutboxRecordV1[] {
    this.#assertOpen();
    const normalizedPeerTrustId = assertPeerTrustId(peerTrustId);
    assertSafeInteger(nowEpochMs, 0, Number.MAX_SAFE_INTEGER, "nowEpochMs");
    const rows = this.#database
      .prepare(`
        SELECT peer_trust_id, message_id, message_type, flags, payload,
               created_at_ms, expires_at_ms
        FROM bluetooth_outbox
        WHERE peer_trust_id=? AND expires_at_ms > ?
        ORDER BY created_at_ms ASC, message_id ASC
      `)
      .all(normalizedPeerTrustId, nowEpochMs) as Array<Record<string, unknown>>;
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          peerTrustId: assertPeerTrustId(String(row.peer_trust_id)),
          messageId: assertMessageId(String(row.message_id)),
          type: asNumber(row.message_type, "message_type") as ReliableFrameType,
          flags: asNumber(row.flags, "flags"),
          payload: Buffer.from(row.payload as Uint8Array),
          createdAtEpochMs: asNumber(row.created_at_ms, "created_at_ms"),
          expiresAtEpochMs: asNumber(row.expires_at_ms, "expires_at_ms")
        })
      )
    );
  }

  hasInbox(
    peerTrustId: string,
    messageId: string,
    nowEpochMs: number
  ): boolean {
    this.#assertOpen();
    const row = this.#database
      .prepare(`
        SELECT 1 AS present FROM bluetooth_inbox_dedup
        WHERE peer_trust_id=? AND message_id=? AND expires_at_ms > ?
      `)
      .get(
        assertPeerTrustId(peerTrustId),
        assertMessageId(messageId),
        nowEpochMs
      );
    return row !== undefined;
  }

  rememberInbox(
    peerTrustId: string,
    messageId: string,
    expiresAtEpochMs: number
  ): void {
    this.#assertOpen();
    assertSafeInteger(expiresAtEpochMs, 1, Number.MAX_SAFE_INTEGER, "expiresAtEpochMs");
    this.#database
      .prepare(`
        INSERT INTO bluetooth_inbox_dedup(
          peer_trust_id, message_id, expires_at_ms
        ) VALUES(?, ?, ?)
        ON CONFLICT(peer_trust_id, message_id) DO UPDATE SET
          expires_at_ms=MAX(expires_at_ms, excluded.expires_at_ms)
      `)
      .run(
        assertPeerTrustId(peerTrustId),
        assertMessageId(messageId),
        expiresAtEpochMs
      );
  }

  forgetInbox(peerTrustId: string, messageId: string): void {
    this.#assertOpen();
    this.#database
      .prepare(`
        DELETE FROM bluetooth_inbox_dedup
        WHERE peer_trust_id=? AND message_id=?
      `)
      .run(assertPeerTrustId(peerTrustId), assertMessageId(messageId));
  }

  prune(nowEpochMs: number): Readonly<{
    expiredOutbox: number;
    expiredInbox: number;
  }> {
    this.#assertOpen();
    assertSafeInteger(nowEpochMs, 0, Number.MAX_SAFE_INTEGER, "nowEpochMs");
    return withTransaction(this.#database, () => {
      const outbox = this.#database
        .prepare("DELETE FROM bluetooth_outbox WHERE expires_at_ms <= ?")
        .run(nowEpochMs);
      const inbox = this.#database
        .prepare("DELETE FROM bluetooth_inbox_dedup WHERE expires_at_ms <= ?")
        .run(nowEpochMs);
      return Object.freeze({
        expiredOutbox: Number(outbox.changes),
        expiredInbox: Number(inbox.changes)
      });
    });
  }

  upsertKnownPeer(input: {
    readonly nodeId: string;
    readonly capabilities: number;
    readonly lastSeenAtEpochMs: number;
    readonly serverReachable: boolean;
  }): void {
    this.#assertOpen();
    assertSafeInteger(input.capabilities, 0, 0x7f, "capabilities");
    assertSafeInteger(input.lastSeenAtEpochMs, 0, Number.MAX_SAFE_INTEGER, "lastSeenAt");
    this.#database
      .prepare(`
        INSERT INTO known_peers(node_id, capabilities, last_seen_at_ms, server_reachable)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
          capabilities=excluded.capabilities,
          last_seen_at_ms=MAX(last_seen_at_ms, excluded.last_seen_at_ms),
          server_reachable=excluded.server_reachable
      `)
      .run(
        assertIdentifier(input.nodeId, "nodeId"),
        input.capabilities,
        input.lastSeenAtEpochMs,
        input.serverReachable ? 1 : 0
      );
  }

  openSession(input: {
    readonly sessionId: string;
    readonly peerId: string;
    readonly openedAtEpochMs: number;
  }): void {
    this.#assertOpen();
    if (!SESSION_ID_PATTERN.test(input.sessionId)) {
      fail("INVALID_SESSION_ID", "sessionId is not canonical");
    }
    assertSafeInteger(input.openedAtEpochMs, 0, Number.MAX_SAFE_INTEGER, "openedAt");
    this.#database
      .prepare(`
        INSERT INTO session_history(session_id, peer_id, opened_at_ms)
        VALUES(?, ?, ?)
      `)
      .run(
        input.sessionId,
        assertIdentifier(input.peerId, "peerId"),
        input.openedAtEpochMs
      );
  }

  closeSession(input: {
    readonly sessionId: string;
    readonly closedAtEpochMs: number;
    readonly closeReason: string;
  }): void {
    this.#assertOpen();
    if (!SESSION_ID_PATTERN.test(input.sessionId)) {
      fail("INVALID_SESSION_ID", "sessionId is not canonical");
    }
    assertSafeInteger(input.closedAtEpochMs, 0, Number.MAX_SAFE_INTEGER, "closedAt");
    const result = this.#database
      .prepare(`
        UPDATE session_history
        SET closed_at_ms=?, close_reason=?
        WHERE session_id=? AND closed_at_ms IS NULL AND opened_at_ms <= ?
      `)
      .run(
        input.closedAtEpochMs,
        assertIdentifier(input.closeReason, "closeReason"),
        input.sessionId,
        input.closedAtEpochMs
      );
    if (Number(result.changes) !== 1) {
      fail("SESSION_CLOSE_CONFLICT", "session is missing, closed or clock-invalid");
    }
  }

  storeLastServerAdvertisement(value: StoredRouteAdvertisementV1): void {
    this.#assertOpen();
    if (!Object.values(ROUTE_KINDS_V1).includes(value.routeKind)) {
      fail("INVALID_ROUTE", "routeKind is not assigned");
    }
    for (const [field, candidate, maximum] of [
      ["serverRttBucket", value.serverRttBucket, 15],
      ["routeAgeSeconds", value.routeAgeSeconds, 65_535],
      ["queueDepthBucket", value.queueDepthBucket, 15],
      ["batteryBucket", value.batteryBucket, 15]
    ] as const) {
      assertSafeInteger(candidate, 0, maximum, field);
    }
    assertSafeInteger(value.observedAtEpochMs, 0, Number.MAX_SAFE_INTEGER, "observedAt");
    assertSafeInteger(value.sequence, 1, 0xffff_ffff, "sequence");
    const result = this.#database
      .prepare(`
        INSERT INTO last_server_advertisement(
          singleton_id, can_reach_server, route_kind, server_rtt_bucket,
          route_age_seconds, queue_depth_bucket, battery_bucket, sequence,
          observed_at_ms
        ) VALUES(1, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton_id) DO UPDATE SET
          can_reach_server=excluded.can_reach_server,
          route_kind=excluded.route_kind,
          server_rtt_bucket=excluded.server_rtt_bucket,
          route_age_seconds=excluded.route_age_seconds,
          queue_depth_bucket=excluded.queue_depth_bucket,
          battery_bucket=excluded.battery_bucket,
          sequence=excluded.sequence,
          observed_at_ms=excluded.observed_at_ms
        WHERE excluded.sequence > last_server_advertisement.sequence
      `)
      .run(
        value.canReachServer ? 1 : 0,
        value.routeKind,
        value.serverRttBucket,
        value.routeAgeSeconds,
        value.queueDepthBucket,
        value.batteryBucket,
        value.sequence,
        value.observedAtEpochMs
      );
    if (Number(result.changes) !== 1) {
      fail("ROUTE_SEQUENCE_REPLAY", "server route sequence did not advance");
    }
  }

  lastServerAdvertisement(): StoredRouteAdvertisementV1 | null {
    this.#assertOpen();
    const row = this.#database
      .prepare("SELECT * FROM last_server_advertisement WHERE singleton_id=1")
      .get() as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const routeKind = String(row.route_kind) as RouteKindV1;
    if (!Object.values(ROUTE_KINDS_V1).includes(routeKind)) {
      fail("CORRUPT_STORE", "stored routeKind is invalid");
    }
    return Object.freeze({
      canReachServer: asNumber(row.can_reach_server, "can_reach_server") === 1,
      routeKind,
      serverRttBucket: asNumber(row.server_rtt_bucket, "server_rtt_bucket"),
      routeAgeSeconds: asNumber(row.route_age_seconds, "route_age_seconds"),
      queueDepthBucket: asNumber(row.queue_depth_bucket, "queue_depth_bucket"),
      batteryBucket: asNumber(row.battery_bucket, "battery_bucket"),
      sequence: asNumber(row.sequence, "sequence"),
      observedAtEpochMs: asNumber(row.observed_at_ms, "observed_at_ms")
    });
  }

  snapshot(): Readonly<{
    outboxDepth: number;
    inboxDedupDepth: number;
    knownPeerCount: number;
    sessionHistoryCount: number;
    openSessionCount: number;
    hasServerAdvertisement: boolean;
    schemaVersion: 3;
  }> {
    this.#assertOpen();
    const scalar = (sql: string): number => {
      const row = this.#database.prepare(sql).get() as { count: unknown };
      return asNumber(row.count, "count");
    };
    return Object.freeze({
      outboxDepth: scalar("SELECT COUNT(*) AS count FROM bluetooth_outbox"),
      inboxDedupDepth: scalar("SELECT COUNT(*) AS count FROM bluetooth_inbox_dedup"),
      knownPeerCount: scalar("SELECT COUNT(*) AS count FROM known_peers"),
      sessionHistoryCount: scalar("SELECT COUNT(*) AS count FROM session_history"),
      openSessionCount: scalar(
        "SELECT COUNT(*) AS count FROM session_history WHERE closed_at_ms IS NULL"
      ),
      hasServerAdvertisement:
        scalar("SELECT COUNT(*) AS count FROM last_server_advertisement") === 1,
      schemaVersion: STORE_SCHEMA_VERSION
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  #initialize(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS bluetooth_transport_meta(
        key TEXT PRIMARY KEY NOT NULL,
        value INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS known_peers(
        node_id TEXT PRIMARY KEY NOT NULL,
        capabilities INTEGER NOT NULL CHECK(capabilities BETWEEN 0 AND 127),
        last_seen_at_ms INTEGER NOT NULL CHECK(last_seen_at_ms >= 0),
        server_reachable INTEGER NOT NULL CHECK(server_reachable IN (0,1))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS session_history(
        session_id TEXT PRIMARY KEY NOT NULL,
        peer_id TEXT NOT NULL,
        opened_at_ms INTEGER NOT NULL CHECK(opened_at_ms >= 0),
        closed_at_ms INTEGER,
        close_reason TEXT,
        CHECK(closed_at_ms IS NULL OR closed_at_ms >= opened_at_ms),
        CHECK((closed_at_ms IS NULL) = (close_reason IS NULL))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS last_server_advertisement(
        singleton_id INTEGER PRIMARY KEY NOT NULL CHECK(singleton_id=1),
        can_reach_server INTEGER NOT NULL CHECK(can_reach_server IN (0,1)),
        route_kind TEXT NOT NULL CHECK(route_kind IN ('WIFI','LAN','BLE_DIRECT','NONE')),
        server_rtt_bucket INTEGER NOT NULL CHECK(server_rtt_bucket BETWEEN 0 AND 15),
        route_age_seconds INTEGER NOT NULL CHECK(route_age_seconds BETWEEN 0 AND 65535),
        queue_depth_bucket INTEGER NOT NULL CHECK(queue_depth_bucket BETWEEN 0 AND 15),
        battery_bucket INTEGER NOT NULL CHECK(battery_bucket BETWEEN 0 AND 15),
        sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 4294967295),
        observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms >= 0)
      ) STRICT;
    `);
    withTransaction(this.#database, () => {
      this.#database
        .prepare(`
          INSERT INTO bluetooth_transport_meta(key, value)
          VALUES('schema_version', ?)
          ON CONFLICT(key) DO NOTHING
        `)
        .run(STORE_SCHEMA_VERSION);
      this.#database
        .prepare(`
          INSERT INTO bluetooth_transport_meta(key, value)
          VALUES('outbound_sequence', 0)
          ON CONFLICT(key) DO NOTHING
        `)
        .run();
      this.#database
        .prepare(`
          INSERT INTO bluetooth_transport_meta(key, value)
          VALUES('route_outbound_sequence', 0)
          ON CONFLICT(key) DO NOTHING
        `)
        .run();
      const row = this.#database
        .prepare("SELECT value FROM bluetooth_transport_meta WHERE key='schema_version'")
        .get() as { value?: unknown };
      let schemaVersion = asNumber(row.value, "schema_version");
      if (schemaVersion === LEGACY_STORE_SCHEMA_VERSION) {
        this.#migrateUnboundReliableRecordsV1ToV2();
        schemaVersion = PEER_BOUND_STORE_SCHEMA_VERSION;
      }
      if (schemaVersion === PEER_BOUND_STORE_SCHEMA_VERSION) {
        if (!this.#hasPeerBoundReliableTablesV2()) {
          this.#migrateUnboundReliableRecordsV1ToV2();
        }
        this.#migrateRouteSequenceV2ToV3();
      } else if (schemaVersion !== STORE_SCHEMA_VERSION) {
        fail("UNSUPPORTED_SCHEMA", "transport store schema is unsupported");
      }
      this.#createPeerBoundReliableTablesV2();
    });
  }

  #createPeerBoundReliableTablesV2(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS bluetooth_outbox(
        peer_trust_id TEXT NOT NULL
          CHECK(length(peer_trust_id)=64)
          CHECK(peer_trust_id=lower(peer_trust_id))
          CHECK(peer_trust_id NOT GLOB '*[^0-9a-f]*'),
        message_id TEXT NOT NULL
          CHECK(length(message_id)=32)
          CHECK(message_id=lower(message_id))
          CHECK(message_id NOT GLOB '*[^0-9a-f]*'),
        message_type INTEGER NOT NULL CHECK(message_type BETWEEN 1 AND 255),
        flags INTEGER NOT NULL CHECK(flags BETWEEN 0 AND 255),
        payload BLOB NOT NULL,
        created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
        expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms),
        PRIMARY KEY(peer_trust_id, message_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS bluetooth_outbox_expiry_idx
        ON bluetooth_outbox(expires_at_ms);
      CREATE TABLE IF NOT EXISTS bluetooth_inbox_dedup(
        peer_trust_id TEXT NOT NULL
          CHECK(length(peer_trust_id)=64)
          CHECK(peer_trust_id=lower(peer_trust_id))
          CHECK(peer_trust_id NOT GLOB '*[^0-9a-f]*'),
        message_id TEXT NOT NULL
          CHECK(length(message_id)=32)
          CHECK(message_id=lower(message_id))
          CHECK(message_id NOT GLOB '*[^0-9a-f]*'),
        expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > 0),
        PRIMARY KEY(peer_trust_id, message_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS bluetooth_inbox_expiry_idx
        ON bluetooth_inbox_dedup(expires_at_ms);
    `);
  }

  #hasPeerBoundReliableTablesV2(): boolean {
    for (const table of ["bluetooth_outbox", "bluetooth_inbox_dedup"]) {
      const columns = this.#database
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<Record<string, unknown>>;
      if (!columns.some((column) => String(column.name) === "peer_trust_id")) {
        return false;
      }
    }
    return true;
  }

  #migrateUnboundReliableRecordsV1ToV2(): void {
    const outboxDepth = asNumber(
      (
        this.#database
          .prepare("SELECT COUNT(*) AS count FROM bluetooth_outbox")
          .get() as { count: unknown }
      ).count,
      "legacy_outbox_count"
    );
    const inboxDepth = asNumber(
      (
        this.#database
          .prepare("SELECT COUNT(*) AS count FROM bluetooth_inbox_dedup")
          .get() as { count: unknown }
      ).count,
      "legacy_inbox_count"
    );
    if (outboxDepth !== 0 || inboxDepth !== 0) {
      fail(
        "UNBOUND_LEGACY_RECORDS",
        "schema v1 reliable records cannot be assigned to a peer trust context"
      );
    }
    this.#database.exec(`
      DROP INDEX IF EXISTS bluetooth_outbox_expiry_idx;
      DROP INDEX IF EXISTS bluetooth_inbox_expiry_idx;
      DROP TABLE bluetooth_outbox;
      DROP TABLE bluetooth_inbox_dedup;
    `);
    this.#createPeerBoundReliableTablesV2();
    this.#database
      .prepare(`
        UPDATE bluetooth_transport_meta SET value=? WHERE key='schema_version'
      `)
      .run(PEER_BOUND_STORE_SCHEMA_VERSION);
  }

  #migrateRouteSequenceV2ToV3(): void {
    this.#database.exec(
      "ALTER TABLE last_server_advertisement ADD COLUMN " +
      "sequence INTEGER NOT NULL DEFAULT 0 " +
      "CHECK(sequence BETWEEN 0 AND 4294967295)"
    );
    this.#database
      .prepare(`
        INSERT INTO bluetooth_transport_meta(key, value)
        VALUES('route_outbound_sequence', 0)
        ON CONFLICT(key) DO NOTHING
      `)
      .run();
    this.#database
      .prepare(
        "UPDATE bluetooth_transport_meta SET value=? WHERE key='schema_version'"
      )
      .run(STORE_SCHEMA_VERSION);
  }

  #assertOpen(): void {
    if (this.#closed) fail("STORE_CLOSED", "transport store is closed");
  }
}
