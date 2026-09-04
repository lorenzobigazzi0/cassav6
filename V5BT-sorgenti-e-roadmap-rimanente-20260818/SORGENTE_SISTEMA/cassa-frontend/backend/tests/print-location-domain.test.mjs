import test from "node:test";
import assert from "node:assert/strict";
import { createPrintLocationHelpers } from "../printing/print-location.domain.js";

function titleCase(value) {
  return String(value ?? "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

const helpers = createPrintLocationHelpers({
  findPosRoomById: (settings, roomId) =>
    (Array.isArray(settings?.rooms) ? settings.rooms : []).find((room) => room.id === roomId) ?? null,
  formatIntegrationPrintDisplayName: titleCase,
  formatIntegrationPrintOrderId: (value) => `#${String(value ?? "").replace(/^0+/, "") || "-"}`,
  sanitizeIntegrationOrder: (order, fallbackId) => ({
    id: String(order?.id ?? fallbackId),
    ...order,
  }),
  sanitizeIntegrationTableLabel: (value) => String(value ?? "").trim().replace(/\s+/g, " "),
  toPrintSafeUppercase: (value) => String(value ?? "").trim().toLocaleUpperCase("it-IT"),
});

test("print location costruisce riferimento preconto da id numerico o fallback", () => {
  assert.equal(helpers.buildPrecontoReferenceLabel("000272"), "#272");
  assert.equal(helpers.buildPrecontoReferenceLabel("COMANDA-A", "BANCO"), "BANCO");
  assert.equal(helpers.buildPrecontoReferenceLabel("", "BANCO"), "BANCO");
});

test("print location combina tavolo e sala senza inventare parti mancanti", () => {
  assert.equal(helpers.buildPrecontoLocationLabel("4", "GAZEBO"), "TAV. 4 GAZEBO");
  assert.equal(helpers.buildPrecontoLocationLabel("4", ""), "TAV. 4");
  assert.equal(helpers.buildPrecontoLocationLabel("", "BAR"), "BAR");
});

test("print location risolve sala da settings o fallback room id", () => {
  const settings = {
    rooms: [{ id: "room_gazebo", name: "Gazebo esterno" }],
  };
  assert.equal(helpers.resolvePrintRoomLabel(settings, "room_gazebo"), "GAZEBO ESTERNO");
  assert.equal(helpers.resolvePrintRoomLabel(settings, "room_bar_2"), "ROOM BAR 2");
  assert.equal(helpers.resolvePrintRoomLabel(settings, "", "Bar 1"), "BAR 1");
});

test("print location ricava label tavolo da ordine con priorita al tavolo logico", () => {
  assert.equal(helpers.resolvePrintTableDisplayLabelFromOrder({ tableLabel: "  A 12 " }), "A 12");
  assert.equal(helpers.resolvePrintTableDisplayLabelFromOrder({ tableNumber: 7 }), "7");
  assert.equal(helpers.resolvePrintTableDisplayLabelFromOrder({ table: "8" }), "8");
  assert.equal(helpers.resolvePrintTableDisplayLabelFromOrder({}), "");
});

test("print location costruisce posizione da ordine e da tavolo", () => {
  const settings = {
    rooms: [{ id: "room_bar", name: "Bar 1" }],
  };
  assert.equal(
    helpers.buildIntegrationOrderLocationLabel({ id: "001", roomId: "room_bar", tableLabel: "T 4" }, settings),
    "TAV. T 4 BAR 1"
  );
  assert.equal(
    helpers.buildTableLocationLabel({ number: 5 }, "room_bar", settings),
    "TAV. 5 BAR 1"
  );
});
