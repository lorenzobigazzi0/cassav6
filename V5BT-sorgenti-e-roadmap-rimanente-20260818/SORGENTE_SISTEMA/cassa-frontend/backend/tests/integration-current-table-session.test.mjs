import assert from "node:assert/strict";
import test from "node:test";
import { startBackend } from "./helpers/test-server.mjs";

test("GET /api/integration/orders currentSessionOnly mantiene ordini pagati se table.settled keptOccupied", async (t) => {
  const openedAt = "2026-06-03T10:00:00.000Z";
  const settledAt = "2026-06-03T10:05:00.000Z";
  const oldOrderAt = "2026-06-03T10:02:00.000Z";
  const newOrderAt = "2026-06-03T10:08:00.000Z";
  const oldOrderAtMs = Date.parse(oldOrderAt);
  const newOrderAtMs = Date.parse(newOrderAt);

  const { baseUrl } = await startBackend(t, {
    stateOverrides(state) {
      state.posSettings.tables = state.posSettings.tables.map((table) =>
        table.id === "room_pedana_t05"
          ? {
              ...table,
              status: "no_orders",
              covers: 2,
              seatedAt: Date.parse(openedAt),
              totalDue: 8,
              pendingBills: [],
            }
          : table
      );
      state.auditEvents = [
        {
          id: "audit_session_opened",
          occurredAt: openedAt,
          action: "table.session_opened",
          entityType: "table",
          entityId: "room_pedana_t05",
          payload: {
            tableId: "room_pedana_t05",
            tableNumber: 5,
            roomId: "room_pedana",
          },
        },
        {
          id: "audit_table_settled",
          occurredAt: settledAt,
          action: "table.settled",
          entityType: "table",
          entityId: "room_pedana_t05",
          payload: {
            tableId: "room_pedana_t05",
            tableNumber: 5,
            roomId: "room_pedana",
            paymentId: "pay_old",
            nextStatus: "no_orders",
            keptOccupied: true,
          },
        },
      ];
      state.integration.orders = [
        {
          id: "00010",
          tableId: "room_pedana_t05",
          tableNumber: 5,
          roomId: "room_pedana",
          title: "Comanda vecchia pagata",
          workflowStatus: "delivered",
          paymentStatus: "paid",
          total: 12,
          paidAmount: 12,
          dueAmount: 0,
          receivedAtMs: oldOrderAtMs,
          createdAt: oldOrderAt,
          updatedAt: settledAt,
          items: [{ name: "Ichnusa", qty: 1, lineTotal: 12 }],
        },
        {
          id: "00011",
          tableId: "room_pedana_t05",
          tableNumber: 5,
          roomId: "room_pedana",
          title: "Comanda corrente",
          workflowStatus: "ready",
          paymentStatus: "unpaid",
          total: 8,
          paidAmount: 0,
          dueAmount: 8,
          receivedAtMs: newOrderAtMs,
          createdAt: newOrderAt,
          updatedAt: newOrderAt,
          items: [{ name: "Spritz", qty: 1, lineTotal: 8 }],
        },
      ];
    },
  });

  const allResponse = await fetch(`${baseUrl}/api/integration/orders?includeDone=1`);
  assert.equal(allResponse.status, 200);
  const allPayload = await allResponse.json();
  assert.deepEqual(
    allPayload.orders.map((order) => order.id).sort(),
    ["00010", "00011"]
  );

  const currentResponse = await fetch(
    `${baseUrl}/api/integration/orders?includeDone=1&currentSessionOnly=1`
  );
  assert.equal(currentResponse.status, 200);
  const currentPayload = await currentResponse.json();
  assert.deepEqual(
    currentPayload.orders.map((order) => order.id),
    ["00010", "00011"]
  );
});

test("GET /api/integration/orders currentSessionOnly esclude ordini pagati prima del table.released", async (t) => {
  const openedAt = "2026-06-03T10:00:00.000Z";
  const releasedAt = "2026-06-03T10:05:00.000Z";
  const oldOrderAt = "2026-06-03T10:02:00.000Z";
  const newOrderAt = "2026-06-03T10:08:00.000Z";
  const oldOrderAtMs = Date.parse(oldOrderAt);
  const newOrderAtMs = Date.parse(newOrderAt);

  const { baseUrl } = await startBackend(t, {
    stateOverrides(state) {
      state.posSettings.tables = state.posSettings.tables.map((table) =>
        table.id === "room_pedana_t05"
          ? {
              ...table,
              status: "no_orders",
              covers: 2,
              seatedAt: Date.parse(openedAt),
              totalDue: 8,
              pendingBills: [],
            }
          : table
      );
      state.auditEvents = [
        {
          id: "audit_session_opened",
          occurredAt: openedAt,
          action: "table.session_opened",
          entityType: "table",
          entityId: "room_pedana_t05",
          payload: {
            tableId: "room_pedana_t05",
            tableNumber: 5,
            roomId: "room_pedana",
          },
        },
        {
          id: "audit_table_released",
          occurredAt: releasedAt,
          action: "table.released",
          entityType: "table",
          entityId: "room_pedana_t05",
          payload: {
            tableId: "room_pedana_t05",
            tableNumber: 5,
            roomId: "room_pedana",
          },
        },
      ];
      state.integration.orders = [
        {
          id: "00010",
          tableId: "room_pedana_t05",
          tableNumber: 5,
          roomId: "room_pedana",
          title: "Comanda vecchia pagata",
          workflowStatus: "delivered",
          paymentStatus: "paid",
          total: 12,
          paidAmount: 12,
          dueAmount: 0,
          receivedAtMs: oldOrderAtMs,
          createdAt: oldOrderAt,
          updatedAt: releasedAt,
          items: [{ name: "Ichnusa", qty: 1, lineTotal: 12 }],
        },
        {
          id: "00011",
          tableId: "room_pedana_t05",
          tableNumber: 5,
          roomId: "room_pedana",
          title: "Comanda corrente",
          workflowStatus: "ready",
          paymentStatus: "unpaid",
          total: 8,
          paidAmount: 0,
          dueAmount: 8,
          receivedAtMs: newOrderAtMs,
          createdAt: newOrderAt,
          updatedAt: newOrderAt,
          items: [{ name: "Spritz", qty: 1, lineTotal: 8 }],
        },
      ];
    },
  });

  const currentResponse = await fetch(
    `${baseUrl}/api/integration/orders?includeDone=1&currentSessionOnly=1`
  );
  assert.equal(currentResponse.status, 200);
  const currentPayload = await currentResponse.json();
  assert.deepEqual(
    currentPayload.orders.map((order) => order.id),
    ["00011"]
  );
});

test("GET /api/integration/orders filtra per roomId quando richiesto", async (t) => {
  const createdAt = "2026-06-03T12:00:00.000Z";
  const createdAtMs = Date.parse(createdAt);

  const { baseUrl } = await startBackend(t, {
    stateOverrides(state) {
      state.integration.orders = [
        {
          id: "10001",
          tableId: "room_pedana_t05",
          tableNumber: 5,
          roomId: "room_pedana",
          title: "Pedana",
          workflowStatus: "ready",
          paymentStatus: "unpaid",
          total: 8,
          paidAmount: 0,
          dueAmount: 8,
          receivedAtMs: createdAtMs,
          createdAt,
          updatedAt: createdAt,
          items: [{ name: "Spritz", qty: 1, lineTotal: 8 }],
        },
        {
          id: "10002",
          tableId: "room_sala_t01",
          tableNumber: 1,
          roomId: "room_sala",
          title: "Sala",
          workflowStatus: "ready",
          paymentStatus: "unpaid",
          total: 10,
          paidAmount: 0,
          dueAmount: 10,
          receivedAtMs: createdAtMs + 1,
          createdAt,
          updatedAt: createdAt,
          items: [{ name: "Birra", qty: 1, lineTotal: 10 }],
        },
        {
          id: "10003",
          tableId: "legacy_t01",
          tableNumber: 1,
          title: "Legacy senza sala",
          workflowStatus: "ready",
          paymentStatus: "unpaid",
          total: 5,
          paidAmount: 0,
          dueAmount: 5,
          receivedAtMs: createdAtMs + 2,
          createdAt,
          updatedAt: createdAt,
          items: [{ name: "Acqua", qty: 1, lineTotal: 5 }],
        },
      ];
    },
  });

  const filteredResponse = await fetch(
    `${baseUrl}/api/integration/orders?includeDone=1&roomId=room_pedana`
  );
  assert.equal(filteredResponse.status, 200);
  const filteredPayload = await filteredResponse.json();
  assert.deepEqual(
    filteredPayload.orders.map((order) => order.id),
    ["10001", "10003"]
  );

  const unfilteredResponse = await fetch(`${baseUrl}/api/integration/orders?includeDone=1`);
  assert.equal(unfilteredResponse.status, 200);
  const unfilteredPayload = await unfilteredResponse.json();
  assert.deepEqual(
    unfilteredPayload.orders.map((order) => order.id),
    ["10001", "10002", "10003"]
  );
});
