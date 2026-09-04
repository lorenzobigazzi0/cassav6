import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  acquireReservationEditLock,
  deleteDiningReservation,
  releaseReservationEditLock,
  reservationsQueryKey,
  updateDiningReservationStatus,
  type DiningReservation,
  type ReservationStatusAction,
} from "../../../../api/reservations";
import { tablesQueryKey, type DiningTable } from "../../../../api/tables";
import { invalidateTableReservationWindowCache } from "../../../../api/tableReservationWindow";
import type { SeatGuardResult } from "../reservationTableUnion";
import {
  ReservationsWorkspace,
  type ReservationsWorkspaceEmbed,
} from "../../reservations/ReservationsWorkspace";

export type TableReservationsSeatGuard = (reservation: DiningReservation) => SeatGuardResult;
import { formatClockTime } from "../utils";
import { useTableReservationsForToday } from "../useTableReservations";

type ReservationAction = Extract<ReservationStatusAction, "arrived" | "no_show"> | "delete";

type TableReservationsProps = {
  table: DiningTable | null;
  disabled?: boolean;
  /** Etichetta e stile del pulsante che apre l'elenco. */
  label?: string;
  className?: string;
  /** Con un'icona il pulsante diventa tondo e senza testo. */
  iconSrc?: string;
  /** Salta l'elenco e apre le scelte della prenotazione piu' vicina. */
  openDirect?: boolean;
  /** Azioni sul tavolo, allineate a quelle sulla prenotazione. */
  onMarkArrived?: () => void;
  onFreeTable?: () => void;
  /** Controlla se i tavoli della prenotazione sono pronti ad accogliere. */
  seatGuard?: TableReservationsSeatGuard;
  /** Libera i tavoli indicati prima di accomodare. */
  onFreeTables?: (tableIds: string[]) => Promise<void>;
};

const ACTION_ICON_SRC: Record<ReservationAction, string> = {
  arrived: "/mobile/assets/arrivati.png",
  no_show: "/mobile/assets/noshow.png",
  delete: "/mobile/assets/cancel.png",
};

const STATUS_LABEL: Record<DiningReservation["status"], string> = {
  booked: "Prenotata",
  arrived: "Arrivati",
  no_show: "No show",
  released: "Chiusa",
  cancelled: "Eliminata",
};

function ReservationActionIcon({ action }: { action: ReservationAction }) {
  return <img src={ACTION_ICON_SRC[action]} alt="" aria-hidden="true" />;
}

function ReservationStatusBadge({ reservation }: { reservation: DiningReservation }) {
  const action =
    reservation.status === "arrived"
      ? "arrived"
      : reservation.status === "no_show"
        ? "no_show"
        : reservation.status === "cancelled"
          ? "delete"
          : null;
  return (
    <span className={`table-reservation-status-badge is-${reservation.status}`}>
      {action ? <ReservationActionIcon action={action} /> : null}
      {STATUS_LABEL[reservation.status]}
    </span>
  );
}

export function TableReservationCountBadge({ table }: TableReservationsProps) {
  const { plannedCount } = useTableReservationsForToday(table);
  if (plannedCount <= 0) return null;
  return <span className="table-reservation-count-badge">{plannedCount}</span>;
}

export function TableReservationsManageButton({
  table,
  disabled = false,
  label = "Gestisci prenotazioni",
  className = "",
  iconSrc,
  openDirect = false,
  onMarkArrived,
  onFreeTable,
  seatGuard,
  onFreeTables,
}: TableReservationsProps) {
  const queryClient = useQueryClient();
  const { query, reservations, plannedCount, session } = useTableReservationsForToday(table);
  const [listOpen, setListOpen] = useState(false);
  const [selectedReservation, setSelectedReservation] = useState<DiningReservation | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [seatBlock, setSeatBlock] = useState<SeatGuardResult | null>(null);
  const [editReservation, setEditReservation] = useState<DiningReservation | null>(null);
  const visibleReservations = reservations.filter(
    (reservation) => reservation.status !== "cancelled"
  );

  if (visibleReservations.length === 0) return null;

  const refreshAfterMutation = async () => {
    invalidateTableReservationWindowCache();
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: reservationsQueryKey(session.roomId, session.serviceDate),
      }),
      queryClient.invalidateQueries({
        queryKey: tablesQueryKey(session.roomId, session.activityId),
      }),
    ]);
  };

  const runReservationAction = async (action: ReservationAction) => {
    if (!selectedReservation) return;
    setActionBusy(true);
    setActionError(null);
    try {
      if (action === "delete") {
        const lock = await acquireReservationEditLock({
          token: session.token,
          userId: session.userId,
          deviceUuid: session.deviceUuid,
          roomId: session.roomId,
          serviceDate: session.serviceDate,
          reservationId: selectedReservation.id,
        });
        try {
          await deleteDiningReservation({
            token: session.token,
            userId: session.userId,
            deviceUuid: session.deviceUuid,
            roomId: session.roomId,
            serviceDate: session.serviceDate,
            reservationId: selectedReservation.id,
            lockId: lock.lockId,
          });
        } catch (error) {
          await releaseReservationEditLock({
            token: session.token,
            userId: session.userId,
            deviceUuid: session.deviceUuid,
            roomId: session.roomId,
            reservationId: selectedReservation.id,
            lockId: lock.lockId,
          }).catch(() => undefined);
          throw error;
        }
      } else {
        await updateDiningReservationStatus({
          token: session.token,
          userId: session.userId,
          deviceUuid: session.deviceUuid,
          roomId: session.roomId,
          serviceDate: session.serviceDate,
          reservationId: selectedReservation.id,
          action,
        });
      }
      // Le tre azioni sono terminali per la derivazione: il tavolo va portato
      // di conseguenza, altrimenti resta indietro con i dati della prenotazione.
      if (action === "arrived") onMarkArrived?.();
      else onFreeTable?.();
      await refreshAfterMutation();
      setSelectedReservation(null);
      if (action === "delete") setListOpen(false);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Aggiornamento prenotazione non riuscito."
      );
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`smallbtn table-reservations-manage-btn ${
          iconSrc ? "is-icon" : ""
        } ${className}`}
        aria-label={iconSrc ? label : undefined}
        title={iconSrc ? label : undefined}
        onClick={() => {
          setActionError(null);
          if (openDirect) {
            const prossima = visibleReservations
              .filter((reservation) => reservation.status === "booked")
              .sort((left, right) => left.reservationAt - right.reservationAt)[0];
            if (prossima) setSelectedReservation(prossima);
            return;
          }
          setListOpen(true);
        }}
        disabled={disabled || query.isLoading}
      >
        {iconSrc ? (
          <img src={iconSrc} alt="" aria-hidden="true" />
        ) : (
          <span>{label}</span>
        )}
        {plannedCount > 0 ? (
          <span className="table-reservation-count-badge">{plannedCount}</span>
        ) : null}
      </button>

      {listOpen && (
        <div className="table-reservations-modal-backdrop" onClick={() => setListOpen(false)}>
          <section
            className="table-reservations-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Prenotazioni tavolo"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="table-reservations-modal-head">
              <strong>Prenotazioni tavolo</strong>
              <button
                type="button"
                className="smallbtn table-reservations-modal-close"
                onClick={() => setListOpen(false)}
                aria-label="Chiudi prenotazioni"
              >
                x
              </button>
            </header>
            {actionError ? <div className="table-detail-error">{actionError}</div> : null}
            <div className="table-reservations-list">
              {visibleReservations.map((reservation) => (
                <button
                  key={reservation.id}
                  type="button"
                  className="table-reservation-list-row"
                  onClick={() => {
                    setActionError(null);
                    setSelectedReservation(reservation);
                  }}
                  disabled={actionBusy}
                >
                  <span className="table-reservation-list-time">
                    {formatClockTime(reservation.reservationAt)}
                  </span>
                  <span className="table-reservation-list-main">
                    <strong>{reservation.customerName}</strong>
                    <em>{reservation.covers} persone</em>
                  </span>
                  <ReservationStatusBadge reservation={reservation} />
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {selectedReservation && (
        <div
          className="table-reservation-action-backdrop"
          onClick={() => setSelectedReservation(null)}
        >
          <section
            className="table-reservation-action-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Gestisci prenotazione"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="table-reservation-action-head">
              <strong>{selectedReservation.customerName}</strong>
              <span>
                {formatClockTime(selectedReservation.reservationAt)} - {selectedReservation.covers}{" "}
                persone
              </span>
              <ReservationStatusBadge reservation={selectedReservation} />
              <button
                type="button"
                className="smallbtn table-reservation-action-close"
                onClick={() => setSelectedReservation(null)}
                aria-label="Chiudi"
                title="Chiudi"
                disabled={actionBusy}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </button>
              <button
                type="button"
                className="smallbtn table-reservation-edit-btn"
                onClick={() => setEditReservation(selectedReservation)}
                aria-label="Modifica prenotazione"
                title="Modifica prenotazione"
                disabled={actionBusy}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 20h4l10-10-4-4L4 16v4zM14.5 5.5l4 4" />
                </svg>
              </button>
            </header>
            {actionError ? <div className="table-detail-error">{actionError}</div> : null}
            <div className="table-reservation-action-grid">
              <button
                type="button"
                className="smallbtn table-reservation-action-btn is-arrived"
                onClick={() => {
                  const esito = seatGuard?.(selectedReservation) ?? { ok: true as const };
                  if (!esito.ok) {
                    setSeatBlock(esito);
                    return;
                  }
                  void runReservationAction("arrived");
                }}
                disabled={actionBusy}
              >
                <ReservationActionIcon action="arrived" />
                <span>Arrivati</span>
              </button>
              <button
                type="button"
                className="smallbtn table-reservation-action-btn is-no-show"
                onClick={() => void runReservationAction("no_show")}
                disabled={actionBusy}
              >
                <ReservationActionIcon action="no_show" />
                <span>No show</span>
              </button>
              <button
                type="button"
                className="smallbtn table-reservation-action-btn is-delete"
                onClick={() => setDeleteConfirm(true)}
                disabled={actionBusy}
              >
                <ReservationActionIcon action="delete" />
                <span>Elimina</span>
              </button>
            </div>
          </section>
        </div>
      )}

      {seatBlock && !seatBlock.ok && (
        <div className="tables-move-confirm-backdrop" onClick={() => setSeatBlock(null)}>
          <section
            className="tables-move-confirm-card"
            role="alertdialog"
            aria-modal="true"
            aria-label="Tavoli della prenotazione"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="tables-move-confirm-title">
              {seatBlock.conflictLabels.length > 0
                ? "TAVOLI GIA' UNITI"
                : seatBlock.blockedLabels.length > 0
                  ? "TAVOLI DA SISTEMARE"
                  : "TAVOLI DA LIBERARE"}
            </div>
            <div className="tables-move-confirm-body">
              {seatBlock.conflictLabels.length > 0 ? (
                <p className="tables-move-confirm-warning">
                  {seatBlock.conflictLabels.join(", ")} fa gia' parte di un'altra unione: dividila
                  prima, oppure correggi i tavoli assegnati alla prenotazione.
                </p>
              ) : seatBlock.blockedLabels.length > 0 ? (
                <p className="tables-move-confirm-warning">
                  {seatBlock.blockedLabels.join(", ")} {seatBlock.blockedLabels.length === 1
                    ? "ha un ordine aperto o un conto da riscuotere"
                    : "hanno ordini aperti o conti da riscuotere"}
                  : vanno sistemati a mano prima di accomodare la prenotazione.
                </p>
              ) : (
                <p className="tables-move-confirm-warning">
                  {seatBlock.freeableLabels.join(", ")} risulta ancora occupato. Liberarlo e
                  accomodare la prenotazione?
                </p>
              )}
            </div>
            <div className="tables-move-confirm-actions">
              <button
                type="button"
                className="smallbtn tables-move-confirm-btn is-cancel"
                onClick={() => setSeatBlock(null)}
                disabled={actionBusy}
                autoFocus
              >
                {seatBlock.blockedLabels.length > 0 || seatBlock.conflictLabels.length > 0
                  ? "CHIUDI"
                  : "ANNULLA"}
              </button>
              {seatBlock.blockedLabels.length === 0 && seatBlock.conflictLabels.length === 0 ? (
                <button
                  type="button"
                  className="smallbtn tables-move-confirm-btn"
                  onClick={async () => {
                    const ids = seatBlock.freeableIds;
                    setSeatBlock(null);
                    setActionBusy(true);
                    try {
                      await onFreeTables?.(ids);
                    } catch (error) {
                      setActionError(
                        error instanceof Error ? error.message : "Liberazione tavoli non riuscita."
                      );
                      setActionBusy(false);
                      return;
                    }
                    setActionBusy(false);
                    void runReservationAction("arrived");
                  }}
                  disabled={actionBusy}
                >
                  LIBERA E ACCOMODA
                </button>
              ) : null}
            </div>
          </section>
        </div>
      )}

      {editReservation ? (
        <div
          className="table-reservation-edit-backdrop"
          onClick={() => setEditReservation(null)}
        >
          <div
            className="table-reservation-edit-card"
            onClick={(event) => event.stopPropagation()}
          >
            <ReservationsWorkspace
              embed={
                {
                  reservationId: editReservation.id,
                  roomId: session.roomId,
                  serviceDate: session.serviceDate,
                  onClose: () => {
                    setEditReservation(null);
                    void refreshAfterMutation();
                  },
                } satisfies ReservationsWorkspaceEmbed
              }
            />
          </div>
        </div>
      ) : null}

      {deleteConfirm && (
        <div className="tables-move-confirm-backdrop" onClick={() => setDeleteConfirm(false)}>
          <section
            className="tables-move-confirm-card"
            role="alertdialog"
            aria-modal="true"
            aria-label="Conferma eliminazione prenotazione"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="tables-move-confirm-title">ELIMINA PRENOTAZIONE</div>
            <div className="tables-move-confirm-body">
              <p className="tables-move-confirm-warning">
                La prenotazione viene eliminata e il tavolo torna libero. L'operazione non e'
                reversibile.
              </p>
            </div>
            <div className="tables-move-confirm-actions">
              <button
                type="button"
                className="smallbtn tables-move-confirm-btn is-cancel"
                onClick={() => setDeleteConfirm(false)}
                disabled={actionBusy}
                autoFocus
              >
                ANNULLA
              </button>
              <button
                type="button"
                className="smallbtn tables-move-confirm-btn tables-room-actions-confirm is-destructive"
                onClick={() => {
                  setDeleteConfirm(false);
                  void runReservationAction("delete");
                }}
                disabled={actionBusy}
              >
                ELIMINA
              </button>
            </div>
          </section>
        </div>
      )}

    </>
  );
}

