import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchMobileSessionEnding } from "../src/app/session/sessionLifecycle";
import { useNotificationAudio } from "../src/pages/home/hooks/useNotificationAudio";

class FakeAudioParam {
  value = 0;
  setValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}

class FakeOscillator {
  type: OscillatorType = "sine";
  frequency = new FakeAudioParam();
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeGain {
  gain = new FakeAudioParam();
  connect = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 1;
  state: AudioContextState = "running";
  destination = {};
  oscillators: FakeOscillator[] = [];
  close = vi.fn(async () => {
    this.state = "closed";
  });
  resume = vi.fn(async () => undefined);
  createOscillator = vi.fn(() => {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  });
  createGain = vi.fn(() => new FakeGain());

  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

describe("notification audio logout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeAudioContext.instances = [];
  });

  it("chiude il contesto e annulla lo squillo differito quando termina la sessione", () => {
    vi.useFakeTimers();
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const { result, unmount } = renderHook(() =>
      useNotificationAudio({ enabled: true, waiterCount: 0, bellCount: 0 })
    );

    act(() => result.current.playHandheldRingTone());
    const context = FakeAudioContext.instances[0];
    expect(context.oscillators).toHaveLength(5);

    act(() => dispatchMobileSessionEnding());
    expect(context.close).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(6_000));
    expect(context.oscillators).toHaveLength(5);
    expect(FakeAudioContext.instances).toHaveLength(1);

    unmount();
  });
});
