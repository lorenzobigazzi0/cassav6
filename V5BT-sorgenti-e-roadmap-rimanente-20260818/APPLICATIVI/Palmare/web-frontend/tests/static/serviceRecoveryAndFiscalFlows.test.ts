import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");
const backendRootCandidates = [
  resolve(repoRoot, "../cassa-frontend/backend"),
  resolve(repoRoot, "../../../SORGENTE_SISTEMA/cassa-frontend/backend"),
  resolve(repoRoot, "../../../sistema-cassa-v4.6-source/cassa-frontend/backend"),
];
const backendRoot =
  backendRootCandidates.find((candidate) => existsSync(candidate)) ?? backendRootCandidates[0];
const readBackendSource = (relativePath: string) =>
  readFileSync(resolve(backendRoot, relativePath), "utf8");

describe("mobile service recovery and fiscal print flows", () => {
  it("mantiene native le azioni Modifica e Reso nel dettaglio comanda", () => {
    const detailPanel = readSource("src/pages/home/tables/components/TableDetailPanel.tsx");
    const recoveryDialog = readSource(
      "src/pages/home/tables/components/TableServiceRecoveryDialog.tsx"
    );
    const legacyAbbuonoBridge = readSource(
      "legacy-mobile-assets/assets/mobile-order-history-abbuono-bridge.js"
    );
    const legacyRecoveryBridge = readSource(
      "legacy-mobile-assets/assets/mobile-order-service-recovery-bridge.js"
    );

    expect(detailPanel).toContain('action === "correction" ? "Modifica" : "Reso"');
    expect(detailPanel).toContain("canShowServiceRecoveryCorrection(order)");
    expect(detailPanel).toContain("canShowServiceRecoveryReplacement(order)");
    expect(recoveryDialog).toContain('action === "replacement"');
    expect(recoveryDialog).toContain('? "Reso"');
    expect(recoveryDialog).toContain('"Gestisci comanda"');
    expect(recoveryDialog).toContain("submitOrderCorrection");
    expect(recoveryDialog).toContain("submitOrderReplacement");
    expect(recoveryDialog).toContain("RESO");
    expect(recoveryDialog).toContain("SOSTITUZIONE");
    expect(
      `${detailPanel}\n${recoveryDialog}\n${legacyAbbuonoBridge}\n${legacyRecoveryBridge}`
    ).not.toContain("Reso bar");
    expect(
      `${detailPanel}\n${recoveryDialog}\n${legacyAbbuonoBridge}\n${legacyRecoveryBridge}`
    ).not.toContain("Reso a carico bar");
  });

  it("il reso rosso senza sostituzione scala la comanda esistente tramite correzione righe", () => {
    const serviceRecoveryApi = readSource("src/api/orderServiceRecovery.ts");

    expect(serviceRecoveryApi).toContain("if (!payload.sendReplacement && !orderAlreadyPaid)");
    expect(serviceRecoveryApi).toContain("ORDER_SERVICE_CORRECTION_LOCK_PURPOSE");
    expect(serviceRecoveryApi).toContain(
      'postJson(context.session, "/api/integration/orders/correct"'
    );
    expect(serviceRecoveryApi).toContain("removedItems");
    expect(serviceRecoveryApi).toContain('idempotencyKey("return_without_replacement"');
    expect(serviceRecoveryApi).toContain('"/api/integration/orders/storno"');
  });

  it("ristampa il documento fiscale corretto, incluso quello di annullamento, senza riemissione", () => {
    const analyticsApi = readSource("src/api/analyticsPaymentMovements.ts");
    const analyticsModel = readSource("src/api/analyticsPaymentMovementModel.ts");
    const analyticsWorkspace = readSource("src/pages/home/analytics/AnalyticsWorkspace.tsx");
    const backendServer = readBackendSource("server.js");
    const paymentHandlers = readBackendSource("modules/payments/payments.handlers.js");
    const fiscalReprintDomain = readBackendSource(
      "modules/payments/fiscal-reprint-reference.domain.js"
    );

    expect(analyticsApi).toContain('const REPRINT_PATH = "/api/reports/payment-movement/reprint"');
    expect(analyticsApi).toContain("canPrintAnalyticsMovement");
    expect(analyticsModel).toContain('record?.type === "payment" || record?.type === "storno"');
    expect(analyticsApi).toContain("printAnalyticsPaymentMovement");
    expect(analyticsWorkspace).toContain("handlePrint");
    expect(paymentHandlers).toContain("handlePaymentMovementReprint");
    expect(paymentHandlers).toContain("FISCAL_VOID_REPRINT_REFERENCE_MISSING");
    expect(backendServer).toContain("buildPosFiscalReprintPayload");
    expect(backendServer).toContain("resolveFiscalReprintTarget");
    expect(fiscalReprintDomain).toContain("voidMovementId");
    expect(fiscalReprintDomain).toContain('documentKind === "void"');
    expect(fiscalReprintDomain).toContain("? receipt.voidMovementId");
    expect(backendServer.includes('POS_FISCAL_API_REPRINT_ENDPOINT ?? "/api/fiscal/reprint"')).toBe(
      true
    );
    expect(backendServer.includes("issueQueuedPosFiscalReprint")).toBe(true);
    expect(backendServer.includes("fetchPosFiscalApiJson(endpoint")).toBe(true);
    expect(
      backendServer.includes(
        'fetchPosFiscalApiJson("/api/fiscal/receipt", {\\n    method: "POST",\\n    body: JSON.stringify(buildPosFiscalReprintPayload'
      )
    ).toBe(false);
  });

  it("aggiorna il tavolo pagato da snapshot senza rilettura tabelle immediata", () => {
    const tablesWorkspace = readSource("src/pages/home/tables/TablesWorkspace.tsx");
    const tablesApi = readSource("src/api/tables.ts");

    expect(tablesWorkspace).toContain("skipRefresh?: boolean");
    expect(tablesWorkspace).toContain("if (!options.skipRefresh)");
    expect(tablesWorkspace).toContain("{ rethrow: true, skipRefresh: true }");
    expect(tablesWorkspace).toContain("payDiningTable({");
    expect(tablesApi).toContain("mergeBackendPaymentTableSnapshot");
    expect(tablesApi).toContain("backendPayment?.table");
    expect(tablesApi).toContain("upsertRoomTable(params.roomId, backendTable)");
    expect(tablesApi).toMatch(
      /const backendTable = mergeBackendPaymentTableSnapshot[\s\S]*if \(backendTable\) \{[\s\S]*upsertRoomTable\(params\.roomId, backendTable\);[\s\S]*\} else \{[\s\S]*await syncTableLayoutToIntegration\(params, updatedTable\);/
    );
  });
});
