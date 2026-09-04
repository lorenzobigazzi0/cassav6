import assert from "node:assert/strict";
import test from "node:test";

import { createOrderTicketRenderer } from "../printing/order-ticket-renderer.js";
import {
  buildPrintLabelLines,
  buildPrintTwoColumnLines,
  toPrintSafeUppercase,
  wrapPrintText,
} from "../printing/print-utils.js";

const renderer = createOrderTicketRenderer({
  PRIMARY_INTEGRATION_STATION: "BAR",
  buildCorrectionPrintAnnotations: () => ({
    addedByLineId: new Map(),
    changedByLineId: new Map(),
    removedLines: [
      {
        lineId: "removed-1",
        productNameSnapshot: "Vecchio",
        qty: 1,
        correctionStatus: "removed",
      },
    ],
  }),
  buildEscPosRasterStrikeMarker: (value) => `RASTER(${value})`,
  buildIntegrationOrderLineSnapshots: (order) =>
    new Map(order.items.map((entry) => [entry.lineId, entry])),
  buildPrintLabelLines,
  buildPrintLocationLabel: ({ tableLabel, roomLabel }) =>
    `${roomLabel} - ${tableLabel}`,
  buildPrintTwoColumnLines,
  cleanIntegrationOrderSupplementLabelForPrint: (value) => value,
  cleanIntegrationOrderVariantLabelForPrint: (value) => value,
  extractIntegrationPrintVariantLabel: (value) => String(value ?? "").trim(),
  formatIntegrationPrintDateTime: () => "01/08/26-12:00",
  formatIntegrationPrintDisplayName: (value) => String(value ?? "").trim(),
  formatIntegrationPrintOrderId: (value) => `#${value}`,
  formatIntegrationWaiterShortLabel: (value) => String(value ?? "").trim(),
  isIntegrationSupplementText: () => false,
  normalizeIntegrationStationName: (value) => String(value ?? "").trim(),
  rasterStrikePrintableColumns: () => 32,
  resolvePrintRoomLabel: (_settings, _roomId, fallback) => fallback,
  resolvePrintTableDisplayLabelFromOrder: (order) => order.tableLabel,
  sanitizeIntegrationOrder: (order) => order,
  sanitizePosPrintPreferences: () => ({
    order: {
      lineWidth: 48,
      showStation: true,
      showOrderId: true,
      showWaiter: true,
      showTime: true,
      showTable: true,
      showVariants: true,
      showLineNotes: true,
      showCommunications: true,
      showOrderNotes: true,
      extraBottomLines: ["FINE"],
    },
  }),
  styleEscPosPrintLines: (values) =>
    (Array.isArray(values) ? values : [values])
      .map((value) => String(value ?? "").trimEnd())
      .filter(Boolean)
      .map((value) => `STYLE(${value})`),
  toPrintSafeUppercase,
  wrapPrintText,
});

test("order ticket renderer preserva righe, correzioni, note e apericena", () => {
  const order = {
    id: "77",
    ownerStation: "BAR",
    roomName: "Sala",
    tableLabel: "T9",
    waiter: "Mario",
    receivedAtMs: 1_788_000_000_000,
    apericena: 2,
    communications: "Portare insieme",
    note: "Cliente allergico",
    items: [
      {
        lineId: "l1",
        productNameSnapshot: "Pizza",
        qty: 2,
        variants: "Grande",
        notes: "Senza sale",
      },
    ],
  };

  const output = renderer.buildIntegrationOrderPrintText(order);
  assert.match(output, /STYLE\(COMANDA\)/);
  assert.match(output, /STYLE\(2 PIZZA\)/);
  assert.match(output, /STYLE\(VARIANTE: GRANDE\)/);
  assert.match(output, /STYLE\(NOTE: SENZA SALE\)/);
  assert.match(output, /RASTER\(1 VECCHIO\)/);
  assert.match(output, /COMUNICAZIONI:/);
  assert.match(output, /PORTARE INSIEME/);
  assert.match(output, /MENU APERICENA: 2/);
  assert.match(output, /STYLE\(FINE\)/);
});
