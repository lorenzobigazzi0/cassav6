import { encodeRadioFrame, RADIO_FRAME_LIMITS } from "./radioProtocol";
import { encodeMuLaw } from "./mulaw";
import { concatFloat32, resampleLinear } from "./resample";

const CAPTURE_WORKLET_FILE = "radio-capture-worklet.js";
const RADIO_SAMPLE_RATE = RADIO_FRAME_LIMITS.sampleRate;
const RADIO_FRAME_SAMPLES = Math.round((RADIO_SAMPLE_RATE * RADIO_FRAME_LIMITS.frameMs) / 1000);
const LEVEL_THROTTLE_MS = 40;
const IDLE_CAPTURE_SUSPEND_MS = 360;
const BASIC_AUDIO_CONSTRAINTS: MediaStreamConstraints = { audio: true };
type LowLatencyMediaTrackConstraints = MediaTrackConstraints & {
  latency?: number | { ideal: number };
};
const PHONE_MIC_AUDIO_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    deviceId: { ideal: "default" },
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48_000 },
    latency: { ideal: 0.02 },
  } as LowLatencyMediaTrackConstraints,
};
const PHONE_MIC_LABEL_HINTS = [
  "default",
  "built-in",
  "builtin",
  "internal",
  "microphone",
  "mic",
  "phone",
  "telefono",
  "voice",
  "communication",
];
const CAMERA_MIC_LABEL_HINTS = ["camera", "camcorder", "video", "front", "back", "rear"];

export type RadioCaptureFrameState = {
  pending: Float32Array;
  seq: number;
  nextTimestampMs: number | null;
};

export type BuildMulawFrameOptions = {
  streamId: number;
  input: Float32Array;
  inputSampleRate: number;
  state: RadioCaptureFrameState;
  nowMs?: number;
};

export type RadioCaptureOptions = {
  streamId: number;
  onFrame: (frame: Uint8Array) => void;
  onLevel?: (level: number) => void;
};

type CaptureWorkletMessage = {
  type?: string;
  pcm?: Float32Array;
  level?: number;
};

type AudioContextConstructor = typeof AudioContext;
type AudioContextScope = typeof globalThis & {
  webkitAudioContext?: AudioContextConstructor;
};
type MediaStreamTrackAudioSourceNodeConstructor = new (
  context: AudioContext,
  options: { mediaStreamTrack: MediaStreamTrack }
) => AudioNode;
type MediaStreamTrackAudioSourceNodeScope = typeof globalThis & {
  MediaStreamTrackAudioSourceNode?: MediaStreamTrackAudioSourceNodeConstructor;
};

export function createRadioCaptureFrameState(): RadioCaptureFrameState {
  return {
    pending: new Float32Array(),
    seq: 0,
    nextTimestampMs: null,
  };
}

export function buildMulawRadioFrames({
  streamId,
  input,
  inputSampleRate,
  state,
  nowMs = Date.now(),
}: BuildMulawFrameOptions) {
  const resampled = resampleLinear(input, inputSampleRate, RADIO_SAMPLE_RATE);
  const pcm = concatFloat32(state.pending, resampled);
  const frames: Uint8Array[] = [];
  let offset = 0;
  let timestampMs = state.nextTimestampMs ?? nowMs;

  while (offset + RADIO_FRAME_SAMPLES <= pcm.length) {
    const framePcm = pcm.slice(offset, offset + RADIO_FRAME_SAMPLES);
    const payload = encodeMuLaw(framePcm);
    frames.push(
      encodeRadioFrame({
        streamId,
        seq: state.seq,
        timestampMs: timestampMs >>> 0,
        payload,
      })
    );
    state.seq = (state.seq + 1) >>> 0;
    timestampMs += RADIO_FRAME_LIMITS.frameMs;
    offset += RADIO_FRAME_SAMPLES;
  }

  state.nextTimestampMs = timestampMs;
  state.pending = pcm.slice(offset);
  return frames;
}

function getAudioContextConstructor(): AudioContextConstructor | null {
  const scope = (typeof window !== "undefined" ? window : globalThis) as AudioContextScope;
  return scope.AudioContext || scope.webkitAudioContext || null;
}

function getMediaStreamTrackAudioSourceNodeConstructor(): MediaStreamTrackAudioSourceNodeConstructor | null {
  const scope = (
    typeof window !== "undefined" ? window : globalThis
  ) as MediaStreamTrackAudioSourceNodeScope;
  return scope.MediaStreamTrackAudioSourceNode || null;
}

function publicWorkletUrl(fileName: string) {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");
  return `${base}/${fileName.replace(/^\/+/, "")}`;
}

function normalizeCaptureError(error: unknown) {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Permesso microfono negato.";
  }
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return "Microfono non disponibile.";
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Audio radio non disponibile.";
}

function shouldRetryCaptureSource(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /could not start audio source/i.test(message);
}

function isCameraLikeAudioInput(device: MediaDeviceInfo) {
  const label = device.label.toLowerCase();
  return CAMERA_MIC_LABEL_HINTS.some((hint) => label.includes(hint));
}

function isPhoneLikeAudioInput(device: MediaDeviceInfo) {
  const label = device.label.toLowerCase();
  return PHONE_MIC_LABEL_HINTS.some((hint) => label.includes(hint));
}

async function findPreferredAudioInputId() {
  if (typeof navigator.mediaDevices.enumerateDevices !== "function") return null;

  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const audioInputs = devices.filter((device) => device.kind === "audioinput" && device.deviceId);
  if (audioInputs.length === 0) return null;

  const defaultInput = audioInputs.find(
    (device) => device.deviceId === "default" && !isCameraLikeAudioInput(device)
  );
  if (defaultInput) return defaultInput.deviceId;

  const phoneInput = audioInputs.find(
    (device) => isPhoneLikeAudioInput(device) && !isCameraLikeAudioInput(device)
  );
  if (phoneInput) return phoneInput.deviceId;

  const nonCameraInput = audioInputs.find((device) => !isCameraLikeAudioInput(device));
  return nonCameraInput?.deviceId ?? null;
}

function withAudioDeviceId(deviceId: string): MediaStreamConstraints {
  return {
    audio: {
      ...(PHONE_MIC_AUDIO_CONSTRAINTS.audio as MediaTrackConstraints),
      deviceId: { exact: deviceId },
    },
  };
}

async function requestMicrophoneStream() {
  const preferredDeviceId = await findPreferredAudioInputId();
  const attempts = preferredDeviceId
    ? [withAudioDeviceId(preferredDeviceId), PHONE_MIC_AUDIO_CONSTRAINTS, BASIC_AUDIO_CONSTRAINTS]
    : [PHONE_MIC_AUDIO_CONSTRAINTS, BASIC_AUDIO_CONSTRAINTS];

  let lastError: unknown = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new RadioAudioError("Microfono non disponibile.");
}

function stopMediaStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

export class RadioAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RadioAudioError";
  }
}

export class RadioAudioEngine {
  private context: AudioContext | null = null;
  private workletLoaded = false;
  private source: AudioNode | null = null;
  private node: AudioWorkletNode | null = null;
  private silentGain: GainNode | null = null;
  private stream: MediaStream | null = null;
  private preparedStream: MediaStream | null = null;
  private preparedSource: AudioNode | null = null;
  private preparedSourceStream: MediaStream | null = null;
  private pendingStream: Promise<MediaStream> | null = null;
  private pendingPrepare: Promise<void> | null = null;
  private captureId = 0;
  private prepareToken = 0;
  private lastLevelAt = 0;
  private idleSuspendTimer: number | null = null;

  async prepareCapture() {
    this.ensureMicrophoneSupport();
    if (this.stream) return;
    if (this.preparedStream) {
      const context = await this.ensureAudioContext();
      this.prepareSourceForStream(context, this.preparedStream);
      return;
    }
    if (this.pendingPrepare) {
      await this.pendingPrepare;
      return;
    }

    const token = this.prepareToken;
    const pendingStream = requestMicrophoneStream()
      .then((stream) => {
        if (token !== this.prepareToken || this.stream || this.preparedStream) {
          stopMediaStream(stream);
          throw new RadioAudioError("Richiesta microfono annullata.");
        }
        this.preparedStream = stream;
        return stream;
      })
      .catch((error) => {
        throw new RadioAudioError(normalizeCaptureError(error));
      });

    const pendingPrepare = pendingStream
      .then(async (stream) => {
        const context = await this.ensureAudioContext();
        this.prepareSourceForStream(context, stream);
      })
      .catch((error) => {
        this.releasePreparedCapture();
        throw error;
      })
      .finally(() => {
        if (this.pendingStream === pendingStream) this.pendingStream = null;
        if (this.pendingPrepare === pendingPrepare) this.pendingPrepare = null;
      });

    this.pendingStream = pendingStream;
    this.pendingPrepare = pendingPrepare;
    await pendingPrepare;
  }

  async startCapture(options: RadioCaptureOptions) {
    this.stopActiveCapture();
    const captureId = this.captureId + 1;
    this.captureId = captureId;
    const frameState = createRadioCaptureFrameState();

    let stream: MediaStream | null = null;
    let context: AudioContext;
    try {
      stream = await this.acquireMicrophoneStream();
      context = await this.ensureAudioContext();
    } catch (error) {
      stopMediaStream(stream);
      throw new RadioAudioError(normalizeCaptureError(error));
    }

    if (!stream) {
      throw new RadioAudioError("Audio radio non disponibile.");
    }

    if (this.captureId !== captureId) {
      stopMediaStream(stream);
      return;
    }

    let source: AudioNode;
    let node: AudioWorkletNode;
    let silentGain: GainNode;
    try {
      ({ source, node, silentGain } = this.createCaptureGraph(context, stream));
    } catch (error) {
      stopMediaStream(stream);
      if (!shouldRetryCaptureSource(error)) {
        throw new RadioAudioError(normalizeCaptureError(error));
      }
      try {
        await this.resetAudioContext();
        stream = await requestMicrophoneStream();
        context = await this.ensureAudioContext();
        ({ source, node, silentGain } = this.createCaptureGraph(context, stream));
      } catch (retryError) {
        stopMediaStream(stream);
        throw new RadioAudioError(normalizeCaptureError(retryError));
      }
    }

    node.port.onmessage = (event: MessageEvent<CaptureWorkletMessage>) => {
      if (this.captureId !== captureId) return;
      const message = event.data;
      if (message.type !== "chunk" || !(message.pcm instanceof Float32Array)) return;
      const frames = buildMulawRadioFrames({
        streamId: options.streamId,
        input: message.pcm,
        inputSampleRate: context.sampleRate,
        state: frameState,
      });
      frames.forEach(options.onFrame);
      const now = performance.now();
      if (options.onLevel && now - this.lastLevelAt >= LEVEL_THROTTLE_MS) {
        this.lastLevelAt = now;
        options.onLevel(
          Number.isFinite(message.level) ? Math.max(0, Math.min(1, message.level ?? 0)) : 0
        );
      }
    };

    source.connect(node);
    node.connect(silentGain);
    silentGain.connect(context.destination);

    this.stream = stream;
    this.source = source;
    this.node = node;
    this.silentGain = silentGain;
  }

  stopCapture() {
    this.prepareToken += 1;
    this.releasePreparedCapture();
    this.stopActiveCapture();
    this.scheduleIdleSuspend();
  }

  private stopActiveCapture() {
    this.captureId += 1;
    this.node?.port.close();
    this.node?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    stopMediaStream(this.stream);
    this.node = null;
    this.source = null;
    this.silentGain = null;
    this.stream = null;
    this.lastLevelAt = 0;
  }

  async dispose() {
    this.stopCapture();
    if (this.context) {
      this.cancelIdleSuspend();
      await this.context.close().catch(() => undefined);
      this.context = null;
      this.workletLoaded = false;
    }
  }

  private async acquireMicrophoneStream() {
    this.ensureMicrophoneSupport();
    if (this.pendingPrepare) {
      await this.pendingPrepare;
    }
    if (this.preparedStream) {
      const stream = this.preparedStream;
      this.preparedStream = null;
      return stream;
    }

    if (this.pendingStream) {
      const stream = await this.pendingStream;
      if (this.preparedStream === stream) this.preparedStream = null;
      return stream;
    }

    return requestMicrophoneStream();
  }

  private releasePreparedCapture() {
    this.preparedSource?.disconnect();
    this.preparedSource = null;
    this.preparedSourceStream = null;
    stopMediaStream(this.preparedStream);
    this.preparedStream = null;
    this.scheduleIdleSuspend();
  }

  private createCaptureGraph(context: AudioContext, stream: MediaStream) {
    const source =
      this.consumePreparedSourceForStream(stream) ?? this.createCaptureSource(context, stream);
    const node = new AudioWorkletNode(context, "radio-capture-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        frameMs: RADIO_FRAME_LIMITS.frameMs,
      },
    });
    const silentGain = context.createGain();
    silentGain.gain.value = 0;
    return { source, node, silentGain };
  }

  private createCaptureSource(context: AudioContext, stream: MediaStream) {
    const audioTracks = typeof stream.getAudioTracks === "function" ? stream.getAudioTracks() : [];
    const audioTrack = audioTracks.find((track) => track.readyState === "live") ?? audioTracks[0];
    const TrackSourceNode = getMediaStreamTrackAudioSourceNodeConstructor();
    if (TrackSourceNode && audioTrack) {
      try {
        return new TrackSourceNode(context, { mediaStreamTrack: audioTrack });
      } catch (error) {
        if (shouldRetryCaptureSource(error)) throw error;
      }
    }
    return context.createMediaStreamSource(stream);
  }

  private prepareSourceForStream(context: AudioContext, stream: MediaStream) {
    if (this.preparedSource && this.preparedSourceStream === stream) return;
    this.preparedSource?.disconnect();
    this.preparedSource = this.createCaptureSource(context, stream);
    this.preparedSourceStream = stream;
  }

  private consumePreparedSourceForStream(stream: MediaStream) {
    if (!this.preparedSource || this.preparedSourceStream !== stream) return null;
    const source = this.preparedSource;
    this.preparedSource = null;
    this.preparedSourceStream = null;
    return source;
  }

  private async resetAudioContext() {
    this.cancelIdleSuspend();
    const context = this.context;
    this.context = null;
    this.workletLoaded = false;
    if (context && context.state !== "closed") {
      await context.close().catch(() => undefined);
    }
  }

  private ensureMicrophoneSupport() {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function"
    ) {
      throw new RadioAudioError("Microfono non supportato da questo browser.");
    }
  }

  private async ensureAudioContext() {
    const AudioContextClass = getAudioContextConstructor();
    if (!AudioContextClass || typeof AudioWorkletNode === "undefined") {
      throw new RadioAudioError("AudioWorklet non supportato da questo browser.");
    }

    this.cancelIdleSuspend();

    if (!this.context || this.context.state === "closed") {
      this.context = new AudioContextClass({ latencyHint: "interactive" });
      this.workletLoaded = false;
    }

    if (!this.context.audioWorklet) {
      throw new RadioAudioError("AudioWorklet non disponibile.");
    }

    if (!this.workletLoaded) {
      await this.context.audioWorklet.addModule(publicWorkletUrl(CAPTURE_WORKLET_FILE));
      this.workletLoaded = true;
    }

    if (this.context.state === "suspended") {
      await this.context.resume();
    }

    return this.context;
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
      this.stream ||
      this.preparedStream ||
      this.pendingStream ||
      this.pendingPrepare
    ) {
      return;
    }

    this.idleSuspendTimer = window.setTimeout(() => {
      this.idleSuspendTimer = null;
      if (
        !this.context ||
        this.context.state !== "running" ||
        this.stream ||
        this.preparedStream ||
        this.pendingStream ||
        this.pendingPrepare
      ) {
        return;
      }
      const suspendPromise = this.context.suspend?.();
      void suspendPromise?.catch(() => undefined);
    }, IDLE_CAPTURE_SUSPEND_MS);
  }
}

export function createRadioAudioEngine() {
  return new RadioAudioEngine();
}

export function normalizeRadioAudioError(error: unknown) {
  if (error instanceof RadioAudioError) return error.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Audio radio non disponibile.";
}
