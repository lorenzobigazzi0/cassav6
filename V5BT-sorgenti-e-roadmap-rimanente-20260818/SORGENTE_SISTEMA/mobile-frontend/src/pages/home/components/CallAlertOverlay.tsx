import type { CallNotification } from "../types";
import { formatRelativeTime } from "../utils/time";

interface CallAlertOverlayProps {
  notification: CallNotification | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function CallAlertOverlay({ notification, onClose, onConfirm }: CallAlertOverlayProps) {
  if (!notification) return null;

  const isWaiter = notification.type === "waiter";

  return (
    <div className="call-overlay" role="dialog" aria-modal="true" aria-label="Chiamata">
      <div className={`call-card ${isWaiter ? "call-waiter" : "call-bell"}`}>
        <div className="call-head">
          <div className="call-type">{isWaiter ? "Chiamata Cameriere" : "Comanda Pronta"}</div>
          <div className="call-time">{formatRelativeTime(notification.createdAt)}</div>
        </div>
        <div className="call-title">{notification.title}</div>
        {notification.description ? <div className="call-desc">{notification.description}</div> : null}
        <div className="call-actions">
          <button className="smallbtn call-close" type="button" onClick={onClose}>
            Chiudi
          </button>
          <button className="btn call-confirm" type="button" onClick={onConfirm}>
            Conferma
          </button>
        </div>
      </div>
    </div>
  );
}
