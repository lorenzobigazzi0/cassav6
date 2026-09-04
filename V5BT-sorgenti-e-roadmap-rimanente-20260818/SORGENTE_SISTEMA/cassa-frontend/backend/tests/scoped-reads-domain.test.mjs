import assert from "node:assert/strict";
import test from "node:test";
import {
  findScopedOpenOrderForTable,
  findScopedPrintJob,
  findScopedTable,
  listScopedNotifications,
  listScopedRoomTables,
  resolveScopedReadSourceMeta,
} from "../modules/scoped-reads/index.js";

test("scoped reads filtra tavolo e tavoli sala da layout gia normalizzato", () => {
  const layout = {
    tables: [
      { id: "table_1", roomId: "room_bar", number: 1 },
      { id: "table_2", roomId: "room_bar", number: 2 },
      { id: "table_3", roomId: "room_deck", number: 3 },
    ],
  };

  assert.deepEqual(findScopedTable(layout, "table_2"), {
    id: "table_2",
    roomId: "room_bar",
    number: 2,
  });
  assert.deepEqual(
    listScopedRoomTables(layout, "room_bar").map((table) => table.id),
    ["table_1", "table_2"],
  );
});

test("scoped reads open-order restituisce solo comande aperte del tavolo", () => {
  const orders = [
    {
      id: "00001",
      tableId: "table_1",
      workflowStatus: "delivered",
      paymentStatus: "paid",
      dueAmount: 0,
      receivedAtMs: 10,
    },
    {
      id: "00002",
      tableId: "table_1",
      workflowStatus: "waiting",
      paymentStatus: "unpaid",
      dueAmount: 12,
      receivedAtMs: 20,
    },
    {
      id: "00003",
      tableId: "table_2",
      workflowStatus: "waiting",
      paymentStatus: "unpaid",
      dueAmount: 8,
      receivedAtMs: 30,
    },
  ];

  assert.equal(findScopedOpenOrderForTable(orders, "table_1")?.id, "00002");
  assert.equal(findScopedOpenOrderForTable(orders, "table_404"), null);
});

test("scoped reads filtra notifiche per target senza marcarle consegnate", () => {
  const notifications = [
    {
      id: "n1",
      type: "bell",
      title: "Chiamata",
      description: "Sala",
      createdAt: "2026-07-07T10:00:00.000Z",
      ackedBy: [],
      meta: { targetUserId: "u_1" },
    },
    {
      id: "n2",
      type: "bell",
      title: "Altro",
      description: "Sala",
      createdAt: "2026-07-07T10:01:00.000Z",
      ackedBy: ["mobile-frontend"],
      meta: { targetUserId: "u_1" },
    },
  ];

  const items = listScopedNotifications(
    notifications,
    { userId: "u_1", consumer: "mobile-frontend", ackConsumer: "mobile-frontend" },
    {
      matchesTarget: (notification, requester) =>
        notification.meta?.targetUserId === requester.userId,
      sanitizeNotification: (notification) => notification,
    },
  );

  assert.deepEqual(items.map((item) => item.id), ["n1"]);
  assert.deepEqual(notifications[0].ackedBy, []);
});

test("scoped reads trova print job per id e segnala fallback meta", () => {
  assert.equal(findScopedPrintJob([{ id: "print_1" }], "print_1")?.id, "print_1");
  assert.deepEqual(resolveScopedReadSourceMeta("scoped"), {
    scopedRead: true,
    source: "scoped",
    fullStateFallbackUsed: false,
    redisCacheHit: false,
  });
  assert.deepEqual(resolveScopedReadSourceMeta("redis"), {
    scopedRead: true,
    source: "redis",
    fullStateFallbackUsed: false,
    redisCacheHit: true,
  });
  assert.deepEqual(resolveScopedReadSourceMeta("legacy"), {
    scopedRead: false,
    source: "legacy",
    fullStateFallbackUsed: true,
    redisCacheHit: false,
  });
});
