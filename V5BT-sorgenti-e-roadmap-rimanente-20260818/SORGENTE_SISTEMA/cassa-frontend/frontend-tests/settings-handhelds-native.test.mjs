import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..", "..");
const settingsDist = path.join(projectRoot, "settings-frontend", "dist");
const cassaDist = path.join(projectRoot, "cassa-frontend", "dist");

test("[FE][V3] impostazioni palmari sono native nel frontend impostazioni", async () => {
  const appSource = await readFile(path.join(settingsDist, "assets", "settings-app.js"), "utf8");

  assert.match(appSource, /\{\s*id:\s*"handhelds",\s*label:\s*"Palmari"\s*\}/);
  assert.match(appSource, /function\s+renderHandhelds\(/);
  assert.match(appSource, /\/api\/settings\/mobile-devices\/status/);
  assert.match(appSource, /\/api\/settings\/mobile-devices\/save/);
  assert.match(appSource, /\/api\/settings\/mobile-devices\/ring/);
});

test("[FE][V3] palmari rilevati partono con fiscalita disattivata", async () => {
  const appSource = await readFile(path.join(settingsDist, "assets", "settings-app.js"), "utf8");

  assert.match(appSource, /fiscalEnabled:\s*false/);
  assert.match(appSource, /electronicPaymentEnabled:\s*false/);
  assert.match(appSource, /cashPaymentEnabled:\s*false/);
});

test("[FE][V3] cassa non carica bridge separati per impostazioni palmari", async () => {
  const cassaIndex = await readFile(path.join(cassaDist, "index.html"), "utf8");

  assert.doesNotMatch(cassaIndex, /cash-mobile-devices-settings\.js/);
});
