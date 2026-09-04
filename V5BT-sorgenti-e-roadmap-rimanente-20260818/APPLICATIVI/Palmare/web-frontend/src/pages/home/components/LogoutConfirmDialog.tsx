import { useEffect } from "react";
import { createPortal } from "react-dom";

interface LogoutConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function LogoutConfirmDialog({
  open,
  onCancel,
  onConfirm,
}: LogoutConfirmDialogProps) {
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
    <div className="notif-clear-all-backdrop logout-confirm-backdrop" onClick={onCancel}>
      <section
        className="notif-clear-all-dialog logout-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="logout-confirm-title"
        aria-describedby="logout-confirm-description"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="notif-clear-all-head">
          <div>
            <span>SESSIONE</span>
            <h2 id="logout-confirm-title">Conferma logout</h2>
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
        <p id="logout-confirm-description">Vuoi uscire dalla sessione corrente?</p>
        <div className="notif-clear-all-actions">
          <button type="button" className="notif-clear-all-cancel" onClick={onCancel} autoFocus>
            ANNULLA
          </button>
          <button type="button" className="notif-clear-all-confirm" onClick={onConfirm}>
            ESCI
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}
