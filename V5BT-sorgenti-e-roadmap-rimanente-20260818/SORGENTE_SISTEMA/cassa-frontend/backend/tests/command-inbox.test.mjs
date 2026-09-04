import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CommandInboxRepository,
  createCommandEnvelope,
  hashCommandPayload,
  openRelationalConnection,
  closeRelationalConnection,
  normalizeRelationalConfig,
  runRelationalMigrations,
} from "../db/relational/index.js";

async function withDb(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cassav4-command-inbox-"));
  const dbPath = path.join(dir, "relational.sqlite");
  const config = normalizeRelationalConfig({
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: dbPath,
    },
    defaultDbPath: dbPath,
  });
  const db = await openRelationalConnection(config);
  try {
    await runRelationalMigrations(db, { nowIso: () => "2026-07-06T10:00:00.000Z" });
    return await fn(db);
  } finally {
    closeRelationalConnection(db);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("command inbox crea envelope canonico e hash stabile", () => {
  const left = hashCommandPayload({ b: 2, a: 1 });
  const right = hashCommandPayload({ a: 1, b: 2 });
  assert.equal(left, right);
  const envelope = createCommandEnvelope({
    requestId: "req-001",
    idempotencyKey: "dev-1:seq-1",
    deviceId: "dev-1",
    commandType: "orders.create",
    aggregateType: "order",
    aggregateId: "ord-1",
    expectedVersion: 7,
    payload: { a: 1 },
    nowIso: () => "2026-07-06T10:00:00.000Z",
  });
  assert.equal(envelope.requestId, "req-001");
  assert.equal(envelope.payloadHash.length, 64);
  assert.equal(envelope.expectedVersion, 7);
});

test("command inbox begin + commit + replay stesso comando", async () => {
  await withDb((db) => {
    const repo = new CommandInboxRepository(db, { nowIso: () => "2026-07-06T10:00:00.000Z" });
    const command = {
      requestId: "req-abc-001",
      idempotencyKey: "device-1:command-1",
      deviceId: "device-1",
      userId: "user-1",
      commandType: "orders.create",
      aggregateType: "order",
      aggregateId: "ord-abc",
      expectedVersion: 1,
      payload: { items: [{ id: "coffee", qty: 1 }] },
      expiresAt: "2026-07-06T11:00:00.000Z",
    };
    const created = repo.begin(command);
    assert.equal(created.state, "created");
    assert.equal(created.record.status, "processing");

    const committed = repo.commit(command.requestId, { orderId: "ord-abc", version: 2 });
    assert.equal(committed.status, "committed");
    assert.deepEqual(committed.result, { orderId: "ord-abc", version: 2 });

    const replay = repo.begin(command);
    assert.equal(replay.state, "committed");
    assert.deepEqual(replay.result, { orderId: "ord-abc", version: 2 });
  });
});

test("command inbox rileva payload diverso sulla stessa idempotency key", async () => {
  await withDb((db) => {
    const repo = new CommandInboxRepository(db, { nowIso: () => "2026-07-06T10:00:00.000Z" });
    const base = {
      requestId: "req-conflict-001",
      idempotencyKey: "device-2:command-1",
      deviceId: "device-2",
      commandType: "payments.settle",
      aggregateType: "payment",
      aggregateId: "pay-1",
      payload: { amount: 10 },
    };
    assert.equal(repo.begin(base).state, "created");
    const conflict = repo.begin({ ...base, requestId: "req-conflict-002", payload: { amount: 11 } });
    assert.equal(conflict.state, "conflict");
    assert.equal(conflict.record.requestId, "req-conflict-001");
  });
});

test("command inbox mantiene riepilogo e pulizia scaduti non processing", async () => {
  await withDb((db) => {
    let now = "2026-07-06T10:00:00.000Z";
    const repo = new CommandInboxRepository(db, { nowIso: () => now });
    repo.begin({
      requestId: "req-expired-001",
      idempotencyKey: "device-3:command-1",
      deviceId: "device-3",
      commandType: "notifications.ack",
      payload: { notificationId: "n1" },
      expiresAt: "2026-07-06T10:01:00.000Z",
    });
    repo.commit("req-expired-001", { ok: true });
    repo.begin({
      requestId: "req-open-001",
      idempotencyKey: "device-3:command-2",
      deviceId: "device-3",
      commandType: "tables.occupy",
      aggregateType: "table",
      aggregateId: "t1",
      payload: { tableId: "t1" },
      expiresAt: "2026-07-06T09:00:00.000Z",
    });
    assert.equal(repo.countSummary().committed, 1);
    assert.equal(repo.countSummary().processing, 1);
    now = "2026-07-06T10:02:00.000Z";
    assert.equal(repo.deleteExpired(now), 1);
    assert.equal(repo.countSummary().committed, 0);
    assert.equal(repo.countSummary().processing, 1);
  });
});
