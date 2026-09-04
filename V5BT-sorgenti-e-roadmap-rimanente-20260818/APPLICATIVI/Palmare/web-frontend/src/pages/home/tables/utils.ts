import type { DiningTable } from "../../../api/tables";
import { deriveTableVisualState } from "../../../api/tables";
export { formatCurrency } from "../../../shared/format/currency";
import { formatElapsedCoarse } from "../utils/time";

export const formatClockTime = (timestamp: number) =>
  new Intl.DateTimeFormat("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));

/**
 * Decide se il modulo del dettaglio va riscritto con i dati del server.
 *
 * Un aggiornamento del tavolo che arriva mentre l'utente ha modifiche non
 * salvate non deve cancellarle: era la finestra per cui un'intolleranza appena
 * segnata spariva senza dire niente. Cambiando tavolo si riparte invece sempre
 * dal server, perche' li la bozza appartiene a un altro tavolo.
 */
export const shouldReseedTableForm = (input: {
  isRestoredSelection: boolean;
  isTableSwitch: boolean;
  hasUnsavedChanges: boolean;
}) => {
  if (input.isRestoredSelection) return false;
  if (input.isTableSwitch) return true;
  return !input.hasUnsavedChanges;
};

export const formatTableTiming = (table: DiningTable, now = Date.now()) => {
  if (table.occupancyState === "reserved" && table.reservationAt) {
    return formatClockTime(table.reservationAt);
  }
  if (table.occupancyState === "seated" && table.seatedAt) {
    return formatElapsedCoarse(table.seatedAt, now);
  }
  return "";
};

export const formatTableStatusLabel = (table: DiningTable) => {
  if (table.occupancyState === "reserved") return "Prenotato";
  const visualState = deriveTableVisualState(table);
  if (visualState === "free") return "Libero";
  if (visualState === "occupied") return "Accomodato";
  if (visualState === "ordering") return "Ordine";
  return "Pagare";
};

export const formatMoveTableLabel = (tables: DiningTable[], tableId: string, fallback: string) => {
  const table = tables.find((entry) => entry.id === tableId);
  return table ? `Tavolo ${table.number}` : fallback;
};

export const getDefaultReservationTimeValue = (table: DiningTable | null) => {
  const base = table?.reservationAt
    ? new Date(table.reservationAt)
    : new Date(Date.now() + 30 * 60000);
  const hours = String(base.getHours()).padStart(2, "0");
  const minutes = String(base.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
};

export const reservationTimeToTimestamp = (hhmm: string) => {
  const [hhRaw, mmRaw] = hhmm.split(":");
  const hh = Number(hhRaw);
  const mm = Number(mmRaw);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) {
    return Date.now() + 30 * 60000;
  }
  const date = new Date();
  date.setSeconds(0, 0);
  date.setHours(Math.max(0, Math.min(23, hh)), Math.max(0, Math.min(59, mm)), 0, 0);
  if (date.getTime() < Date.now() - 2 * 60000) {
    date.setDate(date.getDate() + 1);
  }
  return date.getTime();
};

/** Criteri obbligatori di occupazione e prenotazione, condivisi con il pannello. */
export const tableDraftValidity = (draft: {
  covers: string;
  name: string;
  phone: string;
  time: string;
}) => {
  const covers = Number(draft.covers);
  const coversValid = Number.isFinite(covers) && covers > 0;
  return {
    canOccupy: coversValid,
    canReserve:
      coversValid &&
      Boolean(draft.name.trim()) &&
      Boolean(draft.phone.trim()) &&
      Boolean(draft.time.trim()),
  };
};
