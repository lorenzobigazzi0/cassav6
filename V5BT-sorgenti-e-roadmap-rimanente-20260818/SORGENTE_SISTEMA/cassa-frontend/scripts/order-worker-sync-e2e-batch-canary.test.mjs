import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("./order-worker-sync-e2e-batch-canary.mjs", import.meta.url),
  "utf8",
);
const singleCanarySource = await readFile(
  new URL("./order-worker-sync-e2e-canary.mjs", import.meta.url),
  "utf8",
);

test("order worker batch canary distribuisce tavoli espliciti tra child concorrenti", () => {
  assert.match(
    source,
    /ORDER_E2E_BATCH_TABLE_IDS/,
    "il batch deve accettare una lista tavoli esplicita per test concorrenti"
  );
  assert.match(
    source,
    /env\.CANARY_TABLE_ID = options\.tableIds\[\(index - 1\) % options\.tableIds\.length\]/,
    "ogni child deve ricevere un tavolo round-robin dalla lista"
  );
});

test("order worker batch canary puo tenere vive postazioni simulate", () => {
  assert.match(
    source,
    /ORDER_E2E_BATCH_ACTIVE_STATIONS/,
    "il batch deve poter attivare postazioni simulate prima del carico"
  );
  assert.match(
    source,
    /postStationHeartbeat\(entry,\s*true\)/,
    "il batch deve inviare heartbeat reali all'endpoint station state"
  );
  assert.match(
    source,
    /env\.CANARY_STATION = options\.activeStations\[\(index - 1\) % options\.activeStations\.length\]/,
    "ogni child deve ricevere una postazione round-robin dal preflight"
  );
  assert.match(
    source,
    /fetchActiveStations\(\)/,
    "il cleanup deve verificare che i device simulati non restino attivi"
  );
  assert.match(
    source,
    /\/api\/auth\/logout/,
    "il cleanup deve chiudere le sessioni postazione per evitare recovery attiva"
  );
});

test("order worker canary blocca cleanup cancel su workflow non annullabili", () => {
  assert.match(
    singleCanarySource,
    /CANCEL_CLEANUP_WORKFLOWS = new Set\(\["prep", "preparing", "waiting"\]\)/,
    "il cleanup obbligatorio deve essere ammesso solo su stati annullabili"
  );
  assert.match(
    singleCanarySource,
    /CANARY_SYNC_WORKFLOW_STATUS=\$\{options\.syncWorkflowStatus\} non e compatibile con cleanup via cancel/,
    "ready/delivered devono fallire prima di creare ordini se il cleanup e obbligatorio"
  );
});

test("order worker canary allinea orders/create al routing api-worker", () => {
  assert.match(
    singleCanarySource,
    /expectedCreateProxyRole:\s*envString\("CANARY_EXPECT_CREATE_PROXY_ROLE", "api-worker"\)/,
    "il canary C3/50 deve usare il default di routing corrente per orders/create"
  );
});
