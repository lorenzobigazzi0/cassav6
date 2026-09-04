import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  closeRelationalConnection,
  openRelationalConnection,
  OrdersRelationalRepository,
  ReservationsRelationalRepository,
  runRelationalMigrations,
  TablesBillsRelationalRepository,
} from "../db/relational/index.js";
import {
  persistRelationalTableMove,
  persistRelationalTableMoveWithRuntime,
} from "../modules/tables/relational-table-move-writer.js";
import { createTempRunDir } from "./helpers/test-server.mjs";

const now = "2026-07-16T14:45:00.000Z";

function table(id, roomId, revision, status) {
  return {
    id,
    roomId,
    number: id === "table_source" ? 1 : 2,
    status,
    covers: status === "free" ? 0 : 2,
    totalDue: status === "free" ? 0 : 12,
    revision,
    currentRevision: revision,
    updatedAt: now,
    pendingBills: [],
  };
}

function order(overrides = {}) {
  return {
    id: "order_move_1",
    tableId: "table_source",
    roomId: "room_source",
    tableNumber: 1,
    tableLabel: "1",
    workflowStatus: "prep",
    paymentStatus: "unpaid",
    source: "mobile",
    total: 12,
    dueAmount: 12,
    revision: 1,
    currentRevision: 1,
    createdAt: now,
    updatedAt: now,
    items: [{ lineId: "line_1", productName: "Caffe", quantity: 1, unitPrice: 12 }],
    ...overrides,
  };
}

async function openDb(name) {
  const runDir = await createTempRunDir(name);
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath: path.join(runDir, "relational.sqlite"),
  });
  await runRelationalMigrations(db, { nowIso: () => now });
  return db;
}

function seed(db) {
  new TablesBillsRelationalRepository(db).replaceAllFromAppState({
    posSettings: {
      tables: [
        table("table_source", "room_source", 1, "occupied"),
        table("table_target", "room_target", 1, "free"),
      ],
    },
  });
  new OrdersRelationalRepository(db).createOrder(order());
}

function movedState() {
  return {
    posSettings: {
      tables: [
        table("table_source", "room_source", 2, "free"),
        table("table_target", "room_target", 2, "occupied"),
      ],
    },
  };
}

function movedOrder(overrides = {}) {
  return order({
    tableId: "table_target",
    roomId: "room_target",
    tableNumber: 2,
    tableLabel: "2",
    logicalTableLabel: "2",
    lastTableTransferAtMs: 123456,
    ...overrides,
  });
}

test("spostamento relazionale salva tavoli e ubicazione ordine in un commit", async () => {
  const db = await openDb("relational-table-move-writer");
  try {
    seed(db);
    const result = persistRelationalTableMove({
      relationalDb: db,
      appState: movedState(),
      tableIds: ["table_source", "table_target"],
      movedOrders: [movedOrder()],
      requireRelationalOrders: true,
    });

    const tables = new TablesBillsRelationalRepository(db);
    const persistedOrder = new OrdersRelationalRepository(db).getOrderById("order_move_1");
    assert.equal(result.ok, true);
    assert.deepEqual(result.syncedOrderIds, ["order_move_1"]);
    assert.equal(tables.getTableState("table_source").status, "free");
    assert.equal(tables.getTableState("table_target").status, "occupied");
    assert.equal(persistedOrder.tableId, "table_target");
    assert.equal(persistedOrder.roomId, "room_target");
    assert.equal(persistedOrder.lastTableTransferAtMs, 123456);
    assert.equal(persistedOrder.revision, 2);
  } finally {
    closeRelationalConnection(db);
  }
});

test("spostamento relazionale rollbacka tavoli e ordini se manca una comanda", async () => {
  const db = await openDb("relational-table-move-writer-rollback");
  try {
    seed(db);
    assert.throws(
      () =>
        persistRelationalTableMove({
          relationalDb: db,
          appState: movedState(),
          tableIds: ["table_source", "table_target"],
          movedOrders: [movedOrder(), movedOrder({ id: "order_missing" })],
          requireRelationalOrders: true,
        }),
      (error) => error?.code === "RELATIONAL_TABLE_MOVE_ORDER_MISSING",
    );

    const tables = new TablesBillsRelationalRepository(db);
    const persistedOrder = new OrdersRelationalRepository(db).getOrderById("order_move_1");
    assert.equal(tables.getTableState("table_source").status, "occupied");
    assert.equal(tables.getTableState("table_target").status, "free");
    assert.equal(persistedOrder.tableId, "table_source");
    assert.equal(persistedOrder.revision, 1);
  } finally {
    closeRelationalConnection(db);
  }
});

test("spostamento tombstone trasferisce la prenotazione e cancella la fonte nello stesso commit", async () => {
  const db = await openDb("relational-removed-table-move-writer");
  try {
    new TablesBillsRelationalRepository(db).replaceAllFromAppState({
      posSettings: {
        tables: [
          table("table_source", "room_source", 1, "reserved"),
          table("table_target", "room_source", 1, "free"),
        ],
      },
    });
    const reservations = new ReservationsRelationalRepository(db);
    reservations.replaceAllFromAppState({
      posReservationStates: [
        {
          key: "room_source:2026-07-16",
          roomId: "room_source",
          serviceDate: "2026-07-16",
          version: 1,
          reservations: [
            {
              id: "reservation_move_1",
              roomId: "room_source",
              serviceDate: "2026-07-16",
              reservationAt: Date.parse(now),
              customerName: "Cliente",
              covers: 2,
              assignedTableId: "table_source",
              assignedTableIds: ["table_source"],
              createdAt: Date.parse(now) - 60_000,
              updatedAt: Date.parse(now) - 30_000,
            },
          ],
        },
      ],
    });

    const result = persistRelationalTableMove({
      relationalDb: db,
      appState: {
        posSettings: {
          tables: [table("table_target", "room_source", 2, "reserved")],
        },
      },
      tableIds: ["table_source", "table_target"],
      reservationTransfer: {
        reservationIds: ["reservation_move_1"],
        fromTableId: "table_source",
        toTableId: "table_target",
        nowMs: Date.parse(now),
      },
    });

    const tables = new TablesBillsRelationalRepository(db);
    assert.equal(result.ok, true);
    assert.equal(tables.getTableState("table_source"), null);
    assert.equal(tables.getTableState("table_target").status, "reserved");
    assert.deepEqual(
      reservations.getReservation("reservation_move_1").assignedTableIds,
      ["table_target"],
    );
    assert.equal(
      reservations.getReservation("reservation_move_1").revision,
      2,
    );
  } finally {
    closeRelationalConnection(db);
  }
});

test("conflitto prenotazione rollbacka anche la cancellazione della tombstone", async () => {
  const db = await openDb("relational-removed-table-move-reservation-rollback");
  try {
    seed(db);
    assert.throws(
      () =>
        persistRelationalTableMove({
          relationalDb: db,
          appState: {
            posSettings: {
              tables: [table("table_target", "room_target", 2, "reserved")],
            },
          },
          tableIds: ["table_source", "table_target"],
          reservationTransfer: {
            reservationIds: ["reservation_missing"],
            fromTableId: "table_source",
            toTableId: "table_target",
            nowMs: Date.parse(now),
          },
        }),
      (error) =>
        error?.code === "RELATIONAL_TABLE_MOVE_RESERVATION_CONFLICT",
    );

    const tables = new TablesBillsRelationalRepository(db);
    assert.equal(tables.getTableState("table_source").status, "occupied");
    assert.equal(tables.getTableState("table_target").status, "free");
  } finally {
    closeRelationalConnection(db);
  }
});

test("boundary cambio tavolo inizializza il runtime e converte gli errori noti", async () => {
  let initializeCalls = 0;
  await assert.rejects(
    persistRelationalTableMoveWithRuntime({
      relationalRuntime: {
        db: null,
        async initialize() {
          initializeCalls += 1;
        },
      },
      appState: movedState(),
      tableIds: ["table_source", "table_target"],
      httpErrorFactory(status, message, options) {
        return Object.assign(new Error(message), { status, ...options });
      },
    }),
    (error) =>
      error?.status === 503 &&
      error?.code === "RELATIONAL_TABLE_MOVE_DB_UNAVAILABLE",
  );
  assert.equal(initializeCalls, 1);
});
