import type { DiningReservation } from "../../../../api/reservations";
import { AllergenIcon as SharedAllergenIcon } from "../../../../shared/allergens/AllergenIcon";

export type ReservationActionIconName = "arrived" | "no_show" | "delete";

export const RESERVATION_ACTION_ICON_SRC: Record<ReservationActionIconName, string> = {
  arrived: "/mobile/assets/arrivati.png",
  no_show: "/mobile/assets/noshow.png",
  delete: "/mobile/assets/cancel.png",
};

const reservationStatusIconByStatus: Partial<
  Record<DiningReservation["status"], ReservationActionIconName>
> = {
  arrived: "arrived",
  no_show: "no_show",
  cancelled: "delete",
  released: "delete",
};

export function ReservationActionIcon({ action }: { action: ReservationActionIconName }) {
  return <img src={RESERVATION_ACTION_ICON_SRC[action]} alt="" aria-hidden="true" />;
}

export function ReservationSaveIcon() {
  return (
    <svg className="reservations-save-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 4h12l2 2v14H5z" />
      <path d="M8 4v6h8V4" />
      <path d="M8 20v-6h8v6" />
    </svg>
  );
}

export function ReservationStatusIcon({ status }: { status: DiningReservation["status"] }) {
  const action = reservationStatusIconByStatus[status];
  if (action) return <ReservationActionIcon action={action} />;
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="3" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
      <path d="M5 10h14" />
    </svg>
  );
}

export function AllergenIcon({ allergen }: { allergen?: string }) {
  return (
    <SharedAllergenIcon
      allergen={allergen}
      className="reservations-allergen-icon table-detail-allergen-icon"
    />
  );
}
