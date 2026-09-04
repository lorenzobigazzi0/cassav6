import type { DiningTable } from "../../../../api/tables";
import reservationSettingsIconSrc from "../../../../assets/icons/reservationsettings.png";
import { TableArrivalPill } from "./TableArrivalPill";
import {
  TableReservationsManageButton,
  type TableReservationsSeatGuard,
} from "./TableReservationQuickManager";

type TableDetailHeaderProps = {
  table: DiningTable;
  busy: boolean;
  canMove: boolean;
  arrivalTimeLabel: string;
  onOpenMovePicker: () => void;
  onMarkArrived: () => void;
  onFree: () => void;
  onClose: () => void;
  seatGuard?: TableReservationsSeatGuard;
  onFreeTables?: (tableIds: string[]) => Promise<void>;
};

/** Testata del dettaglio: spostamento, prenotazioni del tavolo, titolo, chiusura. */
export function TableDetailHeader({
  table,
  busy,
  canMove,
  arrivalTimeLabel,
  onOpenMovePicker,
  onMarkArrived,
  onFree,
  onClose,
  seatGuard,
  onFreeTables,
}: TableDetailHeaderProps) {
  return (
    <header className="table-detail-head">
      <div className="table-detail-head-actions">
        {canMove && (
          <button
            type="button"
            className="smallbtn table-detail-move-btn"
            onClick={onOpenMovePicker}
            disabled={busy}
            aria-label="Sposta tavolo"
            title="Sposta tavolo"
          >
            <svg viewBox="0 0 24 24" className="table-detail-move-icon" aria-hidden="true">
              <path d="M7 7h10l-3-3M17 17H7l3 3" />
            </svg>
          </button>
        )}
        <TableReservationsManageButton
          table={table}
          disabled={busy}
          label="Prenotazioni del tavolo"
          className="table-detail-reservations-btn"
          iconSrc={reservationSettingsIconSrc}
          onMarkArrived={onMarkArrived}
          onFreeTable={onFree}
          seatGuard={seatGuard}
          onFreeTables={onFreeTables}
        />
      </div>
      <div className="table-detail-title-wrap">
        <div className="table-detail-title-row">
          <h3 className="table-detail-title">Tavolo {table.number}</h3>
          {arrivalTimeLabel && <TableArrivalPill label={arrivalTimeLabel} />}
        </div>
      </div>
      <button
        type="button"
        className="smallbtn table-detail-close"
        disabled={busy}
        onClick={onClose}
        aria-label="Chiudi"
        title="Chiudi"
      >
        <svg viewBox="0 0 24 24" className="table-detail-close-icon" aria-hidden="true">
          <path d="M6 6l12 12M18 6l-12 12" />
        </svg>
      </button>
    </header>
  );
}
