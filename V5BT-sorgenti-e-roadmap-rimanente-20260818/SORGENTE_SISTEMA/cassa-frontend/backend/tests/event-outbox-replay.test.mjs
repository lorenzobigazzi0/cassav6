import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  EventOutboxRepository,
  closeRelationalConnection,
  openRelationalConnection,
  runRelationalMigrations,
} from "../db/relational/index.js";
import { createEventOutboxCoordinator } from "../modules/realtime-backbone/event-outbox.js";
import { createTempRunDir } from "./helpers/test-server.mjs";

function nowIso() {
  return "2026-07-06T12:00:00.000Z";
}

async function withDb(name, fn) {
  const runDir = await createTempRunDir(name);
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openRelationalConnection({ enabled: true, mode: "shadow", dbPath });
  try {
    await runRelationalMigrations(db, { nowIso });
    return await fn(db);
  } finally {
    closeRelationalConnection(db);
  }
}

function seedEvents(repo, count) {
  const ids = [];
  for (let i = 1; i <= count; i += 1) {
    const queued = repo.enqueue({
      eventType: "notification.acked",
      aggregateType: "notification",
      aggregateId: `n-${i}`,
      payload: { id: `n-${i}`, seq: i },
    });
    ids.push(queued.id);
  }
  return ids;
}

test("listAfter ritorna gli eventi con id crescente oltre afterId (replay/dedup)", async () => {
  await withDb("outbox-replay-listafter", (db) => {
    const repo = new EventOutboxRepository(db, { nowIso });
    const ids = seedEvents(repo, 5);

    const all = repo.listAfter(0);
    assert.deepEqual(all.map((e) => e.id), ids);

    const afterThird = repo.listAfter(ids[2]);
    assert.deepEqual(afterThird.map((e) => e.aggregateId), ["n-4", "n-5"]);

    const limited = repo.listAfter(0, { limit: 2 });
    assert.equal(limited.length, 2);
    assert.deepEqual(limited.map((e) => e.id), ids.slice(0, 2));

    // Dedup: rileggere dall'ultimo id visto non restituisce nulla.
    assert.deepEqual(repo.listAfter(ids[ids.length - 1]), []);
  });
});

test("getReplayBounds riflette min/max correnti e null su tabella vuota", async () => {
  await withDb("outbox-replay-bounds", (db) => {
    const repo = new EventOutboxRepository(db, { nowIso });
    assert.deepEqual(repo.getReplayBounds(), { minId: null, maxId: null });

    const ids = seedEvents(repo, 3);
    assert.deepEqual(repo.getReplayBounds(), { minId: ids[0], maxId: ids[2] });
  });
});

test("coordinator.replay segnala recoveryRequired quando il gap supera la retention", async () => {
  await withDb("outbox-replay-recovery", (db) => {
    const repo = new EventOutboxRepository(db, { nowIso });
    const ids = seedEvents(repo, 5);
    // Simula la potatura da retention dei primi due eventi.
    db.prepare("DELETE FROM event_outbox WHERE id IN (?, ?)").run(ids[0], ids[1]);
    assert.equal(repo.getReplayBounds().minId, ids[2]);

    const coordinator = createEventOutboxCoordinator({
      enabled: true,
      relationalRuntime: { db },
      nowIso,
    });

    // Client fermo a un id gia' potato → recovery.
    const stale = coordinator.replay({ afterEventId: ids[0] });
    assert.equal(stale.recoveryRequired, true);
    assert.deepEqual(stale.events, []);

    // Client al confine della finestra ancora disponibile → replay normale.
    const fresh = coordinator.replay({ afterEventId: ids[2] });
    assert.equal(fresh.recoveryRequired, false);
    assert.deepEqual(fresh.events.map((e) => e.aggregateId), ["n-4", "n-5"]);

    // Client nuovo (afterEventId 0) non richiede mai recovery.
    const brandNew = coordinator.replay({ afterEventId: 0 });
    assert.equal(brandNew.recoveryRequired, false);
    assert.equal(brandNew.events.length, 3);
  });
});

test("coordinator.replay disabilitato è inerte", async () => {
  await withDb("outbox-replay-disabled", (db) => {
    const coordinator = createEventOutboxCoordinator({
      enabled: false,
      relationalRuntime: { db },
      nowIso,
    });
    const result = coordinator.replay({ afterEventId: 0 });
    assert.equal(result.enabled, false);
    assert.deepEqual(result.events, []);
    assert.equal(result.recoveryRequired, false);
  });
});
