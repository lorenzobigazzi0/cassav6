/**
 * Handler HTTP identity: parsing della request, validazioni pure e mappatura
 * esito -> risposta. Ogni accesso all'app-state vive nei write model iniettati
 * dal composition root (P2b), quindi qui non compaiono ne `readDb` ne `writeDb`.
 */
export function createAuthHandlers({
  changeUserPin,
  getLoginRequestIp,
  login,
  logout,
  normalizeClientApp,
  readJsonBody,
  refreshSessionStatus,
  resolveClientAppFromRequest,
  retrySessionStatusPersistently,
  selectWorkstation,
  sendJson,
}) {
  async function handleLogin(req, res) {
    const payload = await readJsonBody(req);
    const username =
      typeof payload.username === "string" ? payload.username.trim() : "";
    const pin = typeof payload.pin === "string" ? payload.pin.trim() : "";
    const deviceUuid =
      typeof payload.deviceUuid === "string" ? payload.deviceUuid.trim() : "";
    const payloadClientApp =
      typeof payload.clientApp === "string" ? payload.clientApp.trim() : "";
    const clientApp = resolveClientAppFromRequest(req, payloadClientApp);
    const ipAddress =
      typeof getLoginRequestIp === "function" ? getLoginRequestIp(req) : "";

    if (!username) {
      sendJson(res, 400, { ok: false, error: "Inserisci il nome utente." });
      return;
    }

    if (!/^\d{4,6}$/.test(pin)) {
      sendJson(res, 400, { ok: false, error: "PIN non valido (4-6 cifre)." });
      return;
    }

    if (!deviceUuid) {
      sendJson(res, 400, { ok: false, error: "Dispositivo non riconosciuto." });
      return;
    }

    const esito = await login({
      payload,
      clientApp,
      ipAddress,
      username,
      pin,
      deviceUuid,
    });
    if (esito.outcome === "rejected") {
      sendJson(res, esito.status, {
        ok: false,
        error: esito.error,
        ...(esito.code ? { code: esito.code } : {}),
        ...(esito.details ? { details: esito.details } : {}),
      });
      return;
    }

    sendJson(res, 200, esito.body);
  }

  async function handleSelectWorkstation(req, res) {
    const payload = await readJsonBody(req);
    const clientApp = normalizeClientApp(
      resolveClientAppFromRequest(req, payload.clientApp),
    );

    const { outcome, selectedWorkstation } = await selectWorkstation({
      payload,
      clientApp,
    });
    if (outcome === "client_not_postazione") {
      sendJson(res, 403, {
        ok: false,
        error: "Selezione disponibile solo per Postazione Advanced.",
        code: "WORKSTATION_CLIENT_REQUIRED",
      });
      return;
    }
    if (outcome === "change_requires_logout") {
      sendJson(res, 409, {
        ok: false,
        error: "Per cambiare postazione esegui prima il logout.",
        code: "WORKSTATION_CHANGE_REQUIRES_LOGOUT",
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      workstationSelectionRequired: false,
      selectedWorkstation,
    });
  }

  async function handleAuthSessionStatus(req, res) {
    const payload = await readJsonBody(req);
    const payloadClientApp =
      typeof payload.clientApp === "string" ? payload.clientApp.trim() : "";
    const clientApp = resolveClientAppFromRequest(req, payloadClientApp);

    const result = await refreshSessionStatus({
      authenticatedDb: req.__authDb,
      clientApp,
      fastPath: req.__authSessionStatusFastPath === true,
      payload,
    });
    if (result.outcome === "retry_persistently") {
      await retrySessionStatusPersistently(req, res);
      return;
    }
    if (result.preserveIntegrationHotCaches) {
      req.__preserveIntegrationHotCaches = true;
    }
    sendJson(res, 200, result.response);
  }

  async function handleChangePin(req, res) {
    const payload = await readJsonBody(req);
    const currentPin =
      typeof payload.currentPin === "string" ? payload.currentPin.trim() : "";
    const newPin =
      typeof payload.newPin === "string" ? payload.newPin.trim() : "";
    const confirmPin =
      typeof payload.confirmPin === "string" ? payload.confirmPin.trim() : "";

    if (!/^\d{4}$/.test(currentPin)) {
      sendJson(res, 400, { ok: false, error: "PIN attuale non valido." });
      return;
    }
    if (!/^\d{4}$/.test(newPin)) {
      sendJson(res, 400, {
        ok: false,
        error: "Il nuovo PIN deve essere di 4 cifre.",
      });
      return;
    }
    if (newPin !== confirmPin) {
      sendJson(res, 400, {
        ok: false,
        error: "Il nuovo PIN e la conferma non coincidono.",
      });
      return;
    }

    const { outcome } = await changeUserPin({ payload, currentPin, newPin });
    if (outcome === "invalid_current_pin") {
      sendJson(res, 401, { ok: false, error: "PIN attuale non corretto." });
      return;
    }
    if (outcome === "user_not_found") {
      sendJson(res, 404, { ok: false, error: "Utente non trovato." });
      return;
    }

    sendJson(res, 200, { ok: true, changed: true });
  }

  async function handleLogout(req, res) {
    const payload = await readJsonBody(req);

    const { outcome } = await logout({ payload });
    if (outcome === "session_cache_unavailable") {
      sendJson(res, 503, {
        ok: false,
        error: "Impossibile invalidare la sessione. Riprova tra poco.",
        code: "SESSION_CACHE_INVALIDATION_UNAVAILABLE",
      });
      return;
    }

    sendJson(res, 200, { ok: true, loggedOut: true });
  }

  return {
    handleAuthSessionStatus,
    handleChangePin,
    handleLogin,
    handleLogout,
    handleSelectWorkstation,
  };
}
