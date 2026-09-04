import { afterEach, describe, expect, it, vi } from "vitest";
import { playRadioBotTone, playRadioEotTone } from "../src/radio/radioGesture";

const originalAudioContext = window.AudioContext;

class FakeAudioParam {
  setValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}

class FakeOscillatorNode {
  type: OscillatorType = "sine";
  frequency = new FakeAudioParam();
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeGainNode {
  gain = new FakeAudioParam();
  connect = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  currentTime = 10;
  destination = {};
  oscillator = new FakeOscillatorNode();
  gain = new FakeGainNode();
  createOscillator = vi.fn(() => this.oscillator);
  createGain = vi.fn(() => this.gain);
  close = vi.fn(async () => undefined);

  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.AudioContext = originalAudioContext;
  FakeAudioContext.instances = [];
});

describe("radio gesture tones", () => {
  it("plays a short rising BOT tone", () => {
    vi.useFakeTimers();
    window.AudioContext = FakeAudioContext as unknown as typeof AudioContext;

    playRadioBotTone();

    const context = FakeAudioContext.instances[0];
    expect(context.oscillator.type).toBe("triangle");
    expect(context.oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(820, 10);
    expect(context.oscillator.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(1320, 10.075);
    expect(context.oscillator.stop).toHaveBeenCalledWith(10.12);

    vi.advanceTimersByTime(260);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("plays a short falling EOT tone", () => {
    vi.useFakeTimers();
    window.AudioContext = FakeAudioContext as unknown as typeof AudioContext;

    playRadioEotTone();

    const context = FakeAudioContext.instances[0];
    expect(context.oscillator.type).toBe("triangle");
    expect(context.oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(1480, 10);
    expect(context.oscillator.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(720, 10.075);
    expect(context.oscillator.stop).toHaveBeenCalledWith(10.145);

    vi.advanceTimersByTime(260);
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});
