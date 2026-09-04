/**
 * Handler HTTP delle notifiche di integrazione (MIG-031).
 *
 * Spostati da `backend/server.js` senza modificarne il corpo: la decomposizione
 * del monolite non e il momento per cambiare comportamento. Le dipendenze che
 * prima erano nello scope del modulo arrivano ora per iniezione dal composition
 * root, come per gli altri handler gia estratti.
 *
 * Dominio dichiarato in `scripts/postgresql-migration/route-domain-map.mjs`:
 * `messaging`, con `integration` fra i contenitori legacy attraversati.
 */
import { compareIntegrationNotifications } from "./notification-priority.js";

export function createNotificationsHandlers({
  acknowledgeNotification,
  publishNotification,
  pullNotifications,
  BELL_TARGET_TIMEOUT_MS,
  HttpError,
  INTEGRATION_WAITER_ACTIVE_WINDOW_MS,
  applyBellClaimAssignmentToOrder,
  applyOrderReadyNotificationHandoff,
  buildNotificationOnlineFallbackView,
  buildOrderReadyHandoffRealtimeEvents,
  buildWaiterRoutingMetadata,
  collectActiveWaitersInRoom,
  collectLoggedInWaiters,
  createDefaultIntegrationState,
  enqueueRealtimePilotEvent,
  findIntegrationBellClaim,
  findIntegrationOrderIndexByLookup,
  findLatestSessionForNotificationRequester,
  flushDueWaiterDeferredCalls,
  flushTableRoomMoveDeferredCallsForUser,
  getNotificationRequestIp,
  isNotificationFreshForSession,
  isNotificationGloballyAcknowledged,
  markNotificationGloballyAcknowledged,
  maybeEscalateBellNotification,
  normalizeClientApp,
  normalizeIntegrationNotificationType,
  normalizeWaiterPauseCollections,
  notificationMatchesTarget,
  nowIso,
  pruneIntegrationState,
  publishIntegrationNotificationStreamRefresh,
  queueBellNotification,
  queueIntegrationNotification,
  readDb,
  readJsonBody,
  refreshExpiredWaiterPause,
  removeMobilePickupNotificationsForOrder,
  resolveNotificationRequesterUser,
  resolveWaiterPauseState,
  sanitizeIntegrationNotification,
  sendJson,
  shouldDeliverNotificationByOnlineFallback,
  shouldGloballyAcknowledgeNotification,
  shouldSuppressNotificationForWaiterPause,
  touchSessionHeartbeat,
  upsertIntegrationBellClaim,
  validateNotificationSessionRequest,
  writeNotificationPunctualDb,
}) {
  async function handleIntegrationNotificationPublish(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await publishNotification(payload));
  }

  async function handleIntegrationNotificationsPull(req, res, requestUrl) {
    sendJson(res, 200, await pullNotifications(requestUrl, req));
  }

  async function handleIntegrationNotificationAck(req, res) {
    const payload = await readJsonBody(req);
    const esito = await acknowledgeNotification(payload, req);
    sendJson(res, esito.stato, esito.corpo);
  }
  return {
    handleIntegrationNotificationPublish,
    handleIntegrationNotificationsPull,
    handleIntegrationNotificationAck,
  };
}
