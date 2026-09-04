import assert from "node:assert/strict";
import test from "node:test";

import { createIntegrationOrderPrintLabelHelpers } from "../modules/orders/order-print-labels.js";

const helpers = createIntegrationOrderPrintLabelHelpers({
  normalizePrecontoInlineSupplementLabel: (value) =>
    String(value ?? "")
      .replace(/^variante\s*:?/i, "")
      .trim(),
  stripPrecontoSupplementUnitSuffix: (value) =>
    String(value ?? "")
      .replace(/\s*\+\s*\d[\d.,]*\s*(?:eur|euro|\u20ac)?\s*$/i, "")
      .trim(),
});

test("extractIntegrationPrintVariantLabel normalizza varianti stringa, array e oggetto", () => {
  assert.equal(helpers.extractIntegrationPrintVariantLabel(" Premium "), "Premium");
  assert.equal(helpers.extractIntegrationPrintVariantLabel([" Gin ", "", "Tonic"]), "Gin / Tonic");
  assert.equal(
    helpers.extractIntegrationPrintVariantLabel({
      label: "Hendrick's",
      tonic: "Indian",
      duplicate: "Indian",
      empty: "",
    }),
    "Hendrick's / Indian"
  );
});

test("extractIntegrationPrintVariantLabel applica fallback sicuri", () => {
  assert.equal(helpers.extractIntegrationPrintVariantLabel(null), "");
  assert.equal(helpers.extractIntegrationPrintVariantLabel(42), "");
  assert.equal(helpers.extractIntegrationPrintVariantLabel({ label: "", name: "", value: "" }), "");
});

test("extractIntegrationPrintVariantLabel non stampa campi tecnici con underscore", () => {
  assert.equal(
    helpers.extractIntegrationPrintVariantLabel({
      id: "menu_drink_premium_mare_tonic",
      label: "Tonic",
      name: "Tonic",
      priceDelta: 0,
    }),
    "Tonic"
  );
  assert.equal(
    helpers.extractIntegrationPrintVariantLabel({
      id: "menu_apericena_prenotazione",
      label: "Prenotazione",
      name: "Prenotazione",
      priceDelta: 2,
    }),
    "Prenotazione"
  );
});

test("extractIntegrationPrintVariantLabel mantiene campi descrittivi custom", () => {
  assert.equal(
    helpers.extractIntegrationPrintVariantLabel({
      Supplemento: "Menu Apericena",
      Variante: "Tonic",
      selectedVariantId: "menu_drink_premium_mare_tonic",
      extraPrice: 2,
    }),
    "Menu Apericena / Tonic"
  );
  assert.equal(
    helpers.extractIntegrationPrintVariantLabel([
      { id: "menu_drink_premium_mare_tonic", label: "Tonic", priceDelta: 0 },
      "Poco ghiaccio",
    ]),
    "Tonic / Poco ghiaccio"
  );
});

test("cleanIntegrationOrderVariantLabelForPrint divide e pulisce varianti inline", () => {
  assert.equal(
    helpers.cleanIntegrationOrderVariantLabelForPrint("Variante: Premium +2 euro | Lemon / Soda"),
    "Premium / Lemon / Soda"
  );
  assert.equal(helpers.cleanIntegrationOrderVariantLabelForPrint(""), "");
});

test("isIntegrationSupplementText riconosce supplementi e ignora note ordinarie", () => {
  assert.equal(helpers.isIntegrationSupplementText("Apericena + 12 euro"), true);
  assert.equal(helpers.isIntegrationSupplementText("extra lime"), true);
  assert.equal(helpers.isIntegrationSupplementText("aggiunta tonica"), true);
  assert.equal(helpers.isIntegrationSupplementText("poco ghiaccio"), false);
  assert.equal(helpers.isIntegrationSupplementText(""), false);
});

test("cleanIntegrationOrderSupplementLabelForPrint rimuove prefissi nota e compatta spazi", () => {
  assert.equal(
    helpers.cleanIntegrationOrderSupplementLabelForPrint("Nota: Apericena + 12 euro |commento: Extra lime +1 euro"),
    "Apericena / Extra lime"
  );
  assert.equal(helpers.cleanIntegrationOrderSupplementLabelForPrint(null), "");
});

test("helper con fallback default resta utilizzabile senza dipendenze", () => {
  const defaults = createIntegrationOrderPrintLabelHelpers();
  assert.equal(defaults.cleanIntegrationOrderVariantLabelForPrint("Premium | Secco"), "Premium / Secco");
  assert.equal(defaults.cleanIntegrationOrderSupplementLabelForPrint("Note: Extra lime"), "Extra lime");
});

test("formatIntegrationWaiterShortLabel compatta nome e cognome per la stampa", () => {
  assert.equal(helpers.formatIntegrationWaiterShortLabel("  Giada   Rossi  "), "Giada R.");
  assert.equal(helpers.formatIntegrationWaiterShortLabel("Roberto"), "Roberto");
  assert.equal(helpers.formatIntegrationWaiterShortLabel(""), "Cameriere");
  assert.equal(helpers.formatIntegrationWaiterShortLabel(null), "Cameriere");
});
