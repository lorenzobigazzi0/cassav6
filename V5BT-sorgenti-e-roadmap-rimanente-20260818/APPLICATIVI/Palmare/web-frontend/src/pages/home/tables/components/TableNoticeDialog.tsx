import { createPortal } from "react-dom";

type TableNoticeDialogProps = {
  message: string | null;
  onDismiss: () => void;
};

/** Avviso bloccante con un solo OK: sostituisce la riga di errore in linea. */
export function TableNoticeDialog({ message, onDismiss }: TableNoticeDialogProps) {
  if (!message || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="tables-move-confirm-backdrop table-notice-backdrop"
      role="presentation"
      onClick={onDismiss}
    >
      <section
        className="tables-move-confirm-card table-notice-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="table-notice-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onDismiss();
        }}
      >
        <div id="table-notice-title" className="tables-move-confirm-title">
          AVVISO
        </div>
        <div className="tables-move-confirm-body">
          <p className="tables-move-confirm-warning">{message}</p>
        </div>
        <div className="tables-move-confirm-actions">
          <button
            type="button"
            className="smallbtn tables-move-confirm-btn table-notice-ok"
            onClick={onDismiss}
            autoFocus
          >
            OK
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}
