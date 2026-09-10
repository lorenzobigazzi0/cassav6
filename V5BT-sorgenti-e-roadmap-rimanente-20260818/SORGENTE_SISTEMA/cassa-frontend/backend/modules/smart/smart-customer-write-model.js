export function createSmartCustomerWriteModel(deps = {}) {
  const {
    HttpError,
    nowIso,
    randomUUID,
    readDb,
    sanitizeSmartCustomer,
    sanitizeSmartCustomerForResponse,
    validateSessionContext,
    writeDb,
  } = deps;

  function ensureSmartCustomers(db) {
    if (!Array.isArray(db.smartCustomers)) db.smartCustomers = [];
  }

  async function upsertCustomer(payload) {
    const db = await readDb();
    ensureSmartCustomers(db);
    const { user } = validateSessionContext(db, payload);
    const input = payload.customer;
    if (!input || typeof input !== "object") {
      throw new HttpError(400, "Cliente smart non valido.");
    }
    const firstName = String(input.firstName ?? "").trim();
    const lastName = String(input.lastName ?? "").trim();
    const phone = String(input.phone ?? "").trim();
    if (!firstName || !lastName) {
      throw new HttpError(400, "Nome e cognome sono obbligatori.");
    }
    if (!phone) throw new HttpError(400, "Numero di telefono obbligatorio.");

    const candidateId =
      typeof input.id === "string" && input.id.trim().length > 0
        ? input.id.trim()
        : `smart_cli_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const existingIndex = db.smartCustomers.findIndex((item) => item.id === candidateId);
    const existing = existingIndex >= 0 ? db.smartCustomers[existingIndex] : null;
    const timestamp = nowIso();
    const normalized = sanitizeSmartCustomer(
      {
        ...existing,
        ...input,
        id: candidateId,
        firstName,
        lastName,
        phone,
        updatedAt: timestamp,
        createdAt: existing?.createdAt ?? timestamp,
      },
      candidateId,
    );

    if (existingIndex >= 0) db.smartCustomers[existingIndex] = normalized;
    else db.smartCustomers.push(normalized);
    db.meta.lastWriteAt = nowIso();
    await writeDb(db);
    return {
      ok: true,
      customer: sanitizeSmartCustomerForResponse(normalized),
      updatedBy: user.username,
    };
  }

  async function deleteCustomer(payload) {
    const customerId = String(payload.customerId ?? "").trim();
    if (!customerId) throw new HttpError(400, "Cliente non valido.");
    const db = await readDb();
    ensureSmartCustomers(db);
    validateSessionContext(db, payload);
    const next = db.smartCustomers.filter((customer) => customer.id !== customerId);
    if (next.length === db.smartCustomers.length) {
      throw new HttpError(404, "Cliente non trovato.");
    }
    db.smartCustomers = next;
    db.meta.lastWriteAt = nowIso();
    await writeDb(db);
    return { ok: true, customerId };
  }

  return { deleteCustomer, upsertCustomer };
}
