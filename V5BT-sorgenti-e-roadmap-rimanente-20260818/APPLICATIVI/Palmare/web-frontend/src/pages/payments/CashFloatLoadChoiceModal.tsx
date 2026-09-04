type CashFloatLoadChoiceModalProps = {
  open: boolean;
  onClose: () => void;
  onAutomatic: () => void;
  onManual: () => void;
  automaticDisabled?: boolean;
  automaticDisabledReason?: string;
};

export function CashFloatLoadChoiceModal({
  open,
  onClose,
  onAutomatic,
  onManual,
  automaticDisabled = false,
  automaticDisabledReason = "",
}: CashFloatLoadChoiceModalProps) {
  if (!open) return null;

  return (
    <div className="payments-confirm-backdrop" onClick={onClose}>
      <div
        className="payments-confirm-card payments-cash-choice-card"
        role="dialog"
        aria-modal="true"
        aria-label="Carica fondo cassa"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="payments-confirm-head">
          <strong>Carica fondo cassa</strong>
          <button
            type="button"
            className="smallbtn payments-confirm-close"
            onClick={onClose}
            aria-label="Chiudi"
          >
            <svg viewBox="0 0 24 24" className="table-detail-close-icon" aria-hidden="true">
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </div>

        <div className="payments-cash-choice-actions">
          <button
            type="button"
            className="smallbtn payments-cash-choice-btn is-auto"
            disabled={automaticDisabled}
            title={automaticDisabledReason || "Carica fondo cassa automatico"}
            onClick={onAutomatic}
          >
            Automatico
          </button>
          <button
            type="button"
            className="smallbtn payments-cash-choice-btn is-manual"
            onClick={onManual}
          >
            Manuale
          </button>
        </div>

        {automaticDisabled && automaticDisabledReason ? (
          <div className="payments-note payments-cash-choice-note">
            {automaticDisabledReason}
          </div>
        ) : null}
      </div>
    </div>
  );
}
