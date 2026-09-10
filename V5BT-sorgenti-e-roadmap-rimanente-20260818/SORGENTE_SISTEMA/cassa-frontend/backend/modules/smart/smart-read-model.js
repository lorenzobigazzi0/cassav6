export function createSmartReadModel(deps = {}) {
  const {
    HttpError,
    SMART_CARD_ALLOW_MOCK_FALLBACK,
    SMART_CARD_READ_TIMEOUT_MS,
    clampSmartCardReadTimeout,
    nowIso,
    readDb,
    sanitizeSmartCustomerForResponse,
    sanitizeSmartNonFiscalEntry,
    validateSessionContext,
    waitForSmartCardDetection,
  } = deps;

  function ensureSmartCollections(db) {
    if (!Array.isArray(db.smartCustomers)) db.smartCustomers = [];
    if (!Array.isArray(db.smartNonFiscal)) db.smartNonFiscal = [];
  }

  async function listCustomers(payload) {
    const db = await readDb();
    ensureSmartCollections(db);
    validateSessionContext(db, payload);
    return {
      ok: true,
      customers: [...db.smartCustomers]
        .map((customer) => sanitizeSmartCustomerForResponse(customer))
        .sort((a, b) =>
          `${a.lastName} ${a.firstName}`.trim().localeCompare(
            `${b.lastName} ${b.firstName}`.trim(),
            "it-IT",
          ),
        ),
    };
  }

  async function listNonFiscalEntries(payload) {
    const db = await readDb();
    ensureSmartCollections(db);
    validateSessionContext(db, payload);
    return {
      ok: true,
      entries: [...db.smartNonFiscal]
        .map((entry) =>
          sanitizeSmartNonFiscalEntry(entry, `smart_nf_${entry?.id ?? Date.now()}`),
        )
        .filter((entry) => entry !== null)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 200),
    };
  }

  async function readCard(payload) {
    const db = await readDb();
    validateSessionContext(db, payload);
    const requestedWaitMs = Number(payload.waitMs);
    const waitMs = clampSmartCardReadTimeout(
      Number.isFinite(requestedWaitMs)
        ? Math.trunc(requestedWaitMs)
        : SMART_CARD_READ_TIMEOUT_MS,
    );
    try {
      const detection = await waitForSmartCardDetection(waitMs);
      if (!detection) {
        throw new HttpError(
          408,
          `Nessun chip rilevato entro ${Math.round(waitMs / 1000)} secondi.`,
        );
      }
      return { ok: true, chipCode: detection.chipCode, detectedAt: detection.detectedAt };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (SMART_CARD_ALLOW_MOCK_FALLBACK) {
        return {
          ok: true,
          chipCode: `SMART-${Date.now().toString().slice(-6)}`,
          detectedAt: nowIso(),
        };
      }
      throw new HttpError(
        503,
        error instanceof Error ? error.message : "Lettore smart card non disponibile.",
      );
    }
  }

  return { listCustomers, listNonFiscalEntries, readCard };
}
