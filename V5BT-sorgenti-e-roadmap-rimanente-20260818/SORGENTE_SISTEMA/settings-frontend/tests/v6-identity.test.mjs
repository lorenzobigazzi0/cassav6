import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("settings Commercial V2 espone soltanto l'identita Cassa V6", async () => {
  const [packageSource, indexSource, mainSource, renderSource] = await Promise.all([
    source("package.json"),
    source("index.html"),
    source("src/main.js"),
    source("src/pages/render.js"),
  ]);

  assert.equal(JSON.parse(packageSource).name, "cassav6-settings-commercial-v2");
  assert.match(indexSource, /<title>Cassa V6 \u00b7 Cataloghi, listini e offerte<\/title>/);
  assert.match(mainSource, /`cassav6-commercial-v2-\$\{result\.version\.versionNumber\}\.json`/);
  assert.match(renderSource, />V6<\/div>/);

  for (const value of [packageSource, indexSource, mainSource, renderSource]) {
    assert.doesNotMatch(value, /V5BT|v5bt|>V5<\/div>/);
  }
});

test("la build Settings conserva l'identita V6", async () => {
  const [indexSource, mainSource, renderSource] = await Promise.all([
    source("dist/index.html"),
    source("dist/assets/main.js"),
    source("dist/assets/pages/render.js"),
  ]);

  assert.match(indexSource, /<title>Cassa V6 \u00b7 Cataloghi, listini e offerte<\/title>/);
  assert.match(mainSource, /cassav6-commercial-v2/);
  assert.match(renderSource, />V6<\/div>/);
  assert.doesNotMatch(`${indexSource}\n${mainSource}\n${renderSource}`, /V5BT|v5bt|>V5<\/div>/);
});
