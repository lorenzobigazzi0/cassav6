import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { cassaRoot } from "./helpers/test-server.mjs";

async function readServer() {
  return fs.readFile(path.join(cassaRoot, "backend", "server.js"), "utf8");
}

async function readSqlPrimaryBatch() {
  return fs.readFile(
    path.join(
      cassaRoot,
      "backend",
      "modules",
      "print-spool",
      "sql-primary-batch.js",
    ),
    "utf8",
  );
}

test("[BE][STEP6.5] SQL-primary claima dal repository relazionale prima del fast worker legacy", async () => {
  const server = await readServer();

  assert.match(
    server,
    /function canUsePrintSpoolFastWorker\(\) \{[\s\S]*!PRINT_SPOOL_SQL_PRIMARY[\s\S]*PRINT_SPOOL_FAST_WORKER/,
    "il fast worker legacy deve essere spento quando PRINT_SPOOL_SQL_PRIMARY=1",
  );
  assert.match(
    server,
    /async function claimNextPrintSpoolJob\(\) \{[\s\S]*if \(PRINT_SPOOL_SQL_PRIMARY\) \{\s*return claimNextPrintSpoolJobSqlPrimary\(\);\s*\}[\s\S]*canUsePrintSpoolFastWorker\(\)/,
    "il claim SQL-primary deve precedere ogni path legacy",
  );
  assert.match(
    server,
    /async function claimNextPrintSpoolJobSqlPrimary\(\) \{[\s\S]*const claimed = repo\.claimNext\(\{[\s\S]*leaseMs: PRINT_SPOOL_CLAIM_LEASE_MS/,
    "il worker deve usare PrintSpoolRepository.claimNext con lease",
  );
});

test("[BE][STEP6.5] enqueue SQL-primary scrive su print_spool e mantiene il mirror legacy best-effort", async () => {
  const server = await readServer();

  assert.match(
    server,
    /async function enqueuePrintSpoolJob\(payload\) \{[\s\S]*if \(PRINT_SPOOL_SQL_PRIMARY\) \{\s*return enqueuePrintSpoolJobSqlPrimary\(payload, \{ throwOnMissingTarget: true \}\);/,
    "enqueuePrintSpoolJob deve delegare alla coda SQL-primary",
  );
  assert.match(
    server,
    /async function appendPrintSpoolJobToDb\(db, payload\) \{[\s\S]*if \(PRINT_SPOOL_SQL_PRIMARY\) \{\s*return enqueuePrintSpoolJobSqlPrimary\(payload, \{[\s\S]*appendLegacyMirrorToDb: true/,
    "appendPrintSpoolJobToDb deve salvare SQL-primary anche quando chiamato dentro una mutazione legacy",
  );
  assert.match(
    server,
    /options\.appendLegacyMirrorToDb === true && process\.env\.PRINT_SPOOL_LEGACY_MIRROR_REMOTE_OWNER !== "1"/,
    "l'offload owner deve evitare la scansione locale del mirror durante l'auto-print",
  );
  assert.match(
    server,
    /createLatestByKeyBatchQueue\([\s\S]*metricPrefix: "printSpoolLegacyMirror"[\s\S]*printSpoolLegacyMirrorOwnerForwarder\.forward\(batch\)[\s\S]*flushPrintSpoolLegacyMirrorBatch\(batch\)[\s\S]*function mirrorLegacyPrintSpoolJobBestEffort[\s\S]*printSpoolLegacyMirrorQueue\.enqueue\(safeJob\.id, safeJob\)/,
    "il mirror app-state deve essere asincrono, coalescente e isolato nella coda dedicata",
  );
  assert.doesNotMatch(
    server,
    /runBatch:\s*\(batch\)\s*=>\s*withPrintLaneMutation\("print_spool_legacy_batch"/,
    "il mirror legacy non deve contendere la print lane autorevole",
  );
  assert.doesNotMatch(
    server,
    /function mirrorLegacyPrintSpoolJobBestEffort[\s\S]{0,1200}withDbMutation\(/,
    "il mirror SQL-primary non deve bloccare la coda globale delle mutazioni",
  );
});

test("[BE][STEP6.5] auto-print SQL-primary riusa lo snapshot create e delega all'owner idempotente", async () => {
  const server = await readServer();
  const batchSource = await readSqlPrimaryBatch();
  // Il piano auto-print del create e uscito da server.js con MIG-031 e vive nel
  // modulo che possiede la route; l'invariante e lo stesso, cambia il file.
  const createSource = await fs.readFile(
    path.join(cassaRoot, "backend", "modules", "integration", "order-create.handlers.js"),
    "utf8",
  );
  const planStart = createSource.indexOf("const autoPrintCreateSettings = PRINT_SPOOL_SQL_PRIMARY");
  const fallbackStart = createSource.indexOf("const latestDb = await readDb();", planStart);
  assert.ok(planStart >= 0, "il create deve preparare il piano auto-print SQL-primary");
  assert.ok(fallbackStart > planStart, "il fallback legacy deve restare esplicito");
  const primaryCreatePath = createSource.slice(planStart, fallbackStart);
  assert.match(
    primaryCreatePath,
    /const autoPrintCreatePayloads = autoPrintCreateSettings[\s\S]*buildAutoPrintPayloadsForOrder\([\s\S]*applyIntegrationOrderCompsToPrintableOrder\(nextOrder, db\)/,
  );
  assert.match(
    primaryCreatePath,
    /if \(autoPrintCreatePayloads\)[\s\S]*scheduleOrderCreateAutoPrint\(\{[\s\S]*payloads: autoPrintCreatePayloads,[\s\S]*settings: autoPrintCreateSettings/,
  );
  assert.doesNotMatch(
    primaryCreatePath,
    /await readDb\(\)/,
    "il path SQL-primary non deve rileggere tutto l'app-state dopo il create",
  );

  assert.match(server, /persistSqlPrimaryPrintBatch\(\{/);
  assert.match(server, /createAutoPrintOwnerForwarder\(\{/);
  assert.match(server, /printSpoolAutoPrintOwnerQueue\.enqueue\(plan\.batchId, plan\)/);
  assert.match(server, /jobId:\s*pendingEntries\[index\]\?\.jobId/);
  assert.match(server, /repository\.getById\(entry\.jobId\)/);
  assert.match(batchSource, /persistJobFile/);
  assert.match(batchSource, /repository\.enqueueMany\(/);
  assert.ok(
    batchSource.indexOf("persistJobFile") < batchSource.indexOf("repository.enqueueMany("),
    "i file di spool devono essere persistiti prima della transazione SQL",
  );
  assert.doesNotMatch(batchSource, /await readDb\(\)/);
});

test("[BE][STEP6.5] completamento SQL-primary chiude sul repository e schedula retry da SQL", async () => {
  const server = await readServer();

  assert.match(
    server,
    /async function completePrintSpoolJob\(jobId, status, errorMessage = ""\) \{[\s\S]*if \(PRINT_SPOOL_SQL_PRIMARY\) \{\s*return completePrintSpoolJobSqlPrimary\(safeJobId, safeStatus, errorMessage\);/,
    "il completamento deve usare il path SQL-primary quando il flag e' attivo",
  );
  assert.match(
    server,
    /async function completePrintSpoolJobSqlPrimary\(jobId, status, errorMessage = ""\) \{[\s\S]*repo\.markConfirmed\(safeJobId\)[\s\S]*repo\.markFailed\(safeJobId, \{[\s\S]*retryDelayMs: PRINT_SPOOL_RETRY_DELAY_MS/,
    "confirmed/failed devono essere scritti su print_spool",
  );
  assert.match(
    server,
    /async function scheduleNextPrintSpoolRetryFromDb\(\) \{[\s\S]*if \(PRINT_SPOOL_SQL_PRIMARY\) \{[\s\S]*getPrintSpoolRepository\(\)\?\.nextRetryDelayMs\(\)/,
    "la pianificazione dei retry deve leggere il prossimo retry da SQL",
  );
});
