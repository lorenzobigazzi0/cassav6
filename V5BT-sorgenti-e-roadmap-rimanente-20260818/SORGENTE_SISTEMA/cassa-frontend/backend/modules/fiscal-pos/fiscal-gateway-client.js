const OPERATION_TYPES = new Set([
  "UNPAID_GOODS_DOCUMENT", "UNPAID_SERVICES_DOCUMENT", "RECOVER_CREDIT_CASH",
  "RECOVER_CREDIT_CHECK", "SERVICE_RECEIVABLE_SETTLEMENT", "PRINT_PAYMENT_RECEIPT",
  "REPRINT_PAYMENT_RECEIPT",
]);

export class FiscalGatewayClient {
  constructor({ baseUrl, serviceToken, fetchImpl = fetch, timeoutMs = 12_000 }) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.serviceToken = String(serviceToken || "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  createUnpaidGoodsDocument(input) { return this.createOperation("UNPAID_GOODS_DOCUMENT", input); }
  createUnpaidServicesDocument(input) { return this.createOperation("UNPAID_SERVICES_DOCUMENT", input); }
  recoverCreditCash(input) { return this.createOperation("RECOVER_CREDIT_CASH", input); }
  recoverCreditCheck(input) { return this.createOperation("RECOVER_CREDIT_CHECK", input); }
  createServiceSettlement(input) { return this.createOperation("SERVICE_RECEIVABLE_SETTLEMENT", input); }
  printPaymentReceipt(input) { return this.createOperation("PRINT_PAYMENT_RECEIPT", input); }
  reprintPaymentReceipt(input) { return this.createOperation("REPRINT_PAYMENT_RECEIPT", input); }

  async createOperation(operationType, input) {
    if (!OPERATION_TYPES.has(operationType)) throw new TypeError("Tipo operazione fiscale non valido.");
    return this.request("POST", "/api/v1/fiscal/operations", { ...input, type: operationType });
  }

  getOperationStatus(operationId) {
    return this.request("GET", `/api/v1/fiscal/operations/${encodeURIComponent(operationId)}`);
  }

  async request(method, path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method, signal: controller.signal,
        headers: { Accept: "application/json", Authorization: `Bearer ${this.serviceToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(payload.errorMessage || "Gateway fiscale non disponibile."), { code: payload.errorCode || "FISCAL_GATEWAY_ERROR", status: response.status });
      return payload;
    } catch (error) {
      if (error?.name === "AbortError" || !Number(error?.status)) {
        throw Object.assign(new Error("Esito gateway fiscale incerto; riconciliazione obbligatoria."), { code: "FISCAL_OPERATION_UNKNOWN", fiscalStatus: "UNKNOWN", cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
