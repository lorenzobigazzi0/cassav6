/**
 * Modello delle due route di lettura dell'app-state (P2b, dominio `app_meta`).
 *
 * `buildAppStatePayload` e una proiezione pura e viene qui con loro: era usata
 * solo da queste due route. La terza route del file, `appState.reset`, non
 * passa da qui perche non usa `readDb` ma `resetAppState`, che e gia un owner
 * a se.
 *
 * `appState.sync` e dichiarata mutativa e lo e davvero: fa avanzare il ciclo
 * di vita delle sessioni di vendita e scrive **solo se qualcosa e cambiato**.
 * Quel `if (changed)` va conservato: scrivere sempre sposterebbe
 * `meta.lastWriteAt` a ogni sincronizzazione.
 */
export function createAppStateModel({
  findActiveSaleSession,
  nowIso,
  readDb,
  runAutomaticSaleLifecycle,
  sanitizeMenuItem,
  sanitizePosSettings,
  sanitizeSaleSession,
  sanitizeSaleSessionTemplate,
  sanitizeSession,
  sanitizeSolarClosure,
  sanitizeUser,
  writeDb,
}) {
  function buildAppStatePayload(db) {
    const activeSaleSession = findActiveSaleSession(db);

    return {
      users: db.users.map((user) => sanitizeUser(user, db.posSettings)),
      sessionsCount: db.sessions.length,
      lastSession: db.sessions.length ? sanitizeSession(db.sessions[db.sessions.length - 1]) : null,
      saleSessionTemplates: db.saleSessionTemplates.map((item) => sanitizeSaleSessionTemplate(item)),
      menuItemsCount: db.menuItems.length,
      sampleMenuItems: db.menuItems.slice(0, 5).map(sanitizeMenuItem),
      posSettings: sanitizePosSettings(db.posSettings, { menuItems: db.menuItems }),
      paymentsCount: db.payments.length,
      paymentContainersCount: Array.isArray(db.paymentContainers) ? db.paymentContainers.length : 0,
      paymentPartsCount: Array.isArray(db.paymentParts) ? db.paymentParts.length : 0,
      paymentTransactionsCount: Array.isArray(db.paymentTransactions) ? db.paymentTransactions.length : 0,
      cashTxDenomsCount: Array.isArray(db.cashTxDenoms) ? db.cashTxDenoms.length : 0,
      fiscalReceiptsCount: db.fiscalReceipts.length,
      smartCustomersCount: db.smartCustomers.length,
      smartNonFiscalCount: db.smartNonFiscal.length,
      auditEventsCount: Array.isArray(db.auditEvents) ? db.auditEvents.length : 0,
      integrationOrdersCount: Array.isArray(db.integration?.orders) ? db.integration.orders.length : 0,
      integrationNotificationsCount: Array.isArray(db.integration?.notifications)
        ? db.integration.notifications.length
        : 0,
      integrationTableGroupsCount: Array.isArray(db.integration?.tableGroups)
        ? db.integration.tableGroups.length
        : 0,
      posRoomChangeRequestsCount: Array.isArray(db.posRoomChangeRequests)
        ? db.posRoomChangeRequests.length
        : 0,
      posTableRoomMoveRequestsCount: Array.isArray(db.posTableRoomMoveRequests)
        ? db.posTableRoomMoveRequests.length
        : 0,
      posReservationStatesCount: Array.isArray(db.posReservationStates)
        ? db.posReservationStates.length
        : 0,
      posReservationLocksCount: Array.isArray(db.posReservationLocks)
        ? db.posReservationLocks.length
        : 0,
      saleSessionsCount: db.saleSessions.length,
      activeSaleSession: activeSaleSession ? sanitizeSaleSession(activeSaleSession) : null,
      recentSolarClosures: [...db.solarClosures]
        .sort((a, b) => b.key.localeCompare(a.key))
        .slice(0, 6)
        .map(sanitizeSolarClosure),
      meta: db.meta,
    };
  }

  async function readAppStateView() {
    const db = await readDb({ allowMigrations: false });
    return buildAppStatePayload(db);
  }

  async function syncAppStateView() {
    const db = await readDb();
    const changed = runAutomaticSaleLifecycle(db);
    if (changed) {
      db.meta.lastWriteAt = nowIso();
      await writeDb(db);
    }

    return {
      ok: true,
      changed,
      ...buildAppStatePayload(db),
    };
  }

  return {
    readAppStateView,
    syncAppStateView,
  };
}
