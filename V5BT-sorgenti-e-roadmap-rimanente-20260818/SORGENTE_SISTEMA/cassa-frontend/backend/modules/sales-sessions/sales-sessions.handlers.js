import {
  computeBusinessDateForStart,
  createSaleSessionStatusBuilder,
  findActiveSaleSession,
  sanitizeSaleSession,
} from "./sales-sessions.domain.js";

export function createSalesSessionsHandlers({
  HttpError,
  SALE_SESSION_MAX_MS,
  appendAuditEvent,
  buildAuditActor,
  hasPermission,
  nowIso,
  randomUUID,
  readDb,
  readJsonBody,
  runAutomaticSaleLifecycle,
  saleSessionsRepository,
  sendJson,
  validateSessionContext,
  writeDb,
}) {
  const buildSaleSessionStatus = createSaleSessionStatusBuilder({
    hasPermission,
  });

  async function handleSaleSessionStatus(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    if (runAutomaticSaleLifecycle(db)) {
      db.meta.lastWriteAt = nowIso();
      await writeDb(db);
    }
    const statusSource = saleSessionsRepository?.buildStatusSource?.(db) ?? db;
    sendJson(res, 200, buildSaleSessionStatus(statusSource, user));
  }

  async function handleSaleSessionOpen(req, res) {
    const payload = await readJsonBody(req);
    const templateId = typeof payload.templateId === "string" ? payload.templateId.trim() : "";

    if (!templateId) {
      throw new HttpError(400, "Template sessione non valido.");
    }

    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    if (runAutomaticSaleLifecycle(db)) {
      db.meta.lastWriteAt = nowIso();
      await writeDb(db);
    }

    if (!hasPermission(user, "manage_sale_sessions")) {
      throw new HttpError(403, "Utente non autorizzato ad aprire sessioni vendita.");
    }

    if (findActiveSaleSession(db)) {
      throw new HttpError(409, "Esiste gia una sessione di vendita attiva.");
    }

    const template = db.saleSessionTemplates.find((item) => item.id === templateId && item.enabled);
    if (!template) {
      throw new HttpError(400, "Template sessione non disponibile.");
    }

    const startedAt = nowIso();
    const saleSession = {
      id: `sale_${randomUUID().replace(/-/g, "")}`,
      templateId: template.id,
      templateName: template.name,
      scheduledStart: template.startTime,
      scheduledEnd: template.endTime,
      businessDate: computeBusinessDateForStart(startedAt, template),
      startedAt,
      startedByUserId: user.id,
      startedByUsername: user.username,
      endedAt: null,
      endedByUserId: null,
      endedByUsername: null,
    };

    db.saleSessions.push(saleSession);
    const openAuditActor = buildAuditActor(user, payload);
    appendAuditEvent(db, {
      ...openAuditActor,
      action: "shift.opened",
      entityType: "shift",
      entityId: saleSession.id,
      payload: sanitizeSaleSession(saleSession),
      after: sanitizeSaleSession(saleSession),
    });
    db.meta.lastWriteAt = nowIso();
    await writeDb(db);

    const statusSource = saleSessionsRepository?.buildStatusSource?.(db) ?? db;
    sendJson(res, 200, buildSaleSessionStatus(statusSource, user));
  }

  async function handleSaleSessionClose(req, res) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const { user } = validateSessionContext(db, payload);
    if (runAutomaticSaleLifecycle(db)) {
      db.meta.lastWriteAt = nowIso();
      await writeDb(db);
    }

    if (!hasPermission(user, "manage_sale_sessions")) {
      throw new HttpError(403, "Utente non autorizzato a chiudere sessioni vendita.");
    }

    const active = findActiveSaleSession(db);
    if (!active) {
      throw new HttpError(409, "Nessuna sessione di vendita attiva da chiudere.");
    }

    if (active.startedByUserId === user.id) {
      throw new HttpError(403, "La sessione puo essere chiusa solo da un altro utente abilitato.");
    }

    const startedAtMs = new Date(active.startedAt).getTime();
    const effectiveEndMs = Math.min(Date.now(), startedAtMs + SALE_SESSION_MAX_MS);
    active.endedAt = new Date(effectiveEndMs).toISOString();
    active.endedByUserId = user.id;
    active.endedByUsername = user.username;
    const closeAuditActor = buildAuditActor(user, payload);
    appendAuditEvent(db, {
      ...closeAuditActor,
      action: "shift.closed",
      entityType: "shift",
      entityId: active.id,
      payload: sanitizeSaleSession(active),
      after: sanitizeSaleSession(active),
    });

    db.meta.lastWriteAt = nowIso();
    await writeDb(db);

    const statusSource = saleSessionsRepository?.buildStatusSource?.(db) ?? db;
    sendJson(res, 200, buildSaleSessionStatus(statusSource, user));
  }

  return {
    "sales.sessionClose": handleSaleSessionClose,
    "sales.sessionOpen": handleSaleSessionOpen,
    "sales.sessionStatus": handleSaleSessionStatus,
  };
}
