import test from "node:test";
import assert from "node:assert/strict";
import { createPrecontoSupplementHelpers } from "../printing/preconto-supplements.domain.js";

const helpers = createPrecontoSupplementHelpers({
  apericenaStandardTargetPrice: 12,
  roundMoney: (value) => Math.round((Number(value) || 0) * 100) / 100,
});

test("preconto supplements normalizza prefissi e riconosce apericena", () => {
  assert.equal(helpers.normalizePrecontoInlineSupplementLabel("Supplemento: Menu Apericena"), "Menu Apericena");
  assert.equal(helpers.normalizePrecontoInlineSupplementLabel("Nota: senza ghiaccio"), "senza ghiaccio");
  assert.equal(helpers.isPrecontoApericenaLabel("menu apericena"), true);
  assert.equal(helpers.isPrecontoApericenaLabel("Apericena Prenotazione"), true);
  assert.equal(helpers.isPrecontoApericenaLabel("Tonica premium"), false);
});

test("preconto supplements parsea importi italiani e internazionali", () => {
  assert.equal(helpers.parsePrecontoLooseMoneyValue("EUR 1,20"), 1.2);
  assert.equal(helpers.parsePrecontoLooseMoneyValue("1.234,50"), 1234.5);
  assert.equal(helpers.parsePrecontoLooseMoneyValue("1,234.50"), 1234.5);
  assert.equal(helpers.parsePrecontoLooseMoneyValue("-2,50"), 2.5);
  assert.equal(helpers.parsePrecontoLooseMoneyValue("nessun prezzo"), null);
});

test("preconto supplements costruisce voce supplemento con prezzo esplicito", () => {
  assert.deepEqual(helpers.buildPrecontoSupplementEntry("Supplemento: Tonica premium + 1,50"), {
    label: "Tonica premium",
    rawLabel: "Supplemento: Tonica premium + 1,50",
    unitValue: 1.5,
    targetUnitValue: 1.5,
  });
  assert.equal(helpers.buildPrecontoSupplementEntry("Tonica premium"), null);
  assert.deepEqual(helpers.buildPrecontoSupplementEntry("Tonica premium", true), {
    label: "Tonica premium",
    rawLabel: "Tonica premium",
    unitValue: null,
    targetUnitValue: null,
  });
});

test("preconto supplements formatta apericena e ricava delta da prezzo target", () => {
  const entries = helpers.getPrecontoEntrySupplementEntries({
    unitValue: 8,
    listUnitValue: 8,
    qtyValue: 1,
    supplements: ["Apericena da 12"],
  });
  assert.deepEqual(entries, [
    {
      label: "Menu Apericena",
      rawLabel: "Apericena da 12",
      unitValue: 4,
      targetUnitValue: 12,
    },
  ]);
});

test("preconto supplements deduplica segmenti e preferisce prezzo esplicito apericena", () => {
  const entries = helpers.getPrecontoEntrySupplementEntries({
    unitValue: 8,
    listUnitValue: 8,
    qtyValue: 1,
    supplements: ["Supplemento: Apericena (+5) / Apericena (+5) | Extra lime +1"],
  });
  assert.deepEqual(entries, [
    {
      label: "Menu Apericena",
      rawLabel: "Apericena (+5)",
      unitValue: 5,
      targetUnitValue: null,
    },
    {
      label: "lime",
      rawLabel: "lime +1",
      unitValue: 1,
      targetUnitValue: null,
    },
  ]);
});

test("preconto supplements ricava supplemento residuo da listino e prezzo unitario", () => {
  const entries = helpers.getPrecontoEntrySupplementEntries({
    unitValue: 10,
    listUnitValue: 8,
    qtyValue: 1,
    descriptions: ["Supplemento: Drink premium"],
  });
  assert.deepEqual(entries, [
    {
      label: "Drink premium",
      rawLabel: "Drink premium",
      unitValue: 2,
      targetUnitValue: null,
    },
  ]);
});
