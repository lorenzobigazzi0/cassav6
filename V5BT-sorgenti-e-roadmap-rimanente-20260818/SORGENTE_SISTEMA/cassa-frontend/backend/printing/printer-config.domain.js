export function createPrinterConfigHelpers(options = {}) {
  const {
    defaultFiscalPrinterModel = "epson_tm_t800f_m261a",
    defaultNetworkPrinterPort = 9100,
    posPrinterModels = [],
    posPrinterPurposes = new Set(["generic", "production", "fiscal"]),
    normalizeConfigId = (value, fallback = "config") => String(value ?? "").trim() || fallback,
    normalizeReferenceIdList = (value) => (Array.isArray(value) ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean) : []),
    normalizePosFiscalApiPath = (pathname, fallback = "/api/fiscal/reprint") => {
      const raw = String(pathname ?? "").trim() || fallback;
      return raw.startsWith("/") ? raw : `/${raw}`;
    },
  } = options;

  function normalizePrinterPurpose(value) {
    const purpose = String(value ?? "").trim().toLowerCase();
    return posPrinterPurposes.has(purpose) ? purpose : "generic";
  }

  function normalizePrinterModelId(value, purpose = "generic") {
    const modelId = String(value ?? "").trim().toLowerCase();
    const matched = (Array.isArray(posPrinterModels) ? posPrinterModels : []).find((entry) => entry.id === modelId);
    if (matched) return matched.id;
    return purpose === "fiscal" ? defaultFiscalPrinterModel : "generic_tcp";
  }

  function normalizePrinterPort(value) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
      return defaultNetworkPrinterPort;
    }
    return parsed;
  }

  function normalizePrinterHost(value) {
    return String(value ?? "").trim().slice(0, 120);
  }

  function sanitizePosPrinter(entry, fallbackId = "printer") {
    if (!entry || typeof entry !== "object") return null;
    const purpose = normalizePrinterPurpose(entry.purpose);
    const name = String(entry.name ?? "").trim().slice(0, 64);
    const host = normalizePrinterHost(entry.host ?? entry.ip);
    if (!name || !host) return null;
    const printer = {
      id: normalizeConfigId(entry.id, fallbackId),
      name,
      host,
      ip: host,
      port: normalizePrinterPort(entry.port),
      purpose,
      model: normalizePrinterModelId(entry.model, purpose),
      description: String(entry.description ?? "").trim().slice(0, 140),
      active: entry.active !== false,
    };
    if (purpose === "fiscal") {
      printer.fiscalProvider = String(entry.fiscalProvider ?? entry.provider ?? "pos-fiscal-api").trim().slice(0, 80) || "pos-fiscal-api";
      printer.apiBaseUrl = String(entry.apiBaseUrl ?? entry.fiscalApiBaseUrl ?? "").trim().replace(/\/+$/, "").slice(0, 180);
      printer.statusEndpoint = normalizePosFiscalApiPath(entry.statusEndpoint ?? entry.fiscalStatusEndpoint, "/api/fiscal/status").slice(0, 120);
      printer.verifyEndpoint = normalizePosFiscalApiPath(entry.verifyEndpoint ?? entry.fiscalVerifyEndpoint, "/api/fiscal/receipt/verify").slice(0, 120);
      printer.receiptEndpoint = normalizePosFiscalApiPath(entry.receiptEndpoint ?? entry.fiscalReceiptEndpoint, "/api/fiscal/receipt").slice(0, 120);
      printer.reprintEndpoint = normalizePosFiscalApiPath(entry.reprintEndpoint ?? entry.fiscalReprintEndpoint, "/api/fiscal/reprint").slice(0, 120);
      printer.voidEndpoint = normalizePosFiscalApiPath(entry.voidEndpoint ?? entry.fiscalVoidEndpoint, "/api/fiscal/void").slice(0, 120);
      printer.paymentMethodIds = normalizeReferenceIdList(entry.paymentMethodIds ?? entry.supportedPaymentMethodIds, null, 16);
      printer.supportsCash = entry.supportsCash === true;
      printer.supportsElectronic = entry.supportsElectronic === true;
      printer.supportsReprint = entry.supportsReprint === true;
    }
    return printer;
  }

  function sanitizePosFiscalDevice(entry, fallbackId = "fiscal_device") {
    if (!entry || typeof entry !== "object") return null;
    const id = normalizeConfigId(entry.id ?? entry.fiscalDeviceId ?? entry.rtId ?? entry.code, fallbackId);
    const name = String(entry.name ?? entry.label ?? id).trim().slice(0, 80);
    if (!id || !name) return null;
    const provider = String(entry.fiscalProvider ?? entry.provider ?? "pos-fiscal-api").trim().slice(0, 80) || "pos-fiscal-api";
    return {
      id,
      name,
      type: String(entry.type ?? entry.kind ?? "api").trim().slice(0, 40) || "api",
      fiscalProvider: provider,
      apiBaseUrl: String(entry.apiBaseUrl ?? entry.fiscalApiBaseUrl ?? "")
        .trim()
        .replace(/\/+$/, "")
        .slice(0, 180),
      statusEndpoint: normalizePosFiscalApiPath(
        entry.statusEndpoint ?? entry.fiscalStatusEndpoint,
        "/api/fiscal/status"
      ).slice(0, 120),
      verifyEndpoint: normalizePosFiscalApiPath(
        entry.verifyEndpoint ?? entry.fiscalVerifyEndpoint,
        "/api/fiscal/receipt/verify"
      ).slice(0, 120),
      receiptEndpoint: normalizePosFiscalApiPath(
        entry.receiptEndpoint ?? entry.fiscalReceiptEndpoint,
        "/api/fiscal/receipt"
      ).slice(0, 120),
      reprintEndpoint: normalizePosFiscalApiPath(
        entry.reprintEndpoint ?? entry.fiscalReprintEndpoint,
        "/api/fiscal/reprint"
      ).slice(0, 120),
      voidEndpoint: normalizePosFiscalApiPath(
        entry.voidEndpoint ?? entry.fiscalVoidEndpoint,
        "/api/fiscal/void"
      ).slice(0, 120),
      paymentMethodIds: normalizeReferenceIdList(
        entry.paymentMethodIds ?? entry.supportedPaymentMethodIds,
        null,
        16
      ),
      supportsCash: entry.supportsCash === true,
      supportsElectronic: entry.supportsElectronic === true,
      supportsReprint: entry.supportsReprint === true,
      description: String(entry.description ?? entry.notes ?? "").trim().slice(0, 180),
      active: entry.active !== false && entry.status !== "disabled",
    };
  }

  function resolveExplicitPrinterTarget(payload = {}) {
    const host = normalizePrinterHost(payload.printerHost ?? payload.host ?? payload.printerIp ?? payload.ip);
    if (!host) return null;
    const purpose = normalizePrinterPurpose(payload.printerPurpose);
    const name = String(payload.printerName ?? payload.printerLabel ?? host).trim().slice(0, 64) || host;
    return {
      printer: {
        id: normalizeConfigId(payload.printerId, ""),
        name,
        host,
        ip: host,
        port: normalizePrinterPort(payload.printerPort ?? payload.port),
        purpose,
        model: normalizePrinterModelId(payload.printerModel, purpose),
        description: "",
        active: true,
      },
      area: null,
      source: "explicit_host",
    };
  }

  return {
    normalizePrinterHost,
    normalizePrinterModelId,
    normalizePrinterPort,
    normalizePrinterPurpose,
    resolveExplicitPrinterTarget,
    sanitizePosFiscalDevice,
    sanitizePosPrinter,
  };
}
