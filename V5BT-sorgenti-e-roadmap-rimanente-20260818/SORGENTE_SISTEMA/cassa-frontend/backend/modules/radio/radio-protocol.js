export const RADIO_WS_PATH = "/api/radio/ws";
export const RADIO_PROTOCOL_VERSION = 1;
export const RADIO_FRAME_MAGIC = "RPT1";
export const RADIO_FRAME_HEADER_BYTES = 16;
export const RADIO_LIMITS = {
  sampleRate: 16000,
  frameMs: 20,
  codec: "mulaw",
  maxFrameBytes: 1024,
  maxBufferedBytes: 16 * 1024,
};

export function parseRadioJsonMessage(data) {
  try {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data ?? "");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function stringifyRadioJsonMessage(message) {
  return JSON.stringify(message);
}

export function isSupportedRadioCodec(message) {
  return (
    String(message?.codec ?? RADIO_LIMITS.codec) === RADIO_LIMITS.codec &&
    Number(message?.sampleRate ?? RADIO_LIMITS.sampleRate) === RADIO_LIMITS.sampleRate &&
    Number(message?.frameMs ?? RADIO_LIMITS.frameMs) === RADIO_LIMITS.frameMs
  );
}

export function parseRadioFrame(data, limits = RADIO_LIMITS) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.length < RADIO_FRAME_HEADER_BYTES) return null;
  if (buffer.length > RADIO_FRAME_HEADER_BYTES + limits.maxFrameBytes) return null;
  if (buffer.toString("ascii", 0, 4) !== RADIO_FRAME_MAGIC) return null;
  return {
    buffer,
    streamId: buffer.readUInt32BE(4),
    seq: buffer.readUInt32BE(8),
    timestampMs: buffer.readUInt32BE(12),
    payloadBytes: buffer.length - RADIO_FRAME_HEADER_BYTES,
  };
}

export function buildRadioFrame({ streamId, seq = 0, timestampMs = 0, payload }) {
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? []);
  const buffer = Buffer.alloc(RADIO_FRAME_HEADER_BYTES + payloadBuffer.length);
  buffer.write(RADIO_FRAME_MAGIC, 0, 4, "ascii");
  buffer.writeUInt32BE(Number(streamId) >>> 0, 4);
  buffer.writeUInt32BE(Number(seq) >>> 0, 8);
  buffer.writeUInt32BE(Number(timestampMs) >>> 0, 12);
  payloadBuffer.copy(buffer, RADIO_FRAME_HEADER_BYTES);
  return buffer;
}

export function formatRadioSpeakerName(fullName, username) {
  const raw = String(fullName || username || "").trim();
  const parts = raw.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "Operatore";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1].charAt(0).toUpperCase()}.`;
}
