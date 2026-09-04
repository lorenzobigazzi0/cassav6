import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { formatCurrency } from "../../shared/format/currency";

type ManualCashFloatModalProps = {
  open: boolean;
  cashDraft: string;
  cashFloat: number | null;
  cashFloatLocked: boolean;
  onCashDraftChange: (value: string) => void;
  onClose: () => void;
  onConfirm: (value: number) => void;
};

export function ManualCashFloatModal({
  open,
  cashDraft,
  cashFloat,
  cashFloatLocked,
  onCashDraftChange,
  onClose,
  onConfirm,
}: ManualCashFloatModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [slideValue, setSlideValue] = useState(0);
  const [slideLocked, setSlideLocked] = useState(false);

  const draftAmount = useMemo(() => {
    const normalized = Number(cashDraft.replace(",", "."));
    if (!Number.isFinite(normalized) || normalized < 0) return null;
    return Math.round(normalized * 100) / 100;
  }, [cashDraft]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSlideValue(0);
    setSlideLocked(false);
  }, [open]);

  if (!open) return null;

  const hasManualCashFloat = cashFloatLocked && cashFloat !== null;
  const canConfirm = !hasManualCashFloat && draftAmount !== null && !slideLocked;

  const resetSlideIfNeeded = () => {
    if (slideLocked) return;
    if (slideValue < 96) setSlideValue(0);
  };

  const confirm = () => {
    if (slideLocked || hasManualCashFloat) return;
    if (draftAmount === null) {
      setError("Inserisci un importo valido per il fondo cassa.");
      setSlideValue(0);
      return;
    }
    setSlideLocked(true);
    onConfirm(draftAmount);
  };

  return (
    <div className="payments-confirm-backdrop" onClick={onClose}>
      <div
        className="payments-confirm-card"
        role="dialog"
        aria-modal="true"
        aria-label="Fondo cassa manuale"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="payments-confirm-head">
          <strong>Fondo cassa manuale</strong>
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

        <div className="payments-confirm-body">
          {hasManualCashFloat ? (
            <>
              <div className="payments-confirm-amount">{formatCurrency(cashFloat ?? 0)}</div>
              <p>Fondo cassa manuale gia confermato.</p>
            </>
          ) : (
            <>
              <label className="payments-modal-field">
                <span>Importo fondo cassa</span>
                <input
                  id="cash-float-manual-input"
                  name="cash_float_manual"
                  type="text"
                  inputMode="decimal"
                  value={cashDraft}
                  placeholder="0,00"
                  onChange={(event) => {
                    onCashDraftChange(event.target.value);
                    setError(null);
                  }}
                  className="payments-input"
                  autoFocus
                />
              </label>
              <div className="payments-confirm-amount">
                {draftAmount !== null ? formatCurrency(draftAmount) : "Importo non valido"}
              </div>
              <p>Dopo la conferma il fondo cassa non potra piu essere modificato.</p>
              {error && <div className="payments-alert is-error">{error}</div>}
            </>
          )}
        </div>

        {!hasManualCashFloat && (
          <div
            className={`table-payment-slide payments-confirm-slide ${
              slideValue > 0 ? "is-dragging" : ""
            } ${!canConfirm ? "is-disabled" : ""}`}
          >
            <div className="table-payment-slide-label">Scorri per confermare</div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={slideValue}
              name="cash_float_confirm"
              aria-label="Scorri per confermare il fondo cassa"
              style={{ "--slide-progress": `${slideValue}%` } as CSSProperties}
              onChange={(event) => {
                const next = Number(event.target.value);
                setSlideValue(next);
                if (next >= 96) confirm();
              }}
              onMouseUp={resetSlideIfNeeded}
              onTouchEnd={resetSlideIfNeeded}
              onKeyUp={resetSlideIfNeeded}
              disabled={!canConfirm}
            />
          </div>
        )}
      </div>
    </div>
  );
}
