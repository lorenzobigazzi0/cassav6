type ServiceRecoveryChoicePanelProps = {
  disabled: boolean;
  onCancelOrder: () => void;
  onModifyOrder: () => void;
};

type ServiceRecoveryCancelConfirmDialogProps = {
  busy: boolean;
  reason: string;
  error: string | null;
  onReasonChange: (value: string) => void;
  onBack: () => void;
  onConfirm: () => void;
};

type ServiceRecoveryAlertDialogProps = {
  message: string;
  onClose: () => void;
};

export function ServiceRecoveryChoicePanel({
  disabled,
  onCancelOrder,
  onModifyOrder,
}: ServiceRecoveryChoicePanelProps) {
  return (
    <div className="msr-choice-panel">
      <div className="msr-choice-copy">
        <strong>Che cosa vuoi fare?</strong>
      </div>
      <div className="msr-choice-actions">
        <button
          className="msr-choice-card msr-choice-danger"
          type="button"
          onClick={onCancelOrder}
          disabled={disabled}
        >
          <strong>Annulla comanda</strong>
          <span>Chiude la comanda e la rimuove dal lavoro operativo.</span>
        </button>
        <button
          className="msr-choice-card"
          type="button"
          onClick={onModifyOrder}
          disabled={disabled}
        >
          <strong>Modifica comanda</strong>
          <span>Cambia quantita, varianti, supplementi, note o comunicazioni.</span>
        </button>
      </div>
    </div>
  );
}

export function ServiceRecoveryCancelConfirmDialog({
  busy,
  reason,
  error,
  onReasonChange,
  onBack,
  onConfirm,
}: ServiceRecoveryCancelConfirmDialogProps) {
  return (
    <>
      <div className="msr-reason-backdrop" />
      <section
        className="msr-reason-modal msr-cancel-confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Conferma annullamento comanda"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <strong>Conferma annullamento</strong>
        </header>
        <p className="msr-confirm-copy">
          La comanda verra annullata e verra stampato il tagliando di annullamento.
        </p>
        {error ? <div className="msr-error">{error}</div> : null}
        <textarea
          className="msr-input msr-textarea"
          value={reason}
          maxLength={300}
          onChange={(event) => onReasonChange(event.target.value)}
          placeholder="Motivo annullamento"
          disabled={busy}
        />
        <footer>
          <button className="smallbtn msr-secondary" type="button" onClick={onBack} disabled={busy}>
            ANNULLA
          </button>
          <button
            className="smallbtn msr-danger-confirm"
            type="button"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "INVIO..." : "CONFERMA"}
          </button>
        </footer>
      </section>
    </>
  );
}

export function ServiceRecoveryAlertDialog({ message, onClose }: ServiceRecoveryAlertDialogProps) {
  return (
    <>
      <div className="msr-reason-backdrop" />
      <section
        className="msr-reason-modal msr-notice-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="msr-alert-title"
        aria-describedby="msr-alert-message"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <strong id="msr-alert-title">Attenzione</strong>
        </header>
        <div id="msr-alert-message" className="msr-error">
          {message}
        </div>
        <footer>
          <button className="smallbtn msr-primary" type="button" onClick={onClose} autoFocus>
            OK
          </button>
        </footer>
      </section>
    </>
  );
}
