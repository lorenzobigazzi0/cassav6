import test from "node:test";
import assert from "node:assert/strict";
import { createPrinterConfigHelpers } from "../printing/printer-config.domain.js";

const helpers = createPrinterConfigHelpers({
  defaultFiscalPrinterModel: "epson_tm_t800f_m261a",
  defaultNetworkPrinterPort: 9100,
  posPrinterModels: [
    { id: "generic_tcp" },
    { id: "epson_tm_t800f_m261a" },
  ],
  posPrinterPurposes: new Set(["generic", "production", "fiscal"]),
  normalizeConfigId: (value, fallback = "config") => {
    const normalized = String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);
    return normalized || fallback;
  },
  normalizeReferenceIdList: (value, _validIds = null, maxLength = 16) => {
    const source = Array.isArray(value) ? value : [];
    const seen = new Set();
    return source
      .map((entry) => String(entry ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_"))
      .filter((entry) => {
        if (!entry || seen.has(entry)) return false;
        seen.add(entry);
        return true;
      })
      .slice(0, maxLength);
  },
  normalizePosFiscalApiPath: (pathname, fallback = "/api/fiscal/reprint") => {
    const raw = String(pathname ?? "").trim() || fallback;
    return raw.startsWith("/") ? raw : `/${raw}`;
  },
});

test("printer config normalizza purpose, modello, porta e host", () => {
  assert.equal(helpers.normalizePrinterPurpose(" fiscal "), "fiscal");
  assert.equal(helpers.normalizePrinterPurpose("sconosciuto"), "generic");
  assert.equal(helpers.normalizePrinterModelId("GENERIC_TCP", "generic"), "generic_tcp");
  assert.equal(helpers.normalizePrinterModelId("missing", "fiscal"), "epson_tm_t800f_m261a");
  assert.equal(helpers.normalizePrinterModelId("missing", "generic"), "generic_tcp");
  assert.equal(helpers.normalizePrinterPort("9101"), 9101);
  assert.equal(helpers.normalizePrinterPort("0"), 9100);
  assert.equal(helpers.normalizePrinterPort("70000"), 9100);
  assert.equal(helpers.normalizePrinterHost(` ${"1".repeat(130)} `).length, 120);
});

test("printer config sanitizza stampante generica senza dati fiscali", () => {
  assert.deepEqual(
    helpers.sanitizePosPrinter(
      {
        id: " Printer Bar 1 ",
        name: " Preconti Bar ",
        host: " 192.168.1.50 ",
        port: "9102",
        purpose: "production",
        model: "generic_tcp",
        description: " ".repeat(2) + "Stampante ordini",
        active: true,
      },
      "fallback"
    ),
    {
      id: "printer_bar_1",
      name: "Preconti Bar",
      host: "192.168.1.50",
      ip: "192.168.1.50",
      port: 9102,
      purpose: "production",
      model: "generic_tcp",
      description: "Stampante ordini",
      active: true,
    }
  );
  assert.equal(helpers.sanitizePosPrinter({ name: "Senza host" }), null);
});

test("printer config sanitizza stampante fiscale con capability e endpoint", () => {
  const printer = helpers.sanitizePosPrinter({
    id: "RT BAR",
    name: "RT Bar",
    ip: "192.168.1.200",
    purpose: "fiscal",
    provider: "pos-fiscal-api",
    fiscalApiBaseUrl: "http://192.168.1.200:8765///",
    statusEndpoint: "api/fiscal/status",
    verifyEndpoint: "api/fiscal/receipt/verify",
    receiptEndpoint: "api/fiscal/receipt",
    reprintEndpoint: "api/fiscal/reprint",
    paymentMethodIds: ["pay_cash", "pay_card", "pay_card"],
    supportsCash: false,
    supportsElectronic: true,
    supportsReprint: false,
  });

  assert.equal(printer.id, "rt_bar");
  assert.equal(printer.purpose, "fiscal");
  assert.equal(printer.model, "epson_tm_t800f_m261a");
  assert.equal(printer.apiBaseUrl, "http://192.168.1.200:8765");
  assert.equal(printer.statusEndpoint, "/api/fiscal/status");
  assert.equal(printer.verifyEndpoint, "/api/fiscal/receipt/verify");
  assert.equal(printer.receiptEndpoint, "/api/fiscal/receipt");
  assert.equal(printer.reprintEndpoint, "/api/fiscal/reprint");
  assert.deepEqual(printer.paymentMethodIds, ["pay_cash", "pay_card"]);
  assert.equal(printer.supportsCash, false);
  assert.equal(printer.supportsElectronic, true);
  assert.equal(printer.supportsReprint, false);
});

test("printer config sanitizza RT fiscale con alias legacy", () => {
  assert.deepEqual(
    helpers.sanitizePosFiscalDevice(
      {
        rtId: "RT Bar",
        label: "Registratore Bar",
        kind: "api",
        fiscalApiBaseUrl: "http://192.168.1.200:8765/",
        fiscalStatusEndpoint: "api/fiscal/status",
        fiscalVerifyEndpoint: "api/fiscal/receipt/verify",
        fiscalReceiptEndpoint: "api/fiscal/receipt",
        fiscalReprintEndpoint: "api/fiscal/reprint",
        supportedPaymentMethodIds: ["pay_card"],
        supportsCash: false,
        status: "disabled",
        notes: "RT principale",
      },
      "fallback"
    ),
    {
      id: "rt_bar",
      name: "Registratore Bar",
      type: "api",
      fiscalProvider: "pos-fiscal-api",
      apiBaseUrl: "http://192.168.1.200:8765",
      statusEndpoint: "/api/fiscal/status",
      verifyEndpoint: "/api/fiscal/receipt/verify",
      receiptEndpoint: "/api/fiscal/receipt",
      reprintEndpoint: "/api/fiscal/reprint",
      voidEndpoint: "/api/fiscal/void",
      paymentMethodIds: ["pay_card"],
      supportsCash: false,
      supportsElectronic: false,
      supportsReprint: false,
      description: "RT principale",
      active: false,
    }
  );
  assert.deepEqual(helpers.sanitizePosFiscalDevice({ id: "rt_minima" })?.paymentMethodIds, []);
  assert.equal(helpers.sanitizePosFiscalDevice({ id: "rt_minima" })?.supportsCash, false);
  assert.equal(helpers.sanitizePosFiscalDevice({ id: "rt_minima" })?.supportsElectronic, false);
  assert.equal(helpers.sanitizePosFiscalDevice({ id: "rt_minima" })?.supportsReprint, false);
});

test("printer config risolve target esplicito da payload senza inventare host", () => {
  assert.equal(helpers.resolveExplicitPrinterTarget({}), null);
  assert.deepEqual(helpers.resolveExplicitPrinterTarget({
    printerId: "Direct Print",
    printerName: "Diretta",
    printerIp: "10.0.0.5",
    printerPort: "9103",
    printerPurpose: "fiscal",
  }), {
    printer: {
      id: "direct_print",
      name: "Diretta",
      host: "10.0.0.5",
      ip: "10.0.0.5",
      port: 9103,
      purpose: "fiscal",
      model: "epson_tm_t800f_m261a",
      description: "",
      active: true,
    },
    area: null,
    source: "explicit_host",
  });
});
