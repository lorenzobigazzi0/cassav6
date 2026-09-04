import React, { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationsMenu } from "../src/pages/home/components/NotificationsMenu";
import { triggerLongPressHaptic } from "../src/utils/haptics";
import type { UiNotification } from "../src/pages/home/types";

vi.mock("../src/utils/haptics", () => ({
  triggerLongPressHaptic: vi.fn(),
}));

const notifications: UiNotification[] = [
  {
    id: "read-1",
    type: "general",
    title: "Letta",
    description: "Notifica gia letta",
    createdAt: Date.now(),
    read: true,
  },
  {
    id: "unread-1",
    type: "general",
    title: "Da leggere",
    description: "Notifica non letta",
    createdAt: Date.now(),
    read: false,
  },
];

const renderMenu = ({
  items = notifications,
  readCount = items.filter((item) => item.read).length,
  onClearRead = vi.fn(),
  onClearAll = vi.fn(),
}: {
  items?: UiNotification[];
  readCount?: number;
  onClearRead?: () => void;
  onClearAll?: () => void;
} = {}) => {
  render(
    <NotificationsMenu
      open
      unreadCount={items.filter((item) => !item.read).length}
      readCount={readCount}
      notifications={items}
      onToggle={vi.fn()}
      onClearRead={onClearRead}
      onClearAll={onClearAll}
      onConfirm={vi.fn()}
      onDelete={vi.fn()}
      containerRef={createRef<HTMLDivElement>()}
    />
  );
  return { onClearRead, onClearAll };
};

describe("NotificationsMenu clear actions", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("mantiene il click breve sulle sole notifiche lette", () => {
    const { onClearRead, onClearAll } = renderMenu();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Cancella notifiche lette; tieni premuto per cancellarle tutte",
      })
    );

    expect(onClearRead).toHaveBeenCalledTimes(1);
    expect(onClearAll).not.toHaveBeenCalled();
  });

  it("apre la conferma dopo la pressione prolungata e non esegue il click breve", () => {
    vi.useFakeTimers();
    const { onClearRead, onClearAll } = renderMenu();
    const clearButton = screen.getByRole("button", {
      name: "Cancella notifiche lette; tieni premuto per cancellarle tutte",
    });

    fireEvent.pointerDown(clearButton, { pointerId: 1, pointerType: "touch", button: 0 });
    act(() => vi.advanceTimersByTime(649));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(triggerLongPressHaptic).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    fireEvent.pointerUp(clearButton, { pointerId: 1, pointerType: "touch", button: 0 });
    fireEvent.click(clearButton);
    expect(onClearRead).not.toHaveBeenCalled();
    expect(onClearAll).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "CANCELLA TUTTE" }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("consente il long press anche quando tutte le notifiche sono da leggere", () => {
    vi.useFakeTimers();
    const unreadOnly = notifications.filter((item) => !item.read);
    renderMenu({ items: unreadOnly, readCount: 0 });
    const clearButton = screen.getByRole("button", {
      name: "Cancella notifiche lette; tieni premuto per cancellarle tutte",
    });

    expect(clearButton).toBeEnabled();
    fireEvent.pointerDown(clearButton, { pointerId: 2, pointerType: "touch", button: 0 });
    act(() => vi.advanceTimersByTime(650));

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});
