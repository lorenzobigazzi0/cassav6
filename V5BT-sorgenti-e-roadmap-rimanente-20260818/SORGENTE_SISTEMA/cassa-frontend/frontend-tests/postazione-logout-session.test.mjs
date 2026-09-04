import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(
  path.resolve(testDir, "../../postazione/src/App.jsx"),
  "utf8",
);
const logoutSessionSource = readFileSync(
  path.resolve(testDir, "../../postazione/src/logoutSession.js"),
  "utf8",
);

test("logout postazione elimina il token sia da localStorage sia da sessionStorage", () => {
  assert.match(
    appSource,
    /const removeAuthKey = \(k\) => \{[\s\S]+removeKey\(k\);[\s\S]+sessionStorage\.removeItem\(k\);/,
  );
  assert.match(
    appSource,
    /if \(auth\.loggedIn\)[\s\S]+else \{\s*removeAuthKey\(LS\.auth\);/,
  );
});

test("logout postazione pulisce subito la sessione locale e completa il backend", () => {
  assert.match(appSource, /fetch\(`\$\{base\}\/api\/auth\/logout`/);
  assert.match(
    appSource,
    /clientApp:\s*"postazione",[\s\S]+station,[\s\S]+stationName:\s*station/,
  );
  assert.match(
    logoutSessionSource,
    /completeLocalLogout\(reason\);[\s\S]+const result = await requestBackendLogout\(authSnapshot, station\)/,
  );
});

test("login postazione autentica prima di selezionare la postazione", () => {
  const loginStart = appSource.indexOf("/api/auth/login");
  const loginEnd = appSource.indexOf(
    "const payload = await res.json()",
    loginStart,
  );
  assert.ok(loginStart >= 0);
  assert.ok(loginEnd > loginStart);
  const loginRequest = appSource.slice(loginStart, loginEnd);
  assert.doesNotMatch(loginRequest, /\bstation(?:Name)?\s*:/);
  assert.match(
    appSource,
    /setPendingLoginAuth\(nextPendingAuth\);[\s\S]+setEntryStage\("workstation"\)/,
  );
  assert.match(
    appSource,
    /\/api\/auth\/workstation\/select[\s\S]+workstationId:\s*workstation\.id,[\s\S]+stationName:\s*workstation\.stationName/,
  );
});

test("la scelta postazione e obbligatoria e non resta disponibile nell'header", () => {
  assert.match(appSource, /aria-labelledby="workstation-login-title"/);
  assert.match(appSource, /loginWorkstations\.map\(\(workstation\)/);
  assert.match(
    appSource,
    /className="station-selector station-selector-static"/,
  );
  assert.doesNotMatch(appSource, /modal\.station/);
  assert.doesNotMatch(appSource, /setStationDraft/);
});

test("logout con sessione gia scaduta spegne comunque la postazione", () => {
  assert.match(
    logoutSessionSource,
    /if \(result\.sessionInvalid\) \{[\s\S]+await requestStationOffline\(authSnapshot, station\);/,
  );
  assert.match(
    appSource,
    /requestStationOffline[\s\S]+active:\s*false,[\s\S]+deviceUuid:[\s\S]+operatorUserId:/,
  );
});
