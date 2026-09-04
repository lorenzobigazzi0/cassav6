import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  closeRelationalConnection,
  openRelationalConnection,
  OrdersRelationalRepository,
  runRelationalMigrations,
} from "../db/relational/index.js";
import { createRelationalPaymentOrderStateSync } from "../modules/payments/relational-payment-order-sync.js";
import { createTempRunDir } from "./helpers/test-server.mjs";

function normalizeOrderIds(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean))];
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

class HttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.status = status;
    this.code = options.code;
    this.details = options.details;
  }
}

test("payment sync conserva il cambio tavolo piu recente e le unita gia pagate", async () => {
  const runDir = await createTempRunDir("rel-payment-order-sync");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openRelationalConnection({
    enabled: true,
    mode: "shadow",
    dbPath,
  });
  await runRelationalMigrations(db, {
    nowIso: () => "2026-07-16T15:00:00.000Z",
  });

  try {
    const repo = new OrdersRelationalRepository(db);
    repo.createOrder({
      id: "00991",
      tableId: "room_sala_t01",
      roomId: "room_sala",
      tableNumber: 1,
      tableLabel: "Tavolo 1",
      logicalTableLabel: "Tavolo 1",
      lastTableTransferAtMs: 100,
      workflowStatus: "prep",
      paymentStatus: "unpaid",
      total: 20,
      paidAmount: 0,
      dueAmount: 20,
      paidArticleUnits: [],
      createdAt: "2026-07-16T14:00:00.000Z",
      updatedAt: "2026-07-16T14:01:00.000Z",
      revision: 4,
      currentRevision: 4,
      items: [
        {
          id: "line_1",
          productId: "product_1",
          name: "Prodotto test",
          qty: 2,
          unitPriceApplied: 10,
          lineTotal: 20,
        },
      ],
    });

    const appState = {
      integration: {
        orders: [
          {
            id: "00991",
            tableId: "room_gazebo_t12",
            roomId: "room_gazebo",
            tableNumber: 12,
            tableLabel: "Tavolo 12",
            logicalTableLabel: "Tavolo 12",
            lastTableTransferAtMs: 200,
            workflowStatus: "prep",
            paymentStatus: "partial",
            total: 20,
            paidAmount: 10,
            dueAmount: 10,
            paidArticleUnits: ["00991_0_0"],
            updatedAt: "2026-07-16T14:10:00.000Z",
            revision: 1,
            currentRevision: 1,
          },
        ],
      },
    };
    const metrics = [];
    const sync = createRelationalPaymentOrderStateSync({
      relationalOrdersAnyWritePrimary: true,
      normalizeIntegrationOrderWriteIds: normalizeOrderIds,
      findIntegrationOrderIndexByLookup: (orders, id) =>
        orders.findIndex((order) => String(order?.id ?? "") === String(id)),
      sanitizeIntegrationOrder: (order, id) => ({ ...order, id: String(order?.id ?? id) }),
      clampInt,
      roundMoney,
      nowIso: () => "2026-07-16T15:00:00.000Z",
      HttpError,
      runtimeMetrics: {
        recordOperation(scope, label, durationMs) {
          metrics.push({ scope, label, durationMs });
        },
      },
    });

    const result = sync(db, { appState, orderIds: ["00991"] });
    const stored = repo.getOrderById("00991");

    assert.deepEqual(result, {
      synced: 1,
      skipped: 0,
      orderIds: ["00991"],
      skippedOrderIds: [],
    });
    assert.equal(stored.tableId, "room_gazebo_t12");
    assert.equal(stored.roomId, "room_gazebo");
    assert.equal(stored.tableNumber, 12);
    assert.equal(stored.lastTableTransferAtMs, 200);
    assert.equal(stored.paymentStatus, "partial");
    assert.equal(stored.paidAmount, 10);
    assert.equal(stored.dueAmount, 10);
    assert.deepEqual(stored.paidArticleUnits, ["00991_0_0"]);
    assert.equal(stored.revision, 5);
    assert.equal(appState.integration.orders[0].revision, 5);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].label, "payments.orders.relationalPaymentStateSync");
  } finally {
    closeRelationalConnection(db);
  }
});
