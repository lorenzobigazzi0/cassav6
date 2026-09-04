export function createPosRoomsHandlers({
  buildMobileRoomSettings,
  buildPosRoomListFromSettings,
  menuSettingsRepository,
  readDb,
  readJsonBody,
  resolveMobileInitialRoom,
  sendJson,
  validateSessionContext,
}) {
  const enabledOperationalRooms = (roomSettings) => {
    const enabledRoomIds = new Set(
      (Array.isArray(roomSettings?.enabledRoomIds)
        ? roomSettings.enabledRoomIds
        : []
      )
        .map((roomId) => String(roomId ?? "").trim())
        .filter(Boolean),
    );
    return (Array.isArray(roomSettings?.rooms) ? roomSettings.rooms : []).filter(
      (room) => {
        const roomId = String(room?.roomId ?? room?.id ?? "").trim();
        return roomId && enabledRoomIds.has(roomId) && room?.enabled !== false;
      },
    );
  };

  async function handlePosRooms(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user } = req?.__authContext?.user
      ? req.__authContext
      : validateSessionContext(db, payload);
    const staticPosSettings = menuSettingsRepository?.getStaticPosSettings?.(db) ?? null;
    const posSettings = staticPosSettings ?? db.posSettings;
    let roomSettings = buildMobileRoomSettings(user, buildPosRoomListFromSettings(posSettings), posSettings);
    if (staticPosSettings && roomSettings.rooms.length === 0 && db.posSettings) {
      roomSettings = buildMobileRoomSettings(
        user,
        buildPosRoomListFromSettings(db.posSettings),
        db.posSettings
      );
    }
    const rooms = enabledOperationalRooms(roomSettings);
    const initialRoom = resolveMobileInitialRoom(user, {
      ...roomSettings,
      rooms,
    });
    sendJson(res, 200, {
      ok: true,
      rooms,
      enabledRoomIds: roomSettings.enabledRoomIds,
      authorizedRoomIds: roomSettings.authorizedRoomIds,
      initialRoom,
      lastSelectedRoomId: String(user.lastSelectedRoomId ?? "").trim() || null,
    });
  }

  return {
    "pos.rooms": handlePosRooms,
  };
}
