import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  closeRelationalConnection,
  openRelationalConnection,
  OrdersRelationalRepository,
  runRelationalMigrations,
  TablesBillsRelationalRepository,
} from "../db/relational/index.js";
import { bindAggregateLastEventId } from "../modules/realtime-backbone/aggregate-last-event-binding.js";
import { createEventOutboxCoordinator } from "../modules/realtime-backbone/event-outbox.js";
import { createTempRunDir } from "./helpers/test-server.mjs";

function nowIso() {
  return "2026-07-07T13:00:00.000Z";
}

function relationalConfig(dbPath) {
  return {
    enabled: true,
    mode: "shadow",
    dbPath,
  };
}

async function openMigratedDb(name) {
  const runDir = await createTempRunDir(name);
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openRelationalConnection(relationalConfig(dbPath));
  await runRelationalMigrations(db, { nowIso });
  return db;
}

function createBindingCoordinator(db) {
  return createEventOutboxCoordinator({
    enabled: true,
    relationalRuntime: { db },
    nowIso,
    canPublish: () => false,
    afterEnqueue: (event, connection) => bindAggregateLastEventId(connection, event),
  });
}

function buildOrder(overrides = {}) {
  return {
    id: "ord_step12b",
    tableId: "table_step12b",
    roomId: "room_main",
    workflowStatus: "prep",
    source: "mobile",
    total: 12,
    revision: 1,
    currentRevision: 1,
    createdAt: "2026-07-07T12:50:00.000Z",
    updatedAt: "2026-07-07T12:51:00.000Z",
    items: [],
    ...overrides,
  };
}

function buildTable(overrides = {}) {
  return {
    id: "table_step12b",
    roomId: "room_main",
    status: "occupied",
    covers: 2,
    totalDue: 12,
    revision: 1,
    currentRevision: 1,
    updatedAt: "2026-07-07T12:51:00.000Z",
    pendingBills: [],
    ...overrides,
  };
}

test("Step 12B collega event_outbox.last event agli ordini", async () => {
  const db = await openMigratedDb("step12b-order-binding");
  try {
    const repo = new OrdersRelationalRepository(db);
    repo.createOrder(buildOrder());
    const coordinator = createBindingCoordinator(db);

    const queued = coordinator.enqueue({
      eventType: "order.created",
      aggregateType: "order",
      aggregateId: "ord_step12b",
      scope: "room_main",
      payload: { detail: { orderId: "ord_step12b", order: { revision: 1 } } },
    });

    assert.equal(repo.getOrderById("ord_step12b").lastEventId, queued.id);

    repo.replaceOrderWithRevision(buildOrder({ revision: 2, currentRevision: 2 }), 1);
    assert.equal(repo.getOrderById("ord_step12b").lastEventId, queued.id);

    repo.replaceAllFromAppState({ integration: { orders: [buildOrder({ revision: 2, currentRevision: 2 })] } });
    assert.equal(repo.getOrderById("ord_step12b").lastEventId, queued.id);
  } finally {
    closeRelationalConnection(db);
  }
});

test("Step 12B collega event_outbox.last event ai tavoli", async () => {
  const db = await openMigratedDb("step12b-table-binding");
  try {
    const repo = new TablesBillsRelationalRepository(db);
    repo.replaceAllFromAppState({ posSettings: { tables: [buildTable()] } });
    const coordinator = createBindingCoordinator(db);

    const queued = coordinator.enqueue({
      eventType: "table.moved",
      aggregateType: "table",
      aggregateId: "table_step12b",
      scope: "room_main",
      payload: { detail: { tableId: "table_step12b", table: { revision: 1 } } },
    });

    assert.equal(repo.getTableState("table_step12b").lastEventId, queued.id);

    repo.replaceTablesFromAppState(
      { posSettings: { tables: [buildTable({ revision: 2, currentRevision: 2 })] } },
      ["table_step12b"],
      { enforceRevision: true },
    );
    assert.equal(repo.getTableState("table_step12b").lastEventId, queued.id);

    repo.replaceAllFromAppState({ posSettings: { tables: [buildTable({ revision: 2, currentRevision: 2 })] } });
    assert.equal(repo.getTableState("table_step12b").lastEventId, queued.id);
  } finally {
    closeRelationalConnection(db);
  }
});

test("Step 12B non retrocede last_event_id se arriva un evento piu vecchio", async () => {
  const db = await openMigratedDb("step12b-last-event-monotonic");
  try {
    const repo = new OrdersRelationalRepository(db);
    repo.createOrder(buildOrder({ lastEventId: 999 }));
    const coordinator = createBindingCoordinator(db);

    const queued = coordinator.enqueue({
      eventType: "order.updated",
      aggregateType: "order",
      aggregateId: "ord_step12b",
      payload: { detail: { orderId: "ord_step12b", order: { revision: 1 } } },
    });

    assert.ok(queued.id < 999);
    assert.equal(repo.getOrderById("ord_step12b").lastEventId, 999);
  } finally {
    closeRelationalConnection(db);
  }
});

test("Step 12B hook afterEnqueue resta nella stessa transazione outbox", async () => {
  const db = await openMigratedDb("step12b-after-enqueue-rollback");
  try {
    const coordinator = createEventOutboxCoordinator({
      enabled: true,
      relationalRuntime: { db },
      nowIso,
      afterEnqueue() {
        throw new Error("forced aggregate binding failure");
      },
    });

    assert.throws(
      () =>
        coordinator.enqueue({
          eventType: "order.created",
          aggregateType: "order",
          aggregateId: "ord_step12b",
          payload: { ok: true },
        }),
      /forced aggregate binding failure/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM event_outbox").get().count, 0);
  } finally {
    closeRelationalConnection(db);
  }
});
