import { useState, type CSSProperties } from "react";

type TableFreeConfirmDialogProps = {
  open: boolean;
  busy: boolean;
  canFree: boolean;
  onClose: () => void;
  onFree: () => void;
};

/**
 * Conferma a scorrimento per liberare il tavolo. Lo stato dello slider vive qui:
 * il dialogo si smonta alla chiusura, quindi si azzera da solo.
 */
export function TableFreeConfirmDialog({
  open,
  busy,
  canFree,
  onClose,
  onFree,
}: TableFreeConfirmDialogProps) {
  const [value, setValue] = useState(0);
  const [locked, setLocked] = useState(false);
  if (!open) return null;

  const disabled = locked || busy || !canFree;
  const confirm = () => {
    if (disabled) return;
    setLocked(true);
    onFree();
    window.setTimeout(onClose, 240);
  };
  const resetIfNeeded = () => {
    if (!locked && value < 96) setValue(0);
  };

  return (
    <div className="table-free-confirm-backdrop" onClick={onClose}>
      <div className="table-free-confirm-card" onClick={(event) => event.stopPropagation()}>
        <div className="table-free-confirm-head">
          <strong>Libera tavolo</strong>
          <button
            type="button"
            className="smallbtn table-free-confirm-close"
            onClick={onClose}
            aria-label="Chiudi"
          >
            <svg viewBox="0 0 24 24" className="table-detail-close-icon" aria-hidden="true">
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </div>
        <div
          className={`table-payment-slide table-detail-free-slide ${
            value > 0 ? "is-dragging" : ""
          } ${disabled ? "is-disabled" : ""}`}
        >
          <div className="table-payment-slide-label">Scorri per liberare</div>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={value}
            name="free_table_confirm"
            aria-label="Scorri per liberare il tavolo"
            style={{ "--slide-progress": `${value}%` } as CSSProperties}
            onChange={(event) => {
              const next = Number(event.target.value);
              setValue(next);
              if (next >= 96) confirm();
            }}
            onMouseUp={resetIfNeeded}
            onTouchEnd={resetIfNeeded}
            onKeyUp={resetIfNeeded}
            disabled={disabled}
          />
        </div>
      </div>
    </div>
  );
}
