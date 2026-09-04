import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  closeRelationalConnection,
  openRelationalConnection,
  OrdersRelationalRepository,
  runRelationalMigrations,
} from "../db/relational/index.js";
import {
  createRelationalScopedOrderReader,
  createScopedReadsHandlers,
} from "../modules/scoped-reads/index.js";
import { createTempRunDir } from "./helpers/test-server.mjs";

class TestHttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function nowIso() {
  return "2026-07-07T15:00:00.000Z";
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

function buildOrder(overrides = {}) {
  return {
    id: "ord_step12d_1",
    tableId: "table_step12d_1",
    roomId: "room_step12d",
    workflowStatus: "waiting",
    paymentStatus: "unpaid",
    dueAmount: 12,
    total: 12,
    revision: 2,
    currentRevision: 2,
    source: "mobile",
    receivedAtMs: 1783510000000,
    createdAt: "2026-07-07T14:46:40.000Z",
    updatedAt: "2026-07-07T14:47:00.000Z",
    items: [],
    ...overrides,
  };
}

function createSendJsonCapture() {
  const capture = {
    status: null,
    payload: null,
  };
  return {
    capture,
    sendJson(_res, status, payload) {
      capture.status = status;
      capture.payload = payload;
    },
  };
}

function createHandlers(options = {}) {
  const { capture, sendJson } = createSendJsonCapture();
  const handlers = createScopedReadsHandlers({
    HttpError: TestHttpError,
    buildLayoutSnapshot: (db) => ({ tables: db?.posSettings?.tables ?? [] }),
    compareNotifications: () => 0,
    isNotificationGloballyAcknowledged: () => false,
    notificationMatchesTarget: () => true,
    readDb: async () => {
      throw new Error("legacy app-state read should not be used");
    },
    sanitizeNotification: (notification) => notification,
    scopedReadsEnabled: true,
    sendJson,
    ...options,
  });
  return { capture, handlers };
}

test("Step 12D handler ordine aperto legge da relazionale prima del full-state", async () => {
  const { capture, handlers } = createHandlers({
    relationalOrderReader: {
      enabled: true,
      findOpenOrderForTable: async (tableId) => ({
        order: tableId === "table_step12d_1" ? buildOrder({ id: "ord_step12d_rel" }) : null,
      }),
    },
  });

  await handlers.handleScopedTableOpenOrder(
    { params: { tableId: "table_step12d_1" } },
    {},
    new URL("http://localhost/api/tables/table_step12d_1/open-order"),
  );

  assert.equal(capture.status, 200);
  assert.equal(capture.payload.meta.source, "relational");
  assert.equal(capture.payload.meta.fullStateFallbackUsed, false);
  assert.equal(capture.payload.order.id, "ord_step12d_rel");
});

test("Step 12D handler restituisce null da relazionale quando il tavolo non ha ordini aperti", async () => {
  const { capture, handlers } = createHandlers({
    relationalOrderReader: {
      enabled: true,
      findOpenOrderForTable: async () => ({ order: null }),
    },
  });

  await handlers.handleScopedTableOpenOrder(
    { params: { tableId: "table_step12d_empty" } },
    {},
    new URL("http://localhost/api/tables/table_step12d_empty/open-order"),
  );

  assert.equal(capture.status, 200);
  assert.equal(capture.payload.meta.source, "relational");
  assert.equal(capture.payload.order, null);
});

test("Step 12D adapter sceglie l'ordine aperto piu recente dal DB relazionale", async () => {
  const db = await openMigratedDb("step12d-relational-open-order");
  try {
    const repository = new OrdersRelationalRepository(db);
    repository.replaceAllFromAppState({
      integration: {
        orders: [
          buildOrder({
            id: "ord_step12d_paid",
            paymentStatus: "paid",
            dueAmount: 0,
            paidAmount: 12,
            receivedAtMs: 1783509900000,
          }),
          buildOrder({
            id: "ord_step12d_old",
            workflowStatus: "waiting",
            dueAmount: 4,
            receivedAtMs: 1783510000000,
          }),
          buildOrder({
            id: "ord_step12d_new",
            workflowStatus: "prep",
            dueAmount: 8,
            receivedAtMs: 1783510100000,
            extraOrderField: "preserved-from-raw-json",
            lastEventId: 55,
          }),
        ],
      },
    });
    let initializeCalls = 0;
    const reader = createRelationalScopedOrderReader({
      enabled: true,
      relationalRuntime: {
        get db() {
          return db;
        },
        initialize: async () => {
          initializeCalls += 1;
        },
      },
    });

    const result = await reader.findOpenOrderForTable("#table_step12d_1");

    assert.equal(result.order.id, "ord_step12d_new");
    assert.equal(result.order.tableId, "table_step12d_1");
    assert.equal(result.order.roomId, "room_step12d");
    assert.equal(result.order.extraOrderField, "preserved-from-raw-json");
    assert.equal(result.order.aggregateVersion, 2);
    assert.equal(result.order.lastEventId, 55);
    assert.equal(initializeCalls, 1);
  } finally {
    closeRelationalConnection(db);
  }
});
