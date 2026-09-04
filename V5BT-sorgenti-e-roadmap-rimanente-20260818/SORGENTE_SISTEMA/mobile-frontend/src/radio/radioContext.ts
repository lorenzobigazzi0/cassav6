import { createContext } from "react";
import type {
  IncomingRadioState,
  OutgoingRadioState,
  RadioChannel,
  RadioConnectionStatus,
  RadioPttSource,
  RadioPttState,
  RadioSlots,
  StartEchoResult,
  StartPttResult,
} from "./radioTypes";

export type RadioContextValue = {
  channels: RadioChannel[];
  slots: RadioSlots;
  activeSlots: RadioChannel[];
  status: RadioConnectionStatus;
  ptt: RadioPttState;
  incoming: IncomingRadioState | null;
  outgoing: OutgoingRadioState | null;
  audioLevels: number[];
  incomingAudioLevels: number[];
  isChannelBusy: (channelId: string) => boolean;
  saveSlots: (slots: RadioSlots) => Promise<void>;
  preparePttAudio: () => Promise<void>;
  startPtt: (channelId: string, source?: RadioPttSource) => Promise<StartPttResult>;
  stopPtt: () => void;
  startEchoTest: () => Promise<StartEchoResult>;
  stopEchoTest: () => void;
  refreshConfig: () => Promise<void>;
};

export const RadioContext = createContext<RadioContextValue | null>(null);
