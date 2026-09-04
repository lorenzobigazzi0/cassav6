import { HACCP_ALLERGEN_OPTIONS } from "../../../domain/allergens";
import type { DiningReservation, ReservationStatusColor } from "../../../api/reservations";

export type ReservationEditorStatus = DiningReservation["status"];

export type ReservationFormState = {
  customerName: string;
  customerPhone: string;
  reservationTime: string;
  covers: string;
  intolerances: string;
  note: string;
  assignedTableId: string | null;
  assignedTableIds: string[];
  status: ReservationEditorStatus;
};

/** Intolleranze proposte in prenotazione: sono gli stessi allergeni dell'anagrafica. */
export const HACCP_INTOLERANCE_OPTIONS = HACCP_ALLERGEN_OPTIONS;

export const toClockTime = (timestamp: number) => {
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
};

export const reservationLabel = (reservation: DiningReservation) =>
  `${toClockTime(reservation.reservationAt)} - ${reservation.customerName}`;

export const statusClassByColor: Record<ReservationStatusColor, string> = {
  free: "is-free",
  safe: "is-safe",
  warning: "is-warning",
  danger: "is-danger",
  conflict: "is-conflict",
};

export const statusLegendLabel: Record<ReservationStatusColor, string> = {
  free: "Disponibile",
  safe: "Sequenziale >= 2h",
  warning: "Distanza 90-119 min",
  danger: "Distanza 60-89 min",
  conflict: "Distanza < 60 min",
};

const parseClock = (value: string) => {
  const [hhRaw, mmRaw] = value.split(":");
  const hh = Number(hhRaw);
  const mm = Number(mmRaw);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return { hh: 19, mm: 30 };
  return {
    hh: Math.min(23, Math.max(0, Math.round(hh))),
    mm: Math.min(59, Math.max(0, Math.round(mm))),
  };
};

const buildDefaultTime = () => {
  const now = new Date();
  now.setMinutes(now.getMinutes() + 60);
  const roundedMinutes = Math.round(now.getMinutes() / 5) * 5;
  now.setMinutes(roundedMinutes, 0, 0);
  return toClockTime(now.getTime());
};

export const toTimestamp = (serviceDate: string, hhmm: string) => {
  const [yearRaw, monthRaw, dayRaw] = serviceDate.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw) - 1;
  const day = Number(dayRaw);
  const { hh, mm } = parseClock(hhmm);
  return new Date(year, month, day, hh, mm, 0, 0).getTime();
};

export const createEmptyForm = (): ReservationFormState => ({
  customerName: "",
  customerPhone: "",
  reservationTime: buildDefaultTime(),
  covers: "2",
  intolerances: "",
  note: "",
  assignedTableId: null,
  assignedTableIds: [],
  status: "booked",
});

export const reservationToForm = (reservation: DiningReservation): ReservationFormState => ({
  customerName: reservation.customerName,
  customerPhone: reservation.customerPhone,
  reservationTime: toClockTime(reservation.reservationAt),
  covers: String(reservation.covers),
  intolerances: reservation.intolerances,
  note: reservation.note,
  assignedTableId: reservation.assignedTableId,
  assignedTableIds: reservation.assignedTableIds.length
    ? reservation.assignedTableIds
    : reservation.assignedTableId
      ? [reservation.assignedTableId]
      : [],
  status: reservation.status,
});

