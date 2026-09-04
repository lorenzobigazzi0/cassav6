import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { DiningTable } from "../../../../api/tables";
import { deriveTableVisualState } from "../../../../api/tables";
import { triggerLongPressHaptic } from "../../../../utils/haptics";
import { tableNeedsConfigurationRemovalDecision } from "../../../../domain/offlineConfiguration/reconciliation";
import { formatClockTime, formatTableStatusLabel, formatTableTiming } from "../utils";
import { TableIntoleranceBadge } from "./TableIntoleranceBadge";
import bookingsIconSrc from "../../../../assets/icons/bookings.png";
import hourglassIconSrc from "../../../../assets/icons/hourglass.png";
import personIconSrc from "../../../../assets/icons/profile.png";

interface TableTileProps {
  table: DiningTable;
  now: number;
  selected: boolean;
  onOpen: (tableId: string) => void;
  onLongPress?: (tableId: string) => void;
}

const LONG_PRESS_MS = 560;
const MOVE_CANCEL_PX = 14;

export function TableTile({ table, now, selected, onOpen, onLongPress }: TableTileProps) {
  const longPressTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const visualState = deriveTableVisualState(table);
  const isFreeTable = table.occupancyState === "free";
  const isReserved = table.occupancyState === "reserved";
  const isSeated = table.occupancyState === "seated";
  const timingLabel = formatTableTiming(table, now);
  const reservationPreview = table.reservationPreview ?? null;
  const upcomingReservationAt = reservationPreview?.reservationAt ?? table.reservationAt ?? null;
  const shouldWarnReservationRelease =
    reservationPreview?.shouldWarnRelease ??
    Boolean(
      isSeated &&
      upcomingReservationAt &&
      upcomingReservationAt - now <= 30 * 60_000 &&
      upcomingReservationAt >= now - 30 * 60_000
    );
  const reservationPreviewTime = upcomingReservationAt
    ? formatClockTime(upcomingReservationAt)
    : "";
  const tableLabel = table.mobileComplexLabel || String(table.number);
  const tableTitle = `Tavolo ${tableLabel}`;
  const displayName = isFreeTable ? "-" : table.tableName.trim();
  const displayPhone = isReserved ? table.customerPhone.trim() : "";
  const note = isFreeTable ? "" : table.note.trim();
  const noteText = note || "Nessuna nota";
  const isComplex = Boolean(table.mobileComplex);
  const hasConfigurationWarning = tableNeedsConfigurationRemovalDecision(table);

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!onLongPress || event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;

    const cleanup = () => {
      clearLongPressTimer();
      window.removeEventListener("pointerup", cleanup, true);
      window.removeEventListener("pointercancel", cleanup, true);
      window.removeEventListener("pointermove", handlePointerMove, true);
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (
        Math.abs(moveEvent.clientX - startX) > MOVE_CANCEL_PX ||
        Math.abs(moveEvent.clientY - startY) > MOVE_CANCEL_PX
      ) {
        cleanup();
      }
    };

    clearLongPressTimer();
    longPressTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = true;
      triggerLongPressHaptic();
      onLongPress(table.id);
      cleanup();
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 700);
    }, LONG_PRESS_MS);

    window.addEventListener("pointerup", cleanup, true);
    window.addEventListener("pointercancel", cleanup, true);
    window.addEventListener("pointermove", handlePointerMove, true);
  };

  return (
    <button
      type="button"
      className={`table-tile state-${visualState} ${selected ? "is-selected" : ""} ${
        isComplex ? "is-mobile-complex-table" : ""
      } ${hasConfigurationWarning ? "has-configuration-removal-warning" : ""}`}
      onPointerDown={handlePointerDown}
      onClick={() => {
        if (suppressClickRef.current) return;
        onOpen(table.id);
      }}
      aria-pressed={selected}
      aria-label={`${
        hasConfigurationWarning ? "Attenzione: tavolo rimosso dalla configurazione. " : ""
      }Apri dettagli ${tableTitle}`}
    >
      <div className="table-tile-head">
        <div className="table-tile-number">{tableLabel}</div>
        {!isFreeTable && table.covers > 0 && (
          <span
            className="table-meta-pill table-tile-covers"
            aria-label={`${table.covers} coperti`}
            title={`${table.covers} coperti`}
          >
            <img className="table-tile-meta-icon" src={personIconSrc} alt="" aria-hidden="true" />
            <span>{table.covers}</span>
          </span>
        )}
        {isFreeTable && upcomingReservationAt ? (
          <div className="table-tile-timing">
            <img
              className="table-tile-meta-icon table-tile-reservation-icon"
              src={bookingsIconSrc}
              alt=""
              aria-hidden="true"
            />
            <span>{reservationPreviewTime}</span>
          </div>
        ) : null}
        {isFreeTable ? <TableIntoleranceBadge table={table} /> : null}
        {timingLabel ? (
          <div className="table-tile-timing is-primary">
            {isReserved ? (
              <img
                className="table-tile-meta-icon table-tile-reservation-icon"
                src={bookingsIconSrc}
                alt=""
                aria-hidden="true"
              />
            ) : (
              <img
                className="table-tile-meta-icon"
                src={hourglassIconSrc}
                alt=""
                aria-hidden="true"
              />
            )}
            <span>{timingLabel}</span>
          </div>
        ) : null}
        <div className="table-status">{formatTableStatusLabel(table)}</div>
      </div>
      <div className="table-tile-subhead">
        {!isFreeTable && <div className="table-name">{displayName || "\u00A0"}</div>}
        {!isFreeTable && <TableIntoleranceBadge table={table} />}
      </div>
      {displayPhone && (
        <div className="table-phone-line" title={displayPhone}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6.4 2.7h3.2l1.2 4.2-1.8 1.8a14.6 14.6 0 0 0 6.2 6.2l1.8-1.8 4.2 1.2v3.2c0 .8-.6 1.5-1.4 1.6-.4.1-.9.1-1.3.1A17.4 17.4 0 0 1 5.1 5.4c0-.4 0-.9.1-1.3.1-.8.8-1.4 1.2-1.4z" />
          </svg>
          <span>{displayPhone}</span>
        </div>
      )}

      <div className="table-meta-line">
        {hasConfigurationWarning ? (
          <span
            className="table-meta-pill table-configuration-removal-badge"
            title="Tavolo rimosso dalla configurazione"
          >
            Config. rimossa
          </span>
        ) : null}
        {!isReserved && !isFreeTable && upcomingReservationAt && (
          <span
            className={`table-meta-pill table-reservation-preview-badge ${
              shouldWarnReservationRelease ? "is-warning" : ""
            }`}
            title={`Prenotazione ${reservationPreviewTime}`}
          >
            <img
              className="table-tile-meta-icon table-tile-reservation-icon"
              src={bookingsIconSrc}
              alt=""
              aria-hidden="true"
            />
            <span>{shouldWarnReservationRelease ? "Lascia 10'" : reservationPreviewTime}</span>
          </span>
        )}
      </div>

      <div className="table-kpi-spacer" aria-hidden="true" />

      {!isFreeTable && (
        <div className="table-note" title={noteText}>
          {noteText}
        </div>
      )}
    </button>
  );
}
