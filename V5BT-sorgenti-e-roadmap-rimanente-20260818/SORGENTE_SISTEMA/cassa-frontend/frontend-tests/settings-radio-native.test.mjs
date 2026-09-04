import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, "..", "..");
const settingsDist = path.join(projectRoot, "settings-frontend", "dist");

test("[FE][RADIO] impostazioni radio sono native nel frontend impostazioni", async () => {
  const appSource = await readFile(path.join(settingsDist, "assets", "settings-app.js"), "utf8");

  assert.match(appSource, /\{\s*id:\s*"radio",\s*label:\s*"Radio"\s*\}/);
  assert.match(appSource, /function\s+renderRadio\(/);
  assert.match(appSource, /\/api\/settings\/radio/);
  assert.match(appSource, /\/api\/settings\/radio\/save/);
  assert.match(appSource, /data-radio-field="id"/);
  assert.match(appSource, /data-radio-field="name"/);
  assert.match(appSource, /data-radio-field="color"/);
  assert.match(appSource, /function\s+validateRadioChannelsForSave\(/);
});

test("[FE][RADIO] default canali radio propone Bar, Generale e Cassa", async () => {
  const appSource = await readFile(path.join(settingsDist, "assets", "settings-app.js"), "utf8");

  assert.match(appSource, /\{\s*id:\s*"bar",\s*name:\s*"Bar",\s*color:\s*"#00d2ff"\s*\}/);
  assert.match(appSource, /\{\s*id:\s*"generale",\s*name:\s*"Generale",\s*color:\s*"#2ed573"\s*\}/);
  assert.match(appSource, /\{\s*id:\s*"cassa",\s*name:\s*"Cassa",\s*color:\s*"#8b5cf6"\s*\}/);
});

test("[FE][RADIO] canali radio non usano autosave generico delle impostazioni", async () => {
  const appSource = await readFile(path.join(settingsDist, "assets", "settings-app.js"), "utf8");

  assert.doesNotMatch(appSource, /data-path="settings\.radioChannels/);
  assert.doesNotMatch(appSource, /scheduleAutoSaveForPath\("settings\.radioChannels/);
  assert.match(appSource, /void runSave\("Radio", saveRadio\)/);
});

test("[FE][RADIO] stile canali radio presente nel frontend impostazioni", async () => {
  const cssSource = await readFile(path.join(settingsDist, "assets", "settings-app.css"), "utf8");

  assert.match(cssSource, /\.radio-channel-list/);
  assert.match(cssSource, /\.radio-channel-row/);
  assert.match(cssSource, /\.radio-channel-swatch/);
});
