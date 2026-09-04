import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHandheldSessionReport,
  collectHandheldCashSessions,
  findNextClosedHandheldSessionReport,
  formatHandheldSessionReportText,
  getHandheldSessionWindow,
  recordHandheldCashSessionClose,
  recordHandheldCashSessionOpen,
  resolveHandheldOperationalSessionDateKey,
  resolveHandheldSessionReportPrinterId,
} from "../modules/reports/handheld-session-report.js";

test("handheld session window usa la fascia 16:00 -> 02:00 del giorno dopo", () => {
  const window = getHandheldSessionWindow("2026-06-20");
  assert.equal(window.sessionDate, "2026-06-20");
  assert.equal(new Date(window.startAt).getHours(), 16);
  assert.equal(new Date(window.endAt).getHours(), 2);
  assert.equal(new Date(window.endAt).getDate(), new Date(window.startAt).getDate() + 1);
});

test("handheld operational session date prima delle 02:00 resta sul giorno precedente", () => {
  assert.equal(resolveHandheldOperationalSessionDateKey(new Date(2026, 5, 21, 1, 30)), "2026-06-20");
  assert.equal(resolveHandheldOperationalSessionDateKey(new Date(2026, 5, 21, 2, 1)), "2026-06-21");
});

test("handheld report conta i coperti una volta per sessione tavolo e riconta dopo liberazione", () => {
  const db = {
    users: [{ id: "u_giada", username: "giada", fullName: "Giada" }],
    sessions: [{ userId: "u_giada", username: "giada", clientApp: "mobile-frontend", deviceUuid: "dev_giada" }],
    posSettings: {
      rooms: [{ id: "room_gazebo", name: "Gazebo" }],
      tables: [{ id: "room_gazebo_t01", roomId: "room_gazebo", number: 1 }],
      mobileDevices: [{ deviceId: "dev_giada", deviceName: "Palmare Giada", fiscalEnabled: true }],
    },
    auditEvents: [
      { action: "table.session_opened", entityId: "room_gazebo_t01", occurredAt: "2026-06-20T14:05:00.000Z", payload: { tableId: "room_gazebo_t01" } },
      { action: "table.released", entityId: "room_gazebo_t01", occurredAt: "2026-06-20T17:00:00.000Z", payload: { tableId: "room_gazebo_t01" } },
      { action: "table.session_opened", entityId: "room_gazebo_t01", occurredAt: "2026-06-20T18:00:00.000Z", payload: { tableId: "room_gazebo_t01" } },
    ],
    integration: {
      orders: [
        { id: "001", source: "mobile-frontend", createdAt: "2026-06-20T14:10:00.000Z", tableId: "room_gazebo_t01", roomId: "room_gazebo", covers: 4, apericena: 1, total: 20, createdByUserId: "u_giada", createdByUsername: "giada", paymentStatus: "paid" },
        { id: "002", source: "mobile-frontend", createdAt: "2026-06-20T14:30:00.000Z", tableId: "room_gazebo_t01", roomId: "room_gazebo", covers: 4, apericena: 0, total: 10, createdByUserId: "u_giada", createdByUsername: "giada", paymentStatus: "paid" },
        { id: "003", source: "mobile-frontend", createdAt: "2026-06-20T18:10:00.000Z", tableId: "room_gazebo_t01", roomId: "room_gazebo", covers: 2, apericena: 1, total: 12, createdByUserId: "u_giada", createdByUsername: "giada", paymentStatus: "unpaid", dueAmount: 12 },
      ],
    },
    payments: [
      { id: "p1", createdAt: "2026-06-20T14:40:00.000Z", orderIds: ["001", "002"], amount: 30, methodId: "pay_card", methodLabel: "Carta", collectedByUserId: "u_giada", collectedByUsername: "giada", collectedByDeviceUuid: "dev_giada" },
    ],
  };

  const report = buildHandheldSessionReport(db, { date: "2026-06-20" });
  assert.equal(report.totals.orders, 3);
  assert.equal(report.totals.covers, 6);
  assert.equal(report.totals.apericena, 2);
  assert.equal(report.totals.pos, 30);
  assert.equal(report.totals.cash, 0);
  assert.equal(report.totals.unpaid, 12);
  assert.deepEqual(report.rooms.map((room) => `${room.roomName}:${room.covers}`), ["Gazebo:6"]);
});

test("handheld report limita ogni tavolo a 100 ma non il totale aggregato", () => {
  const db = {
    users: [{ id: "u_giada", username: "giada", fullName: "Giada" }],
    posSettings: {
      rooms: [{ id: "room_gazebo", name: "Gazebo" }],
      tables: [
        { id: "room_gazebo_t01", roomId: "room_gazebo", number: 1 },
        { id: "room_gazebo_t02", roomId: "room_gazebo", number: 2 },
      ],
    },
    auditEvents: [
      { action: "table.session_opened", entityId: "room_gazebo_t01", occurredAt: "2026-06-20T14:05:00.000Z", payload: { tableId: "room_gazebo_t01" } },
      { action: "table.session_opened", entityId: "room_gazebo_t02", occurredAt: "2026-06-20T14:06:00.000Z", payload: { tableId: "room_gazebo_t02" } },
    ],
    integration: {
      orders: [
        { id: "001", source: "mobile-frontend", createdAt: "2026-06-20T14:10:00.000Z", tableId: "room_gazebo_t01", roomId: "room_gazebo", covers: 250, createdByUserId: "u_giada", paymentStatus: "paid" },
        { id: "002", source: "mobile-frontend", createdAt: "2026-06-20T14:11:00.000Z", tableId: "room_gazebo_t02", roomId: "room_gazebo", covers: 175, createdByUserId: "u_giada", paymentStatus: "paid" },
      ],
    },
    payments: [],
  };

  const report = buildHandheldSessionReport(db, { date: "2026-06-20" });

  assert.equal(report.totals.covers, 200);
  assert.deepEqual(report.rooms.map((room) => `${room.roomName}:${room.covers}`), ["Gazebo:200"]);
});

test("handheld report separa POS, contanti e altri metodi", () => {
  const basePayment = {
    createdAt: "2026-06-20T17:00:00.000Z",
    collectedByUserId: "u_lorenzo",
    collectedByUsername: "lorenzo",
    collectedByDeviceUuid: "dev_lorenzo",
  };
  const db = {
    users: [{ id: "u_lorenzo", username: "lorenzo", fullName: "Lorenzo" }],
    sessions: [{ userId: "u_lorenzo", username: "lorenzo", clientApp: "mobile-frontend", deviceUuid: "dev_lorenzo" }],
    posSettings: { mobileDevices: [{ deviceId: "dev_lorenzo", fiscalEnabled: true }] },
    integration: { orders: [] },
    payments: [
      { ...basePayment, id: "pos", amount: 11, methodId: "pay_card", methodLabel: "POS" },
      { ...basePayment, id: "cash", amount: 7, methodId: "pay_cash", methodLabel: "Contanti" },
      { ...basePayment, id: "other", amount: 3, methodId: "smart", methodLabel: "SNG" },
    ],
  };
  const report = buildHandheldSessionReport(db, { date: "2026-06-20" });
  assert.equal(report.totals.paid, 21);
  assert.equal(report.totals.pos, 11);
  assert.equal(report.totals.cash, 7);
  assert.equal(report.totals.other, 3);
});

test("handheld report espone lordo, resi e netto per storni mobile", () => {
  const db = {
    users: [{ id: "u_lorenzo", username: "lorenzo", fullName: "Lorenzo" }],
    sessions: [{ userId: "u_lorenzo", username: "lorenzo", clientApp: "mobile-frontend", deviceUuid: "dev_lorenzo" }],
    posSettings: { mobileDevices: [{ deviceId: "dev_lorenzo", fiscalEnabled: true }] },
    integration: {
      orders: [],
      orderComps: [
        {
          id: "comp-cash-8",
          orderId: "ord-1",
          createdAt: "2026-06-20T17:20:00.000Z",
          createdByUserId: "u_lorenzo",
          createdByUsername: "lorenzo",
          createdByDeviceUuid: "dev_lorenzo",
          refundPlan: {
            allocations: [
              {
                paymentId: "cash-30",
                method: "CASH",
                action: "cash_refund",
                refundAmount: 8,
                voidAmount: 0,
              },
            ],
          },
        },
      ],
    },
    payments: [
      {
        id: "cash-30",
        createdAt: "2026-06-20T17:00:00.000Z",
        amount: 30,
        methodId: "pay_cash",
        methodLabel: "Contanti",
        orderIds: ["ord-1"],
        collectedByUserId: "u_lorenzo",
        collectedByUsername: "lorenzo",
        collectedByDeviceUuid: "dev_lorenzo",
      },
    ],
  };

  const report = buildHandheldSessionReport(db, { date: "2026-06-20" });
  assert.equal(report.settlementTotals.grossTotal, 30);
  assert.equal(report.settlementTotals.refundTotal, 8);
  assert.equal(report.settlementTotals.netTotal, 22);
  assert.equal(report.settlementTotals.cashNetTotal, 22);
  assert.match(formatHandheldSessionReportText(report), /Incassato netto/);
});

test("handheld report usa la finestra reale da caricamento fondo cassa a scarico anche oltre mezzanotte", () => {
  const db = {
    users: [{ id: "u_giada", username: "giada", fullName: "Giada" }],
    sessions: [{ userId: "u_giada", username: "giada", clientApp: "mobile-frontend", deviceUuid: "dev_giada" }],
    posSettings: { mobileDevices: [{ deviceId: "dev_giada", fiscalEnabled: true }] },
    handheldCashSessions: [
      {
        id: "hcs_giada",
        userId: "u_giada",
        username: "giada",
        deviceUuid: "dev_giada",
        cashFloat: 50,
        openedAt: "2026-06-21T15:00:00.000Z",
        closedAt: "2026-06-21T22:42:00.000Z",
      },
    ],
    integration: {
      orders: [
        { id: "before", source: "mobile-frontend", createdAt: "2026-06-21T14:59:59.000Z", total: 99, createdByUserId: "u_giada", paymentStatus: "paid" },
        { id: "inside", source: "mobile-frontend", createdAt: "2026-06-21T18:00:00.000Z", total: 12, covers: 2, createdByUserId: "u_giada", paymentStatus: "paid" },
        { id: "after", source: "mobile-frontend", createdAt: "2026-06-21T22:42:01.000Z", total: 77, createdByUserId: "u_giada", paymentStatus: "paid" },
      ],
    },
    payments: [
      { id: "outside-before", createdAt: "2026-06-21T14:59:59.000Z", amount: 99, methodId: "pay_card", collectedByUserId: "u_giada", collectedByUsername: "giada", collectedByDeviceUuid: "dev_giada" },
      { id: "inside-payment", createdAt: "2026-06-21T22:41:00.000Z", amount: 12, methodId: "pay_card", collectedByUserId: "u_giada", collectedByUsername: "giada", collectedByDeviceUuid: "dev_giada" },
      { id: "outside-after", createdAt: "2026-06-21T22:43:00.000Z", amount: 77, methodId: "pay_cash", collectedByUserId: "u_giada", collectedByUsername: "giada", collectedByDeviceUuid: "dev_giada" },
    ],
  };

  const report = buildHandheldSessionReport(db, { date: "2026-06-21" });
  assert.equal(report.window.source, "cash_sessions");
  assert.equal(report.window.startAt, "2026-06-21T15:00:00.000Z");
  assert.equal(report.window.endAt, "2026-06-21T22:42:00.000Z");
  assert.equal(report.window.allCashSessionsClosed, true);
  assert.equal(report.totals.orders, 1);
  assert.equal(report.totals.paid, 12);
  assert.equal(report.totals.pos, 12);
  assert.match(report.printKey, /^cash:2026-06-21:/);
});

test("handheld report automatico parte solo quando tutti i palmari con fondo cassa hanno fatto scarico", () => {
  const db = {
    handheldCashSessions: [
      {
        id: "hcs_giada",
        userId: "u_giada",
        username: "giada",
        deviceUuid: "dev_giada",
        openedAt: "2026-06-21T15:00:00.000Z",
        closedAt: "2026-06-21T22:40:00.000Z",
      },
      {
        id: "hcs_anna",
        userId: "u_anna",
        username: "anna",
        deviceUuid: "dev_anna",
        openedAt: "2026-06-21T15:10:00.000Z",
      },
    ],
  };

  assert.equal(findNextClosedHandheldSessionReport(db), null);

  recordHandheldCashSessionClose(
    db,
    { userId: "u_anna", username: "anna", deviceUuid: "dev_anna", completedAtMs: "2026-06-21T22:45:00.000Z" },
    { nowIso: () => "2026-06-21T22:45:01.000Z" },
  );
  const ready = findNextClosedHandheldSessionReport(db);
  assert.equal(ready.sessionDate, "2026-06-21");
  assert.equal(ready.sessions.length, 2);
  assert.equal(ready.window.endAt, "2026-06-21T22:45:00.000Z");

  assert.equal(findNextClosedHandheldSessionReport(db, { printed: { [ready.printKey]: { printedAt: "2026-06-21T22:46:00.000Z" } } }), null);
});

test("handheld cash session open e close sono idempotenti per utente e device", () => {
  const db = {};
  const opened = recordHandheldCashSessionOpen(
    db,
    { userId: "u_giada", username: "giada", deviceUuid: "dev_giada", cashFloat: 40, sessionStartedAt: "2026-06-21T15:00:00.000Z" },
    { nowIso: () => "2026-06-21T15:00:01.000Z" },
  );
  const reopened = recordHandheldCashSessionOpen(
    db,
    { userId: "u_giada", username: "giada", deviceUuid: "dev_giada", cashFloat: 45, sessionStartedAt: "2026-06-21T15:05:00.000Z" },
    { nowIso: () => "2026-06-21T15:05:01.000Z" },
  );
  assert.equal(opened.id, reopened.id);
  assert.equal(collectHandheldCashSessions(db).length, 1);
  assert.equal(collectHandheldCashSessions(db)[0].cashFloat, 45);

  const closed = recordHandheldCashSessionClose(
    db,
    { userId: "u_giada", username: "giada", deviceUuid: "dev_giada", completedAtMs: "2026-06-21T22:42:00.000Z", totals: { paid: 100 } },
    { nowIso: () => "2026-06-21T22:42:01.000Z" },
  );
  assert.equal(closed.status, "closed");
  assert.equal(closed.closedAt, "2026-06-21T22:42:00.000Z");
  assert.equal(closed.totals.paid, 100);
});

test("handheld report risolve solo la stampante preconti dell'attivita Bar", () => {
  const printerId = resolveHandheldSessionReportPrinterId({
    printers: [
      { id: "pizza", purpose: "generic", active: true },
      { id: "bar", purpose: "generic", active: true },
    ],
    activities: [
      { id: "activity_pizza_in_riva", name: "Pizza in Riva", precontoPrinterIds: ["pizza"] },
      { id: "activity_bar", name: "Bar", precontoPrinterIds: ["bar"] },
    ],
  });
  assert.equal(printerId, "bar");
});

test("handheld report testo stampa contiene totali principali", () => {
  const text = formatHandheldSessionReportText({
    generatedAt: "2026-06-20T17:10:00.000Z",
    window: getHandheldSessionWindow("2026-06-20"),
    totals: { paid: 10, pos: 8, cash: 2, other: 0, unpaid: 1, orders: 2, payments: 2, covers: 4, apericena: 1, averagePerOrder: 5, averagePerCover: 2.5 },
    rooms: [{ roomName: "Gazebo", covers: 4 }],
    users: [{ displayName: "Giada", ordersTaken: 2, coversManaged: 4, posTotal: 8, cashTotal: 2, otherTotal: 0, unpaidTotal: 1 }],
  });
  assert.match(text, /RIEPILOGO PALMARI/);
  assert.match(text, /POS/);
  assert.match(text, /Gazebo/);
  assert.match(text, /Giada/);
});
