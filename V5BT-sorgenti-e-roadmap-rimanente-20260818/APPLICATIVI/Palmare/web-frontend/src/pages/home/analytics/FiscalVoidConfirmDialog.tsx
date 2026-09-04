type FiscalVoidConfirmDialogProps = {
  open: boolean;
  documentLabel: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
};

export function FiscalVoidConfirmDialog({
  open,
  documentLabel,
  busy,
  error,
  onClose,
  onConfirm,
}: FiscalVoidConfirmDialogProps) {
  if (!open) return null;
  return (
    <div
      className="mobile-analytics-fiscal-void-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (!busy) onClose();
      }}
    >
      <section
        className="mobile-analytics-fiscal-void-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="mobile-fiscal-void-title"
        aria-describedby="mobile-fiscal-void-description"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <strong id="mobile-fiscal-void-title">Annulla documento fiscale</strong>
            <span>{documentLabel}</span>
          </div>
          <button
            type="button"
            className="smallbtn mobile-analytics-detail-close"
            aria-label="Chiudi conferma annullamento"
            disabled={busy}
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" className="table-detail-close-icon" aria-hidden="true">
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </header>
        <p id="mobile-fiscal-void-description">
          Confermi l&apos;annullamento fiscale del documento indicato?
        </p>
        {error ? <div className="mobile-analytics-detail-error">{error}</div> : null}
        <footer>
          <button
            type="button"
            className="smallbtn fiscal-void-cancel"
            disabled={busy}
            onClick={onClose}
          >
            ANNULLA OPERAZIONE
          </button>
          <button
            type="button"
            className="smallbtn fiscal-void-confirm"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "ANNULLAMENTO..." : "CONFERMA ANNULLAMENTO"}
          </button>
        </footer>
      </section>
    </div>
  );
}
