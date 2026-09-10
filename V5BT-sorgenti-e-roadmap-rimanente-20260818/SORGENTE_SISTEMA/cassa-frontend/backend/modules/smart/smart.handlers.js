import { createSmartReadModel } from "./smart-read-model.js";
import { createSmartCustomerWriteModel } from "./smart-customer-write-model.js";
import { createSmartTransactionWriteModel } from "./smart-transaction-write-model.js";

export function createSmartHandlers(deps = {}) {
  const {
    HttpError,
    SMART_CARD_ALLOW_MOCK_FALLBACK,
    SMART_CARD_READ_TIMEOUT_MS,
    assertUserPaymentMethodAllowed,
    clampSmartCardReadTimeout,
    computeDaysUntilDate,
    computeSmartPassExpiry,
    executeFiscalProvider,
    findPaymentMethod,
    formatDateIt,
    isPosDemoModeEnabled,
    normalizeSmartCardCode,
    normalizeSmartPass,
    nowIso,
    randomUUID,
    readDb,
    readJsonBody,
    resolveSmartBeachPassCandidates,
    roundMoney,
    sanitizeFiscalReceipt,
    sanitizePaymentRecord,
    sanitizePosSettings,
    sanitizeSmartCustomer,
    sanitizeSmartCustomerForResponse,
    sanitizeSmartNonFiscalEntry,
    sendJson,
    validateSessionContext,
    waitForSmartCardDetection,
    writeDb,
  } = deps;

  const smartReadModel = createSmartReadModel({
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
  });
  const smartCustomerWriteModel = createSmartCustomerWriteModel({
    HttpError,
    nowIso,
    randomUUID,
    readDb,
    sanitizeSmartCustomer,
    sanitizeSmartCustomerForResponse,
    validateSessionContext,
    writeDb,
  });
  const smartTransactionWriteModel = createSmartTransactionWriteModel({
    HttpError,
    assertUserPaymentMethodAllowed,
    computeDaysUntilDate,
    computeSmartPassExpiry,
    executeFiscalProvider,
    findPaymentMethod,
    formatDateIt,
    isPosDemoModeEnabled,
    normalizeSmartCardCode,
    normalizeSmartPass,
    nowIso,
    randomUUID,
    readDb,
    resolveSmartBeachPassCandidates,
    roundMoney,
    sanitizeFiscalReceipt,
    sanitizePaymentRecord,
    sanitizePosSettings,
    sanitizeSmartCustomer,
    sanitizeSmartCustomerForResponse,
    sanitizeSmartNonFiscalEntry,
    validateSessionContext,
    writeDb,
  });

  async function handleSmartCustomers(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await smartReadModel.listCustomers(payload));
  }

  async function handleSmartCustomerUpsert(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await smartCustomerWriteModel.upsertCustomer(payload));
  }

  async function handleSmartCustomerDelete(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await smartCustomerWriteModel.deleteCustomer(payload));
  }

  async function handleSmartCardRead(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await smartReadModel.readCard(payload));
  }

  async function handleSmartCashBeachEntryConsume(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await smartTransactionWriteModel.consumeBeachEntry(payload));
  }

  async function handleSmartCustomerRecharge(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await smartTransactionWriteModel.rechargeCustomer(payload));
  }

  async function handleSmartNonFiscal(req, res) {
    const payload = await readJsonBody(req);
    sendJson(res, 200, await smartReadModel.listNonFiscalEntries(payload));
  }

  return {
    handleSmartCardRead,
    handleSmartCashBeachEntryConsume,
    handleSmartCustomerDelete,
    handleSmartCustomerRecharge,
    handleSmartCustomerUpsert,
    handleSmartCustomers,
    handleSmartNonFiscal,
  };
}
