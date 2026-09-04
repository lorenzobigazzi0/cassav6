import type { RadioChannel } from "./radioTypes";

export const RADIO_SLOT_COLORS = ["#ff9f43", "#00d2ff", "#8b5cf6"] as const;

export type RadioRectLike = {
  left: number;
  width: number;
};

export type RadioZone = {
  index: number;
  channel: RadioChannel;
  color: string;
};

export function normalizeRadioColor(color: string | null | undefined, index = 0) {
  const value = String(color ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  return RADIO_SLOT_COLORS[index] ?? RADIO_SLOT_COLORS[0];
}

export function getRadioChannelColor(channel: RadioChannel | null | undefined, index: number) {
  return normalizeRadioColor(channel?.color, index);
}

export function resolveRadioZone(
  clientX: number,
  rect: RadioRectLike,
  activeSlots: RadioChannel[]
): RadioZone | null {
  if (activeSlots.length === 0 || rect.width <= 0) return null;
  if (activeSlots.length === 1) {
    return {
      index: 0,
      channel: activeSlots[0],
      color: getRadioChannelColor(activeSlots[0], 0),
    };
  }

  const ratio = Math.min(0.999, Math.max(0, (clientX - rect.left) / rect.width));
  const index = Math.min(activeSlots.length - 1, Math.floor(ratio * activeSlots.length));
  const channel = activeSlots[index];
  if (!channel) return null;
  return {
    index,
    channel,
    color: getRadioChannelColor(channel, index),
  };
}
