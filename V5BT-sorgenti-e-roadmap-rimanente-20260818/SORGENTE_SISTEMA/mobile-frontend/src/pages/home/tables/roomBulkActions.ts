import {
  adminCancelDiningTable,
  fetchTablesForSession,
  freeDiningTable,
  type DiningTable,
  type TableSessionRequest,
} from "../../../api/tables";

export type RoomBulkOutcome = {
  /** Tavoli non vuoti trovati nella sala. */
  total: number;
  /** Tavoli effettivamente portati a vuoto. */
  done: number;
  /** Tavoli lasciati intatti perche' hanno ordini aperti o importi da riscuotere. */
  skipped: number;
};

const isEmpty = (table: DiningTable) => table.occupancyState === "free";
const canFree = (table: DiningTable) => table.ordersInProgress <= 0 && table.amountDue <= 0;

async function loadRoomTables(session: TableSessionRequest, roomId: string) {
  const snapshot = await fetchTablesForSession({ ...session, roomId });
  return snapshot.rawTables ?? snapshot.tables;
}

/** Libera i tavoli occupati della sala. Non tocca quelli con ordini o conti aperti. */
export async function freeRoomTables(
  session: TableSessionRequest,
  room: { id: string; name?: string }
): Promise<RoomBulkOutcome> {
  const targets = (await loadRoomTables(session, room.id)).filter((table) => !isEmpty(table));
  let done = 0;
  let skipped = 0;
  for (const table of targets) {
    if (!canFree(table)) {
      skipped += 1;
      continue;
    }
    await freeDiningTable({ ...session, roomId: room.id, tableId: table.id });
    done += 1;
  }
  return { total: targets.length, done, skipped };
}

/**
 * Svuota la sala: annulla ordini e pagamenti aperti di ogni tavolo, poi li libera.
 * Il secondo giro rilegge la sala perche' la liberazione e' ammessa solo quando
 * l'annullamento ha gia' tolto ordini e importi.
 */
export async function clearRoomTables(
  session: TableSessionRequest,
  room: { id: string; name?: string },
  reason: string
): Promise<RoomBulkOutcome> {
  const scoped = { ...session, roomId: room.id };
  const targets = (await loadRoomTables(session, room.id)).filter((table) => !isEmpty(table));
  for (const table of targets) {
    const orderIds = table.orderHistory
      .filter((order) => order.state !== "paid")
      .map((order) => order.id)
      .filter(Boolean);
    await adminCancelDiningTable({ ...scoped, roomName: room.name, table, reason, orderIds });
  }
  let done = 0;
  let skipped = 0;
  for (const table of (await loadRoomTables(session, room.id)).filter((entry) => !isEmpty(entry))) {
    if (!canFree(table)) {
      skipped += 1;
      continue;
    }
    await freeDiningTable({ ...scoped, tableId: table.id });
    done += 1;
  }
  return { total: targets.length, done, skipped };
}
