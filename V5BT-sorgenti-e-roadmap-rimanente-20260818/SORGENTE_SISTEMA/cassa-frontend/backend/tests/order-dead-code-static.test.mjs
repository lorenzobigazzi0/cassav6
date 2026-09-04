import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../server.js", import.meta.url), "utf8");

test("server non contiene piu helper ordine item id inutilizzato", () => {
  assert.doesNotMatch(serverSource, /function\s+nextIntegrationOrderItemId\s*\(/);
});
