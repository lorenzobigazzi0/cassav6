import { useMemo, type CSSProperties, type RefObject } from "react";
import type { UiNotification } from "../types";
import {
  getSystemConnectionLabel,
  getSystemConnectionRingColor,
} from "../../../app/runtime/systemConnectionStatus";
import { useSystemConnectionStatus } from "../../../app/runtime/SystemConnectionStatusContext";
import { AvatarMenu } from "./AvatarMenu";
import { BluetoothDiagnosticBadge } from "./BluetoothDiagnosticBadge";
import { NotificationsMenu } from "./NotificationsMenu";

interface TopbarRightProps {
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
  showPaymentAlert: boolean;
  onLogout: () => void;
  onClearRead: () => void;
  onClearAll: () => void;
  onConfirm: (id: string) => void;
  onDelete: (id: string) => void;
}

export function TopbarRight({
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
  showPaymentAlert,
  onLogout,
  onClearRead,
  onClearAll,
  onConfirm,
  onDelete,
}: TopbarRightProps) {
  const connectionState = useSystemConnectionStatus();
  const avatarConnection = useMemo(() => {
    return {
      className: `avatar-connection-ring avatar-connection-state-${connectionState}`,
      label: getSystemConnectionLabel(connectionState),
      style: {
        "--connection-ring-color": getSystemConnectionRingColor(connectionState),
      } as CSSProperties,
    };
  }, [connectionState]);

  return (
    <div className="topbar-right">
      <BluetoothDiagnosticBadge />
      <NotificationsMenu
        open={notifOpen}
        unreadCount={unreadCount}
        readCount={readCount}
        notifications={notifications}
        onToggle={onToggleNotif}
        onClearRead={onClearRead}
        onClearAll={onClearAll}
        onConfirm={onConfirm}
        onDelete={onDelete}
        containerRef={notifRef}
      />
      <AvatarMenu
        open={menuOpen}
        initials={initials}
        username={username}
        canCollectPayments={canCollectPayments}
        isDark={isDark}
        onToggle={onToggleMenu}
        onThemeToggle={onThemeToggle}
        onOpenProfile={onOpenProfile}
        onOpenSettings={onOpenSettings}
        onOpenRadio={onOpenRadio}
        onOpenPayments={onOpenPayments}
        showPaymentAlert={showPaymentAlert}
        onLogout={onLogout}
        containerRef={menuRef}
        avatarClassName={avatarConnection.className}
        avatarStatusLabel={avatarConnection.label}
        avatarStyle={avatarConnection.style}
      />
    </div>
  );
}
