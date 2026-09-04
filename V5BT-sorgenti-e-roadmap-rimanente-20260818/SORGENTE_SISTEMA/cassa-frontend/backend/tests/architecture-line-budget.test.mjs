import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(testDir, "..");
const serverPath = path.join(backendRoot, "server.js");

const SERVER_LINE_BUDGET = 39_500;

test("backend/server.js resta sotto il budget righe architetturale", async () => {
  const source = await readFile(serverPath, "utf8");
  const lineCount = source.split(/\r?\n/).length;

  assert.ok(
    lineCount <= SERVER_LINE_BUDGET,
    [
      `backend/server.js ha ${lineCount} righe, budget ${SERVER_LINE_BUDGET}.`,
      "Estrarre nuove logiche in backend/modules o backend/routes invece di aggiungere codice al monolite.",
    ].join(" "),
  );
});
