import test from "node:test";
import assert from "node:assert/strict";
import { createEscPosStyleHelpers } from "../printing/escpos-style.js";

const helpers = createEscPosStyleHelpers({
  clampInt: (value, min, max, fallback = min) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
  },
});

function codes(value) {
  return [...String(value)].map((char) => char.charCodeAt(0));
}

test("escpos style genera comandi base", () => {
  assert.deepEqual(codes(helpers.escPos([0x1b, 0x61, 0x01])), [27, 97, 1]);
  assert.deepEqual(codes(helpers.escPosAlign("center")), [27, 97, 1]);
  assert.deepEqual(codes(helpers.escPosAlign("right")), [27, 97, 2]);
  assert.deepEqual(codes(helpers.escPosAlign("unknown")), [27, 97, 0]);
  assert.deepEqual(codes(helpers.escPosBold(true)), [27, 69, 1]);
  assert.deepEqual(codes(helpers.escPosBold(false)), [27, 69, 0]);
  assert.deepEqual(codes(helpers.escPosUnderline(true)), [27, 45, 1]);
  assert.deepEqual(codes(helpers.escPosItalic(true)), [27, 52, 1]);
});

test("escpos style limita spaziatura e dimensioni come nel monolite", () => {
  assert.deepEqual(codes(helpers.escPosCharSpacing(99)), [27, 32, 8]);
  assert.deepEqual(codes(helpers.escPosCharSpacing(-5)), [27, 32, 0]);
  assert.deepEqual(codes(helpers.escPosSize(1, 2)), [29, 33, 18]);
  assert.deepEqual(codes(helpers.escPosSize(9, 10)), [29, 33, 18]);
});

test("escpos style formatta una riga completa con reset finale", () => {
  const output = helpers.styleEscPosPrintLine("TEST   ", {
    align: "center",
    bold: true,
    italic: true,
    underline: true,
    charSpacing: 2,
    widthScale: 1,
    heightScale: 2,
  });

  assert.equal(output.includes("TEST"), true);
  assert.deepEqual(codes(output.slice(0, 3)), [27, 97, 1]);
  assert.equal(output.endsWith(helpers.escPosInlineReset()), true);
  assert.equal(output.includes("TEST   "), false);
});

test("escpos style formatta liste e scarta righe vuote", () => {
  assert.deepEqual(helpers.styleEscPosPrintLines(["A", "", null, "B"]).map((line) => line.includes("A") || line.includes("B")), [
    true,
    true,
  ]);
  assert.deepEqual(helpers.styleEscPosPrintLines("Singola").length, 1);
});
