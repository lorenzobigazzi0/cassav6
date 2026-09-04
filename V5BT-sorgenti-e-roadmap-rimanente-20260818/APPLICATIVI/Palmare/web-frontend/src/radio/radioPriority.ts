import type { IncomingRadioState, RadioSlots } from "./radioTypes";

export function resolvePrimaryRadioChannelId(slots: RadioSlots): string | null {
  const firstSlot = slots[0];
  return typeof firstSlot === "string" && firstSlot.trim() ? firstSlot.trim() : null;
}

export function isPrimaryRadioStream(
  stream: Pick<IncomingRadioState, "channelId"> | null | undefined,
  primaryChannelId: string | null | undefined
) {
  return Boolean(stream && primaryChannelId && stream.channelId === primaryChannelId);
}

export function chooseNextIncomingStream(
  streams: IncomingRadioState[],
  primaryChannelId: string | null | undefined
): IncomingRadioState | null {
  if (streams.length === 0) return null;

  const primary = streams
    .filter((stream) => isPrimaryRadioStream(stream, primaryChannelId))
    .sort((left, right) => right.startedAt - left.startedAt)[0];
  if (primary) return primary;

  return [...streams].sort((left, right) => right.startedAt - left.startedAt)[0] ?? null;
}
