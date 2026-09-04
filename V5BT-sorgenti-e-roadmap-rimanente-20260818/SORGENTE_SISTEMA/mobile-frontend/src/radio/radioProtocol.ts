import type { RadioChannel, RadioSlots } from "./radioTypes";

export const RADIO_PROTOCOL_VERSION = 1;
export const RADIO_WS_PATH = "/api/radio/ws";
export const RADIO_FRAME_MAGIC = "RPT1";
export const RADIO_FRAME_HEADER_BYTES = 16;
export const RADIO_FRAME_LIMITS = {
  sampleRate: 16000,
  frameMs: 20,
  codec: "mulaw" as const,
  maxFrameBytes: 1024,
  maxBufferedBytes: 16 * 1024,
};

export type RadioFrame = {
  streamId: number;
  seq: number;
  timestampMs: number;
  payload: Uint8Array;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function asUint8Array(data: ArrayBuffer | Uint8Array) {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export function encodeRadioFrame(frame: RadioFrame): Uint8Array {
  const payload = asUint8Array(frame.payload);
  const bytes = new Uint8Array(RADIO_FRAME_HEADER_BYTES + payload.byteLength);
  bytes.set(textEncoder.encode(RADIO_FRAME_MAGIC), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, frame.streamId >>> 0);
  view.setUint32(8, frame.seq >>> 0);
  view.setUint32(12, frame.timestampMs >>> 0);
  bytes.set(payload, RADIO_FRAME_HEADER_BYTES);
  return bytes;
}

export function decodeRadioFrame(data: ArrayBuffer | Uint8Array): RadioFrame | null {
  const bytes = asUint8Array(data);
  if (bytes.byteLength < RADIO_FRAME_HEADER_BYTES) return null;
  if (bytes.byteLength > RADIO_FRAME_HEADER_BYTES + RADIO_FRAME_LIMITS.maxFrameBytes) return null;
  const magic = textDecoder.decode(bytes.slice(0, 4));
  if (magic !== RADIO_FRAME_MAGIC) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    streamId: view.getUint32(4),
    seq: view.getUint32(8),
    timestampMs: view.getUint32(12),
    payload: bytes.slice(RADIO_FRAME_HEADER_BYTES),
  };
}

export function formatRadioSpeakerName(fullName?: string | null, username?: string | null) {
  const raw = String(fullName || username || "").trim();
  const parts = raw.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "Operatore";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1].charAt(0).toUpperCase()}.`;
}

export function formatPttElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function normalizeRadioSlots(slots: unknown): RadioSlots {
  const source = Array.isArray(slots) ? slots : [];
  return [0, 1, 2].map((index) => {
    const value = String(source[index] ?? "").trim();
    return value || null;
  }) as RadioSlots;
}

export function resolveActiveRadioSlots(channels: RadioChannel[], slots: RadioSlots) {
  const channelById = new Map(
    channels.filter((channel) => channel.enabled).map((channel) => [channel.id, channel])
  );
  const seen = new Set<string>();
  const active: RadioChannel[] = [];
  for (const slot of slots) {
    if (!slot || seen.has(slot)) continue;
    const channel = channelById.get(slot);
    if (!channel) continue;
    seen.add(slot);
    active.push(channel);
  }
  return active;
}

export function createRadioTxId(prefix = "tx") {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random.slice(0, 18)}`;
}
