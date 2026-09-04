import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  closeRelationalConnection,
  assertRelationalEquivalence,
  compareDomain,
  openRelationalConnection,
  RELATIONAL_EQUIVALENCE_DOMAINS,
  runRelationalMigrations,
  syncAuditEventsFromAppState,
  syncMenuSettingsFromAppState,
  syncOrdersFromAppState,
  syncPaymentsFromAppState,
  syncReservationsFromAppState,
  syncSaleSessionsFromAppState,
  syncSessionsFromAppState,
  syncTablesBillsFromAppState,
  syncUsersFromAppState,
} from "../db/relational/index.js";
import { buildTestState, createTempRunDir } from "./helpers/test-server.mjs";

function nowIso() {
  return "2026-05-13T18:00:00.000Z";
}

function relationalConfig(dbPath) {
  return {
    enabled: true,
    mode: "shadow",
    dbPath,
  };
}

async function openMigratedDb(dbPath) {
  const db = await openRelationalConnection(relationalConfig(dbPath));
  await runRelationalMigrations(db, { nowIso });
  return db;
}

function buildEquivalenceState() {
  const state = buildTestState();
  state.meta.lastWriteAt = "2026-05-13T18:10:00.000Z";

  state.users = state.users.map((user) => ({ ...user }));
  state.users[0] = {
    ...state.users[0],
    active: true,
    defaultRoomId: "room_pedana",
    lastSelectedRoomId: "room_sala",
    lastSelectedRoomName: "Sala",
    lastSelectedRoomAt: "2026-05-13T17:59:00.000Z",
    lastSelectedRoomDeviceUuid: "device-admin",
    allowedPaymentMethodIds: ["pay_cash", "pay_card"],
    equivalenceExtraField: "user-raw-json",
  };
  state.users[1] = {
    ...state.users[1],
    active: false,
    paymentMethodIds: ["pay_cash"],
  };

  state.sessions = [
    {
      id: "sess_active",
      userId: "u_admin",
      tokenHash: "hash_active",
      deviceUuid: "device-active",
      clientApp: "cassa-frontend",
      createdAt: "2026-05-13T12:00:00.000Z",
      lastSeenAt: "2026-05-13T12:01:00.000Z",
      expiresAt: "2026-05-14T12:00:00.000Z",
      roomId: "room_pedana",
      extraNote: "sessione attiva",
    },
    {
      id: "sess_revoked",
      userId: "u_cashier",
      tokenHash: "hash_revoked",
      deviceUuid: "device-revoked",
      clientApp: "mobile-frontend",
      createdAt: "2026-05-13T11:00:00.000Z",
      lastSeenAt: "2026-05-13T11:05:00.000Z",
      expiresAt: "2026-05-14T11:00:00.000Z",
      revokedAt: "2026-05-13T11:06:00.000Z",
    },
  ];

  state.auditEvents = [
    {
      id: "evt_order_created",
      occurredAt: "2026-05-13T10:01:00.000Z",
      actorUserId: "u_admin",
      actorRole: "ADMIN",
      roomId: "room_pedana",
      deviceId: "device-a",
      action: "order.created",
      entityType: "order",
      entityId: "ord_1",
      correlationId: "corr-a",
      payload: { total: 12, tags: ["shadow", "equivalence"] },
      before: { due: 0 },
      after: { due: 12 },
    },
    {
      id: "evt_deleted",
      occurredAt: "2026-05-13T10:02:00.000Z",
      actorUserId: "u_admin",
      actorRole: "ADMIN",
      action: "security.admin_delete",
      entityType: "audit_event",
      entityId: "evt_old",
      payload: { reason: "cleanup" },
      before: null,
      after: { deleted: true },
      deletedAt: "2026-05-13T10:03:00.000Z",
      deletedBy: "u_admin",
      deleteReason: "cleanup test",
    },
  ];

  state.saleSessions = [
    {
      id: "sale_open",
      templateId: "shift_day",
      templateName: "Diurna",
      businessDate: "2026-05-13",
      startedAt: "2026-05-13T08:00:00.000Z",
      startedByUserId: "u_admin",
      extraNote: "apertura test",
    },
    {
      id: "sale_closed",
      templateId: "shift_night",
      templateName: "Notturna",
      businessDate: "2026-05-12",
      startedAt: "2026-05-12T20:00:00.000Z",
      startedByUserId: "u_cashier",
      endedAt: "2026-05-13T04:00:00.000Z",
      endedByUserId: "u_manager",
      closingTotalCents: 12345,
    },
  ];
  state.solarClosures = [
    {
      id: "solar_20260512",
      key: "2026-05-12",
      transmittedAt: "2026-05-13T04:05:00.000Z",
      closedAt: "2026-05-13T04:05:00.000Z",
      printerStatus: "accepted",
      printerResponseCode: "RT_OK",
      totalSaleSessions: 1,
      saleSessionIds: ["sale_closed"],
    },
  ];

  state.menuItems = [
    {
      id: "menu_test_caffe",
      name: "Caffe Test",
      description: "Espresso di prova",
      price: 1.3,
      category: "Caffetteria",
      enabled: true,
      available: true,
      stations: ["CAFFETTERIA"],
      variants: [{ id: "large", name: "Grande", priceDelta: 0.5 }],
      extraItemField: "preserved",
    },
    {
      id: "menu_test_gin",
      name: "Gin Test",
      price: 12,
      category: "Drink Premium",
      enabled: true,
      available: true,
      stationId: "COCKTAIL",
      stations: ["COCKTAIL"],
      variantRequired: true,
      variants: [{ id: "gin_premium", name: "Premium", priceDelta: 2.5 }],
    },
    {
      id: "menu_test_hidden",
      name: "Bibita Nascosta",
      price: 4,
      category: "Bibite",
      enabled: false,
      available: false,
    },
  ];

  state.posSettings = {
    ...state.posSettings,
    paymentMethods: [
      { id: "pay_cash", label: "Contanti", enabled: true, isFiscal: true },
      { id: "pay_card", label: "Carta", enabled: false, isFiscal: true },
    ],
    rooms: [
      { id: "room_pedana", roomId: "room_pedana", name: "Pedana", enabled: true, extraRoomField: "preserved" },
      { id: "room_sala", roomId: "room_sala", name: "Sala", enabled: false },
    ],
    areas: [],
    tables: [
      {
        id: "room_pedana_t05",
        roomId: "room_pedana",
        number: 5,
        name: "Tavolo 5",
        type: "Pedana",
        status: "free",
        covers: 0,
        totalDue: 0,
        pendingBills: [],
        enabled: true,
        x: 10,
        y: 20,
        shape: "square",
        extraTableField: "free-preserved",
      },
      {
        id: "room_sala_t01",
        roomId: "room_sala",
        number: 1,
        name: "Sala 1",
        type: "Sala",
        status: "payment_due",
        guestName: "Cliente Test",
        covers: 3,
        totalDue: 8,
        totalPaid: 4,
        note: "Allergia frutta secca",
        updatedAt: "2026-05-13T17:05:00.000Z",
        enabled: false,
        pendingBills: [
          {
            id: "bill_room_sala_1",
            status: "partial",
            subtotal: 10,
            paidAmount: 4,
            dueAmount: 6,
            createdAt: "2026-05-13T17:00:00.000Z",
            updatedAt: "2026-05-13T17:04:00.000Z",
            orderId: "00042",
            orderIds: ["00042"],
            lines: [
              { name: "Americano", qty: 1, unitPrice: 8, lineTotal: 8 },
              { name: "Caffe", qty: 2, unitPrice: 1, lineTotal: 2 },
            ],
            extraBillField: "bill-preserved",
          },
        ],
      },
      {
        id: "room_pedana_t06",
        roomId: "room_pedana",
        number: 6,
        type: "Pedana",
        status: "free",
        covers: 0,
        totalDue: 0,
        pendingBills: [],
        workLock: {
          tableId: "room_pedana_t06",
          userId: "u_cashier",
          username: "cashier",
          deviceUuid: "lock-device-1",
          sessionId: "sess_lock_1",
          purpose: "edit",
          acquiredAt: "2026-05-13T17:01:00.000Z",
          heartbeatAt: "2026-05-13T17:02:00.000Z",
          expiresAt: "2026-05-13T17:07:00.000Z",
        },
      },
    ],
  };

  state.integration.orders = [
    {
      id: "00042",
      tableId: "room_pedana_t05",
      tableNumber: 5,
      tableLabel: "Tavolo 5",
      roomId: "room_pedana",
      workflowStatus: "prep",
      paymentStatus: "unpaid",
      source: "mobile-frontend",
      total: 17.1,
      station: "BAR PRINCIPALE",
      assignedStationId: "BAR PRINCIPALE",
      createdByUserId: "u_cashier",
      createdByUsername: "cashier",
      createdAt: "2026-05-13T16:00:00.000Z",
      updatedAt: "2026-05-13T16:05:00.000Z",
      extraOrderField: "preserved",
      items: [
        {
          id: "oi_1",
          lineId: "line_caffe",
          productId: "menu_test_caffe",
          productNameSnapshot: "Caffe Test",
          name: "Caffe Test",
          qty: 2,
          doneQty: 1,
          unitPriceApplied: 1.3,
          listPriceAtTime: 1.3,
          lineTotal: 2.6,
          routeStations: ["BAR PRINCIPALE"],
        },
        {
          id: "oi_2",
          lineId: "line_gin",
          productId: "menu_test_gin",
          productNameSnapshot: "Gin Test",
          name: "Gin Test",
          qty: 1,
          deliveredQuantity: 1,
          unitPriceApplied: 14.5,
          listPriceAtTime: 12,
          lineTotal: 14.5,
          selectedVariantId: "gin_premium",
          selectedVariantName: "Premium",
          selectedVariantPriceDelta: 2.5,
          supplements: [{ id: "sup_lime", name: "Lime extra", priceDelta: 0.5 }],
          routeStations: ["COCKTAIL"],
        },
      ],
      lineRoutes: [
        { id: "route_1", lineId: "line_caffe", stationId: "BAR PRINCIPALE" },
        { id: "route_2", lineId: "line_gin", stationId: "COCKTAIL" },
      ],
      events: [
        {
          id: "order_evt_1",
          type: "status_changed",
          occurredAt: "2026-05-13T16:03:00.000Z",
          actorUserId: "u_cashier",
          payload: { from: "waiting", to: "prep" },
          extraEventField: "preserved",
        },
      ],
    },
  ];

  state.posReservationStates = [
    {
      key: "room_pedana:2026-05-13",
      roomId: "room_pedana",
      serviceDate: "2026-05-13",
      version: 3,
      reservations: [
        {
          id: "res_equiv_1",
          roomId: "room_pedana",
          serviceDate: "2026-05-13",
          reservationAt: 1778689800000,
          customerName: "Cliente Prenotato",
          customerPhone: "+3900000001",
          covers: 4,
          intolerances: "glutine",
          note: "Compleanno",
          assignedTableId: "room_pedana_t05",
          assignedTableIds: ["room_pedana_t05", "room_pedana_t06"],
          createdAt: 1778686200000,
          updatedAt: 1778686500000,
          extraReservationField: "preserved",
        },
        {
          id: "res_equiv_2",
          roomId: "room_pedana",
          serviceDate: "2026-05-13",
          reservationAt: 1778693400000,
          customerName: "Cliente Arrivato",
          covers: 2,
          status: "arrived",
          assignedTableIds: ["room_pedana_t06"],
          createdAt: 1778687000000,
          updatedAt: 1778690000000,
          arrivedAt: 1778690100000,
        },
      ],
    },
  ];
  state.posReservationLocks = [
    {
      reservationId: "res_equiv_1",
      lockId: "res_lock_equiv_1",
      userId: "u_cashier",
      deviceUuid: "device-reservation",
      expiresAt: 1778697000000,
    },
  ];
  state.posRoomChangeRequests = [
    {
      requestId: "room_req_equiv_1",
      userId: "u_cashier",
      sessionId: "sess_active",
      deviceUuid: "device-active",
      targetRoomId: "room_sala",
      targetRoomName: "Sala",
      createdAt: 1778686000000,
    },
  ];
  state.posTableRoomMoveRequests = [
    {
      requestId: "table_room_req_equiv_1",
      requesterUserId: "u_cashier",
      requesterUsername: "cashier",
      requesterFullName: "Cassiere Test",
      requesterDeviceUuid: "device-active",
      fromRoomId: "room_pedana",
      fromRoomName: "Pedana",
      targetRoomId: "room_sala",
      targetRoomName: "Sala",
      fromTableId: "room_pedana_t05",
      fromTableLabel: "Tavolo 5",
      targetTableIds: ["room_sala_t01"],
      targetTableLabels: ["Sala 1"],
      sourceLeafCount: 1,
      targetTableCount: 1,
      adjustCoversDelta: 0,
      status: "pending",
      createdAt: 1778686000000,
      expiresAt: 1778686600000,
    },
  ];

  state.paymentContainers = [
    {
      id: "pay_container_1",
      tableId: "room_pedana_t05",
      tableNumber: 5,
      tableLabel: "Tavolo 5",
      orderId: "00042",
      orderIds: ["00042"],
      billId: "bill_room_sala_1",
      billIds: ["bill_room_sala_1"],
      roomId: "room_pedana",
      paymentMethod: "pay_cash",
      amount: 12.34,
      status: "COMPLETED",
      splitType: "SINGLE",
      idempotencyKey: "idem-container-1",
      clientPaymentId: "client-pay-1",
      fiscalDocNo: "fiscal_1",
      fiscalIssuedAt: "2026-05-13T14:04:00.000Z",
      createdAt: "2026-05-13T14:00:00.000Z",
      updatedAt: "2026-05-13T14:04:00.000Z",
      extraContainerField: "preserved",
    },
  ];
  state.paymentParts = [
    {
      id: "part_1",
      paymentId: "pay_container_1",
      partNo: 1,
      amountDue: 12.34,
      status: "PAID",
      extraPartField: "preserved",
    },
  ];
  state.paymentTransactions = [
    {
      id: "tx_1",
      partId: "part_1",
      createdAt: "2026-05-13T14:01:00.000Z",
      method: "CASH",
      amountPaid: 12.34,
      cashGiven: 20,
      changeGiven: 7.66,
      extraTransactionField: "preserved",
    },
  ];
  state.paymentProviderTransactions = [
    {
      transactionId: "ptx_1",
      clientPaymentId: "client-pay-1",
      idempotencyKey: "idem-provider-1",
      status: "settled",
      amount: 12.34,
      currency: "EUR",
      paymentMethodId: "pay_cash",
      providerType: "cash",
      providerPayload: { drawer: "A" },
      settlementResponse: {
        paymentId: "pay_container_1",
        receiptId: "fiscal_1",
      },
      phase: "settled",
      createdAt: "2026-05-13T14:00:30.000Z",
      updatedAt: "2026-05-13T14:04:30.000Z",
      completedAt: "2026-05-13T14:04:30.000Z",
      extraProviderField: "preserved",
    },
  ];
  state.payments = [
    {
      id: "pay_container_1",
      tableId: "room_pedana_t05",
      roomId: "room_pedana",
      orderId: "00042",
      orderIds: ["00042"],
      billId: "bill_room_sala_1",
      billIds: ["bill_room_sala_1"],
      amount: 12.34,
      methodId: "pay_cash",
      methodLabel: "Contanti",
      fiscal: true,
      source: "table_payment",
      createdAt: "2026-05-13T14:02:00.000Z",
      idempotencyKey: "idem-payment-1",
      clientPaymentId: "client-pay-1",
      receiptId: "fiscal_1",
      paymentContainerId: "pay_container_1",
      paymentPartId: "part_1",
      paymentTxId: "tx_1",
    },
  ];
  state.fiscalReceipts = [
    {
      id: "fiscal_1",
      paymentId: "pay_container_1",
      command: "print_receipt",
      status: "ok",
      responseCode: "RT_OK",
      responseMessage: "Operazione completata.",
      fiscalStatus: "ISSUED",
      fiscalProvider: "mock",
      fiscalProviderRef: "RT-2026-0001",
      createdAt: "2026-05-13T14:03:00.000Z",
      extraReceiptField: "preserved",
    },
  ];

  return state;
}

function syncAllDomains(db, state) {
  syncAuditEventsFromAppState(db, state, { nowIso });
  syncUsersFromAppState(db, state, { nowIso });
  syncSessionsFromAppState(db, state, { nowIso });
  syncSaleSessionsFromAppState(db, state, { nowIso });
  syncPaymentsFromAppState(db, state, { nowIso });
  syncMenuSettingsFromAppState(db, state, { nowIso });
  syncOrdersFromAppState(db, state, { nowIso });
  syncTablesBillsFromAppState(db, state, { nowIso });
  syncReservationsFromAppState(db, state, { nowIso });
}

async function withSyncedFixture(callback) {
  const runDir = await createTempRunDir("rel-equivalence");
  const dbPath = path.join(runDir, "relational.sqlite");
  const db = await openMigratedDb(dbPath);
  const state = buildEquivalenceState();
  try {
    syncAllDomains(db, state);
    return await callback({ db, state });
  } finally {
    closeRelationalConnection(db);
  }
}

for (const domain of RELATIONAL_EQUIVALENCE_DOMAINS) {
  test(`${domain} checksum app-state == relazionale`, async (t) => {
    await withSyncedFixture(({ db, state }) => {
      const comparison = compareDomain(state, db, domain);
      if (comparison.skipped) {
        t.skip(comparison.reason);
        return;
      }
      assert.equal(comparison.appState.rowCount, comparison.relational.rowCount);
      assert.equal(comparison.appState.checksum, comparison.relational.checksum);
      assert.equal(comparison.matches, true);
    });
  });
}

test("dominio non implementato viene skipped esplicitamente", async () => {
  await withSyncedFixture(({ db, state }) => {
    const comparison = compareDomain(state, db, "notImplementedYet");
    assert.equal(comparison.skipped, true);
    assert.match(comparison.reason, /non implementato/i);
  });
});

test("modifica intenzionale di una riga relazionale produce mismatch", async () => {
  await withSyncedFixture(({ db, state }) => {
    const before = compareDomain(state, db, "auditEvents");
    assert.equal(before.matches, true);

    db.prepare("UPDATE audit_events SET action = ? WHERE id = ?").run("tampered.action", "evt_order_created");

    const after = compareDomain(state, db, "auditEvents");
    assert.equal(after.appState.rowCount, after.relational.rowCount);
    assert.notEqual(after.appState.checksum, after.relational.checksum);
    assert.equal(after.matches, false);
  });
});

test("assertRelationalEquivalence blocca orders non equivalente", async () => {
  await withSyncedFixture(({ db, state }) => {
    const before = assertRelationalEquivalence(state, db, "orders");
    assert.equal(before.orders.matches, true);

    db.prepare("UPDATE orders SET status = ? WHERE id = ?").run("tampered", "00042");

    assert.throws(
      () => assertRelationalEquivalence(state, db, ["orders"]),
      /Equivalenza relazionale shadow fallita per orders/
    );
  });
});
