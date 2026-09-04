import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(testDir, "..", "..", "..");
const settingsAppPath = path.join(
  workspaceRoot,
  "WEBAPP_COMPILATA",
  "impostazioni",
  "assets",
  "settings-app.js"
);
const runtimeSettingsAppPath = path.join(
  workspaceRoot,
  "SORGENTE_SISTEMA",
  "settings-frontend",
  "dist",
  "assets",
  "settings-app.js"
);
const packagedIndexPath = path.join(
  workspaceRoot,
  "WEBAPP_COMPILATA",
  "impostazioni",
  "index.html"
);
const runtimeIndexPath = path.join(
  workspaceRoot,
  "SORGENTE_SISTEMA",
  "settings-frontend",
  "dist",
  "index.html"
);

const APP_OPTIONS = Object.freeze([
  { id: "cassa", label: "Cassa" },
  { id: "postazione", label: "Postazione" },
  { id: "palmare", label: "Palmare" },
]);

test("[FE][SETTINGS] copia pacchetto e copia runtime restano identiche", async () => {
  const [packagedSource, runtimeSource, packagedIndex, runtimeIndex] = await Promise.all([
    readFile(settingsAppPath, "utf8"),
    readFile(runtimeSettingsAppPath, "utf8"),
    readFile(packagedIndexPath, "utf8"),
    readFile(runtimeIndexPath, "utf8"),
  ]);
  assert.equal(runtimeSource, packagedSource);
  assert.equal(runtimeIndex, packagedIndex);
  assert.match(runtimeIndex, /settings-app\.js\?v=20260804-user-app-access-v5bt/);
});

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} non trovata`);
  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `Corpo di ${name} non trovato`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`Corpo di ${name} incompleto`);
}

test("[FE][SETTINGS] enabledAppIds usa la allowlist canonica delle tre app", async () => {
  const source = await readFile(settingsAppPath, "utf8");

  assert.match(
    source,
    /const USER_APP_OPTIONS = Object\.freeze\(\[\s*\{ id: "cassa", label: "Cassa" \},\s*\{ id: "postazione", label: "Postazione" \},\s*\{ id: "palmare", label: "Palmare" \},\s*\]\);/
  );
  assert.doesNotMatch(source, /\benabledApps\b/);
});

test("[FE][SETTINGS] dati legacy senza enabledAppIds restano abilitati su tutte le app", async () => {
  const source = await readFile(settingsAppPath, "utf8");
  const functionSource = extractFunction(source, "normalizeUserEnabledAppIds");
  const normalizeUserEnabledAppIds = new Function(
    "USER_APP_OPTIONS",
    `"use strict"; ${functionSource}; return normalizeUserEnabledAppIds;`
  )(APP_OPTIONS);

  assert.deepEqual(normalizeUserEnabledAppIds(undefined), ["cassa", "postazione", "palmare"]);
  assert.deepEqual(normalizeUserEnabledAppIds(null), ["cassa", "postazione", "palmare"]);
  assert.deepEqual(normalizeUserEnabledAppIds([]), []);
  assert.deepEqual(
    normalizeUserEnabledAppIds([" postazione ", "POSTAZIONE", "invalid", "cassa"]),
    ["postazione", "cassa"]
  );
});

test("[FE][SETTINGS] tabella e modale utente espongono le applicazioni abilitate", async () => {
  const source = await readFile(settingsAppPath, "utf8");
  const renderUsersSource = extractFunction(source, "renderUsers");
  const renderUserModalSource = extractFunction(source, "renderUserModal");

  assert.match(renderUsersSource, /<th>Applicazioni<\/th>/);
  assert.match(renderUsersSource, /userEnabledAppSummary\(user\.enabledAppIds\)/);
  assert.match(renderUserModalSource, /<h3>Applicazioni abilitate<\/h3>/);
  assert.match(
    renderUserModalSource,
    /modalCheck\("enabledAppIds", application\.id, application\.label, enabledAppSet\.has\(application\.id\)\)/
  );
});

test("[FE][SETTINGS] nuovi utenti e salvataggio modale normalizzano enabledAppIds", async () => {
  const source = await readFile(settingsAppPath, "utf8");
  const defaultDraftSource = extractFunction(source, "defaultUserDraft");
  const openModalSource = extractFunction(source, "openUserModal");
  const saveModalSource = extractFunction(source, "saveUserModal");

  assert.match(defaultDraftSource, /enabledAppIds:\s*USER_APP_OPTIONS\.map\(\(entry\) => entry\.id\)/);
  assert.match(
    openModalSource,
    /source\.enabledAppIds = normalizeUserEnabledAppIds\(source\.enabledAppIds\)/
  );
  assert.match(
    saveModalSource,
    /draft\.enabledAppIds = normalizeUserEnabledAppIds\(draft\.enabledAppIds\)/
  );
});
