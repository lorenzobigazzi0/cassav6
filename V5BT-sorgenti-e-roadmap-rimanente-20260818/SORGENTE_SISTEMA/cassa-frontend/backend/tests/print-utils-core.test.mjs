import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPrintLabelLines,
  buildPrintTwoColumnLines,
  centerPrintText,
  formatPrintAmountLine,
  formatPrintMoney,
  formatPrintMoneyCompact,
  makePrintSeparator,
  padPrintRight,
  sanitizePrintFileToken,
  toPrintSafeUppercase,
  wrapPrintText,
} from "../printing/print-utils.js";

test("print utils sanitizzano token e formattano denaro", () => {
  assert.equal(sanitizePrintFileToken(" Preconto #42 / Tavolo "), "preconto_42_tavolo");
  assert.equal(sanitizePrintFileToken("###", "fallback"), "fallback");
  assert.equal(formatPrintMoneyCompact(12.5), "12,50");
  assert.equal(formatPrintMoney("x"), "0,00 EUR");
});

test("print utils gestiscono larghezze, padding e maiuscole safe", () => {
  assert.equal(makePrintSeparator(4), "----------------");
  assert.equal(centerPrintText("BAR", 9), "      BAR");
  assert.equal(padPrintRight("ABCDEFG", 4), "ABC ");
  assert.equal(formatPrintAmountLine("TOTALE", "12,50 EUR", 20), "TOTALE       12,50 EUR");
  assert.equal(toPrintSafeUppercase("È già più"), "E' GIA' PIU'");
});

test("print utils wrappano testo e label senza perdere indentazione", () => {
  assert.deepEqual(wrapPrintText("uno due tre quattro", 12, "  "), ["  uno due", "  tre", "  quattro"]);
  assert.deepEqual(buildPrintLabelLines("NOTA", "uno due tre quattro", 12), ["NOTA:", "  uno due", "  tre", "  quattro"]);
  assert.deepEqual(buildPrintLabelLines("", "uno due", 12), ["uno due"]);
});

test("print utils costruiscono righe a due colonne e fallback multilinea", () => {
  assert.deepEqual(buildPrintTwoColumnLines("TAV. 1", "00042", 18), ["TAV. 1       00042"]);
  assert.deepEqual(buildPrintTwoColumnLines("Descrizione molto lunga", "00042", 16), [
    "Descrizione",
    "molto lunga",
    "00042",
  ]);
  assert.deepEqual(buildPrintTwoColumnLines("", "solo destra", 16), ["solo destra"]);
});
