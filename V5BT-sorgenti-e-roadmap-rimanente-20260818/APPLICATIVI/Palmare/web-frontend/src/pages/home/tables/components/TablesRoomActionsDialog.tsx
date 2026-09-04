import { useState } from "react";
import { createPortal } from "react-dom";

export type RoomBulkAction = "free" | "clear";

type TablesRoomActionsDialogProps = {
  roomName: string | null;
  canClear: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onRun: (action: RoomBulkAction) => void;
};

const CONFIRM_TEXT: Record<RoomBulkAction, string> = {
  free: "Tutti i tavoli occupati della sala tornano liberi. Quelli con ordini aperti o importi da riscuotere restano invariati.",
  clear:
    "Ordini e pagamenti aperti della sala vengono annullati e i tavoli svuotati. L'operazione non e' reversibile.",
};

const CONFIRM_TITLE: Record<RoomBulkAction, string> = {
  free: "LIBERA TAVOLI",
  clear: "ELIMINA TAVOLI",
};

/** Menu tenuto premuto su una sala: azioni di massa, ciascuna con conferma. */
export function TablesRoomActionsDialog({
  roomName,
  canClear,
  busy,
  error,
  onClose,
  onRun,
}: TablesRoomActionsDialogProps) {
  const [pending, setPending] = useState<RoomBulkAction | null>(null);
  if (!roomName || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="tables-move-confirm-backdrop tables-room-actions-backdrop"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <section
        className="tables-move-confirm-card tables-room-actions-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="tables-room-actions-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="tables-room-actions-head">
          <div id="tables-room-actions-title" className="tables-room-actions-title">
            {pending ? CONFIRM_TITLE[pending] : roomName}
          </div>
          <button
            type="button"
            className="smallbtn tables-room-actions-close"
            onClick={() => {
              if (busy) return;
              if (pending) setPending(null);
              else onClose();
            }}
            disabled={busy}
            aria-label="Chiudi"
          >
            <svg viewBox="0 0 24 24" className="table-detail-close-icon" aria-hidden="true">
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </div>
        <div className="tables-move-confirm-body">
          {pending ? <p className="tables-room-actions-text">{CONFIRM_TEXT[pending]}</p> : null}
          {error ? <p className="tables-room-actions-error">{error}</p> : null}
        </div>

        {pending ? (
          <div className="tables-move-confirm-actions is-single">
            <button
              type="button"
              className={`smallbtn tables-move-confirm-btn tables-room-actions-confirm ${
                pending === "clear" ? "is-destructive" : ""
              }`}
              onClick={() => onRun(pending)}
              disabled={busy}
              autoFocus
            >
              CONFERMA
            </button>
          </div>
        ) : (
          <div className="tables-room-actions-list">
            <button
              type="button"
              className="smallbtn tables-room-actions-item"
              onClick={() => setPending("free")}
              disabled={busy}
            >
              LIBERA TAVOLI
            </button>
            {canClear ? (
              <button
                type="button"
                className="smallbtn tables-room-actions-item is-destructive"
                onClick={() => setPending("clear")}
                disabled={busy}
              >
                ELIMINA TAVOLI
              </button>
            ) : null}
          </div>
        )}
      </section>
    </div>,
    document.body
  );
}
