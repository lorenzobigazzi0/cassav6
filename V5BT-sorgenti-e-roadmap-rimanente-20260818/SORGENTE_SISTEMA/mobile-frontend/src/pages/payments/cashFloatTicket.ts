export type CashFloatTicket = {
  workflowId?: string | null;
  operationId?: string | null;
  cashFloatId: string;
  assignmentId?: string | null;
  combinationId?: string | null;
  businessEveningKey?: string | null;
  createdAtMs: number;
  operatorName: string;
  totalCents?: number | null;
  qrPayload: string;
  printText: string;
  autoPrint?: boolean;
};

export type CashFloatTicketRecordStatus =
  | "generated"
  | "loaded"
  | "used_in_settlement"
  | "cancelled";

export type CashFloatTicketRecord = CashFloatTicket & {
  status: CashFloatTicketRecordStatus;
};

export type CashFloatTicketPrintAuth = {
  token: string | null;
  userId: string | null;
  username?: string | null;
  fullName?: string | null;
  deviceUuid: string | null;
  activityId?: string | null;
  roomId?: string | null;
};

const ESC_POS_RAW_BASE64_PREFIX = "{{ESC_POS_RAW_BASE64:";
const ESC_POS_RAW_BASE64_SUFFIX = "}}";
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: number[]) {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const combined = (first << 16) | (second << 8) | third;
    output += BASE64_ALPHABET[(combined >> 18) & 63];
    output += BASE64_ALPHABET[(combined >> 12) & 63];
    output += hasSecond ? BASE64_ALPHABET[(combined >> 6) & 63] : "=";
    output += hasThird ? BASE64_ALPHABET[combined & 63] : "=";
  }
  return output;
}

function encodeUtf8Bytes(value: string) {
  if (typeof TextEncoder !== "undefined") {
    return Array.from(new TextEncoder().encode(value));
  }
  const encoded = encodeURIComponent(value);
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === "%") {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(encoded.charCodeAt(index));
    }
  }
  return bytes;
}

function buildEscPosRawBase64Marker(bytes: number[]) {
  return `${ESC_POS_RAW_BASE64_PREFIX}${bytesToBase64(bytes)}${ESC_POS_RAW_BASE64_SUFFIX}`;
}

function buildEscPosQrCodeMarker(payload: string) {
  const data = encodeUtf8Bytes(payload);
  const storeLength = data.length + 3;
  if (storeLength > 65535) return "";
  const pL = storeLength & 0xff;
  const pH = (storeLength >> 8) & 0xff;
  const bytes = [
    0x1d,
    0x28,
    0x6b,
    0x04,
    0x00,
    0x31,
    0x41,
    0x32,
    0x00,
    0x1d,
    0x28,
    0x6b,
    0x03,
    0x00,
    0x31,
    0x43,
    0x07,
    0x1d,
    0x28,
    0x6b,
    0x03,
    0x00,
    0x31,
    0x45,
    0x31,
    0x1d,
    0x28,
    0x6b,
    pL,
    pH,
    0x31,
    0x50,
    0x30,
    ...data,
    0x1d,
    0x28,
    0x6b,
    0x03,
    0x00,
    0x31,
    0x51,
    0x30,
  ];
  return buildEscPosRawBase64Marker(bytes);
}

export function buildAutomaticCashFloatTicketText(input: {
  cashFloatId: string;
  assignmentId?: string | null;
  combinationId?: string | null;
  businessEveningKey?: string | null;
  createdAtMs: number;
  operatorName: string;
  qrPayload: string;
}) {
  const width = 42;
  const divider = "-".repeat(width);
  const date = new Date(input.createdAtMs).toLocaleString("it-IT");
  const qrMarker = buildEscPosQrCodeMarker(input.qrPayload);

  return [
    "        FONDO CASSA AUTOMATICO",
    divider,
    `Data/Ora: ${date}`,
    `Operatore: ${input.operatorName}`,
    `ID Fondo Cassa: ${input.cashFloatId}`,
    input.assignmentId ? `ID Assegnazione: ${input.assignmentId}` : null,
    input.businessEveningKey ? `Serata: ${input.businessEveningKey}` : null,
    input.combinationId ? `Config: ${input.combinationId}` : null,
    divider,
    "Scansiona il QR per caricare",
    "il fondo cassa automatico.",
    "Valore codificato - non visibile.",
    divider,
    qrMarker,
    divider,
    "Inserire lo scontrino nel borsellino.",
    "Documento interno.",
    divider,
  ]
    .filter(Boolean)
    .join("\n");
}
