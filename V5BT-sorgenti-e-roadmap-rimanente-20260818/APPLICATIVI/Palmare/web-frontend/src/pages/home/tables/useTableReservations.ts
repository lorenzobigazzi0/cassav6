import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchReservationsForDay, reservationsQueryKey } from "../../../api/reservations";
import type { DiningTable } from "../../../api/tables";
import type { DiningReservation } from "../../../api/reservations";
import { useAuthStore } from "../../../store/authStore";
import { getOrCreateDeviceUuid } from "../../../utils/device";

const effectiveUserIdFor = (userId?: string | null, username?: string | null) => {
  if (userId?.trim()) return userId.trim();
  if (username?.trim()) {
    return `u_${username
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")}`;
  }
  return "u_operatore";
};

const reservationMatchesTable = (reservation: DiningReservation, tableIds: Set<string>) => {
  const assignedIds = reservation.assignedTableIds.length
    ? reservation.assignedTableIds
    : reservation.assignedTableId
      ? [reservation.assignedTableId]
      : [];
  return assignedIds.some((tableId) => tableIds.has(tableId));
};

const toDateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const tableIdsForReservationMatch = (table: DiningTable | null) =>
  new Set(
    [
      table?.id,
      table?.mobileActiveTableId,
      table?.logicalTableId,
      ...(table?.mobileLeafTableIds ?? []),
    ]
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean)
  );

export function useTableReservationsForToday(table: DiningTable | null) {
  const { token, userId, username, deviceUuid, roomId, activityId } = useAuthStore();
  const serviceDate = toDateKey(new Date());
  const effectiveUserId = useMemo(() => effectiveUserIdFor(userId, username), [userId, username]);
  const effectiveDeviceUuid = useMemo(
    () => (deviceUuid?.trim() ? deviceUuid : getOrCreateDeviceUuid()),
    [deviceUuid]
  );
  const enabled = Boolean(table && token && effectiveUserId && effectiveDeviceUuid && roomId);
  const query = useQuery({
    queryKey: reservationsQueryKey(roomId || "", serviceDate),
    enabled,
    staleTime: 10_000,
    queryFn: () =>
      fetchReservationsForDay({
        token: token || "",
        userId: effectiveUserId,
        deviceUuid: effectiveDeviceUuid,
        roomId: roomId || "",
        serviceDate,
      }),
  });
  const tableIds = useMemo(() => tableIdsForReservationMatch(table), [table]);
  const reservations = useMemo(
    () =>
      (query.data?.reservations ?? [])
        .filter((reservation) => reservation.status !== "released")
        .filter((reservation) => reservationMatchesTable(reservation, tableIds)),
    [query.data?.reservations, tableIds]
  );
  const plannedCount = reservations.filter((reservation) => reservation.status === "booked").length;

  return {
    query,
    reservations,
    plannedCount,
    session: {
      token: token || "",
      userId: effectiveUserId,
      deviceUuid: effectiveDeviceUuid,
      roomId: roomId || "",
      activityId: activityId || "",
      serviceDate,
    },
  };
}
