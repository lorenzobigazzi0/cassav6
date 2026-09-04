export type TableMergeConfirmRequest = {
  rootId: string;
  selectedIds: string[];
  sourceLabel: string;
  targetLabels: string[];
};

export type TableMoveConfirmRequest = {
  fromTableId: string;
  toTableIds: string[];
  sourceLabel: string;
  targetLabels: string[];
};

type TableMergeConfirmDialogProps = {
  request: TableMergeConfirmRequest;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

type TableMoveConfirmDialogProps = {
  request: TableMoveConfirmRequest;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

function DialogActionIcon({ type }: { type: "cancel" | "confirm" }) {
  return (
    <svg className="tables-move-confirm-action-icon" viewBox="0 0 24 24" aria-hidden="true">
      {type === "cancel" ? (
        <>
          <path d="M6 6l12 12" />
          <path d="M18 6L6 18" />
        </>
      ) : (
        <path d="M5 13l4 4L19 7" />
      )}
    </svg>
  );
}

export function TableMoveConfirmDialog({
  request,
  busy,
  onCancel,
  onConfirm,
}: TableMoveConfirmDialogProps) {
  const targetLabel = request.targetLabels.join(", ");
  return (
    <div className="tables-move-confirm-backdrop" onClick={onCancel}>
      <div
        className="tables-move-confirm-card"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Conferma spostamento tavolo"
      >
        <div className="tables-move-confirm-title">Conferma spostamento</div>
        <div className="tables-move-confirm-body">
          <div className="tables-move-confirm-route">
            <span>Da</span>
            <strong>{request.sourceLabel}</strong>
          </div>
          <div className="tables-move-confirm-route">
            <span>A</span>
            <strong>{targetLabel}</strong>
          </div>
          <p className="tables-move-confirm-warning">
            I tavoli sorgente interessati verranno liberati dopo lo spostamento.
          </p>
        </div>
        <div className="tables-move-confirm-actions">
          <button
            type="button"
            className="smallbtn tables-move-confirm-btn is-cancel"
            onClick={onCancel}
            disabled={busy}
          >
            <DialogActionIcon type="cancel" />
            <span>ANNULLA</span>
          </button>
          <button
            type="button"
            className="smallbtn tables-move-confirm-btn is-confirm"
            onClick={onConfirm}
            disabled={busy}
          >
            <DialogActionIcon type="confirm" />
            <span>CONFERMA</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function TableMergeConfirmDialog({
  request,
  busy,
  onCancel,
  onConfirm,
}: TableMergeConfirmDialogProps) {
  const targetLabel = request.targetLabels.join(", ");
  return (
    <div className="tables-move-confirm-backdrop" onClick={onCancel}>
      <div
        className="tables-move-confirm-card"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Conferma unione tavoli occupati"
      >
        <div className="tables-move-confirm-title">Unisci tavoli occupati</div>
        <div className="tables-move-confirm-body">
          <div className="tables-move-confirm-route">
            <span>Principale</span>
            <strong>{request.sourceLabel}</strong>
          </div>
          <div className="tables-move-confirm-route">
            <span>Unisci con</span>
            <strong>{targetLabel}</strong>
          </div>
          <p className="tables-move-confirm-warning">
            Le comande, i conti aperti, i coperti e lo storico verranno mostrati insieme nel tavolo
            unito.
          </p>
        </div>
        <div className="tables-move-confirm-actions">
          <button
            type="button"
            className="smallbtn tables-move-confirm-btn is-cancel"
            onClick={onCancel}
            disabled={busy}
          >
            <DialogActionIcon type="cancel" />
            <span>ANNULLA</span>
          </button>
          <button
            type="button"
            className="smallbtn tables-move-confirm-btn is-confirm"
            onClick={onConfirm}
            disabled={busy}
          >
            <DialogActionIcon type="confirm" />
            <span>CONFERMA</span>
          </button>
        </div>
      </div>
    </div>
  );
}
