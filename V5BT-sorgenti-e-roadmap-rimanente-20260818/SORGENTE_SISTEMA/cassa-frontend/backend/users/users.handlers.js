/**
 * Handler HTTP identity per utenti e gruppi: leggono il body e delegano ai
 * modelli iniettati dal composition root (P2b). Nessun accesso all'app-state.
 */
export function createUsersHandlers({
  readJsonBody,
  readUsersListView,
  saveUsersList,
  sendJson,
}) {
  async function handlePosSettingsUsers(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await readUsersListView(payload));
  }

  async function handleSavePosSettingsUsers(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await saveUsersList(payload));
  }

  return {
    handlePosSettingsUsers,
    handleSavePosSettingsUsers,
  };
}
