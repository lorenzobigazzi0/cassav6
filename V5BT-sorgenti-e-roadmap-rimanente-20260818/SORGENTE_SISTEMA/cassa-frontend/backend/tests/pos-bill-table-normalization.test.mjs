import assert from "node:assert/strict";
import test from "node:test";

import { createPosBillTableNormalization } from "../modules/payments/pos-bill-table-normalization.js";

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;
const normalizeStringList = (value, maxLength = 12, itemMaxLength = 40) => [
  ...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => String(entry ?? "").trim().slice(0, itemMaxLength))
      .filter(Boolean),
  ),
].slice(0, maxLength);

const normalization = createPosBillTableNormalization({
  DEFAULT_VIRTUAL_WAITING_ROOM_ID: "room_waiting",
  DEFAULT_VIRTUAL_WAITING_ROOM_NAME: "Attesa",
  DEFAULT_VIRTUAL_WAITING_ROOM_TABLE_COUNT: 3,
  POS_TABLE_STATUSES: new Set(["free", "occupied", "payment_due"]),
  clampInt: (value, min, max, fallback = min) => {
    const parsed = Number(value);
    return Number.isFinite(parsed)
      ? Math.min(Math.max(Math.trunc(parsed), min), max)
      : fallback;
  },
  isTableWorkLockExpired: (lock) => lock?.expired === true,
  normalizeConfigId: (value, fallback = "config") => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return normalized || fallback;
  },
  normalizePosRoomId: (value) => String(value ?? "").trim().toLowerCase(),
  normalizeReservation: (value) => value ?? null,
  normalizeSeatedAtMs: (value) => value ?? null,
  normalizeStringList,
  normalizeTableCovers: (value) => Math.max(Math.trunc(Number(value) || 0), 0),
  nowIso: () => "2026-08-06T10:00:00.000Z",
  pad2: (value) => String(value).padStart(2, "0"),
  resolveConfiguredAreaMinimumTables: (area) =>
    Math.max(Math.trunc(Number(area?.minimumTables) || 0), 0),
  roundMoney,
  sanitizePaymentItem: (item) => {
    const qty = Math.max(Math.trunc(Number(item?.qty) || 0), 0);
    const lineTotal = roundMoney(Math.max(Number(item?.lineTotal) || 0, 0));
    return String(item?.name ?? "").trim() && qty > 0 && lineTotal > 0
      ? { ...item, name: String(item.name).trim(), qty, lineTotal }
      : null;
  },
  sanitizeTableWorkLock: (value) =>
    value && typeof value === "object" ? { ...value } : null,
});

test("POS table normalizza conto legacy, minimi e dedupe canonico", () => {
  const table = normalization.sanitizePosTable(
    {
      id: "table_7",
      number: 7,
      roomId: "ROOM_MAIN",
      status: "free",
      totalDue: 12.5,
      covers: 4,
      workLock: { id: "lock_1", expired: true },
    },
    7,
  );
  assert.equal(table.status, "payment_due");
  assert.equal(table.totalDue, 12.5);
  assert.equal(table.pendingBills.length, 1);
  assert.equal(table.pendingBills[0].id, "table_7_legacy");
  assert.equal(table.workLock, null);

  const seeded = normalization.ensureMinimumTablesForConfiguredAreas(
    [table],
    [{ id: "room_main", name: "Sala", minimumTables: 3 }],
  );
  assert.deepEqual(
    seeded.map((entry) => entry.number).sort((a, b) => a - b),
    [1, 2, 3, 7],
  );

  const deduped = normalization.canonicalizeAndDedupePosTables(
    [
      { id: "legacy", number: 1, type: "Sala", status: "free", totalDue: 0 },
      { id: "active", number: 1, roomId: "room_main", status: "occupied", totalDue: 5 },
    ],
    [{ id: "room_main", name: "Sala" }],
  );
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].id, "active");

  const waiting = normalization.ensureDefaultVirtualWaitingRoomArea([]);
  assert.deepEqual(waiting[0], {
    id: "room_waiting",
    name: "Attesa",
    minimumTables: 3,
    notes: "Sala virtuale di appoggio prima della sala reale finale.",
    menuIds: [],
    priceListIds: [],
    waiterUserIds: [],
    printerIds: [],
    menuSchedules: [],
    priceListSchedules: [],
    cashPoints: [],
    workstations: [],
  });
});

test("split importo e selezione righe conservano totali e unita articolo", () => {
  const bills = [
    {
      id: "bill_1",
      createdAt: "2026-08-06T09:00:00.000Z",
      subtotal: 30,
      lines: [
        {
          name: "Pizza",
          qty: 2,
          unitPrice: 10,
          lineTotal: 20,
          articleUnitIds: ["pizza_1", "pizza_2"],
        },
        {
          name: "Bibita",
          qty: 2,
          unitPrice: 5,
          lineTotal: 10,
          articleUnitIds: ["drink_1", "drink_2"],
        },
      ],
    },
  ];
  const before = structuredClone(bills);

  const amountSplit = normalization.applyAmountPaymentToPosBills(
    bills,
    12,
    "amount",
  );
  assert.equal(amountSplit.amount, 12);
  assert.equal(amountSplit.remainingBills[0].subtotal, 18);
  assert.equal(amountSplit.remainingBills[0].lines[0].name, "Residuo importo libero");

  const lineSplit = normalization.applyLineSelectionsToPosBills(bills, [
    { billId: "bill_1", lineIndex: 0, qty: 1 },
    { billId: "bill_1", lineIndex: 1, qty: 2 },
  ]);
  assert.equal(lineSplit.amount, 20);
  assert.equal(lineSplit.remainingBills[0].subtotal, 10);
  assert.equal(lineSplit.remainingBills[0].lines[0].qty, 1);
  assert.deepEqual(lineSplit.remainingBills[0].lines[0].articleUnitIds, ["pizza_2"]);
  assert.deepEqual(lineSplit.paidItems[0].articleUnitIds, ["pizza_1"]);
  assert.deepEqual(bills, before);
});
