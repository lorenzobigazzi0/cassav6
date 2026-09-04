import { useEffect, useRef, type PointerEvent } from "react";
import type { RefObject } from "react";
import { triggerLongPressHaptic } from "../../../utils/haptics";
import type { CallNotification, UiNotification } from "../types";
import { TopbarLeft } from "./TopbarLeft";
import { TopbarRight } from "./TopbarRight";

const TITLE_LONG_PRESS_MS = 650;

interface TopBarProps {
  pageTitle: string;
  waiterCount: number;
  bellCount: number;
  historyType: "waiter" | "bell" | null;
  waiterHistory: CallNotification[];
  bellHistory: CallNotification[];
  onOpenWaiter: () => void;
  onOpenBell: () => void;
  onDeleteHistoryById: (id: string) => void;
  onClearWaiterHistory: () => void;
  onClearBellHistory: () => void;
  menuOpen: boolean;
  notifOpen: boolean;
  unreadCount: number;
  readCount: number;
  notifications: UiNotification[];
  canCollectPayments: boolean;
  initials: string;
  username: string;
  isDark: boolean;
  menuRef: RefObject<HTMLDivElement>;
  notifRef: RefObject<HTMLDivElement>;
  onToggleMenu: () => void;
  onToggleNotif: () => void;
  onThemeToggle: () => void;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  onOpenRadio: () => void;
  onOpenPayments: () => void;
  onTitleLongPress?: () => void;
  showPaymentAlert: boolean;
  onLogout: () => void;
  onClearRead: () => void;
  onClearAll: () => void;
  onConfirm: (id: string) => void;
  onDelete: (id: string) => void;
}

export function TopBar({
  pageTitle,
  waiterCount,
  bellCount,
  historyType,
  waiterHistory,
  bellHistory,
  onOpenWaiter,
  onOpenBell,
  onDeleteHistoryById,
  onClearWaiterHistory,
  onClearBellHistory,
  menuOpen,
  notifOpen,
  unreadCount,
  readCount,
  notifications,
  canCollectPayments,
  initials,
  username,
  isDark,
  menuRef,
  notifRef,
  onToggleMenu,
  onToggleNotif,
  onThemeToggle,
  onOpenProfile,
  onOpenSettings,
  onOpenRadio,
  onOpenPayments,
  onTitleLongPress,
  showPaymentAlert,
  onLogout,
  onClearRead,
  onClearAll,
  onConfirm,
  onDelete,
}: TopBarProps) {
  const titleLongPressTimerRef = useRef<number | null>(null);

  const clearTitleLongPress = () => {
    if (titleLongPressTimerRef.current === null) return;
    window.clearTimeout(titleLongPressTimerRef.current);
    titleLongPressTimerRef.current = null;
  };

  useEffect(() => clearTitleLongPress, []);

  const startTitleLongPress = (event: PointerEvent<HTMLDivElement>) => {
    if (!onTitleLongPress) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    clearTitleLongPress();
    titleLongPressTimerRef.current = window.setTimeout(() => {
      titleLongPressTimerRef.current = null;
      triggerLongPressHaptic();
      onTitleLongPress();
    }, TITLE_LONG_PRESS_MS);
  };

  return (
    <div className="home-topbar">
      <div
        className={`topbar-title ${onTitleLongPress ? "is-long-pressable" : ""}`}
        aria-live="polite"
        onPointerDown={startTitleLongPress}
        onPointerUp={clearTitleLongPress}
        onPointerCancel={clearTitleLongPress}
        onContextMenu={(event) => {
          if (!onTitleLongPress) return;
          event.preventDefault();
        }}
      >
        {pageTitle}
      </div>
      <TopbarLeft
        waiterCount={waiterCount}
        bellCount={bellCount}
        historyType={historyType}
        waiterHistory={waiterHistory}
        bellHistory={bellHistory}
        onOpenWaiter={onOpenWaiter}
        onOpenBell={onOpenBell}
        onDeleteHistoryById={onDeleteHistoryById}
        onClearWaiterHistory={onClearWaiterHistory}
        onClearBellHistory={onClearBellHistory}
      />
      <TopbarRight
        menuOpen={menuOpen}
        notifOpen={notifOpen}
        unreadCount={unreadCount}
        readCount={readCount}
        notifications={notifications}
        canCollectPayments={canCollectPayments}
        initials={initials}
        username={username}
        isDark={isDark}
        menuRef={menuRef}
        notifRef={notifRef}
        onToggleMenu={onToggleMenu}
        onToggleNotif={onToggleNotif}
        onThemeToggle={onThemeToggle}
        onOpenProfile={onOpenProfile}
        onOpenSettings={onOpenSettings}
        onOpenRadio={onOpenRadio}
        onOpenPayments={onOpenPayments}
        showPaymentAlert={showPaymentAlert}
        onLogout={onLogout}
        onClearRead={onClearRead}
        onClearAll={onClearAll}
        onConfirm={onConfirm}
        onDelete={onDelete}
      />
    </div>
  );
}
