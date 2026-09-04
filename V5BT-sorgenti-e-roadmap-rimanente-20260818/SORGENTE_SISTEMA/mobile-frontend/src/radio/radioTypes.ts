export type RadioSlot = string | null;
export type RadioSlots = [RadioSlot, RadioSlot, RadioSlot];

export type RadioAuthContext = {
  token: string;
  userId: string;
  deviceUuid: string;
  clientApp?: string;
};

export type RadioChannel = {
  id: string;
  name: string;
  enabled: boolean;
  color: string;
  sortOrder: number;
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
};

export type RadioPreference = {
  id: string;
  userId: string;
  deviceUuid: string;
  slots: RadioSlots;
  updatedAt: string;
  updatedBy?: string;
};

export type RadioConfigResponse = {
  ok: true;
  channels: RadioChannel[];
  slots: RadioSlots;
  preference: RadioPreference;
  lastWriteAt?: string;
  version?: number;
};

export type RadioConnectionStatus =
  | "disabled"
  | "disconnected"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "error";

export type RadioSpeaker = {
  userId: string;
  displayName: string;
  fullName: string;
};

export type IncomingRadioState = {
  streamId: number;
  channelId: string;
  channelName: string;
  channelColor: string;
  speaker: RadioSpeaker;
  startedAt: number;
};

export type OutgoingRadioState = {
  streamId: number;
  channelId: string;
  channelName: string;
  channelColor: string;
  startedAt: number;
  source: RadioPttSource;
};

export type RadioPttState =
  | { mode: "idle" }
  | { mode: "requesting"; txId: string; channelId: string; source: RadioPttSource }
  | { mode: "transmitting"; txId: string; streamId: number; channelId: string; startedAt: number; source: RadioPttSource }
  | { mode: "busy"; txId: string; channelId: string; activeSpeaker: RadioSpeaker | null }
  | { mode: "echo"; txId: string; streamId: number; startedAt: number }
  | { mode: "error"; message: string; code?: string };

export type RadioPttSource = "bottom-bar" | "radio-page" | "test" | "volume-primary";

export type StartPttResult =
  | { ok: true; txId: string; streamId: number; channelId: string; startedAt: number }
  | { ok: false; reason: "disabled" | "not_ready" | "busy" | "error"; message?: string; activeSpeaker?: RadioSpeaker | null };

export type StartEchoResult =
  | { ok: true; txId: string; streamId: number; startedAt: number }
  | { ok: false; reason: "disabled" | "not_ready" | "error"; message?: string };

export type RadioReadyMessage = {
  type: "ready";
  protocolVersion: number;
  clientId: string;
  serverTime: number;
  limits: RadioLimits;
};

export type RadioLimits = {
  sampleRate: number;
  frameMs: number;
  codec: "mulaw";
  maxFrameBytes: number;
  maxBufferedBytes: number;
};

export type RadioSubscribedMessage = {
  type: "subscribed";
  channelIds: string[];
};

export type RadioPttGrantMessage = {
  type: "ptt:grant";
  txId: string;
  streamId: number;
  channelId: string;
  startedAt: number;
};

export type RadioPttBusyMessage = {
  type: "ptt:busy";
  txId: string;
  channelId: string;
  activeSpeaker?: RadioSpeaker;
  message?: string;
};

export type RadioIncomingStartMessage = {
  type: "ptt:incoming-start";
  streamId: number;
  channelId: string;
  channelName: string;
  channelColor: string;
  speaker: RadioSpeaker;
  codec: "mulaw";
  sampleRate: number;
  frameMs: number;
  startedAt: number;
};

export type RadioIncomingStopMessage = {
  type: "ptt:incoming-stop";
  streamId: number;
  channelId: string;
  stoppedAt: number;
  reason: "speaker_stop" | "socket_closed" | "idle_timeout" | "server_shutdown" | "error" | string;
};

export type RadioEchoGrantMessage = {
  type: "echo:grant";
  txId: string;
  streamId: number;
  startedAt: number;
};

export type RadioEchoStopMessage = {
  type: "echo:stop";
  txId: string;
  streamId?: number;
  stoppedAt?: number;
  reason?: string;
};

export type RadioErrorMessage = {
  type: "error";
  code: string;
  message: string;
  txId?: string;
  channelId?: string;
};

export type RadioServerJsonMessage =
  | RadioReadyMessage
  | RadioSubscribedMessage
  | RadioPttGrantMessage
  | RadioPttBusyMessage
  | RadioIncomingStartMessage
  | RadioIncomingStopMessage
  | RadioEchoGrantMessage
  | RadioEchoStopMessage
  | RadioErrorMessage;

export type RadioClientEvents = {
  status: { status: RadioConnectionStatus; error?: string };
  ready: RadioReadyMessage;
  subscribed: RadioSubscribedMessage;
  pttGrant: RadioPttGrantMessage;
  pttBusy: RadioPttBusyMessage;
  incomingStart: RadioIncomingStartMessage;
  incomingStop: RadioIncomingStopMessage;
  echoGrant: RadioEchoGrantMessage;
  echoStop: RadioEchoStopMessage;
  error: RadioErrorMessage;
  audioFrame: { streamId: number; frame: Uint8Array };
};
