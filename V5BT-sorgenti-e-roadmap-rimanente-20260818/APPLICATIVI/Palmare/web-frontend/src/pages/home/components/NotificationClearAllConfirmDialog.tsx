import { useEffect } from "react";
import { createPortal } from "react-dom";

interface NotificationClearAllConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function NotificationClearAllConfirmDialog({
  open,
  onCancel,
  onConfirm,
}: NotificationClearAllConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return createPortal(
    <div className="notif-clear-all-backdrop" onClick={onCancel}>
      <section
        className="notif-clear-all-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="notif-clear-all-title"
        aria-describedby="notif-clear-all-description"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="notif-clear-all-head">
          <div>
            <span>NOTIFICHE</span>
            <h2 id="notif-clear-all-title">Cancella tutte?</h2>
          </div>
          <button
            type="button"
            className="notif-clear-all-close"
            aria-label="Chiudi"
            onClick={onCancel}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        <p id="notif-clear-all-description">
          Verranno eliminate anche le notifiche non ancora lette. L'operazione non puo essere
          annullata.
        </p>
        <div className="notif-clear-all-actions">
          <button type="button" className="notif-clear-all-cancel" onClick={onCancel} autoFocus>
            ANNULLA
          </button>
          <button type="button" className="notif-clear-all-confirm" onClick={onConfirm}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16M9 7V5h6v2M7 7l1 12h8l1-12" />
            </svg>
            CANCELLA TUTTE
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}
