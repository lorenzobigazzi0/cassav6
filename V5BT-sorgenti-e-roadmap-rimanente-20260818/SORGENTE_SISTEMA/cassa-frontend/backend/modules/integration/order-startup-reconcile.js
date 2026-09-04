import { OrdersRelationalRepository } from "../../db/relational/index.js";
import { advanceIntegrationOrderSequencePastId } from "./relational-order-create.js";

function positiveRevision(value, fallback = 1) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Fase 1 (idratazione): porta nello stato appena letto gli ordini che il
// relazionale (write-primary, durevole prima dell'ACK) ha e il mirror app-state
// no. Deve avvenire PRIMA di qualunque writeDb: in modalita' shadow ogni write
// riallinea il relazionale allo stato app (replaceAllFromAppState) e
// cancellerebbe gli ordini non ancora mirrorati.
export async function mergeRelationalOrdersIntoHydratedState({
  enabled = false,
  relationalRuntime,
  state,
  findIntegrationOrderIndexByLookup,
  sanitizeIntegrationOrder,
  syncPosTableFinancials = null,
  logger = console,
  marginMs = 6 * 60 * 60 * 1000,
  fallbackWindowMs = 48 * 60 * 60 * 1000,
  nowMs = () => Date.now(),
} = {}) {
  const empty = { enabled, candidates: 0, reconciled: 0, orderIds: [], posSettingsTableIds: [], posSettingsChanged: false };
  if (!enabled || !state || typeof state !== "object") return empty;
  try {
    await relationalRuntime?.initialize?.();
    const relationalDb = relationalRuntime?.db;
    if (!relationalDb) {
      logger?.warn?.("[orders:startup-reconcile] DB relazionale non disponibile: riconciliazione saltata.");
      return { ...empty, skipped: true };
    }
    if (!state.integration || typeof state.integration !== "object") state.integration = {};
    if (!Array.isArray(state.integration.orders)) state.integration.orders = [];
    const integration = state.integration;
    const lastWriteMs = Date.parse(String(integration.lastWriteAt ?? ""));
    const cutoffMs = Number.isFinite(lastWriteMs) ? lastWriteMs - marginMs : nowMs() - fallbackWindowMs;
    const sinceIso = new Date(Math.max(0, cutoffMs)).toISOString();
    const ordersRepository = new OrdersRelationalRepository(relationalDb);
    const candidates = ordersRepository.listOrdersUpdatedSince(sinceIso);
    // Guardia anti-collisione id cross-process: il contatore sequence.order nel
    // mirror puo' essere stantio (es. clobber dell'oggetto sequence da un altro
    // processo); il relazionale e' la fonte di verita' sugli id gia' allocati.
    const maxRelationalOrderId = ordersRepository.getMaxOrderId();
    if (maxRelationalOrderId) advanceIntegrationOrderSequencePastId(integration, maxRelationalOrderId);
    const reconciledIds = [];
    const tableIds = new Set();
    for (const candidate of candidates) {
      const orderId = String(candidate?.id ?? "").trim();
      if (!orderId) continue;
      const relationalRevision = positiveRevision(candidate.revision ?? candidate.currentRevision);
      const orderIndex = findIntegrationOrderIndexByLookup(integration.orders, orderId);
      if (orderIndex >= 0) {
        const appOrder = integration.orders[orderIndex];
        const appRevision = positiveRevision(appOrder?.revision ?? appOrder?.currentRevision);
        if (appRevision > relationalRevision) {
          logger?.warn?.(`[orders:startup-reconcile] app-state piu' avanti del relazionale per ${orderId} (app rev ${appRevision} > rel rev ${relationalRevision}): skip.`);
          continue;
        }
        if (appRevision === relationalRevision) continue;
        integration.orders[orderIndex] = sanitizeIntegrationOrder(candidate, orderId);
      } else {
        integration.orders.push(sanitizeIntegrationOrder(candidate, orderId));
      }
      advanceIntegrationOrderSequencePastId(integration, orderId);
      reconciledIds.push(orderId);
      const tableId = String(candidate.tableId ?? "").trim();
      if (tableId) tableIds.add(tableId);
    }
    if (reconciledIds.length === 0) {
      return { enabled: true, candidates: candidates.length, reconciled: 0, orderIds: [], posSettingsTableIds: [], posSettingsChanged: false };
    }
    let posSettingsChanged = false;
    let posSettingsTableIds = [...tableIds];
    if (typeof syncPosTableFinancials === "function") {
      const financialSync = syncPosTableFinancials(state, tableIds.size > 0 ? [...tableIds] : null);
      posSettingsChanged = financialSync?.changed === true;
      if (Array.isArray(financialSync?.tableIds) && financialSync.tableIds.length > 0) posSettingsTableIds = financialSync.tableIds;
    }
    logger?.log?.(`[orders:startup-reconcile] ripristinati in memoria ${reconciledIds.length} ordini dal relazionale (candidati: ${candidates.length}): ${reconciledIds.join(", ")}`);
    return { enabled: true, candidates: candidates.length, reconciled: reconciledIds.length, orderIds: reconciledIds, posSettingsTableIds, posSettingsChanged };
  } catch (error) {
    logger?.warn?.(`[orders:startup-reconcile] merge in idratazione fallito: ${error instanceof Error ? error.message : String(error)}`);
    return { ...empty, error: true };
  }
}

// Fase 2 (post-listen): rende durevole nel mirror app-state cio' che la fase 1
// ha gia' ripristinato in memoria (in MySQL split una write scoped successiva
// non coprirebbe questi ID).
export async function persistReconciledOrders({
  pending,
  readDb,
  writeOrderSyncDb,
  pruneIntegrationState,
  nowIso,
  runtimeMetrics = null,
  logger = console,
} = {}) {
  const orderIds = Array.isArray(pending?.orderIds) ? pending.orderIds : [];
  if (orderIds.length === 0) {
    logger?.log?.(`[orders:startup-reconcile] 0 divergenze ordini (candidati relazionali: ${pending?.candidates ?? 0}).`);
    return { persisted: 0 };
  }
  const appDb = await readDb();
  appDb.integration.lastWriteAt = nowIso();
  if (!appDb.meta || typeof appDb.meta !== "object") appDb.meta = {};
  appDb.meta.lastWriteAt = nowIso();
  pruneIntegrationState(appDb.integration);
  await writeOrderSyncDb(appDb, {
    orderIds,
    syncSequence: true,
    syncPosSettings: pending.posSettingsChanged === true,
    posSettingsTableIds: pending.posSettingsTableIds ?? [],
    metricLabel: "orders.startupReconcile.appStateWrite",
  });
  runtimeMetrics?.incrementCounter?.("ordersStartupReconciled", orderIds.length);
  logger?.log?.(`[orders:startup-reconcile] mirror app-state aggiornato per ${orderIds.length} ordini riconciliati.`);
  return { persisted: orderIds.length };
}
