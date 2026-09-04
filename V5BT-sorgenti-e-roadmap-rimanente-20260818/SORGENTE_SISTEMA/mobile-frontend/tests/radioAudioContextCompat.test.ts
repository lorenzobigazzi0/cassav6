import { afterEach, describe, expect, it, vi } from "vitest";
import { createRadioAudioEngine } from "../src/radio/radioAudioEngine";
import { createRadioPlaybackEngine } from "../src/radio/radioPlaybackEngine";
import { encodeRadioFrame } from "../src/radio/radioProtocol";

const originalAudioContext = window.AudioContext;
const originalWebkitAudioContext = (
  window as typeof window & {
    webkitAudioContext?: typeof AudioContext;
  }
).webkitAudioContext;
const originalAudioWorkletNode = globalThis.AudioWorkletNode;

class FakeAudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeGainNode extends FakeAudioNode {
  gain = { value: 1 };
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static createMediaStreamSourceImplementation: (() => FakeAudioNode) | null = null;

  state: AudioContextState = "suspended";
  sampleRate = 48_000;
  destination = {};
  audioWorklet = {
    addModule: vi.fn(async () => undefined),
  };
  createMediaStreamSource = vi.fn(() =>
    FakeAudioContext.createMediaStreamSourceImplementation
      ? FakeAudioContext.createMediaStreamSourceImplementation()
      : new FakeAudioNode()
  );
  createGain = vi.fn(() => new FakeGainNode());
  resume = vi.fn(async () => {
    this.state = "running";
  });
  suspend = vi.fn(async () => {
    this.state = "suspended";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

class FakeAudioWorkletNode extends FakeAudioNode {
  static instances: FakeAudioWorkletNode[] = [];
  static constructorCalls: unknown[][] = [];

  port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    close: vi.fn(),
    postMessage: vi.fn(),
  };

  constructor(...args: unknown[]) {
    super();
    FakeAudioWorkletNode.constructorCalls.push(args);
    FakeAudioWorkletNode.instances.push(this);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.AudioContext = originalAudioContext;
  (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext =
    originalWebkitAudioContext;
  globalThis.AudioWorkletNode = originalAudioWorkletNode;
  FakeAudioContext.instances = [];
  FakeAudioContext.createMediaStreamSourceImplementation = null;
  FakeAudioWorkletNode.instances = [];
  FakeAudioWorkletNode.constructorCalls = [];
});

describe("radio audio context compatibility", () => {
  it("captures with webkitAudioContext when standard AudioContext is missing", async () => {
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop: stopTrack }],
    }));

    window.AudioContext = undefined as unknown as typeof AudioContext;
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext =
      FakeAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    const engine = createRadioAudioEngine();
    await engine.startCapture({ streamId: 7, onFrame: vi.fn() });

    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({
          deviceId: { ideal: "default" },
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl: { ideal: true },
          channelCount: { ideal: 1 },
        }),
      })
    );
    expect(FakeAudioContext.instances[0]?.resume).toHaveBeenCalled();
    expect(FakeAudioWorkletNode.constructorCalls[0]?.[2]).toEqual(
      expect.objectContaining({
        processorOptions: {
          frameMs: 20,
        },
      })
    );

    await engine.dispose();
    expect(stopTrack).toHaveBeenCalled();
  });

  it("prepares the microphone stream and source before capture, then reuses it after grant", async () => {
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop: stopTrack }],
    }));

    window.AudioContext = undefined as unknown as typeof AudioContext;
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext =
      FakeAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    const engine = createRadioAudioEngine();
    await engine.prepareCapture();

    expect(FakeAudioContext.instances[0]?.audioWorklet.addModule).toHaveBeenCalledWith(
      "/radio-capture-worklet.js"
    );
    expect(FakeAudioContext.instances[0]?.createMediaStreamSource).toHaveBeenCalledTimes(1);
    expect(FakeAudioWorkletNode.instances).toHaveLength(0);

    await engine.startCapture({ streamId: 11, onFrame: vi.fn() });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({
          deviceId: { ideal: "default" },
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl: { ideal: true },
          channelCount: { ideal: 1 },
        }),
      })
    );
    expect(FakeAudioContext.instances[0]?.createMediaStreamSource).toHaveBeenCalledTimes(1);

    await engine.dispose();
    expect(stopTrack).toHaveBeenCalled();
  });

  it("retries with a fresh microphone stream and AudioContext when Android WebView cannot start the source", async () => {
    const firstStopTrack = vi.fn();
    const secondStopTrack = vi.fn();
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce({
        getTracks: () => [{ stop: firstStopTrack }],
      })
      .mockResolvedValueOnce({
        getTracks: () => [{ stop: secondStopTrack }],
      });

    window.AudioContext = undefined as unknown as typeof AudioContext;
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext =
      FakeAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    let shouldThrow = true;
    FakeAudioContext.createMediaStreamSourceImplementation = () => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("Could not start audio source");
      }
      return new FakeAudioNode();
    };

    const engine = createRadioAudioEngine();
    await engine.startCapture({ streamId: 12, onFrame: vi.fn() });

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(firstStopTrack).toHaveBeenCalled();
    expect(FakeAudioContext.instances[0]?.createMediaStreamSource).toHaveBeenCalledTimes(1);
    expect(FakeAudioContext.instances[0]?.close).toHaveBeenCalled();
    expect(FakeAudioContext.instances).toHaveLength(2);
    expect(FakeAudioContext.instances[1]?.createMediaStreamSource).toHaveBeenCalledTimes(1);

    await engine.dispose();
    expect(secondStopTrack).toHaveBeenCalled();
  });

  it("plays back with webkitAudioContext when standard AudioContext is missing", async () => {
    window.AudioContext = undefined as unknown as typeof AudioContext;
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext =
      FakeAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode;

    const engine = createRadioPlaybackEngine();
    await engine.startStream(8);

    expect(FakeAudioContext.instances[0]?.audioWorklet.addModule).toHaveBeenCalledWith(
      "/radio-playback-worklet.js"
    );
    expect(FakeAudioContext.instances[0]?.resume).toHaveBeenCalled();
    expect(FakeAudioWorkletNode.constructorCalls[0]?.[2]).toEqual(
      expect.objectContaining({
        processorOptions: {
          jitterSamples: 3840,
          rebufferSamples: 3840,
        },
      })
    );

    await engine.dispose();
  });

  it("coalesces concurrent creation of the same playback stream", async () => {
    window.AudioContext = undefined as unknown as typeof AudioContext;
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext =
      FakeAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode;

    const engine = createRadioPlaybackEngine();
    const frame = encodeRadioFrame({
      streamId: 18,
      seq: 0,
      timestampMs: 1000,
      payload: new Uint8Array(320),
    });

    await Promise.all([engine.startStream(18), engine.startStream(18), engine.enqueueFrame(frame)]);

    expect(FakeAudioWorkletNode.instances).toHaveLength(1);
    expect(FakeAudioWorkletNode.instances[0]?.port.postMessage).toHaveBeenCalledTimes(1);

    await engine.dispose();
  });

  it("suspends unlocked playback while no radio stream is active", async () => {
    vi.useFakeTimers();
    window.AudioContext = undefined as unknown as typeof AudioContext;
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext =
      FakeAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode;

    const engine = createRadioPlaybackEngine();
    await engine.unlock();
    const context = FakeAudioContext.instances[0];

    expect(context?.resume).toHaveBeenCalledTimes(1);
    expect(context?.suspend).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(360);

    expect(context?.suspend).toHaveBeenCalledTimes(1);

    await engine.dispose();
  });

  it("releases prepared capture and suspends the capture context after cancellation", async () => {
    vi.useFakeTimers();
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop: stopTrack }],
    }));

    window.AudioContext = undefined as unknown as typeof AudioContext;
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext =
      FakeAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    const engine = createRadioAudioEngine();
    await engine.prepareCapture();
    const context = FakeAudioContext.instances[0];

    await vi.advanceTimersByTimeAsync(360);
    expect(context?.suspend).not.toHaveBeenCalled();

    engine.stopCapture();
    expect(stopTrack).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(360);
    expect(context?.suspend).toHaveBeenCalledTimes(1);

    await engine.dispose();
  });

  it("delays buffered echo playback before enqueueing frames", async () => {
    vi.useFakeTimers();
    window.AudioContext = undefined as unknown as typeof AudioContext;
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext =
      FakeAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode;

    const engine = createRadioPlaybackEngine();
    const frame = encodeRadioFrame({
      streamId: 9,
      seq: 0,
      timestampMs: 1000,
      payload: new Uint8Array(320),
    });

    engine.playBufferedFrames(9, [frame], 500);

    await vi.advanceTimersByTimeAsync(499);
    expect(FakeAudioWorkletNode.instances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(FakeAudioWorkletNode.instances).toHaveLength(1);
    expect(FakeAudioWorkletNode.instances[0]?.port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "enqueue" }),
      expect.any(Array)
    );

    await engine.dispose();
  });

  it("resamples decoded radio frames to the playback AudioContext sample rate", async () => {
    window.AudioContext = undefined as unknown as typeof AudioContext;
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext =
      FakeAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode;

    const engine = createRadioPlaybackEngine();
    const frame = encodeRadioFrame({
      streamId: 10,
      seq: 0,
      timestampMs: 1000,
      payload: new Uint8Array(320),
    });

    await engine.enqueueFrame(frame);

    const enqueueCall = FakeAudioWorkletNode.instances[0]?.port.postMessage.mock.calls[0];
    expect(enqueueCall?.[0]).toEqual(
      expect.objectContaining({
        type: "enqueue",
        pcm: expect.any(Float32Array),
      })
    );
    expect(enqueueCall?.[0].pcm).toHaveLength(960);

    await engine.dispose();
  });

  it("drops duplicated playback frames for the same stream and sequence", async () => {
    window.AudioContext = undefined as unknown as typeof AudioContext;
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext =
      FakeAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode;

    const engine = createRadioPlaybackEngine();
    const frame = encodeRadioFrame({
      streamId: 11,
      seq: 7,
      timestampMs: 1000,
      payload: new Uint8Array(320),
    });

    expect(await engine.enqueueFrame(frame)).toBe(true);
    expect(await engine.enqueueFrame(frame)).toBe(false);

    expect(FakeAudioWorkletNode.instances[0]?.port.postMessage).toHaveBeenCalledTimes(1);

    await engine.dispose();
  });
});
