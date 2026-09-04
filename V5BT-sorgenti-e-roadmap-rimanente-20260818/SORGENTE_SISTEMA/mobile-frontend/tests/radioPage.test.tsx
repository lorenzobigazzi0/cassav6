import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { RadioPage } from "../src/pages/RadioPage";
import type { RadioContextValue } from "../src/radio/radioContext";

const radioMock = vi.hoisted(() => ({
  value: null as RadioContextValue | null,
}));

vi.mock("../src/radio/useRadio", () => ({
  useRadio: () => {
    if (!radioMock.value) throw new Error("missing radio mock");
    return radioMock.value;
  },
  useOptionalRadio: () => radioMock.value,
}));

function makeRadioMock(overrides: Partial<RadioContextValue> = {}): RadioContextValue {
  return {
    channels: [
      { id: "cucina", name: "Cucina", enabled: true, color: "#ff9f43", sortOrder: 1 },
      { id: "bar", name: "Bar", enabled: true, color: "#00d2ff", sortOrder: 2 },
    ],
    slots: ["cucina", null, null],
    activeSlots: [{ id: "cucina", name: "Cucina", enabled: true, color: "#ff9f43", sortOrder: 1 }],
    status: "ready",
    ptt: { mode: "idle" },
    incoming: null,
    outgoing: null,
    audioLevels: [],
    incomingAudioLevels: [],
    isChannelBusy: vi.fn(() => false),
    saveSlots: vi.fn().mockResolvedValue(undefined),
    preparePttAudio: vi.fn().mockResolvedValue(undefined),
    startPtt: vi.fn().mockResolvedValue({
      ok: true,
      txId: "tx",
      streamId: 1,
      channelId: "cucina",
      startedAt: 1000,
    }),
    stopPtt: vi.fn(),
    startEchoTest: vi.fn().mockResolvedValue({
      ok: true,
      txId: "echo",
      streamId: 2,
      startedAt: 1000,
    }),
    stopEchoTest: vi.fn(),
    refreshConfig: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function renderRadioPage() {
  return render(
    <MemoryRouter>
      <RadioPage />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  radioMock.value = null;
  vi.useRealTimers();
});

describe("RadioPage", () => {
  it("refreshes radio channels when the page opens", async () => {
    const refreshConfig = vi.fn().mockResolvedValue(undefined);
    radioMock.value = makeRadioMock({ refreshConfig });

    renderRadioPage();

    await waitFor(() => {
      expect(refreshConfig).toHaveBeenCalledTimes(1);
    });
  });

  it("renders slot selectors and saves selected slots through the radio provider", async () => {
    const saveSlots = vi.fn().mockResolvedValue(undefined);
    radioMock.value = makeRadioMock({ saveSlots });

    renderRadioPage();

    expect(screen.getByText("Radio connessa")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Echo Test radio" })).toBeEnabled();

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Canale 1" }));
    fireEvent.click(screen.getByRole("option", { name: "Bar" }));

    await waitFor(() => {
      expect(saveSlots).toHaveBeenCalledWith(["bar", null, null]);
    });
  });

  it("disables PTT controls when radio is not ready", () => {
    radioMock.value = makeRadioMock({ status: "disconnected" });

    renderRadioPage();

    expect(screen.getByRole("button", { name: "PTT Cucina" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Echo Test radio" })).toBeDisabled();
  });

  it("keeps a Radio page PTT hold active when WebView emits pointercancel", async () => {
    vi.useFakeTimers();
    const startPtt = vi.fn().mockResolvedValue({
      ok: true,
      txId: "tx",
      streamId: 3,
      channelId: "cucina",
      startedAt: 1000,
    });
    const stopPtt = vi.fn();
    radioMock.value = makeRadioMock({ startPtt, stopPtt });

    renderRadioPage();

    const pttButton = screen.getByRole("button", { name: "PTT Cucina" }) as HTMLButtonElement;
    pttButton.setPointerCapture = vi.fn();
    pttButton.hasPointerCapture = vi.fn(() => true);
    pttButton.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(pttButton, {
      pointerId: 21,
      pointerType: "touch",
      clientX: 240,
      clientY: 420,
    });
    await vi.advanceTimersByTimeAsync(1_700);

    fireEvent.pointerCancel(pttButton, {
      pointerId: 21,
      pointerType: "touch",
      clientX: 250,
      clientY: 430,
    });

    expect(startPtt).toHaveBeenCalledTimes(1);
    expect(stopPtt).not.toHaveBeenCalled();

    fireEvent.pointerUp(pttButton, {
      pointerId: 21,
      pointerType: "touch",
      clientX: 250,
      clientY: 430,
    });

    expect(stopPtt).toHaveBeenCalledTimes(1);
  });

  it("blocks Radio page PTT immediately when the channel is already busy", async () => {
    vi.useFakeTimers();
    const isChannelBusy = vi.fn(() => true);
    const preparePttAudio = vi.fn().mockResolvedValue(undefined);
    const startPtt = vi.fn();
    radioMock.value = makeRadioMock({ isChannelBusy, preparePttAudio, startPtt });

    renderRadioPage();

    const pttButton = screen.getByRole("button", { name: "PTT Cucina" }) as HTMLButtonElement;
    pttButton.setPointerCapture = vi.fn();
    pttButton.hasPointerCapture = vi.fn(() => true);
    pttButton.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(pttButton, {
      pointerId: 22,
      pointerType: "touch",
      clientX: 240,
      clientY: 420,
    });

    expect(isChannelBusy).toHaveBeenCalledWith("cucina");
    expect(preparePttAudio).not.toHaveBeenCalled();
    expect(startPtt).not.toHaveBeenCalled();
    expect(screen.getByText("CANALE OCCUPATO")).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(screen.queryByText("CANALE OCCUPATO")).not.toBeInTheDocument();
  });
});
