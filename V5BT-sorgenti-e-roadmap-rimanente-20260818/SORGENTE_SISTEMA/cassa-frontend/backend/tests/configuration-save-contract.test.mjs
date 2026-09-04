import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(testDir, "..");
const projectRoot = path.resolve(backendDir, "..", "..");

test("settings areas save preserva locale, attivita e binding attivita-sale", async () => {
  // La scrittura vive nel write model del dominio `configuration` da MIG-032.
  const handlersSource = await readFile(
    path.join(backendDir, "modules/settings/settings-write-model.js"),
    "utf8",
  );
  assert.match(
    handlersSource,
    /locale:\s*payload\.locale\s*\?\?\s*db\.posSettings\?\.locale/,
  );
  assert.match(
    handlersSource,
    /activities:\s*payload\.activities\s*\?\?\s*db\.posSettings\?\.activities/,
  );
  assert.match(
    handlersSource,
    /activityRoomBindings:\s*payload\.activityRoomBindings\s*\?\?\s*db\.posSettings\?\.activityRoomBindings/,
  );
});

test("salvataggio menu preserva locale, attivita e binding attivita-sale", async () => {
  const menuHandlersSource = await readFile(
    path.join(backendDir, "modules/menu/menu-write-model.js"),
    "utf8",
  );
  assert.match(menuHandlersSource, /locale:\s*nextPosSettings\.locale/);
  assert.match(menuHandlersSource, /activities:\s*nextPosSettings\.activities/);
  assert.match(
    menuHandlersSource,
    /activityRoomBindings:\s*nextPosSettings\.activityRoomBindings/,
  );
  assert.match(menuHandlersSource, /menus:\s*nextPosSettings\.menus/);
  assert.match(menuHandlersSource, /priceLists:\s*nextPosSettings\.priceLists/);
  assert.match(
    menuHandlersSource,
    /priceListSchedules:\s*nextPosSettings\.priceListSchedules/,
  );
  assert.match(
    menuHandlersSource,
    /menuSchedules:\s*nextPosSettings\.menuSchedules/,
  );
  assert.match(menuHandlersSource, /priceListPrices/);
  assert.match(menuHandlersSource, /workstationIds/);
  assert.match(menuHandlersSource, /vatRate/);
});

test("payload impostazioni espone il modello locale-attivita-sale", async () => {
  const serverSource = await readFile(
    path.join(backendDir, "server.js"),
    "utf8",
  );
  assert.match(serverSource, /locale:\s*settings\.locale/);
  assert.match(serverSource, /activities:\s*settings\.activities/);
  assert.match(
    serverSource,
    /activityRoomBindings:\s*settings\.activityRoomBindings/,
  );
});

test("preferenze pagamento utente persistono nel record utente", async () => {
  const routesSource = await readFile(
    path.join(backendDir, "modules/settings/settings.routes.js"),
    "utf8",
  );
  const handlersSource = await readFile(
    path.join(backendDir, "modules/settings/settings.handlers.js"),
    "utf8",
  );
  assert.match(routesSource, /\/api\/settings\/user\/payment-preferences/);
  assert.match(routesSource, /settings\.saveUserPaymentPreferences/);
  assert.match(handlersSource, /user\.preferences\s*=/);
  assert.match(handlersSource, /counterCashDefaultSource/);
});

test("migrazione stato preserva configurazioni POS non visibili nelle aree", async () => {
  const migrationSource = await readFile(
    path.join(backendDir, "modules/app-state/security-migration.js"),
    "utf8",
  );
  assert.match(migrationSource, /demoMode:\s*normalizedPosSettings\.demoMode/);
  assert.match(
    migrationSource,
    /paymentTerminals:\s*normalizedPosSettings\.paymentTerminals/,
  );
  assert.match(
    migrationSource,
    /automaticCash:\s*normalizedPosSettings\.automaticCash/,
  );
});

test("catalogo runtime espone aliquota IVA ai frontend operativi", async () => {
  const serverSource = await readFile(
    path.join(backendDir, "server.js"),
    "utf8",
  );
  assert.match(
    serverSource,
    /const productVatRateRaw = Number\(item\.vatRate \?\? item\.iva \?\? item\.taxRate\)/,
  );
  assert.match(serverSource, /vatRate:\s*productVatRate/);
  assert.match(serverSource, /vatCode:\s*productVatCode/);
});

test("frontend impostazioni invia locale, attivita e binding al salvataggio aree", async () => {
  const settingsAppSource = await readFile(
    path.join(projectRoot, "settings-frontend/dist/assets/settings-app.js"),
    "utf8",
  );
  assert.match(settingsAppSource, /locale:\s*state\.settings\.locale/);
  assert.match(settingsAppSource, /activities:\s*state\.settings\.activities/);
  assert.match(
    settingsAppSource,
    /activityRoomBindings:\s*state\.settings\.activityRoomBindings/,
  );
  assert.match(settingsAppSource, /Collegamenti attività-sale/);
  assert.match(settingsAppSource, /renderOperationalMatrix/);
  assert.match(settingsAppSource, /Matrice operativa sale/);
  assert.match(settingsAppSource, /RT solo su Attivit/);
  assert.match(settingsAppSource, /Legacy \/ Migrazione sale/);
  assert.match(settingsAppSource, /fiscalDeviceIds/);
  assert.match(settingsAppSource, /workstationIds/);
  assert.match(
    settingsAppSource,
    /key === "activities" && field === "fiscalDeviceIds"/,
  );
  assert.match(
    settingsAppSource,
    /key === "activities" && field === "menuIds"/,
  );
  assert.match(
    settingsAppSource,
    /key === "activities" && field === "printerIds"/,
  );
  assert.match(
    settingsAppSource,
    /key === "activities" && field === "workstationIds"/,
  );
  assert.match(settingsAppSource, /renderListChecks/);
  assert.match(settingsAppSource, /data-list-path/);
  assert.match(settingsAppSource, /key === "areas" && field === "menuIds"/);
  assert.match(
    settingsAppSource,
    /key === "areas" && field === "waiterUserIds"/,
  );
  assert.match(settingsAppSource, /key === "areas" && field === "printerIds"/);
  assert.match(settingsAppSource, /renderCashPointsEditor/);
  assert.match(settingsAppSource, /renderWorkstationsEditor/);
  assert.match(settingsAppSource, /data-action="add-cash-point"/);
  assert.match(settingsAppSource, /data-action="add-workstation"/);
  assert.match(settingsAppSource, /key === "areas" && field === "cashPoints"/);
  assert.match(
    settingsAppSource,
    /key === "areas" && field === "workstations"/,
  );
  assert.match(settingsAppSource, /NOTIFICATION_PRIORITY_OPTIONS/);
  assert.match(settingsAppSource, /normalizeNotificationPrioritySelection/);
  assert.match(settingsAppSource, /Priorità notifiche/);
  assert.match(settingsAppSource, /modalCheck\("notificationPriorities"/);
  assert.match(settingsAppSource, /renderMenuScopeModal/);
  assert.match(settingsAppSource, /renderPriceListModal/);
  assert.match(settingsAppSource, /renderPriceListScheduleModal/);
  assert.match(settingsAppSource, /renderScheduleRulesEditor/);
  assert.match(settingsAppSource, /Cambio menu automatico/);
  assert.match(settingsAppSource, /priceListPrices/);
  assert.match(settingsAppSource, /vatRate/);
  assert.match(settingsAppSource, /Postazioni vendita/);
  assert.match(settingsAppSource, /scheduleAutoSaveForPath/);
  assert.match(settingsAppSource, /persistModalSave/);
  assert.match(
    settingsAppSource,
    /setPath\(state, path, parseByType\(target\)\);\s*state\.error = "";\s*scheduleAutoSaveForPath\(path\);/s,
  );
  assert.match(
    settingsAppSource,
    /Do not render here: blur\/change fires before the save click/,
  );
  assert.match(settingsAppSource, /void saveModal\(\)/);
  assert.match(settingsAppSource, /runSave\("Configurazione", saveAreas\)/);
  assert.match(settingsAppSource, /runSave\("Menu", saveMenu\)/);
  assert.match(settingsAppSource, /data-action="test-printer"/);
  assert.match(settingsAppSource, /function buildPrinterTestText/);
  assert.match(
    settingsAppSource,
    /POST \/api\/integration\/print|\/api\/integration\/print/,
  );
  assert.match(settingsAppSource, /kind:\s*"settings_printer_test"/);
});
