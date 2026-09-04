import React, { createRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AvatarMenu } from "../src/pages/home/components/AvatarMenu";
import { RadioIncomingPill, SystemRow } from "../src/pages/home/components/SystemRow";
import type { IncomingRadioState, OutgoingRadioState } from "../src/radio/radioTypes";

const radioHookState = vi.hoisted(() => ({
  incoming: null as IncomingRadioState | null,
  outgoing: null as OutgoingRadioState | null,
  audioLevels: [] as number[],
  incomingAudioLevels: [] as number[],
}));

vi.mock("../src/radio/useRadio", () => ({
  useOptionalRadio: () => ({
    incoming: radioHookState.incoming,
    outgoing: radioHookState.outgoing,
    audioLevels: radioHookState.audioLevels,
    incomingAudioLevels: radioHookState.incomingAudioLevels,
  }),
}));

afterEach(() => {
  cleanup();
  radioHookState.incoming = null;
  radioHookState.outgoing = null;
  radioHookState.audioLevels = [];
  radioHookState.incomingAudioLevels = [];
  vi.useRealTimers();
});

const incoming: IncomingRadioState = {
  streamId: 42,
  channelId: "sala",
  channelName: "Sala",
  channelColor: "#00d2ff",
  speaker: {
    userId: "u1",
    displayName: "Lorenzo Bigazzi",
    fullName: "Lorenzo Bigazzi",
  },
  startedAt: 123,
};

const secondIncoming: IncomingRadioState = {
  ...incoming,
  streamId: 99,
  channelId: "bar",
  channelName: "Bar",
  channelColor: "#22c55e",
  speaker: {
    userId: "u2",
    displayName: "Giada Neri",
    fullName: "Giada Neri",
  },
};

const outgoing: OutgoingRadioState = {
  streamId: 121,
  channelId: "bar",
  channelName: "Bar",
  channelColor: "#00d2ff",
  startedAt: 2_000,
  source: "bottom-bar",
};

describe("radio top bar UI", () => {
  it("renders the incoming radio pill with channel and formatted speaker", () => {
    render(<RadioIncomingPill incoming={incoming} />);

    const pill = screen.getByLabelText("Trasmissione radio in arrivo");
    expect(pill).toHaveClass("radio-incoming-pill");
    expect(pill).toHaveStyle({ "--radio-pill-color": "#00d2ff" });
    expect(screen.getByText("Sala")).toBeInTheDocument();
    expect(screen.getByText("Lorenzo B.")).toBeInTheDocument();
    expect(pill.querySelectorAll(".radio-pill-waveform i")).toHaveLength(12);
  });

  it("shows the incoming radio waveform using live receive levels", () => {
    radioHookState.incoming = incoming;
    radioHookState.incomingAudioLevels = [0.15, 0.72, 0.38, 0.9];

    render(<SystemRow timeLabel="12:00" showBattery={false} showRadioPill={true} />);

    const pill = screen.getByLabelText("Trasmissione radio in arrivo");
    const bars = pill.querySelectorAll(".radio-pill-waveform i");
    expect(pill).toHaveClass("radio-incoming-pill", "is-incoming");
    expect(bars).toHaveLength(4);
    expect((bars[1] as HTMLElement).style.getPropertyValue("--radio-pill-wave-level")).toBe("0.72");
  });

  it("keeps the incoming radio pill visible for one second after the call ends", () => {
    vi.useFakeTimers();
    radioHookState.incoming = incoming;
    const view = render(<SystemRow timeLabel="12:00" showBattery={false} showRadioPill={true} />);

    expect(screen.getByText("Sala")).toBeInTheDocument();
    radioHookState.incoming = null;
    view.rerender(<SystemRow timeLabel="12:00" showBattery={false} showRadioPill={true} />);

    expect(screen.getByLabelText("Trasmissione radio in arrivo")).not.toHaveClass("is-closing");
    act(() => vi.advanceTimersByTime(999));
    expect(screen.getByLabelText("Trasmissione radio in arrivo")).not.toHaveClass("is-closing");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByLabelText("Trasmissione radio in arrivo")).toHaveClass("is-closing");
    act(() => vi.advanceTimersByTime(240));
    expect(screen.queryByLabelText("Trasmissione radio in arrivo")).not.toBeInTheDocument();
  });

  it("replaces the lingering pill immediately when a second caller starts", () => {
    vi.useFakeTimers();
    radioHookState.incoming = incoming;
    const view = render(<SystemRow timeLabel="12:00" showBattery={false} showRadioPill={true} />);

    radioHookState.incoming = null;
    view.rerender(<SystemRow timeLabel="12:00" showBattery={false} showRadioPill={true} />);
    act(() => vi.advanceTimersByTime(500));

    radioHookState.incoming = secondIncoming;
    view.rerender(<SystemRow timeLabel="12:00" showBattery={false} showRadioPill={true} />);

    expect(screen.queryByText("Sala")).not.toBeInTheDocument();
    expect(screen.getByText("Bar")).toBeInTheDocument();
    expect(screen.getByText("Giada N.")).toBeInTheDocument();
    expect(screen.getByLabelText("Trasmissione radio in arrivo")).not.toHaveClass("is-closing");
  });

  it("shows outgoing channel, waveform and timer in the top radio pill", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_250);
    radioHookState.outgoing = outgoing;
    radioHookState.audioLevels = [0.2, 0.8, 0.45];

    render(<SystemRow timeLabel="12:00" showBattery={false} showRadioPill={true} />);

    const pill = screen.getByLabelText("Trasmissione radio in corso");
    expect(pill).toHaveClass("radio-incoming-pill", "is-outgoing");
    expect(screen.getByText("Bar")).toBeInTheDocument();
    expect(screen.getByText("00:03")).toHaveClass("radio-pill-timer");
    expect(pill.querySelectorAll(".radio-pill-waveform i")).toHaveLength(3);
    expect(screen.queryByText("RILASCIA PER TERMINARE")).not.toBeInTheDocument();
  });

  it("scrolls long outgoing channel names without moving the centered waveform", () => {
    radioHookState.outgoing = {
      ...outgoing,
      channelName: "Sala panoramica superiore",
    };

    render(<SystemRow timeLabel="12:00" showBattery={false} showRadioPill={true} />);

    const pill = screen.getByLabelText("Trasmissione radio in corso");
    expect(pill.querySelector(".radio-pill-channel")).toHaveClass("is-marquee");
    expect(pill.querySelector(".radio-pill-waveform")).toBeInTheDocument();
    expect(pill.querySelector(".radio-pill-timer")).toBeInTheDocument();
  });

  it("keeps avatar initials and payment warning while adding the backend connection ring", () => {
    render(
      <AvatarMenu
        open={false}
        initials="LB"
        username="lorenzo"
        canCollectPayments={true}
        isDark={false}
        onToggle={vi.fn()}
        onThemeToggle={vi.fn()}
        onOpenProfile={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenRadio={vi.fn()}
        onOpenPayments={vi.fn()}
        showPaymentAlert={true}
        onLogout={vi.fn()}
        containerRef={createRef<HTMLDivElement>()}
        avatarClassName="avatar-connection-ring avatar-connection-state-online"
        avatarStatusLabel="Server connesso"
        avatarStyle={{ "--connection-ring-color": "#2fdc86" } as React.CSSProperties}
      />
    );

    const avatar = screen.getByRole("button", { name: /Operatore lorenzo, Server connesso/i });
    expect(avatar).toHaveClass(
      "avatar",
      "avatar-connection-ring",
      "avatar-connection-state-online"
    );
    expect(screen.getByText("LB")).toHaveClass("avatar-initials");
    expect(screen.queryByText("Radio")).not.toBeInTheDocument();
    expect(avatar.querySelector(".avatar-payment-alert")).toBeInTheDocument();
  });

  it("shows the Radio item when the avatar menu is open", () => {
    const { container } = render(
      <AvatarMenu
        open={true}
        initials="LB"
        username="lorenzo"
        canCollectPayments={false}
        isDark={false}
        onToggle={vi.fn()}
        onThemeToggle={vi.fn()}
        onOpenProfile={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenRadio={vi.fn()}
        onOpenPayments={vi.fn()}
        showPaymentAlert={false}
        onLogout={vi.fn()}
        containerRef={createRef<HTMLDivElement>()}
      />
    );

    expect(screen.getByRole("button", { name: "Radio" })).toBeInTheDocument();
    const radioButton = screen.getByRole("button", { name: "Radio" });
    expect(radioButton.querySelector("img.app-icon-img.menu-item-icon")).toBeInTheDocument();
    expect(container.innerHTML).toContain("radio.png");
  });
});
