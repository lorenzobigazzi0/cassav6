import { fetchTablesForSession } from "../../../api/tables";

type ReleaseWarningParams = {
  token: string;
  effectiveUserId: string;
  effectiveDeviceUuid: string;
  effectiveRoomId: string;
  serviceDate: string;
  reminderSent: Set<string>;
  emitGeneralNotification: (title: string, description: string) => Promise<void>;
};

const toClock = (timestamp: number) => {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

export async function emitReservationReleaseWarnings({
  token,
  effectiveUserId,
  effectiveDeviceUuid,
  effectiveRoomId,
  serviceDate,
  reminderSent,
  emitGeneralNotification,
}: ReleaseWarningParams) {
  const snapshot = await fetchTablesForSession({
    token,
    userId: effectiveUserId,
    deviceUuid: effectiveDeviceUuid,
    roomId: effectiveRoomId,
  }).catch(() => null);
  if (!snapshot) return;

  for (const table of snapshot.tables) {
    const preview = table.reservationPreview;
    if (!preview?.shouldWarnRelease) continue;
    const warningKey = `${serviceDate}|${preview.id}|30_occupied_release`;
    if (reminderSent.has(warningKey)) continue;
    reminderSent.add(warningKey);
    const tableLabel = table.mobileComplexLabel || `Tavolo ${table.number}`;
    await emitGeneralNotification(
      "Tavolo da liberare",
      `${tableLabel} va lasciato entro 10 minuti: prenotazione alle ${toClock(preview.reservationAt)}`
    );
  }
}
