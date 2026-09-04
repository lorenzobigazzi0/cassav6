import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..", "..");
const workspaceRoot = path.resolve(projectRoot, "..");

const settingsSources = [
  path.join(projectRoot, "settings-frontend", "dist", "assets", "settings-app.js"),
  path.join(workspaceRoot, "WEBAPP_COMPILATA", "impostazioni", "assets", "settings-app.js"),
];

const mobileSettingsPages = [
  path.join(projectRoot, "mobile-frontend", "src", "pages", "SettingsPage.tsx"),
  path.join(
    workspaceRoot,
    "APPLICATIVI",
    "Palmare",
    "web-frontend",
    "src",
    "pages",
    "SettingsPage.tsx"
  ),
];

const mobileAutomaticCashSections = [
  path.join(
    projectRoot,
    "mobile-frontend",
    "src",
    "pages",
    "settings",
    "components",
    "AutomaticCashSettingsSection.tsx"
  ),
  path.join(
    workspaceRoot,
    "APPLICATIVI",
    "Palmare",
    "web-frontend",
    "src",
    "pages",
    "settings",
    "components",
    "AutomaticCashSettingsSection.tsx"
  ),
];

function readSources(paths) {
  return paths.map((filePath) => readFileSync(filePath, "utf8"));
}

function extractFunction(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  assert.notEqual(start, -1, `${name} non trovata`);
  assert.notEqual(end, -1, `${nextName} non trovata dopo ${name}`);
  return source.slice(start, end).trim();
}

test("[FE][SETTINGS] amministrazione fondo cassa resta solo in /impostazioni", () => {
  for (const source of readSources(settingsSources)) {
    assert.match(source, /\{\s*id:\s*"automaticCash",\s*label:\s*"Cassa automatica"\s*\}/);
    assert.match(source, /function\s+renderAutomaticCash\(/);
    assert.match(source, /File combinazioni JSON/);
    assert.match(source, /Riserva minima cassa/);
    assert.match(source, /data-action="save-automatic-cash-settings"/);
    assert.match(source, /putJson\("\/api\/automatic-cash\/settings"/);
    assert.match(source, /\/api\/automatic-cash\/gateway\/state/);
    assert.match(source, /automaticCash\.enabled/);
    assert.match(source, /automaticCash\.feedbackEnabled/);
    assert.match(source, /automaticCash\.warningThresholdCents/);
    assert.match(source, /automaticCash\.dangerThresholdCents/);
    assert.match(source, /automaticCash\.configSetId/);
    assert.match(source, /automaticCash\.reserveConfigId/);
    assert.match(source, /\/api\/automatic-cash\/config-sets/);
    assert.match(source, /\/api\/automatic-cash\/reserve-configs/);
    assert.match(source, /function\s+validateAutomaticCashConfigDraft\(/);
    assert.match(source, /function\s+validateAutomaticCashReserveDraft\(/);
    assert.match(source, /AUTOMATIC_CASH_FILE_MAX_BYTES/);
    assert.match(source, /Valore denominazione duplicato/);
  }

  for (const source of readSources(mobileSettingsPages)) {
    assert.doesNotMatch(source, /AutomaticCashSettingsSection/);
    assert.doesNotMatch(source, /Statistiche POS/);
    assert.doesNotMatch(source, /File combinazioni JSON/);
    assert.doesNotMatch(source, /File riserva minima JSON/);
  }

  for (const componentPath of mobileAutomaticCashSections) {
    assert.equal(existsSync(componentPath), false);
  }
});

test("[FE][SETTINGS] pagina Pagamenti mostra statistiche realmente POS", () => {
  const [sourceSettings, compiledSettings] = readSources(settingsSources);

  for (const source of [sourceSettings, compiledSettings]) {
    assert.match(source, /postJson\("\/api\/reports\/sales", sessionPayload\(\)\)/);
    assert.match(source, /\$\{renderPosStatistics\(\)\}/);
    assert.match(source, /const posMethods = methods\.filter\(isPosPaymentMethod\)/);
    assert.match(source, /POS lordo/);
    assert.match(source, /Storni POS/);
    assert.match(source, /Riaddebiti POS/);
    assert.match(source, /POS netto/);
    assert.match(source, /Operazioni lorde POS/);
    assert.match(source, /Media lorda POS/);
    assert.match(source, /posStatisticsScope/);
    assert.match(source, /Nessun pagamento POS registrato/);
    assert.match(source, /data-action="reload-pos-statistics"/);
    assert.match(source, /action === "reload-pos-statistics"/);
  }

  assert.equal(
    extractFunction(sourceSettings, "renderPosStatistics", "benefitValueSummary"),
    extractFunction(compiledSettings, "renderPosStatistics", "benefitValueSummary")
  );
});

test("[FE][SETTINGS] artefatti /impostazioni espongono il cache-buster statistiche POS", () => {
  const indexes = readSources([
    path.join(projectRoot, "settings-frontend", "dist", "index.html"),
    path.join(workspaceRoot, "WEBAPP_COMPILATA", "impostazioni", "index.html"),
  ]);

  for (const index of indexes) {
    assert.match(index, /settings-app\.js\?v=20260804-user-app-access-v5bt/);
    assert.match(index, /settings-app\.css\?v=20260724-automatic-cash-admin-v4/);
  }
});
