import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchRadioConfig, saveRadioSlots } from "../api/radio";
import { subscribeMobileSessionEnding } from "../app/session/sessionLifecycle";
import { useAuthStore } from "../store/authStore";
import {
  createRadioAudioEngine,
  normalizeRadioAudioError,
  type RadioAudioEngine,
} from "./radioAudioEngine";
import { createRadioTxId, normalizeRadioSlots, resolveActiveRadioSlots } from "./radioProtocol";
import {
  chooseNextIncomingStream,
  isPrimaryRadioStream,
  resolvePrimaryRadioChannelId,
} from "./radioPriority";
import {
  RADIO_BUSY_TOTAL_MS,
  playRadioBotTone,
  playRadioEotTone,
  setRadioTonesEnabled,
  stopAllRadioTones,
} from "./radioGesture";
import { getRadioChannelColor } from "./radioUi";
import { createRadioPlaybackEngine, type RadioPlaybackEngine } from "./radioPlaybackEngine";
import { useNativePrimaryPtt } from "./useNativePrimaryPtt";
import type {
  IncomingRadioState,
  OutgoingRadioState,
  RadioAuthContext,
  RadioChannel,
  RadioConnectionStatus,
  RadioEchoGrantMessage,
  RadioPttSource,
  RadioPttGrantMessage,
  RadioPttState,
  RadioSlots,
  StartEchoResult,
  StartPttResult,
} from "./radioTypes";
import { RadioContext, type RadioContextValue } from "./radioContext";
import {
  createRadioWsClient,
  normalizeRadioErrorMessage,
  type RadioWsClient,
} from "./radioWsClient";

type PendingPttRequest = {
  txId: string;
  channelId: string;
  source: RadioPttSource;
  resolve: (result: StartPttResult) => void;
  timer: number;
};

type PendingEchoRequest = {
  txId: string;
  resolve: (result: StartEchoResult) => void;
  timer: number;
};

type EchoPlaybackBuffer = {
  streamId: number;
  frames: Uint8Array[];
};

const EMPTY_SLOTS: RadioSlots = [null, null, null];
const REQUEST_TIMEOUT_MS = 10000;
const ECHO_PLAYBACK_DELAY_MS = 80;
const PTT_TONE_CAPTURE_GUARD_MS = 0;
const ECHO_TONE_CAPTURE_GUARD_MS = 130;
const RX_EOT_TONE_DELAY_MS = 120;
const INCOMING_LEVEL_THROTTLE_MS = 40;

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function resolveAuthContext(): RadioAuthContext | null {
  const { token, userId, deviceUuid } = useAuthStore.getState();
  if (!token || !userId || !deviceUuid) return null;
  return {
    token,
    userId,
    deviceUuid,
    clientApp: "mobile-frontend",
  };
}

function clearPendingPtt(request: PendingPttRequest | null) {
  if (request) window.clearTimeout(request.timer);
}

function clearPendingEcho(request: PendingEchoRequest | null) {
  if (request) window.clearTimeout(request.timer);
}

function findIncomingStreamByChannel(streams: Map<number, IncomingRadioState>, channelId: string) {
  return [...streams.values()].find((stream) => stream.channelId === channelId) ?? null;
}

export function RadioProvider({ children }: { children: ReactNode }) {
  const token = useAuthStore((state) => state.token);
  const userId = useAuthStore((state) => state.userId);
  const deviceUuid = useAuthStore((state) => state.deviceUuid);
  const auth = useMemo<RadioAuthContext | null>(() => {
    if (!token || !userId || !deviceUuid) return null;
    return {
      token,
      userId,
      deviceUuid,
      clientApp: "mobile-frontend",
    };
  }, [deviceUuid, token, userId]);

  const clientRef = useRef<RadioWsClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = createRadioWsClient();
  }
  const captureEngineRef = useRef<RadioAudioEngine | null>(null);
  if (!captureEngineRef.current) {
    captureEngineRef.current = createRadioAudioEngine();
  }
  const playbackEngineRef = useRef<RadioPlaybackEngine | null>(null);
  if (!playbackEngineRef.current) {
    playbackEngineRef.current = createRadioPlaybackEngine();
  }

  const pendingPttRef = useRef<PendingPttRequest | null>(null);
  const pendingEchoRef = useRef<PendingEchoRequest | null>(null);
  const pttResetTimerRef = useRef<number | null>(null);
  const eotToneTimerRef = useRef<number | null>(null);
  const echoPlaybackBufferRef = useRef<EchoPlaybackBuffer | null>(null);
  const echoPlaybackStreamIdRef = useRef<number | null>(null);
  const incomingStreamsRef = useRef<Map<number, IncomingRadioState>>(new Map());
  const activeIncomingStreamIdRef = useRef<number | null>(null);
  const lastIncomingLevelAtRef = useRef(0);
  const primaryChannelIdRef = useRef<string | null>(null);
  const pttRef = useRef<RadioPttState>({ mode: "idle" });
  const [channels, setChannels] = useState<RadioChannel[]>([]);
  const [slots, setSlots] = useState<RadioSlots>(EMPTY_SLOTS);
  const [status, setStatus] = useState<RadioConnectionStatus>("disabled");
  const [ptt, setPtt] = useState<RadioPttState>({ mode: "idle" });
  const [incoming, setIncoming] = useState<IncomingRadioState | null>(null);
  const [audioLevels, setAudioLevels] = useState<number[]>([]);
  const [incomingAudioLevels, setIncomingAudioLevels] = useState<number[]>([]);
  const setPttState = useCallback((nextPtt: RadioPttState) => {
    pttRef.current = nextPtt;
    setPtt(nextPtt);
  }, []);

  const clearPttResetTimer = useCallback(() => {
    if (pttResetTimerRef.current !== null) {
      window.clearTimeout(pttResetTimerRef.current);
      pttResetTimerRef.current = null;
    }
  }, []);

  const clearEotToneTimer = useCallback(() => {
    if (eotToneTimerRef.current !== null) {
      window.clearTimeout(eotToneTimerRef.current);
      eotToneTimerRef.current = null;
    }
  }, []);

  const scheduleEotTone = useCallback(() => {
    clearEotToneTimer();
    eotToneTimerRef.current = window.setTimeout(() => {
      eotToneTimerRef.current = null;
      if (!useAuthStore.getState().token) return;
      playRadioEotTone();
    }, RX_EOT_TONE_DELAY_MS);
  }, [clearEotToneTimer]);

  const schedulePttIdleReset = useCallback(
    (delayMs: number) => {
      clearPttResetTimer();
      pttResetTimerRef.current = window.setTimeout(() => {
        pttResetTimerRef.current = null;
        const current = pttRef.current;
        if (current.mode === "busy" || current.mode === "error") {
          setPttState({ mode: "idle" });
        }
      }, delayMs);
    },
    [clearPttResetTimer, setPttState]
  );

  const isChannelBusy = useCallback((channelId: string) => {
    const normalizedChannelId = String(channelId ?? "").trim();
    if (!normalizedChannelId) return false;
    if (findIncomingStreamByChannel(incomingStreamsRef.current, normalizedChannelId)) {
      return true;
    }
    const current = pttRef.current;
    return (
      (current.mode === "requesting" || current.mode === "transmitting") &&
      current.channelId === normalizedChannelId
    );
  }, []);

  const markChannelBusy = useCallback(
    (channelId: string, activeSpeaker: IncomingRadioState["speaker"] | null = null) => {
      const normalizedChannelId = String(channelId ?? "").trim();
      if (!normalizedChannelId) return;
      setPttState({
        mode: "busy",
        txId: createRadioTxId("busy"),
        channelId: normalizedChannelId,
        activeSpeaker,
      });
      schedulePttIdleReset(RADIO_BUSY_TOTAL_MS);
    },
    [schedulePttIdleReset, setPttState]
  );

  const activeSlots = useMemo(() => resolveActiveRadioSlots(channels, slots), [channels, slots]);
  const primaryChannelId = useMemo(() => resolvePrimaryRadioChannelId(slots), [slots]);
  const outgoing = useMemo<OutgoingRadioState | null>(() => {
    if (ptt.mode !== "transmitting") return null;
    const channelIndex = Math.max(
      0,
      channels.findIndex((channel) => channel.id === ptt.channelId)
    );
    const channel = channels[channelIndex] ?? null;
    return {
      streamId: ptt.streamId,
      channelId: ptt.channelId,
      channelName: channel?.name || ptt.channelId || "Radio",
      channelColor: getRadioChannelColor(channel, channelIndex),
      startedAt: ptt.startedAt,
      source: ptt.source,
    };
  }, [channels, ptt]);

  useEffect(() => {
    pttRef.current = ptt;
  }, [ptt]);

  useEffect(() => {
    const client = clientRef.current;
    const captureEngine = captureEngineRef.current;
    const playbackEngine = playbackEngineRef.current;
    if (!client) return undefined;
    return () => {
      client.disconnect();
      void captureEngine?.dispose();
      void playbackEngine?.dispose();
      clearPendingPtt(pendingPttRef.current);
      clearPendingEcho(pendingEchoRef.current);
      pendingPttRef.current = null;
      pendingEchoRef.current = null;
      clearPttResetTimer();
      clearEotToneTimer();
      setRadioTonesEnabled(false);
      stopAllRadioTones();
      incomingStreamsRef.current.clear();
      activeIncomingStreamIdRef.current = null;
    };
  }, [clearEotToneTimer, clearPttResetTimer]);

  const pushAudioLevel = useCallback((level: number) => {
    const safeLevel = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
    setAudioLevels((current) => [safeLevel, ...current].slice(0, 32));
  }, []);

  const pushIncomingAudioLevel = useCallback((level: number) => {
    const now = performance.now();
    if (now - lastIncomingLevelAtRef.current < INCOMING_LEVEL_THROTTLE_MS) return;
    lastIncomingLevelAtRef.current = now;
    const safeLevel = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
    setIncomingAudioLevels((current) => [safeLevel, ...current].slice(0, 32));
  }, []);

  const stopCapture = useCallback(() => {
    captureEngineRef.current?.stopCapture();
    setAudioLevels([]);
  }, []);

  const unlockPlayback = useCallback(() => {
    void playbackEngineRef.current?.unlock().catch(() => undefined);
  }, []);

  const resetIncomingStreams = useCallback(() => {
    incomingStreamsRef.current.clear();
    activeIncomingStreamIdRef.current = null;
    lastIncomingLevelAtRef.current = 0;
    playbackEngineRef.current?.stopAll();
    setIncomingAudioLevels([]);
    setIncoming(null);
  }, []);

  const activateIncomingStream = useCallback((next: IncomingRadioState) => {
    const previousId = activeIncomingStreamIdRef.current;
    if (previousId !== null && previousId !== next.streamId) {
      playbackEngineRef.current?.stopStream(previousId);
    }

    for (const streamId of incomingStreamsRef.current.keys()) {
      if (streamId !== next.streamId) {
        playbackEngineRef.current?.stopStream(streamId);
      }
    }

    activeIncomingStreamIdRef.current = next.streamId;
    lastIncomingLevelAtRef.current = 0;
    setIncomingAudioLevels([]);
    void playbackEngineRef.current?.startStream(next.streamId).catch(() => undefined);
    playRadioBotTone();
    setIncoming(next);
  }, []);

  useEffect(() => {
    primaryChannelIdRef.current = primaryChannelId;
    const next = chooseNextIncomingStream(
      [...incomingStreamsRef.current.values()],
      primaryChannelId
    );
    if (
      next &&
      isPrimaryRadioStream(next, primaryChannelId) &&
      activeIncomingStreamIdRef.current !== next.streamId
    ) {
      activateIncomingStream(next);
    }
  }, [activateIncomingStream, primaryChannelId]);

  useEffect(() => {
    if (!auth) return undefined;
    const options: AddEventListenerOptions = { capture: true, passive: true };
    document.addEventListener("pointerdown", unlockPlayback, options);
    document.addEventListener("touchstart", unlockPlayback, options);
    document.addEventListener("click", unlockPlayback, options);
    document.addEventListener("keydown", unlockPlayback, options);
    return () => {
      document.removeEventListener("pointerdown", unlockPlayback, options);
      document.removeEventListener("touchstart", unlockPlayback, options);
      document.removeEventListener("click", unlockPlayback, options);
      document.removeEventListener("keydown", unlockPlayback, options);
    };
  }, [auth, unlockPlayback]);

  const clearEchoPlaybackBuffer = useCallback(() => {
    const buffer = echoPlaybackBufferRef.current;
    if (buffer) {
      playbackEngineRef.current?.stopStream(buffer.streamId);
    }
    if (echoPlaybackStreamIdRef.current !== null) {
      playbackEngineRef.current?.stopStream(echoPlaybackStreamIdRef.current);
      echoPlaybackStreamIdRef.current = null;
    }
    echoPlaybackBufferRef.current = null;
  }, []);

  useEffect(() => {
    setRadioTonesEnabled(Boolean(auth));
    if (!auth) stopAllRadioTones();
  }, [auth]);

  useEffect(
    () =>
      subscribeMobileSessionEnding(() => {
        clearEotToneTimer();
        clearPttResetTimer();
        setRadioTonesEnabled(false);
        stopAllRadioTones();
        clearPendingPtt(pendingPttRef.current);
        clearPendingEcho(pendingEchoRef.current);
        pendingPttRef.current?.resolve({ ok: false, reason: "disabled" });
        pendingEchoRef.current?.resolve({ ok: false, reason: "disabled" });
        pendingPttRef.current = null;
        pendingEchoRef.current = null;
        clientRef.current?.disconnect();
        stopCapture();
        clearEchoPlaybackBuffer();
        resetIncomingStreams();
        void captureEngineRef.current?.dispose();
        void playbackEngineRef.current?.dispose();
        setChannels([]);
        setSlots(EMPTY_SLOTS);
        setPttState({ mode: "idle" });
        setStatus("disabled");
      }),
    [
      clearEchoPlaybackBuffer,
      clearEotToneTimer,
      clearPttResetTimer,
      resetIncomingStreams,
      setPttState,
      stopCapture,
    ]
  );

  const playBufferedEcho = useCallback((streamId?: number) => {
    const buffer = echoPlaybackBufferRef.current;
    if (!buffer || (streamId !== undefined && buffer.streamId !== streamId)) {
      if (streamId !== undefined) playbackEngineRef.current?.stopStream(streamId);
      return;
    }

    echoPlaybackBufferRef.current = null;
    echoPlaybackStreamIdRef.current = buffer.streamId;
    playbackEngineRef.current?.playBufferedFrames(
      buffer.streamId,
      buffer.frames,
      ECHO_PLAYBACK_DELAY_MS
    );
  }, []);

  const startGrantedPttCapture = useCallback(
    async (message: RadioPttGrantMessage, pending: PendingPttRequest) => {
      try {
        playRadioBotTone();
        if (PTT_TONE_CAPTURE_GUARD_MS > 0) {
          await wait(PTT_TONE_CAPTURE_GUARD_MS);
        }
        const currentBeforeCapture = pttRef.current;
        if (
          currentBeforeCapture.mode !== "requesting" ||
          currentBeforeCapture.txId !== message.txId
        ) {
          pending.resolve({ ok: false, reason: "error", message: "PTT annullato." });
          return;
        }
        await captureEngineRef.current?.startCapture({
          streamId: message.streamId,
          onFrame: (frame) => {
            clientRef.current?.sendAudioFrame(frame);
          },
          onLevel: pushAudioLevel,
        });
        const currentAfterCapture = pttRef.current;
        if (
          currentAfterCapture.mode !== "requesting" ||
          currentAfterCapture.txId !== message.txId
        ) {
          stopCapture();
          clientRef.current?.stopPtt(message.txId);
          pending.resolve({ ok: false, reason: "error", message: "PTT annullato." });
          return;
        }
        const nextPtt: RadioPttState = {
          mode: "transmitting",
          txId: message.txId,
          streamId: message.streamId,
          channelId: message.channelId,
          startedAt: message.startedAt,
          source: pending.source,
        };
        setPttState(nextPtt);
        pending.resolve({
          ok: true,
          txId: message.txId,
          streamId: message.streamId,
          channelId: message.channelId,
          startedAt: message.startedAt,
        });
      } catch (error) {
        const messageText = normalizeRadioAudioError(error);
        stopCapture();
        clientRef.current?.stopPtt(message.txId);
        setAudioLevels([]);
        setPttState({ mode: "error", message: messageText });
        pending.resolve({ ok: false, reason: "error", message: messageText });
      }
    },
    [pushAudioLevel, setPttState, stopCapture]
  );

  const startGrantedEchoCapture = useCallback(
    async (message: RadioEchoGrantMessage, pending: PendingEchoRequest) => {
      try {
        clearEchoPlaybackBuffer();
        echoPlaybackBufferRef.current = {
          streamId: message.streamId,
          frames: [],
        };
        setPttState({
          mode: "echo",
          txId: message.txId,
          streamId: message.streamId,
          startedAt: message.startedAt,
        });
        playRadioBotTone();
        await wait(ECHO_TONE_CAPTURE_GUARD_MS);
        const currentBeforeCapture = pttRef.current;
        if (currentBeforeCapture.mode !== "echo" || currentBeforeCapture.txId !== message.txId) {
          pending.resolve({ ok: false, reason: "error", message: "Echo test annullato." });
          return;
        }
        await captureEngineRef.current?.startCapture({
          streamId: message.streamId,
          onFrame: (frame) => {
            clientRef.current?.sendAudioFrame(frame);
          },
          onLevel: pushAudioLevel,
        });
        const currentAfterCapture = pttRef.current;
        if (currentAfterCapture.mode !== "echo" || currentAfterCapture.txId !== message.txId) {
          stopCapture();
          clientRef.current?.stopEcho(message.txId);
          pending.resolve({ ok: false, reason: "error", message: "Echo test annullato." });
          return;
        }
        pending.resolve({
          ok: true,
          txId: message.txId,
          streamId: message.streamId,
          startedAt: message.startedAt,
        });
      } catch (error) {
        stopCapture();
        clearEchoPlaybackBuffer();
        const messageText = normalizeRadioAudioError(error);
        clientRef.current?.stopEcho(message.txId);
        setAudioLevels([]);
        setPttState({ mode: "error", message: messageText });
        pending.resolve({ ok: false, reason: "error", message: messageText });
      }
    },
    [clearEchoPlaybackBuffer, pushAudioLevel, setPttState, stopCapture]
  );

  useEffect(() => {
    const client = clientRef.current;
    if (!client) return undefined;
    const unsubscribe = [
      client.on("status", (event) => setStatus(event.status)),
      client.on("pttGrant", (message) => {
        const pending = pendingPttRef.current;
        if (pending?.txId !== message.txId) return;
        clearPendingPtt(pending);
        pendingPttRef.current = null;
        void startGrantedPttCapture(message, pending);
      }),
      client.on("pttBusy", (message) => {
        stopCapture();
        const pending = pendingPttRef.current;
        if (pending?.txId === message.txId) {
          clearPendingPtt(pending);
          pendingPttRef.current = null;
          pending.resolve({
            ok: false,
            reason: "busy",
            message: message.message || "Canale occupato",
            activeSpeaker: message.activeSpeaker ?? null,
          });
        }
        setPttState({
          mode: "busy",
          txId: message.txId,
          channelId: message.channelId,
          activeSpeaker: message.activeSpeaker ?? null,
        });
        schedulePttIdleReset(RADIO_BUSY_TOTAL_MS);
      }),
      client.on("incomingStart", (message) => {
        const next: IncomingRadioState = {
          streamId: message.streamId,
          channelId: message.channelId,
          channelName: message.channelName,
          channelColor: message.channelColor,
          speaker: message.speaker,
          startedAt: message.startedAt,
        };
        incomingStreamsRef.current.set(next.streamId, next);

        const primary = primaryChannelIdRef.current;
        const activeId = activeIncomingStreamIdRef.current;
        const active =
          activeId !== null ? (incomingStreamsRef.current.get(activeId) ?? null) : null;

        if (isPrimaryRadioStream(next, primary)) {
          activateIncomingStream(next);
          return;
        }

        if (!active) {
          activateIncomingStream(next);
          return;
        }

        if (isPrimaryRadioStream(active, primary)) {
          return;
        }

        // Another secondary stream is already audible. Keep it until it ends.
      }),
      client.on("incomingStop", (message) => {
        incomingStreamsRef.current.delete(message.streamId);
        playbackEngineRef.current?.stopStream(message.streamId);
        if (activeIncomingStreamIdRef.current !== message.streamId) {
          return;
        }

        scheduleEotTone();
        activeIncomingStreamIdRef.current = null;
        lastIncomingLevelAtRef.current = 0;
        const next = chooseNextIncomingStream(
          [...incomingStreamsRef.current.values()],
          primaryChannelIdRef.current
        );
        if (next) {
          activateIncomingStream(next);
          return;
        }
        setIncomingAudioLevels([]);
        setIncoming(null);
      }),
      client.on("echoGrant", (message) => {
        const pending = pendingEchoRef.current;
        if (pending?.txId !== message.txId) return;
        clearPendingEcho(pending);
        pendingEchoRef.current = null;
        void startGrantedEchoCapture(message, pending);
      }),
      client.on("echoStop", (message) => {
        stopCapture();
        playBufferedEcho(message.streamId);
        setPttState({ mode: "idle" });
      }),
      client.on("error", (message) => {
        stopCapture();
        clearEchoPlaybackBuffer();
        const errorMessage = normalizeRadioErrorMessage(message);
        const pttPending = pendingPttRef.current;
        const echoPending = pendingEchoRef.current;
        if (pttPending && (!message.txId || message.txId === pttPending.txId)) {
          clearPendingPtt(pttPending);
          pendingPttRef.current = null;
          pttPending.resolve({ ok: false, reason: "error", message: errorMessage });
        }
        if (echoPending && (!message.txId || message.txId === echoPending.txId)) {
          clearPendingEcho(echoPending);
          pendingEchoRef.current = null;
          echoPending.resolve({ ok: false, reason: "error", message: errorMessage });
        }
        setPttState({ mode: "error", message: errorMessage, code: message.code });
      }),
      client.on("audioFrame", (message) => {
        const echoBuffer = echoPlaybackBufferRef.current;
        if (echoBuffer?.streamId === message.streamId) {
          echoBuffer.frames.push(new Uint8Array(message.frame));
          return;
        }
        if (message.streamId !== activeIncomingStreamIdRef.current) {
          return;
        }
        void playbackEngineRef.current
          ?.enqueueFrame(message.frame, { onLevel: pushIncomingAudioLevel })
          .catch(() => undefined);
      }),
    ];
    return () => unsubscribe.forEach((dispose) => dispose());
  }, [
    clearEchoPlaybackBuffer,
    activateIncomingStream,
    playBufferedEcho,
    pushIncomingAudioLevel,
    setPttState,
    startGrantedEchoCapture,
    startGrantedPttCapture,
    stopCapture,
    schedulePttIdleReset,
    scheduleEotTone,
  ]);

  const refreshConfig = useCallback(async () => {
    const currentAuth = resolveAuthContext();
    if (!currentAuth) {
      setChannels([]);
      setSlots(EMPTY_SLOTS);
      setStatus("disabled");
      return;
    }
    const config = await fetchRadioConfig(currentAuth);
    setChannels(config.channels);
    setSlots(normalizeRadioSlots(config.slots));
    const activeChannelIds = resolveActiveRadioSlots(config.channels, config.slots).map(
      (channel) => channel.id
    );
    clientRef.current?.subscribe(activeChannelIds);
  }, []);

  useEffect(() => {
    const client = clientRef.current;
    if (!client) return undefined;
    if (!auth) {
      client.disconnect();
      stopCapture();
      clearEchoPlaybackBuffer();
      resetIncomingStreams();
      setChannels([]);
      setSlots(EMPTY_SLOTS);
      setPttState({ mode: "idle" });
      setStatus("disabled");
      return undefined;
    }

    let disposed = false;
    setStatus("connecting");
    fetchRadioConfig(auth)
      .then((config) => {
        if (disposed) return;
        const safeSlots = normalizeRadioSlots(config.slots);
        setChannels(config.channels);
        setSlots(safeSlots);
        const activeChannelIds = resolveActiveRadioSlots(config.channels, safeSlots).map(
          (channel) => channel.id
        );
        client.connect(auth, activeChannelIds);
      })
      .catch((error) => {
        if (disposed) return;
        setStatus("error");
        setPttState({
          mode: "error",
          message: error instanceof Error ? error.message : "Configurazione radio non disponibile.",
        });
      });

    return () => {
      disposed = true;
      stopCapture();
      incomingStreamsRef.current.clear();
      activeIncomingStreamIdRef.current = null;
      setIncomingAudioLevels([]);
      playbackEngineRef.current?.stopAll();
      client.disconnect();
    };
  }, [auth, clearEchoPlaybackBuffer, resetIncomingStreams, setPttState, stopCapture]);

  useEffect(() => {
    clientRef.current?.subscribe(activeSlots.map((channel) => channel.id));
  }, [activeSlots]);

  const handleSaveSlots = useCallback(async (nextSlots: RadioSlots) => {
    const currentAuth = resolveAuthContext();
    if (!currentAuth) return;
    const config = await saveRadioSlots(currentAuth, normalizeRadioSlots(nextSlots));
    const safeSlots = normalizeRadioSlots(config.slots);
    setChannels(config.channels);
    setSlots(safeSlots);
    const activeChannelIds = resolveActiveRadioSlots(config.channels, safeSlots).map(
      (channel) => channel.id
    );
    clientRef.current?.subscribe(activeChannelIds);
  }, []);

  const preparePttAudio = useCallback(async () => {
    if (!auth) return;
    unlockPlayback();
    try {
      await captureEngineRef.current?.prepareCapture();
    } catch (error) {
      const messageText = normalizeRadioAudioError(error);
      if (messageText === "Richiesta microfono annullata.") return;
    }
  }, [auth, unlockPlayback]);

  const startPtt = useCallback(
    (channelId: string, source: RadioPttSource = "bottom-bar"): Promise<StartPttResult> => {
      if (!auth) return Promise.resolve({ ok: false, reason: "disabled" });
      const normalizedChannelId = String(channelId ?? "").trim();
      const busyStream = findIncomingStreamByChannel(
        incomingStreamsRef.current,
        normalizedChannelId
      );
      if (busyStream) {
        markChannelBusy(normalizedChannelId, busyStream.speaker);
        return Promise.resolve({
          ok: false,
          reason: "busy",
          message: "Canale occupato",
          activeSpeaker: busyStream.speaker,
        });
      }
      const client = clientRef.current;
      if (!client || client.getStatus() !== "ready") {
        stopCapture();
        return Promise.resolve({ ok: false, reason: "not_ready" });
      }
      unlockPlayback();
      const txId = createRadioTxId("tx");
      const sentTxId = client.startPtt(normalizedChannelId, txId);
      if (!sentTxId) {
        stopCapture();
        return Promise.resolve({ ok: false, reason: "not_ready" });
      }
      setPttState({ mode: "requesting", txId, channelId: normalizedChannelId, source });
      return new Promise<StartPttResult>((resolve) => {
        clearPendingPtt(pendingPttRef.current);
        const timer = window.setTimeout(() => {
          if (pendingPttRef.current?.txId !== txId) return;
          pendingPttRef.current = null;
          stopCapture();
          setPttState({ mode: "error", message: "Timeout richiesta radio." });
          resolve({ ok: false, reason: "error", message: "Timeout richiesta radio." });
        }, REQUEST_TIMEOUT_MS);
        pendingPttRef.current = {
          txId,
          channelId: normalizedChannelId,
          source,
          resolve,
          timer,
        };
      });
    },
    [auth, markChannelBusy, setPttState, stopCapture, unlockPlayback]
  );

  const stopPtt = useCallback(() => {
    const current = pttRef.current;
    const pending = pendingPttRef.current;
    if (pending) {
      clearPendingPtt(pending);
      pendingPttRef.current = null;
      pending.resolve({ ok: false, reason: "error", message: "PTT annullato." });
    }
    stopCapture();
    if (current.mode === "transmitting" || current.mode === "requesting") {
      clientRef.current?.stopPtt(current.txId);
    }
    if (current.mode === "transmitting") {
      playRadioEotTone();
    }
    setPttState({ mode: "idle" });
  }, [setPttState, stopCapture]);

  const startEchoTest = useCallback((): Promise<StartEchoResult> => {
    if (!auth) return Promise.resolve({ ok: false, reason: "disabled" });
    const client = clientRef.current;
    if (!client || client.getStatus() !== "ready") {
      stopCapture();
      return Promise.resolve({ ok: false, reason: "not_ready" });
    }
    unlockPlayback();
    void captureEngineRef.current?.prepareCapture().catch(() => undefined);
    const txId = createRadioTxId("echo");
    clearEchoPlaybackBuffer();
    const sentTxId = client.startEcho(txId);
    if (!sentTxId) {
      stopCapture();
      return Promise.resolve({ ok: false, reason: "not_ready" });
    }
    return new Promise<StartEchoResult>((resolve) => {
      clearPendingEcho(pendingEchoRef.current);
      const timer = window.setTimeout(() => {
        if (pendingEchoRef.current?.txId !== txId) return;
        pendingEchoRef.current = null;
        stopCapture();
        clearEchoPlaybackBuffer();
        setPttState({ mode: "error", message: "Timeout echo test." });
        resolve({ ok: false, reason: "error", message: "Timeout echo test." });
      }, REQUEST_TIMEOUT_MS);
      pendingEchoRef.current = {
        txId,
        resolve,
        timer,
      };
    });
  }, [auth, clearEchoPlaybackBuffer, setPttState, stopCapture, unlockPlayback]);

  const stopEchoTest = useCallback(() => {
    const pending = pendingEchoRef.current;
    if (pending) {
      clearPendingEcho(pending);
      pendingEchoRef.current = null;
      pending.resolve({ ok: false, reason: "error", message: "Echo test annullato." });
    }
    const current = pttRef.current;
    stopCapture();
    if (current.mode === "echo") {
      clientRef.current?.stopEcho(current.txId);
      playRadioEotTone();
    }
    setPttState({ mode: "idle" });
  }, [setPttState, stopCapture]);

  const handleMissingPrimaryChannel = useCallback(() => {
    setPttState({
      mode: "error",
      message: "Canale primario non configurato.",
    });
  }, [setPttState]);

  const handleBusyPrimaryChannel = useCallback(
    (channelId: string) => {
      const speaker =
        findIncomingStreamByChannel(incomingStreamsRef.current, channelId)?.speaker ?? null;
      markChannelBusy(channelId, speaker);
    },
    [markChannelBusy]
  );

  useNativePrimaryPtt({
    slots,
    ptt,
    preparePttAudio,
    isChannelBusy,
    onBusyPrimaryChannel: handleBusyPrimaryChannel,
    startPtt,
    stopPtt,
    onMissingPrimaryChannel: handleMissingPrimaryChannel,
  });

  const value = useMemo<RadioContextValue>(
    () => ({
      channels,
      slots,
      activeSlots,
      status,
      ptt,
      incoming,
      outgoing,
      audioLevels,
      incomingAudioLevels,
      isChannelBusy,
      saveSlots: handleSaveSlots,
      preparePttAudio,
      startPtt,
      stopPtt,
      startEchoTest,
      stopEchoTest,
      refreshConfig,
    }),
    [
      activeSlots,
      audioLevels,
      channels,
      handleSaveSlots,
      incomingAudioLevels,
      isChannelBusy,
      incoming,
      outgoing,
      ptt,
      preparePttAudio,
      refreshConfig,
      slots,
      startEchoTest,
      startPtt,
      status,
      stopEchoTest,
      stopPtt,
    ]
  );

  return <RadioContext.Provider value={value}>{children}</RadioContext.Provider>;
}
