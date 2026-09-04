import { useEffect, useRef } from "react";
import { resolvePrimaryRadioChannelId } from "./radioPriority";
import type { RadioPttState, RadioSlots, StartPttResult } from "./radioTypes";

type NativeRadioPttDetail = {
  phase?: "down" | "up" | "cancel";
  key?: string;
  source?: string;
  ts?: number;
};

type NativeRadioPttEvent = CustomEvent<NativeRadioPttDetail>;

type UseNativePrimaryPttOptions = {
  slots: RadioSlots;
  ptt: RadioPttState;
  preparePttAudio: () => Promise<void>;
  isChannelBusy?: (channelId: string) => boolean;
  onBusyPrimaryChannel?: (channelId: string) => void;
  startPtt: (channelId: string, source: "volume-primary") => Promise<StartPttResult>;
  stopPtt: () => void;
  onMissingPrimaryChannel?: () => void;
};

export function useNativePrimaryPtt({
  slots,
  ptt,
  preparePttAudio,
  isChannelBusy,
  onBusyPrimaryChannel,
  startPtt,
  stopPtt,
  onMissingPrimaryChannel,
}: UseNativePrimaryPttOptions) {
  const nativePttActiveRef = useRef(false);
  const slotsRef = useRef(slots);
  const pttRef = useRef(ptt);

  useEffect(() => {
    slotsRef.current = slots;
  }, [slots]);

  useEffect(() => {
    pttRef.current = ptt;
  }, [ptt]);

  useEffect(() => {
    const handleNativePtt = (event: Event) => {
      const detail = (event as NativeRadioPttEvent).detail ?? {};
      const phase = detail.phase;

      if (phase === "down") {
        if (nativePttActiveRef.current) return;
        const primaryChannelId = resolvePrimaryRadioChannelId(slotsRef.current);
        if (!primaryChannelId) {
          onMissingPrimaryChannel?.();
          return;
        }
        if (isChannelBusy?.(primaryChannelId)) {
          onBusyPrimaryChannel?.(primaryChannelId);
          return;
        }
        nativePttActiveRef.current = true;
        void preparePttAudio().catch(() => undefined);
        void startPtt(primaryChannelId, "volume-primary").then((result) => {
          if (!result.ok) {
            nativePttActiveRef.current = false;
          }
        });
        return;
      }

      if (phase === "up" || phase === "cancel") {
        if (!nativePttActiveRef.current) return;
        nativePttActiveRef.current = false;
        const current = pttRef.current;
        if (
          (current.mode === "requesting" || current.mode === "transmitting") &&
          current.source === "volume-primary"
        ) {
          stopPtt();
        }
      }
    };

    window.addEventListener("amalia:native-radio-ptt", handleNativePtt);
    return () => {
      window.removeEventListener("amalia:native-radio-ptt", handleNativePtt);
    };
  }, [
    isChannelBusy,
    onBusyPrimaryChannel,
    onMissingPrimaryChannel,
    preparePttAudio,
    startPtt,
    stopPtt,
  ]);
}
