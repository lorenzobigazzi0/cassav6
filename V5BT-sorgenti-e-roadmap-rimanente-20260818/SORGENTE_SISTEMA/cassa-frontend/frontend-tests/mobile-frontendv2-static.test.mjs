import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cassaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(cassaRoot, "..");
const mobileDistDir = path.join(projectRoot, "mobile-frontend", "dist");
const mobileSrcDir = path.join(projectRoot, "mobile-frontend", "src");

function cleanReference(value) {
  return String(value ?? "").split("#")[0].split("?")[0];
}

function resolveMobileDistReference(reference) {
  const clean = cleanReference(reference);
  if (clean.startsWith("/mobile/")) return path.join(mobileDistDir, clean.slice("/mobile/".length));
  return path.join(mobileDistDir, clean.replace(/^\/+/, ""));
}

test("[FE][FRONTENDV2] mobile dist usa base /mobile e runtime config same-origin", async () => {
  const html = await fs.readFile(path.join(mobileDistDir, "index.html"), "utf8");
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /src="\/mobile\/assets\/index-[^"]+\.js"/);
  assert.match(html, /href="\/mobile\/assets\/index-[^"]+\.css"/);

  const config = JSON.parse(await fs.readFile(path.join(mobileDistDir, "config.json"), "utf8"));
  assert.equal(config.apiBaseUrl, "/api");
  assert.equal(config.sseBaseUrl, "/api");
  assert.equal(config.defaultOrderStation, "BAR PRINCIPALE");
});

test("[FE][FRONTENDV2] asset referenziati da mobile/dist esistono", async () => {
  const html = await fs.readFile(path.join(mobileDistDir, "index.html"), "utf8");
  const references = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)]
    .map((match) => cleanReference(match[1]))
    .filter((value) => value && !/^(?:https?:|data:|mailto:|#)/i.test(value));

  assert.ok(references.length > 0, "index.html deve referenziare asset statici");
  for (const reference of references) {
    const filePath = resolveMobileDistReference(reference);
    assert.ok(filePath.startsWith(mobileDistDir), `${reference} deve restare dentro mobile/dist`);
    const stat = await fs.stat(filePath);
    assert.equal(stat.isFile(), true, `${reference} deve esistere`);
  }
});

test("[FE][FRONTENDV2] il bundle mobile non reinstalla i bridge legacy rimossi", async () => {
  const html = await fs.readFile(path.join(mobileDistDir, "index.html"), "utf8");
  const scriptMatch = html.match(/src="(\/mobile\/assets\/index-[^"]+\.js)"/);
  assert.ok(scriptMatch, "bundle JS principale non trovato");
  const source = await fs.readFile(resolveMobileDistReference(scriptMatch[1]), "utf8");

  assert.equal(source.includes("mobile-backend-connection-bridge"), false);
  assert.equal(source.includes("frontend-hot-fetch-cache"), false);
  assert.equal(source.includes("window.fetch ="), false);
  assert.match(source, /\/api\/auth\/login/);
});

test("[FE][FRONTENDV2] mobile dist incassa tramite il dominio pagamenti backend", async () => {
  const assetsDir = path.join(mobileDistDir, "assets");
  const assetNames = await fs.readdir(assetsDir);
  const scriptNames = assetNames.filter((name) => name.endsWith(".js"));
  assert.ok(scriptNames.length > 0, "bundle JS mobile non trovato");
  const sources = await Promise.all(
    scriptNames.map((name) => fs.readFile(path.join(assetsDir, name), "utf8"))
  );
  const source = sources.join("\n");

  assert.match(source, /\/api\/payments\/free-split/);
  assert.match(source, /FREE_SPLIT/);
  assert.match(source, /pay_cash/);
  assert.match(source, /pay_card/);
  assert.match(source, /mobile-pos/);
});


test("[FE][FRONTENDV2][P1] mobile settings non contiene fallback statici di sale", async () => {
  const assetsDir = path.join(mobileDistDir, "assets");
  const assetNames = await fs.readdir(assetsDir);
  const settingsScript = assetNames.find((name) => /^SettingsPage-.*\.js$/.test(name));
  assert.ok(settingsScript, "chunk SettingsPage non trovato");
  const settingsSource = await fs.readFile(path.join(assetsDir, settingsScript), "utf8");
  const allSources = (
    await Promise.all(
      assetNames
        .filter((name) => name.endsWith(".js"))
        .map((name) => fs.readFile(path.join(assetsDir, name), "utf8"))
    )
  ).join("\n");

  assert.equal(settingsSource.includes("Sala Principale"), false);
  assert.equal(settingsSource.includes("sala_terrazza"), false);
  assert.match(allSources, /\/api\/pos\/rooms/);
  assert.match(allSources, /\/api\/integration\/layout/);
});

test("[FE][FRONTENDV2][P1] mobile batteria usa la sorgente locale nativa senza polling backend", async () => {
  const assetsDir = path.join(mobileDistDir, "assets");
  const assetNames = await fs.readdir(assetsDir);
  const scriptSource = (
    await Promise.all(
    assetNames
      .filter((name) => name.endsWith(".js"))
      .map((name) => fs.readFile(path.join(assetsDir, name), "utf8"))
    )
  ).join("\n");
  const batteryService = await fs.readFile(
    path.join(mobileSrcDir, "app", "runtime", "batteryStatusService.ts"),
    "utf8",
  );

  assert.match(batteryService, /window\.AmaliaNativeBattery\?\.getSnapshot\?\.\(\)/);
  assert.match(batteryService, /NATIVE_BATTERY_EVENT = "amalia:native-battery"/);
  assert.match(batteryService, /subscribeBrowserBatteryState/);
  assert.doesNotMatch(batteryService, /\/api\/mobile\/battery/);
  assert.match(scriptSource, /AmaliaNativeBattery/);
  assert.match(scriptSource, /amalia:native-battery/);
  assert.doesNotMatch(scriptSource, /\/api\/mobile\/battery/);
});

test("[FE][FRONTENDV2] fallback tavoli mobile non genera ordini o prenotazioni demo", async () => {
  const source = await fs.readFile(path.join(mobileSrcDir, "api", "tables.ts"), "utf8");

  assert.equal(source.includes("makeInitialOrderHistory"), false);
  assert.equal(source.includes("MOCK_TABLE_NAMES"), false);
  assert.equal(source.includes("Composizione ordine"), false);
  assert.equal(source.includes("Allergia segnalata: verificare note cliente."), false);
});

test("[FE][FRONTENDV2] cambio sala riallinea anche activityId e activityName", async () => {
  const tablesSource = await fs.readFile(
    path.join(mobileSrcDir, "pages", "home", "tables", "TablesWorkspace.tsx"),
    "utf8"
  );
  const settingsSource = await fs.readFile(path.join(mobileSrcDir, "pages", "SettingsPage.tsx"), "utf8");

  assert.match(tablesSource, /nextActivityId\s*=.*currentRoom\.activityId/s);
  assert.match(tablesSource, /nextActivityName\s*=.*currentRoom\.activityName/s);
  assert.match(tablesSource, /nextActivityId\s*!==\s*\(activityId\s*\|\|\s*""\)/);
  assert.match(tablesSource, /nextActivityName\s*!==\s*\(activityName\s*\|\|\s*""\)/);

  assert.match(settingsSource, /selectedActivityId\s*=.*selected\.activityId/s);
  assert.match(settingsSource, /selectedActivityName\s*=.*selected\.activityName/s);
  assert.match(settingsSource, /selectedActivityId\s*!==\s*\(activityId\s*\|\|\s*""\)/);
  assert.match(settingsSource, /selectedActivityName\s*!==\s*\(activityName\s*\|\|\s*""\)/);
});

test("[FE][FRONTENDV2][P0] invio comanda preserva bozza finche il backend conferma", async () => {
  const composerSource = await fs.readFile(
    path.join(
      mobileSrcDir,
      "pages",
      "home",
      "tables",
      "components",
      "TableOrderComposer.tsx"
    ),
    "utf8"
  );
  const detailSource = await fs.readFile(
    path.join(
      mobileSrcDir,
      "pages",
      "home",
      "tables",
      "components",
      "TableDetailPanel.tsx"
    ),
    "utf8"
  );
  const workspaceSource = await fs.readFile(
    path.join(mobileSrcDir, "pages", "home", "tables", "TablesWorkspace.tsx"),
    "utf8"
  );

  assert.match(
    composerSource,
    /onSubmit:\s*\(payload:\s*TableOrderSubmitPayload\)\s*=>\s*Promise<void>/,
  );
  assert.match(composerSource, /const submitOrder = async \(\) =>/);
  const submitOrderStart = composerSource.indexOf("const submitOrder = async () =>");
  const submitOrderEnd = composerSource.indexOf("const submitLongPress", submitOrderStart);
  assert.notEqual(submitOrderStart, -1, "il flusso submitOrder deve esistere");
  assert.notEqual(submitOrderEnd, -1, "il confine del flusso submitOrder deve esistere");
  const submitOrderSource = composerSource.slice(submitOrderStart, submitOrderEnd);
  assert.match(submitOrderSource, /const payload = buildSubmitPayload\(\);/);
  const awaitSubmitIndex = submitOrderSource.indexOf("await onSubmit(payload)");
  const clearDraftIndex = submitOrderSource.indexOf("setDraft([])", awaitSubmitIndex);
  assert.notEqual(awaitSubmitIndex, -1, "il composer deve attendere onSubmit");
  assert.notEqual(clearDraftIndex, -1, "il composer deve svuotare la bozza solo nel ramo di successo");
  assert.ok(clearDraftIndex > awaitSubmitIndex, "setDraft([]) deve avvenire dopo await onSubmit");
  assert.match(submitOrderSource, /catch\s*\{[\s\S]*preserviamo la bozza/);

  assert.match(detailSource, /onSubmit=\{async \(payload\) => \{\s*await onSubmitOrder\(payload\);\s*onToggleOrderComposer\(false\);/);
  assert.match(
    workspaceSource,
    /lockPurpose:\s*ORDER_CREATE_LOCK_PURPOSE,\s*offlineContinuation:\s*true,\s*rethrow:\s*true/,
  );
});

test("[FE][FRONTENDV2][P1] restore tavoli non riapre modali transazionali", async () => {
  const workspaceSource = await fs.readFile(
    path.join(mobileSrcDir, "pages", "home", "tables", "TablesWorkspace.tsx"),
    "utf8"
  );

  assert.equal(workspaceSource.includes("parsed.movePickerOpen"), false);
  assert.equal(workspaceSource.includes("parsed.orderComposerOpen"), false);
  assert.equal(workspaceSource.includes("parsed.paymentWizardOpen"), false);

  const payloadStart = workspaceSource.indexOf("const payload: TablesWorkspaceUiSnapshot = {");
  const payloadEnd = workspaceSource.indexOf("};", payloadStart);
  assert.notEqual(payloadStart, -1, "snapshot UI tavoli non trovato");
  assert.notEqual(payloadEnd, -1, "fine snapshot UI tavoli non trovata");

  const persistedPayload = workspaceSource.slice(payloadStart, payloadEnd);
  assert.equal(persistedPayload.includes("movePickerOpen"), false);
  assert.equal(persistedPayload.includes("orderComposerOpen"), false);
  assert.equal(persistedPayload.includes("paymentWizardOpen"), false);
});

test("[FE][FRONTENDV2][P1] filtro rapido home tavoli resta transitorio e disattivabile", async () => {
  const homePageSource = await fs.readFile(path.join(mobileSrcDir, "pages", "HomePage.tsx"), "utf8");
  const workspaceSource = await fs.readFile(
    path.join(mobileSrcDir, "pages", "home", "tables", "TablesWorkspace.tsx"),
    "utf8"
  );
  const glassCss = await fs.readFile(path.join(mobileSrcDir, "styles", "glass.css"), "utf8");
  const tablesCss = await fs.readFile(path.join(mobileSrcDir, "styles", "tables.css"), "utf8");
  const dashboardOverrideCss = await fs.readFile(
    path.join(projectRoot, "mobile-frontend", "legacy-mobile-assets", "assets", "mobile-home-dashboard-overrides.css"),
    "utf8"
  );

  assert.match(
    homePageSource,
    /if \(nextTab !== "tavoli" \|\| options\.keepDashboardQuickFilter !== true\) \{[\s\S]*setTablesQuickFilter\(null\);/
  );
  assert.match(workspaceSource, /dashboardQuickFilterActiveRef = useRef\(false\)/);
  assert.match(workspaceSource, /dashboardQuickFilterPreviousModeRef = useRef<TableFilterMode \| null>\(null\)/);
  assert.match(
    workspaceSource,
    /activeLegendFilter: dashboardQuickFilterActiveRef\.current \? null : activeLegendFilter/
  );
  assert.match(workspaceSource, /setLegendFilterModeState\(previousMode\)/);

  for (const token of [
    "--table-filter-free-bg",
    "--table-filter-occupied-bg",
    "--table-filter-ordering-bg",
    "--table-filter-payment-bg",
  ]) {
    assert.match(glassCss, new RegExp(token));
    assert.match(tablesCss, new RegExp(`background: var\\(${token}\\)`));
    assert.match(dashboardOverrideCss, new RegExp(`background: var\\(${token}\\) !important`));
  }
});

test("[FE][FRONTENDV2][P1] chiusura dettaglio tavolo chiude i flow figli", async () => {
  const workspaceSource = await fs.readFile(
    path.join(mobileSrcDir, "pages", "home", "tables", "TablesWorkspace.tsx"),
    "utf8"
  );

  assert.match(workspaceSource, /const closeTableChildFlows = useCallback\(\(\) => \{/);
  assert.match(workspaceSource, /setMovePickerOpen\(false\);/);
  assert.match(workspaceSource, /setOrderComposerOpen\(false\);/);
  assert.match(workspaceSource, /setPaymentWizardOpen\(false\);/);
  assert.match(workspaceSource, /setMoveConfirm\(null\);/);
  assert.match(workspaceSource, /setMergeConfirm\(null\);/);
  assert.match(workspaceSource, /setTableGroupsDialog\(null\);/);
  assert.match(workspaceSource, /setServiceRecoveryDialog\(null\);/);

  assert.match(
    workspaceSource,
    /const closeTableDetail = useCallback\(\(\) => \{[\s\S]*setSelectedTableId\(null\);[\s\S]*setSelectedTableSnapshot\(null\);[\s\S]*closeTableChildFlows\(\);/
  );
  assert.match(workspaceSource, /onClose=\{\(\) => \{\s*closeTableDetail\(\);/);
  assert.match(
    workspaceSource,
    /if \(!selectedTableId\) \{[\s\S]*selectedTableMissingSinceRef\.current = null;[\s\S]*closeTableChildFlows\(\);[\s\S]*\}\s*\}, \[closeTableChildFlows, selectedTableId\]\);/
  );
});

test("[FE][FRONTENDV2][P1] form dettaglio tavolo si riallinea su snapshot dati", async () => {
  const workspaceSource = await fs.readFile(
    path.join(mobileSrcDir, "pages", "home", "tables", "TablesWorkspace.tsx"),
    "utf8"
  );

  assert.match(workspaceSource, /const buildTableFormSyncKey = \(table: DiningTable \| null\) => \{/);
  for (const field of [
    "occupancyState",
    "tableName",
    "customerPhone",
    "covers",
    "note",
    "allergens",
    "manualIntolerance",
    "reservationAt",
  ]) {
    assert.match(workspaceSource, new RegExp(`${field}: table\\.${field}`));
  }
  assert.match(workspaceSource, /const detailTableFormSyncKey = useMemo\(/);
  assert.match(workspaceSource, /\}, \[detailTableFormSyncKey\]\);/);
  assert.equal(
    workspaceSource.includes("}, [detailTable?.id]);"),
    false,
    "il form non deve dipendere solo dall'id tavolo"
  );
});

test("[FE][FRONTENDV2][P1] comanda tavolo non usa fallback catalogo generico", async () => {
  const workspaceSource = await fs.readFile(
    path.join(mobileSrcDir, "pages", "home", "tables", "TablesWorkspace.tsx"),
    "utf8"
  );
  const detailSource = await fs.readFile(
    path.join(
      mobileSrcDir,
      "pages",
      "home",
      "tables",
      "components",
      "TableDetailPanel.tsx"
    ),
    "utf8"
  );

  assert.equal(
    /import \{[^}]*\bfetchMenuCatalog\b[^}]*\}/.test(workspaceSource),
    false,
    "TablesWorkspace non deve importare il catalogo generico per il composer tavolo"
  );
  assert.equal(workspaceSource.includes("return fetchMenuCatalog();"), false);

  const queryStart = workspaceSource.indexOf("const menuCatalogQuery = useQuery({");
  const queryEnd = workspaceSource.indexOf("useTimedPricingRefresh({", queryStart);
  assert.notEqual(queryStart, -1, "query catalogo tavoli non trovata");
  assert.notEqual(queryEnd, -1, "fine query catalogo tavoli non trovata");
  const querySource = workspaceSource.slice(queryStart, queryEnd);
  assert.match(querySource, /fetchMenuCatalogForSession/);
  assert.equal(querySource.includes("catch"), false, "il catalogo tavoli non deve fare fallback catch");

  assert.match(workspaceSource, /menuCatalogLoading=\{menuCatalogQuery\.isLoading && !menuCatalogQuery\.data\}/);
  assert.match(workspaceSource, /menuCatalogError=\{/);

  assert.match(detailSource, /const orderMenuReady = Boolean\(menuCatalog && menuCatalog\.products\.length > 0\);/);
  assert.match(detailSource, /disabled=\{busy \|\| !canOrder \|\| menuCatalogLoading \|\| !orderMenuReady\}/);
  assert.match(detailSource, /Menu non disponibile per questa sala e attivita/);
});

test("[FE][FRONTENDV2][P1] dominio tavoli estratto da api/tables monolitico", async () => {
  const tablesApiSource = await fs.readFile(path.join(mobileSrcDir, "api", "tables.ts"), "utf8");
  const domainTypesSource = await fs.readFile(
    path.join(mobileSrcDir, "domain", "tables", "types.ts"),
    "utf8"
  );
  const domainDerivationsSource = await fs.readFile(
    path.join(mobileSrcDir, "domain", "tables", "derivations.ts"),
    "utf8"
  );
  const domainQueryKeysSource = await fs.readFile(
    path.join(mobileSrcDir, "domain", "tables", "queryKeys.ts"),
    "utf8"
  );
  const domainIntegrationTypesSource = await fs.readFile(
    path.join(mobileSrcDir, "domain", "tables", "integrationTypes.ts"),
    "utf8"
  );
  const domainIntegrationParsersSource = await fs.readFile(
    path.join(mobileSrcDir, "domain", "tables", "integrationParsers.ts"),
    "utf8"
  );
  const domainIntegrationOrderTransformsSource = await fs.readFile(
    path.join(mobileSrcDir, "domain", "tables", "integrationOrderTransforms.ts"),
    "utf8"
  );
  const domainIntegrationQueueStorageSource = await fs.readFile(
    path.join(mobileSrcDir, "domain", "tables", "integrationQueueStorage.ts"),
    "utf8"
  );
  const apiIntegrationClientSource = await fs.readFile(
    path.join(mobileSrcDir, "api", "tables", "integrationClient.ts"),
    "utf8"
  );
  const reservationWindowSource = await fs.readFile(
    path.join(mobileSrcDir, "api", "tableReservationWindow.ts"),
    "utf8"
  );

  assert.match(domainTypesSource, /export type DiningTable = \{/);
  assert.match(domainTypesSource, /export type DiningTableOrder = \{/);
  assert.match(domainTypesSource, /export type TableSessionRequest = \{/);
  assert.match(domainDerivationsSource, /export const deriveTableVisualState = \(table: DiningTable\)/);
  assert.match(domainDerivationsSource, /export const derivePosStatusFromDiningTable = \(table: DiningTable\)/);
  assert.match(domainQueryKeysSource, /export const tablesQueryKey = \(roomId: string, activityId = ""\)/);
  assert.match(domainQueryKeysSource, /export const TABLE_SESSION_HISTORY_GRACE_MS = 1000;/);
  assert.match(domainIntegrationTypesSource, /export type IntegrationOrder = \{/);
  assert.match(domainIntegrationTypesSource, /export type IntegrationLayoutTable = \{/);
  assert.match(domainIntegrationTypesSource, /export type PendingIntegrationAction =/);
  assert.match(domainIntegrationParsersSource, /export const parseIntegrationLayoutRoom =/);
  assert.match(domainIntegrationParsersSource, /export const parseIntegrationLayoutTable =/);
  assert.match(domainIntegrationParsersSource, /export const parseIntegrationOrder =/);
  assert.match(domainIntegrationParsersSource, /export const parseIntegrationWorkflowStatus =/);
  assert.match(domainIntegrationParsersSource, /export const toDiningTableFromLayout =/);
  assert.match(domainIntegrationOrderTransformsSource, /export const buildIntegrationOrderFingerprint =/);
  assert.match(domainIntegrationOrderTransformsSource, /export const groupIntegrationOrderLines =/);
  assert.match(domainIntegrationOrderTransformsSource, /export const deriveOrderStateFromIntegration =/);
  assert.match(domainIntegrationOrderTransformsSource, /export const toDiningOrderFromIntegration =/);
  assert.match(domainIntegrationQueueStorageSource, /export const INTEGRATION_QUEUE_STORAGE_KEY = "POS_INTEGRATION_QUEUE_V1";/);
  assert.match(domainIntegrationQueueStorageSource, /export const loadIntegrationQueueFromStorage =/);
  assert.match(domainIntegrationQueueStorageSource, /export const saveIntegrationQueueToStorage =/);
  assert.match(apiIntegrationClientSource, /export const fetchIntegrationLayout =/);
  assert.match(apiIntegrationClientSource, /export const fetchIntegrationOrders =/);
  assert.match(apiIntegrationClientSource, /export const sendIntegrationOrderCreateRequest =/);
  assert.match(apiIntegrationClientSource, /export const sendIntegrationLayoutSyncRequest =/);
  assert.match(apiIntegrationClientSource, /export const shouldQueueForRetry =/);

  assert.match(tablesApiSource, /from "\.\.\/domain\/tables\/types"/);
  assert.match(tablesApiSource, /from "\.\.\/domain\/tables\/derivations"/);
  assert.match(tablesApiSource, /from "\.\.\/domain\/tables\/queryKeys"/);
  assert.match(tablesApiSource, /from "\.\.\/domain\/tables\/integrationTypes"/);
  assert.match(tablesApiSource, /from "\.\.\/domain\/tables\/integrationParsers"/);
  assert.match(tablesApiSource, /from "\.\.\/domain\/tables\/integrationOrderTransforms"/);
  assert.match(tablesApiSource, /from "\.\.\/domain\/tables\/integrationQueueStorage"/);
  assert.match(tablesApiSource, /from "\.\/tables\/integrationClient"/);
  assert.equal(tablesApiSource.includes("export type DiningTable = {"), false);
  assert.equal(tablesApiSource.includes("type IntegrationOrder = {"), false);
  assert.equal(tablesApiSource.includes("type IntegrationLayoutTable = {"), false);
  assert.equal(tablesApiSource.includes("type PendingIntegrationAction ="), false);
  assert.equal(tablesApiSource.includes("const parseIntegrationLayoutRoom ="), false);
  assert.equal(tablesApiSource.includes("const parseIntegrationLayoutTable ="), false);
  assert.equal(tablesApiSource.includes("const parseIntegrationOrder ="), false);
  assert.equal(tablesApiSource.includes("const parseIntegrationWorkflowStatus ="), false);
  assert.equal(tablesApiSource.includes("const toDiningTableFromLayout ="), false);
  assert.equal(tablesApiSource.includes("const groupIntegrationOrderLines ="), false);
  assert.equal(tablesApiSource.includes("const deriveOrderStateFromIntegration ="), false);
  assert.equal(tablesApiSource.includes("const toDiningOrderFromIntegration ="), false);
  assert.equal(tablesApiSource.includes('const INTEGRATION_QUEUE_STORAGE_KEY = "POS_INTEGRATION_QUEUE_V1"'), false);
  assert.equal(tablesApiSource.includes("const readIntegrationQueueFromStorage ="), false);
  assert.equal(tablesApiSource.includes("const postIntegrationJson ="), false);
  assert.equal(tablesApiSource.includes("const sendIntegrationOrderCreateRequest ="), false);
  assert.equal(tablesApiSource.includes("const sendIntegrationLayoutSyncRequest ="), false);
  assert.equal(tablesApiSource.includes("export const deriveTableVisualState = (table: DiningTable)"), false);
  assert.equal(tablesApiSource.includes('export const tablesQueryKey = (roomId: string, activityId = "")'), false);
  assert.equal(tablesApiSource.includes("const TABLE_SESSION_HISTORY_GRACE_MS = 1000;"), false);

  assert.match(reservationWindowSource, /from "\.\.\/domain\/tables\/types"/);
  assert.equal(reservationWindowSource.includes('from "./tables"'), false);
});
