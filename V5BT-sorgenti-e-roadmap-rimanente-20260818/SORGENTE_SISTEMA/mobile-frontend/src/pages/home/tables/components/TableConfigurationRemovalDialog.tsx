import type { DiningTable } from "../../../../api/tables";

type TableConfigurationRemovalDialogProps = {
  table: DiningTable;
  busy: boolean;
  onClose: () => void;
  onKeep: () => void;
  onMove: () => void;
};

export function TableConfigurationRemovalDialog({
  table,
  busy,
  onClose,
  onKeep,
  onMove,
}: TableConfigurationRemovalDialogProps) {
  if (!table.offlineLifecycle) return null;
  const tableLabel = table.mobileComplexLabel || String(table.number);

  return (
    <div
      className="table-configuration-removal-backdrop"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <section
        className="table-configuration-removal-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="table-configuration-removal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="table-configuration-removal-head">
          <span className="table-configuration-removal-icon" aria-hidden="true">
            !
          </span>
          <div>
            <h2 id="table-configuration-removal-title">Tavolo rimosso dalla configurazione</h2>
            <p>Tavolo {tableLabel}</p>
          </div>
          <button
            type="button"
            className="table-configuration-removal-close"
            aria-label="Chiudi avviso"
            disabled={busy}
            onClick={onClose}
          />
        </header>
        <p className="table-configuration-removal-copy">
          Il tavolo e stato rimosso dalla configurazione mentre era prenotato. Mantienilo per il
          servizio corrente oppure sposta la prenotazione su un altro tavolo.
        </p>
        <div className="table-configuration-removal-actions">
          <button type="button" disabled={busy} onClick={onKeep}>
            Mantieni
          </button>
          <button type="button" className="is-primary" disabled={busy} onClick={onMove}>
            Sposta
          </button>
        </div>
      </section>
    </div>
  );
}
