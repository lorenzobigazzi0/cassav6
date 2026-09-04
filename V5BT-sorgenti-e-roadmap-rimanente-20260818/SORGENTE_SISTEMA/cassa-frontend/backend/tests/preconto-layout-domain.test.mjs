import test from "node:test";
import assert from "node:assert/strict";
import { createPrecontoLayoutHelpers } from "../printing/preconto-layout.domain.js";
import { createPrecontoSupplementHelpers } from "../printing/preconto-supplements.domain.js";

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;
const formatPrintMoneyCompact = (value) =>
  new Intl.NumberFormat("it-IT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(Number(value)) ? Number(value) : 0);

function padPrintRight(value, width) {
  const text = String(value ?? "");
  const safeWidth = Math.max(0, Math.trunc(Number(width) || 0));
  if (text.length >= safeWidth) {
    return safeWidth > 0 ? `${text.slice(0, Math.max(0, safeWidth - 1))} ` : text;
  }
  return `${text}${" ".repeat(safeWidth - text.length)}`;
}

function wrapPrintText(value, width) {
  const safeWidth = Math.max(8, Math.trunc(Number(width) || 32));
  const words = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= safeWidth || !current) {
      current = candidate;
      return;
    }
    lines.push(current);
    current = word;
  });
  if (current) lines.push(current);
  return lines;
}

const supplementHelpers = createPrecontoSupplementHelpers({
  apericenaStandardTargetPrice: 12,
  roundMoney,
});

const helpers = createPrecontoLayoutHelpers({
  extractPrecontoEntryNameUnitHintValue: supplementHelpers.extractPrecontoEntryNameUnitHintValue,
  formatPrintMoneyCompact,
  getPrecontoEntrySupplementEntries: supplementHelpers.getPrecontoEntrySupplementEntries,
  isPrecontoApericenaLabel: supplementHelpers.isPrecontoApericenaLabel,
  padPrintRight,
  roundMoney,
  wrapPrintText,
});

test("preconto layout risolve base e totale senza supplementi", () => {
  const entry = { name: "Caffe", qtyValue: 2, unitValue: 1.3, totalValue: 0 };
  assert.equal(helpers.resolvePrecontoEntryBaseUnitValue(entry), 1.3);
  assert.equal(helpers.resolvePrecontoEntryDisplayTotalValue(entry), 2.6);
  assert.deepEqual(helpers.collectPrecontoEntryLayoutUnitValues(entry), [1.3]);
});

test("preconto layout usa listino come base e supplemento come extra", () => {
  const entry = {
    name: "Gin Premium",
    qtyValue: 1,
    unitValue: 10,
    listUnitValue: 8,
    descriptions: ["Supplemento: Tonica +2"],
  };
  const supplementEntries = supplementHelpers.getPrecontoEntrySupplementEntries(entry);
  assert.equal(helpers.resolvePrecontoEntryBaseUnitValue(entry, supplementEntries), 8);
  assert.equal(helpers.resolvePrecontoEntryDisplayTotalValue(entry, supplementEntries), 10);
  assert.deepEqual(helpers.collectPrecontoEntryLayoutUnitValues(entry), [8, 2]);
});

test("preconto layout mantiene il totale calcolato per apericena", () => {
  const entry = {
    name: "Spritz",
    qtyValue: 1,
    unitValue: 8,
    listUnitValue: 8,
    supplements: ["Apericena da 12"],
  };
  const supplementEntries = supplementHelpers.getPrecontoEntrySupplementEntries(entry);
  assert.equal(helpers.resolvePrecontoEntryBaseUnitValue(entry, supplementEntries), 8);
  assert.equal(helpers.resolvePrecontoEntryDisplayTotalValue(entry, supplementEntries), 12);
});

test("preconto layout dimensiona colonne in base a righe e supplementi", () => {
  const layout = helpers.buildIntegrationPrecontoColumnLayout(44, {
    groups: [
      {
        lines: [
          { name: "Caffe", qty: "2x", qtyValue: 2, unitValue: 1.3 },
          { name: "Gin Premium", qtyValue: 1, unitValue: 10, listUnitValue: 8, descriptions: ["Tonica +2"] },
        ],
      },
    ],
  });
  assert.equal(layout.width, 44);
  assert.equal(layout.qtyWidth >= 3, true);
  assert.equal(layout.unitWidth >= 7, true);
  assert.equal(layout.subtotalWidth >= 7, true);
  assert.equal(layout.nameWidth >= 6, true);
});

test("preconto layout costruisce righe articolo con supplementi e totale finale", () => {
  const entry = {
    name: "Gin Premium Molto Lungo",
    qtyValue: 1,
    unitValue: 10,
    listUnitValue: 8,
    descriptions: ["Supplemento: Tonica +2"],
  };
  const layout = {
    qtyWidth: 3,
    nameWidth: 12,
    unitWidth: 7,
    subtotalWidth: 7,
  };
  const lines = helpers.buildIntegrationPrecontoItemLines(entry, layout);
  assert.equal(lines.some((line) => line.includes("Gin Premium")), true);
  assert.equal(lines.some((line) => line.includes("Tonica")), true);
  assert.equal(lines.some((line) => line.includes("8,00")), true);
  assert.equal(lines.some((line) => line.includes("2,00")), true);
  assert.equal(lines.at(-1).includes("10,00"), true);
});
