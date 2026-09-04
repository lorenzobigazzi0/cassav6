import assert from "node:assert/strict";
import { chmodSync, linkSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { RELIABLE_FRAME_FLAGS, RELIABLE_FRAME_TYPES } from "../dist/protocol/FrameCodec.js";
import {
  BluetoothTransportStoreError,
  BluetoothTransportStoreV1,
  ROUTE_KINDS_V1
} from "../dist/storage/BluetoothTransportStore.js";

const NOW = 1_800_000_000_000;
const PEER_A = "a".repeat(64);
const PEER_B = "b".repeat(64);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "v6-store-"));
  chmodSync(root, 0o700);
  return {
    root,
    databasePath: path.join(root, "transport.sqlite"),
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    }
  };
}

function record(messageId, overrides = {}) {
  return {
    peerTrustId: PEER_A,
    messageId,
    type: RELIABLE_FRAME_TYPES.DATA,
    flags: RELIABLE_FRAME_FLAGS.DURABLE,
    payload: Buffer.from("durable"),
    createdAtEpochMs: NOW,
    expiresAtEpochMs: NOW + 60_000,
    ...overrides
  };
}

function createLegacyStore(
  databasePath,
  { schemaVersion, peerBound = false, outbox = false, inbox = false } = {}
) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE bluetooth_transport_meta(
      key TEXT PRIMARY KEY NOT NULL,
      value INTEGER NOT NULL
    ) STRICT;
    INSERT INTO bluetooth_transport_meta(key,value)
      VALUES('schema_version',${schemaVersion});
    INSERT INTO bluetooth_transport_meta(key,value)
      VALUES('outbound_sequence',9);
    CREATE TABLE known_peers(
      node_id TEXT PRIMARY KEY NOT NULL,
      capabilities INTEGER NOT NULL,
      last_seen_at_ms INTEGER NOT NULL,
      server_reachable INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE session_history(
      session_id TEXT PRIMARY KEY NOT NULL,
      peer_id TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      close_reason TEXT
    ) STRICT;
    CREATE TABLE last_server_advertisement(
      singleton_id INTEGER PRIMARY KEY NOT NULL CHECK(singleton_id=1),
      can_reach_server INTEGER NOT NULL,
      route_kind TEXT NOT NULL,
      server_rtt_bucket INTEGER NOT NULL,
      route_age_seconds INTEGER NOT NULL,
      queue_depth_bucket INTEGER NOT NULL,
      battery_bucket INTEGER NOT NULL,
      observed_at_ms INTEGER NOT NULL
    ) STRICT;
    INSERT INTO last_server_advertisement VALUES(1,1,'LAN',2,1,3,9,${NOW});
  `);
  if (peerBound) {
    database.exec(`
      CREATE TABLE bluetooth_outbox(
        peer_trust_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        message_type INTEGER NOT NULL,
        flags INTEGER NOT NULL,
        payload BLOB NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        PRIMARY KEY(peer_trust_id,message_id)
      ) STRICT;
      CREATE TABLE bluetooth_inbox_dedup(
        peer_trust_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        PRIMARY KEY(peer_trust_id,message_id)
      ) STRICT;
    `);
  } else {
    database.exec(`
      CREATE TABLE bluetooth_outbox(
        message_id TEXT PRIMARY KEY NOT NULL,
        message_type INTEGER NOT NULL,
        flags INTEGER NOT NULL,
        payload BLOB NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE bluetooth_inbox_dedup(
        message_id TEXT PRIMARY KEY NOT NULL,
        expires_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
  }
  if (outbox) {
    const columns = peerBound
      ? "peer_trust_id,message_id,message_type,flags,payload,created_at_ms,expires_at_ms"
      : "message_id,message_type,flags,payload,created_at_ms,expires_at_ms";
    const values = peerBound
      ? `('${PEER_A}','00112233445566778899aabbccddeeff',1,1,X'01',${NOW},${NOW + 60_000})`
      : `('00112233445566778899aabbccddeeff',1,1,X'01',${NOW},${NOW + 60_000})`;
    database.exec(`INSERT INTO bluetooth_outbox(${columns}) VALUES${values};`);
  }
  if (inbox) {
    const columns = peerBound
      ? "peer_trust_id,message_id,expires_at_ms"
      : "message_id,expires_at_ms";
    const values = peerBound
      ? `('${PEER_A}','10112233445566778899aabbccddeeff',${NOW + 60_000})`
      : `('10112233445566778899aabbccddeeff',${NOW + 60_000})`;
    database.exec(`INSERT INTO bluetooth_inbox_dedup(${columns}) VALUES${values};`);
  }
  database.close();
}

function isUnboundLegacyFailure(error) {
  return error instanceof BluetoothTransportStoreError &&
    error.code === "STORE_INITIALIZATION_FAILED" &&
    error.cause instanceof BluetoothTransportStoreError &&
    error.cause.code === "UNBOUND_LEGACY_RECORDS";
}

test("SQLite transport store is private and persists every B8 table", async () => {
  const files = await fixture();
  try {
    let store = new BluetoothTransportStoreV1(files.databasePath);
    assert.equal(lstatSync(files.databasePath).mode & 0o777, 0o600);
    assert.equal(lstatSync(files.databasePath).nlink, 1);
    assert.equal(store.reserveOutboundSequence(), 1);
    assert.equal(store.reserveOutboundSequence(), 2);
    assert.equal(store.reserveRouteAdvertisementSequence(), 1);
    store.enqueueOutbox(record("00112233445566778899aabbccddeeff"));
    store.rememberInbox(
      PEER_A,
      "10112233445566778899aabbccddeeff",
      NOW + 60_000
    );
    store.upsertKnownPeer({
      nodeId: "peer-1",
      capabilities: 0x3f,
      lastSeenAtEpochMs: NOW,
      serverReachable: true
    });
    store.openSession({
      sessionId: "AbCdEfGhIjKlMnOpQrStUg",
      peerId: "peer-1",
      openedAtEpochMs: NOW
    });
    store.storeLastServerAdvertisement({
      canReachServer: true,
      routeKind: ROUTE_KINDS_V1.LAN,
      serverRttBucket: 2,
      routeAgeSeconds: 1,
      queueDepthBucket: 3,
      batteryBucket: 9,
      sequence: 7,
      observedAtEpochMs: NOW
    });
    assert.deepEqual(store.snapshot(), {
      outboxDepth: 1,
      inboxDedupDepth: 1,
      knownPeerCount: 1,
      sessionHistoryCount: 1,
      openSessionCount: 1,
      hasServerAdvertisement: true,
      schemaVersion: 3
    });
    store.close();

    store = new BluetoothTransportStoreV1(files.databasePath);
    assert.equal(store.reserveOutboundSequence(), 3);
    assert.equal(store.routeAdvertisementSequenceHighWatermark(), 1);
    assert.deepEqual(store.listOutbox(PEER_A, NOW), [
      record("00112233445566778899aabbccddeeff")
    ]);
    assert.equal(
      store.hasInbox(PEER_A, "10112233445566778899aabbccddeeff", NOW),
      true
    );
    assert.deepEqual(store.lastServerAdvertisement(), {
      canReachServer: true,
      routeKind: ROUTE_KINDS_V1.LAN,
      serverRttBucket: 2,
      routeAgeSeconds: 1,
      queueDepthBucket: 3,
      batteryBucket: 9,
      sequence: 7,
      observedAtEpochMs: NOW
    });
    assert.throws(
      () => store.storeLastServerAdvertisement({
        canReachServer: true,
        routeKind: ROUTE_KINDS_V1.LAN,
        serverRttBucket: 2,
        routeAgeSeconds: 1,
        queueDepthBucket: 3,
        batteryBucket: 9,
        sequence: 7,
        observedAtEpochMs: NOW + 1
      }),
      (error) =>
        error instanceof BluetoothTransportStoreError &&
        error.code === "ROUTE_SEQUENCE_REPLAY"
    );
    store.closeSession({
      sessionId: "AbCdEfGhIjKlMnOpQrStUg",
      closedAtEpochMs: NOW + 1_000,
      closeReason: "NORMAL"
    });
    assert.equal(store.snapshot().openSessionCount, 0);
    store.close();
  } finally {
    await files.cleanup();
  }
});

test("peer-bound durable records isolate identical message IDs", async () => {
  const files = await fixture();
  try {
    const store = new BluetoothTransportStoreV1(files.databasePath);
    const messageId = "70112233445566778899aabbccddeeff";
    store.enqueueOutbox(record(messageId));
    store.enqueueOutbox(record(messageId, { peerTrustId: PEER_B }));
    assert.equal(store.listOutbox(PEER_A, NOW).length, 1);
    assert.equal(store.listOutbox(PEER_B, NOW).length, 1);
    store.completeOutbox(PEER_A, messageId);
    assert.equal(store.listOutbox(PEER_A, NOW).length, 0);
    assert.equal(store.listOutbox(PEER_B, NOW).length, 1);

    const inboxId = "80112233445566778899aabbccddeeff";
    store.rememberInbox(PEER_A, inboxId, NOW + 60_000);
    store.rememberInbox(PEER_B, inboxId, NOW + 60_000);
    store.forgetInbox(PEER_A, inboxId);
    assert.equal(store.hasInbox(PEER_A, inboxId, NOW), false);
    assert.equal(store.hasInbox(PEER_B, inboxId, NOW), true);
    store.close();
  } finally {
    await files.cleanup();
  }
});

test("empty schema v1 migrates through peer binding to route schema v3", async () => {
  const files = await fixture();
  try {
    createLegacyStore(files.databasePath, { schemaVersion: 1 });
    const store = new BluetoothTransportStoreV1(files.databasePath);
    assert.equal(store.snapshot().schemaVersion, 3);
    assert.equal(store.reserveOutboundSequence(), 10);
    assert.equal(store.routeAdvertisementSequenceHighWatermark(), 0);
    assert.equal(store.lastServerAdvertisement().sequence, 0);
    store.close();
  } finally {
    await files.cleanup();
  }
});

test("empty peer-bound schema v2 migrates route state to v3", async () => {
  const files = await fixture();
  try {
    createLegacyStore(files.databasePath, { schemaVersion: 2, peerBound: true });
    const store = new BluetoothTransportStoreV1(files.databasePath);
    assert.equal(store.snapshot().schemaVersion, 3);
    assert.equal(store.lastServerAdvertisement().sequence, 0);
    assert.equal(store.reserveRouteAdvertisementSequence(), 1);
    store.close();
  } finally {
    await files.cleanup();
  }
});

for (const schemaVersion of [1, 2]) {
  for (const field of ["outbox", "inbox"]) {
    test(`unbound schema v${schemaVersion} ${field} records block migration`, async () => {
      const files = await fixture();
      try {
        createLegacyStore(files.databasePath, {
          schemaVersion,
          [field]: true
        });
        assert.throws(
          () => new BluetoothTransportStoreV1(files.databasePath),
          isUnboundLegacyFailure
        );
      } finally {
        await files.cleanup();
      }
    });
  }
}

test("outbox uniqueness, ACK completion and expiry pruning are atomic", async () => {
  const files = await fixture();
  try {
    const store = new BluetoothTransportStoreV1(files.databasePath);
    const id = "20112233445566778899aabbccddeeff";
    store.enqueueOutbox(record(id, { expiresAtEpochMs: NOW + 1_000 }));
    assert.throws(
      () => store.enqueueOutbox(record(id)),
      (error) =>
        error instanceof BluetoothTransportStoreError &&
        error.code === "OUTBOX_CONFLICT"
    );
    store.rememberInbox(
      PEER_A,
      "30112233445566778899aabbccddeeff",
      NOW + 1_000
    );
    assert.deepEqual(store.prune(NOW + 1_000), {
      expiredOutbox: 1,
      expiredInbox: 1
    });
    assert.equal(store.snapshot().outboxDepth, 0);
    store.enqueueOutbox(record("40112233445566778899aabbccddeeff"));
    store.completeOutbox(PEER_A, "40112233445566778899aabbccddeeff");
    assert.equal(store.snapshot().outboxDepth, 0);
    store.close();
  } finally {
    await files.cleanup();
  }
});

test("symlink, hardlink and non-private parent are rejected", async () => {
  const files = await fixture();
  try {
    const target = path.join(files.root, "target.sqlite");
    const targetStore = new BluetoothTransportStoreV1(target);
    targetStore.close();
    const link = path.join(files.root, "link.sqlite");
    symlinkSync(target, link);
    assert.throws(
      () => new BluetoothTransportStoreV1(link),
      (error) =>
        error instanceof BluetoothTransportStoreError &&
        ["STORE_OPEN_FAILED", "UNSAFE_STORE_FILE"].includes(error.code)
    );
    const hardlink = path.join(files.root, "hard.sqlite");
    linkSync(target, hardlink);
    assert.throws(
      () => new BluetoothTransportStoreV1(hardlink),
      (error) =>
        error instanceof BluetoothTransportStoreError &&
        error.code === "UNSAFE_STORE_FILE"
    );
    const publicDir = path.join(files.root, "public");
    mkdirSync(publicDir, { mode: 0o755 });
    chmodSync(publicDir, 0o755);
    assert.throws(
      () => new BluetoothTransportStoreV1(path.join(publicDir, "db.sqlite")),
      (error) =>
        error instanceof BluetoothTransportStoreError &&
        error.code === "UNSAFE_STORE_MODE"
    );
  } finally {
    await files.cleanup();
  }
});

test("session close is one-shot and rejects regressive clocks", async () => {
  const files = await fixture();
  try {
    const store = new BluetoothTransportStoreV1(files.databasePath);
    store.openSession({
      sessionId: "ZbCdEfGhIjKlMnOpQrStUg",
      peerId: "peer-2",
      openedAtEpochMs: NOW
    });
    assert.throws(
      () =>
        store.closeSession({
          sessionId: "ZbCdEfGhIjKlMnOpQrStUg",
          closedAtEpochMs: NOW - 1,
          closeReason: "CLOCK"
        }),
      (error) =>
        error instanceof BluetoothTransportStoreError &&
        error.code === "SESSION_CLOSE_CONFLICT"
    );
    store.closeSession({
      sessionId: "ZbCdEfGhIjKlMnOpQrStUg",
      closedAtEpochMs: NOW + 1,
      closeReason: "NORMAL"
    });
    assert.throws(
      () =>
        store.closeSession({
          sessionId: "ZbCdEfGhIjKlMnOpQrStUg",
          closedAtEpochMs: NOW + 2,
          closeReason: "DUPLICATE"
        }),
      (error) =>
        error instanceof BluetoothTransportStoreError &&
        error.code === "SESSION_CLOSE_CONFLICT"
    );
    store.close();
  } finally {
    await files.cleanup();
  }
});

test("closed store fails closed without leaking identifiers in snapshot", async () => {
  const files = await fixture();
  try {
    const store = new BluetoothTransportStoreV1(files.databasePath);
    store.enqueueOutbox(record("50112233445566778899aabbccddeeff"));
    const serialized = JSON.stringify(store.snapshot());
    assert.equal(serialized.includes("501122"), false);
    assert.equal(serialized.includes(files.databasePath), false);
    store.close();
    assert.throws(
      () => store.snapshot(),
      (error) =>
        error instanceof BluetoothTransportStoreError &&
        error.code === "STORE_CLOSED"
    );
  } finally {
    await files.cleanup();
  }
});
