import { tableStatus } from "../../../api/tableGroups";
import { toDiningTableFromLayout } from "../../../domain/tables/integrationParsers";
import type { IntegrationLayoutTable } from "../../../domain/tables/integrationTypes";

export type RoomMoveAvailability = {
  freeCount: number;
  totalCount: number;
};

export function buildRoomMoveAvailability(
  tables: readonly IntegrationLayoutTable[]
): Map<string, RoomMoveAvailability> {
  const availabilityByRoom = new Map<string, RoomMoveAvailability>();

  for (const table of tables) {
    const roomId = String(table.roomId ?? "").trim();
    if (!roomId) continue;

    const current = availabilityByRoom.get(roomId) ?? { freeCount: 0, totalCount: 0 };
    availabilityByRoom.set(roomId, {
      freeCount:
        current.freeCount + (tableStatus(toDiningTableFromLayout(table)) === "libero" ? 1 : 0),
      totalCount: current.totalCount + 1,
    });
  }

  return availabilityByRoom;
}

export function formatRoomMoveAvailability({
  freeCount,
  totalCount,
}: RoomMoveAvailability): string {
  const safeTotal = Math.max(0, Math.trunc(totalCount));
  const safeFree = Math.min(safeTotal, Math.max(0, Math.trunc(freeCount)));
  if (safeFree === 0) return "Piena";
  return `${safeFree === 1 ? "Libero" : "Liberi"} ${safeFree}/${safeTotal}`;
}
