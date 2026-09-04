import type { CSSProperties } from "react";
import logoutIconSrc from "../../../assets/icons/logout.png";
import profileIconSrc from "../../../assets/icons/profile.png";
import radioIconSrc from "../../../assets/icons/radio.png";
import settingsIconSrc from "../../../assets/icons/settings.png";
import { AppIcon } from "../../../components/AppIcon";

interface AvatarMenuProps {
  open: boolean;
  initials: string;
  username: string;
  canCollectPayments: boolean;
  isDark: boolean;
  onToggle: () => void;
  onThemeToggle: () => void;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  onOpenRadio: () => void;
  onOpenPayments: () => void;
  showPaymentAlert: boolean;
  onLogout: () => void;
  containerRef: React.RefObject<HTMLDivElement>;
  avatarClassName?: string;
  avatarStatusLabel?: string;
  avatarStyle?: CSSProperties;
}

export function AvatarMenu({
  open,
  initials,
  username,
  canCollectPayments,
  isDark,
  onToggle,
  onThemeToggle,
  onOpenProfile,
  onOpenSettings,
  onOpenRadio,
  onOpenPayments,
  showPaymentAlert,
  onLogout,
  containerRef,
  avatarClassName,
  avatarStatusLabel,
  avatarStyle,
}: AvatarMenuProps) {
  const operatorLabel = `Operatore ${username || ""}`.trim();
  const buttonLabel = avatarStatusLabel ? `${operatorLabel}, ${avatarStatusLabel}` : operatorLabel;

  return (
    <div className="menu-wrap" ref={containerRef}>
      <button
        className={["avatar", avatarClassName].filter(Boolean).join(" ")}
        style={avatarStyle}
        type="button"
        aria-label={buttonLabel}
        aria-expanded={open}
        title={avatarStatusLabel}
        onClick={onToggle}
      >
        <span className="avatar-initials">{initials}</span>
        {showPaymentAlert && (
          <span className="avatar-payment-alert payment-alert-blink" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="payment-alert-icon">
              <path className="payment-alert-triangle" d="M12 3l9 16H3z" />
              <path className="payment-alert-mark" d="M12 9v5" />
              <circle className="payment-alert-dot" cx="12" cy="17" r="1.1" />
            </svg>
          </span>
        )}
      </button>
      {open && (
        <div className="menu">
          <button className="menu-item" type="button" onClick={onOpenProfile}>
            <span className="menu-item-main">
              <AppIcon
                src={profileIconSrc}
                className="icon menu-item-icon"
                fallback={
                  <svg className="icon menu-item-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="8" r="3.5" />
                    <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
                  </svg>
                }
              />
              <span>Profilo</span>
            </span>
          </button>
          <button className="menu-item" type="button" onClick={onOpenSettings}>
            <span className="menu-item-main">
              <AppIcon
                src={settingsIconSrc}
                className="icon menu-item-icon"
                fallback={
                  <svg className="icon menu-item-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="3.2" />
                    <path d="M12 4v2" />
                    <path d="M12 18v2" />
                    <path d="M4 12h2" />
                    <path d="M18 12h2" />
                    <path d="M6.2 6.2l1.4 1.4" />
                    <path d="M16.4 16.4l1.4 1.4" />
                    <path d="M16.4 7.6l1.4-1.4" />
                    <path d="M6.2 17.8l1.4-1.4" />
                  </svg>
                }
              />
              <span>Impostazioni</span>
            </span>
          </button>
          <button className="menu-item" type="button" onClick={onOpenRadio}>
            <span className="menu-item-main">
              <AppIcon
                src={radioIconSrc}
                className="icon menu-item-icon"
                fallback={
                  <svg className="icon menu-item-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6.5 16.5a8 8 0 0 1 0-9" />
                    <path d="M17.5 7.5a8 8 0 0 1 0 9" />
                    <path d="M9.3 14a4 4 0 0 1 0-4" />
                    <path d="M14.7 10a4 4 0 0 1 0 4" />
                    <circle cx="12" cy="12" r="1.8" />
                  </svg>
                }
              />
              <span>Radio</span>
            </span>
          </button>
          {canCollectPayments && (
            <button className="menu-item" type="button" onClick={onOpenPayments}>
              <span className="menu-item-main">
                <svg className="icon menu-item-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="3.5" y="5.5" width="17" height="13" rx="2.6" />
                  <path d="M3.5 10.5h17" />
                  <path d="M8 15h4" />
                </svg>
                <span>Pagamenti</span>
              </span>
              {showPaymentAlert && (
                <span className="menu-payment-alert payment-alert-blink" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="payment-alert-icon">
                    <path className="payment-alert-triangle" d="M12 3l9 16H3z" />
                    <path className="payment-alert-mark" d="M12 9v5" />
                    <circle className="payment-alert-dot" cx="12" cy="17" r="1.1" />
                  </svg>
                </span>
              )}
            </button>
          )}
          <div className="menu-item menu-style">
            <span>Stile</span>
            <button
              className={`theme-toggle ${isDark ? "is-dark" : ""}`}
              type="button"
              aria-label="Stile"
              aria-pressed={isDark}
              onClick={onThemeToggle}
            >
              <span className="toggle-knob">
                <svg className="toggle-icon sun" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2" />
                  <path d="M12 20v2" />
                  <path d="M2 12h2" />
                  <path d="M20 12h2" />
                  <path d="M4.9 4.9l1.4 1.4" />
                  <path d="M17.7 17.7l1.4 1.4" />
                  <path d="M17.7 6.3l1.4-1.4" />
                  <path d="M4.9 19.1l1.4-1.4" />
                </svg>
                <svg className="toggle-icon moon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3a7 7 0 0 0 11.5 11.5z" />
                </svg>
              </span>
            </button>
          </div>
          <div className="menu-sep" />
          <button className="menu-item menu-logout" type="button" onClick={onLogout}>
            <span className="menu-item-main">
              <AppIcon
                src={logoutIconSrc}
                className="icon menu-item-icon"
                fallback={
                  <svg className="icon menu-item-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M14 4h5v16h-5" />
                    <path d="M10 12h9" />
                    <path d="M12.8 9.2L10 12l2.8 2.8" />
                    <path d="M15 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9" />
                  </svg>
                }
              />
              <span>Logout</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
