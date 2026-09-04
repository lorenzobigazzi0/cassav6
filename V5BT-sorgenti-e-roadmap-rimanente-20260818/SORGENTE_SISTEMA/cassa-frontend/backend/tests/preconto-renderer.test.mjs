import assert from "node:assert/strict";
import test from "node:test";

import { createPrecontoRenderer } from "../printing/preconto-renderer.js";
import {
  buildPrintTwoColumnLines,
  centerPrintText,
  formatPrintAmountLine,
  formatPrintMoney,
  makePrintSeparator,
  padPrintRight,
  wrapPrintText,
} from "../printing/print-utils.js";

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;
const getSupplements = (entry) =>
  (Array.isArray(entry?.supplements) ? entry.supplements : []).map((value) =>
    typeof value === "string" ? { label: value, unitValue: 0 } : value,
  );

const renderer = createPrecontoRenderer({
  APERICENA_STANDARD_TARGET_PRICE: 12,
  DEFAULT_POS_SETTINGS: { printPreferences: { preconto: { lineWidth: 48 } } },
  buildIntegrationOrderLineSnapshots: (order) =>
    new Map(
      (Array.isArray(order?.items) ? order.items : []).map((entry, index) => [
        entry.lineId || `line-${index + 1}`,
        entry,
      ]),
    ),
  buildIntegrationPrecontoBrandingFooter: () => ["FOOTER"],
  buildIntegrationPrecontoBrandingHeader: () => ["VENUE"],
  buildIntegrationPrecontoColumnLayout: (width) => ({
    width,
    qtyWidth: 3,
    nameWidth: Math.max(12, width - 20),
    unitWidth: 7,
    subtotalWidth: 7,
  }),
  buildIntegrationPrecontoItemLines: (entry) => [
    `${entry.qty} ${entry.name} ${formatPrintMoney(entry.totalValue)}`,
  ],
  buildPrecontoLocationLabel: (table, room) => `${room} - ${table}`,
  buildPrecontoReferenceLabel: (id) => `#${id}`,
  buildPrintTwoColumnLines,
  centerPrintText,
  extractIntegrationPrintVariantLabel: (value) => String(value ?? "").trim(),
  formatIntegrationPrintDateTime: () => "01/08/26-12:00",
  formatPrintAmountLine,
  formatPrintMoney,
  getPrecontoEntrySupplementEntries: getSupplements,
  isPrecontoApericenaLabel: (value) => /apericena/i.test(String(value ?? "")),
  makePrintSeparator,
  padPrintRight,
  resolvePrecontoEntryBaseUnitValue: (entry) =>
    roundMoney(Number(entry?.unitValue) || 0),
  resolvePrecontoEntryDisplayTotalValue: (entry) =>
    roundMoney(Number(entry?.totalValue) || 0),
  resolvePrintRoomLabel: (_settings, _roomId, fallback) => fallback || "BANCO",
  resolvePrintTableDisplayLabelFromOrder: (order) => order?.tableLabel || "BANCO",
  roundMoney,
  sanitizeIntegrationOrder: (order) => ({ ...order }),
  sanitizePosPrintPreferences: (value) => ({
    ...(value && typeof value === "object" ? value : {}),
    branding: {},
    preconto: {
      lineWidth: Number(value?.preconto?.lineWidth) || 48,
      showDocumentLabel: true,
    },
  }),
  styleEscPosPrintLine: (value) => `STYLE(${value})`,
  wrapPrintText,
});

const order = {
  id: "42",
  tableLabel: "T12",
  roomName: "Sala",
  total: 10,
  apericena: 1,
  items: [
    {
      lineId: "l1",
      productNameSnapshot: "Pizza",
      qty: 2,
      unitPriceApplied: 5,
      listPriceAtTime: 5,
      lineTotal: 10,
      variants: "Grande",
      notes: "Senza sale",
    },
  ],
};

test("preconto renderer costruisce modello e voce apericena senza mutare ordine", () => {
  const before = structuredClone(order);
  const model = renderer.buildIntegrationPrecontoModel(order);

  assert.deepEqual(order, before);
  assert.equal(model.referenceLabel, "#42");
  assert.equal(model.locationLabel, "Sala - T12");
  assert.equal(model.groups[0].lines.length, 2);
  assert.equal(model.groups[0].lines[0].totalValue, 10);
  assert.equal(model.groups[0].lines[1].name, "Menu Apericena");
  assert.equal(model.total, 22);
});

test("preconto renderer mantiene profili standard/cash e riepilogo pagamenti", () => {
  const standard = renderer.buildIntegrationPrecontoPrintTextWithOptions(
    order,
    { preconto: { lineWidth: 48 } },
    null,
    { paymentSummary: { paidAmount: 5, dueAmount: 17 } },
  );
  const cash = renderer.buildIntegrationPrecontoPrintTextWithOptions(
    order,
    { preconto: { lineWidth: 48 } },
    null,
    { profile: "cash", paymentSummary: { paidAmount: 5, dueAmount: 17 } },
  );

  assert.match(standard, /VENUE/);
  assert.match(standard, /PRECONTO/);
  assert.match(standard, /GIA' PAGATO/);
  assert.match(standard, /17,00 EUR/);
  assert.match(standard, /FOOTER/);
  assert.match(cash, /STYLE\(PRECONTO\)/);
  assert.match(cash, /STYLE\(GIA' PAGATO/);
  assert.match(cash, /Richiedere lo scontrino fiscale alla cassa/);
});
