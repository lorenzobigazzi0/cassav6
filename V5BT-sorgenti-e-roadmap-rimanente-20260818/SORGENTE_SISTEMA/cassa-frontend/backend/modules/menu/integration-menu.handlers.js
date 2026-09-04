/**
 * Handler HTTP estratti da `backend/server.js` (MIG-031).
 *
 * Spostamento verbatim: la decomposizione del monolite non e il momento per
 * cambiare comportamento. Le dipendenze che prima erano nello scope del modulo
 * arrivano ora per iniezione dal composition root.
 */
export function createIntegrationMenuHandlers({
  readIntegrationMenuView,
  readJsonBody,
  readTopSoldMenuView,
  sendJson,
  sendJsonString,
}) {

  async function handleIntegrationMenu(req, res, requestUrl = null) {
    const method = String(req?.method ?? "GET")
      .trim()
      .toUpperCase();
    const payload = method === "POST" ? await readJsonBody(req) : {};
    const requestedStation = String(
      payload?.station ?? requestUrl?.searchParams?.get("station") ?? "",
    ).trim();
    const view = await readIntegrationMenuView({ method, requestedStation });
    if (typeof view.json === "string") {
      sendJsonString(res, 200, view.json);
      return;
    }
    sendJson(res, 200, view.payload);
  }

  async function handleIntegrationMenuTopSold(req, res, requestUrl = null) {
    sendJson(res, 200, await readTopSoldMenuView({
      days: requestUrl?.searchParams?.get("days"),
      limit: requestUrl?.searchParams?.get("limit"),
    }));
  }
  

  return {
    handleIntegrationMenu,
    handleIntegrationMenuTopSold,
  };
}
