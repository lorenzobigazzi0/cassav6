import React from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomBar, type BottomTabItem } from "../src/pages/home/components/BottomBar";
import type { RadioContextValue } from "../src/radio/radioContext";

const radioMock = vi.hoisted(() => ({
  value: null as RadioContextValue | null,
}));

vi.mock("../src/radio/useRadio", () => ({
  useRadio: () => {
    if (!radioMock.value) throw new Error("missing radio mock");
    return radioMock.value;
  },
}));

const tabs: BottomTabItem[] = [
  { key: "home", label: "Home", icon: <span>H</span> },
  { key: "menu", label: "Menu", icon: <span>M</span> },
  { key: "tavoli", label: "Tavoli", icon: <span>T</span> },
  { key: "prenotazioni", label: "Prenotazioni", icon: <span>P</span> },
  { key: "analytics", label: "Statistiche", icon: <span>S</span> },
];

function makeRadioMock(overrides: Partial<RadioContextValue> = {}): RadioContextValue {
  return {
    channels: [{ id: "cucina", name: "Cucina", enabled: true, color: "#ff9f43", sortOrder: 1 }],
    slots: ["cucina", null, null],
    activeSlots: [{ id: "cucina", name: "Cucina", enabled: true, color: "#ff9f43", sortOrder: 1 }],
    status: "ready",
    ptt: { mode: "idle" },
    incoming: null,
    outgoing: null,
    audioLevels: [],
    incomingAudioLevels: [],
    isChannelBusy: vi.fn(() => false),
    saveSlots: vi.fn(),
    preparePttAudio: vi.fn().mockResolvedValue(undefined),
    startPtt: vi.fn(),
    stopPtt: vi.fn(),
    startEchoTest: vi.fn(),
    stopEchoTest: vi.fn(),
    refreshConfig: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  radioMock.value = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BottomBar radio gesture", () => {
  const prepareBar = (onChange = vi.fn()) => {
    const { container } = render(<BottomBar tabs={tabs} activeTab="home" onChange={onChange} />);
    const bar = container.querySelector(".bottom-bar") as HTMLDivElement;
    expect(bar).toBeTruthy();

    vi.spyOn(bar, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 300,
      bottom: 64,
      width: 300,
      height: 64,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    bar.setPointerCapture = vi.fn();
    bar.hasPointerCapture = vi.fn(() => true);
    bar.releasePointerCapture = vi.fn();
    return { bar, onChange };
  };

  it("does not start PTT and releases prepared audio when the press is released before 1700ms", () => {
    vi.useFakeTimers();
    const startPtt = vi.fn();
    const stopPtt = vi.fn();
    radioMock.value = makeRadioMock({ startPtt, stopPtt });

    const { bar } = prepareBar();

    fireEvent.pointerDown(bar, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 150,
      clientY: 24,
    });
    vi.advanceTimersByTime(1_699);
    fireEvent.pointerUp(bar, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 150,
      clientY: 24,
    });
    vi.runOnlyPendingTimers();

    expect(startPtt).not.toHaveBeenCalled();
    expect(stopPtt).toHaveBeenCalledTimes(1);
  });

  it("keeps PTT active when the finger moves inside the screen", async () => {
    vi.useFakeTimers();
    const startPtt = vi.fn().mockResolvedValue({
      ok: true,
      txId: "tx",
      streamId: 11,
      channelId: "cucina",
      startedAt: Date.now(),
    });
    const stopPtt = vi.fn();
    const onChange = vi.fn();
    radioMock.value = makeRadioMock({ startPtt, stopPtt });
    const { bar } = prepareBar(onChange);

    fireEvent.pointerDown(bar, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 150,
      clientY: 24,
    });
    await vi.advanceTimersByTimeAsync(1_700);

    fireEvent.pointerMove(bar, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 286,
      clientY: 48,
    });

    expect(startPtt).toHaveBeenCalledTimes(1);
    expect(stopPtt).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(within(bar).getByText("RILASCIA PER TERMINARE")).toBeInTheDocument();
    expect(bar.querySelector(".bottom-radio-waveform")).not.toBeInTheDocument();
    expect(within(bar).queryByText("00:00")).not.toBeInTheDocument();

    fireEvent.pointerUp(bar, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 286,
      clientY: 48,
    });

    expect(stopPtt).toHaveBeenCalledTimes(1);
  });

  it("keeps PTT active when WebView emits pointercancel during a touch hold", async () => {
    vi.useFakeTimers();
    const startPtt = vi.fn().mockResolvedValue({
      ok: true,
      txId: "tx",
      streamId: 13,
      channelId: "cucina",
      startedAt: Date.now(),
    });
    const stopPtt = vi.fn();
    const onChange = vi.fn();
    radioMock.value = makeRadioMock({ startPtt, stopPtt });
    const { bar } = prepareBar(onChange);

    fireEvent.pointerDown(bar, {
      pointerId: 4,
      pointerType: "touch",
      clientX: 150,
      clientY: 24,
    });
    await vi.advanceTimersByTimeAsync(1_700);

    fireEvent.pointerCancel(bar, {
      pointerId: 4,
      pointerType: "touch",
      clientX: 230,
      clientY: 40,
    });

    expect(startPtt).toHaveBeenCalledTimes(1);
    expect(stopPtt).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(bar, {
      pointerId: 4,
      pointerType: "touch",
      clientX: 230,
      clientY: 40,
    });

    expect(stopPtt).toHaveBeenCalledTimes(1);
  });

  it("starts PTT even when WebView pointer capture fails", async () => {
    vi.useFakeTimers();
    const startPtt = vi.fn().mockResolvedValue({
      ok: true,
      txId: "tx",
      streamId: 14,
      channelId: "cucina",
      startedAt: Date.now(),
    });
    const stopPtt = vi.fn();
    radioMock.value = makeRadioMock({ startPtt, stopPtt });
    const { bar } = prepareBar();
    bar.setPointerCapture = vi.fn(() => {
      throw new Error("capture failed");
    });

    fireEvent.pointerDown(bar, {
      pointerId: 5,
      pointerType: "touch",
      clientX: 150,
      clientY: 24,
    });
    await vi.advanceTimersByTimeAsync(1_700);

    expect(startPtt).toHaveBeenCalledTimes(1);

    fireEvent.pointerUp(bar, {
      pointerId: 5,
      pointerType: "touch",
      clientX: 150,
      clientY: 24,
    });

    expect(stopPtt).toHaveBeenCalledTimes(1);
  });

  it("starts PTT through the native touch fallback when pointer events are unreliable", async () => {
    vi.useFakeTimers();
    const startPtt = vi.fn().mockResolvedValue({
      ok: true,
      txId: "tx",
      streamId: 15,
      channelId: "cucina",
      startedAt: Date.now(),
    });
    const stopPtt = vi.fn();
    const onChange = vi.fn();
    radioMock.value = makeRadioMock({ startPtt, stopPtt });
    const { bar } = prepareBar(onChange);

    fireEvent.touchStart(bar, {
      touches: [{ clientX: 150, clientY: 24 }],
      changedTouches: [{ clientX: 150, clientY: 24 }],
    });
    await vi.advanceTimersByTimeAsync(1_700);

    fireEvent.touchMove(bar, {
      touches: [{ clientX: 250, clientY: 42 }],
      changedTouches: [{ clientX: 250, clientY: 42 }],
    });

    expect(startPtt).toHaveBeenCalledTimes(1);
    expect(stopPtt).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.touchEnd(bar, {
      touches: [],
      changedTouches: [{ clientX: 250, clientY: 42 }],
    });

    expect(stopPtt).toHaveBeenCalledTimes(1);
  });

  it("keeps short native touch taps clickable when radio slots are active", () => {
    vi.useFakeTimers();
    const startPtt = vi.fn();
    const stopPtt = vi.fn();
    const onChange = vi.fn();
    radioMock.value = makeRadioMock({ startPtt, stopPtt });
    const { bar } = prepareBar(onChange);
    const tavoliButton = within(bar).getByRole("button", { name: "Tavoli" });

    const touchStartDispatched = fireEvent.touchStart(bar, {
      touches: [{ clientX: 150, clientY: 24 }],
      changedTouches: [{ clientX: 150, clientY: 24 }],
    });
    const touchEndDispatched = fireEvent.touchEnd(bar, {
      touches: [],
      changedTouches: [{ clientX: 150, clientY: 24 }],
    });
    vi.runOnlyPendingTimers();

    expect(touchStartDispatched).toBe(true);
    expect(touchEndDispatched).toBe(true);
    expect(startPtt).not.toHaveBeenCalled();
    expect(stopPtt).not.toHaveBeenCalled();

    fireEvent.click(tavoliButton);

    expect(onChange).toHaveBeenCalledWith("tavoli");
  });

  it("starts the bottom-bar hold when slots are assigned even if the socket state is still catching up", async () => {
    vi.useFakeTimers();
    const startPtt = vi.fn().mockResolvedValue({
      ok: false,
      reason: "not_ready",
      message: "Radio non pronta",
    });
    const onChange = vi.fn();
    radioMock.value = makeRadioMock({ status: "connecting", startPtt });
    const { bar } = prepareBar(onChange);

    fireEvent.pointerDown(bar, {
      pointerId: 6,
      pointerType: "touch",
      clientX: 150,
      clientY: 24,
    });
    await vi.advanceTimersByTimeAsync(1_700);

    expect(startPtt).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("blocks the bottom-bar PTT immediately when the selected channel is busy", async () => {
    vi.useFakeTimers();
    const startPtt = vi.fn();
    const stopPtt = vi.fn();
    const preparePttAudio = vi.fn().mockResolvedValue(undefined);
    const isChannelBusy = vi.fn(() => true);
    radioMock.value = makeRadioMock({
      isChannelBusy,
      preparePttAudio,
      startPtt,
      stopPtt,
    });
    const { bar } = prepareBar();

    fireEvent.pointerDown(bar, {
      pointerId: 7,
      pointerType: "touch",
      clientX: 150,
      clientY: 24,
    });
    await vi.advanceTimersByTimeAsync(320);

    expect(isChannelBusy).toHaveBeenCalledWith("cucina");
    expect(preparePttAudio).not.toHaveBeenCalled();
    expect(startPtt).not.toHaveBeenCalled();
    expect(within(bar).getByText("CANALE OCCUPATO")).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(within(bar).queryByText("CANALE OCCUPATO")).not.toBeInTheDocument();
    expect(stopPtt).not.toHaveBeenCalled();
  });

  it("restores the bottom bar three seconds after a microphone error", async () => {
    vi.useFakeTimers();
    const startPtt = vi.fn().mockResolvedValue({
      ok: false,
      reason: "audio_error",
      message: "Microfono non disponibile.",
    });
    radioMock.value = makeRadioMock({ startPtt });
    const { bar } = prepareBar();
    const wrapper = bar.closest(".bottom-bar-wrap") as HTMLDivElement;

    fireEvent.pointerDown(bar, {
      pointerId: 8,
      pointerType: "touch",
      clientX: 150,
      clientY: 24,
    });
    await vi.advanceTimersByTimeAsync(1_700);

    expect(within(bar).getByText("MICROFONO NON DISPONIBILE.")).toBeInTheDocument();
    expect(wrapper).toHaveClass("is-radio-active", "is-radio-error");

    await vi.advanceTimersByTimeAsync(2_999);
    expect(wrapper).toHaveClass("is-radio-active", "is-radio-error");

    await vi.advanceTimersByTimeAsync(1);
    expect(within(bar).queryByText("MICROFONO NON DISPONIBILE.")).not.toBeInTheDocument();
    expect(wrapper).not.toHaveClass("is-radio-active");
    expect(wrapper).not.toHaveClass("is-radio-error");
  });

  it("stops PTT when the finger exits the screen", async () => {
    vi.useFakeTimers();
    const startPtt = vi.fn().mockResolvedValue({
      ok: true,
      txId: "tx",
      streamId: 12,
      channelId: "cucina",
      startedAt: Date.now(),
    });
    const stopPtt = vi.fn();
    const onChange = vi.fn();
    radioMock.value = makeRadioMock({ startPtt, stopPtt });
    const { bar } = prepareBar(onChange);

    fireEvent.pointerDown(bar, {
      pointerId: 3,
      pointerType: "touch",
      clientX: 150,
      clientY: 24,
    });
    await vi.advanceTimersByTimeAsync(1_700);

    fireEvent.pointerMove(bar, {
      pointerId: 3,
      pointerType: "touch",
      clientX: -2,
      clientY: 24,
    });

    expect(startPtt).toHaveBeenCalledTimes(1);
    expect(stopPtt).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});
