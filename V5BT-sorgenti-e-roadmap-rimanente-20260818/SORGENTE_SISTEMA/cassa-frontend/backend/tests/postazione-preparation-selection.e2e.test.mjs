import test from "node:test";
import assert from "node:assert/strict";
import {
  apiPost,
  authPayload,
  createSimpleOrder,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

function findOrder(db, orderId) {
  return (Array.isArray(db?.integration?.orders) ? db.integration.orders : []).find(
    (order) => String(order?.id ?? "").trim() === String(orderId ?? "").trim()
  );
}

test("la selezione postazione demuove lato backend la comanda precedente senza spunte", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const mobile = await loginJson(baseUrl, "waiter", "3333", {
    deviceUuid: "waiter-selection-device",
    clientApp: "mobile-frontend",
  });
  const station = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "station-selection-device",
    clientApp: "postazione",
  });

  const first = await createSimpleOrder(baseUrl, mobile, {
    deviceUuid: "waiter-selection-device",
    tableId: "room_pedana_t05",
    roomId: "room_pedana",
    tableNumber: 5,
  });
  assert.equal(first.response.status, 200);

  const second = await createSimpleOrder(baseUrl, mobile, {
    deviceUuid: "waiter-selection-device",
    tableId: "room_pedana_t06",
    roomId: "room_pedana",
    tableNumber: 6,
  });
  assert.equal(second.response.status, 200);

  const stationPoll = await fetch(
    `${baseUrl}/api/integration/orders?station=${encodeURIComponent("BAR PRINCIPALE")}&includeDone=1&includeTransferred=1&_=${Date.now()}`,
    {
      cache: "no-store",
      headers: {
        "X-Client-App": "postazione",
      },
    }
  );
  assert.equal(stationPoll.status, 200);

  let db = await readJson(dbPath);
  const firstBefore = findOrder(db, first.body.order.id);
  const secondBefore = findOrder(db, second.body.order.id);
  assert.ok(firstBefore);
  assert.ok(secondBefore);

  const firstSelected = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(station, "station-selection-device", {
      id: firstBefore.id,
      workflowReason: "selected_order",
      order: {
        ...firstBefore,
        workflowStatus: "prep",
        ownerStation: "BAR PRINCIPALE",
        ownerOperator: "Postazione Bar",
        ownerRole: "Operatore",
        ownerAtMs: Date.now(),
      },
    }),
    {
      headers: {
        "X-Client-App": "postazione",
      },
    }
  );
  assert.equal(firstSelected.response.status, 200);

  db = await readJson(dbPath);
  const preparing = findOrder(db, firstBefore.id);
  const waiting = findOrder(db, secondBefore.id);
  assert.equal(preparing.workflowStatus, "prep");
  assert.equal(waiting.workflowStatus, "waiting");

  const promoted = await apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(station, "station-selection-device", {
      id: waiting.id,
      workflowReason: "selected_order",
      order: {
        ...waiting,
        workflowStatus: "prep",
        ownerStation: "BAR PRINCIPALE",
        ownerOperator: "Postazione Bar",
        ownerRole: "Operatore",
        ownerAtMs: Date.now(),
      },
    }),
    {
      headers: {
        "X-Client-App": "postazione",
      },
    }
  );

  assert.equal(promoted.response.status, 200);
  assert.equal(promoted.body.ok, true);
  assert.equal(promoted.body.order.workflowStatus, "prep");
  assert.deepEqual(promoted.body.selectionHandoffDemotions, [
    {
      orderId: preparing.id,
      previousStatus: "prep",
      nextStatus: "waiting",
    },
  ]);

  db = await readJson(dbPath);
  assert.equal(findOrder(db, preparing.id).workflowStatus, "waiting");
  assert.equal(findOrder(db, waiting.id).workflowStatus, "prep");
  assert.ok(
    (Array.isArray(db.auditEvents) ? db.auditEvents : []).some(
      (event) =>
        event.action === "order.selection_handoff_demoted" &&
        event.entityId === preparing.id &&
        event.payload?.selectedOrderId === waiting.id
    ),
    "la demotion deve essere auditata"
  );
});
