import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseNextIncomingStream,
  isPrimaryRadioStream,
  resolvePrimaryRadioChannelId,
} from "../src/radio/radioPriority";
import { useNativePrimaryPtt } from "../src/radio/useNativePrimaryPtt";
import type { IncomingRadioState, RadioPttState, RadioSlots } from "../src/radio/radioTypes";

function stream(streamId: number, channelId: string, startedAt: number): IncomingRadioState {
  return {
    streamId,
    channelId,
    channelName: channelId,
    channelColor: "#fff",
    speaker: {
      userId: "u",
      displayName: "Operatore",
      fullName: "Operatore",
    },
    startedAt,
  };
}

function NativePttHarness({
  slots,
  ptt,
  preparePttAudio,
  isChannelBusy,
  onBusyPrimaryChannel,
  startPtt,
  stopPtt,
  onMissingPrimaryChannel,
}: {
  slots: RadioSlots;
  ptt: RadioPttState;
  preparePttAudio: () => Promise<void>;
  isChannelBusy?: (channelId: string) => boolean;
  onBusyPrimaryChannel?: (channelId: string) => void;
  startPtt: (
    channelId: string,
    source: "volume-primary"
  ) => Promise<{ ok: true; txId: string; streamId: number; channelId: string; startedAt: number }>;
  stopPtt: () => void;
  onMissingPrimaryChannel?: () => void;
}) {
  useNativePrimaryPtt({
    slots,
    ptt,
    preparePttAudio,
    isChannelBusy,
    onBusyPrimaryChannel,
    startPtt,
    stopPtt,
    onMissingPrimaryChannel,
  });
  return null;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("radio priority", () => {
  it("resolves the primary channel from the first configured slot", () => {
    expect(resolvePrimaryRadioChannelId(["main", "bar", null])).toBe("main");
    expect(resolvePrimaryRadioChannelId([null, "bar", null])).toBeNull();
  });

  it("identifies primary streams by channel id", () => {
    expect(isPrimaryRadioStream(stream(1, "main", 1), "main")).toBe(true);
    expect(isPrimaryRadioStream(stream(1, "bar", 1), "main")).toBe(false);
    expect(isPrimaryRadioStream(stream(1, "main", 1), null)).toBe(false);
  });

  it("prefers the primary stream and otherwise selects the most recent stream", () => {
    const streams = [stream(1, "bar", 20), stream(2, "main", 10), stream(3, "sala", 30)];

    expect(chooseNextIncomingStream(streams, "main")?.streamId).toBe(2);
    expect(chooseNextIncomingStream(streams, null)?.streamId).toBe(3);
  });
});

describe("native primary PTT hook", () => {
  it("starts and stops Volume+ PTT on the primary slot only", async () => {
    const preparePttAudio = vi.fn().mockResolvedValue(undefined);
    const startPtt = vi.fn().mockResolvedValue({
      ok: true,
      txId: "tx",
      streamId: 12,
      channelId: "main",
      startedAt: 1000,
    });
    const stopPtt = vi.fn();
    const { rerender } = render(
      <NativePttHarness
        slots={["main", "bar", null]}
        ptt={{ mode: "idle" }}
        preparePttAudio={preparePttAudio}
        startPtt={startPtt}
        stopPtt={stopPtt}
      />
    );

    window.dispatchEvent(new CustomEvent("amalia:native-radio-ptt", { detail: { phase: "down" } }));
    await Promise.resolve();

    expect(preparePttAudio).toHaveBeenCalledTimes(1);
    expect(startPtt).toHaveBeenCalledWith("main", "volume-primary");

    rerender(
      <NativePttHarness
        slots={["main", "bar", null]}
        ptt={{
          mode: "transmitting",
          txId: "tx",
          streamId: 12,
          channelId: "main",
          startedAt: 1000,
          source: "volume-primary",
        }}
        preparePttAudio={preparePttAudio}
        startPtt={startPtt}
        stopPtt={stopPtt}
      />
    );

    window.dispatchEvent(new CustomEvent("amalia:native-radio-ptt", { detail: { phase: "up" } }));

    expect(stopPtt).toHaveBeenCalledTimes(1);
  });

  it("ignores Volume+ PTT when slot 1 is empty", async () => {
    const preparePttAudio = vi.fn().mockResolvedValue(undefined);
    const startPtt = vi.fn();
    const stopPtt = vi.fn();
    const onMissingPrimaryChannel = vi.fn();

    render(
      <NativePttHarness
        slots={[null, "bar", null]}
        ptt={{ mode: "idle" }}
        preparePttAudio={preparePttAudio}
        startPtt={startPtt}
        stopPtt={stopPtt}
        onMissingPrimaryChannel={onMissingPrimaryChannel}
      />
    );

    window.dispatchEvent(new CustomEvent("amalia:native-radio-ptt", { detail: { phase: "down" } }));
    await Promise.resolve();

    expect(preparePttAudio).not.toHaveBeenCalled();
    expect(startPtt).not.toHaveBeenCalled();
    expect(stopPtt).not.toHaveBeenCalled();
    expect(onMissingPrimaryChannel).toHaveBeenCalledTimes(1);
  });

  it("blocks Volume+ PTT before microphone preparation when the primary channel is busy", async () => {
    const preparePttAudio = vi.fn().mockResolvedValue(undefined);
    const startPtt = vi.fn();
    const stopPtt = vi.fn();
    const isChannelBusy = vi.fn(() => true);
    const onBusyPrimaryChannel = vi.fn();

    render(
      <NativePttHarness
        slots={["main", "bar", null]}
        ptt={{ mode: "idle" }}
        preparePttAudio={preparePttAudio}
        isChannelBusy={isChannelBusy}
        onBusyPrimaryChannel={onBusyPrimaryChannel}
        startPtt={startPtt}
        stopPtt={stopPtt}
      />
    );

    window.dispatchEvent(new CustomEvent("amalia:native-radio-ptt", { detail: { phase: "down" } }));
    await Promise.resolve();

    expect(isChannelBusy).toHaveBeenCalledWith("main");
    expect(onBusyPrimaryChannel).toHaveBeenCalledWith("main");
    expect(preparePttAudio).not.toHaveBeenCalled();
    expect(startPtt).not.toHaveBeenCalled();
    expect(stopPtt).not.toHaveBeenCalled();
  });
});
