import { createPortal } from "react-dom";

type TableAllergyRemovalDialogProps = {
  intolerance: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function TableAllergyRemovalDialog({
  intolerance,
  busy,
  onCancel,
  onConfirm,
}: TableAllergyRemovalDialogProps) {
  if (!intolerance || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="tables-move-confirm-backdrop table-allergy-remove-confirm-backdrop"
      role="presentation"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <section
        className="tables-move-confirm-card table-allergy-remove-confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="table-allergy-remove-confirm-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onCancel();
        }}
      >
        <div id="table-allergy-remove-confirm-title" className="tables-move-confirm-title">
          RIMUOVI ALLERGIA / INTOLLERANZA
        </div>
        <div className="tables-move-confirm-body">
          <p className="tables-move-confirm-warning">
            CONFERMI LA RIMOZIONE DI <strong>{intolerance}</strong>?
          </p>
        </div>
        <div className="tables-move-confirm-actions">
          <button
            type="button"
            className="smallbtn tables-move-confirm-btn is-cancel"
            onClick={onCancel}
            disabled={busy}
            autoFocus
          >
            ANNULLA
          </button>
          <button
            type="button"
            className="smallbtn tables-move-confirm-btn table-allergy-remove-confirm-btn"
            onClick={onConfirm}
            disabled={busy}
          >
            CONFERMA
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}
