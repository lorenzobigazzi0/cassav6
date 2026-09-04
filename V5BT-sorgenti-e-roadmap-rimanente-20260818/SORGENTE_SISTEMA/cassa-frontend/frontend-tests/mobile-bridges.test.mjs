import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { projectRoot } from "./helpers/bridge-env.mjs";

const readSource = (relativePath) => fs.readFile(path.join(projectRoot, relativePath), "utf8");

const assertContains = (source, needles, label) => {
  for (const needle of needles) {
    assert.ok(
      source.includes(needle),
      `${label} deve contenere: ${needle}`
    );
  }
};

test("[FE][BRIDGE->NATIVE] i bridge mobile v1 restano archiviati ma non iniettati nel runtime", async () => {
  const viteConfig = await readSource("mobile-frontend/vite.config.ts");
  const migrationTest = await readSource("mobile-frontend/tests/static/v1BridgeNativeMigration.test.ts");

  assert.match(viteConfig, /const mobileLegacyBridgeScripts:\s*string\[\]\s*=\s*\[\]/);
  assert.match(viteConfig, /\/\^mobile-\.\*\\\.js\$\/i\.test\(entry\)/);
  assert.match(migrationTest, /mobile-backend-connection-bridge\.js/);
  assert.match(migrationTest, /mobile-order-service-recovery-bridge\.js/);
  assert.match(migrationTest, /mobile-payments-settlement-bridge\.js/);
  assert.match(migrationTest, /src\/pages\/home\/tables\/components\/TablePaymentWizard\.tsx/);
});

test("[FE][BRIDGE->NATIVE] connessione backend mobile coperta da apiClient nativo senza bridge fetch", async () => {
  const apiClient = await readSource("mobile-frontend/src/shared/api/apiClient.ts");
  const viteConfig = await readSource("mobile-frontend/vite.config.ts");

  assertContains(
    apiClient,
    [
      "export function buildApiUrl",
      "export function buildSseUrl",
      "const RETRYABLE_STATUSES = new Set([502, 503, 504])",
      "return isIdempotentMethod(init) ? 1 : 0",
      "return method === \"GET\" || method === \"HEAD\"",
    ],
    "apiClient"
  );
  assert.match(viteConfig, /VITE_API_PROXY_TARGET/);
  assert.doesNotMatch(apiClient, /192\.168\.1\.166/);
});

test("[FE][BRIDGE->NATIVE] avviso nessuna postazione attiva e native order composer sostituiscono station guard", async () => {
  const composer = await readSource("mobile-frontend/src/pages/home/tables/components/TableOrderComposer.tsx");
  const stationsApi = await readSource("mobile-frontend/src/api/stations.ts");
  const staticTest = await readSource("mobile-frontend/tests/static/stationAvailabilityModal.test.ts");

  assertContains(
    composer,
    [
      "import { fetchActiveStationCount }",
      "const [stationWarningVisible, setStationWarningVisible]",
      "const stationWarningAckedRef = useRef(false)",
      "const previousNoActiveStationsRef = useRef(false)",
      "nessuna postazione attiva, gli ordini andranno in coda",
      "{noActiveStations && stationWarningVisible && (",
    ],
    "TableOrderComposer"
  );
  assert.match(stationsApi, /\/api\/integration\/stations\/active/);
  assert.match(staticTest, /mobile-no-active-stations-backdrop/);
});

test("[FE][BRIDGE->NATIVE] sessione pagamenti persistente dopo logout/login e scarico coperti dal runtime React", async () => {
  const runtimeHook = await readSource("mobile-frontend/src/app/runtime/usePaymentSessionRuntime.ts");
  const runtime = await readSource("mobile-frontend/src/utils/paymentSessionRuntime.ts");
  const settlement = await readSource("mobile-frontend/src/pages/payments/PaymentSettlementSection.tsx");
  const nativeTest = await readSource("mobile-frontend/tests/nativeBridgeFunctionality.test.tsx");

  assert.match(runtimeHook, /installMobilePaymentSessionRuntime\(\)/);
  assert.match(runtime, /mobile_payment_runtime_v1/);
  assert.match(settlement, /mobile:payments:settlement-completed/);
  assert.match(settlement, /clearMobilePaymentRuntime\("settlement-completed"\)/);
  assert.match(nativeTest, /mantiene il turno statistiche da runtime dopo logout\/login/);
});

test("[FE][BRIDGE->NATIVE] statistiche pagamenti ricostruiscono pagamenti, storni, sostituzioni e ristampa", async () => {
  const analyticsApi = await readSource("mobile-frontend/src/api/analyticsPaymentMovements.ts");
  const analyticsPage = await readSource("mobile-frontend/src/pages/home/analytics/AnalyticsWorkspace.tsx");
  const nativeTest = await readSource("mobile-frontend/tests/nativeBridgeFunctionality.test.tsx");

  assertContains(
    analyticsApi,
    [
      "export type AnalyticsMovementType = \"payment\" | \"storno\" | \"replacement\"",
      "const REPRINT_PATH = \"/api/reports/payment-movement/reprint\"",
      "export const resolveAnalyticsSessionContext",
      "export const buildAnalyticsMovementRecords",
      "export async function printAnalyticsPaymentMovement",
    ],
    "analyticsPaymentMovements"
  );
  assert.match(analyticsPage, /printAnalyticsPaymentMovement\(session, selectedRecord/);
  assert.match(nativeTest, /ricostruisce i movimenti statistiche includendo pagamenti, storni e sostituzioni/);
  assert.match(nativeTest, /ristampa un pagamento\/storno tramite endpoint di ristampa senza riemettere fiscale/);
});

test("[FE][BRIDGE->NATIVE] scarico pagamenti avvisa se ci sono tavoli ancora da riscuotere", async () => {
  const settlement = await readSource("mobile-frontend/src/pages/payments/PaymentSettlementSection.tsx");

  assertContains(
    settlement,
    [
      "Tavoli da riscuotere",
      "Tavoli con conto aperto",
      "pendingTables",
      "/api/integration/layout",
      "modal.phase === \"pending-warning\"",
    ],
    "PaymentSettlementSection"
  );
});

test("[FE][BRIDGE->NATIVE] modifica/reso comanda sono nativi e basati sulla comanda selezionata", async () => {
  const detail = await readSource("mobile-frontend/src/pages/home/tables/components/TableDetailPanel.tsx");
  const recoveryDialog = await readSource("mobile-frontend/src/pages/home/tables/components/TableServiceRecoveryDialog.tsx");
  const recoveryChoice = await readSource("mobile-frontend/src/pages/home/tables/components/TableServiceRecoveryChoice.tsx");
  const nativeTest = await readSource("mobile-frontend/tests/nativeBridgeFunctionality.test.tsx");
  const staticVisualTest = await readSource("mobile-frontend/tests/static/serviceRecoveryModalVisual.test.ts");

  assertContains(
    detail,
    [
      "export const canShowServiceRecoveryCorrection",
      "export const canShowServiceRecoveryReplacement",
      "data-msr-native-action",
      "data-msr-order-id={order.id}",
      "selectedHistoryOrderId",
    ],
    "TableDetailPanel"
  );
  assertContains(
    recoveryDialog,
    [
      "Gestisci comanda",
      "Modifica comanda",
      "Reso",
      "SOSTITUZIONE",
    ],
    "TableServiceRecoveryDialog"
  );
  assertContains(
    recoveryChoice,
    ["Annulla comanda", "Conferma annullamento", "Motivo annullamento", "Conferma annulla"],
    "TableServiceRecoveryChoice"
  );
  assert.match(nativeTest, /mostra Modifica per comande non pagate e Reso appena la comanda e nello storico/);
  assert.match(staticVisualTest, /Modifica comanda/);
});

test("[FE][BRIDGE->NATIVE] identita righe reso/modifica protetta da lineId e fallback grafico stabile", async () => {
  const serviceApi = await readSource("mobile-frontend/src/api/orderServiceRecovery.ts");
  const serviceTest = await readSource("mobile-frontend/tests/orderServiceRecovery.test.ts");

  assert.match(serviceApi, /export function lineKeyForOrderService/);
  assert.match(serviceTest, /mantiene il lineId backend come identita primaria/);
  assert.match(serviceTest, /non collassa righe diverse dello stesso prodotto/);
  assert.match(serviceTest, /distingue varianti e note nel fallback grafico/);
});

test("[FE][BRIDGE->NATIVE] storico ordini, PAGA e stampe storico restano nel componente React", async () => {
  const detail = await readSource("mobile-frontend/src/pages/home/tables/components/TableDetailPanel.tsx");
  const historySyncTest = await readSource("mobile-frontend/tests/static/tableHistorySync.test.ts");
  const printButtonsTest = await readSource("mobile-frontend/tests/static/serviceRecoveryAndFiscalFlows.test.ts");

  assertContains(
    detail,
    [
      "historyOpen",
      "selectedHistoryOrderId",
      "table-history-pay-action",
      "setPaymentTarget({ amount: payableAmount, orderId: order.id });",
      "requestHistoryPrint(orderId, kind)",
    ],
    "TableDetailPanel"
  );
  assert.match(historySyncTest, /numero comanda nello storico/);
  assert.match(printButtonsTest, /printAnalyticsPaymentMovement/);
});

test("[FE][BRIDGE->NATIVE] blocco per articolo e quote alla romana sono funzionalita della payment wizard", async () => {
  const wizard = await readSource("mobile-frontend/src/pages/home/tables/components/TablePaymentWizard.tsx");
  const lockStorage = await readSource("mobile-frontend/src/pages/home/tables/payment/articleSplitLockStorage.ts");
  const tablesApi = await readSource("mobile-frontend/src/api/tables.ts");
  const nativeTest = await readSource("mobile-frontend/tests/nativeBridgeFunctionality.test.tsx");

  assertContains(
    wizard,
    [
      "paymentArticleSplitLocked",
      "romanSharesToPay",
      "Quote da pagare ora:",
      "Pagamento per articolo non disponibile",
      "writeArticleSplitLock(table.id, targetOrderId)",
    ],
    "TablePaymentWizard"
  );
  assertContains(
    lockStorage,
    ["ARTICLE_SPLIT_LOCK_PREFIX", "readArticleSplitLock", "writeArticleSplitLock"],
    "articleSplitLockStorage"
  );
  assert.match(tablesApi, /romanSharesPaid/);
  assert.match(tablesApi, /paymentArticleSplitLocked/);
  assert.match(nativeTest, /paga due quote alla romana/);
  assert.match(nativeTest, /blocca il pagamento per articolo/);
});

test("[FE][BRIDGE->NATIVE] varianti obbligatorie drink premium e dropdown custom non dipendono piu dal bridge", async () => {
  const composer = await readSource("mobile-frontend/src/pages/home/tables/components/TableOrderComposer.tsx");
  const premiumTest = await readSource("mobile-frontend/tests/static/premiumDrinkVariantModal.test.ts");

  assertContains(
    composer,
    [
      "const productRequiresVariantSelection",
      "category.includes(\"premium\")",
      "openProductQuickAdd(productId)",
      "Variante obbligatoria per Drink Premium",
      "GlassDropdown",
    ],
    "TableOrderComposer"
  );
  assert.match(premiumTest, /mantiene i flag backend e apre la modale obbligatoria/);
});

test("[FE][BRIDGE->NATIVE] pulsante Libera e protezione anti flash sono nel codice nativo", async () => {
  const detail = await readSource("mobile-frontend/src/pages/home/tables/components/TableDetailPanel.tsx");
  const tableFreeTest = await readSource("mobile-frontend/tests/static/tableFreeAction.test.ts");

  assert.match(detail, /const canFree = Boolean\(table && !isFree && table\.ordersInProgress <= 0 && table\.amountDue <= 0\)/);
  assert.match(detail, /const showFreeAction = canFree;/);
  assert.match(tableFreeTest, /mostra Libera anche per tavoli occupati senza ordini e prenotati/);
  assert.match(tableFreeTest, /l'API mobile libera anche una prenotazione/);
});
