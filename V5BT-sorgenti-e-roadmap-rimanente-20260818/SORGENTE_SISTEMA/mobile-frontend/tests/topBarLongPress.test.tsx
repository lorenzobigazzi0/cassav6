import React, { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopBar } from "../src/pages/home/components/TopBar";

vi.mock("../src/utils/haptics", () => ({
  triggerLongPressHaptic: vi.fn(),
}));

const renderTopBar = (onTitleLongPress = vi.fn()) =>
  render(
    <TopBar
      pageTitle="TAVOLI"
      waiterCount={0}
      bellCount={0}
      historyType={null}
      waiterHistory={[]}
      bellHistory={[]}
      onOpenWaiter={vi.fn()}
      onOpenBell={vi.fn()}
      onDeleteHistoryById={vi.fn()}
      onClearWaiterHistory={vi.fn()}
      onClearBellHistory={vi.fn()}
      menuOpen={false}
      notifOpen={false}
      unreadCount={0}
      readCount={0}
      notifications={[]}
      canCollectPayments={true}
      initials="AD"
      username="Admin"
      isDark={false}
      menuRef={createRef<HTMLDivElement>()}
      notifRef={createRef<HTMLDivElement>()}
      onToggleMenu={vi.fn()}
      onToggleNotif={vi.fn()}
      onThemeToggle={vi.fn()}
      onOpenProfile={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenRadio={vi.fn()}
      onOpenPayments={vi.fn()}
      onTitleLongPress={onTitleLongPress}
      showPaymentAlert={false}
      onLogout={vi.fn()}
      onClearRead={vi.fn()}
      onClearAll={vi.fn()}
      onConfirm={vi.fn()}
      onDelete={vi.fn()}
    />
  );

describe("TopBar title long press", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("fires the title long press after the configured hold time", () => {
    vi.useFakeTimers();
    const onTitleLongPress = vi.fn();
    renderTopBar(onTitleLongPress);

    fireEvent.pointerDown(screen.getByText("TAVOLI"), { pointerId: 1 });
    act(() => vi.advanceTimersByTime(649));
    expect(onTitleLongPress).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onTitleLongPress).toHaveBeenCalledTimes(1);
  });

  it("keeps the hold alive when the pointer leaves the title before release", () => {
    vi.useFakeTimers();
    const onTitleLongPress = vi.fn();
    renderTopBar(onTitleLongPress);
    const title = screen.getByText("TAVOLI");

    fireEvent.pointerDown(title, { pointerId: 1 });
    fireEvent.pointerLeave(title, { pointerId: 1 });
    act(() => vi.advanceTimersByTime(650));

    expect(onTitleLongPress).toHaveBeenCalledTimes(1);
  });
});
