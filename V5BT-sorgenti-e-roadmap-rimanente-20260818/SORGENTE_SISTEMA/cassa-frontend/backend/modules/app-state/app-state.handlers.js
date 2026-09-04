export function createAppStateHandlers({
  readAppStateView,
  syncAppStateView,
  HttpError,
  debugEnabled,
  maintenanceEnabled,
  readJsonBody,
  resetAppState,
  sanitizeUser,
  sendJson,
}) {
  async function handleGetAppState(_req, res) {
    sendJson(res, 200, await readAppStateView());
  }

  async function handleSyncAppState(_req, res) {
    sendJson(res, 200, await syncAppStateView());
  }
  async function handleResetAppState(_req, res) {
    if (!debugEnabled || !maintenanceEnabled) {
      throw new HttpError(404, "Endpoint non trovato.");
    }
    const payload = await readJsonBody(_req);
    if (payload.confirm !== "RESET_POS_DB") {
      throw new HttpError(400, "Conferma reset mancante.", { code: "RESET_CONFIRMATION_REQUIRED" });
    }
    const db = await resetAppState();
    sendJson(res, 200, {
      ok: true,
      users: db.users.map((user) => sanitizeUser(user, db.posSettings)),
      sessionsCount: db.sessions.length,
      menuItemsCount: db.menuItems.length,
      saleSessionsCount: db.saleSessions.length,
    });
  }

  return {
    handleGetAppState,
    handleResetAppState,
    handleSyncAppState,
  };
}
