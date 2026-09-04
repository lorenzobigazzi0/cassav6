export type RoomIdentity = {
  id?: string | null;
  name?: string | null;
};

export const isVirtualWaitingRoom = (room: RoomIdentity | null | undefined) => {
  const id = String(room?.id ?? "")
    .trim()
    .toLowerCase();
  const name = String(room?.name ?? "")
    .trim()
    .toLowerCase();
  return (
    id.includes("attesa_virtuale") ||
    id.includes("attesa-virtuale") ||
    id.includes("virtual_waiting") ||
    id.includes("virtual-waiting") ||
    name === "attesa virtuale" ||
    name.includes("attesa virtuale") ||
    name.includes("virtual waiting")
  );
};

export const reservableRoomOptions = <T extends RoomIdentity>(
  rooms: T[],
  fallbackRoom?: T | null
) => {
  const reservableRooms = rooms.filter((room) => !isVirtualWaitingRoom(room));
  if (reservableRooms.length > 0) return reservableRooms;
  return fallbackRoom && !isVirtualWaitingRoom(fallbackRoom) ? [fallbackRoom] : [];
};
