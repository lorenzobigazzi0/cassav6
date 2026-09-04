import { decodeRadioFrame, RADIO_FRAME_LIMITS } from "./radioProtocol";
import { calculatePcmLevel, decodeMuLaw } from "./mulaw";
import { resampleLinear } from "./resample";

const PLAYBACK_WORKLET_FILE = "radio-playback-worklet.js";
const STREAM_DRAIN_MS = 360;
const IDLE_SUSPEND_MS = 360;
const PLAYBACK_JITTER_BUFFER_MS = 80;
const PLAYBACK_REBUFFER_MS = 80;

type PlaybackStream = {
  node: AudioWorkletNode;
  gain: GainNode;
  closeTimer: number | null;
};

type AudioContextConstructor = typeof AudioContext;
type AudioContextScope = typeof globalThis & {
  webkitAudioContext?: AudioContextConstructor;
};

function getAudioContextConstructor(): AudioContextConstructor | null {
  const scope = (typeof window !== "undefined" ? window : globalThis) as AudioContextScope;
  return scope.AudioContext || scope.webkitAudioContext || null;
}

function publicWorkletUrl(fileName: string) {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");
  return `${base}/${fileName.replace(/^\/+/, "")}`;
}

export class RadioPlaybackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RadioPlaybackError";
  }
}

export class RadioPlaybackEngine {
  private context: AudioContext | null = null;
  private workletLoaded = false;
  private workletLoadPromise: Promise<void> | null = null;
  private streams = new Map<number, PlaybackStream>();
  private streamCreationPromises = new Map<number, Promise<PlaybackStream>>();
  private lastFrameSeqByStream = new Map<number, number>();
  private delayedPlaybackTimers = new Map<number, number>();
  private delayedStopTimers = new Map<number, number>();
  private idleSuspendTimer: number | null = null;
  private hasUnlockedPlayback = false;

  async unlock() {
    if (
      this.hasUnlockedPlayback &&
      this.context &&
      this.context.state !== "closed" &&
      this.streams.size === 0 &&
      this.delayedPlaybackTimers.size === 0
    ) {
      return;
    }
    const context = await this.ensureBaseAudioContext();
    this.playSilentUnlockBuffer(context);
    await this.ensurePlaybackWorklet(context);
    if (context.state === "suspended") {
      await context.resume();
    }
    this.hasUnlockedPlayback = true;
    this.scheduleIdleSuspend();
  }

  async startStream(streamId: number) {
    await this.ensureStream(streamId);
  }

  async enqueueFrame(frame: Uint8Array, options: { onLevel?: (level: number) => void } = {}) {
    const decoded = decodeRadioFrame(frame);
    if (!decoded) return false;
    if (this.isDuplicateOrStaleFrame(decoded.streamId, decoded.seq)) return false;
    const stream = await this.ensureStream(decoded.streamId);
    const pcm = decodeMuLaw(decoded.payload);
    const level = calculatePcmLevel(pcm);
    const outputSampleRate = this.context?.sampleRate || RADIO_FRAME_LIMITS.sampleRate;
    const outputPcm = resampleLinear(pcm, RADIO_FRAME_LIMITS.sampleRate, outputSampleRate);
    stream.node.port.postMessage(
      {
        type: "enqueue",
        pcm: outputPcm,
        level,
      },
      [outputPcm.buffer]
    );
    options.onLevel?.(level);
    this.unmuteStream(stream);
    return true;
  }

  playBufferedFrames(streamId: number, frames: Uint8Array[], delayMs = 0) {
    this.cancelScheduledPlayback(streamId);
    const bufferedFrames = frames.map((frame) => new Uint8Array(frame));
    if (bufferedFrames.length === 0) return;

    const startPlayback = () => {
      this.delayedPlaybackTimers.delete(streamId);
      void (async () => {
        for (const frame of bufferedFrames) {
          await this.enqueueFrame(frame);
        }
        const stopDelayMs =
          bufferedFrames.length * RADIO_FRAME_LIMITS.frameMs + STREAM_DRAIN_MS + 60;
        const stopTimer = window.setTimeout(() => {
          this.delayedStopTimers.delete(streamId);
          this.stopStream(streamId);
        }, stopDelayMs);
        this.delayedStopTimers.set(streamId, stopTimer);
      })().catch(() => {
        this.stopStream(streamId);
      });
    };

    if (delayMs <= 0) {
      startPlayback();
      return;
    }

    const timer = window.setTimeout(startPlayback, delayMs);
    this.delayedPlaybackTimers.set(streamId, timer);
  }

  stopStream(streamId: number) {
    this.cancelScheduledPlayback(streamId);
    const stream = this.streams.get(streamId);
    if (!stream) {
      const pending = this.streamCreationPromises.get(streamId);
      if (pending) {
        void pending.then(() => this.stopStream(streamId)).catch(() => this.scheduleIdleSuspend());
        return;
      }
      this.scheduleIdleSuspend();
      return;
    }
    stream.node.port.postMessage({ type: "stop" });
    if (stream.closeTimer !== null) {
      window.clearTimeout(stream.closeTimer);
    }
    stream.closeTimer = window.setTimeout(() => {
      stream.node.port.close();
      stream.node.disconnect();
      stream.gain.disconnect();
      this.streams.delete(streamId);
      this.lastFrameSeqByStream.delete(streamId);
      this.scheduleIdleSuspend();
    }, STREAM_DRAIN_MS);
  }

  stopAll() {
    const streamIds = new Set([
      ...this.streams.keys(),
      ...this.streamCreationPromises.keys(),
      ...this.delayedPlaybackTimers.keys(),
      ...this.delayedStopTimers.keys(),
    ]);
    for (const streamId of streamIds) {
      this.stopStream(streamId);
    }
  }

  private cancelScheduledPlayback(streamId: number) {
    const playbackTimer = this.delayedPlaybackTimers.get(streamId);
    if (playbackTimer !== undefined) {
      window.clearTimeout(playbackTimer);
      this.delayedPlaybackTimers.delete(streamId);
    }

    const stopTimer = this.delayedStopTimers.get(streamId);
    if (stopTimer !== undefined) {
      window.clearTimeout(stopTimer);
      this.delayedStopTimers.delete(streamId);
    }
  }

  async dispose() {
    this.stopAll();
    if (this.context) {
      this.cancelIdleSuspend();
      await this.context.close().catch(() => undefined);
      this.context = null;
      this.workletLoaded = false;
      this.workletLoadPromise = null;
      this.hasUnlockedPlayback = false;
    }
  }

  private async ensureStream(streamId: number) {
    const existing = this.streams.get(streamId);
    if (existing) {
      if (existing.closeTimer !== null) {
        window.clearTimeout(existing.closeTimer);
        existing.closeTimer = null;
      }
      return existing;
    }

    const pending = this.streamCreationPromises.get(streamId);
    if (pending) return pending;

    const creation = (async () => {
      const context = await this.ensureAudioContext();
      const node = new AudioWorkletNode(context, "radio-playback-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          jitterSamples: Math.round((context.sampleRate * PLAYBACK_JITTER_BUFFER_MS) / 1000),
          rebufferSamples: Math.round((context.sampleRate * PLAYBACK_REBUFFER_MS) / 1000),
        },
      });
      const gain = context.createGain();
      gain.gain.value = 0;
      node.connect(gain);
      gain.connect(context.destination);
      const stream = { node, gain, closeTimer: null };
      this.streams.set(streamId, stream);
      return stream;
    })();
    this.streamCreationPromises.set(streamId, creation);
    try {
      return await creation;
    } finally {
      if (this.streamCreationPromises.get(streamId) === creation) {
        this.streamCreationPromises.delete(streamId);
      }
    }
  }

  private async ensureBaseAudioContext() {
    const AudioContextClass = getAudioContextConstructor();
    if (!AudioContextClass || typeof AudioWorkletNode === "undefined") {
      throw new RadioPlaybackError("AudioWorklet non supportato da questo browser.");
    }

    this.cancelIdleSuspend();

    if (!this.context || this.context.state === "closed") {
      this.context = new AudioContextClass({ latencyHint: "interactive" });
      this.workletLoaded = false;
      this.hasUnlockedPlayback = false;
    }

    if (!this.context.audioWorklet) {
      throw new RadioPlaybackError("AudioWorklet non disponibile.");
    }

    if (this.context.state === "suspended") {
      await this.context.resume();
    }

    return this.context;
  }

  private async ensurePlaybackWorklet(context: AudioContext) {
    if (this.workletLoaded) return;
    if (!this.workletLoadPromise) {
      this.workletLoadPromise = context.audioWorklet
        .addModule(publicWorkletUrl(PLAYBACK_WORKLET_FILE))
        .then(() => {
          this.workletLoaded = true;
        })
        .finally(() => {
          this.workletLoadPromise = null;
        });
    }
    await this.workletLoadPromise;
  }

  private playSilentUnlockBuffer(context: AudioContext) {
    try {
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = context.createBuffer(1, 1, Math.max(1, context.sampleRate));
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(context.destination);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
      };
      source.start();
      source.stop(context.currentTime + 0.01);
    } catch {
      // Best-effort audio unlock for mobile browsers.
    }
  }

  private unmuteStream(stream: PlaybackStream) {
    const context = this.context;
    try {
      if (context) {
        stream.gain.gain.cancelScheduledValues(context.currentTime);
        stream.gain.gain.setValueAtTime(1, context.currentTime);
        return;
      }
    } catch {
      // Fall through to direct assignment for older WebViews.
    }
    stream.gain.gain.value = 1;
  }

  private isDuplicateOrStaleFrame(streamId: number, seq: number) {
    const safeSeq = seq >>> 0;
    const previousSeq = this.lastFrameSeqByStream.get(streamId);
    if (previousSeq !== undefined && safeSeq <= previousSeq) {
      return true;
    }
    this.lastFrameSeqByStream.set(streamId, safeSeq);
    return false;
  }

  private cancelIdleSuspend() {
    if (this.idleSuspendTimer !== null) {
      window.clearTimeout(this.idleSuspendTimer);
      this.idleSuspendTimer = null;
    }
  }

  private scheduleIdleSuspend() {
    this.cancelIdleSuspend();
    const context = this.context;
    if (
      !context ||
      context.state !== "running" ||
      this.streams.size > 0 ||
      this.delayedPlaybackTimers.size > 0 ||
      this.delayedStopTimers.size > 0
    ) {
      return;
    }

    this.idleSuspendTimer = window.setTimeout(() => {
      this.idleSuspendTimer = null;
      if (
        !this.context ||
        this.context.state !== "running" ||
        this.streams.size > 0 ||
        this.delayedPlaybackTimers.size > 0 ||
        this.delayedStopTimers.size > 0
      ) {
        return;
      }
      const suspendPromise = this.context.suspend?.();
      void suspendPromise?.catch(() => undefined);
    }, IDLE_SUSPEND_MS);
  }

  private async ensureAudioContext() {
    const context = await this.ensureBaseAudioContext();
    await this.ensurePlaybackWorklet(context);

    if (!this.workletLoaded) {
      throw new RadioPlaybackError("AudioWorklet non disponibile.");
    }

    if (context.state === "suspended") {
      await context.resume();
    }

    return context;
  }
}

export function createRadioPlaybackEngine() {
  return new RadioPlaybackEngine();
}
