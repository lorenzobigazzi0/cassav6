import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(path.join(testDir, "..", "server.js"), "utf8");

function sourceBetween(start, end) {
  const startIndex = serverSource.indexOf(start);
  const endIndex = serverSource.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `blocco iniziale non trovato: ${start}`);
  assert.ok(endIndex > startIndex, `blocco finale non trovato: ${end}`);
  return serverSource.slice(startIndex, endIndex);
}

test("la mutation lane generica ripristina il contesto della richiesta proprietaria", () => {
  const block = sourceBetween(
    "async function withDbMutation",
    "function withPrintLaneMutation",
  );
  assert.match(block, /requestMetricsStorage\.run\(requestMetricsContext/);
  assert.match(block, /requestMetricsContext,/);
});

test("lo scheduler considera urgente anche una mutazione oltre il limite di attesa", () => {
  const block = sourceBetween(
    "function hasUrgentDbMutationTask",
    "function dequeueNextOrderSyncLaneTask",
  );
  assert.match(block, /hasUrgentOrStarvedDbMutationTask/);
  assert.match(block, /DB_MUTATION_STARVATION_WAIT_MS/);
  assert.match(block, /dbMutationStarvationPromotions/);
});
