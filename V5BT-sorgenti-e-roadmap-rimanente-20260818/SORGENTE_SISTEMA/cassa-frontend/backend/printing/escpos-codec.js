import { toPrintSafeUppercase } from "./print-utils.js";

const ESC_POS_RAW_BASE64_PATTERN =
  /\{\{ESC_POS_RAW_BASE64:([A-Za-z0-9+/=]+)\}\}/g;
const ESC_POS_CP437_BYTES = new Map(
  Object.entries({
    Ç: 0x80,
    ü: 0x81,
    é: 0x82,
    â: 0x83,
    ä: 0x84,
    à: 0x85,
    å: 0x86,
    ç: 0x87,
    ê: 0x88,
    ë: 0x89,
    è: 0x8a,
    ï: 0x8b,
    î: 0x8c,
    ì: 0x8d,
    Ä: 0x8e,
    Å: 0x8f,
    É: 0x90,
    æ: 0x91,
    Æ: 0x92,
    ô: 0x93,
    ö: 0x94,
    ò: 0x95,
    û: 0x96,
    ù: 0x97,
    ÿ: 0x98,
    Ö: 0x99,
    Ü: 0x9a,
    á: 0xa0,
    í: 0xa1,
    ó: 0xa2,
    ú: 0xa3,
    ñ: 0xa4,
    Ñ: 0xa5,
    ª: 0xa6,
    º: 0xa7,
    "¿": 0xa8,
    "¬": 0xaa,
    "½": 0xab,
    "¼": 0xac,
    "¡": 0xad,
    "«": 0xae,
    "»": 0xaf,
    "°": 0xf8,
  }),
);
const PRINT_RASTER_FONT_5X7 = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "'": ["00100", "00100", "01000", "00000", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ",": ["00000", "00000", "00000", "00000", "00100", "00100", "01000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  "°": ["01100", "10010", "10010", "01100", "00000", "00000", "00000"],
  0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  5: ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  6: ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  9: ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10011", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

function escPosRawBase64Marker(buffer) {
  return `{{ESC_POS_RAW_BASE64:${Buffer.from(buffer).toString("base64")}}}`;
}

function encodeEscPosCp437TextChunk(value) {
  const bytes = [];
  for (const char of String(value ?? "")) {
    const code = char.codePointAt(0);
    if (code <= 0x7f) {
      bytes.push(code);
      continue;
    }
    if (ESC_POS_CP437_BYTES.has(char)) {
      bytes.push(ESC_POS_CP437_BYTES.get(char));
      continue;
    }
    const fallback = char.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (fallback && fallback !== char) {
      for (const fallbackChar of fallback) {
        const fallbackCode = fallbackChar.codePointAt(0);
        bytes.push(fallbackCode <= 0x7f ? fallbackCode : 0x3f);
      }
      continue;
    }
    bytes.push(0x3f);
  }
  return Buffer.from(bytes);
}

export function buildEscPosTextBufferWithRawMarkers(value) {
  const source = String(
    Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? ""),
  ).replace(/\u20ac/g, " EUR");
  const chunks = [];
  let lastIndex = 0;
  for (const match of source.matchAll(ESC_POS_RAW_BASE64_PATTERN)) {
    const textChunk = source.slice(lastIndex, match.index);
    if (textChunk) {
      chunks.push(
        encodeEscPosCp437TextChunk(
          textChunk.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n"),
        ),
      );
    }
    try {
      chunks.push(Buffer.from(match[1], "base64"));
    } catch {
      // Se il marker e corrotto, non mandare byte casuali alla stampante.
    }
    lastIndex = match.index + match[0].length;
  }
  const tail = source.slice(lastIndex);
  if (tail) {
    chunks.push(
      encodeEscPosCp437TextChunk(
        tail.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n"),
      ),
    );
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
}

export function buildEscPosRasterStrikeMarker(value, options = {}) {
  const text = toPrintSafeUppercase(value)
    .replace(/[^ A-Z0-9'.,:\/°-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const parsedScale = Number(options.scale);
  const scale = Number.isFinite(parsedScale)
    ? Math.min(5, Math.max(2, parsedScale))
    : 4;
  const glyphWidth = 5;
  const glyphHeight = 7;
  const gap = 1;
  const pad = Math.ceil(Math.max(4, scale * 2));
  const rawWidth =
    pad * 2 +
    (text.length * glyphWidth + Math.max(0, text.length - 1) * gap) * scale;
  const width = Math.max(8, Math.ceil(rawWidth / 8) * 8);
  const height = Math.ceil(pad * 2 + glyphHeight * scale);
  const pixels = Array.from({ length: height }, () => Array(width).fill(0));
  let cursorX = pad;
  const cursorY = pad;
  for (const char of text) {
    const glyph = PRINT_RASTER_FONT_5X7[char] || PRINT_RASTER_FONT_5X7[" "];
    for (let gy = 0; gy < glyphHeight; gy += 1) {
      for (let gx = 0; gx < glyphWidth; gx += 1) {
        if (glyph[gy][gx] !== "1") continue;
        const startY = Math.floor(cursorY + gy * scale);
        const endY = Math.min(height, Math.ceil(cursorY + (gy + 1) * scale));
        const startX = Math.floor(cursorX + gx * scale);
        const endX = Math.min(width, Math.ceil(cursorX + (gx + 1) * scale));
        for (let y = startY; y < endY; y += 1) {
          for (let x = startX; x < endX; x += 1) {
            pixels[y][x] = 1;
          }
        }
      }
    }
    cursorX += (glyphWidth + gap) * scale;
  }
  const strikeY = cursorY + Math.floor(glyphHeight * scale * 0.54);
  const strikeHalfThickness = Math.max(1, Math.floor(scale / 2));
  for (
    let y = Math.max(0, strikeY - strikeHalfThickness);
    y <= Math.min(height - 1, strikeY + strikeHalfThickness);
    y += 1
  ) {
    for (
      let x = pad;
      x < Math.min(width - pad, cursorX - gap * scale);
      x += 1
    ) {
      pixels[y][x] = 1;
    }
  }
  const bytesPerRow = width / 8;
  const data = Buffer.alloc(bytesPerRow * height);
  for (let y = 0; y < height; y += 1) {
    for (let byteIndex = 0; byteIndex < bytesPerRow; byteIndex += 1) {
      let byteValue = 0;
      for (let bit = 0; bit < 8; bit += 1) {
        if (pixels[y][byteIndex * 8 + bit]) {
          byteValue |= 0x80 >> bit;
        }
      }
      data[y * bytesPerRow + byteIndex] = byteValue;
    }
  }
  const raster = Buffer.concat([
    Buffer.from([
      0x1b, 0x61, 0x00, 0x1d, 0x21, 0x00, 0x1b, 0x45, 0x00, 0x1b, 0x2d, 0x00,
    ]),
    Buffer.from([
      0x1d,
      0x76,
      0x30,
      0x00,
      bytesPerRow & 0xff,
      (bytesPerRow >> 8) & 0xff,
      height & 0xff,
      (height >> 8) & 0xff,
    ]),
    data,
    Buffer.from([0x1b, 0x61, 0x00]),
  ]);
  return escPosRawBase64Marker(raster);
}

export function rasterStrikePrintableColumns(lineWidth, scaleValue = 4.4) {
  const safeLineWidth = Math.max(32, Math.trunc(Number(lineWidth) || 48));
  const parsedScale = Number(scaleValue);
  const scale = Number.isFinite(parsedScale)
    ? Math.min(5, Math.max(2, parsedScale))
    : 4.4;
  const glyphWidth = 5;
  const gap = 1;
  const pad = Math.ceil(Math.max(4, scale * 2));
  const printableDots = safeLineWidth * 12;
  const availableDots = Math.max(1, printableDots - pad * 2);
  return Math.max(
    8,
    Math.floor((availableDots + gap * scale) / ((glyphWidth + gap) * scale)),
  );
}

