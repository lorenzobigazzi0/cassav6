import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  resetP5GuiRequestTraffic,
  resolveStationWorkstationOptionIndex,
} from "./p5-headed-gui.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

async function source(name) {
  return fs.readFile(path.join(scriptDir, name), "utf8");
}

test("il launcher P5 fissa il contratto 20x5, 1000 azioni e 3 start/s", async () => {
  const text = await source("run-p5-endurance-25k.mjs");
  assert.match(text, /LOADTEST_HANDHELDS:\s*"20"/);
  assert.match(text, /LOADTEST_STATIONS:\s*"5"/);
  assert.match(text, /LOADTEST_GUI:\s*"2"/);
  assert.match(text, /P5_SMOKE_ACTIONS_PER_DEVICE = 8/);
  assert.match(text, /P5_CANARY_ACTIONS_PER_DEVICE = 100/);
  assert.match(text, /P5_FULL_ACTIONS_PER_DEVICE = 1_000/);
  assert.match(text, /canary\s*\? P5_CANARY_ACTIONS_PER_DEVICE/);
  assert.match(text, /LOADTEST_P5_ACTIONS_PER_SECOND:\s*"3"/);
  assert.match(text, /LOADTEST_PRINTER_COUNT:\s*"5"/);
  assert.match(text, /P5 non superato/);
  assert.match(text, /contentionGateFailures/);
  assert.match(text, /process\.platform === "win32"/);
  assert.match(text, /process\.env\.ProgramFiles/);
  assert.match(text, /process\.env\.LOCALAPPDATA/);
  assert.match(text, /Google", "Chrome", "Application", "chrome\.exe"/);
  assert.match(text, /process\.env\.ComSpec \|\| "cmd\.exe"/);
  assert.match(text, /\["\/d", "\/s", "\/c", "npm\.cmd"/);
});

test("il canary P5 e esplicito e non indebolisce il contratto full", async () => {
  const launcher = await source("run-p5-endurance-25k.mjs");
  const packageJson = JSON.parse(
    await fs.readFile(path.join(scriptDir, "..", "package.json"), "utf8"),
  );
  assert.match(launcher, /const canary = args\.has\("--canary"\)/);
  assert.match(launcher, /smoke && canary/);
  assert.match(launcher, /LOADTEST_P5_ALLOW_NONSTANDARD: smoke \|\| canary \? "1" : "0"/);
  assert.equal(
    packageJson.scripts["test:p5:endurance:canary"],
    "node scripts/run-p5-endurance-25k.mjs --canary",
  );
});

test("il P5 blocca stampanti, fiscale e gateway fuori loopback", async () => {
  const text = await source("run-p5-endurance-25k.mjs");
  assert.match(text, /LOADTEST_PRINTER_HOST:\s*"127\.0\.0\.1"/);
  assert.match(text, /POS_FISCAL_API_BASE_URL:\s*"http:\/\/127\.0\.0\.1:19290"/);
  assert.match(text, /LOADTEST_AUTOMATIC_CASH_BASE_URL:\s*"http:\/\/127\.0\.0\.1:19190"/);
  assert.match(text, /LOADTEST_ALLOW_NON_LOOPBACK_IO:\s*"0"/);
  assert.doesNotMatch(text, /192\.168\./);
});

test("le GUI P5 usano input reali e pressioni di almeno due secondi", async () => {
  const text = await source("p5-headed-gui.mjs");
  assert.match(text, /locator\.page\(\)\.touchscreen\.tap/);
  assert.match(text, /page\.mouse\.down\(\)/);
  assert.match(text, /Math\.max\(2_000, durationMs\)/);
  assert.match(text, /page\.mouse\.up\(\)/);
  assert.match(text, /station\.logout_10m_relogin/);
  assert.match(text, /setOffline\(true\)/);
  assert.match(text, /setOffline\(false\)/);
  assert.match(text, /loginStationViaUi/);
  assert.match(text, /verifyStationAuthCleared/);
  assert.match(text, /confirmStationLogout/);
  assert.match(text, /const logout = page\.locator\("\.logout-btn"\)/);
  assert.match(text, /La conferma logout non ha aperto la schermata di accesso/);
  assert.match(text, /stationLogoutFailureContext/);
  assert.match(text, /page\.on\("requestfailed", onRequestFailed\)/);
  assert.match(text, /p5ActionKind = "logout-longpress-login"/);
  assert.match(text, /attempt <= 6/);
  assert.match(text, /attempt <= 6/);
  assert.match(text, /attempt <= 4/);
  assert.match(text, /window\.localStorage, window\.sessionStorage/);
  assert.match(text, /verifyMobileSession/);
  assert.match(text, /expectedConflicts/);
  assert.match(text, /\/api\/integration\/orders\/sync/);
  assert.match(text, /createExpectedInterruptionRequestTracker/);
  assert.match(text, /interruptionRequests\.includes\(request\)/);
  assert.match(text, /at: new Date\(\)\.toISOString\(\)/);
});

test("il login GUI Postazione seleziona la postazione abilitata prima della UI operativa", async () => {
  const text = await source("p5-headed-gui.mjs");
  assert.match(
    text,
    /loginStationViaUi\(\{ page, session, pin, longPressMs, stationName \}\)/,
  );
  assert.match(text, /workstation-login-title/);
  assert.match(text, /\.workstation-login-option/);
  assert.match(text, /\/api\/auth\/workstation\/select/);
  assert.match(text, /selectStationWorkstationViaUi\(page, stationName\)/);
  assert.match(text, /waitForStationOperational\(page, stationName\)/);
  assert.match(text, /BAR_POSTAZIONE_STATION_V1/);
  assert.match(text, /gui\.station_workstation_target_bound/);
  assert.match(text, /flow = "legacy"/);
  assert.match(text, /state === "launcher"/);
  assert.match(text, /state === "form"|getByPlaceholder\("Utente"\)/);
  assert.match(
    text,
    /loginPayload\.workstationSelectionRequired === true[\s\S]+loginPayload\.workstationSelectionRequired == null[\s\S]+Array\.isArray\(loginPayload\.availableWorkstations\)/,
  );
});

test("la scelta Postazione usa un confronto esatto e non confonde target simili", () => {
  const options = [
    { name: "Bar dieci", stationName: "BAR-10" },
    { name: "Bar principale", stationName: "BAR-1" },
    { name: "Cucina", stationName: "CUCINA" },
  ];
  assert.equal(resolveStationWorkstationOptionIndex(options, " bar-1 "), 1);
  assert.equal(resolveStationWorkstationOptionIndex(options, "BAR-10"), 0);
  assert.equal(resolveStationWorkstationOptionIndex(options, "BAR"), -1);
  assert.equal(resolveStationWorkstationOptionIndex(options, ""), -1);
});

test("la finestra request GUI riparte senza cancellare errori e interazioni", () => {
  const diagnostics = {
    requests: 41,
    requestsByRoute: { "GET /api/integration/orders": 17 },
    requestFailures: 2,
    consoleErrors: 1,
    interactions: 3,
  };

  assert.equal(resetP5GuiRequestTraffic(diagnostics), diagnostics);
  assert.equal(diagnostics.requests, 0);
  assert.deepEqual(diagnostics.requestsByRoute, {});
  assert.equal(diagnostics.requestFailures, 2);
  assert.equal(diagnostics.consoleErrors, 1);
  assert.equal(diagnostics.interactions, 3);
});

test("il profilo multiprocesso P5 abilita il writer puntuale delle notifiche", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  assert.match(runner, /BACKEND_NOTIFICATION_PUNCTUAL_WRITER:\s*"1"/);
});

test("il launcher P5 promuove i writer puntuali gia coperti mantenendo il rollback", async () => {
  const launcher = await source("run-p5-endurance-25k.mjs");
  assert.match(
    launcher,
    /LOADTEST_TABLE_SYNC_APP_STATE_FASTPATH:[\s\S]+process\.env\.LOADTEST_TABLE_SYNC_APP_STATE_FASTPATH \|\| "1"/,
  );
  assert.match(
    launcher,
    /LOADTEST_TABLE_ROOM_MOVE_REQUEST_APP_STATE_FASTPATH:[\s\S]+process\.env\.LOADTEST_TABLE_ROOM_MOVE_REQUEST_APP_STATE_FASTPATH \|\| "1"/,
  );
  assert.match(
    launcher,
    /LOADTEST_WAITER_PAUSE_SESSION_AUDIT_FASTPATH:[\s\S]+process\.env\.LOADTEST_WAITER_PAUSE_SESSION_AUDIT_FASTPATH \|\| "1"/,
  );
  assert.match(
    launcher,
    /LOADTEST_COUNTER_COLLECTION_ATOMIC_FASTPATH:[\s\S]+process\.env\.LOADTEST_COUNTER_COLLECTION_ATOMIC_FASTPATH \|\| "1"/,
  );
});

test("il pagamento automatico P5 usa una comanda dedicata non condivisa", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  assert.match(runner, /async function createP5ScenarioOrder/);
  assert.match(runner, /createP5ScenarioOrder\(\s*device\.session,\s*tables/);
  assert.match(
    runner,
    /automaticCashPayment\(\s*device\.session,\s*scenarioOrder\.order/,
  );
  assert.doesNotMatch(
    runner,
    /automaticCashPayment\(device\.session, selectUsableOrder\(sharedOrders\)\)/,
  );
  assert.match(runner, /completeStatus: payment\?\.complete\?\.status/);
  assert.match(runner, /includeAuthQuery:\s*false/);
  assert.match(runner, /options\.includeAuthQuery === false/);
});

test("il pagamento per articolo ricalcola una selezione diventata obsoleta", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  assert.match(runner, /isStalePaymentArticleSelectionResponse/);
  assert.match(runner, /payment_article_selection_refresh_retry/);
  assert.match(runner, /firstPayableOrderArticleUnit\(order\)/);
  assert.match(runner, /buildBody\(":article-refresh1"\)/);
  assert.match(runner, /amount = resolveAmount\(\)/);
});

test("l'annullamento rilegge la comanda dopo il lock e tratta lo spostamento come race recuperabile", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  const start = runner.indexOf("async function cancelOrder");
  const end = runner.indexOf("async function syncTableDetails", start);
  const cancelSource = runner.slice(start, end);

  assert.match(
    cancelSource,
    /lockTableWithRetry\(session, lockedTableId, "order\.cancel"\)[\s\S]+order = await refreshOrderById\(session, order\)/,
  );
  assert.match(cancelSource, /order\.tableId !== lockedTableId/);
  assert.match(cancelSource, /order_cancel_skip_table_changed/);
  assert.match(cancelSource, /order_cancel_skip_table_changed_after_submit/);
  assert.match(
    cancelSource,
    /allowResponse:[\s\S]+La comanda non appartiene al tavolo indicato/,
  );
});

test("il report P5 include percentili, drift e finestre temporali", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  const pdf = await source("p5-endurance-report-pdf.mjs");
  assert.match(runner, /p5ActionTimeWindows/);
  assert.match(runner, /actionLatencyDrift/);
  assert.match(runner, /steadyActionLatencyDrift/);
  assert.match(runner, /disruptiveActionCount/);
  assert.match(runner, /p5ActionTypeSummaries/);
  assert.match(runner, /error\?\.p5ActionType/);
  assert.match(runner, /error\?\.p5Disruptive/);
  assert.match(runner, /p999ms/);
  assert.match(pdf, /Drift primo\/ultimo 10%/);
  assert.match(pdf, /P99\.9/);
});

test("il P5 persiste checkpoint incrementali di latenza anche prima del report finale", async () => {
  const launcher = await source("run-p5-endurance-25k.mjs");
  const runner = await source("loadtest-full-capacity.mjs");
  const checkpoint = await source("p5-latency-checkpoint.mjs");
  assert.match(launcher, /p5-latency-checkpoints\.jsonl/);
  assert.match(launcher, /LOADTEST_P5_CHECKPOINT_INTERVAL_MS/);
  assert.match(runner, /createP5LatencyCheckpointWriter/);
  assert.match(runner, /process-cleanup/);
  assert.match(runner, /profile-stop/);
  assert.match(checkpoint, /httpLatencyMs/);
  assert.match(checkpoint, /actionLatencyMs/);
  assert.match(checkpoint, /p999ms/);
});

test("il P5 conserva diagnostica route e retry separata per processo", async () => {
  const launcher = await source("run-p5-endurance-25k.mjs");
  const runner = await source("loadtest-full-capacity.mjs");
  assert.match(launcher, /backend-baseline\.jsonl/);
  assert.match(launcher, /backend-api-worker-\$\{index \+ 1\}-baseline\.jsonl/);
  assert.match(launcher, /missingBaselineDiagnostics/);
  assert.match(launcher, /p5-contention-report\.mjs/);
  assert.match(launcher, /P5_CONTENTION_REPORT\.md/);
  assert.match(runner, /DIAGNOSTICS_BASELINE:\s*"1"/);
  assert.match(runner, /DIAGNOSTICS_SAMPLE_RATE:\s*"1"/);
  assert.match(runner, /p5BaselineDiagnosticsPaths/);
  assert.match(runner, /Innodb_deadlocks/);
  assert.match(runner, /Innodb_row_lock_waits/);
  assert.match(runner, /runtimeProcessEntries/);
  assert.match(runner, /runtimeSampleIntervalMs = 5_000/);
  assert.match(runner, /cpuPercent/);
});

test("il P5 fallisce su errori HTTP o console delle GUI reali", async () => {
  const runner = await source("loadtest-full-capacity.mjs");
  assert.match(runner, /p5\.gui\.http_clean/);
  assert.match(runner, /p5\.gui\.console_clean/);
  assert.match(runner, /p5\.gui\.unexpected_errors/);
});
