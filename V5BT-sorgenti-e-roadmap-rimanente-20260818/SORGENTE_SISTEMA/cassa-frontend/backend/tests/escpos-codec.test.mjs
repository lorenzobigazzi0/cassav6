import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEscPosRasterStrikeMarker,
  buildEscPosTextBufferWithRawMarkers,
  rasterStrikePrintableColumns,
} from "../printing/escpos-codec.js";

test("ESC/POS codec preserva CP437, newline e marker raw", () => {
  const raw = Buffer.from([0x1b, 0x40, 0x00, 0xff]);
  const marker = `{{ESC_POS_RAW_BASE64:${raw.toString("base64")}}}`;
  const output = buildEscPosTextBufferWithRawMarkers(
    `A\n\u00e8 ${marker} \u20ac`,
  );

  assert.deepEqual(
    [...output],
    [0x41, 0x0d, 0x0a, 0x8a, 0x20, ...raw, 0x20, 0x20, 0x45, 0x55, 0x52],
  );
});

test("ESC/POS raster strike produce un marker deterministico e decodificabile", () => {
  const marker = buildEscPosRasterStrikeMarker("2 Articolo", { scale: 3 });
  const match = /^\{\{ESC_POS_RAW_BASE64:([A-Za-z0-9+/=]+)\}\}$/.exec(marker);
  assert.ok(match);

  const bytes = Buffer.from(match[1], "base64");
  assert.deepEqual([...bytes.subarray(0, 12)], [
    0x1b, 0x61, 0x00, 0x1d, 0x21, 0x00, 0x1b, 0x45, 0x00, 0x1b, 0x2d, 0x00,
  ]);
  assert.equal(bytes.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00])) >= 0, true);
  assert.deepEqual([...bytes.subarray(-3)], [0x1b, 0x61, 0x00]);
  assert.equal(buildEscPosRasterStrikeMarker("   "), "");
});

test("ESC/POS raster columns rispetta larghezza e scala", () => {
  assert.equal(rasterStrikePrintableColumns(48, 4.4), 21);
  assert.ok(rasterStrikePrintableColumns(80, 4.4) > rasterStrikePrintableColumns(48, 4.4));
  assert.ok(rasterStrikePrintableColumns(48, 2) > rasterStrikePrintableColumns(48, 5));
});
