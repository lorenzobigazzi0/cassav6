import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { buildRouteRegistry } from "../routes/index.js";
import { validateRouteDefinitions } from "../core/router.js";
import { startBackend } from "./helpers/test-server.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cassaDir = path.resolve(testDir, "..");
const appDir = path.resolve(cassaDir, "..");
const projectDir = path.resolve(appDir, "..");

// MIG-031 ha spostato gli handler da `server.js` ai moduli sotto `backend/`.
// Gli invarianti che questi test sorvegliano -- write-primary relazionale, CAS,
// pubblicazione via outbox, pruning in sola lettura -- non sono cambiati: e
// cambiato il file in cui vivono. La sorgente da ispezionare e quindi il backend
// nel suo insieme, non piu il solo monolite.
function elencaJs(dir) {
  const dentro = [];
  for (const voce of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, voce.name);
    if (voce.isDirectory()) dentro.push(...elencaJs(p));
    else if (voce.name.endsWith(".js")) dentro.push(p);
  }
  return dentro;
}

const percorsiBackend = [
  path.join(cassaDir, "server.js"),
  ...["modules", "auth", "users", "routes", "core"].flatMap((nome) =>
    elencaJs(path.join(cassaDir, nome)),
  ),
];

const backendSource = percorsiBackend
  .map((percorso) => readFileSync(percorso, "utf8"))
  .join("\n");

// Molti test qui ritagliano una regione di sorgente fra due marcatori, dando per
// scontato che entrambi vivano in `server.js`. Dopo MIG-031 una funzione puo
// stare in un modulo: questo aiuto la cerca dove si trova davvero e ne
// restituisce il corpo, cosi l'invariante sorvegliato resta quello di prima.
function corpoFunzione(nome) {
  for (const percorso of percorsiBackend) {
    const testo = readFileSync(percorso, "utf8");
    for (const marcatore of [`async function ${nome}(`, `function ${nome}(`]) {
      const inizio = testo.indexOf(marcatore);
      if (inizio < 0) continue;
      let profondita = 0;
      let aperto = false;
      for (let i = inizio; i < testo.length; i += 1) {
        if (testo[i] === "{") {
          profondita += 1;
          aperto = true;
        } else if (testo[i] === "}") {
          profondita -= 1;
          if (aperto && profondita === 0) return testo.slice(inizio, i + 1);
        }
      }
      return testo.slice(inizio);
    }
  }
  return "";
}

const dummyHandlers = Object.fromEntries(
  buildRouteRegistry()
    .map((route) => route.handlerKey)
    .filter(Boolean)
    .map((key) => [key, () => {}])
);

test("public mutation routes are explicitly justified and body-limited", () => {
  const publicMutations = buildRouteRegistry().filter((route) => route.public === true && route.mutation === true);
  assert.deepEqual(
    publicMutations.map((route) => `${route.method} ${route.path}`).sort(),
    [
      "POST /api/auth/login",
      "POST /api/integration/notifications/ack",
      "POST /api/integration/notifications/publish",
      "POST /api/integration/stations/state",
      "POST /api/integration/waiter-pause/defer-call",
      "POST /api/public/reservations/create",
    ].sort()
  );
  for (const route of publicMutations) {
    assert.equal(route.allowPublicMutation, true, `${route.method} ${route.path}`);
    assert.match(route.publicReason, /legacy|Heartbeat|operativo|postazione|mobile|Login|prenotazioni/i, `${route.method} ${route.path}`);
    assert.equal(typeof route.maxBodySize, "number", `${route.method} ${route.path}`);
    assert.ok(route.maxBodySize > 0 && route.maxBodySize <= 65_536, `${route.method} ${route.path}`);
  }
});

test("read-only POST report routes do not enter the global mutation queue", () => {
  const routesByKey = new Map(buildRouteRegistry().map((route) => [`${route.method} ${route.path}`, route]));
  const readOnlyReports = [
    "POST /api/audit/events",
    "POST /api/reports/sales",
    "POST /api/reports/handheld-session",
    "POST /api/reports/non-fiscalized",
  ];
  const mutatingReports = [
    "POST /api/audit/events/delete",
    "POST /api/reports/handheld-session/cash/open",
    "POST /api/reports/handheld-session/cash/close",
    "POST /api/reports/handheld-session/print",
    "POST /api/reports/payment-movement/reprint",
    "POST /api/reports/payment-movement/fiscal/verify",
    "POST /api/reports/payment-movement/fiscal/issue",
    "POST /api/reports/payment-movement/fiscal/void",
  ];

  for (const key of readOnlyReports) {
    const route = routesByKey.get(key);
    assert.ok(route, `${key} deve essere registrata`);
    assert.equal(route.mutation, false, `${key} deve restare fuori dalla coda globale`);
    assert.equal(route.readOnly, true, `${key} deve dichiarare readOnly:true`);
    assert.ok(String(route.readOnlyReason ?? "").trim().length >= 8, `${key} deve documentare readOnlyReason`);
  }

  for (const key of mutatingReports) {
    const route = routesByKey.get(key);
    assert.ok(route, `${key} deve essere registrata`);
    assert.equal(route.mutation, true, `${key} deve restare serializzata come mutazione`);
  }
});

test("print spool legacy mirror e' un endpoint interno owner-only", () => {
  const route = buildRouteRegistry().find(
    (entry) => entry.method === "POST" && entry.path === "/api/internal/print-spool/legacy-mirror",
  );
  assert.ok(route);
  assert.equal(route.service, "integration");
  assert.equal(route.authRequired, true);
  assert.equal(route.maxBodySize, 65_536);

  const serverSource = backendSource;
  const handlersSource = readFileSync(path.join(cassaDir, "routes", "route-handlers.js"), "utf8");
  assert.match(serverSource, /PRINT_SPOOL_LEGACY_MIRROR_REMOTE_OWNER/);
  assert.match(serverSource, /handleInternalPrintSpoolLegacyMirror/);
  assert.match(serverSource, /printSpoolLegacyMirrorOwnerForwarder\.forward\(batch\)/);
  assert.match(serverSource, /!PRINTING_ENABLED \|\| !SHOULD_RUN_BACKEND_OWNER_JOBS \|\| printSpoolWorkerQueued/);
  assert.match(serverSource, /startPrintSpoolOwnerPollScheduler\(\)/);
  assert.match(serverSource, /PRINT_SPOOL_INTERMEDIATE_STATUS_EVENTS/);
  assert.match(serverSource, /PRINT_SPOOL_LEGACY_MIRROR_ENABLED/);
  assert.match(serverSource, /PRINT_SPOOL_PRE_SEND_PROBE/);
  assert.match(serverSource, /PRINT_TCP_END_DELAY_MS/);
  assert.match(handlersSource, /"integration\.printSpoolLegacyMirror": handleInternalPrintSpoolLegacyMirror/);
});

test("print spool auto-print e' un endpoint interno con payload limitato", () => {
  const route = buildRouteRegistry().find(
    (entry) => entry.method === "POST" && entry.path === "/api/internal/print-spool/auto-print",
  );
  assert.ok(route);
  assert.equal(route.service, "integration");
  assert.equal(route.authRequired, true);
  assert.equal(route.handlerKey, "integration.printSpoolAutoPrint");
  assert.equal(route.maxBodySize, 262_144);

  const handlersSource = readFileSync(path.join(cassaDir, "routes", "route-handlers.js"), "utf8");
  const serverSource = backendSource;
  const ownerWorkflowSource = readFileSync(
    path.join(cassaDir, "modules", "print-spool", "auto-print-owner.js"),
    "utf8",
  );
  assert.match(handlersSource, /"integration\.printSpoolAutoPrint": handleInternalPrintSpoolAutoPrint/);
  assert.match(
    serverSource,
    /function withPrintLaneMutation[\s\S]+metricLabel:\s*options\.metricLabel/,
    "la label diagnostica privata deve essere separata dalla label metrica stabile",
  );
  assert.match(
    ownerWorkflowSource,
    /persistAutoPrintOwnerPlanWorkflow[\s\S]+["']normalizePlans["'][\s\S]+["']resolveDb["'][\s\S]+["']resolveSettings["'][\s\S]+["']enqueueBatch["'][\s\S]+["']printSpoolOwner["'],\s*["']total/,
    "il workflow owner deve esportare timer di fase a cardinalita costante",
  );
  assert.match(serverSource, /metricLabel:\s*["']owner auto-print batch["']/);
  assert.match(serverSource, /metricLabel:\s*["']async auto-print["']/);
});

test("waiter pause status stays read-only outside notification lane", () => {
  const routesByKey = new Map(buildRouteRegistry().map((route) => [`${route.method} ${route.path}`, route]));
  const statusRoute = routesByKey.get("POST /api/mobile/waiter-pause/status");
  assert.equal(statusRoute?.mutation, false);
  assert.equal(statusRoute?.readOnly, true);

  const serverSource = backendSource;
  const telemetrySource = readFileSync(
    path.join(cassaDir, "modules", "notifications", "waiter-pause-telemetry.js"),
    "utf8",
  );
  const writerSource = readFileSync(
    path.join(cassaDir, "modules", "notifications", "waiter-pause-writer.js"),
    "utf8",
  );
  const recoverySource = readFileSync(
    path.join(cassaDir, "modules", "notifications", "waiter-pause-recovery.js"),
    "utf8",
  );
  const mutationLaneSource = readFileSync(
    path.join(cassaDir, "modules", "queue", "mutation-lane.js"),
    "utf8",
  );
  const matcher = serverSource.match(/function isWaiterPauseLaneRequest\(method, pathname\) \{([\s\S]*?)\n\}/);
  assert.ok(matcher, "deve esistere il filtro dedicato alle lane pause cameriere");
  assert.match(matcher[1], /\/api\/mobile\/waiter-pause\/start/);
  assert.match(matcher[1], /\/api\/mobile\/waiter-pause\/stop/);
  assert.doesNotMatch(matcher[1], /startsWith\(["']\/api\/mobile\/waiter-pause\//);
  assert.match(serverSource, /kind:\s*["']waiterPauseLane["']/);
  assert.match(serverSource, /counterName:\s*["']waiterPauseLaneEnqueued["']/);
  assert.match(serverSource, /prefix === ["']waiter["'][\s\S]+waiterPauseLane/);
  assert.doesNotMatch(serverSource, /prefix === ["']waiter["'][\s\S]{0,120}\? notificationLane/);
  assert.match(
    serverSource,
    /async function enqueuePresenceMutation[\s\S]+requestMetricsStorage\.getStore\(\)[\s\S]+requestMetricsStorage\.run\(requestMetricsContext, mutator\)[\s\S]+onWait:\s*\(waitMs\)\s*=>\s*markRequestQueueTiming\(requestMetricsContext, laneKind, waitMs\)/,
  );
  assert.match(mutationLaneSource, /task\.onWait\?\.\(waitMs\)/);
  assert.match(mutationLaneSource, /typeof enqueueOptions\.onWait === ["']function["']/);
  assert.match(serverSource, /BACKEND_WAITER_PAUSE_SESSION_AUDIT_FASTPATH === "1"/);
  assert.match(serverSource, /async function writeWaiterPauseDb\(db, options = \{\}\) \{ return writeWaiterPauseFastDb\(db, options\); \}/);
  assert.match(serverSource, /writeWaiterPauseDb\(db, \{ metricLabel: "waiter\.pause\.start\.appStateWrite"[^\n]+sessionIds:[^\n]+auditEventIds:[^\n]+measure:/);
  assert.match(serverSource, /writeWaiterPauseDb\(db, \{ metricLabel: "waiter\.pause\.stop\.appStateWrite"[^\n]+sessionIds:[^\n]+auditEventIds:[^\n]+measure:/);
  assert.match(writerSource, /\["waiterPauses", "waiterDeferredCalls", "lastWriteAt"\]/);
  assert.match(writerSource, /writeSessionAuditFastDb/);
  assert.match(writerSource, /splitDomains: \["sessions", "auditEvents"\]/);
  assert.match(writerSource, /splitDomains: \["integration", "sessions", "auditEvents"\]/);
  assert.match(writerSource, /skipIntegrationFields/);
  assert.match(recoverySource, /buildWaiterPauseCorrelationId/);
  assert.match(serverSource, /async function reconcileWaiterPauseSideEffects/);
  assert.match(serverSource, /result\.reason === "already_paused"[\s\S]+reconcileWaiterPauseSideEffects\(\{ kind: "start"/);
  assert.match(serverSource, /result\.reason === "already_active"[\s\S]+reconcileWaiterPauseSideEffects\(\{ kind: "stop"/);
  assert.match(serverSource, /createWaiterPauseTelemetry/);
  assert.match(serverSource, /waiterPauseTelemetry\.start\("status"\)/);
  assert.match(serverSource, /waiterPauseTelemetry\.start\("start"\)/);
  assert.match(serverSource, /waiterPauseTelemetry\.start\("stop"\)/);
  assert.match(serverSource, /telemetry\.measure\("state\.appStateWrite"/);
  assert.match(serverSource, /telemetry\.measureSync\("realtime\.publish"/);
  assert.match(serverSource, /telemetry\.measureSync\(\s*"deferred\.waiterFlush"/);
  assert.match(serverSource, /result\.reason === "already_paused"/);
  assert.match(serverSource, /result\.reason === "already_active"/);
  assert.match(telemetrySource, /"waiterPauseWorkflow"/);
  assert.match(telemetrySource, /record\(`laneWait\.\$\{outcome\}`/);
});

test("route registry rejects accidental public mutations without explicit risk acceptance", () => {
  assert.throws(
    () => validateRouteDefinitions(
      [
        {
          method: "POST",
          path: "/api/unsafe/public-write",
          handlerKey: "unsafe.write",
          public: true,
          authRequired: false,
          mutation: true,
        },
      ],
      { ...dummyHandlers, "unsafe.write": () => {} }
    ),
    /allowPublicMutation|publicReason|maxBodySize/
  );
});

test("backend architecture/security audit passes without blocking findings", async () => {
  const child = spawn(process.execPath, ["cassa-frontend/scripts/backend-architecture-security-audit.mjs"], {
    cwd: projectDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, `${stdout}\n${stderr}`);
  assert.match(stdout, /route pubbliche mutative: 6/);
  assert.match(stdout, /backend\/server\.js resta monolitico/);
});

test("relational shadow dirty-domain filter follows write-primary order routes", () => {
  const serverSource = backendSource;
  assert.match(
    serverSource,
    /const RELATIONAL_SHADOW_DIRTY_DOMAIN_FILTER =\s*ORDERS_ANY_ASYNC_ACK \|\| RELATIONAL_ORDERS_ANY_WRITE_PRIMARY;/,
    "il filtro dirty shadow deve attivarsi anche con write-primary ordini, non solo con async ACK"
  );
  assert.match(
    serverSource,
    /dirtyDomains:\s*RELATIONAL_SHADOW_DIRTY_DOMAIN_FILTER[\s\S]*\?\s*writeContext\.dirtyDomains[\s\S]*:\s*\[\]/,
    "lo shadow relazionale deve ricevere i dirtyDomains reali anche quando async ACK e' spento"
  );
  assert.doesNotMatch(
    serverSource,
    /dirtyDomains:\s*ORDERS_ANY_ASYNC_ACK\s*\?\s*writeContext\.dirtyDomains\s*:\s*\[\]/,
    "la vecchia forma forzava full sync sessioni nel profilo write-primary non async"
  );
});

test("multiprocess order sync refreshes externalized fast-lane state only where needed", () => {
  const serverSource = backendSource;
  const orderTargetRefreshSource = readFileSync(
    path.join(
      cassaDir,
      "modules",
      "orders",
      "externalized-order-target-refresh.js",
    ),
    "utf8",
  );
  assert.match(
    serverSource,
    /async function refreshExternalizedSessionsForRead\(db, options = \{\}\)[\s\S]+options\?\.refreshExternalizedSessions !== true[\s\S]+mysqlSessionsSplitRepository\.hydrateAppState\(db\)/,
    "i processi worker devono reidratare le sessioni dalla fonte MySQL condivisa"
  );
  assert.match(
    orderTargetRefreshSource,
    /refreshExternalizedIntegrationOrderTarget[\s\S]+readObjectArrayEntry\([\s\S]+["']integration["'],\s*["']orders["'][\s\S]+findOrderIndex/,
    "orders/sync deve poter rileggere dal MySQL split solo la comanda richiesta"
  );
  assert.match(
    serverSource,
    /import \{ refreshExternalizedIntegrationOrderTarget \}[\s\S]+refreshExternalizedIntegrationOrderTarget\(db, options, \{ repository: mysqlAppStateDomainsSplitRepository/,
    "server.js deve limitarsi al wiring del refresh puntuale ordine",
  );
  assert.match(
    serverSource,
    /const shouldRefreshOrderSyncAuth =[\s\S]+requestUrl\.pathname === ["']\/api\/integration\/orders\/sync["'][\s\S]+const canRefreshOrderSyncTarget =[\s\S]+readObjectArrayEntry[\s\S]+refreshExternalizedIntegrationOrderId:\s*orderSyncTargetId[\s\S]+forceReload:\s*true,\s*refreshExternalizedSessions:\s*true/,
    "l'owner deve usare sessioni e ordine target condivisi, mantenendo il reload completo solo come fallback legacy"
  );
  assert.doesNotMatch(
    serverSource,
    /isApiWorkerAuth\s*\?\s*\{[^}]*refreshExternalizedTableLocks|isApiWorkerAuth\s*\?\s*\{[^}]*refreshExternalizedIntegrationSequence/,
    "il boundary auth non deve caricare lock tavolo o sequence non necessari alla validazione sessione",
  );
  assert.match(
    serverSource,
    /async function readTableWorkLockRequestDb\(req\)[\s\S]+req\?\.__authDb[\s\S]+RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY \|\| isTableWorkLockFastPathEnabled\(\)[\s\S]+refreshExternalizedSessions: true, refreshExternalizedTableLocks: true/,
    "i route lock devono riusare lo snapshot autenticato sui repository condivisi e conservare il fallback legacy",
  );
  assert.match(
    serverSource,
    /async function refreshExternalizedTableLocksForRead\(db, options = \{\}\)[\s\S]+listTableWorkLocks\(\)/,
    "il refresh scoped dei work lock tavolo deve leggere dalla fonte MySQL condivisa senza clonare lo stato"
  );
  assert.match(
    serverSource,
    /async function refreshExternalizedIntegrationSequenceForRead\(db, options = \{\}\)[\s\S]+readObjectEntry\(["']integration["'], ["']sequence["'][\s\S]+Math\.max\(localValue, remoteValue\)/,
    "il refresh scoped della sequence integra i contatori condivisi con merge a MAX (niente regressioni cross-process)"
  );
  assert.match(
    serverSource,
    /async function refreshExternalizedIntegrationStationStatesForRead\(db, options = \{\}\)[\s\S]+readObjectArrayField\(["']integration["'], ["']stationStates["'][\s\S]+filterPersistentIntegrationStationStates/,
    "menu e creazione comanda devono poter rileggere gli stati postazione dal dominio split condiviso"
  );
  assert.match(
    serverSource,
    /async function handleIntegrationMenu\(req, res, requestUrl = null\)[\s\S]+const db = await readDb\(\{\s*refreshExternalizedIntegrationStationStates:\s*true\s*\}\);/,
    "il menu integrazione deve vedere subito le postazioni attive aggiornate da altri processi"
  );
  assert.match(
    serverSource,
    /async function handleIntegrationOrderCreate\(req, res\)[\s\S]+const orderCreateTableId[\s\S]+const db = await readDb\(\{\s*operationMetricKind:\s*["']orderCreateRead["'],\s*parallelExternalizedTableLocksAndStationStates:\s*ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH,\s*refreshExternalizedSessions:\s*!req\.__authContext,\s*refreshExternalizedIntegrationStationStates:\s*true,\s*refreshExternalizedTableLocks:\s*!ORDER_CREATE_TARGETED_LOCK_REFRESH \|\| Boolean\(orderCreateTableId\),\s*refreshExternalizedTableLockId:\s*ORDER_CREATE_TARGETED_LOCK_REFRESH \? orderCreateTableId : ["']["'],?\s*\}\);/,
    "la creazione comanda deve riusare l'auth gia validata e vedere postazioni e lock target freschi sui worker"
  );
  assert.match(
    serverSource,
    /if \(isApiWorkerRequestAuthFastPathEnabled\(\)\)[\s\S]+apiWorkerRequestFastPath\.authenticate\(authPayload\)[\s\S]+const isApiWorkerAuth/,
    "l'API worker deve provare Redis e lookup sessione indicizzato prima dell'hydrate completo legacy",
  );
  assert.match(
    serverSource,
    /requireAuthSessionCacheInvalidation:\s*isAuthSessionRedisCacheRequired/,
    "login, logout e revoche devono invalidare la cache usata dagli API worker",
  );
  assert.match(
    serverSource,
    /async function handleIntegrationOrderSync\(req, res\)[\s\S]+const authContext =[\s\S]+req\.__authContext[\s\S]+\?\s*req\.__authContext[\s\S]+:\s*validateSessionContext\(db, payload\);/,
    "orders/sync non deve rivalidare la sessione contro il cache fast-lane quando la policy ha gia autenticato la richiesta"
  );
});

test("multiprocess login keeps externalized sessions additive", () => {
  const authSource = backendSource;
  assert.match(
    authSource,
    /const db = await readDb\(\{\s*refreshExternalizedSessions:\s*true\s*\}\);/,
    "il login deve partire dalle sessioni MySQL condivise prima di applicare la policy di concorrenza"
  );
  assert.match(
    authSource,
    /writeAuthSessionFastDb\(db,[\s\S]+metricLabel:\s*["']auth\.login\.sessionFastWrite["'][\s\S]+sessionIds:\s*\[session\.id\][\s\S]+deletedSessionIds:\s*revokedSessionIds[\s\S]+usersChanged:\s*userAuthorizationChanged/,
    "il login deve provare il fast write puntuale sessione/audit prima del fallback app-state"
  );
  assert.match(
    authSource,
    /metricLabel:\s*["']auth\.login\.appStateWrite["'][\s\S]+splitDomains:\s*\[["']sessions["'], ["']users["'], ["']auditEvents["']\][\s\S]+sessionsSync:\s*\{\s*deleteMissing:\s*false,\s*deleteSessionIds:\s*revokedSessionIds\s*\}/,
    "il login deve upsertare la nuova sessione senza potare quelle create da altri processi"
  );
});

test("multiprocess session split prunes only on explicit session removal", () => {
  const serverSource = backendSource;
  const authSource = backendSource;
  assert.match(
    serverSource,
    /function resolveSessionsSplitSyncOptions\(options = \{\}\)[\s\S]+syncOptions\.deleteMissing = syncOptions\.deleteMissing === true;/,
    "la sync sessioni deve essere additiva di default e potare solo con deleteMissing true esplicito"
  );
  assert.match(
    serverSource,
    /const sessionsSyncOptions = resolveSessionsSplitSyncOptions\(options\)[\s\S]+mysqlSessionsSplitRepository\.syncFromAppState\(\s*appState,\s*sessionsSyncOptions,\s*\)/,
    "il backend deve applicare la guardia additiva prima di sincronizzare app_state_sessions"
  );
  assert.match(
    serverSource,
    /async function writeAuthSessionFastDb\(db, options = \{\}\)[\s\S]+const sessionWriter = updateOnly[\s\S]+\?\s*mysqlSessionsSplitRepository\?\.updateEntriesFromAppState[\s\S]+:\s*mysqlSessionsSplitRepository\?\.syncEntriesFromAppState;[\s\S]+mysqlSessionsSplitRepository\.deleteSessions\(deletedSessionIds\)[\s\S]+sessionWriter\.call\(\s*mysqlSessionsSplitRepository,\s*db,\s*sessionIds\s*,?\s*\)[\s\S]+if \(auditEventIds\.length > 0\)\s*\{[\s\S]+syncOrderAuditEventsFastPath\(db, auditEventIds\)/,
    "login/logout devono poter scrivere sessioni e audit senza full app-state quando i domini sono esternalizzati"
  );
  assert.match(
    authSource,
    /metricLabel:\s*["']auth\.sessionStatus\.sessionFastWrite["'][\s\S]+sessionIds:\s*\[session\.id\][\s\S]+metricLabel:\s*["']auth\.sessionStatus\.appStateWrite["'][\s\S]+sessionsSync:\s*\{\s*deleteMissing:\s*false\s*\}/,
    "gli heartbeat/session status non devono potare sessioni di altri processi"
  );
  assert.match(
    authSource,
    /writeAuthSessionFastDb\(db,[\s\S]+metricLabel:\s*["']auth\.logout\.sessionFastWrite["'][\s\S]+deletedSessionIds:\s*\[session\.id\][\s\S]+auditEventIds:/,
    "il logout deve provare la cancellazione puntuale della sessione prima del fallback"
  );
  assert.match(
    authSource,
    /metricLabel:\s*["']auth\.logout\.appStateWrite["'][\s\S]+splitDomains:\s*\[["']sessions["'], ["']auditEvents["']\][\s\S]+sessionsSync:\s*\{\s*deleteMissing:\s*true\s*\}/,
    "il logout resta il percorso esplicito di rimozione della sessione"
  );
});

test("backend architecture/security gate treats current architecture debt as warnings", async () => {
  const child = spawn(process.execPath, ["cassa-frontend/scripts/architecture-security-gate.mjs"], {
    cwd: projectDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, `${stdout}\n${stderr}`);
  assert.match(stdout, /mutazioni pubbliche=6/);
  assert.doesNotMatch(stderr, /Auth token da query string non protetto/);
  assert.match(stderr, /backend\/server\.js resta monolitico/);
});

test("order create and print spool stay ahead of background heartbeats", () => {
  const serverSource = backendSource;
  const loadtestSource = readFileSync(
    path.join(cassaDir, "..", "scripts", "loadtest-full-capacity.mjs"),
    "utf8",
  );
  assert.match(
    serverSource,
    /ORDER_SYNC_FAST_LANE_MAX_CONCURRENCY[\s\S]+parsePositiveInt\(process\.env\.ORDER_SYNC_FAST_LANE_MAX_CONCURRENCY,\s*8\)[\s\S]+ORDER_SYNC_FAST_LANE_CONCURRENCY[\s\S]+parsePositiveInt\(process\.env\.ORDER_SYNC_FAST_LANE_CONCURRENCY,\s*6\)[\s\S]+ORDER_SYNC_FAST_LANE_MAX_CONCURRENCY/,
    "order lane deve tenere default prudente ma permettere canary espliciti oltre 8"
  );
  assert.match(
    serverSource,
    /ORDER_SYNC_FAST_LANE_BURST[\s\S]+parsePositiveInt\(process\.env\.ORDER_SYNC_FAST_LANE_BURST,\s*Math\.max\(ORDER_SYNC_FAST_LANE_CONCURRENCY \* 2,\s*12\)\)/,
    "il burst ordini deve scalare con la concorrenza invece di restare fisso sotto gli slot disponibili"
  );
  assert.match(
    serverSource,
    /function withPrintLaneMutation\([\s\S]+printLane\.enqueue\([\s\S]+fallback:\s*\(\)\s*=>\s*withDbMutation/,
    "la lane stampa deve mantenere il fallback serializzato quando non e' abilitata"
  );
  assert.match(
    serverSource,
    /withPrintLaneMutation\(\s*`async auto-print \$\{nextOrder\.id\}`,[\s\S]+\[`order:\$\{nextOrder\.id\}`\]/,
    "il fallback monolitico dell'auto-print non deve entrare direttamente nella coda globale"
  );
  assert.match(
    serverSource,
    /function scheduleOrderCreateAutoPrint\([\s\S]+backendProcessRouteGuard\.role === ["']api-worker["'][\s\S]+printSpoolAutoPrintOwnerQueue\.enqueue\(plan\.batchId, plan\)/,
    "l'api-worker deve inoltrare l'auto-print senza scrivere sul relazionale condiviso"
  );
  assert.match(
    serverSource,
    /runBatch:\s*async \(batch\)[\s\S]+printSpoolAutoPrintOwnerForwarder\.forward\(plans\)[\s\S]+throw new Error\(["']Owner auto-print non disponibile\./,
    "la coda owner deve ritentare senza fallback locale"
  );
  assert.match(
    serverSource,
    /createLatestByKeyBatchQueue\([\s\S]+metricPrefix: "printSpoolLegacyMirror"[\s\S]+printSpoolLegacyMirrorOwnerForwarder\.forward\(batch\)[\s\S]+flushPrintSpoolLegacyMirrorBatch\(batch\)[\s\S]+function mirrorLegacyPrintSpoolJobBestEffort[\s\S]+printSpoolLegacyMirrorQueue\.enqueue\(safeJob\.id, safeJob\)/,
    "il mirror legacy deve coalescere per job in una coda dedicata",
  );
  assert.doesNotMatch(
    serverSource,
    /runBatch:\s*\(batch\)\s*=>\s*withPrintLaneMutation\("print_spool_legacy_batch"/,
    "il mirror legacy non deve contendere la print lane autorevole",
  );
  assert.doesNotMatch(
    serverSource,
    /function mirrorLegacyPrintSpoolJobBestEffort[\s\S]{0,1200}withDbMutation\(/,
    "il mirror legacy SQL-primary non deve rientrare nella coda globale",
  );
  assert.doesNotMatch(
    serverSource,
    /withDbMutation\(\s*`async auto-print \$\{nextOrder\.id\}`/,
    "l'auto-print non deve piu' bloccare il refill della order lane con priorita urgente"
  );
  assert.match(
    loadtestSource,
    /PRINT_SPOOL_SQL_PRIMARY: "1"[\s\S]+LANE_PRINT: "1"[\s\S]+PRINT_LANE_ENABLED: "1"/,
    "il profilo P4 deve abilitare lo storage SQL richiesto dalla print lane",
  );
  assert.match(
    serverSource,
    /ORDER_WORKFLOW_FAST_LANE_PATHS = new Set\(\[\s*["']\/api\/integration\/orders\/create["']/,
    "orders/create deve entrare nella corsia veloce ordini"
  );
  for (const pathname of [
    "/api/integration/orders/replacement/bar-charge",
    "/api/orders/replacement/bar-charge",
    "/api/integration/orders/transfer/request",
    "/api/integration/orders/transfer/resolve",
    "/api/integration/orders/transfer/force",
  ]) {
    assert.match(
      serverSource,
      new RegExp(`["']${pathname.replaceAll("/", "\\/")}["']`),
      `${pathname} deve stare nella order lane, non nella coda mutativa globale`
    );
  }
  assert.match(
    serverSource,
    /normalizedLabel\.includes\(["']async auto-print["']\)\) return 4;/,
    "auto-print deve avere priorita operativa alta"
  );
  assert.match(
    serverSource,
    /normalizedLabel\.includes\(["']print_spool["']\)\) return 4;/,
    "spool di stampa deve restare davanti agli heartbeat"
  );
  assert.match(
    serverSource,
    /normalizedLabel\.includes\(["']\/api\/auth\/session\/status["']\)\) return 30;/,
    "heartbeat sessione non deve precedere comande e stampa"
  );
});

test("integration layout evita rebuild concorrenti con singleflight", () => {
  const serverSource = backendSource;
  assert.match(
    serverSource,
    /async function buildIntegrationLayoutCacheEntry\(\)[\s\S]+cacheGeneration = integrationHotCacheGeneration[\s\S]+cacheGeneration !== integrationHotCacheGeneration[\s\S]+createSingleflight\(buildIntegrationLayoutCacheEntry/,
  );
  assert.match(
    serverSource,
    /async function handleIntegrationLayout\(_req, res\)[\s\S]+cachedLayout \?\? await runIntegrationLayoutBuild\(\)[\s\S]+sendJsonString/,
  );
});

test("station heartbeat retries transient MySQL contention before exposing 500", () => {
  const serverSource = backendSource;
  const retrySource = readFileSync(
    path.join(cassaDir, "modules", "integration", "station-state-transient-retry.js"),
    "utf8",
  );
  assert.match(
    retrySource,
    /TRANSIENT_MYSQL_ROUTE_RETRY_CODES = new Set\(\[[\s\S]+ER_CHECKREAD[\s\S]+ER_LOCK_DEADLOCK[\s\S]+ER_LOCK_WAIT_TIMEOUT/,
    "la route heartbeat deve riconoscere i transient MySQL noti"
  );
  assert.match(
    retrySource,
    /function shouldRetryTransientMysqlStationStateRequest[\s\S]+isStationStateFastPathRequest\(req\?\.method, pathname\)[\s\S]+isTransientMysqlRouteError\(error\)/,
    "il retry transient deve restare limitato alla route stato postazione"
  );
  assert.match(
    serverSource,
    /catch \(error\) \{[\s\S]+await retryTransientMysqlStationStateRequest\(\{[\s\S]+pathname: requestUrl\.pathname[\s\S]+retry: \(\) => handleHttpRequest\(req, res\)[\s\S]+sendJson\(res, 500/,
    "il retry deve avvenire prima di trasformare il deadlock in HTTP 500"
  );
});

test("payment lane retries transient MySQL contention before exposing 500", () => {
  const serverSource = backendSource;
  assert.match(serverSource, /retryTransientMysqlPaymentRequest/);
  assert.match(serverSource, /isPaymentLaneRequest/);
});

test("station state fast path syncs one station entry and labels slow writes", () => {
  const serverSource = backendSource;
  assert.match(
    serverSource,
    /function integrationStationStateMysqlRecordId\(entry, position = 0\)[\s\S]+stationStates_\$\{position\}/,
    "il backend deve ricostruire la stessa record id usata dal domain split MySQL"
  );
  assert.match(
    serverSource,
    /async function writeIntegrationStationStatesDb\(db, options = \{\}\)[\s\S]+syncObjectArrayEntriesFromAppState\([\s\S]+["']integration["'],[\s\S]+["']stationStates["'],[\s\S]+stationStateIds[\s\S]+syncObjectArrayFieldFromAppState/,
    "il fast path station-state deve preferire la singola entry al full-array"
  );
  assert.match(
    serverSource,
    /writeIntegrationStationStatesDb[\s\S]+stationStateWorkflow["'],\s*["']mysqlWrite[\s\S]+stationStateWorkflow["'],\s*["']writeTotal/,
    "la persistenza station-state deve avere timer MySQL e totale stabili",
  );
  assert.match(serverSource, /stationStateHeartbeatPersistenceSkipped/);
  assert.match(serverSource, /stationStateHeartbeatPersistenceWrites/);
  assert.match(
    serverSource,
    /writeIntegrationStationStatesDb\(db,\s*\{[\s\S]+stationStateIds:\s*\[integrationStationStateMysqlRecordId\(nextEntry\)\]/,
    "l'heartbeat persistente deve passare l'ID puntuale della postazione"
  );
  assert.match(
    serverSource,
    /async function writeIntegrationStationPresenceDb\(db, options = \{\}\)[\s\S]+stationAvailabilityNotificationState[\s\S]+noActiveStationsAlert[\s\S]+syncObjectArrayEntriesAndObjectEntriesFromAppState\(db, ["']integration["'][\s\S]+fieldName: ["']stationStates["'][\s\S]+fieldName: ["']notifications["']/,
    "lo station-state offline/online semplice deve persistere stationStates e notifiche in modo puntuale"
  );
  assert.match(
    serverSource,
    /refreshPostazioneStationStateFromSessionHeartbeat\(db, options = \{\}\)[\s\S]+touchedStationStateIds[\s\S]+integrationStationStateMysqlRecordId\(nextEntry\)/,
    "l'heartbeat postazione deve raccogliere gli ID MySQL degli station state modificati",
  );
  assert.match(
    serverSource,
    /writeAuthSessionFastDb\(db, options = \{\}\)[\s\S]+if \(auditEventIds\.length > 0\)\s*\{\s*await syncOrderAuditEventsFastPath\(db, auditEventIds\);\s*\}/,
    "l'heartbeat senza eventi non deve avviare una sincronizzazione audit completa",
  );
  assert.match(
    serverSource,
    /canUsePresenceFastWrite = !sessionHeartbeatTouched[\s\S]+rebalancedOrders\.length === 0[\s\S]+writeIntegrationStationPresenceDb\(db,\s*\{[\s\S]+notificationIds: stationStateNotificationIds[\s\S]+syncNoActiveStationsAlert: noActiveStationsAlertChanged/,
    "il fast write presenza deve restare disattivato quando ci sono sessioni o ordini da ribilanciare"
  );
  assert.match(
    serverSource,
    /metricLabel:\s*["']stationState\.upsert\.appStateWrite["'][\s\S]+splitDomains:\s*\[["']integration["'], ["']sessions["'], ["']auditEvents["']\]/,
    "lo slow path station-state non deve ricadere nel route fallback generico"
  );
  assert.match(
    serverSource,
    /metricLabel:\s*["']stationState\.upsert\.appStateWrite["'][\s\S]+sessionsSync:\s*\{\s*deleteMissing:\s*false\s*\}/,
    "lo station-state puo aggiornare sessioni ma non potare quelle create da altri processi"
  );
});

test("station-state lastWriteAt coalescing resta diagnostico, monotono e isolato dagli eventi presenza", () => {
  const serverSource = backendSource;
  const flushSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "station-last-write-at-flush.js"),
    "utf8",
  );
  const repositorySource = readFileSync(
    path.join(cassaDir, "db", "app-state", "mysql-domains-split.repository.js"),
    "utf8",
  );
  const deploySource = readFileSync(
    path.join(appDir, "deploy", "systemd", "50-p3-orders-write-primary.conf"),
    "utf8",
  );
  const stationWriterStart = serverSource.indexOf(
    "async function writeIntegrationStationStatesDb",
  );
  const presenceWriterStart = serverSource.indexOf(
    "async function writeIntegrationStationPresenceDb",
  );
  const presenceWriterEnd = serverSource.indexOf(
    "const writePostazioneLogoutFastDb",
    presenceWriterStart,
  );
  const stationWriterSource = serverSource.slice(stationWriterStart, presenceWriterStart);
  const presenceWriterSource = serverSource.slice(presenceWriterStart, presenceWriterEnd);

  assert.match(deploySource, /Environment=BACKEND_STATION_STATE_LAST_WRITE_COALESCE=0\b/);
  assert.match(
    serverSource,
    /STATION_STATE_LAST_WRITE_COALESCE_REQUESTED\s*=\s*process\.env\.BACKEND_STATION_STATE_LAST_WRITE_COALESCE === ["']1["']/,
  );
  assert.match(
    stationWriterSource,
    /syncObjectArrayEntriesFromAppState[\s\S]+preserveNewerStationStates:\s*STATION_STATE_LAST_WRITE_COALESCE[\s\S]+stationStateLastWriteFlush\.enqueueFromAppState\(db\)[\s\S]+else if[\s\S]+syncObjectEntryFromAppState\(db, ["']integration["'], ["']lastWriteAt["']\)/,
    "il canary deve partire dopo la station entry e OFF deve conservare il writer canonico",
  );
  assert.equal(
    serverSource.match(/stationStateLastWriteFlush\.enqueueFromAppState\(db\)/g)?.length,
    1,
    "solo il writer heartbeat station-state puo accodare lastWriteAt",
  );
  assert.doesNotMatch(
    presenceWriterSource,
    /STATION_STATE_LAST_WRITE_COALESCE|stationStateLastWriteFlush/,
    "login/logout e cambi presenza devono restare fuori dal coalescing",
  );
  assert.match(
    presenceWriterSource,
    /normalizeIntegrationObjectFieldNames\(["']lastWriteAt["'], ["']stationAvailabilityNotificationState["'][\s\S]+syncObjectArrayEntriesAndObjectEntriesFromAppState\(db, ["']integration["'][\s\S]+objectFields/,
    "presence deve mantenere station state, notifiche e lastWriteAt nello stesso commit",
  );

  assert.match(flushSource, /function maxPayload\([\s\S]+timestampMs[\s\S]+Math\.max/);
  assert.match(
    flushSource,
    /payload\.timestampMs < highest\.timestampMs[\s\S]+ClockRegressions[\s\S]+pending = maxPayload\(pending, payload\)/,
    "la coda deve conservare il massimo timestamp anche con clock regressivo",
  );
  assert.match(
    flushSource,
    /async function recoverFromAppState[\s\S]+recoveryRequired[\s\S]+await writeTimestamp\(payload, \{ lockRowsNowait: false, mode: ["']recovery["'] \}\)[\s\S]+RecoveryWrites/,
  );
  assert.match(
    repositorySource,
    /async function syncIntegrationLastWriteAt[\s\S]+beginTransaction\(\)[\s\S]+lockRowsNowait:\s*options\.lockRowsNowait === true[\s\S]+preserveNewerIntegrationRecords:\s*true[\s\S]+commit\(\)[\s\S]+rollback\(\)/,
    "il flush deve usare un writer transazionale che non regredisce lastWriteAt",
  );
  assert.match(
    serverSource,
    /createStationLastWriteAtFlush\([\s\S]+lockRowsNowait = false[\s\S]+syncIntegrationLastWriteAt\(timestamp,\s*\{\s*appStatePosition:\s*position,\s*lockRowsNowait\s*\}\)/,
  );
  assert.match(
    serverSource,
    /await stationStateLastWriteFlush\.recoverFromAppState\(initialAppState\)/,
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    assert.match(
      serverSource,
      new RegExp(
        `process\\.on\\(["']${signal}["'][\\s\\S]+stationStateLastWriteFlush\\.drain\\(\\{ timeoutMs: 4_000 \\}\\)[\\s\\S]+closeBackendResourcesAndExit`,
      ),
      `${signal} deve drenare lastWriteAt prima della chiusura repository`,
    );
  }
});

test("order workflow retries transient MySQL contention before exposing 500", () => {
  const serverSource = backendSource;
  const retrySource = readFileSync(
    path.join(cassaDir, "modules", "integration", "station-state-transient-retry.js"),
    "utf8",
  );
  assert.match(
    retrySource,
    /function shouldRetryTransientMysqlOrderWorkflowRequest[\s\S]+isOrderSyncFastLaneRequest\(req\?\.method, pathname\)[\s\S]+isTransientMysqlRouteError\(error\)/,
    "il retry transient ordini deve restare limitato alle route della order lane"
  );
  assert.match(
    retrySource,
    /function retryTransientMysqlOrderWorkflowRequest[\s\S]+__transientMysqlOrderWorkflowRetryCount[\s\S]+await retry\(\)/,
    "il retry ordini deve usare un contatore dedicato e rilanciare la route"
  );
  assert.match(
    serverSource,
    /catch \(error\) \{[\s\S]+await retryTransientMysqlStationStateRequest\(\{[\s\S]+await retryTransientMysqlOrderWorkflowRequest\(\{[\s\S]+isOrderSyncFastLaneRequest[\s\S]+sendJson\(res, 500/,
    "il retry ordini deve avvenire prima di trasformare il deadlock in HTTP 500"
  );
});

test("payment stale order table mismatch is reported as recoverable conflict", () => {
  const serverSource = backendSource;
  assert.match(
    serverSource,
    /throw new HttpError\(\s*409,\s*["']Comanda non appartenente al tavolo selezionato\.[\s\S]+code: ["']PAYMENT_ORDER_NOT_IN_TABLE["']/,
    "il pagamento su comanda spostata deve essere un conflitto recuperabile, non un 400"
  );
});

test("domain lanes use pressure scheduling with bounded aging promotion", () => {
  const serverSource = backendSource;
  const crossDomainSchedulerBody =
    serverSource.match(
      /function scheduleCrossDomainCompatibleLaneTasks\(\) \{([\s\S]*?)\n\}/,
    )?.[1] ?? "";
  assert.match(
    serverSource,
    /import \{[^}]*selectHybridSchedulableLane[^}]*\} from ["']\.\/modules\/queue\/domain-lane-fairness\.js["']/,
    "il server deve usare il selettore ibrido condiviso"
  );
  assert.match(
    serverSource,
    /function buildDomainLaneScheduleCandidates\(\)[\s\S]+id: ["']order["'][\s\S]+id: ["']payment["'][\s\S]+id: ["']room["'][\s\S]+id: ["']reservation["'][\s\S]+id: ["']notification["'][\s\S]+id: ["']waiterPause["'][\s\S]+id: ["']stationState["']/,
    "tutte le domain lane devono partecipare alla selezione"
  );
  assert.match(
    serverSource,
    /function domainLaneNormalPriority\([\s\S]+PAYMENT_LANE_PRESSURE_PRIORITY_DEPTH[\s\S]+RESERVATION_LANE_PRESSURE_PRIORITY_DEPTH[\s\S]+ROOM_LANE_PRESSURE_PRIORITY_DEPTH[\s\S]+ORDER_LANE_PRESSURE_PRIORITY_DEPTH/,
    "il percorso normale deve conservare le priorita di pressione"
  );
  assert.match(
    serverSource,
    /function scheduleEligibleDomainLane\(\)[\s\S]+selectHybridSchedulableLane\([\s\S]+starvationWaitMs: DOMAIN_LANE_STARVATION_WAIT_MS[\s\S]+allowAgedPromotion: !domainLaneAgedPromotionYieldPending[\s\S]+selected\.schedule\(\)/,
    "l'aging deve essere una promozione limitata sopra lo scheduler di pressione"
  );
  assert.match(
    serverSource,
    /domainLaneAgedPromotionYieldPending = true[\s\S]+domainLaneAgedPromotions[\s\S]+domainLaneAgedPromotionYieldPending = false[\s\S]+domainLaneNormalTurns/,
    "una promozione aged deve essere seguita da un turno normale"
  );
  assert.match(
    serverSource,
    /function resetDomainLaneAgedPromotionCooldownIfDrained\(\)[\s\S]+isDomainLaneSchedulerDrained\([\s\S]+domainLaneAgedPromotionYieldPending = false[\s\S]+function scheduleNextDbMutationTask\(\)[\s\S]+resetDomainLaneAgedPromotionCooldownIfDrained\(\)/,
    "il cooldown aging non deve sopravvivere al drain completo delle domain lane"
  );
  assert.match(
    crossDomainSchedulerBody,
    /if \(!hasDomainLaneRunning\(\)\) \{[\s\S]+if \(scheduleEligibleDomainLane\(\)\) return true;[\s\S]+return printLane\.schedule\(\);/,
    "a scheduler idle una domain eleggibile deve precedere la print lane"
  );
  assert.match(
    serverSource,
    /function nextDomainLaneFairSequence\(\)[\s\S]+fairSequence: candidate\.metadata\?\.fairSequence/,
    "la scelta cross-lane deve usare una sequenza condivisa indipendente dal clock di parete"
  );
  assert.match(serverSource, /fairSequence: nextDomainLaneFairSequence\(\)/);
  assert.match(
    serverSource,
    /function beginDomainLaneTurn\(target\)[\s\S]+selectIdlePeerLaneIds\(\s*target,[\s\S]+orders: LANE_CROSS_EXCLUSION_ORDERS[\s\S]+tables: LANE_CROSS_EXCLUSION_TABLES[\s\S]+payments: LANE_CROSS_EXCLUSION_PAYMENTS[\s\S]+presence: LANE_CROSS_EXCLUSION_PRESENCE[\s\S]+idlePeerIds\.forEach\(\(id\) => resetDomainLaneBurst\(id\)\)/,
    "una lane compatibile ancora attiva non deve perdere il proprio conteggio burst"
  );
  assert.doesNotMatch(serverSource, /lastDomainLaneTurn/);
  assert.match(
    serverSource,
    /starvationWaitMs: DOMAIN_LANE_STARVATION_WAIT_MS[\s\S]+nextFairSequence: nextDomainLaneFairSequence/,
    "le lane serializzate devono promuovere le richieste anziane e condividere la sequenza fair"
  );
  assert.doesNotMatch(
    serverSource,
    /kind:\s*["']stationStateLane["'][\s\S]{0,900}hasPeerRunning:\s*\(\)\s*=>[\s\S]{0,180}orderSyncLaneRunning > 0/,
    "stationStateLane non deve restare bloccata solo perche' la order lane sta lavorando"
  );
});

test("reservation writes keep explicit split domains for lock-heavy paths", () => {
  const serverSource = backendSource;
  const reservationsSource = readFileSync(
    path.join(cassaDir, "modules", "reservations", "reservations.handlers.js"),
    "utf8",
  );
  assert.match(
    serverSource,
    /function resolveScopedWriteSplitDomains\(defaultDomains, options = \{\}\)[\s\S]+const explicitDomains = Array\.isArray\(options\.splitDomains\)[\s\S]+explicitDomains\.length > 0[\s\S]+defaultDomains/,
    "writeReservationDb deve rispettare splitDomains espliciti invece di reintrodurre sempre il set largo"
  );
  assert.match(
    serverSource,
    /async function writeReservationDb\(db, options = \{\}\)[\s\S]+resolveScopedWriteSplitDomains\(RESERVATION_WRITE_SPLIT_DOMAINS, options\)/,
    "writeReservationDb deve passare dal resolver scoped per supportare override stretti"
  );
  assert.match(
    serverSource,
    /metricLabel: options\.metricLabel \?\? ["']reservations\.appStateWrite["']/,
    "le scritture reservation devono avere una metrica app-state leggibile"
  );
  assert.match(
    reservationsSource,
    /const RESERVATION_LOCK_SPLIT_DOMAINS = \[["']posReservationLocks["']\]/,
    "i lock prenotazione devono avere un set domini dedicato"
  );
  assert.match(
    reservationsSource,
    /["']reservations\.lock\.appStateWrite["'][\s\S]+RESERVATION_LOCK_SPLIT_DOMAINS/,
    "acquire\/release lock non devono risincronizzare stati, tavoli e audit"
  );
  assert.match(
    reservationsSource,
    /tableUpdate\.changed === true[\s\S]+\? RESERVATION_TABLE_STATUS_SPLIT_DOMAINS[\s\S]+: RESERVATION_STATE_LOCK_SPLIT_DOMAINS/,
    "lo status reservation deve includere tavoli\/sala solo quando li modifica davvero"
  );
  assert.match(
    serverSource,
    /function applyRouteFallbackWriteScope[\s\S]+POST \/api\/pos\/reservations\/[\s\S]+reservations\.\$\{action === ["']lock["'] \? ["']lock["'] : action\}\.routeFallback\.appStateWrite/,
    "le write di fallback sulla route status prenotazioni devono essere etichettate e non restare route:*"
  );
  assert.match(
    serverSource,
    /function applyRouteFallbackWriteScope[\s\S]+splitDomains:\s*\[["']sessions["']\]/,
    "le write di fallback reservation devono sincronizzare solo sessions invece del default full-domain"
  );
});

test("room lane remains distinct from notifications under the fair scheduler", () => {
  const serverSource = backendSource;
  const notificationPaths = serverSource.match(/const NOTIFICATION_LANE_PATHS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
  assert.doesNotMatch(
    notificationPaths,
    /\/api\/pos\/room-change\/request|\/api\/integration\/layout\/table\/room-move\/request/,
    "le richieste Tavoli/Sale devono restare nella room lane, non nella notification lane"
  );
  assert.match(
    serverSource,
    /id: ["']room["'][\s\S]+metadata: nextRoomLaneTaskMetadata\(\)[\s\S]+canSchedule: canScheduleRoomLaneBatch\(\)[\s\S]+schedule: \(\) => scheduleNextRoomLaneTask\(\)/,
    "la room lane deve fornire metadata, eleggibilita e callback al selettore equo"
  );
});

test("order lane prioritizes live workflow before station reconciliation", () => {
  const serverSource = backendSource;
  const orderLaneMetricsSource = readFileSync(path.join(cassaDir, "modules", "orders", "order-lane-metrics.js"), "utf8");
  const terminalDuplicatePreLaneSource = readFileSync(path.join(cassaDir, "modules", "orders", "terminal-duplicate-sync-prelane.js"), "utf8");
  const canScheduleBody = serverSource.match(
    /function canScheduleOrderSyncLaneBatch\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? "";
  assert.doesNotMatch(
    canScheduleBody,
    /orderSyncLaneRunning > 0/,
    "order lane deve ricaricare gli slot liberi mentre altri worker sono gia' attivi"
  );
  assert.match(
    serverSource,
    /function orderSyncLaneTaskPriority\(label\)[\s\S]+station reconciliation[\s\S]+return 4[\s\S]+\/api\/integration\/orders\/create[\s\S]+return 2[\s\S]+return 2/,
    "create/sync/correzioni devono essere workflow live davanti alla riconciliazione postazione"
  );
  assert.match(
    serverSource,
    /candidate\.priority < orderSyncLaneQueue\[selectedIndex\]\.priority/,
    "la order lane deve scegliere anche per priorita, non solo FIFO"
  );
  assert.match(
    orderLaneMetricsSource,
    /function summarizeItems\(items, rawOrder = \{\}\)[\s\S]+lines:[\s\S]+qty:[\s\S]+routes:[\s\S]+notes:/,
    "order lane deve esporre bucket diagnostici per correlare il p95 con dimensione e motivo workflow"
  );
  assert.match(
    orderLaneMetricsSource,
    /function workflowBucket\(value\)[\s\S]+delivered[\s\S]+ready[\s\S]+wf=\$\{workflowBucket\(rawOrder\?\.workflowStatus \?\? payload\.workflowStatus\)\}/,
    "order lane deve separare le sync per workflow richiesto, non solo per reason"
  );
  assert.match(
    serverSource,
    /isTerminalDuplicateSync = isTerminalDuplicateOrderSyncNoop\(currentOrder,\s*requestedWorkflowStatus,\s*rawOrder\)[\s\S]+!RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY && isTerminalDuplicateSync[\s\S]+orderTerminalDuplicateSyncNoops[\s\S]+idempotent:\s*true[\s\S]+noop:\s*true/,
    "il fallback dentro handler deve lasciare il no-op app-state solo fuori dal write-primary relazionale"
  );
  assert.match(
    serverSource,
    /readRelationalOrderById:\s*\(orderId\) => findRelationalOrderById\(\{[\s\S]+tryHandleTerminalDuplicateOrderSyncPreLane\(req, res, pathname[\s\S]+withOrderSyncLaneMutation/,
    "le sync terminali duplicate devono provare il no-op relazionale prima di entrare nella order lane"
  );
  assert.match(
    terminalDuplicatePreLaneSource,
    /READY_DUPLICATE_SYNC_STATUS_ONLY_FIELDS[\s\S]+isStatusOnlyReadyDuplicateOrderSync[\s\S]+isTerminalDuplicateOrderSyncNoop[\s\S]+currentOrder\.workflowStatus === "ready"[\s\S]+requestedWorkflowStatus === "ready"[\s\S]+relationalSyncWritePrimary === true[\s\S]+readRelationalOrderById[\s\S]+orderTerminalDuplicateSyncRelationalPreLaneNoops[\s\S]+source,\s*order: currentOrder/,
    "il pre-lane terminale deve usare il relazionale quando il write-primary e' attivo e limitare i ready duplicate ai payload status-only"
  );
  assert.match(
    serverSource,
    /withOrderSyncLaneMutation\(\s*orderLaneMetricLabeler\.buildLabel\(req, pathname\)/,
    "orders/create e orders/sync devono usare label diagnostiche prima di entrare nella order lane"
  );
  assert.match(
    serverSource,
    /rememberOrder\(nextOrder\)[\s\S]+rememberOrder\(mergedOrder\)/,
    "le sync devono poter ereditare i bucket dell'ordine gia' visto senza leggere il DB prima della coda"
  );
  assert.match(
    serverSource,
    /function isStationOrdersReconciliationBackpressureActive\(\)[\s\S]+orderSyncLaneRunning > 0[\s\S]+orderSyncLiveWorkflowQueueDepth\(\) >= STATION_ORDERS_RECONCILIATION_PRESSURE_DEPTH/,
    "la riconciliazione postazione deve poter essere differita quando la order lane e sotto pressione"
  );
  assert.match(
    serverSource,
    /createStationOrdersPollReconciliationScheduler\(\{[\s\S]+backpressureDelayMs: STATION_ORDERS_RECONCILIATION_BACKPRESSURE_DELAY_MS[\s\S]+deferInitialSchedule: true[\s\S]+isBackpressureActive: isStationOrdersReconciliationBackpressureActive/,
    "lo scheduler postazione deve ricevere il backpressure della order lane"
  );
});

test("order financial sync updates posSettings tables without full-domain fallback", () => {
  const serverSource = backendSource;
  assert.match(
    serverSource,
    /objectEntryDomains:\s*\[[^\]]*["']integration["'][^\]]*["']posSettings["'][^\]]*\]/,
    "posSettings deve restare serializzato a object-entry per aggiornare tables a grana fine"
  );
  assert.match(
    serverSource,
    /posSettings:\s*\[[^\]]*["']tables["'][^\]]*\]/,
    "posSettings.tables deve restare configurato come array annidato a entry"
  );
  assert.match(
    serverSource,
    /function syncPosSettingsTablesFastPath[\s\S]+const syncState = buildPosSettingsTablesSyncState\(db\)[\s\S]+syncObjectArrayEntriesFromAppState\(syncState,\s*["']posSettings["'],\s*["']tables["'],\s*ids\)/,
    "il fast path ordini deve sincronizzare solo i tavoli finanziariamente cambiati"
  );
  assert.match(
    serverSource,
    /function syncPosSettingsTablesFastPath[\s\S]+syncObjectArrayFieldFromAppState\(syncState,\s*["']posSettings["'],\s*["']tables["']\)/,
    "il refresh completo dei tavoli non deve riscrivere le altre entry posSettings"
  );
  assert.match(
    serverSource,
    /function syncPosTableFinancialsFromIntegrationOrders[\s\S]+const changedTableIds = new Set\(\)[\s\S]+changedTableIds\.add\(tableFinancialPlan\.tableId\)[\s\S]+tableIds:\s*\[\.\.\.changedTableIds\]/,
    "il ricalcolo finanziario deve restituire gli id tavolo realmente modificati"
  );
  assert.match(
    serverSource,
    /financialSync = syncPosTableFinancialsFromIntegrationOrders[\s\S]+runtimeMetrics\.incrementCounter\(\s*financialSync\.changed[\s\S]+orderSyncTableStateChanged[\s\S]+orderSyncTableStateNoops/,
    "orders/sync deve misurare se il side effect tavolo e' changed oppure no-op"
  );
  assert.match(
    serverSource,
    /orders\.create\.appStateWrite[\s\S]+syncPosSettings:\s*financialSync\.changed === true[\s\S]+posSettingsTableIds:\s*financialSync\.tableIds/,
    "la create ordine non deve forzare sync posSettings quando il tavolo non e' cambiato"
  );
});

test("order workflow fast path exposes per-step runtime metrics", () => {
  const serverSource = backendSource;
  const writerStart = serverSource.indexOf("async function writeIntegrationOrderSyncDb");
  const writerEnd = serverSource.indexOf(
    "async function handleInternalOrderAsyncAppStateFlush",
    writerStart,
  );
  const writerSource = serverSource.slice(writerStart, writerEnd);
  assert.match(
    serverSource,
    /runtimeMetrics\.recordOperation\(["']orderWorkflowStep["'],\s*`\$\{stepPrefix\}\.\$\{label\}`/,
    "la fast path ordini deve misurare i sotto-step con prefisso create/sync"
  );
  for (const label of [
    "mysql.integrationBulk",
    "mysql.posSettingsTables",
    "auditRecent",
    "printSpoolSplit",
  ]) {
    assert.match(
      serverSource,
      new RegExp(`recordStep\\(["']${label.replace(".", "\\.")}["']`),
      `metrica orderWorkflowStep mancante per ${label}`
    );
  }
  assert.match(
    serverSource,
    /writeTableRoomMoveRequestAppStateFastDb\(db, \{ requestId: request\.requestId, notificationIds: notification\?\.id \? \[notification\.id\] : \[\]/,
    "tableRoomMove request deve provare il writer puntuale prima del fallback precedente"
  );
  assert.match(
    writerSource,
    /syncObjectArrayEntriesAndObjectEntriesFromAppState\(db,\s*["']integration["'][\s\S]+fieldName:\s*["']orders["'][\s\S]+fieldName:\s*["']notifications["'][\s\S]+fieldName:\s*["']orderFulfillmentHistory["'][\s\S]+objectFields:\s*integrationObjectFields/,
    "il fast path ordini deve accorpare entries e object fields integration in una sola acquisizione MySQL"
  );
  assert.match(
    writerSource,
    /normalizeIntegrationObjectFieldNames\(options\.integrationObjectFields,\s*["']lastWriteAt["']/,
    "lastWriteAt deve restare nel set canonico prima della partizione protetta dal flag",
  );
  assert.doesNotMatch(
    writerSource,
    /recordStep\(["']mysql\.lastWriteAt["']|syncIntegrationLastWriteAt/,
    "il vecchio secondo writer non protetto deve restare assente",
  );
});

test("mysql order entry sync uses batch upsert fast path", () => {
  const serverSource = backendSource;
  const domainsRepositorySource = readFileSync(
    path.join(cassaDir, "db", "app-state", "mysql-domains-split.repository.js"),
    "utf8",
  );
  assert.match(
    serverSource,
    /orderEntryBatchUpsert:\s*process\.env\.BACKEND_MYSQL_ORDER_ENTRY_BATCH_UPSERT === ["']1["']/,
    "il batch orders deve restare un canary esplicito, non default"
  );
  assert.match(domainsRepositorySource, /function upsertDomainRowsBatch\(connection, rows, metricPrefix = ["']["']\)/);
  assert.match(
    domainsRepositorySource,
    /orderEntryBatchUpsert && normalizedDomain === INTEGRATION_DOMAIN && normalizedFieldName === INTEGRATION_ORDERS_FIELD[\s\S]+upsertDomainRowsBatch\(connection, entryRows, metricPrefix\)[\s\S]+syncOrderStationIndex\(connection, normalizedDomain, normalizedFieldName, entryRows/,
    "integration.orders deve usare batch upsert per ID espliciti mantenendo indice postazioni"
  );
  assert.match(
    domainsRepositorySource,
    /async function syncObjectArrayEntriesAndObjectEntriesFromAppState[\s\S]+const metricPrefix = `\$\{normalizedDomain\}\.bulkEntries`[\s\S]+syncOrderStationIndex\([\s\S]+INTEGRATION_ORDERS_FIELD[\s\S]+syncObjectArrayEntriesAndObjectEntriesFromAppState,/,
    "integration bulk deve usare una transazione unica mantenendo indice ordini/postazioni"
  );
  assert.doesNotMatch(
    domainsRepositorySource,
    /const rollbackStartedAt = Date\.now\(\);\s*const rollbackStartedAt = Date\.now\(\);/,
    "il rollback del fast path domini non deve contenere dichiarazioni duplicate"
  );
});

test("print spool fallback write is scoped and never inherits order route labels", () => {
  const serverSource = backendSource;
  const printSpoolWriter = serverSource.match(/async function writePrintSpoolDb[\s\S]*?\n}\n\nasync function withDbMutation/)?.[0] ?? "";
  assert.doesNotMatch(printSpoolWriter, /await writeDb\(db\);/);
  assert.match(printSpoolWriter, /printSpool\.sync\.appStateWrite/);
  assert.match(printSpoolWriter, /splitDomains: \[["']printSpoolJobs["']\]/);
});

test("background app-state flushes use their own metric label", () => {
  const serverSource = backendSource;
  const flushSource = serverSource.match(/function scheduleAppStateBackgroundFlush[\s\S]*?\n}\n\nconst INTEGRATION_ORDER_WRITE_SPLIT_DOMAINS/)?.[0] ?? "";
  assert.match(flushSource, /metricLabel: `\$\{label\}\.backgroundFlush\.appStateWrite`/);
  assert.doesNotMatch(flushSource, /await writeDb\(snapshot,\s*flushOptions\)/);
});

test("order route fallback writes are labeled and scoped", () => {
  const serverSource = backendSource;
  const fallbackSource = serverSource.match(/function applyRouteFallbackWriteScope[\s\S]*?\n}\n\nfunction resolveScopedWriteSplitDomains/)?.[0] ?? "";
  assert.match(fallbackSource, /orderPrefix = ["']POST \/api\/integration\/orders\/["']/);
  assert.match(fallbackSource, /orders\.\$\{orderAction\}\.routeFallback\.appStateWrite/);
  assert.match(fallbackSource, /splitDomains: INTEGRATION_WORKFLOW_WRITE_SPLIT_DOMAINS/);
});

test("order audit sync uses explicit event ids before recent-window fallback", () => {
  const serverSource = backendSource;
  assert.match(
    serverSource,
    /function collectAuditEventIdsSince\(db, startIndex = 0\)/,
    "gli handler ordini devono poter raccogliere gli audit creati dalla singola mutazione"
  );
  assert.match(
    serverSource,
    /async function syncMysqlOrderAuditEventsFastPath[\s\S]+ids\.length > 0[\s\S]+syncEntriesFromAppState\(db, ids\)[\s\S]+syncRecentFromAppState\(db\)[\s\S]+async function syncSecondaryOrderAuditEventsFastPath[\s\S]+ids\.length > 0[\s\S]+syncEntriesFromAppState\(db, ids\)[\s\S]+syncRecentFromAppState\(db\)[\s\S]+async function syncOrderAuditEventsFastPath[\s\S]+syncMysqlOrderAuditEventsFastPath\(db, auditEventIds\)[\s\S]+syncSecondaryOrderAuditEventsFastPath\(db, auditEventIds\)/,
    "il fast path audit deve preferire gli ID espliciti prima della finestra recente"
  );
  assert.match(
    serverSource,
    /auditEventIds:\s*collectAuditEventIdsSince\(db, auditStartIndex\)/,
    "orders/sync deve passare solo gli audit aggiunti dalla mutazione"
  );
});

test("mysql audit split batches explicit audit upserts", () => {
  const auditRepositorySource = readFileSync(
    path.join(cassaDir, "db", "app-state", "mysql-audit-events-split.repository.js"),
    "utf8",
  );
  assert.match(auditRepositorySource, /function upsertAuditRows\(connection, rows\)/);
  assert.match(auditRepositorySource, /VALUES \$\{placeholders\}/);
  assert.match(auditRepositorySource, /rows\.flatMap\(auditRowParams\)/);
  assert.doesNotMatch(auditRepositorySource, /for \(const row of rows\) \{[\s\S]{0,240}await connection\.query\(/);
});

test("order async ACK defers mirror writes only behind relational write-primary", () => {
  const serverSource = backendSource;
  const flushModuleSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "order-async-appstate-flush.js"),
    "utf8",
  );
  for (const [operation, relationalFlag] of [
    ["CREATE", "CREATE"],
    ["SYNC", "SYNC"],
    ["CANCEL", "CANCEL"],
    ["COMP", "COMP"],
    ["CORRECT", "CORRECT"],
    ["BAR_REPLACEMENT", "BAR_REPLACEMENT"],
    ["TRANSFER_FORCE", "TRANSFER_FORCE"],
  ]) {
    assert.match(
      serverSource,
      new RegExp(
        `ORDERS_${operation}_ASYNC_ACK = ORDERS_${operation}_ASYNC_ACK_REQUESTED && RELATIONAL_ORDERS_${relationalFlag}_WRITE_PRIMARY`,
      ),
      `l'async ACK ${operation} deve restare vincolato al write-primary relazionale`,
    );
  }
  assert.match(
    serverSource,
    /ORDERS_ANY_ASYNC_ACK =[^;]+\|\| ORDERS_TRANSFER_FORCE_ASYNC_ACK;/,
    "il drain/recovery comune deve includere il trasferimento forzato",
  );
  assert.match(
    serverSource,
    /if \(options\.defer === true && orderAsyncAppStateFlushQueue\.tryDefer\(options\)\)[^\n]+\.deferred`/,
    "il ramo defer deve vivere dentro writeIntegrationOrderSyncDb e registrare la metrica .deferred"
  );
  assert.match(
    serverSource,
    /metricLabel: ["']orders\.create\.appStateWrite["'], defer: ORDERS_CREATE_ASYNC_ACK/,
    "orders/create deve passare defer: ORDERS_CREATE_ASYNC_ACK"
  );
  assert.match(
    serverSource,
    /defer: ORDERS_SYNC_ASYNC_ACK,/,
    "orders/sync deve passare defer: ORDERS_SYNC_ASYNC_ACK"
  );
  assert.match(
    serverSource,
    /metricLabel: ["']orders\.cancel\.appStateWrite["'][^\n]+defer: ORDERS_CANCEL_ASYNC_ACK/,
    "orders/cancel deve passare defer: ORDERS_CANCEL_ASYNC_ACK"
  );
  assert.match(
    serverSource,
    /metricLabel:\s*`\$\{orderCompMetricPrefix\}\.appStateWrite`[^\n]+defer: ORDERS_COMP_ASYNC_ACK/,
    "orders/comp deve passare defer: ORDERS_COMP_ASYNC_ACK"
  );
  assert.match(
    serverSource,
    /integrationObjectFields:\s*\[[^\n]*["']orderCorrections["'][^\n]+metricLabel: ["']orders\.correct\.appStateWrite["'][^\n]+defer: ORDERS_CORRECT_ASYNC_ACK/,
    "orders/correct deve passare defer: ORDERS_CORRECT_ASYNC_ACK conservando orderCorrections"
  );
  assert.match(
    serverSource,
    /integrationObjectFields:\s*\[[^\n]*["']barChargeReplacements["'][^\n]+metricLabel: ["']orders\.barReplacement\.appStateWrite["'][^\n]+defer: ORDERS_BAR_REPLACEMENT_ASYNC_ACK/,
    "orders/barReplacement deve passare defer: ORDERS_BAR_REPLACEMENT_ASYNC_ACK conservando barChargeReplacements"
  );
  assert.match(
    serverSource,
    /metricLabel: ["']orders\.transfer\.force\.appStateWrite["'][^\n]+defer: ORDERS_TRANSFER_FORCE_ASYNC_ACK/,
    "orders/transfer/force deve differire solo il mirror dopo il commit relazionale",
  );
  assert.match(serverSource, /SHOULD_RUN_BACKEND_OWNER_JOBS && ORDERS_ANY_ASYNC_ACK/);
  assert.match(
    serverSource,
    /process\.on\(["']SIGINT["'], \(\) => \{ void Promise\.all\(\[orderAsyncAppStateFlushQueue\.drain[\s\S]+printSpoolAutoPrintOwnerQueue\.drain[\s\S]+printSpoolLegacyMirrorQueue\.drain/,
    "SIGINT deve drenare ordini, auto-print owner e mirror stampa prima di chiudere"
  );
  assert.match(
    serverSource,
    /process\.on\(["']SIGTERM["'], \(\) => \{ void Promise\.all\(\[orderAsyncAppStateFlushQueue\.drain[\s\S]+printSpoolAutoPrintOwnerQueue\.drain[\s\S]+printSpoolLegacyMirrorQueue\.drain/,
    "SIGTERM deve drenare ordini, auto-print owner e mirror stampa prima di chiudere"
  );
  assert.match(
    flushModuleSource,
    /orders\.asyncFlush\.appStateWrite/,
    "il flush in background deve usare la label dedicata orders.asyncFlush.appStateWrite"
  );
  assert.match(
    serverSource,
    /mergeRelationalOrdersIntoHydratedState\(\{ enabled: true, relationalRuntime, state: hydrated/,
    "la riconciliazione deve avvenire in idratazione, prima che qualunque write shadow possa cancellare ordini dal relazionale"
  );
  assert.match(
    serverSource,
    /persistReconciledOrders\(\{ pending: pendingOrdersStartupReconcile/,
    "gli ordini riconciliati vanno persistiti esplicitamente nel mirror dopo il boot"
  );
});

test("order posSettings fast-path non persiste lock tavolo esternalizzati", () => {
  const serverSource = backendSource;
  assert.match(
    serverSource,
    /function buildPosSettingsTablesSyncState\(db\)[\s\S]+workLock: null/,
    "i lock tavolo esternalizzati devono essere rimossi dalla vista posSettings prima del sync"
  );
  assert.match(
    serverSource,
    /const syncState = buildPosSettingsTablesSyncState\(db\)[\s\S]+syncObjectArrayEntriesFromAppState\(syncState, ["']posSettings["'], ["']tables["'], ids\)[\s\S]+tableStateSplitRepository\.syncFromAppState\(syncState\)/,
    "il fast-path posSettings.tables deve sincronizzare la vista senza workLock"
  );
  assert.match(
    serverSource,
    /ORDER_CREATE_TARGETED_LOCK_REFRESH = process\.env\.BACKEND_ORDER_CREATE_TARGETED_LOCK_REFRESH === ["']1["'][\s\S]+async function handleIntegrationOrderCreate[\s\S]+const orderCreateTableId[\s\S]+refreshExternalizedTableLocks: !ORDER_CREATE_TARGETED_LOCK_REFRESH \|\| Boolean\(orderCreateTableId\)[\s\S]+refreshExternalizedTableLockId: ORDER_CREATE_TARGETED_LOCK_REFRESH \? orderCreateTableId : ["']["'][\s\S]+assertActiveTableWorkLock\(db, tableId,[\s\S]+clearEmbeddedTableWorkLock\(db, tableId\)/,
    "orders/create deve poter leggere solo il lock del tavolo target e non lasciare workLock nella cache del worker"
  );
  assert.match(
    serverSource,
    /ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH = process\.env\.BACKEND_ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH === ["']1["'][\s\S]+parallelExternalizedTableLocksAndStationStates:\s*ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH/,
    "orders/create deve mantenere il refresh parallelo dietro un flag default OFF",
  );
  const parallelRefreshSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "order-create-read-refresh.js"),
    "utf8",
  );
  assert.match(parallelRefreshSource, /Promise\.all\(\[/);
  assert.match(
    parallelRefreshSource,
    /const \[tableLocksDb, stationStatesDb\][\s\S]+db\.posSettings = tableLocksDb\.posSettings[\s\S]+db\.integration =/,
    "il merge deve avvenire soltanto dopo il successo di entrambi i refresh",
  );
  assert.match(
    serverSource,
    /async function handleIntegrationOrderCancel[\s\S]+readDb\(\{[\s\S]*?refreshExternalizedSessions:\s*true,[\s\S]*?refreshExternalizedTableLocks:\s*true[\s\S]*?\}\)[\s\S]+assertActiveTableWorkLock\(db, tableId,[\s\S]+clearEmbeddedTableWorkLock\(db, tableId\)/,
    "orders/cancel deve leggere lock esterni freschi e non lasciare workLock nella cache del worker"
  );
});

test("table locks and order workflow do not revalidate against stale worker sessions", () => {
  const serverSource = backendSource;
  assert.match(
    serverSource,
    /async function readTableWorkLockRequestDb\(req\)[\s\S]+req\?\.__authDb[\s\S]+RELATIONAL_TABLE_LOCKS_WRITE_PRIMARY \|\| isTableWorkLockFastPathEnabled\(\)[\s\S]+refreshExternalizedSessions: true, refreshExternalizedTableLocks: true/,
    "il fast path lock deve riusare la sessione gia validata e conservare il fallback legacy autoritativo",
  );
  for (const handlerName of [
    "handleTableLockAcquire",
    "handleTableLockHeartbeat",
    "handleTableLockRelease",
    "handleTableLockForceRelease",
  ]) {
    const start = serverSource.indexOf(`async function ${handlerName}`);
    assert.notEqual(start, -1, `${handlerName} deve esistere`);
    const end = serverSource.indexOf("\nasync function ", start + 1);
    const source = serverSource.slice(start, end === -1 ? undefined : end);
    assert.match(source, /readTableWorkLockRequestDb\(req\)/);
    assert.doesNotMatch(source, /readDb\(\{[\s\S]*refreshExternalizedTableLocks/);
    assert.match(source, /req\.__authContext[\s\S]+validateSessionContext\(db, payload\)/);
  }

  for (const handlerName of [
    "handleIntegrationOrderCreate",
    "handleIntegrationOrderSync",
  ]) {
    const start = serverSource.indexOf(`async function ${handlerName}`);
    assert.notEqual(start, -1, `${handlerName} deve esistere`);
    const end = serverSource.indexOf("\nasync function ", start + 1);
    const source = serverSource.slice(start, end === -1 ? undefined : end);
    assert.match(source, /refreshExternalizedSessions:\s*!req\.__authContext/);
    assert.match(source, /req\.__authContext[\s\S]+validateSessionContext\(db, payload\)/);
  }

  for (const handlerName of [
    "handleIntegrationOrderCancel",
    "handleIntegrationOrderLineSplit",
    "handleIntegrationOrderLinePriceOverride",
    "handleIntegrationOrderComp",
    "handleIntegrationOrderCorrection",
  ]) {
    const start = serverSource.indexOf(`async function ${handlerName}`);
    assert.notEqual(start, -1, `${handlerName} deve esistere`);
    const end = serverSource.indexOf("\nasync function ", start + 1);
    const source = serverSource.slice(start, end === -1 ? undefined : end);
    assert.match(source, /refreshExternalizedSessions:\s*true/);
    assert.match(source, /req\.__authContext[\s\S]+validateSessionContext\(db, payload\)/);
  }

  const compFastRejectStart = serverSource.indexOf(
    "async function tryFastRejectIntegrationOrderComp",
  );
  const compFastRejectEnd = serverSource.indexOf(
    "\nasync function ",
    compFastRejectStart + 1,
  );
  const compFastRejectSource = serverSource.slice(
    compFastRejectStart,
    compFastRejectEnd,
  );
  assert.match(compFastRejectSource, /refreshExternalizedTableLocks:\s*true/);

  const compStart = serverSource.indexOf(
    "async function handleIntegrationOrderComp",
  );
  const compEnd = serverSource.indexOf("\nasync function ", compStart + 1);
  const compSource = serverSource.slice(compStart, compEnd);
  assert.match(compSource, /refreshExternalizedTableLocks:\s*true/);
});

test("payments read the authoritative cross-process table lock", () => {
  const paymentSource = readFileSync(
    path.join(cassaDir, "modules", "payments", "payments.handlers.js"),
    "utf8",
  );
  for (const handlerName of ["handlePayTable", "handlePaymentFreeSplit"]) {
    const start = paymentSource.indexOf(`function ${handlerName}`);
    assert.notEqual(start, -1, `${handlerName} deve esistere`);
    const end = paymentSource.indexOf("\n  async function ", start + 1);
    const source = paymentSource.slice(start, end === -1 ? undefined : end);
    assert.match(source, /refreshExternalizedSessions:\s*!req\.__authContext/);
    assert.match(source, /refreshExternalizedTableLocks:\s*true/);
    assert.match(source, /refreshExternalizedTableLockId:\s*tableId/);
    assert.match(source, /req\.__authContext[\s\S]+validateSessionContext\(db, payload\)/);
    assert.ok(
      source.indexOf("assertActiveTableWorkLock") < source.indexOf("syncPosTableFinancialsFromIntegrationOrders"),
      `${handlerName} deve validare il lock autoritativo prima del financial sync`,
    );
  }
});

test("payment lane conserva il contesto metriche della richiesta accodata", () => {
  const serverSource = backendSource;
  const admissionSource = readFileSync(
    path.join(cassaDir, "modules", "queue", "payment-lane-admission.js"),
    "utf8",
  );
  const start = serverSource.indexOf("async function withPaymentLaneMutation");
  const end = serverSource.indexOf("\nasync function withRoomLaneMutation", start);
  const paymentLaneSource = serverSource.slice(start, end);
  assert.notEqual(start, -1);
  assert.match(
    paymentLaneSource,
    /enqueuePaymentLaneTaskWithAdmission\(\{[\s\S]+?action:\s*\(\)\s*=>\s*requestMetricsStorage\.run\(requestMetricsContext/,
  );
  assert.match(admissionSource, /return enqueue\(runInLane\);/);
});

test("order lane conserva il contesto metriche della richiesta accodata", () => {
  const serverSource = backendSource;
  const start = serverSource.indexOf("async function withOrderSyncLaneMutation");
  const end = serverSource.indexOf("\nfunction orderSyncLaneTaskPriority", start);
  const orderLaneSource = serverSource.slice(start, end);
  assert.notEqual(start, -1);
  assert.match(
    orderLaneSource,
    /run:\s*async \(\) => requestMetricsStorage\.run\(requestMetricsContext/,
  );
});

test("order ready notifications sync by explicit id before full notification fallback", () => {
  const serverSource = backendSource;
  assert.match(
    serverSource,
    /function syncOrderNotificationsFastPath[\s\S]+syncObjectArrayEntriesFromAppState\(db,\s*["']integration["'],\s*["']notifications["'],\s*ids\)[\s\S]+syncObjectArrayFieldFromAppState\(db,\s*["']integration["'],\s*["']notifications["']\)/,
    "orders/sync deve sincronizzare solo le notifiche create quando l'ID e' noto"
  );
  assert.match(
    serverSource,
    /notificationIds:\s*queuedReadyBell && queuedReadyBell\.deduped !== true \? \[queuedReadyBell\.notification\?\.id\] : \[\]/,
    "orders/sync deve passare l'ID della nuova notifica pronta"
  );
});

test("order fulfillment history sync uses explicit event id before full history fallback", () => {
  const serverSource = backendSource;
  assert.match(
    serverSource,
    /function syncOrderFulfillmentHistoryFastPath[\s\S]+syncObjectArrayEntriesFromAppState\(db,\s*["']integration["'],\s*["']orderFulfillmentHistory["'],\s*ids\)[\s\S]+syncObjectArrayFieldFromAppState\(db,\s*["']integration["'],\s*["']orderFulfillmentHistory["']\)/,
    "orders/sync deve sincronizzare solo l'evento fulfillment appena creato quando l'ID e' noto"
  );
  assert.match(
    serverSource,
    /fulfillmentHistoryIds:\s*fulfillmentHistoryEvent \? \[fulfillmentHistoryEvent\.id\] : \[\]/,
    "orders/sync deve passare l'ID del nuovo evento fulfillment"
  );
  assert.match(
    serverSource,
    /fulfillmentHistoryFullSync:\s*Boolean\(fulfillmentHistoryEvent && fulfillmentHistoryLengthBefore >= INTEGRATION_MAX_ORDER_FULFILLMENT_HISTORY\)/,
    "il fast path fulfillment deve tornare al full sync quando lo storico puo' aver potato record vecchi"
  );
});

test("order comp/correct/cancel use punctual workflow sync", () => {
  const serverSource = backendSource;
  assert.match(
    serverSource,
    /import \{ normalizeIntegrationObjectFieldNames, syncIntegrationObjectFieldsFastPath \} from ["']\.\/modules\/integration\/integration-object-fields\.js["']/,
    "il fast path ordine deve poter sincronizzare campi integration laterali senza full-domain"
  );
  assert.match(
    serverSource,
    /writeIntegrationOrderSyncDb\(db,\s*\{[^\n]+integrationObjectFields:\s*\[[^\n]*["']orderComps["'][^\n]+metricLabel:\s*`\$\{orderCompMetricPrefix\}\.appStateWrite`/,
    "orders/comp deve usare writeIntegrationOrderSyncDb con orderComps puntuale"
  );
  assert.match(
    serverSource,
    /writeIntegrationOrderSyncDb\(db,\s*\{[^\n]+integrationObjectFields:\s*\[[^\n]*["']orderCorrections["'][^\n]+metricLabel:\s*["']orders\.correct\.appStateWrite["']/,
    "orders/correct deve usare writeIntegrationOrderSyncDb con orderCorrections puntuale"
  );
  assert.match(
    serverSource,
    /writeIntegrationOrderSyncDb\(db,\s*\{[^\n]+auditEventIds:\s*collectAuditEventIdsSince\(db,\s*auditStartIndex\)[^\n]+metricLabel:\s*["']orders\.cancel\.appStateWrite["']/,
    "orders/cancel deve usare writeIntegrationOrderSyncDb e audit espliciti"
  );
});

test("secondary order writes use explicit scoped metrics", () => {
  const serverSource = backendSource;
  // Questo divieto nasce sul monolite e li resta: `relational-order-create.js`
  // contiene una chiamata generica dal 2026-07-14, precedente alla
  // decomposizione, e allargare qui il perimetro la trasformerebbe in un rosso
  // che non riguarda questo lavoro.
  assert.doesNotMatch(
    readFileSync(path.join(cassaDir, "server.js"), "utf8"),
    /await writeIntegrationOrderDb\(db\);/,
    "le scritture ordine non devono tornare alla label generica orders.appStateWrite"
  );
  for (const label of [
    "orders.transfer.request.appStateWrite",
    "orders.transfer.resolve.appStateWrite",
    "orders.transfer.force.appStateWrite",
    "orders.lineSplit.appStateWrite",
    "orders.priceOverride.appStateWrite",
    "orders.barReplacement.appStateWrite",
  ]) {
    assert.match(serverSource, new RegExp(`metricLabel:\\s*["']${label.replaceAll(".", "\\.")}["']`), `${label} deve restare tracciata`);
  }
  assert.match(
    serverSource,
    /writeIntegrationOrderSyncDb\(db,\s*\{[^\n]+metricLabel:\s*["']orders\.lineSplit\.appStateWrite["']/,
    "line split deve usare il writer puntuale ordine"
  );
  assert.match(
    serverSource,
    /writeIntegrationOrderSyncDb\(db,\s*\{[^\n]+metricLabel:\s*["']orders\.priceOverride\.appStateWrite["']/,
    "price override deve usare il writer puntuale ordine"
  );
  assert.match(
    serverSource,
    /writeIntegrationOrderSyncDb\(db,\s*\{[^\n]+integrationObjectFields:\s*\[[^\n]*["']barChargeReplacements["'][^\n]+metricLabel:\s*["']orders\.barReplacement\.appStateWrite["']/,
    "bar replacement deve sincronizzare il campo laterale senza full-domain"
  );
});

test("room and table writes keep scoped labels for P3 diagnostics", () => {
  const serverSource = backendSource;
  assert.doesNotMatch(
    serverSource,
    /await writeRoomDb\(db\);/,
    "le write sale/tavoli non devono tornare alla label generica rooms.appStateWrite"
  );
  for (const label of [
    "rooms.session.appStateWrite",
    "rooms.change.request.appStateWrite",
    "rooms.change.approve.appStateWrite",
    "rooms.change.cancel.appStateWrite",
    "rooms.table.sync.appStateWrite",
    "rooms.table.move.appStateWrite",
    "rooms.tableRoomMove.request.appStateWrite",
    "rooms.tableRoomMove.resolve.appStateWrite",
  ]) {
    assert.match(
      serverSource,
      new RegExp(`metricLabel:\\s*["']${label.replace(/\./g, "\\.")}["'][^\\n]+splitDomains:\\s*\\[`),
      `${label} deve dichiarare anche splitDomains espliciti`
    );
  }
});

test("P5.4 high-volume writes declare only their owned app-state domains", () => {
  const serverSource = backendSource;
  const counterSource = readFileSync(
    path.join(cassaDir, "modules", "counter", "counter.handlers.js"),
    "utf8",
  );
  const counterWriterSource = readFileSync(
    path.join(cassaDir, "modules", "counter", "counter-collection-writer.js"),
    "utf8",
  );
  const reportsSource = readFileSync(
    path.join(cassaDir, "modules", "reports", "reports.handlers.js"),
    "utf8",
  );

  assert.match(
    serverSource,
    /integration\.tableGroups\.normalize\.appStateWrite[\s\S]+splitDomains:\s*\["integration"\]/,
  );
  assert.match(
    serverSource,
    /integration\.tableGroups\.save\.appStateWrite[\s\S]+splitDomains:\s*\[\s*"integration",\s*"posSettings",\s*\.\.\.\(printJobs\.length > 0 \? \["printSpoolJobs"\]/,
  );
  assert.match(
    counterWriterSource,
    /const FALLBACK_SPLIT_DOMAINS = \[[\s\S]+"paymentContainers"[\s\S]+"commercialBenefitCoupons"[\s\S]+"auditEvents"[\s\S]+counter\.collect\.appStateWrite[\s\S]+splitDomains: FALLBACK_SPLIT_DOMAINS/,
  );
  assert.match(
    counterSource,
    /const counterMutation = \{[\s\S]+paymentIds:[\s\S]+auditEventIds:[\s\S]+writeCounterCollectionDb\(db, counterMutation\)/,
  );
  assert.match(
    reportsSource,
    /const HANDHELD_CASH_SESSION_WRITE_DOMAINS = \[[\s\S]+"handheldCashSessions"[\s\S]+"auditEvents"[\s\S]+reports\.handheldCashSessionOpen\.appStateWrite[\s\S]+reports\.handheldCashSessionClose\.appStateWrite/,
  );
});

test("P4.3 table sync usa write puntuale con fallback completo e rollback flag", () => {
  const serverSource = backendSource;
  const fastPathSource = readFileSync(
    path.join(cassaDir, "modules", "tables", "table-sync-app-state-fastpath.js"),
    "utf8",
  );

  assert.match(
    serverSource,
    /TABLE_SYNC_APP_STATE_FASTPATH = process\.env\.BACKEND_TABLE_SYNC_APP_STATE_FASTPATH === "1"/,
  );
  assert.match(
    serverSource,
    /writeTableSyncAppStateFastDb\(db, \{ tableId, auditEventIds: collectAuditEventIdsSince\(db, auditEventStartIndex\), requiresFullFallback: reservationSplit\.changed \}\)/,
  );
  assert.match(
    serverSource,
    /if \(!fastAppStateWritten\) await writeRoomDb\(db, \{ metricLabel: "rooms\.table\.sync\.appStateWrite", splitDomains:/,
  );
  assert.match(fastPathSource, /syncObjectArrayEntriesFromAppState/);
  assert.match(fastPathSource, /syncEntriesFromAppState\(syncState, tableIds\)/);
  assert.match(
    fastPathSource,
    /runtimeMetrics\?\.recordOperation\?\.\(\s*"tableSyncWrite",\s*"total"/,
  );
});

test("P4.3 table-room-move request usa write puntuale con prune guard e rollback flag", () => {
  const serverSource = backendSource;
  const fastPathSource = readFileSync(
    path.join(
      cassaDir,
      "modules",
      "table-room-move",
      "table-room-move-request-app-state-fastpath.js",
    ),
    "utf8",
  );

  assert.match(
    serverSource,
    /TABLE_ROOM_MOVE_REQUEST_APP_STATE_FASTPATH = process\.env\.BACKEND_TABLE_ROOM_MOVE_REQUEST_APP_STATE_FASTPATH === "1"/,
  );
  assert.match(
    serverSource,
    /tableRoomMoveRequestsPruned = pruneExpiredPosTableRoomMoveRequests\(db\)[\s\S]+writeTableRoomMoveRequestAppStateFastDb\(db, \{ requestId: request\.requestId[\s\S]+requiresFullFallback: tableRoomMoveRequestsPruned \}\)/,
  );
  assert.match(
    serverSource,
    /if \(!fastAppStateWritten\) \{[\s\S]+rooms\.tableRoomMove\.request\.appStateWrite/,
  );
  assert.match(fastPathSource, /syncDomainArrayEntriesFromAppState/);
  assert.match(
    fastPathSource,
    /syncObjectArrayEntriesAndObjectEntriesFromAppState/,
  );
  assert.match(fastPathSource, /options\.requiresFullFallback === true/);
  assert.match(
    fastPathSource,
    /runtimeMetrics\?\.recordOperation\?\.\(\s*"tableRoomMoveRequestWrite",\s*"total"/,
  );
});

test("P4.3 room-change request misura i rami senza spostare le regole dalla route", () => {
  const serverSource = backendSource;
  const telemetrySource = readFileSync(
    path.join(cassaDir, "modules", "pos-rooms", "room-change-request-telemetry.js"),
    "utf8",
  );
  const operationTelemetrySource = readFileSync(
    path.join(cassaDir, "modules", "pos-rooms", "room-change-operation-telemetry.js"),
    "utf8",
  );

  assert.match(serverSource, /createPosRoomChangeRequestTelemetry/);
  assert.match(serverSource, /requestTelemetry\.measure\("readDb\.handler"/);
  assert.match(serverSource, /requestTelemetry\.measureSync\("authorization"/);
  assert.match(serverSource, /requestTelemetry\.finish\("direct"\)/);
  assert.match(serverSource, /requestTelemetry\.finish\("pending"\)/);
  assert.match(
    serverSource,
    /function withRoomLaneMutation[\s\S]+run: async \(\) => requestMetricsStorage\.run\(requestMetricsContext/,
  );
  assert.match(operationTelemetrySource, /record\(`laneWait\.\$\{outcome\}`/);
  assert.match(operationTelemetrySource, /record\(`readDbTotal\.\$\{outcome\}`/);
  assert.doesNotMatch(
    `${telemetrySource}\n${operationTelemetrySource}`,
    /findPosAllowedRoomForUser|canUserChangeRoomDirectly/,
  );
});

test("P4.3 room-change approve usa prova PIN pre-lane effimera con fallback canonico", () => {
  const serverSource = backendSource;
  const telemetrySource = readFileSync(
    path.join(cassaDir, "modules", "pos-rooms", "room-change-approve-telemetry.js"),
    "utf8",
  );
  const operationTelemetrySource = readFileSync(
    path.join(cassaDir, "modules", "pos-rooms", "room-change-operation-telemetry.js"),
    "utf8",
  );
  const pinProofSource = readFileSync(
    path.join(cassaDir, "modules", "pos-rooms", "room-change-approve-pin-proof.js"),
    "utf8",
  );
  const approveStart = serverSource.indexOf("async function handlePosRoomChangeApprove");
  const approveEnd = serverSource.indexOf("async function handlePosRoomChangeCancel");
  const approveSource = serverSource.slice(approveStart, approveEnd);
  const requestStart = serverSource.indexOf("async function handlePosRoomChangeRequest");
  const requestEnd = serverSource.indexOf("async function handlePosRoomChangeApprove", requestStart);
  const requestSource = serverSource.slice(requestStart, requestEnd);

  assert.match(serverSource, /createPosRoomChangeApproveTelemetry/);
  assert.match(
    requestSource,
    /metricLabel:\s*"rooms\.session\.appStateWrite",\s*splitDomains:\s*\["sessions",\s*"users"\]/,
    "il cambio sala diretto deve persistere insieme sessione e preferenza utente",
  );
  assert.match(serverSource, /createRoomChangeApprovePinProofService/);
  assert.match(serverSource, /BACKEND_POS_ROOM_CHANGE_APPROVE_ASYNC_PIN_PRELANE === "1"/);
  assert.match(serverSource, /posRoomChangeApprovePinProof\.shouldPrepare\(req, pathname\)[\s\S]+posRoomChangeApprovePinProof\.prepare\(req, pathname\)[\s\S]+if \(isRoomLaneRequest/);
  assert.match(serverSource, /approveTelemetry\.measure\("readDb\.handler"/);
  assert.match(serverSource, /approveTelemetry\.measureSync\("authorization\.pinVerify"/);
  assert.match(serverSource, /approveTelemetry\.measure\("pending\.relationalDelete"/);
  assert.match(serverSource, /approveTelemetry\.measure\("state\.appStateWrite"/);
  assert.match(
    approveSource,
    /metricLabel:\s*"rooms\.change\.approve\.appStateWrite",\s*splitDomains:\s*\["posRoomChangeRequests",\s*"sessions",\s*"users"\]/,
    "approve deve persistere anche users.lastSelectedRoom* insieme ai domini dichiarati",
  );
  assert.match(serverSource, /approveTelemetry\.finish\("approved"\)/);
  assert.match(serverSource, /approveTelemetry\.finish\("error"\)/);
  assert.match(telemetrySource, /metricKind: "posRoomChangeApprove"/);
  assert.match(operationTelemetrySource, /record\(`laneWait\.\$\{outcome\}`/);
  assert.match(approveSource, /posRoomChangeApprovePinProof\.consume\(req, approver, approverUsername\)[\s\S]+pinProof\.usable[\s\S]+verifyPin\(approverPin, approver\.pinHash\)[\s\S]+isPosPrivilegedRole\(approver\.role\)/);
  assert.match(approveSource, /finally \{[\s\S]+posRoomChangeApprovePinProof\.discard\(req\)/);
  assert.match(pinProofSource, /Symbol\("roomChangeApprovePinProof"\)/);
  assert.match(pinProofSource, /Object\.defineProperty\(req, proofProperty,[\s\S]+enumerable: false/);
  assert.match(pinProofSource, /const proof = Object\.freeze\(\{ version: 1, \.\.\.snapshot, pinValid:/);
  assert.match(pinProofSource, /safeSecretEqual\(proof\.pinHash, current\.pinHash\)/);
  assert.doesNotMatch(pinProofSource, /sendJson|writeRoomDb|deleteRoomChangeRequest|updatePosSessionRoom/);
  assert.doesNotMatch(
    `${telemetrySource}\n${operationTelemetrySource}`,
    /verifyPin|deleteRoomChangeRequest|updatePosSessionRoom|writeRoomDb/,
  );
});

test("P4.3 room-change approve mantiene esplicito il confine transazionale cross-store", () => {
  const serverSource = backendSource;
  const reservationsRepositorySource = readFileSync(
    path.join(cassaDir, "db", "relational", "reservations.repo.js"),
    "utf8",
  );
  const relationalConnectionSource = readFileSync(
    path.join(cassaDir, "db", "relational", "connection.js"),
    "utf8",
  );
  const mysqlSessionsSource = readFileSync(
    path.join(cassaDir, "db", "app-state", "mysql-sessions-split.repository.js"),
    "utf8",
  );
  const approveStart = serverSource.indexOf("async function handlePosRoomChangeApprove");
  const approveEnd = serverSource.indexOf("async function handlePosRoomChangeCancel");
  const approveSource = serverSource.slice(approveStart, approveEnd);
  const relationalDeleteOffset = approveSource.indexOf("deleteRoomChangeRequest");
  const appStateWriteOffset = approveSource.indexOf("rooms.change.approve.appStateWrite");

  assert.match(relationalConnectionSource, /import\("node:sqlite"\)/);
  assert.match(
    reservationsRepositorySource,
    /deleteRoomChangeRequest\([\s\S]+runRelationalTransaction\(this\.db, operation\)/,
    "la pending resta in una transazione SQLite locale",
  );
  assert.match(mysqlSessionsSource, /mysqlRepository\.getPool\(\)/);
  assert.match(mysqlSessionsSource, /connection\.beginTransaction\(\)/);
  assert.ok(
    relationalDeleteOffset >= 0 && appStateWriteOffset > relationalDeleteOffset,
    "il flusso corrente espone due commit ordinati, non un singolo commit atomico",
  );
});

test("integration layout refresh stays outside the mutation lanes with scoped write", () => {
  const serverSource = backendSource;
  const laneRoutingSource = readFileSync(path.join(cassaDir, "modules", "queue", "lane-routing.js"), "utf8");
  const layoutHandler = serverSource.match(/async function buildIntegrationLayoutCacheEntry[\s\S]*?\n}\nconst runIntegrationLayoutBuild/)?.[0] ?? "";
  const roomPaths = serverSource.match(/const ROOM_LANE_PATHS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "";
  assert.doesNotMatch(roomPaths, /["']\/api\/integration\/layout["']/);
  assert.doesNotMatch(serverSource, /function isIntegrationLayoutReadRequest/);
  assert.doesNotMatch(laneRoutingSource, /safePath === ["']\/api\/integration\/layout["']/);
  assert.doesNotMatch(layoutHandler, /await writeDb\(db\)/);
  assert.doesNotMatch(layoutHandler, /reservationActivation\.changed \|\| changed/);
  assert.match(layoutHandler, /if \(reservationActivation\.changed\) \{[\s\S]+writeIntegrationLayoutRefreshDb/);
  assert.match(layoutHandler, /writeIntegrationLayoutRefreshDb\(db,\s*\{ syncTableGroups: reservationActivation\.changed \}/);
  assert.match(serverSource, /function writeIntegrationLayoutRefreshDb[\s\S]+syncPosSettingsTablesFastPath\(db\)[\s\S]+\[["']tableGroups["'], ["']lastWriteAt["']\]/);
  assert.match(serverSource, /rooms\.layout\.refresh\.appStateWrite/);
});

test("payment writes keep scoped labels for P3 diagnostics", () => {
  const serverSource = backendSource;
  const paymentsSource = readFileSync(
    path.join(cassaDir, "modules", "payments", "payments.handlers.js"),
    "utf8",
  );
  const fiscalSource = readFileSync(
    path.join(cassaDir, "modules", "fiscal-pos", "fiscal.handlers.js"),
    "utf8",
  );
  const freeSplitFastPathSource = readFileSync(
    path.join(cassaDir, "modules", "payments", "payment-free-split-fastpath.js"),
    "utf8",
  );
  const combinedSource = `${serverSource}\n${paymentsSource}\n${fiscalSource}`;
  assert.doesNotMatch(
    combinedSource,
    /await writePaymentDb\(db\);/,
    "le write pagamenti/fiscali devono dichiarare label e splitDomains espliciti"
  );
  for (const label of [
    "payments.table.complete.appStateWrite",
    "payments.freeSplit.complete.appStateWrite",
    "payments.freeSplit.provider.appStateWrite",
    "payments.ticket.complete.appStateWrite",
    "payments.fiscalReceipt.processing.appStateWrite",
    "payments.fiscalReprint.sent.appStateWrite",
    "payments.fiscalCommand.executed.appStateWrite",
  ]) {
    assert.match(
      combinedSource,
      new RegExp(label.replace(/\./g, "\\.")),
      `${label} deve restare tracciabile separatamente`
    );
  }
  assert.match(
    paymentsSource,
    /PAYMENT_CORE_WRITE_SPLIT_DOMAINS[\s\S]+payments\.table\.complete\.appStateWrite[\s\S]+payments\.freeSplit\.complete\.appStateWrite/,
    "pagamento tavolo e split libero devono condividere uno scope core esplicito"
  );
  assert.match(
    serverSource,
    /PAYMENT_PROVIDER_WRITE_SPLIT_DOMAINS = \[["']paymentProviderTransactions["'], ["']auditEvents["']\]/,
    "i write provider POS devono sincronizzare solo transazioni provider e audit"
  );
  assert.match(
    serverSource,
    /createPaymentFreeSplitFastPath\(\{[\s\S]+writePaymentFreeSplitDb/,
    "lo split libero deve essere collegato al fast path pagamenti"
  );
  assert.match(
    serverSource,
    /createPaymentFreeSplitFastPath\(\{[^\n]+deferTransientMirror:[^\n]+RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY[^\n]+isTransientMysqlRouteError[^\n]+scheduleAppStateBackgroundFlush\(["']payments\.freeSplit["']/,
    "dopo il write-primary relazionale il mirror transitorio deve essere differito"
  );
  assert.match(
    freeSplitFastPathSource,
    /catch \(error\)[\s\S]+deferTransientMirror\?\.\([\s\S]+if \(!deferred\) throw error[\s\S]+paymentFreeSplitTransientMirrorDeferred/,
    "il fast path deve propagare gli errori non differibili e misurare quelli accodati"
  );
  assert.match(
    paymentsSource,
    /await writePaymentFreeSplitDb\(db,\s*\{[\s\S]+payments\.freeSplit\.complete\.appStateWrite[\s\S]+auditEventIds:/,
    "free-split complete deve passare orderIds/tableIds/auditEventIds puntuali"
  );
  const recordDomains = freeSplitFastPathSource.match(
    /PAYMENT_FREE_SPLIT_RECORD_WRITE_SPLIT_DOMAINS = \[([\s\S]*?)\];/,
  )?.[1] ?? "";
  assert.ok(recordDomains.length > 0, "il fast path free-split deve dichiarare i domini record");
  assert.doesNotMatch(
    recordDomains,
    /["'](?:integration|posSettings|auditEvents|printSpoolJobs)["']/,
    "il write record free-split non deve risincronizzare domini gia' gestiti puntualmente"
  );
});

test("P4.3 free-split atomico conserva audit secondario e freshness fail-closed", () => {
  const serverSource = backendSource;
  const freeSplitSource = readFileSync(
    path.join(cassaDir, "modules", "payments", "payment-free-split-fastpath.js"),
    "utf8",
  );
  const durableSource = readFileSync(
    path.join(
      cassaDir,
      "modules",
      "payments",
      "payment-free-split-durable-mirror.js",
    ),
    "utf8",
  );
  const atomicWriterSource = readFileSync(
    path.join(cassaDir, "db", "app-state", "mysql-atomic-selection-writer.js"),
    "utf8",
  );
  const domainsSource = readFileSync(
    path.join(cassaDir, "db", "app-state", "mysql-domains-split.repository.js"),
    "utf8",
  );
  const operationsSource = readFileSync(
    path.join(appDir, "scripts", "run-v5bt-operations-30.mjs"),
    "utf8",
  );
  const secondaryAuditSource =
    serverSource.match(
      /async function syncSecondaryOrderAuditEventsFastPath[\s\S]*?\n}/,
    )?.[0] ?? "";

  assert.match(
    serverSource,
    /createPaymentFreeSplitFastPath\(\{[^\n]+atomicSelectionWriter: mysqlAtomicSelectionWriter[^\n]+syncSecondaryAuditEventsFastPath: syncSecondaryOrderAuditEventsFastPath/,
  );
  assert.match(secondaryAuditSource, /auditEventsSplitRepository/);
  assert.doesNotMatch(secondaryAuditSource, /mysqlAuditEventsSplitRepository/);
  assert.match(
    freeSplitSource,
    /typeof syncSecondaryAuditEventsFastPath === ["']function["']/,
  );
  assert.match(
    freeSplitSource,
    /await recordStep\(["']audit\.secondary["'][\s\S]+syncSecondaryAuditEventsFastPath\(db, auditEventIds\)/,
  );
  assert.doesNotMatch(
    freeSplitSource,
    /syncSecondaryAuditEventsFastPath\?\.\(db, auditEventIds\)/,
  );
  assert.ok(
    freeSplitSource.lastIndexOf("syncSecondaryAuditEventsFastPath(db") >
      freeSplitSource.indexOf("atomicSelectionWriter.write"),
    "l'audit secondario deve partire solo dopo il writer atomico atteso",
  );
  assert.match(
    freeSplitSource,
    /domainArrayEntries: paymentDomainEntries[\s\S]+fieldName: ["']orders["'][\s\S]+fieldNames: \[["']lastWriteAt["']\][\s\S]+auditEventIds[\s\S]+preserveNewerIntegrationRecords: true[\s\S]+preserveNewerPaymentMirrorRecords: true/,
  );
  assert.doesNotMatch(freeSplitSource, /mysql\.lastWriteAt/);
  assert.match(
    atomicWriterSource,
    /syncSelectedEntriesFromAppState\([\s\S]+connection[\s\S]+preserveNewerIntegrationRecords[\s\S]+preserveNewerPaymentMirrorRecords[\s\S]+syncEntriesFromAppState\([\s\S]+\{ connection \}[\s\S]+await connection\.commit\(\)/,
  );
  assert.match(
    domainsSource,
    /async function lockDomainRowsForWrite[\s\S]+?SELECT record_id, kind, app_state_position, row_hash, raw_json[\s\S]+?FROM \$\{tableSql\}[\s\S]+?WHERE domain = \? AND record_id IN \(\$\{placeholders\}\)[\s\S]+?ORDER BY record_id ASC[\s\S]+?FOR UPDATE/,
  );
  assert.match(
    domainsSource,
    /const existing = buildRecordState\(\[\.\.\.lockedDomainRows\.values\(\)\]\)/,
  );
  assert.match(
    domainsSource,
    /const PAYMENT_PROVIDER_TRANSACTIONS_DOMAIN = ["']paymentProviderTransactions["'];/,
  );
  assert.match(
    domainsSource,
    /const FISCAL_RECEIPTS_DOMAIN = ["']fiscalReceipts["'];/,
  );
  assert.match(
    domainsSource,
    /const MUTABLE_PAYMENT_MIRROR_DOMAINS = new Set\(\[[\s\S]+["']payments["'][\s\S]+["']paymentContainers["'][\s\S]+PAYMENT_PROVIDER_TRANSACTIONS_DOMAIN[\s\S]+FISCAL_RECEIPTS_DOMAIN/,
  );
  assert.match(
    durableSource,
    /PaymentsRelationalRepository[\s\S]+FiscalOutboxRepository[\s\S]+latestMutableCollections/,
  );
  assert.match(
    durableSource,
    /PAYMENT_MIRROR_RELATIONAL_FISCAL_SNAPSHOT_INCOMPLETE/,
  );
  assert.doesNotMatch(
    durableSource,
    /PAYMENT_MIRROR_RELATIONAL_PROVIDER_SNAPSHOT_INCOMPLETE/,
  );
  assert.match(
    durableSource,
    /getByAggregate\(["']fiscal_receipt["'], id\)/,
  );
  assert.match(
    durableSource,
    /const latestCollections = latestMutableCollections\(payload, relationalDb\)[\s\S]+buildPaymentFreeSplitStatelessMirror\(payload,[\s\S]+latestCollections/,
  );
  assert.match(
    operationsSource,
    /const V5BT_CERTIFIED_PAYMENT_LANE_CONCURRENCY = 2;/,
  );
});

test("P4.3 free-split usa mirror durevole atomico, recuperabile e sotto flag", () => {
  const serverSource = backendSource;
  const handlersSource = readFileSync(path.join(cassaDir, "modules", "payments", "payments.handlers.js"), "utf8");
  const durableSource = readFileSync(path.join(cassaDir, "modules", "payments", "payment-free-split-durable-mirror.js"), "utf8");
  const statelessSource = readFileSync(path.join(cassaDir, "modules", "payments", "payment-free-split-stateless-mirror.js"), "utf8");
  const workerSource = readFileSync(path.join(cassaDir, "modules", "payments", "payment-mirror-worker.js"), "utf8");
  const migrationSource = readFileSync(path.join(cassaDir, "db", "relational", "migrations", "025_payment_mirror_outbox.sql"), "utf8");
  const loadtestSource = readFileSync(path.resolve(appDir, "scripts", "loadtest-full-capacity.mjs"), "utf8");
  const relationalWrite = serverSource.match(/async function recordRelationalFreeSplitPayment[\s\S]*?\n}\nconst relationalTableLockCoordinator/)?.[0] ?? "";

  assert.match(serverSource, /PAYMENT_FREE_SPLIT_DURABLE_MIRROR_REQUESTED[\s\S]+RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY/);
  assert.match(relationalWrite, /withTransactionalOutboxEvent[\s\S]+enqueuePaymentFreeSplitMirror/);
  assert.match(relationalWrite, /paymentMirrorJob[\s\S]+tableInvariant/);
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS payment_mirror_outbox/);
  assert.match(migrationSource, /UNIQUE \(mirror_kind, aggregate_id\)/);
  assert.match(durableSource, /OrdersRelationalRepository[\s\S]+TablesBillsRelationalRepository/);
  assert.match(durableSource, /withPaymentLaneMutation[\s\S]+payment\.freeSplit durable mirror/);
  assert.match(serverSource, /PAYMENT_MIRROR_STATELESS_CONSUMER[\s\S]+PAYMENT_FREE_SPLIT_DURABLE_MIRROR[\s\S]+PAYMENT_MIRROR_SKIP_POSSETTINGS_TABLES[\s\S]+MYSQL_SPLIT_APP_STATE_DOMAINS[\s\S]+MYSQL_SPLIT_AUDIT_EVENTS/);
  assert.match(durableSource, /options\.stateless === true && canUsePaymentFreeSplitStatelessMirror[\s\S]+processStateless/);
  assert.match(durableSource, /paymentMirrorStatelessFallbacks[\s\S]+withPaymentLaneMutation[\s\S]+durable mirror legacy/);
  assert.doesNotMatch(durableSource.match(/return createPaymentMirrorWorkerRuntime\([\s\S]+?\n  \}\);/)?.[0] ?? "", /runExclusive/);
  assert.doesNotMatch(statelessSource, /\breadDb\b|\bdbCache\b|withPaymentLaneMutation/);
  assert.match(statelessSource, /new Array\(Math\.max[\s\S]+entry\.position/);
  assert.match(workerSource, /reclaimAllProcessing[\s\S]+wake\("startup"\)/);
  assert.match(handlersSource, /appState\.mirror\.enqueued[\s\S]+appState\.mirror\.fallback/);
  assert.doesNotMatch(handlersSource, /PAYMENT_DURABLE_MIRROR_NOT_QUEUED/);
  assert.match(serverSource, /SHOULD_RUN_BACKEND_OWNER_JOBS && PAYMENT_FREE_SPLIT_DURABLE_MIRROR/);
  assert.match(loadtestSource, /paymentMirrorPending[\s\S]+payment\.mirror\.terminal_failure/);
  assert.match(loadtestSource, /paymentMirrorStatelessConsumer/);
});

test("P4.3 free-split riusa il contesto POS sanificato solo sotto flag", () => {
  const serverSource = backendSource;
  const handlersSource = readFileSync(
    path.join(cassaDir, "modules", "payments", "payments.handlers.js"),
    "utf8",
  );
  const loadtestSource = readFileSync(
    path.resolve(appDir, "scripts", "loadtest-full-capacity.mjs"),
    "utf8",
  );

  assert.match(
    serverSource,
    /PAYMENT_FREE_SPLIT_SETTINGS_REUSE = process\.env\.BACKEND_PAYMENT_FREE_SPLIT_SETTINGS_REUSE === ["']1["']/,
  );
  assert.match(
    serverSource,
    /paymentFreeSplitSettingsReuseEnabled: PAYMENT_FREE_SPLIT_SETTINGS_REUSE/,
  );
  assert.match(
    handlersSource,
    /paymentFreeSplitSettingsReuseEnabled[\s\S]+sanitizedPosSettings: settings/,
  );
  assert.match(
    handlersSource,
    /domain\.settingsSanitize[\s\S]+domain\.tableFinancialSync\.initial[\s\S]+domain\.authoritativeValidate[\s\S]+domain\.readiness\.preflight[\s\S]+domain\.readiness\.final[\s\S]+domain\.applyIntegrationPayment[\s\S]+domain\.tableFinancialSync\.final/,
  );
  assert.match(
    serverSource,
    /function resolveSanitizedPosSettings\([\s\S]+options\.sanitizedPosSettings[\s\S]+function syncPosTableFinancialsFromIntegrationOrders\([\s\S]+resolveSanitizedPosSettings\(db, options\)[\s\S]+targetOptions\.sanitizedPosSettings = settings/,
  );
  assert.match(loadtestSource, /paymentFreeSplitSettingsReuse/);
});

test("P4.3 free-split legacy persiste puntualmente i soli record catturati", () => {
  const handlersSource = readFileSync(
    path.join(cassaDir, "modules", "payments", "payments.handlers.js"),
    "utf8",
  );

  assert.match(
    handlersSource,
    /const paymentMirrorCapture = beginPaymentFreeSplitMirrorCapture\(db\);/,
  );
  assert.match(
    handlersSource,
    /collectPaymentFreeSplitCollectionEntryIds\(paymentMirrorPayload\)/,
  );
  assert.match(
    handlersSource,
    /writePaymentFreeSplitDb\(db,[\s\S]+collectionEntryIds: paymentCollectionEntryIds/,
  );
});

test("order domain split exposes internal timing metrics for order writes", () => {
  const serverSource = backendSource;
  const repositorySource = readFileSync(
    path.join(cassaDir, "db", "app-state", "mysql-domains-split.repository.js"),
    "utf8",
  );
  assert.match(
    serverSource,
    /createMysqlAppStateDomainsSplitRepository\(\{[\s\S]+runtimeMetrics,[\s\S]+nowIso/,
    "il repository domain split deve ricevere runtimeMetrics dal server"
  );
  assert.match(
    repositorySource,
    /recordOperation\?\.\(\s*["']appStateDomainSplit["']/,
    "il repository domain split deve registrare metriche interne"
  );
  assert.match(
    repositorySource,
    /const metricPrefix = `\$\{normalizedDomain\}\.\$\{normalizedFieldName\}\.entries`/,
    "le metriche entries devono usare il prefisso domain.field.entries"
  );
  for (const matcher of [
    /\`\$\{metricPrefix\}\.ensure\`/,
    /\`\$\{metricPrefix\}\.getPool\`/,
    /\`\$\{metricPrefix\}\.getConnection\`/,
    /\`\$\{metricPrefix\}\.beginTransaction\`/,
    /\`\$\{metricPrefix\}\.commit\`/,
    /\`\$\{metricPrefix\}\.rollback\`/,
    /\`\$\{metricPrefix\}\.rollback\.cause\.\$\{rollbackCause\}\`/,
    /\`\$\{metricPrefix\}\.error\.\$\{rollbackCause\}\`/,
    /\`\$\{metricPrefix\}\.errorStage\.\$\{transactionStep\}\.\$\{rollbackCause\}\`/,
    /\`\$\{metricPrefix\}\.outcome\.committed\`/,
    /\`\$\{metricPrefix\}\.outcome\.rolledBack\`/,
    /\`\$\{metricPrefix\}\.rollback\.failed\`/,
    /\`\$\{metricPrefix\}\.release\`/,
    /\`\$\{prefix\}\.stateRead\`/,
    /\`\$\{prefix\}\.upsertChangedRows\`/,
    /\`\$\{normalizedDomain\}\.\$\{normalizedFieldName\}\.entries\.total\`/,
    /\`\$\{metricPrefix\}\.stateRead\`/,
    /\`\$\{metricPrefix\}\.compare\`/,
    /\`\$\{metricPrefix\}\.total\`/,
  ]) {
    assert.match(repositorySource, matcher);
  }
  assert.match(
    repositorySource,
    /function normalizeDomainSplitRollbackCause\(error\)/,
    "i rollback devono essere classificati con cause stabili"
  );
  for (const cause of ["transientDbError", "revisionConflict", "duplicate", "unknown"]) {
    assert.match(repositorySource, new RegExp(`return ["']${cause}["']`));
  }
});

test("app-state MySQL repository exposes shared pool pressure metrics", () => {
  const serverSource = backendSource;
  const repositorySource = readFileSync(
    path.join(cassaDir, "db", "app-state", "app-state-mysql.repository.js"),
    "utf8",
  );
  const runtimeMetricsSource = readFileSync(
    path.join(cassaDir, "modules", "runtime-metrics.js"),
    "utf8",
  );

  assert.match(
    serverSource,
    /new AppStateMysqlRepository\(\{[\s\S]+poolMetricsEnabled:\s*process\.env\.BACKEND_MYSQL_POOL_METRICS === ["']1["'],[\s\S]+runtimeMetrics,[\s\S]+}\)/,
    "il repository MySQL condiviso deve ricevere runtimeMetrics solo come canary esplicito",
  );
  assert.match(
    repositorySource,
    /poolMetricsEnabled[\s\S]+BACKEND_MYSQL_POOL_METRICS === ["']1["']/,
    "le metriche pool MySQL devono essere default-off e attivabili via env",
  );
  assert.match(
    repositorySource,
    /recordOperation\?\.\(\s*["']appStateMysql["']/,
    "il repository MySQL deve registrare metriche appStateMysql condivise",
  );
  assert.match(
    repositorySource,
    /pool\.getConnection = async[\s\S]+connection\.acquire[\s\S]+connection\.hold/,
    "il pool MySQL deve misurare acquire e hold delle connessioni condivise",
  );
  assert.match(
    repositorySource,
    /pool\.query = async[\s\S]+query\.\$\{classifySql/,
    "il pool MySQL deve misurare le query per verbo SQL a bassa cardinalita'",
  );
  assert.match(
    runtimeMetricsSource,
    /\^appStateMysql:\//,
    "le metriche appStateMysql devono restare pinnate nello snapshot runtime",
  );
  assert.match(runtimeMetricsSource, /mysqlPoolActiveConnections: 0/);
  assert.match(runtimeMetricsSource, /mysqlPoolPendingAcquires: 0/);
});

test("Fase L1 espone flag canary per sciogliere order lane da room/reservation/notification", () => {
  const serverSource = backendSource;
  assert.match(
    serverSource,
    /LANE_CROSS_EXCLUSION_ORDERS\s*=\s*process\.env\.LANE_CROSS_EXCLUSION_ORDERS !== ["']0["']/,
    "il passo L1 deve restare default-on e attivarsi solo con LANE_CROSS_EXCLUSION_ORDERS=0"
  );
  assert.match(
    serverSource,
    /function orderLanePeerRunningForRoomLikeLanes\(\)[\s\S]+LANE_CROSS_EXCLUSION_ORDERS && orderSyncLaneRunning > 0/,
    "room/reservation/notification devono poter ignorare orderSyncLaneRunning quando L1 e' attivo"
  );
  assert.match(
    serverSource,
    /function roomLikeLanePeerRunningForOrderLane\(\)[\s\S]+if \(!LANE_CROSS_EXCLUSION_ORDERS\) return false;[\s\S]+roomLaneRunning > 0[\s\S]+reservationLane\.runningCount\(\) > 0[\s\S]+notificationLane\.runningCount\(\) > 0/,
    "orderSyncLane deve poter ignorare room/reservation/notification quando L1 e' attivo"
  );
  assert.match(
    serverSource,
    /if \(hasDomainLaneRunning\(\)\) \{[\s\S]+if \(!hasUrgentDbMutationTask\(\)\) \{[\s\S]+scheduleCrossDomainCompatibleLaneTasks\(\);[\s\S]+return;[\s\S]+\}/,
    "lo scheduler deve provare ad avviare lane compatibili anche mentre una lane e' gia' running"
  );
});

test("Fase L2 espone flag canary per sciogliere room lane da reservation lane", () => {
  const serverSource = backendSource;
  assert.match(
    serverSource,
    /LANE_CROSS_EXCLUSION_TABLES\s*=\s*process\.env\.LANE_CROSS_EXCLUSION_TABLES !== ["']0["']/,
    "il passo L2 deve restare default-on e attivarsi solo con LANE_CROSS_EXCLUSION_TABLES=0"
  );
  assert.match(
    serverSource,
    /function roomLanePeerRunningForReservationLane\(\)[\s\S]+LANE_CROSS_EXCLUSION_TABLES && roomLaneRunning > 0/,
    "reservationLane deve poter ignorare roomLaneRunning quando L2 e' attivo"
  );
  assert.match(
    serverSource,
    /function reservationLanePeerRunningForRoomLane\(\)[\s\S]+LANE_CROSS_EXCLUSION_TABLES && reservationLane\.runningCount\(\) > 0/,
    "roomLane deve poter ignorare reservationLane.runningCount quando L2 e' attivo"
  );
  assert.match(
    serverSource,
    /hasPeerRunning: \(\) =>[\s\S]+roomLanePeerRunningForReservationLane\(\)[\s\S]+notificationLanePeerRunningForRoomLikeLanes\(\)[\s\S]+presenceLanePeerRunningForRoomLikeLanes\(\)/,
    "reservationLane deve poter sciogliere anche notificationLane con il canary L2"
  );
  assert.match(
    serverSource,
    /function canScheduleRoomLaneBatch\(\)[\s\S]+reservationLanePeerRunningForRoomLane\(\)[\s\S]+notificationLanePeerRunningForRoomLikeLanes\(\)[\s\S]+presenceLanePeerRunningForRoomLikeLanes\(\)/,
    "roomLane deve poter sciogliere anche notificationLane con il canary L2"
  );
  assert.match(
    serverSource,
    /function roomLikeLanePeerRunningForNotificationLane\(\)[\s\S]+LANE_CROSS_EXCLUSION_TABLES && \(roomLaneRunning > 0 \|\| reservationLane\.runningCount\(\) > 0\)/,
    "notificationLane deve usare lo stesso canary L2 dei peer room/reservation"
  );
});

test("Fase L3 espone flag canary per sciogliere payment lane dalle domain lane", () => {
  const serverSource = backendSource;
  const canSchedulePaymentBody = serverSource.match(
    /function canSchedulePaymentLaneBatch\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? "";
  assert.match(
    serverSource,
    /LANE_CROSS_EXCLUSION_PAYMENTS\s*=\s*process\.env\.LANE_CROSS_EXCLUSION_PAYMENTS !== ["']0["']/,
    "il passo L3 deve restare default-on e attivarsi solo con LANE_CROSS_EXCLUSION_PAYMENTS=0"
  );
  assert.match(
    serverSource,
    /function paymentLanePeerRunningForDomainLanes\(\)[\s\S]+LANE_CROSS_EXCLUSION_PAYMENTS && paymentLaneRunning > 0/,
    "le altre lane devono poter ignorare paymentLaneRunning quando L3 e' attivo"
  );
  assert.match(
    serverSource,
    /function domainLanePeerRunningForPaymentLane\(\)[\s\S]+if \(!LANE_CROSS_EXCLUSION_PAYMENTS\) return false;[\s\S]+orderSyncLaneRunning > 0[\s\S]+roomLaneRunning > 0[\s\S]+reservationLane\.runningCount\(\) > 0[\s\S]+notificationLane\.runningCount\(\) > 0[\s\S]+stationStateLane\.runningCount\(\) > 0/,
    "paymentLane deve poter ignorare tutte le domain lane quando L3 e' attivo"
  );
  assert.match(canSchedulePaymentBody, /dbMutationQueueRunning[\s\S]+domainLanePeerRunningForPaymentLane\(\)/);
  assert.doesNotMatch(canSchedulePaymentBody, /paymentLaneRunning\s*>\s*0/);
  assert.match(serverSource, /while \(paymentLaneRunning < PAYMENT_LANE_CONCURRENCY\)/);
  assert.match(
    serverSource,
    /function canScheduleOrderSyncLaneBatch\(\)[\s\S]+paymentLanePeerRunningForDomainLanes\(\)[\s\S]+roomLikeLanePeerRunningForOrderLane\(\)/,
    "orderSyncLane deve usare il helper payment L3 invece di paymentLaneRunning diretto"
  );
  assert.match(
    serverSource,
    /function canScheduleRoomLaneBatch\(\)[\s\S]+paymentLanePeerRunningForDomainLanes\(\)[\s\S]+reservationLanePeerRunningForRoomLane\(\)/,
    "roomLane deve usare il helper payment L3 invece di paymentLaneRunning diretto"
  );
});

test("Fase L4 espone flag canary per sciogliere presence lane dalle corsie live", () => {
  const serverSource = backendSource;
  const canScheduleOrderBody = serverSource.match(
    /function canScheduleOrderSyncLaneBatch\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? "";
  assert.match(
    serverSource,
    /LANE_CROSS_EXCLUSION_PRESENCE\s*=\s*process\.env\.LANE_CROSS_EXCLUSION_PRESENCE !== ["']0["']/,
    "il passo L4 deve restare default-on e attivarsi solo con LANE_CROSS_EXCLUSION_PRESENCE=0"
  );
  assert.match(
    serverSource,
    /function presenceLanePeerRunningForRoomLikeLanes\(\)[\s\S]+if \(!LANE_CROSS_EXCLUSION_PRESENCE\) return false;[\s\S]+waiterPauseLane\?\.runningCount\?\.\(\) > 0[\s\S]+stationStateLane\?\.runningCount\?\.\(\) > 0/,
    "room/reservation/notification devono poter ignorare waiter\/station quando L4 e' attivo"
  );
  assert.match(
    serverSource,
    /function roomLikeLanePeerRunningForPresenceLane\(\)[\s\S]+if \(!LANE_CROSS_EXCLUSION_PRESENCE\) return false;[\s\S]+roomLaneRunning > 0[\s\S]+reservationLane\.runningCount\(\) > 0[\s\S]+notificationLane\.runningCount\(\) > 0/,
    "waiterPauseLane e stationStateLane devono poter ignorare room\/reservation\/notification quando L4 e' attivo"
  );
  assert.match(
    serverSource,
    /kind:\s*["']waiterPauseLane["'][\s\S]+hasPeerRunning:\s*\(\)\s*=>\s*paymentLanePeerRunningForDomainLanes\(\) \|\| roomLikeLanePeerRunningForPresenceLane\(\)/,
    "waiterPauseLane deve usare il helper L4 invece di leggere room\/reservation\/notification direttamente"
  );
  assert.match(
    serverSource,
    /kind:\s*["']stationStateLane["'][\s\S]+hasPeerRunning:\s*\(\)\s*=>\s*paymentLanePeerRunningForDomainLanes\(\) \|\| roomLikeLanePeerRunningForPresenceLane\(\)/,
    "stationStateLane deve usare il helper L4 invece di leggere room\/reservation\/notification direttamente"
  );
  assert.match(
    serverSource,
    /function stationStateLanePeerRunningForOrderLane\(\)[\s\S]+LANE_CROSS_EXCLUSION_PRESENCE && stationStateLane\?\.runningCount\?\.\(\) > 0/,
    "la order lane deve poter ignorare gli heartbeat postazione quando L4 e' attivo"
  );
  assert.match(
    canScheduleOrderBody,
    /stationStateLanePeerRunningForOrderLane\(\)/,
    "il refill degli slot order deve passare dal gate L4"
  );
  assert.doesNotMatch(
    canScheduleOrderBody,
    /stationStateLane\.runningCount\(\) > 0/,
    "canScheduleOrderSyncLaneBatch non deve bypassare il gate L4"
  );
});

test("Fase M2 usa una cache key canonica per integration.orders station-scoped", () => {
  const serverSource = backendSource;
  assert.match(
    serverSource,
    /import \{ buildIntegrationOrdersFastCacheKey, readScopedIntegrationOrdersDb \} from ["']\.\/modules\/integration\/scoped-orders-read\.js["']/,
    "integration.orders deve importare il builder cache canonico M2"
  );
  assert.match(
    serverSource,
    /const fastCacheKey = buildIntegrationOrdersFastCacheKey\(requestUrl,[\s\S]+defaultDoneHistoryLimit: INTEGRATION_STATION_DONE_HISTORY_LIMIT/,
    "handleIntegrationOrders deve usare il builder canonico con il default runtime del limite storico"
  );
  assert.match(
    serverSource,
    /integrationOrdersFastCacheHits/,
    "M2 deve esporre hit della cache ordini nelle runtime metrics"
  );
  assert.match(
    serverSource,
    /integrationOrdersFastCacheMisses/,
    "M2 deve esporre miss della cache ordini nelle runtime metrics"
  );
});

test("integration orders GET mantiene il pruning in sola lettura", () => {
  const serverSource = backendSource;
  const handler = corpoFunzione("handleIntegrationOrders");
  assert.match(handler, /cloneJson\(db\.integration, createDefaultIntegrationState\(\)\)/);
  assert.match(handler, /integrationOrdersReadOnlyPrunes/);
  assert.doesNotMatch(handler, /writeIntegrationOrderDb\(/);
  assert.doesNotMatch(handler, /orders\.poll\.prune\.appStateWrite/);
});

test("Fase M3 isola i retry fiscali pendenti in una lane dedicata", () => {
  const serverSource = backendSource;
  const metricsSource = readFileSync(
    path.join(cassaDir, "modules", "runtime-metrics.js"),
    "utf8",
  );
  assert.match(
    serverSource,
    /FISCAL_RETRY_LANE_ENABLED\s*=[\s\S]+process\.env\.LANE_FISCAL_RETRY !== ["']0["'][\s\S]+process\.env\.FISCAL_RETRY_LANE_ENABLED !== ["']0["']/,
    "M3 deve avere flag canary default-on per disattivare la lane fiscale"
  );
  assert.match(
    serverSource,
    /fiscalRetryLane = createSerializedMutationLane\(\{[\s\S]+kind: ["']fiscalRetryLane["'][\s\S]+counterName: ["']fiscalRetryLaneEnqueued["']/,
    "M3 deve usare una lane dedicata con metriche proprie"
  );
  assert.match(
    serverSource,
    /function schedulePosFiscalReceiptBackgroundJob[\s\S]+enqueueFiscalRetryLaneJob\([\s\S]+pos_fiscal_receipt_/,
    "i job receipt POS devono passare dalla fiscal retry lane"
  );
  assert.match(
    serverSource,
    /function schedulePosFiscalReprintBackgroundJobs[\s\S]+enqueueFiscalRetryLaneJob\([\s\S]+pos_fiscal_reprint_/,
    "i job reprint POS devono passare dalla fiscal retry lane"
  );
  const domainRunningCount = serverSource.match(
    /function domainLaneRunningCount\(\) \{[\s\S]+?\n\}/,
  )?.[0];
  assert.ok(domainRunningCount && !domainRunningCount.includes("fiscalRetryLane"));
  assert.match(
    metricsSource,
    /fiscalRetryLaneEnqueued[\s\S]+fiscalRetryLaneDepth[\s\S]+fiscalRetryLaneRunning/,
    "le runtime metrics devono esporre contatore e gauge M3"
  );
  assert.match(
    metricsSource,
    /fiscalRetryLaneWaitByLabel[\s\S]+fiscalRetryLaneRunByLabel[\s\S]+fiscalRetryLane:/,
    "le runtime metrics devono esporre wait/run histogram della lane fiscale"
  );
});

test("Fase M4 espone dashboard runtime per monitor operativo", () => {
  const metricsSource = readFileSync(
    path.join(cassaDir, "modules", "runtime-metrics.js"),
    "utf8",
  );
  const monitorHtml = readFileSync(
    path.join(projectDir, "monitor-frontend", "dist", "index.html"),
    "utf8",
  );
  const monitorApp = readFileSync(
    path.join(projectDir, "monitor-frontend", "dist", "app.js"),
    "utf8",
  );
  assert.match(
    metricsSource,
    /export function buildRuntimeMetricsDashboard/,
    "M4 deve centralizzare il summary dashboard runtime nel backend"
  );
  assert.match(
    metricsSource,
    /outboxLagMs[\s\S]+idempotency[\s\S]+fallbackRate[\s\S]+p99Top/,
    "M4 deve esporre lag outbox, hit idempotenza, fallback relazionale e p99 route"
  );
  assert.match(
    monitorHtml,
    /id=["']runtime-metrics-list["']/,
    "il monitor deve avere un pannello dedicato alle metriche runtime"
  );
  assert.match(
    monitorApp,
    /\/api\/monitor\/runtime-metrics[\s\S]+renderRuntimeMetrics/,
    "il monitor deve caricare e renderizzare il summary runtime autenticato"
  );
});

test("P4 proxy realtime ammette oltre 100 stream SSE concorrenti", () => {
  const frontendServer = readFileSync(
    path.join(projectDir, "serve-frontends.mjs"),
    "utf8",
  );
  assert.match(frontendServer, /FRONTEND_REALTIME_PROXY_MAX_SOCKETS/);
  assert.match(frontendServer, /REALTIME_PROXY_MAX_SOCKETS[\s\S]+512/);
  assert.match(frontendServer, /maxSockets:\s*REALTIME_PROXY_MAX_SOCKETS/);
});

test("MP-4f report loadtest espongono changed/no-op del table-state sync", () => {
  const loadtestSource = readFileSync(
    path.join(appDir, "scripts", "loadtest-full-capacity.mjs"),
    "utf8",
  );
  const enduranceSource = readFileSync(
    path.join(appDir, "scripts", "endurance-sim-50k.mjs"),
    "utf8",
  );
  for (const source of [loadtestSource, enduranceSource]) {
    assert.match(
      source,
      /orderSyncTableStateChanged[\s\S]+orderSyncTableStateNoops[\s\S]+orderSyncTableStateChangeRate/,
      "i report stress devono leggere i contatori table-state changed/no-op"
    );
    assert.match(
      source,
      /Sync table-state changed\/no-op: \$\{orderSyncTableStateChanged\} \/ \$\{orderSyncTableStateNoops\}/,
      "i report stress devono mostrare la riga changed/no-op table-state"
    );
  }
});

test("MP-4i orders-flow copre tableStates externalized su orders/sync", () => {
  const ordersFlowSource = readFileSync(
    path.join(cassaDir, "tests", "orders-flow.e2e.test.mjs"),
    "utf8",
  );
  assert.match(
    ordersFlowSource,
    /BACKEND_APP_STATE_SPLIT_TABLE_STATES:\s*["']externalized["'][\s\S]+\/api\/integration\/orders\/sync[\s\S]+persistedTable\.status,\s*undefined[\s\S]+split\.listTableStates\(\)[\s\S]+splitTable\.state\.status,\s*["']payment_due["']/,
    "orders/sync deve avere una prova e2e con tableStates externalized e JSON primario senza stato operativo tavolo"
  );
});

test("MP-4o orders/sync usa piano preparazione snapshot-ready", () => {
  const serverSource = backendSource;
  const preparationQueueSource = readFileSync(
    path.join(cassaDir, "modules", "orders", "order-preparation-queue.js"),
    "utf8",
  );
  assert.match(
    serverSource,
    /async function handleIntegrationOrderSync[\s\S]+const orderWorkflowSnapshot = relationalOrderWorkflowTarget\.found[\s\S]+buildIntegrationOrderSyncPreparationPlan\(\s*orderWorkflowSnapshot[\s\S]+workflowSyncReason[\s\S]+maxPreparingOrdersPerLane:\s*INTEGRATION_MAX_PREPARING_ORDERS_PER_LANE[\s\S]+syncPreparationPlan\.preparationQueueFull/,
    "orders/sync deve delegare handoff/limite coda al piano snapshot-ready"
  );
  assert.doesNotMatch(
    serverSource,
    /demoteEmptyPreparationOrdersForSelection\(db,\s*mergedOrder/,
    "orders/sync non deve piu calcolare demotion direttamente dal dbCache"
  );
  assert.doesNotMatch(
    serverSource,
    /countPreparingIntegrationOrdersInLane\(\s*db,\s*mergedOrder/,
    "orders/sync non deve piu contare prep direttamente dal dbCache"
  );
  assert.match(
    preparationQueueSource,
    /export function buildIntegrationOrderSyncPreparationPlan[\s\S]+buildEmptyPreparationSelectionDemotionPlan[\s\S]+countPreparingIntegrationOrdersInLane/,
    "il piano sync deve comporre demotion e conteggio su snapshot ordini"
  );
});

test("MP-4p riconciliazione coda usa piano applicativo snapshot-ready", () => {
  const serverSource = backendSource;
  const preparationQueueSource = readFileSync(
    path.join(cassaDir, "modules", "orders", "order-preparation-queue.js"),
    "utf8",
  );
  assert.match(
    serverSource,
    /function reconcileIntegrationPreparationQueue[\s\S]+buildIntegrationOrderWorkflowSnapshotSource\(db,\s*\{[\s\S]+sourceKind:\s*["']dbcache["'][\s\S]+buildPreparationQueueReconciliationApplyPlan\(\s*orderWorkflowSnapshot[\s\S]+promoteOrder:\s*\(order\)[\s\S]+buildPromotionRecord:\s*\(order\)[\s\S]+reconciliationPlan\.changed/,
    "reconcileIntegrationPreparationQueue deve applicare un piano snapshot-ready unico"
  );
  assert.doesNotMatch(
    serverSource,
    /const normalizedOrders = reconciliationPlan\.orders[\s\S]+applyPreparationQueuePromotionPlan\(/,
    "il server non deve ricomporre manualmente reconciliation plan e promotion plan"
  );
  assert.match(
    preparationQueueSource,
    /export function buildPreparationQueueReconciliationApplyPlan[\s\S]+buildPreparationQueueReconciliationPlan[\s\S]+applyPreparationQueuePromotionPlan/,
    "il modulo coda deve comporre riconciliazione e promozione in un piano applicativo puro"
  );
});

test("MP-4q order workflow usa sorgente snapshot esplicita", () => {
  const serverSource = backendSource;
  const preparationQueueSource = readFileSync(
    path.join(cassaDir, "modules", "orders", "order-preparation-queue.js"),
    "utf8",
  );
  assert.match(
    serverSource,
    /async function handleIntegrationOrderSync[\s\S]+const dbCacheOrderWorkflowSnapshot = buildIntegrationOrderWorkflowSnapshotSource\(db,\s*\{[\s\S]+sourceKind:\s*["']dbcache["'][\s\S]+const orderWorkflowSnapshot = relationalOrderWorkflowTarget\.found[\s\S]+const syncPreparationPlan = buildIntegrationOrderSyncPreparationPlan\(\s*orderWorkflowSnapshot/,
    "orders/sync deve costruire una sorgente snapshot esplicita prima del piano workflow"
  );
  assert.match(
    serverSource,
    /function reconcileIntegrationPreparationQueue[\s\S]+const orderWorkflowSnapshot = buildIntegrationOrderWorkflowSnapshotSource\(db,\s*\{[\s\S]+sourceKind:\s*["']dbcache["'][\s\S]+\}\);\s*const reconciliationPlan = buildPreparationQueueReconciliationApplyPlan\(\s*orderWorkflowSnapshot/,
    "la riconciliazione coda deve costruire una sorgente snapshot esplicita prima del piano"
  );
  assert.match(
    preparationQueueSource,
    /export function buildIntegrationOrderWorkflowSnapshotSource[\s\S]+__orderWorkflowSnapshotSource[\s\S]+sourceKind[\s\S]+orderCount/,
    "il modulo coda deve normalizzare le sorgenti ordine per array/dbcache/read-model"
  );
});

test("MP-4r orders/sync usa target/apply plan snapshot-ready", () => {
  const serverSource = backendSource;
  const preparationQueueSource = readFileSync(
    path.join(cassaDir, "modules", "orders", "order-preparation-queue.js"),
    "utf8",
  );
  const syncSource = corpoFunzione("handleIntegrationOrderSync");

  assert.match(
    syncSource,
    /resolveIntegrationOrderWorkflowTarget\(\s*relationalOrderWorkflowSnapshot,\s*id[\s\S]+resolveIntegrationOrderWorkflowTarget\(dbCacheOrderWorkflowSnapshot,\s*id[\s\S]+const currentOrder = orderWorkflowTarget\.order/,
    "orders/sync deve risolvere l'ordine corrente tramite target snapshot esplicito"
  );
  assert.match(
    syncSource,
    /buildIntegrationOrderWorkflowApplyPlan\([\s\S]+orders:\s*syncPreparationPlan\.orders[\s\S]+orderWorkflowScopedMergeFilteredOrders[\s\S]+mergeIntegrationOrderWorkflowScopedOrders\(db\.integration\.orders,\s*orderWorkflowScopedMergeOrders/,
    "orders/sync deve applicare l'ordine aggiornato tramite piano snapshot e fondere eventuali snapshot parziali"
  );
  assert.doesNotMatch(
    syncSource,
    /const orderIndex = findIntegrationOrderIndexByLookup\(\s*db\.integration\.orders/,
    "orders/sync non deve risolvere direttamente l'indice sul dbCache"
  );
  assert.doesNotMatch(
    syncSource,
    /db\.integration\.orders\[orderIndex\] = mergedOrder/,
    "orders/sync non deve scrivere direttamente nell'indice dbCache"
  );
  assert.match(
    preparationQueueSource,
    /export function resolveIntegrationOrderWorkflowTarget[\s\S]+snapshotSource[\s\S]+export function buildIntegrationOrderWorkflowApplyPlan[\s\S]+orders = snapshotSource\.orders\.slice\(\)/,
    "il modulo coda deve esporre target/apply plan puri per sostituire il read model"
  );
});

test("MP-4s orders/sync usa snapshot relazionale quando disponibile", () => {
  const serverSource = backendSource;
  const relationalSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "relational-order-create.js"),
    "utf8",
  );
  const metricsSource = readFileSync(
    path.join(cassaDir, "modules", "runtime-metrics.js"),
    "utf8",
  );
  const syncSource = corpoFunzione("handleIntegrationOrderSync");

  assert.match(
    syncSource,
    /const relationalOrderWorkflowStationIds = normalizeStringList[\s\S]+listRelationalOrderWorkflowSnapshot\(\{[\s\S]+enabled:\s*RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY[\s\S]+runtimeMetrics[\s\S]+orderId:\s*id[\s\S]+stationIds:\s*relationalOrderWorkflowStationIds/,
    "orders/sync deve provare lo snapshot relazionale scoped per postazione solo con write-primary sync attivo"
  );
  assert.match(
    syncSource,
    /const orderWorkflowSnapshot = relationalOrderWorkflowTarget\.found\s*\?\s*relationalOrderWorkflowSnapshot\s*:\s*dbCacheOrderWorkflowSnapshot/,
    "orders/sync deve usare il relazionale solo se contiene il target e altrimenti ricadere sul dbCache"
  );
  assert.match(
    relationalSource,
    /export async function listRelationalOrderWorkflowSnapshot[\s\S]+const repository = new OrdersRelationalRepository\(db\)[\s\S]+listScopedRelationalOrders\(repository,[\s\S]+sourceKind:\s*["']relational-orders["']/,
    "il modulo relazionale deve esporre uno snapshot workflow ordini esternalizzato"
  );
  assert.match(
    relationalSource,
    /const listScopedOrders\s*=[\s\S]+repository\.listWorkflowOrders\(filters\)[\s\S]+repository\.listOrders\(filters\)/,
    "lo snapshot relazionale deve mantenere il selettore light/full"
  );
  assert.match(
    relationalSource,
    /orderIds\.length === 0[\s\S]+return listScopedOrders\(workflowStatuses\.length > 0 \? \{ statuses: workflowStatuses \} : \{\}\)/,
    "lo snapshot relazionale completo deve applicare gli eventuali stati workflow"
  );
  assert.match(
    relationalSource,
    /listScopedOrders\(\{\s*stationIds:\s*targetStationIds[\s\S]+statuses:\s*workflowStatuses[\s\S]+listScopedOrders\(\{\s*tableIds:\s*targetTableIds\s*\}\)/,
    "lo snapshot relazionale deve mantenere gli scope per postazione/tavolo"
  );
  assert.match(relationalSource, /scoped,/);
  assert.match(
    metricsSource,
    /relationalSnapshotRead/,
    "la metrica di lettura snapshot relazionale deve restare visibile nei runtime metrics"
  );
});

test("P3.53 snapshot relazionale batcha stationIds/tableIds invece di ciclare query singole", () => {
  const relationalSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "relational-order-create.js"),
    "utf8",
  );
  const repoSource = readFileSync(
    path.join(cassaDir, "db", "relational", "orders.repo.js"),
    "utf8",
  );
  const scopedSource = relationalSource.slice(
    relationalSource.indexOf("function listScopedRelationalOrders"),
    relationalSource.indexOf("export async function findRelationalOrderCreateIdempotencyRecord"),
  );

  assert.match(repoSource, /#appendFilterList\([\s\S]+IN \(\$\{normalized\.map\(\(\) => "\?"\)\.join\(", "\)\}\)/);
  assert.match(repoSource, /this\.#appendFilterList\(clauses,\s*params,\s*["']table_id["'],\s*filters\.tableIds\)/);
  assert.match(repoSource, /this\.#appendFilterList\(clauses,\s*params,\s*["']station_id["'],\s*filters\.stationIds\)/);
  assert.match(scopedSource, /if \(targetStationIds\.length > 0\) listScopedOrders\(\{\s*stationIds:\s*targetStationIds[\s\S]+statuses:\s*workflowStatuses/);
  assert.match(scopedSource, /if \(targetTableIds\.length > 0\) listScopedOrders\(\{\s*tableIds:\s*targetTableIds\s*\}\)\.forEach\(addOrder\)/);
  assert.doesNotMatch(scopedSource, /targetStationIds\.forEach\(\(id\)/);
  assert.doesNotMatch(scopedSource, /targetTableIds\.forEach\(\(id\)/);
});

test("P3.32 orders/sync persiste table_state relazionale prima del mirror app-state", () => {
  const serverSource = backendSource;
  const syncSource = corpoFunzione("handleIntegrationOrderSync");

  assert.match(
    syncSource,
    /syncRelationalOrderPrimary\([\s\S]+orders\.sync\.relationalFinancialSnapshotRead[\s\S]+buildOrderFinancialSyncState\([\s\S]+captureRelationalOrderFinancialTableGuard\([\s\S]+syncPosTableFinancialsFromIntegrationOrders\([\s\S]+applyOrderFinancialTableRevisionTokens\([\s\S]+persistRelationalOrderFinancialTables\([\s\S]+writeIntegrationOrderSyncDb/,
    "orders/sync deve scrivere ordine e table_state relazionali prima del mirror app-state asincrono"
  );
});

test("P3.33 il mirror async posSettingsTables si salta solo dietro read-primary tavoli", () => {
  const serverSource = backendSource;
  const metricsSource = readFileSync(
    path.join(cassaDir, "modules", "runtime-metrics.js"),
    "utf8",
  );

  assert.match(
    serverSource,
    /ORDERS_ASYNC_FLUSH_SKIP_POSSETTINGS_TABLES[\s\S]+RELATIONAL_TABLES_READ_PRIMARY[\s\S]+RELATIONAL_LAYOUT_TABLES_READ_PRIMARY[\s\S]+APP_STATE_TABLE_STATES_SPLIT_MODE === ["']externalized["']/,
    "lo skip deve essere efficace solo se layout/tavoli leggono dal relazionale e tableStates e' externalized"
  );
  assert.match(
    serverSource,
    /shouldSyncPosSettingsTables[\s\S]+stepPrefix === ["']orders\.asyncFlush["'][\s\S]+ordersAsyncFlushPosSettingsTablesSkipped/,
    "solo il flush async ordini deve saltare posSettingsTables e contare lo skip"
  );
  assert.match(metricsSource, /ordersAsyncFlushPosSettingsTablesSkipped:\s*0/);
});

test("P3.34 il flush async salta auditRecent vuoto solo con audit workflow GO", () => {
  const serverSource = backendSource;
  const metricsSource = readFileSync(
    path.join(cassaDir, "modules", "runtime-metrics.js"),
    "utf8",
  );

  assert.match(
    serverSource,
    /ORDERS_ASYNC_FLUSH_SKIP_EMPTY_AUDIT[\s\S]+BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO[\s\S]+DB_MODE === ["']mysql["'][\s\S]+MYSQL_SPLIT_APP_STATE_DOMAINS/,
    "lo skip audit vuoto deve richiedere audit workflow GO e split MySQL"
  );
  assert.match(
    serverSource,
    /const auditEventIds = normalizeIntegrationOrderWriteIds\(options\.auditEventIds\)[\s\S]+auditEventIds\.length > 0[\s\S]+stepPrefix === ["']orders\.asyncFlush["'][\s\S]+ordersAsyncFlushEmptyAuditSkipped/,
    "solo il flush async ordini senza auditEventIds deve saltare auditRecent e contare lo skip"
  );
  assert.match(metricsSource, /ordersAsyncFlushEmptyAuditSkipped:\s*0/);
});

test("P3.35 il flush async viene inoltrato all'owner prima del lock con fallback locale", () => {
  const serverSource = backendSource;
  const routesSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "integration.routes.js"),
    "utf8",
  );
  const routeHandlersSource = readFileSync(
    path.join(cassaDir, "routes", "route-handlers.js"),
    "utf8",
  );
  const ownerFlushSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "order-async-owner-flush.js"),
    "utf8",
  );
  const queueSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "order-async-appstate-flush.js"),
    "utf8",
  );
  const metricsSource = readFileSync(
    path.join(cassaDir, "modules", "runtime-metrics.js"),
    "utf8",
  );

  assert.match(
    routesSource,
    /serviceRoute\(["']POST["'],\s*["']\/api\/internal\/orders\/async-appstate-flush["'],\s*["']integration\.orderAsyncAppStateFlush["'],\s*["']integration["']/,
    "la route interna deve richiedere service token integration"
  );
  assert.match(
    serverSource,
    /createOrderAsyncOwnerFlushForwarder\(\{[\s\S]+enabled:\s*process\.env\.ORDERS_ASYNC_FLUSH_REMOTE_OWNER === ["']1["'][\s\S]+getRole:\s*\(\)\s*=>\s*backendProcessRouteGuard\?\.role[\s\S]+ownerUrl:\s*process\.env\.ORDERS_ASYNC_FLUSH_OWNER_URL[\s\S]+serviceToken:\s*INTEGRATION_SERVICE_TOKEN/,
    "il forward remoto deve essere attivo solo dietro flag, owner URL e service token"
  );
  assert.match(
    ownerFlushSource,
    /const active = enabled === true[\s\S]+String\(serviceToken \?\? ["']["']\)\.length > 0[\s\S]+getRole\(\) !== ["']api-worker["'][\s\S]+fetchWithTimeout[\s\S]+X-Service-Token[\s\S]+ordersAsyncFlushRemoteOwnerAccepted[\s\S]+ordersAsyncFlushRemoteOwnerFallbacks/,
    "solo gli api-worker devono inoltrare all'owner e devono avere fallback locale"
  );
  const forwarderIndex = serverSource.indexOf("const orderAsyncOwnerFlushForwarder =");
  const queueIndex = serverSource.indexOf("const orderAsyncAppStateFlushQueue =");
  assert.ok(forwarderIndex >= 0 && queueIndex > forwarderIndex, "il forwarder deve essere costruito prima della coda");
  assert.match(
    serverSource,
    /createOrderAsyncAppStateFlushQueue\(\{[^\n]+tryRemoteFlush:\s*\(options\)\s*=>\s*tryForwardOrderAsyncFlushToOwner\(options\)/,
    "la coda deve provare l'owner prima del percorso locale"
  );
  const remoteIndex = queueSource.indexOf("await tryRemoteFlush(options, context)");
  const exclusiveIndex = queueSource.indexOf('typeof runExclusive === "function"');
  assert.ok(remoteIndex >= 0 && exclusiveIndex > remoteIndex, "il tentativo remoto deve precedere il lock esclusivo");
  const writerStart = serverSource.indexOf("async function writeIntegrationOrderSyncDb");
  const writerEnd = serverSource.indexOf("async function handleInternalOrderAsyncAppStateFlush", writerStart);
  const writerSource = serverSource.slice(writerStart, writerEnd);
  assert.doesNotMatch(writerSource, /orderAsyncOwnerFlushForwarder\.forward/, "il writer locale non deve inoltrare dopo aver letto il DB");
  assert.match(
    routeHandlersSource,
    /["']integration\.orderAsyncAppStateFlush["']:\s*handleInternalOrderAsyncAppStateFlush/,
    "la route interna deve essere mappata alla handler"
  );
  assert.match(
    serverSource,
    /handleInternalOrderAsyncAppStateFlush[\s\S]+SHOULD_RUN_BACKEND_OWNER_JOBS[\s\S]+const options = buildRemoteOwnerFlushOptions\(payload\?\.options\)[\s\S]+ordersAsyncFlushRemoteOwnerHandled[\s\S]+orderAsyncAppStateFlushQueue\.tryDefer\(options\)[\s\S]+ordersAsyncFlushRemoteOwnerDeferred[\s\S]+sendJson\(res,\s*202[\s\S]+ordersAsyncFlushRemoteOwnerSyncFallbacks[\s\S]+readDb\(\{ forceReload: true \}\)[\s\S]+writeIntegrationOrderSyncDb\(db,\s*options\)/,
    "l'endpoint interno deve girare solo sull'owner, accodare il flush remoto e usare il writer sincrono solo in backpressure"
  );
  assert.match(
    serverSource,
    /safeMethod === ["']POST["'] &&\s*safePath === ["']\/api\/internal\/orders\/async-appstate-flush["'][\s\S]{0,80}return false;/,
    "il control-plane del flush remoto non deve attraversare la dbMutationQueue globale"
  );
  assert.match(metricsSource, /ordersAsyncFlushRemoteOwnerForwarded:\s*0/);
  assert.match(metricsSource, /ordersAsyncFlushRemoteOwnerAccepted:\s*0/);
  assert.match(metricsSource, /ordersAsyncFlushRemoteOwnerFallbacks:\s*0/);
  assert.match(metricsSource, /ordersAsyncFlushRemoteOwnerHandled:\s*0/);
  assert.match(metricsSource, /ordersAsyncFlushRemoteOwnerDeferred:\s*0/);
  assert.match(metricsSource, /ordersAsyncFlushRemoteOwnerSyncFallbacks:\s*0/);
});

test("P4 multi-process riserva gli ID ordine nel relazionale condiviso", () => {
  const serverSource = backendSource;
  const repositorySource = readFileSync(
    path.join(cassaDir, "db", "relational", "orders.repo.js"),
    "utf8",
  );
  assert.match(serverSource, /allocateRelationalIntegrationOrderSequence[\s\S]+allocateNextOrderId/);
  assert.match(repositorySource, /allocateNextOrderId[\s\S]+runRelationalTransaction/);
  assert.match(repositorySource, /order_id_allocator[\s\S]+allocated \+ 1/);
});

test("P4 stampa esplicita ha precedenza sul routing operativo non risolto", () => {
  const serverSource = backendSource;
  const resolver = serverSource.slice(
    serverSource.indexOf("function resolvePrinterFromSettings"),
    serverSource.indexOf("function buildPrintPrependChunks"),
  );
  assert.ok(resolver.indexOf("const explicitPrinterId") < resolver.indexOf("const operationalTarget"));
});

test("P3.56 il monitor runtime owner aggrega le metriche dei worker via endpoint interno", () => {
  const serverSource = backendSource;
  const statusRoutesSource = readFileSync(
    path.join(cassaDir, "modules", "status", "status.routes.js"),
    "utf8",
  );
  const statusHandlersSource = readFileSync(
    path.join(cassaDir, "modules", "status", "status.handlers.js"),
    "utf8",
  );
  const topologySource = readFileSync(
    path.join(cassaDir, "core", "process-topology.js"),
    "utf8",
  );

  assert.match(
    statusRoutesSource,
    /path:\s*["']\/api\/internal\/monitor\/runtime-metrics["'][\s\S]+handlerKey:\s*["']monitor\.runtimeMetricsInternal["'][\s\S]+service:\s*["']integration["']/,
    "le metriche worker devono passare da una route interna protetta da service token"
  );
  assert.match(
    topologySource,
    /INTERNAL_SERVICE_PATHS[\s\S]+\/api\/internal\/monitor\/runtime-metrics/,
    "gli api-worker devono accettare la route interna di sola lettura runtime"
  );
  assert.match(
    topologySource,
    /INTERNAL_SERVICE_PATHS[\s\S]+\/api\/internal\/print-spool\/auto-print/,
    "i processi multipli devono accettare la route interna auto-print"
  );
  assert.match(
    serverSource,
    /RUNTIME_METRICS_PEER_URLS[\s\S]+BACKEND_RUNTIME_METRICS_PEER_URLS[\s\S]+BACKEND_API_WORKER_ORIGIN/,
    "l'owner deve poter scoprire i peer dal valore esplicito o dal deploy multiprocesso esistente"
  );
  assert.match(
    serverSource,
    /createStatusHandlers\(\{[\s\S]+backendProcessRole:\s*process\.env\.BACKEND_PROCESS_ROLE[\s\S]+fetchWithTimeout[\s\S]+runtimeMetricsPeerTimeoutMs:\s*RUNTIME_METRICS_PEER_TIMEOUT_MS[\s\S]+runtimeMetricsPeerUrls:\s*RUNTIME_METRICS_PEER_URLS[\s\S]+runtimeMetricsServiceToken:\s*INTEGRATION_SERVICE_TOKEN/,
    "il modulo status deve ricevere role, fetch e token per interrogare i worker"
  );
  assert.match(
    statusHandlersSource,
    /fetchRuntimeMetricsPeer[\s\S]+\/api\/internal\/monitor\/runtime-metrics[\s\S]+X-Service-Token[\s\S]+runtimeMetricsServiceToken/,
    "la raccolta peer deve usare il token di servizio e non sessioni admin"
  );
  assert.match(
    statusHandlersSource,
    /\[["']api-worker["'], ["']table-lock-worker["']\]\.includes\(normalizeText\(backendProcessRole\)\)[\s\S]+workerCollection[\s\S]+workers/,
    "i worker API e lock non devono fare fan-out ricorsivo, solo l'owner aggrega"
  );
});

test("P3.57 orders/sync salta il financial sync solo su no-op economico verificato", () => {
  const serverSource = backendSource;
  const moduleSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "order-financial-sync-source.js"),
    "utf8",
  );
  const syncSource = corpoFunzione("handleIntegrationOrderSync");

  assert.match(moduleSource, /export function buildOrderSyncFinancialNoopFastPath/);
  assert.match(moduleSource, /financialOrderSignature[\s\S]+tableLooksCompatible[\s\S]+queue_side_effects/);
  assert.match(
    syncSource,
    /buildOrderSyncFinancialNoopFastPath\(\{[\s\S]+BACKEND_ORDERS_SYNC_FINANCIAL_NOOP_FASTPATH !== ["']0["'][\s\S]+currentOrder[\s\S]+mergedOrder[\s\S]+queuePromotions[\s\S]+selectionHandoffDemotions/,
    "il fast path deve essere reversibile via env e deve vedere ordine corrente/futuro e side effect di coda"
  );
  assert.match(
    syncSource,
    /financialNoopFastPath[\s\S]+else \{[\s\S]+orders\.sync\.relationalFinancialSnapshotRead[\s\S]+syncPosTableFinancialsFromIntegrationOrders/,
    "il percorso relazionale completo deve restare fallback quando lo skip non e' autorizzato"
  );
});

test("P3.58 orders/sync no-op economico prepara la snapshot tavolo realtime", () => {
  const serverSource = backendSource;
  const moduleSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "order-financial-sync-source.js"),
    "utf8",
  );
  const syncSource = corpoFunzione("handleIntegrationOrderSync");

  assert.match(moduleSource, /export function addOrderSyncFinancialNoopTableSnapshot/);
  assert.match(
    syncSource,
    /BACKEND_ORDERS_SYNC_NOOP_TABLE_SNAPSHOT !== ["']0["'][\s\S]+addOrderSyncFinancialNoopTableSnapshot\([\s\S]+findIntegrationLayoutTableFromSettings\(settings,\s*mergedOrder\.tableId\)/,
    "il no-op economico deve agganciare una snapshot tavolo leggera e rollbackabile prima del fallback realtime"
  );
  assert.ok(
    syncSource.indexOf("addOrderSyncFinancialNoopTableSnapshot") <
      syncSource.indexOf("findIntegrationLayoutTableSnapshot(db, mergedOrder.tableId)"),
    "la snapshot no-op deve essere pronta prima del fallback legacy costoso"
  );
});

test("P3.59 orders/sync limita lo snapshot station agli stati di coda", () => {
  const serverSource = backendSource;
  const relationalSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "relational-order-create.js"),
    "utf8",
  );
  const repoSource = readFileSync(
    path.join(cassaDir, "db", "relational", "orders.repo.js"),
    "utf8",
  );
  const syncSource = corpoFunzione("handleIntegrationOrderSync");

  assert.match(
    syncSource,
    /workflowStatuses:\s*process\.env\.BACKEND_ORDERS_SYNC_WORKFLOW_STATION_STATUS_FILTER === ["']0["'] \? \[\] : \[["']waiting["'], ["']prep["']\]/,
    "orders/sync deve filtrare il contesto station a waiting/prep con rollback env"
  );
  assert.match(
    relationalSource,
    /const workflowStatuses = uniqueTexts\(options\.workflowStatuses\)[\s\S]+listScopedOrders\(\{ stationIds: targetStationIds,[\s\S]+statuses:\s*workflowStatuses/,
    "il modulo snapshot deve applicare il filtro stati solo alla query station-scoped"
  );
  assert.match(
    repoSource,
    /listWorkflowOrders\(filters = \{\}\)[\s\S]+this\.#appendFilterList\(clauses,\s*params,\s*["']status["'],\s*filters\.statuses\)/,
    "il repository deve supportare status IN per evitare di idratare la storia della postazione"
  );
});

test("P3.39 il flush async owner resta sul profilo stabile finche non esiste uno scheduler adattivo", () => {
  const deploySource = readFileSync(
    path.join(appDir, "deploy", "systemd", "50-p3-orders-write-primary.conf"),
    "utf8",
  );
  const serverSource = backendSource;
  assert.match(
    deploySource,
    /Environment=ORDERS_ASYNC_FLUSH_INTERVAL_MS=500\b/,
    "il profilo multiprocesso deve restare sul valore misurato come piu stabile finche non c'e' un canary migliore"
  );
  assert.match(deploySource, /Environment=ORDERS_ASYNC_FLUSH_MYSQL_NOWAIT=0\b/);
  assert.match(deploySource, /Environment=ORDERS_ASYNC_FLUSH_DETACH_LAST_WRITE_AT=0\b/);
  assert.match(deploySource, /Environment=ORDERS_ASYNC_FLUSH_DETACH_SEQUENCE_WHEN_SAFE=0\b/);
  assert.match(deploySource, /Environment=BACKEND_STATION_STATE_MARKER_LOCK_SKIP=0\b/);
  assert.match(deploySource, /Environment=PRINT_SPOOL_AUTO_PRINT_REMOTE_OWNER=1\b/);
  assert.match(deploySource, /Environment=PRINT_SPOOL_AUTO_PRINT_OWNER_URL=http:\/\/127\.0\.0\.1:5281\b/);
  assert.match(deploySource, /Environment=PRINT_SPOOL_AUTO_PRINT_REMOTE_OWNER_TIMEOUT_MS=10000\b/);
  assert.match(
    serverSource,
    /ORDERS_ASYNC_FLUSH_INTERVAL_MS[\s\S]+parsePositiveInt\(process\.env\.ORDERS_ASYNC_FLUSH_INTERVAL_MS,\s*25\)[\s\S]+createOrderAsyncAppStateFlushQueue\(\{[\s\S]+intervalMs:\s*ORDERS_ASYNC_FLUSH_INTERVAL_MS/,
    "il backend deve continuare a usare il knob deployato per la coda async flush"
  );
  assert.match(
    serverSource,
    /stationStatesPartialMarkerLockElision:\s*process\.env\.BACKEND_STATION_STATE_MARKER_LOCK_SKIP === ["']1["']/,
    "il canary marker station-state deve restare dietro un flag backend esplicito",
  );
  assert.match(
    serverSource,
    /ORDERS_ASYNC_FLUSH_MYSQL_NOWAIT[\s\S]+lockRowsNowait:\s*ORDERS_ASYNC_FLUSH_MYSQL_NOWAIT\s*&&\s*stepPrefix === ["']orders\.asyncFlush["']/,
  );
  assert.match(
    serverSource,
    /ORDERS_ASYNC_FLUSH_DETACH_LAST_WRITE_AT[\s\S]+ORDERS_ASYNC_FLUSH_DETACH_SEQUENCE_WHEN_SAFE[\s\S]+detachSequence[\s\S]+!canBulkNotifications[\s\S]+partitionOrderAsyncIntegrationObjectFields[\s\S]+mysql\.integrationBulk[\s\S]+preserveNewerIntegrationRecords:\s*detachLastWriteAt \|\| detachSequence[\s\S]+mysql\.hotMetadataDetached[\s\S]+objectFields:\s*integrationFieldPartition\.detachedFields[\s\S]+preserveNewerIntegrationRecords:\s*true/,
    "il canary deve togliere solo lastWriteAt dal batch ordini e ripristinarlo monotono dopo il commit business",
  );
});

test("P3.43 snapshot tavolo singolo non ricostruisce tutto il layout", () => {
  const serverSource = backendSource;
  const findStart = serverSource.indexOf("function findIntegrationLayoutTableSnapshot");
  const syncStart = serverSource.indexOf("function syncPosTableFinancialsFromIntegrationOrders");
  const tableSnapshotSource = serverSource.slice(findStart, syncStart);

  assert.match(
    serverSource,
    /function buildIntegrationLayoutTableSnapshot\([\s\S]+targetTableIds:\s*\[baseTable\.id\][\s\S]+targetRoomNumberKeys[\s\S]+buildIntegrationTableOrderStats\([\s\S]+targetOptions[\s\S]+buildIntegrationTableLiveStats\([\s\S]+targetOptions/,
    "la snapshot singolo tavolo deve filtrare order stats e live stats sul target"
  );
  assert.match(
    tableSnapshotSource,
    /return buildIntegrationLayoutTableSnapshot\(db,\s*normalizedTableId\)/,
    "findIntegrationLayoutTableSnapshot deve usare il fast path singolo tavolo"
  );
  assert.doesNotMatch(
    tableSnapshotSource,
    /buildIntegrationLayoutSnapshot\(/,
    "findIntegrationLayoutTableSnapshot non deve ricostruire tutto il layout"
  );
});

test("P3.44 live stats filtrati costruiscono solo le sessioni target", () => {
  const serverSource = backendSource;
  const liveStatsStart = serverSource.indexOf("function buildIntegrationTableLiveStats");
  const sessionStart = serverSource.indexOf("function buildIntegrationCurrentTableSessions");
  const liveStatsSource = serverSource.slice(liveStatsStart, sessionStart);
  const sessionSource = serverSource.slice(sessionStart, serverSource.indexOf("function getIntegrationTableSessionForOrder"));

  assert.match(
    liveStatsSource,
    /buildIntegrationCurrentTableSessions\(db,\s*options\)/,
    "buildIntegrationTableLiveStats deve propagare il filtro target alle sessioni"
  );
  assert.match(
    sessionSource,
    /targetFilter\.hasTargetFilter[\s\S]+createIntegrationLayoutRoomResolver\(db\?\.posSettings\)[\s\S]+buildIntegrationLayoutTableRecord\(table,\s*resolver\.resolveRoom\(table\)\)[\s\S]+targetTableIds\.has\(entry\.id\)[\s\S]+targetRoomNumberKeys\.has\(roomKey\)/,
    "buildIntegrationCurrentTableSessions deve costruire solo sessioni del target quando filtrato"
  );
});

test("P3.45 financial sync propaga il filtro target ai live stats", () => {
  const serverSource = backendSource;
  const financialStart = serverSource.indexOf("function syncPosTableFinancialsFromIntegrationOrders");
  const financialEnd = serverSource.indexOf("function resolveOrderFinancialSnapshotTableIds");
  const financialSource = serverSource.slice(financialStart, financialEnd);

  assert.match(
    financialSource,
    /targetOptions\s*=\s*targetSet\s*\?\s*\{\s*targetTableIds:\s*\[\.\.\.targetSet\]\s*\}\s*:\s*\{\}/,
    "financial sync deve ricavare targetOptions dai targetTableIds"
  );
  assert.match(
    financialSource,
    /const layout\s*=\s*targetSet\s*\?[\s\S]+createIntegrationLayoutRoomResolver\(settings\)[\s\S]+buildIntegrationLayoutTableRecord\(table,\s*resolver\.resolveRoom\(table\)\)[\s\S]+targetSet\.has\(String\(table\.id/,
    "financial sync deve costruire solo i record layout dei tavoli target quando filtrato"
  );
  assert.match(
    financialSource,
    /buildIntegrationCurrentTableSessions\([\s\S]+targetOptions\)[\s\S]+buildIntegrationTableLiveStats\([\s\S]+\{ \.\.\.targetOptions, currentTableSessions: tableSessions \}/,
    "financial sync deve usare live stats e sessioni filtrate sul target"
  );
});

test("P3.47 orders/sync espone split interno workflow/appState", () => {
  const serverSource = backendSource;
  const syncSource = corpoFunzione("handleIntegrationOrderSync");

  assert.match(
    syncSource,
    /recordOperation\(["']orderSyncInternal["']/,
    "orders/sync deve registrare metriche interne dedicate"
  );
  for (const label of ["readDbBootstrap", "authWorkflowSetup", "relationalSnapshotRead", "mergeSanitizeLock", "preparationPlan", "applyPlanQueue", "workflowApplyAudit", "relationalWrite", "financialSync", "realtimeTableSnapshot", "readyNotificationPublish", "auditEventIdsCollect", "appStateWrite", "realtimeResponse"]) {
    assert.match(syncSource, new RegExp(`recordOrderSyncStage\\(["']${label}["']\\)`));
  }
  assert.match(syncSource, /const orderSyncAuditEventIds = collectAuditEventIdsSince\(db, auditStartIndex\)[\s\S]+auditEventIds: orderSyncAuditEventIds/);
});

test("P3.54 orders/sync separa bootstrap, auth e lettura snapshot relazionale", () => {
  const serverSource = backendSource;
  const syncSource = corpoFunzione("handleIntegrationOrderSync");

  assert.match(
    syncSource,
    /const db = await readDb\([\s\S]+recordOrderSyncStage\(["']readDbBootstrap["']\)[\s\S]+validateSessionContext\(db,\s*payload\)[\s\S]+buildIntegrationOrderWorkflowSnapshotSource\(db[\s\S]+recordOrderSyncStage\(["']authWorkflowSetup["']\)[\s\S]+listRelationalOrderWorkflowSnapshot[\s\S]+recordOrderSyncStage\(["']relationalSnapshotRead["']\)/,
    "orders/sync deve misurare separatamente bootstrap readDb, setup auth/workflow e query snapshot"
  );
});

test("P3.55 orders/sync usa snapshot workflow light senza toccare i financial snapshot", () => {
  const serverSource = backendSource;
  const relationalSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "relational-order-create.js"),
    "utf8",
  );
  const repoSource = readFileSync(
    path.join(cassaDir, "db", "relational", "orders.repo.js"),
    "utf8",
  );
  const syncSource = corpoFunzione("handleIntegrationOrderSync");

  assert.match(
    serverSource,
    /const ORDERS_SYNC_WORKFLOW_LIGHT_SNAPSHOT = process\.env\.BACKEND_ORDERS_SYNC_WORKFLOW_LIGHT_SNAPSHOT !== ["']0["'][,;]/,
    "il fast path workflow light deve avere rollback con una sola variabile"
  );
  assert.match(
    syncSource,
    /workflowLight:\s*ORDERS_SYNC_WORKFLOW_LIGHT_SNAPSHOT && !INTEGRATION_PREPARATION_SELECTION_REASONS\.has\(workflowSyncReason\)/,
    "orders/sync deve disattivare lo snapshot leggero nei flussi selection che possono demansionare altri ordini"
  );
  assert.match(
    relationalSource,
    /workflowLight = false[\s\S]+listScopedRelationalOrders\(repository,[\s\S]+\{[\s\S]*workflowStatuses,[\s\S]*workflowLight,[\s\S]*\}/,
    "il modulo relazionale deve accettare workflowLight solo come opzione esplicita"
  );
  assert.match(
    repoSource,
    /listWorkflowOrders\(filters = \{\}\)[\s\S]+#hydrateWorkflowOrder\(row\)[\s\S]+#hydrateWorkflowItems\(source\.items\)[\s\S]+#hydrateWorkflowRoutes\(source\.lineRoutes\)/,
    "il repository deve avere una vista workflow idratata con campi minimi"
  );
  assert.match(
    syncSource,
    /listRelationalOrderWorkflowSnapshot\(\{[\s\S]+metricLabel:\s*["']orders\.sync\.relationalFinancialSnapshotRead["'][\s\S]+tableIds:/,
    "il financial sync deve restare su snapshot full, non workflow light"
  );
  assert.doesNotMatch(
    syncSource,
    /metricLabel:\s*["']orders\.sync\.relationalFinancialSnapshotRead["'][\s\S]{0,220}workflowLight/,
    "i financial snapshot non devono ricevere workflowLight"
  );
});

test("P3.48 orders/sync riusa lo snapshot tavolo del financial sync", () => {
  const serverSource = backendSource;
  const financialStart = serverSource.indexOf("function syncPosTableFinancialsFromIntegrationOrders");
  const financialEnd = serverSource.indexOf("function resolveOrderFinancialSnapshotTableIds");
  const syncStart = serverSource.indexOf("async function handleIntegrationOrderSync");
  const splitStart = serverSource.indexOf("async function handleIntegrationOrderLineSplit");
  const financialSource = serverSource.slice(financialStart, financialEnd);
  const syncSource = serverSource.slice(syncStart, splitStart);

  assert.match(
    financialSource,
    /tableSnapshotsById[\s\S]+buildIntegrationLayoutTableRecord\(tableFinancialPlan\.nextTable[\s\S]+overlayIntegrationLayoutTableFinancials\(snapshotTable,\s*liveStats\)[\s\S]+return \{ settings, liveStats, tableSnapshotsById/,
    "financial sync deve restituire snapshot realtime gia filtrati per tavolo target"
  );
  assert.match(
    syncSource,
    /financialSync\.tableSnapshotsById\?\.get\([\s\S]+findIntegrationLayoutTableSnapshot\(db,\s*mergedOrder\.tableId\)/,
    "orders/sync deve riusare lo snapshot financialSync prima del fallback legacy"
  );
});

test("P3.52 financial sync riusa le sessioni tavolo e scansiona audit in modo leggero", () => {
  const serverSource = backendSource;
  const financialStart = serverSource.indexOf("function syncPosTableFinancialsFromIntegrationOrders");
  const financialEnd = serverSource.indexOf("function resolveOrderFinancialSnapshotTableIds");
  const liveStart = serverSource.indexOf("function buildIntegrationTableLiveStats");
  const liveEnd = serverSource.indexOf("function normalizeIntegrationLayoutPendingBills");
  const sessionsStart = serverSource.indexOf("function buildIntegrationCurrentTableSessions");
  const sessionsEnd = serverSource.indexOf("function getIntegrationTableSessionForOrder");
  const financialSource = serverSource.slice(financialStart, financialEnd);
  const liveSource = serverSource.slice(liveStart, liveEnd);
  const sessionsSource = serverSource.slice(sessionsStart, sessionsEnd);

  assert.match(
    liveSource,
    /options\.currentTableSessions[\s\S]+buildIntegrationCurrentTableSessions\(db,\s*options\)/,
    "live stats deve accettare sessioni gia calcolate"
  );
  assert.match(
    financialSource,
    /const tableSessions = buildIntegrationCurrentTableSessions[\s\S]+buildIntegrationTableLiveStats\([\s\S]+\{ \.\.\.targetOptions, currentTableSessions: tableSessions \}/,
    "financial sync non deve ricalcolare due volte le sessioni tavolo"
  );
  assert.match(
    sessionsSource,
    /forEachIntegrationCurrentTableSessionAuditEvent\(db,/,
    "sessioni tavolo deve usare la scansione audit mirata"
  );
  assert.doesNotMatch(
    sessionsSource,
    /sanitizeAuditEvents\(db\?\.auditEvents\)/,
    "il percorso hot non deve sanitizzare e ordinare tutto l'audit log"
  );
});

test("P3.49 orders/sync spacchetta applyPlanQueue", () => {
  const serverSource = backendSource;
  const syncSource = corpoFunzione("handleIntegrationOrderSync");

  for (const label of ["revisionApply", "workflowApplyPlan", "workflowScopedMerge", "orderLabeler", "queueReconcile", "applyPlanQueue"]) {
    assert.match(syncSource, new RegExp(`recordOrderSyncStage\\(["']${label}["']\\)`));
  }
  assert.match(
    syncSource,
    /buildIntegrationOrderWorkflowApplyPlan\([\s\S]+recordOrderSyncStage\(["']workflowApplyPlan["']\)[\s\S]+mergeIntegrationOrderWorkflowScopedOrders[\s\S]+recordOrderSyncStage\(["']workflowScopedMerge["']\)[\s\S]+reconcileIntegrationPreparationQueue[\s\S]+recordOrderSyncStage\(["']queueReconcile["']\)/,
    "apply plan, scoped merge e queue reconcile devono essere misurati separatamente"
  );
});

test("P3.50 orders/sync usa fast scoped merge senza indice globale nel path caldo", () => {
  const serverSource = backendSource;
  const preparationQueueSource = readFileSync(path.join(cassaDir, "modules", "orders", "order-preparation-queue.js"), "utf8");
  const syncSource = corpoFunzione("handleIntegrationOrderSync");

  assert.match(
    syncSource,
    /orderWorkflowScopedMergeIds[\s\S]+selectionHandoffDemotions\.map[\s\S]+orderWorkflowScopedMergeFilteredOrders[\s\S]+orderWorkflowApplyPlan\.orders\.filter[\s\S]+orderWorkflowScopedMergeOrders[\s\S]+mergeIntegrationOrderWorkflowScopedOrders\(db\.integration\.orders,\s*orderWorkflowScopedMergeOrders,\s*\{[\s\S]+fastScopedMerge:\s*true[\s\S]+scopedMergeTailSize:\s*128[\s\S]+\}\)/,
    "orders/sync deve passare al merge scoped solo gli ordini cambiati con hint coda recente"
  );
  assert.match(
    preparationQueueSource,
    /dependencies\.fastScopedMerge === true[\s\S]+collectScopedMergeCandidateIndexes\(orderId,\s*dependencies,\s*baseOrders\.length\)[\s\S]+orderMatchesLookupValue\(baseOrders\[index\],\s*orderId\)[\s\S]+remainingById[\s\S]+findIntegrationOrderIndexByLookup\(baseOrders,\s*orderId\)[\s\S]+buildIntegrationOrderLookupIndex\(baseOrders\)/,
    "il modulo deve provare l'hint ordinale verificato prima del fallback con indice globale"
  );
  assert.match(preparationQueueSource, /scopedMergeTailSize[\s\S]+orderCount - offset/);
});

test("P3.51 preparation plan evita normalizzazione profonda sui workflow canonici invariati", () => {
  const preparationQueueSource = readFileSync(path.join(cassaDir, "modules", "orders", "order-preparation-queue.js"), "utf8");

  assert.match(
    preparationQueueSource,
    /function normalizeCanonicalOrderWorkflowForPreparationPlan[\s\S]+ownerStation[\s\S]+return ["']prep["'][\s\S]+function buildSameWorkflowPreparationFastNoop[\s\S]+currentWorkflow !== nextWorkflow[\s\S]+fastNoop:\s*true[\s\S]+buildIntegrationOrderSyncPreparationPlan[\s\S]+const fastNoop = buildSameWorkflowPreparationFastNoop[\s\S]+if \(fastNoop\) return fastNoop/,
    "il piano preparazione deve uscire subito se current/next hanno lo stesso workflow canonico"
  );
});

test("P3.60 orders/sync salta queue reconcile sui fast-noop non waiting", () => {
  const serverSource = backendSource;
  const metricsSource = readFileSync(path.join(cassaDir, "modules", "runtime-metrics.js"), "utf8");
  const preparationQueueSource = readFileSync(
    path.join(cassaDir, "modules", "orders", "order-preparation-queue.js"),
    "utf8",
  );
  const deploySource = readFileSync(
    path.join(appDir, "deploy", "systemd", "50-p3-orders-write-primary.conf"),
    "utf8",
  );
  const syncSource = corpoFunzione("handleIntegrationOrderSync");

  assert.match(
    serverSource,
    /ORDERS_SYNC_QUEUE_RECONCILE_FAST_SKIP = process\.env\.BACKEND_ORDERS_SYNC_QUEUE_RECONCILE_FAST_SKIP !== ["']0["']/,
    "lo skip queue reconcile deve avere rollback con una sola variabile"
  );
  assert.match(
    syncSource,
    /const orderSyncQueueReconcileFastSkip = ORDERS_SYNC_QUEUE_RECONCILE_FAST_SKIP && selectionHandoffDemotions\.length === 0 && \(\(syncPreparationPlan\.fastNoop === true && syncPreparationPlan\.currentWorkflow !== ["']waiting["']\) \|\| syncPreparationPlan\.entersPreparation === true\)[\s\S]+orderSyncQueueReconcileFastSkips[\s\S]+else if \([\s\S]+reconcileIntegrationPreparationQueue/,
    "orders/sync deve evitare la riconciliazione globale sui fast-noop non waiting e sugli ingressi prep che occupano gia la lane"
  );
  assert.match(
    syncSource,
    /recordOrderSyncStage\(["']queueReconcile["']\)/,
    "lo stage queueReconcile deve restare misurabile anche quando viene saltato"
  );
  assert.match(
    metricsSource,
    /orderSyncQueueReconcileFastSkips:\s*0/,
    "il numero di skip deve essere esposto nei runtime metrics"
  );
  assert.match(
    deploySource,
    /Environment=BACKEND_ORDERS_SYNC_QUEUE_RECONCILE_FAST_SKIP=1\b/,
    "il profilo P3 deve abilitare lo skip rollbackabile"
  );
});

test("P3.62 orders/create espone breakdown interno del percorso caldo", () => {
  const serverSource = backendSource;
  const createSource = corpoFunzione("handleIntegrationOrderCreate");

  assert.match(
    createSource,
    /runtimeMetrics\.recordOperation\(["']orderCreateInternal["'],\s*label,/,
    "orders/create deve esporre metriche interne P3.62"
  );
  [
    "readDb",
    "lineExpansion",
    "allocationAndStationState",
    "tableLockAndOperationalContext",
    "buildOrderAndAssignment",
    "auditDetails",
    "financialSnapshotRead",
    "financialSync",
    "appStateWrite",
    "realtimePublish",
  ].forEach((stage) => {
    assert.match(
      createSource,
      new RegExp(`recordOrderCreateStage\\(["']${stage}["']\\)`),
      `orders/create deve misurare lo stage ${stage}`
    );
  });
});

test("MP-4au orders/line/split usa write-primary relazionale con CAS", () => {
  const serverSource = backendSource;
  const splitSource = corpoFunzione("handleIntegrationOrderLineSplit");

  assert.match(
    serverSource,
    /RELATIONAL_ORDERS_LINE_SPLIT_WRITE_PRIMARY = process\.env\.BACKEND_RELATIONAL_ORDERS_LINE_SPLIT_WRITE_PRIMARY === ["']1["'] \|\| RELATIONAL_ORDERS_WRITE_PRIMARY/,
    "orders/line/split deve avere un flag write-primary dedicato"
  );
  assert.match(
    splitSource,
    /const currentRevision = clampInt\(currentOrder\.revision \?\? currentOrder\.currentRevision[\s\S]+const nextRevision = currentRevision \+ 1/,
    "orders/line/split deve avanzare revision/currentRevision"
  );
  assert.match(
    splitSource,
    /const requestedLineSplitRevision = clampInt\([^;]*payload\.expectedRevision[^;]*\);[\s\S]+currentRevision !== requestedLineSplitRevision[\s\S]+REVISION_CONFLICT/,
    "orders/line/split deve rifiutare client stale tramite expectedRevision"
  );
  assert.match(
    splitSource,
    /syncRelationalOrderPrimary\(\{ enabled: RELATIONAL_ORDERS_LINE_SPLIT_WRITE_PRIMARY, order: nextOrder, previousRevision: requestedLineSplitRevision > 0 \? requestedLineSplitRevision : currentRevision, relationalRuntime, runtimeMetrics \}\)/,
    "orders/line/split deve scrivere il primary relazionale con CAS prima del mirror app-state"
  );
  assert.match(
    splitSource,
    /findRelationalOrderById\(\{ enabled: RELATIONAL_ORDERS_LINE_SPLIT_WRITE_PRIMARY, orderId, relationalRuntime, runtimeMetrics \}\)[\s\S]+if \(orderIndex < 0 && !relationalLineSplitCurrentOrder\)/,
    "orders/line/split deve leggere dal relazionale prima di trattare un mirror app-state mancante come 404"
  );
  assert.ok(
    splitSource.indexOf("findRelationalOrderById({ enabled: RELATIONAL_ORDERS_LINE_SPLIT_WRITE_PRIMARY") <
      splitSource.indexOf("const db = await readDb("),
    "orders/line/split deve acquisire il read-model relazionale prima di leggere app-state/dbCache"
  );
  assert.match(
    splitSource,
    /const currentOrderSource = relationalLineSplitCurrentOrder \?\? db\.integration\.orders\[orderIndex\]/,
    "orders/line/split deve preferire il read-model relazionale al dbCache locale"
  );
  assert.match(
    splitSource,
    /if \(orderIndex >= 0\) \{[\s\S]+db\.integration\.orders\[orderIndex\] = nextOrder;[\s\S]+\} else \{[\s\S]+db\.integration\.orders\.push\(nextOrder\);[\s\S]+\}/,
    "orders/line/split deve ripristinare il mirror app-state quando parte da read-model relazionale"
  );
  assert.doesNotMatch(
    splitSource,
    /syncPosTableFinancialsFromIntegrationOrders|persistRelationalOrderFinancialTables|captureRelationalOrderFinancialTableGuard/,
    "orders/line/split deve restare neutro per table-state finanziario"
  );
  assert.match(
    splitSource,
    /RELATIONAL_ORDERS_LINE_SPLIT_WRITE_PRIMARY && !relationalLineSplitResult[\s\S]+REVISION_CONFLICT/,
    "orders/line/split deve rifiutare revisioni stale"
  );
});

test("MP-4ax canary e2e copre orders/line/split cross-process con revisione attesa", () => {
  const canarySource = readFileSync(path.join(appDir, "scripts", "order-worker-sync-e2e-canary.mjs"), "utf8");

  assert.match(
    canarySource,
    /requireLineSplit:\s*envBool\(["']CANARY_REQUIRE_LINE_SPLIT["']/,
    "il canary e2e deve avere un flag esplicito per line/split"
  );
  assert.match(
    canarySource,
    /expectedLineSplitProxyRole:\s*envString\(["']CANARY_EXPECT_LINE_SPLIT_PROXY_ROLE["']/,
    "il canary e2e deve poter vincolare line/split ad api-worker"
  );
  assert.match(
    canarySource,
    /requestJson\(["']\/api\/integration\/orders\/line\/split["']/,
    "il canary e2e deve chiamare la route reale line/split"
  );
  assert.match(
    canarySource,
    /expectedRevision:\s*order\.revision \?\? order\.currentRevision \?\? 1/,
    "line/split nel canary deve inviare expectedRevision per testare il CAS cross-process"
  );
});

test("MP-4ay orders/correct/resolve resta hard-disabled prima di qualunque mutazione", () => {
  const serverSource = backendSource;
  const resolveSource = corpoFunzione("handleIntegrationOrderCorrectionResolve");

  assert.match(
    resolveSource,
    /async function handleIntegrationOrderCorrectionResolve\(req, res\) \{\s*throw new HttpError\(\s*410,[\s\S]+ORDER_CORRECTION_APPROVAL_DISABLED/,
    "correct/resolve deve rispondere 410 prima di leggere body/sessione o mutare app-state"
  );
  assert.ok(
    resolveSource.indexOf("throw new HttpError(") < resolveSource.indexOf("const payload = await readJsonBody(req)"),
    "il 410 hard-disabled deve precedere readJsonBody"
  );
});

test("MP-4az orders/transfer/request usa write-primary relazionale con CAS", () => {
  const serverSource = backendSource;
  const transferSource = corpoFunzione("handleIntegrationOrderTransferRequest");

  assert.match(
    serverSource,
    /RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY = process\.env\.BACKEND_RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY === ["']1["'] \|\| RELATIONAL_ORDERS_WRITE_PRIMARY/,
    "transfer/request deve avere un flag write-primary dedicato"
  );
  assert.match(
    transferSource,
    /const requestedTransferRevision = clampInt\([^;]*payload\.expectedRevision[^;]*\);/,
    "transfer/request deve leggere expectedRevision/currentRevision dal client"
  );
  assert.match(
    transferSource,
    /findRelationalOrderById\(\{ enabled: RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY[\s\S]+currentOrder = sanitizeIntegrationOrder\(relationalTransferRequestCurrentOrder/,
    "transfer/request deve preferire il read-model relazionale quando il write-primary e attivo"
  );
  assert.match(
    transferSource,
    /const currentRevision = clampInt\(currentOrder\.revision \?\? currentOrder\.currentRevision[\s\S]+const nextRevision = currentRevision \+ 1/,
    "transfer/request deve avanzare revision/currentRevision"
  );
  assert.match(
    transferSource,
    /RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY && requestedTransferRevision > 0 && currentRevision !== requestedTransferRevision[\s\S]+REVISION_CONFLICT/,
    "transfer/request deve rifiutare client stale"
  );
  assert.match(
    transferSource,
    /syncRelationalOrderPrimary\(\{ enabled: RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY, order: nextOrder, previousRevision: requestedTransferRevision > 0 \? requestedTransferRevision : currentRevision, relationalRuntime, runtimeMetrics \}\)/,
    "transfer/request deve scrivere il primary relazionale con CAS"
  );
  assert.ok(
    transferSource.indexOf("syncRelationalOrderPrimary({ enabled: RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY") <
      transferSource.indexOf("const notification = queueIntegrationNotification"),
    "transfer/request deve creare notifiche solo dopo il write-primary relazionale"
  );
});

test("MP-4ba orders/transfer/resolve usa write-primary relazionale con CAS", () => {
  const serverSource = backendSource;
  const transferSource = corpoFunzione("handleIntegrationOrderTransferResolve");

  assert.match(
    serverSource,
    /RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY = process\.env\.BACKEND_RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY === ["']1["'] \|\| RELATIONAL_ORDERS_WRITE_PRIMARY/,
    "transfer/resolve deve avere un flag write-primary dedicato"
  );
  assert.match(
    transferSource,
    /const requestedTransferResolveRevision = clampInt\([^;]*payload\.expectedRevision[^;]*\);/,
    "transfer/resolve deve leggere expectedRevision/currentRevision dal client"
  );
  assert.match(
    transferSource,
    /findRelationalOrderById\(\{ enabled: RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY[\s\S]+currentOrder = sanitizeIntegrationOrder\(relationalTransferResolveCurrentOrder/,
    "transfer/resolve deve preferire il read-model relazionale quando il write-primary e attivo"
  );
  assert.match(
    transferSource,
    /const currentRevision = clampInt\(currentOrder\.revision \?\? currentOrder\.currentRevision[\s\S]+const nextRevision = currentRevision \+ 1/,
    "transfer/resolve deve avanzare revision/currentRevision"
  );
  assert.match(
    transferSource,
    /RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY && requestedTransferResolveRevision > 0 && currentRevision !== requestedTransferResolveRevision[\s\S]+REVISION_CONFLICT/,
    "transfer/resolve deve rifiutare client stale"
  );
  assert.match(
    transferSource,
    /syncRelationalOrderPrimary\(\{ enabled: RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY, order: nextOrder, previousRevision: requestedTransferResolveRevision > 0 \? requestedTransferResolveRevision : currentRevision, relationalRuntime, runtimeMetrics \}\)/,
    "transfer/resolve deve scrivere il primary relazionale con CAS"
  );
  assert.ok(
    transferSource.indexOf("syncRelationalOrderPrimary({ enabled: RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY") <
      transferSource.indexOf("const notification = queueIntegrationNotification"),
    "transfer/resolve deve creare notifiche solo dopo il write-primary relazionale"
  );
});

test("MP-4bb orders/line/price-override usa write-primary relazionale con CAS", () => {
  const serverSource = backendSource;
  const priceSource = corpoFunzione("handleIntegrationOrderLinePriceOverride");

  assert.match(
    serverSource,
    /RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY = process\.env\.BACKEND_RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY === ["']1["'] \|\| RELATIONAL_ORDERS_WRITE_PRIMARY/,
    "price-override deve avere un flag write-primary dedicato"
  );
  assert.match(
    priceSource,
    /const requestedPriceOverrideRevision = clampInt\([^;]*payload\.expectedRevision[^;]*\);/,
    "price-override deve leggere expectedRevision/currentRevision dal client"
  );
  assert.match(
    priceSource,
    /findRelationalOrderById\(\{ enabled: RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY[\s\S]+currentOrder = sanitizeIntegrationOrder\(relationalPriceOverrideCurrentOrder/,
    "price-override deve preferire il read-model relazionale quando il write-primary e attivo"
  );
  assert.match(
    priceSource,
    /const currentRevision = clampInt\(currentOrder\.revision \?\? currentOrder\.currentRevision[\s\S]+const nextRevision = currentRevision \+ 1/,
    "price-override deve avanzare revision/currentRevision"
  );
  assert.match(
    priceSource,
    /RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY && requestedPriceOverrideRevision > 0 && currentRevision !== requestedPriceOverrideRevision[\s\S]+REVISION_CONFLICT/,
    "price-override deve rifiutare client stale"
  );
  assert.match(
    priceSource,
    /syncRelationalOrderPrimary\(\{ enabled: RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY, order: nextOrder, previousRevision: requestedPriceOverrideRevision > 0 \? requestedPriceOverrideRevision : currentRevision, relationalRuntime, runtimeMetrics \}\)/,
    "price-override deve scrivere il primary relazionale con CAS"
  );
  assert.ok(
    priceSource.indexOf("syncRelationalOrderPrimary({ enabled: RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY") <
      priceSource.indexOf("db.integration.orders[orderIndex] = nextOrder"),
    "price-override deve aggiornare il mirror app-state solo dopo il write-primary relazionale"
  );
});

test("MP-4bc orders/transfer/force usa write-primary relazionale con CAS", () => {
  const serverSource = backendSource;
  const transferSource = corpoFunzione("handleIntegrationOrderTransferForce");

  assert.match(
    serverSource,
    /RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY = process\.env\.BACKEND_RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY === ["']1["'] \|\| RELATIONAL_ORDERS_WRITE_PRIMARY/,
    "transfer/force deve avere un flag write-primary dedicato"
  );
  assert.match(
    transferSource,
    /requestedTransferForceRevision = clampInt\([^;]*payload\.expectedRevision[^;]*\);/,
    "transfer/force deve leggere expectedRevision/currentRevision dal client"
  );
  assert.match(
    transferSource,
    /findRelationalOrderById\(\{ enabled: RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY[\s\S]+currentOrder = sanitizeIntegrationOrder\(relationalTransferForceCurrentOrder/,
    "transfer/force deve preferire il read-model relazionale quando il write-primary e attivo"
  );
  assert.match(
    transferSource,
    /const currentRevision = clampInt\(currentOrder\.revision \?\? currentOrder\.currentRevision[\s\S]+const nextRevision = currentRevision \+ 1/,
    "transfer/force deve avanzare revision/currentRevision"
  );
  assert.match(
    transferSource,
    /RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY && requestedTransferForceRevision > 0 && currentRevision !== requestedTransferForceRevision[\s\S]+REVISION_CONFLICT/,
    "transfer/force deve rifiutare client stale"
  );
  assert.match(
    transferSource,
    /syncRelationalOrderPrimary\(\{ enabled: RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY, order: nextOrder, previousRevision: requestedTransferForceRevision > 0 \? requestedTransferForceRevision : currentRevision, relationalRuntime, runtimeMetrics \}\)/,
    "transfer/force deve scrivere il primary relazionale con CAS"
  );
  assert.ok(
    transferSource.indexOf("syncRelationalOrderPrimary({ enabled: RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY") <
      transferSource.indexOf("db.integration.orders[orderIndex] = nextOrder"),
    "transfer/force deve aggiornare il mirror app-state solo dopo il write-primary relazionale"
  );
});

test("MP-4bd orders/storno usa write-primary relazionale dedicato con CAS", () => {
  const serverSource = backendSource;
  const compSource = corpoFunzione("handleIntegrationOrderComp");

  assert.match(
    serverSource,
    /RELATIONAL_ORDERS_STORNO_WRITE_PRIMARY = process\.env\.BACKEND_RELATIONAL_ORDERS_STORNO_WRITE_PRIMARY === ["']1["'] \|\| RELATIONAL_ORDERS_WRITE_PRIMARY/,
    "orders/storno deve avere un flag write-primary dedicato"
  );
  assert.match(
    compSource,
    /const orderCompWritePrimary = explicitStornoRequest \? RELATIONAL_ORDERS_STORNO_WRITE_PRIMARY : RELATIONAL_ORDERS_COMP_WRITE_PRIMARY/,
    "il handler condiviso deve selezionare il flag STORNO solo per la route storno"
  );
  assert.match(
    compSource,
    /let requestedOrderCompRevision = clampInt\([^;]*payload\.expectedRevision[^;]*\);/,
    "storno deve leggere expectedRevision/currentRevision dal client"
  );
  assert.match(
    compSource,
    /findRelationalOrderById\(\{ enabled: orderCompWritePrimary[\s\S]+currentOrder = sanitizeIntegrationOrder\(relationalOrderCompCurrentOrder/,
    "storno e comp devono preferire il read-model relazionale del rispettivo percorso"
  );
  assert.match(
    compSource,
    /orderCompWritePrimary && requestedOrderCompRevision > 0 && currentRevision !== requestedOrderCompRevision[\s\S]+REVISION_CONFLICT/,
    "storno deve rifiutare client stale prima dei side effect"
  );
  assert.match(
    compSource,
    /syncRelationalOrderPrimary\(\{ enabled: orderCompWritePrimary, order: nextOrder, previousRevision: requestedOrderCompRevision > 0 \? requestedOrderCompRevision : currentRevision, relationalRuntime \}\)/,
    "storno deve scrivere il primary relazionale con CAS dedicato"
  );
  assert.match(
    compSource,
    /persistRelationalOrderFinancialTables\(\{ appState: db, enabled: orderCompWritePrimary && financialSync\.changed === true/,
    "storno deve usare il flag effettivo anche per la persistenza table_state"
  );
});

test("MP-4x orders/cancel rilegge il relazionale prima del controllo revisione", () => {
  const serverSource = backendSource;
  const cancelSource = corpoFunzione("handleIntegrationOrderCancel");

  assert.match(
    cancelSource,
    /findRelationalOrderById\(\{ enabled:\s*RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY[\s\S]+db\.integration\.orders\[orderIndex\] = currentOrder[\s\S]+if \(expectedRevision > 0 && currentRevision !== expectedRevision\)/,
    "orders/cancel deve allinearsi al relazionale write-primary prima di rifiutare per revisione stale"
  );
  assert.match(
    cancelSource,
    /let orderIndex = findIntegrationOrderIndexByLookup[\s\S]+findRelationalOrderById\(\{ enabled:\s*RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY[\s\S]+if \(!currentOrder \|\| orderIndex < 0\) throw new HttpError\(404/,
    "orders/cancel deve provare il relazionale prima del 404 quando il mirror app-state non contiene la comanda"
  );
  assert.match(
    cancelSource,
    /appliedRelationalCancelCurrentOrder[\s\S]+if \(alreadyCancelled\) \{[\s\S]+writeIntegrationOrderSyncDb\(db, \{[\s\S]+orders\.cancel\.idempotentMirror\.appStateWrite/,
    "orders/cancel idempotente deve rendere durevole il mirror se ha incorporato una revisione relazionale piu' fresca"
  );
});

test("MP-4y orders/create usa piano riusabile per assegnazione postazione", () => {
  const serverSource = backendSource;
  const moduleSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "order-create-assignment-plan.js"),
    "utf8",
  );
  const assignmentStart = serverSource.indexOf("function applyIntegrationAutoAssignment");
  const nextFunctionStart = serverSource.indexOf("function assignQueuedUnassignedIntegrationOrders");
  const assignmentSource = serverSource.slice(assignmentStart, nextFunctionStart);

  assert.match(serverSource, /import \{ buildOrderCreateAutoAssignmentPlan \}/);
  assert.match(moduleSource, /export function buildOrderCreateStationEligibilityChecker/);
  assert.match(moduleSource, /export function buildOrderCreateAutoAssignmentPlan/);
  assert.match(assignmentSource, /buildOrderCreateAutoAssignmentPlan\(/);
  assert.doesNotMatch(
    assignmentSource,
    /chooseBestStationForOrder\(db,\s*current,\s*\{[\s\S]*?isStationEligible:/,
    "orders/create non deve ricostruire eleggibilita' e scelta postazione inline nel server"
  );
});

test("MP-4z financial sync tavolo usa piano riusabile snapshot-ready", () => {
  const serverSource = backendSource;
  const moduleSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "order-table-financial-plan.js"),
    "utf8",
  );
  const syncStart = serverSource.indexOf("function syncPosTableFinancialsFromIntegrationOrders");
  const nextFunctionStart = serverSource.indexOf("function resolveIntegrationPaymentOrderCandidates");
  const syncSource = serverSource.slice(syncStart, nextFunctionStart);

  assert.match(serverSource, /import \{ buildOrderTableFinancialPlan \}/);
  assert.match(moduleSource, /export function buildOrderTableFinancialPlan/);
  assert.match(syncSource, /buildOrderTableFinancialPlan\(/);
  assert.match(syncSource, /tableFinancialPlan\.nextTable/);
  assert.doesNotMatch(
    syncSource,
    /const nextStatus\s*=[\s\S]*?currentTable\.status === ["']payment_due["']/,
    "la decisione stato/importi tavolo non deve tornare inline nel server"
  );
});

test("MP-4aa orders/create calcola financial sync da snapshot relazionale dopo write-primary", () => {
  const serverSource = backendSource;
  const moduleSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "order-financial-sync-source.js"),
    "utf8",
  );
  const createSource = corpoFunzione("handleIntegrationOrderCreate");

  assert.match(serverSource, /import \{ addOrderSyncFinancialNoopTableSnapshot, buildOrderCancelFinancialDeltaBeforeSnapshotFastPath, buildOrderCreateFinancialDeltaBeforeSnapshotFastPath, buildOrderCreateFinancialDeltaFastPath, buildOrderFinancialSyncState, buildOrderSyncFinancialNoopFastPath \}/);
  assert.match(moduleSource, /export function buildOrderFinancialSyncState/);
  assert.match(
    createSource,
    /createRelationalOrderPrimary\([\s\S]+listRelationalOrderWorkflowSnapshot\([\s\S]+buildOrderFinancialSyncState\([\s\S]+syncPosTableFinancialsFromIntegrationOrders\(/,
    "orders/create deve scrivere il primary relazionale prima di calcolare il conto da snapshot condiviso"
  );
  assert.match(createSource, /metricLabel:\s*["']orders\.create\.relationalFinancialSnapshotRead["']/);
  assert.match(createSource, /if \(orderCreateFinancialSyncSource\.state !== db && financialSync\.changed === true\)/);
});

test("P3.65 orders/create usa financial delta fast path con fallback completo", () => {
  const serverSource = backendSource;
  const moduleSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "order-financial-sync-source.js"),
    "utf8",
  );
  const createSource = corpoFunzione("handleIntegrationOrderCreate");

  assert.match(moduleSource, /export function buildOrderCreateFinancialDeltaFastPath/);
  assert.match(moduleSource, /buildOrderTableFinancialPlan/);
  assert.match(
    createSource,
    /const orderCreateFinancialDeltaEnabled = process\.env\.BACKEND_ORDERS_CREATE_FINANCIAL_DELTA_FASTPATH !== ["']0["'][\s\S]+buildOrderCreateFinancialDeltaFastPath\(\{[\s\S]+enabled: orderCreateFinancialDeltaEnabled[\s\S]+linkedTableIds:[\s\S]+targetTableIds: orderCreateFinancialTargetTableIds[\s\S]+orderCreateFinancialDeltaFastPath\.applied \? orderCreateFinancialDeltaFastPath\.financialSync : syncPosTableFinancialsFromIntegrationOrders\(/,
    "orders/create deve provare il delta economico prima del sync completo e mantenere rollback/fallback"
  );
  assert.match(
    createSource,
    /orderCreateFinancialDeltaFastPathHits[\s\S]+orderCreateFinancialDeltaFastPathFallbacks/,
    "il fast path deve esporre hit/fallback nelle metriche runtime"
  );
});

test("P3.67 orders/create prova il delta economico prima dello snapshot relazionale", () => {
  const serverSource = backendSource;
  const moduleSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "order-financial-sync-source.js"),
    "utf8",
  );
  const metricsSource = readFileSync(path.join(cassaDir, "modules", "runtime-metrics.js"), "utf8");
  const deploySource = readFileSync(
    path.join(appDir, "deploy", "systemd", "50-p3-orders-write-primary.conf"),
    "utf8",
  );
  const createSource = corpoFunzione("handleIntegrationOrderCreate");

  assert.match(moduleSource, /export function buildOrderCreateFinancialDeltaBeforeSnapshotFastPath/);
  assert.match(
    moduleSource,
    /guardTokens[\s\S]+token\?\.exists[\s\S]+guard_mismatch[\s\S]+buildOrderCreateFinancialDeltaFastPath/,
    "il delta before-snapshot deve richiedere token relazionale coerente prima di mutare il tavolo"
  );
  assert.match(
    serverSource,
    /ORDERS_CREATE_FINANCIAL_DELTA_BEFORE_SNAPSHOT = process\.env\.BACKEND_ORDERS_CREATE_FINANCIAL_DELTA_BEFORE_SNAPSHOT !== ["']0["']/,
    "il nuovo fast path deve avere rollback con una sola variabile"
  );
  assert.match(
    createSource,
    /captureRelationalOrderFinancialTableGuard\([\s\S]+buildOrderCreateFinancialDeltaBeforeSnapshotFastPath\([\s\S]+financialDeltaBeforeSnapshot[\s\S]+if \(!orderCreateFinancialDeltaFastPath\.applied\) \{[\s\S]+listRelationalOrderWorkflowSnapshot\([\s\S]+buildOrderFinancialSyncState\([\s\S]+buildOrderCreateFinancialDeltaFastPath/,
    "orders/create deve saltare lo snapshot relazionale solo quando il delta guardato riesce"
  );
  assert.match(
    metricsSource,
    /orderCreateFinancialDeltaBeforeSnapshotHits:\s*0,[\s\S]+orderCreateFinancialDeltaBeforeSnapshotFallbacks:\s*0/,
    "le metriche devono esporre hit/fallback del delta before-snapshot"
  );
  assert.match(
    deploySource,
    /Environment=BACKEND_ORDERS_CREATE_FINANCIAL_DELTA_BEFORE_SNAPSHOT=1\b/,
    "il profilo P3 deve abilitare il delta before-snapshot rollbackabile"
  );
});

test("P3.69 orders/cancel prova il delta economico prima dello snapshot relazionale", () => {
  const serverSource = backendSource;
  const moduleSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "order-financial-sync-source.js"),
    "utf8",
  );
  const metricsSource = readFileSync(path.join(cassaDir, "modules", "runtime-metrics.js"), "utf8");
  const deploySource = readFileSync(
    path.join(appDir, "deploy", "systemd", "50-p3-orders-write-primary.conf"),
    "utf8",
  );
  const cancelStart = serverSource.indexOf("async function handleIntegrationOrderCancel");
  const cancelEnd = serverSource.indexOf("async function handleIntegrationOrderCorrectionPending");
  const cancelSource = serverSource.slice(cancelStart, cancelEnd);

  assert.match(moduleSource, /export function buildOrderCancelFinancialDeltaBeforeSnapshotFastPath/);
  assert.match(
    serverSource,
    /ORDERS_CANCEL_FINANCIAL_DELTA_BEFORE_SNAPSHOT = process\.env\.BACKEND_ORDERS_CANCEL_FINANCIAL_DELTA_BEFORE_SNAPSHOT !== ["']0["']/,
    "il fast path cancel deve avere rollback con una sola variabile"
  );
  assert.match(
    cancelSource,
    /captureRelationalOrderFinancialTableGuard\([\s\S]+orders\.cancel\.relationalFinancialTableGuardRead[\s\S]+buildOrderCancelFinancialDeltaBeforeSnapshotFastPath\([\s\S]+financialDeltaBeforeSnapshot[\s\S]+if \(!orderCancelFinancialDeltaFastPath\.applied\) \{[\s\S]+listRelationalOrderWorkflowSnapshot\([\s\S]+buildOrderFinancialSyncState\([\s\S]+syncPosTableFinancialsFromIntegrationOrders/,
    "orders/cancel deve saltare lo snapshot relazionale solo quando il delta guardato riesce"
  );
  assert.match(
    cancelSource,
    /runtimeMetrics\.recordOperation\(["']orderCancelInternal["'],\s*label,/,
    "orders/cancel deve esporre metriche interne P3.69"
  );
  assert.match(
    metricsSource,
    /orderCancelFinancialDeltaBeforeSnapshotHits:\s*0,[\s\S]+orderCancelFinancialDeltaBeforeSnapshotFallbacks:\s*0/,
    "le metriche devono esporre hit/fallback del delta cancel before-snapshot"
  );
  assert.match(
    metricsSource,
    /\^orderWorkflow:orders\\\.cancel\\\.financialDeltaBeforeSnapshot\\\./,
    "le ragioni hit/fallback del delta cancel devono restare pinned nelle runtime metrics"
  );
  assert.match(
    deploySource,
    /Environment=BACKEND_ORDERS_CANCEL_FINANCIAL_DELTA_BEFORE_SNAPSHOT=1\b/,
    "il profilo P3 deve abilitare il delta cancel before-snapshot rollbackabile"
  );
});

test("P3.70 print spool disabled usa fast append senza SQL-primary", () => {
  const serverSource = backendSource;
  const metricsSource = readFileSync(path.join(cassaDir, "modules", "runtime-metrics.js"), "utf8");
  const deploySource = readFileSync(
    path.join(appDir, "deploy", "systemd", "50-p3-orders-write-primary.conf"),
    "utf8",
  );
  const appendStart = serverSource.indexOf("async function appendPrintSpoolJobToDb");
  const appendEnd = serverSource.indexOf("function sanitizeSmartCustomerForResponse", appendStart);
  const appendSource = serverSource.slice(appendStart, appendEnd);

  assert.match(
    serverSource,
    /PRINT_SPOOL_DISABLED_FAST_APPEND = process\.env\.PRINT_SPOOL_DISABLED_FAST_APPEND !== ["']0["']/,
    "il fast append disabled deve avere rollback con una sola variabile"
  );
  assert.match(
    serverSource,
    /function shouldFastAppendDisabledPrintSpoolJob\(\) \{[\s\S]+PRINT_SPOOL_SQL_PRIMARY[\s\S]+PRINT_SPOOL_DISABLED_FAST_APPEND[\s\S]+!PRINTING_ENABLED/,
    "il fast append deve valere solo quando la stampa e disabilitata"
  );
  assert.match(
    appendSource,
    /shouldFastAppendDisabledPrintSpoolJob\(\)[\s\S]+appendDisabledPrintSpoolJobFast\(db, payload\)[\s\S]+if \(PRINT_SPOOL_SQL_PRIMARY\) \{[\s\S]+enqueuePrintSpoolJobSqlPrimary/,
    "appendPrintSpoolJobToDb deve saltare SQL-primary solo nel path disabled"
  );
  assert.match(
    serverSource,
    /function appendDisabledPrintSpoolJobFast\(db, payload\) \{[\s\S]+sanitizePrintSpoolJob\(\{[\s\S]+status:\s*["']disabled["'][\s\S]+db\.printSpoolJobs\.push\(nextJob\)[\s\S]+PRINT_SPOOL_MAX_JOBS[\s\S]+printSpoolDisabledFastAppends[\s\S]+disabledFastAppend/,
    "il path disabled deve costruire un job minimale, conservarlo nel mirror senza scan completo e tracciare metriche"
  );
  assert.match(metricsSource, /printSpoolDisabledFastAppends:\s*0/);
  assert.match(metricsSource, /\^printSpool:disabledFastAppend\$/);
  assert.match(deploySource, /Environment=PRINT_SPOOL_DISABLED_FAST_APPEND=1\b/);
});

test("P3.71 readDb espone metriche interne per isolare idratazione e refresh esterni", () => {
  const serverSource = backendSource;
  const metricsSource = readFileSync(path.join(cassaDir, "modules", "runtime-metrics.js"), "utf8");
  const readStart = serverSource.indexOf("const readDb = async");
  const readEnd = serverSource.indexOf("let healthSnapshot", readStart);
  const readSource = serverSource.slice(readStart, readEnd);

  assert.match(serverSource, /recordReadDbInternalDuration = \(label, durationMs, options = \{\}\) =>[\s\S]+readDbInternal/);
  assert.match(serverSource, /recordReadDbInternalStep = \(label, startedAt, options = \{\}\) =>\s*recordReadDbInternalDuration/);
  for (const label of [
    "appStateRead",
    "refreshSessions",
    "refreshTableLocks",
    "refreshStationStates",
    "refreshSequence",
  ]) {
    assert.match(readSource, new RegExp(`recordReadDbInternalStep\\("${label}"`));
  }
  assert.match(readSource, /refreshOrderCreateExternalizedReadsInParallel\(\{/);
  assert.match(readSource, /recordReadDbInternalStep\("parallelExternalRefresh"/);
  assert.match(serverSource, /operationMetricKind:\s*["']orderCreateRead["']/);
  assert.match(metricsSource, /\^readDbInternal:/);
  assert.match(metricsSource, /\^orderCreateRead:/);
});

test("P3.72 scritture ordine espongono attesa BEGIN, corpo e commit senza avvelenare il guard", () => {
  const serverSource = backendSource;
  const transactionSource = readFileSync(path.join(cassaDir, "db", "relational", "transaction.js"), "utf8");
  const repositorySource = readFileSync(path.join(cassaDir, "db", "relational", "orders.repo.js"), "utf8");
  const integrationSource = readFileSync(path.join(cassaDir, "modules", "integration", "relational-order-create.js"), "utf8");
  const metricsSource = readFileSync(path.join(cassaDir, "modules", "runtime-metrics.js"), "utf8");

  assert.match(transactionSource, /activeRelationalTransactions\.add\(db\)[\s\S]+try \{[\s\S]+BEGIN IMMEDIATE[\s\S]+finally \{[\s\S]+activeRelationalTransactions\.delete\(db\)/);
  for (const label of ["beginImmediate", "body", "commit", "rollback"]) {
    assert.match(transactionSource, new RegExp(`recordTransactionStep\\(options, ["']${label}["']`));
  }
  for (const label of ["mapRows", "casUpdate", "deleteChildren", "insertChildren", "hydrateResult", "total"]) {
    assert.match(repositorySource, new RegExp(`recordRepositoryMetric\\(options, ["']${label}["']`));
  }
  assert.match(integrationSource, /orderRelationalWriteInternal[\s\S]+metricScope[\s\S]+onMetric:\s*recordInternal/);
  // I due scope vivono ora in moduli diversi: l'ordine testuale era un accidente
  // della disposizione in server.js, non un invariante. Restano due presenze.
  assert.match(serverSource, /metricScope:\s*["']sync["']/);
  assert.match(serverSource, /metricScope:\s*["']cancel["']/);
  assert.match(metricsSource, /\^orderRelationalWriteInternal:/);
});

test("P3.73 checkpoint WAL esce dai commit worker ed e gestito solo dall owner", () => {
  const serverSource = backendSource;
  const connectionSource = readFileSync(path.join(cassaDir, "db", "relational", "connection.js"), "utf8");
  const runtimeSource = readFileSync(path.join(cassaDir, "db", "relational", "index.js"), "utf8");
  const checkpointSource = readFileSync(path.join(cassaDir, "db", "relational", "wal-checkpoint.js"), "utf8");
  const metricsSource = readFileSync(path.join(cassaDir, "modules", "runtime-metrics.js"), "utf8");
  const deploySource = readFileSync(
    path.join(appDir, "deploy", "systemd", "60-p3-relational-wal-checkpoint.conf"),
    "utf8",
  );

  assert.match(connectionSource, /BACKEND_RELATIONAL_WAL_CHECKPOINT_OWNER/);
  assert.match(connectionSource, /walCheckpointOwner\s*=\s*walCheckpointEnabled\s*&&\s*\[[\s\S]+api-owner/);
  assert.match(connectionSource, /walAutoCheckpointPages\s*=\s*walCheckpointEnabled\s*\?\s*0\s*:\s*1_000/);
  assert.match(connectionSource, /PRAGMA wal_autocheckpoint = \$\{walAutoCheckpointPages\}/);
  assert.match(checkpointSource, /PRAGMA wal_checkpoint\(PASSIVE\)/);
  assert.match(checkpointSource, /relationalWalCheckpointRuns/);
  assert.match(checkpointSource, /relationalWalCheckpointErrors/);
  assert.match(checkpointSource, /relationalWalBacklogPages/);
  assert.match(checkpointSource, /recordOperation\?\.\("relationalWalCheckpoint", "passive"/);
  assert.match(runtimeSource, /await runRelationalMigrations\(db,[\s\S]+walCheckpoint\.start\(\)/);
  assert.match(runtimeSource, /walCheckpoint\.stop\(\);[\s\S]+closeRelationalConnection\(db\)/);
  assert.match(serverSource, /createRelationalRuntime\(\{[\s\S]+runtimeMetrics/);
  assert.match(metricsSource, /\^relationalWalCheckpoint:/);
  assert.match(metricsSource, /walCheckpointRuns:[\s\S]+walBacklogPages:/);
  assert.match(deploySource, /BACKEND_RELATIONAL_WAL_CHECKPOINT_OWNER=1/);
  assert.match(deploySource, /BACKEND_RELATIONAL_WAL_CHECKPOINT_INTERVAL_MS=1000/);
});

test("P3.74 layout usa ordini attivi relazionali invece della cache worker divergente", () => {
  const serverSource = backendSource;
  const relationalOrdersSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "relational-order-create.js"),
    "utf8",
  );
  const deploySource = readFileSync(
    path.join(appDir, "deploy", "systemd", "50-p3-orders-write-primary.conf"),
    "utf8",
  );
  const layoutHandler = serverSource.match(
    /async function buildIntegrationLayoutCacheEntry[\s\S]*?\n}\nconst runIntegrationLayoutBuild/,
  )?.[0] ?? "";

  assert.match(
    serverSource,
    /RELATIONAL_LAYOUT_ORDERS_READ_PRIMARY\s*=\s*process\.env\.BACKEND_RELATIONAL_LAYOUT_ORDERS_READ_PRIMARY === ["']1["']\s*&&\s*RELATIONAL_ORDERS_READ_PRIMARY/,
  );
  assert.match(
    relationalOrdersSource,
    /orderIds\.length === 0[\s\S]+return listScopedOrders\(workflowStatuses\.length > 0 \? \{ statuses: workflowStatuses \} : \{\}\)/,
    "lo snapshot relazionale globale deve rispettare il filtro stati",
  );
  assert.match(layoutHandler, /integration\.layout\.relationalOrdersRead/);
  assert.match(layoutHandler, /workflowStatuses:\s*\[["']waiting["'], ["']prep["'], ["']ready["'], ["']delivered["']\]/);
  assert.match(layoutHandler, /buildOrderFinancialSyncState\([\s\S]+syncPosTableFinancialsFromIntegrationOrders\(layoutFinancialSource\.state\)/);
  assert.match(layoutHandler, /buildIntegrationTableOrderStats\(layoutFinancialSource\.state\)/);
  assert.doesNotMatch(layoutHandler, /buildIntegrationTableOrderStats\(db\)/);
  assert.match(deploySource, /BACKEND_RELATIONAL_LAYOUT_ORDERS_READ_PRIMARY=1/);
});

test("P3.75 conserva la telemetria interna create sotto pressione label", () => {
  const metricsSource = readFileSync(
    path.join(cassaDir, "modules", "runtime-metrics.js"),
    "utf8",
  );

  assert.match(metricsSource, /\^orderCreateInternal:/);
  assert.match(metricsSource, /\^orderCreateAuditPrelude:/);
  assert.match(
    metricsSource,
    /\^orderWorkflow:orders\\\.create\\\.relationalWrite\$/,
  );
});

test("P3.76 lookup idempotenza ordini usa colonne native indicizzate", () => {
  const repositorySource = readFileSync(
    path.join(cassaDir, "db", "relational", "orders.repo.js"),
    "utf8",
  );
  const migrationSource = readFileSync(
    path.join(cassaDir, "db", "relational", "migrations", "023_orders_idempotency_index.sql"),
    "utf8",
  );
  const equivalenceSource = readFileSync(
    path.join(cassaDir, "db", "relational", "equivalence.js"),
    "utf8",
  );
  const lookupSource = repositorySource.match(
    /findOrderByIdempotencyKey\(key, filters = \{\}\)[\s\S]*?\n  listOrderLines/,
  )?.[0] ?? "";

  assert.match(migrationSource, /ALTER TABLE orders ADD COLUMN idempotency_key TEXT/);
  assert.match(
    migrationSource,
    /idx_orders_idempotency_scope[\s\S]+idempotency_key, created_by_user_id, created_by_device_uuid/,
  );
  assert.match(lookupSource, /idempotency_key = \?/);
  assert.match(lookupSource, /created_by_user_id IS NULL OR created_by_user_id = \?/);
  assert.match(lookupSource, /created_by_device_uuid IS NULL OR created_by_device_uuid = \?/);
  assert.doesNotMatch(lookupSource, /raw_json LIKE|SELECT \* FROM orders ORDER BY/);
  assert.match(repositorySource, /INSERT INTO orders \([\s\S]+idempotency_key,[\s\S]+created_by_device_uuid/);
  assert.match(equivalenceSource, /idempotency_key AS idempotencyKey/);
});

test("P3.66 orders/create evita re-sanitize audit events con rollback", () => {
  const serverSource = backendSource;
  const createSource = corpoFunzione("handleIntegrationOrderCreate");

  assert.match(
    createSource,
    /const mergedCreateEvents = mergeOrderEvents\(nextOrder\.events, orderRelationalEvents\);[\s\S]+BACKEND_ORDERS_CREATE_AUDIT_PRELUDE_FAST_EVENTS !== ["']0["'][\s\S]+\{ \.\.\.nextOrder, events: mergedCreateEvents\.slice\(-500\) \}[\s\S]+sanitizeIntegrationOrder\(\{ \.\.\.nextOrder, events: mergedCreateEvents \}, nextOrder\.id\)/,
    "orders/create deve saltare la re-sanitize completa quando aggiunge solo eventi deterministici, con rollback env"
  );
  assert.match(
    createSource,
    /recordOrderCreateAuditPrelude[\s\S]+queueReconcile[\s\S]+baseAuditEvents[\s\S]+lineSnapshots[\s\S]+relationalEventsBuild[\s\S]+eventsMerge/,
    "P3.66 deve mantenere il breakdown interno del prelude audit create"
  );
});

test("P3.66c orders/create salta queue reconcile quando la nuova comanda occupa gia la lane", () => {
  const serverSource = backendSource;
  const metricsSource = readFileSync(path.join(cassaDir, "modules", "runtime-metrics.js"), "utf8");
  const preparationQueueSource = readFileSync(
    path.join(cassaDir, "modules", "orders", "order-preparation-queue.js"),
    "utf8",
  );
  const deploySource = readFileSync(
    path.join(appDir, "deploy", "systemd", "50-p3-orders-write-primary.conf"),
    "utf8",
  );
  const createSource = corpoFunzione("handleIntegrationOrderCreate");

  assert.match(
    serverSource,
    /ORDERS_CREATE_QUEUE_RECONCILE_FAST_SKIP = process\.env\.BACKEND_ORDERS_CREATE_QUEUE_RECONCILE_FAST_SKIP !== ["']0["']/,
    "lo skip create queue reconcile deve avere rollback con una sola variabile"
  );
  assert.match(
    preparationQueueSource,
    /export function buildCreatedOrderPreparationQueueFastPlan\([\s\S]+isIntegrationOrderQueueLaneActive\(createdOrder, normalizedActiveQueue\)[\s\S]+integrationOrderQueueLaneKey\(candidate\) !== laneKey[\s\S]+workflow === ["']prep["'][\s\S]+promoteOrder\(waitingOrder\)/,
    "orders/create deve avere una riconciliazione mirata per la lane della nuova comanda"
  );
  assert.match(
    createSource,
    /ORDERS_CREATE_QUEUE_RECONCILE_FAST_SKIP[\s\S]+buildCreatedOrderPreparationQueueFastPlan\(db, nextOrder, buildActiveIntegrationOrderQueueLaneKeys\(db\)/,
    "orders/create deve provare il fast path mirato prima della riconciliazione globale"
  );
  assert.match(
    createSource,
    /orderCreateQueueReconcileFastPath\.applied[\s\S]+orderCreateQueueReconcileFastSkips[\s\S]+orderCreateQueueReconcileFastFallbacks[\s\S]+reconcileIntegrationPreparationQueue/,
    "orders/create deve evitare la riconciliazione globale quando il fast path mirato puo decidere la lane"
  );
  assert.match(
    createSource,
    /recordOrderCreateAuditPrelude\(["']queueReconcile["']\)/,
    "lo stage queueReconcile create deve restare misurabile anche quando viene saltato"
  );
  assert.match(
    metricsSource,
    /orderCreateQueueReconcileFastSkips:\s*0,[\s\S]+orderCreateQueueReconcileFastFallbacks:\s*0/,
    "il numero di skip create deve essere esposto nei runtime metrics"
  );
  assert.match(
    deploySource,
    /Environment=BACKEND_ORDERS_CREATE_QUEUE_RECONCILE_FAST_SKIP=1\b/,
    "il profilo P3 deve abilitare lo skip create rollbackabile"
  );
});

test("MP-4ab orders/create protegge la scrittura financial table con revision guard", () => {
  const serverSource = backendSource;
  const moduleSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "order-financial-table-write-guard.js"),
    "utf8",
  );
  const createSource = corpoFunzione("handleIntegrationOrderCreate");

  assert.match(serverSource, /import \{ applyOrderFinancialTableRevisionTokens, buildOrderFinancialTableRevisionTokens \}/);
  assert.match(moduleSource, /export function buildOrderFinancialTableRevisionTokens/);
  assert.match(moduleSource, /export function applyOrderFinancialTableRevisionTokens/);
  assert.match(
    serverSource,
    /function captureRelationalOrderFinancialTableGuard[\s\S]+buildOrderFinancialTableRevisionTokens/,
    "orders/create deve catturare le revisioni tavolo dal relazionale"
  );
  assert.match(
    serverSource,
    /function persistRelationalOrderFinancialTables[\s\S]+replaceTablesFromAppState\([\s\S]+\{ enforceRevision: true \}/,
    "orders/create deve persistere il tavolo con CAS su revision"
  );
  assert.match(
    createSource,
    /captureRelationalOrderFinancialTableGuard\([\s\S]+syncPosTableFinancialsFromIntegrationOrders\([\s\S]+applyOrderFinancialTableRevisionTokens\([\s\S]+persistRelationalOrderFinancialTables\(/,
    "il guard deve catturare revision prima del calcolo e scrivere il tavolo prima del mirror app-state"
  );
});

test("MP-4ac orders/create pubblica order_created solo via outbox nel profilo write-primary", () => {
  const serverSource = backendSource;
  const createSource = corpoFunzione("handleIntegrationOrderCreate");

  assert.match(
    serverSource,
    /function publishIntegrationNotificationStreamRefresh\([\s\S]+const requireOutbox = options\?\.requireOutbox === true[\s\S]+EVENT_OUTBOX_REQUIRED/,
    "publish realtime deve poter rendere obbligatorio event_outbox senza fallback inline"
  );
  assert.match(
    createSource,
    /publishIntegrationNotificationStreamRefresh\(["']order_created["'][\s\S]+requireOutbox:\s*[\s\S]+RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY[\s\S]+REALTIME_BACKBONE_CONFIG\.eventOutboxEnabled/,
    "orders/create deve richiedere outbox per order_created quando write-primary e outbox sono attivi"
  );
  assert.match(
    createSource,
    /enqueueOnly:\s*process\.env\.BACKEND_ORDERS_CREATE_REALTIME_ENQUEUE_ONLY !== ["']0["'][\s\S]+RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY[\s\S]+REALTIME_BACKBONE_CONFIG\.eventOutboxEnabled/,
    "orders/create deve poter saltare il publish inline realtime con rollback a una variabile"
  );
  assert.match(
    createSource,
    /BACKEND_ORDERS_CREATE_REALTIME_LEAN_PAYLOAD !== ["']0["'][\s\S]+payloadMode:\s*["']lean["'][\s\S]+findIntegrationLayoutTableSnapshot/,
    "orders/create deve poter accodare order_created con payload leggero e rollback a una variabile"
  );
});

test("MP-4af orders/cancel pubblica order_cancelled solo via outbox nel profilo write-primary", () => {
  const serverSource = backendSource;
  const cancelStart = serverSource.indexOf("async function handleIntegrationOrderCancel");
  const cancelEnd = serverSource.indexOf("async function handleIntegrationOrderCorrectionPending");
  const cancelSource = serverSource.slice(cancelStart, cancelEnd);

  assert.match(
    cancelSource,
    /publishIntegrationNotificationStreamRefresh\(["']order_cancelled["'][\s\S]+requireOutbox:\s*[\s\S]+RELATIONAL_ORDERS_CANCEL_WRITE_PRIMARY[\s\S]+REALTIME_BACKBONE_CONFIG\.eventOutboxEnabled/,
    "orders/cancel deve richiedere outbox per order_cancelled quando write-primary e outbox sono attivi"
  );
});

test("MP-4an orders/correct pubblica order_correction_applied solo via outbox nel profilo write-primary", () => {
  const serverSource = backendSource;
  const correctStart = serverSource.indexOf("async function handleIntegrationOrderCorrection");
  const correctEnd = serverSource.indexOf("async function handleIntegrationOrderCancel");
  const correctSource = serverSource.slice(correctStart, correctEnd);

  assert.match(
    correctSource,
    /publishIntegrationNotificationStreamRefresh\(["']order_correction_applied["'][\s\S]+requireOutbox:\s*[\s\S]+RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY[\s\S]+REALTIME_BACKBONE_CONFIG\.eventOutboxEnabled/,
    "orders/correct deve richiedere outbox per order_correction_applied quando write-primary e outbox sono attivi"
  );
});

test("MP-4be transfer request/resolve pubblicano notifiche via outbox nel profilo write-primary", () => {
  const serverSource = backendSource;
  const requestSource = corpoFunzione("handleIntegrationOrderTransferRequest");
  const resolveSource = corpoFunzione("handleIntegrationOrderTransferResolve");

  assert.match(requestSource, /writeIntegrationOrderSyncDb\([\s\S]+publishIntegrationNotificationStreamRefresh\(["']transfer_request["'][\s\S]+requireOutbox:\s*RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY && REALTIME_BACKBONE_CONFIG\.eventOutboxEnabled/, "transfer/request deve pubblicare transfer_request da event_outbox dopo il mirror mirato");
  assert.match(resolveSource, /writeIntegrationOrderSyncDb\([\s\S]+publishIntegrationNotificationStreamRefresh\(approve \? ["']transfer_approved["'] : ["']transfer_denied["'][\s\S]+requireOutbox:\s*RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY && REALTIME_BACKBONE_CONFIG\.eventOutboxEnabled/, "transfer/resolve deve pubblicare approvazione/negazione da event_outbox dopo il mirror mirato");
});

test("MP-4bf transfer/resolve scrive audit relazionale deterministico nella transazione CAS", () => {
  const serverSource = backendSource;
  const resolveSource = corpoFunzione("handleIntegrationOrderTransferResolve");
  const eventsSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "relational-order-events.js"),
    "utf8",
  );

  assert.match(
    resolveSource,
    /events: mergeOrderEvents\(nextOrder\.events, buildOrderTransferResolutionRelationalEvents\(/,
    "transfer/resolve deve fondere l'evento audit deterministico nel grafo ordine prima del write-primary"
  );
  assert.ok(
    resolveSource.indexOf("buildOrderTransferResolutionRelationalEvents") <
      resolveSource.indexOf("syncRelationalOrderPrimary({ enabled: RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY"),
    "l'evento audit deve viaggiare dentro la stessa transazione CAS del write-primary"
  );
  assert.ok(
    !resolveSource.includes("appendAuditEvent"),
    "transfer/resolve non deve usare appendAuditEvent app-state (id casuale non idempotente)"
  );
  assert.match(
    eventsSource,
    /export function buildOrderTransferResolutionRelationalEvents/,
    "il builder audit trasferimento deve vivere nel modulo relational-order-events"
  );
  assert.match(
    eventsSource,
    /\$\{orderId\}:order\.transfer_resolved:\$\{safeRevision\}/,
    "l'id evento deve essere deterministico su orderId+revision"
  );
});

test("MP-4bi transfer/force usa audit relazionale, outbox e non dipende da lock owner-bound", () => {
  const serverSource = backendSource;
  const forceSource = corpoFunzione("handleIntegrationOrderTransferForce");
  const eventsSource = readFileSync(path.join(cassaDir, "modules", "integration", "relational-order-events.js"), "utf8");

  assert.match(forceSource, /events: mergeOrderEvents\(currentOrder\.events, buildOrderTransferForceRelationalEvents\(/, "transfer/force deve fondere l'audit deterministico nel grafo ordine prima del CAS");
  assert.ok(forceSource.indexOf("buildOrderTransferForceRelationalEvents") < forceSource.indexOf("syncRelationalOrderPrimary({ enabled: RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY"), "l'audit transfer/force deve entrare nella stessa transazione CAS del write-primary");
  assert.match(forceSource, /publishIntegrationNotificationStreamRefresh\(["']transfer_forced["'][\s\S]+requireOutbox:\s*RELATIONAL_ORDERS_TRANSFER_FORCE_WRITE_PRIMARY && REALTIME_BACKBONE_CONFIG\.eventOutboxEnabled/, "transfer/force deve pubblicare transfer_forced da event_outbox nel profilo write-primary");
  assert.doesNotMatch(forceSource, /assertActiveTableWorkLock|relationalTableLockCoordinator|stationStates|appendAuditEvent/, "transfer/force non deve tornare a dipendere da lock/station owner-bound o audit app-state");
  assert.match(eventsSource, /export function buildOrderTransferForceRelationalEvents/);
  assert.match(eventsSource, /\$\{orderId\}:order\.transfer_forced:\$\{safeRevision\}/);
});

test("MP-4bg transfer/request non dipende da lock o stato owner", () => {
  const serverSource = backendSource;
  const requestSource = corpoFunzione("handleIntegrationOrderTransferRequest");

  assert.ok(
    !requestSource.includes("assertActiveTableWorkLock"),
    "transfer/request non deve dipendere dai work lock tavolo"
  );
  assert.ok(
    !requestSource.includes("stationStates"),
    "transfer/request non deve leggere gli station state owner-bound"
  );
  assert.ok(
    !requestSource.includes("lockedByStationId"),
    "transfer/request non deve toccare i campi lock dell'ordine"
  );
  assert.match(
    requestSource,
    /findRelationalOrderById\(\{ enabled: RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY/,
    "transfer/request deve preferire il read-model relazionale"
  );
  assert.ok(
    requestSource.indexOf("syncRelationalOrderPrimary") < requestSource.indexOf("queueIntegrationNotification"),
    "l'handoff pendingAuthRequest deve essere persistito nel primary prima della notifica"
  );
});

test("MP-4bh price-override scrive audit CAS deterministico e financial sync da snapshot relazionale", () => {
  const serverSource = backendSource;
  const overrideStart = serverSource.indexOf("async function handleIntegrationOrderLinePriceOverride");
  const overrideSource = serverSource.slice(overrideStart, serverSource.indexOf("async function handleIntegrationNotificationPublish", overrideStart));
  const eventsSource = readFileSync(
    path.join(cassaDir, "modules", "integration", "relational-order-events.js"),
    "utf8",
  );

  assert.match(
    overrideSource,
    /events: mergeOrderEvents\(currentOrder\.events, buildOrderLinePriceOverrideRelationalEvents\(/,
    "price-override deve fondere l'evento audit deterministico nel grafo ordine prima del write-primary"
  );
  assert.ok(
    overrideSource.indexOf("buildOrderLinePriceOverrideRelationalEvents") <
      overrideSource.indexOf("syncRelationalOrderPrimary({ enabled: RELATIONAL_ORDERS_PRICE_OVERRIDE_WRITE_PRIMARY"),
    "l'evento audit deve viaggiare dentro la stessa transazione CAS del write-primary"
  );
  assert.match(
    overrideSource,
    /listRelationalOrderWorkflowSnapshot\([\s\S]+buildOrderFinancialSyncState\([\s\S]+captureRelationalOrderFinancialTableGuard\([\s\S]+syncPosTableFinancialsFromIntegrationOrders\(priceOverrideFinancialSyncSource\.state[\s\S]+applyOrderFinancialTableRevisionTokens\([\s\S]+persistRelationalOrderFinancialTables\(/,
    "price-override deve calcolare il financial sync da snapshot relazionale e persistere table_state con revision guard"
  );
  assert.match(overrideSource, /metricLabel:\s*["']orders\.priceOverride\.relationalFinancialSnapshotRead["']/);
  assert.match(
    overrideSource,
    /appendAuditEvent\(db, \{[\s\S]+action: ["']order\.line_price_overridden["']/,
    "l'audit app-state resta presente: e' consumato dai report (reports.handlers)"
  );
  assert.match(
    eventsSource,
    /\$\{orderId\}:\$\{safeLineId\}:order\.line_price_overridden:\$\{safeRevision\}/,
    "l'id evento price-override deve essere deterministico su orderId+lineId+revision"
  );
});

test("MP-4ag orders/cancel calcola financial sync da snapshot relazionale e protegge table_state", () => {
  const serverSource = backendSource;
  const cancelStart = serverSource.indexOf("async function handleIntegrationOrderCancel");
  const cancelEnd = serverSource.indexOf("async function handleIntegrationOrderCorrectionPending");
  const cancelSource = serverSource.slice(cancelStart, cancelEnd);

  assert.match(
    cancelSource,
    /syncRelationalOrderPrimary\([\s\S]+captureRelationalOrderFinancialTableGuard\([\s\S]+buildOrderCancelFinancialDeltaBeforeSnapshotFastPath\([\s\S]+if \(!orderCancelFinancialDeltaFastPath\.applied\) \{[\s\S]+listRelationalOrderWorkflowSnapshot\([\s\S]+buildOrderFinancialSyncState\([\s\S]+syncPosTableFinancialsFromIntegrationOrders\([\s\S]+applyOrderFinancialTableRevisionTokens\([\s\S]+persistRelationalOrderFinancialTables\(/,
    "orders/cancel deve scrivere il primary relazionale prima del financial sync e persistere table_state con revision guard"
  );
  assert.match(cancelSource, /metricLabel:\s*["']orders\.cancel\.relationalFinancialSnapshotRead["']/);
});

test("MP-4aj orders/comp calcola financial sync da snapshot relazionale e protegge table_state", () => {
  const serverSource = backendSource;
  const compStart = serverSource.indexOf("async function handleIntegrationOrderComp");
  const compEnd = serverSource.indexOf("async function handleIntegrationOrderCancel");
  const compSource = serverSource.slice(compStart, compEnd);

  assert.match(
    compSource,
    /syncRelationalOrderPrimary\([\s\S]+listRelationalOrderWorkflowSnapshot\([\s\S]+buildOrderFinancialSyncState\([\s\S]+captureRelationalOrderFinancialTableGuard\([\s\S]+syncPosTableFinancialsFromIntegrationOrders\([\s\S]+applyOrderFinancialTableRevisionTokens\([\s\S]+persistRelationalOrderFinancialTables\(/,
    "orders/comp deve scrivere il primary relazionale prima del financial sync e persistere table_state con revision guard"
  );
  assert.match(compSource, /const orderCompMetricPrefix = explicitStornoRequest \? ["']orders\.storno["'] : ["']orders\.comp["']/);
});

test("MP-4bl orders/storno espone financial sync relazionale con metriche dedicate", () => {
  const serverSource = backendSource;
  const compStart = serverSource.indexOf("async function handleIntegrationOrderComp");
  const compEnd = serverSource.indexOf("async function handleIntegrationOrderCancel");
  const compSource = serverSource.slice(compStart, compEnd);

  assert.match(
    compSource,
    /const orderCompMetricPrefix = explicitStornoRequest \? ["']orders\.storno["'] : ["']orders\.comp["']/,
    "storno deve avere metriche separate dal percorso comp"
  );
  assert.match(
    compSource,
    /syncRelationalOrderPrimary\([\s\S]+listRelationalOrderWorkflowSnapshot\([\s\S]+buildOrderFinancialSyncState\([\s\S]+captureRelationalOrderFinancialTableGuard\([\s\S]+syncPosTableFinancialsFromIntegrationOrders\(orderCompFinancialSyncSource\.state[\s\S]+applyOrderFinancialTableRevisionTokens\([\s\S]+persistRelationalOrderFinancialTables\(/,
    "orders/storno deve usare snapshot relazionale e table_state revision guard prima del mirror"
  );
  assert.match(
    compSource,
    /metricLabel:\s*`\$\{orderCompMetricPrefix\}\.relationalFinancialSnapshotRead`/,
    "storno deve esporre orders.storno.relationalFinancialSnapshotRead"
  );
  assert.match(
    compSource,
    /metricLabel:\s*`\$\{orderCompMetricPrefix\}\.appStateWrite`/,
    "storno deve esporre orders.storno.appStateWrite"
  );
});

test("MP-4bm orders/storno persiste intent fiscal-payment condivisi prima del mirror app-state", () => {
  const serverSource = backendSource;
  const writerStart = serverSource.indexOf("async function writeOrderStornoFiscalPaymentIntentDb");
  const writerEnd = serverSource.indexOf("const writePaymentFreeSplitDb", writerStart);
  const writerSource = serverSource.slice(writerStart, writerEnd);
  const compStart = serverSource.indexOf("async function handleIntegrationOrderComp");
  const compEnd = serverSource.indexOf("async function handleIntegrationOrderCancel");
  const compSource = serverSource.slice(compStart, compEnd);

  assert.match(writerSource, /metricLabel:\s*options\.metricLabel \?\? ["']orders\.storno\.fiscalPaymentIntentWrite["']/);
  for (const domain of [
    "payments",
    "paymentContainers",
    "paymentParts",
    "paymentTransactions",
    "paymentProviderTransactions",
    "fiscalReceipts",
    "fiscalEvents",
    "printSpoolJobs",
    "auditEvents",
  ]) {
    assert.match(writerSource, new RegExp(`["']${domain}["']`), `manca dominio ${domain}`);
  }
  assert.match(
    compSource,
    /const orderStornoFiscalPaymentIntentNeeded = explicitStornoRequest[\s\S]+writeOrderStornoFiscalPaymentIntentDb\(db,\s*\{\s*metricLabel:\s*["']orders\.storno\.fiscalPaymentIntentWrite["']\s*\}\)[\s\S]+writeIntegrationOrderSyncDb\(db,/,
    "lo storno deve persistire intent fiscal/payment prima del mirror app-state"
  );
});

test("MP-4am orders/correct calcola financial sync da snapshot relazionale e protegge table_state", () => {
  const serverSource = backendSource;
  const correctStart = serverSource.indexOf("async function handleIntegrationOrderCorrection");
  const correctEnd = serverSource.indexOf("async function handleIntegrationOrderCancel");
  const correctSource = serverSource.slice(correctStart, correctEnd);

  assert.match(
    correctSource,
    /findRelationalOrderById\(\{[\s\S]+enabled: RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY[\s\S]+currentOrder = sanitizeIntegrationOrder\([\s\S]+if \(!currentOrder \|\| orderIndex < 0\)/,
    "orders/correct deve idratare il read-model relazionale prima del 404 e dei controlli revisione",
  );
  assert.match(
    correctSource,
    /syncRelationalOrderPrimary\([\s\S]+listRelationalOrderWorkflowSnapshot\([\s\S]+buildOrderFinancialSyncState\([\s\S]+captureRelationalOrderFinancialTableGuard\([\s\S]+syncPosTableFinancialsFromIntegrationOrders\([\s\S]+applyOrderFinancialTableRevisionTokens\([\s\S]+persistRelationalOrderFinancialTables\(/,
    "orders/correct deve scrivere il primary relazionale prima del financial sync e persistere table_state con revision guard"
  );
  assert.match(correctSource, /metricLabel:\s*["']orders\.correct\.relationalFinancialSnapshotRead["']/);
  assert.match(correctSource, /skipFinancialSync:\s*RELATIONAL_ORDERS_CORRECT_WRITE_PRIMARY/);
});

test("Fase M5 e il canary lastWriteAt conservano il margine server.js", () => {
  // Qui il soggetto e' la dimensione del monolite, non il backend nel suo
  // insieme: va misurato `server.js` e basta.
  const serverSource = readFileSync(path.join(cassaDir, "server.js"), "utf8");
  const budgetSource = readFileSync(
    path.join(cassaDir, "tests", "architecture-line-budget.test.mjs"),
    "utf8",
  );
  const orderStateMachineSource = readFileSync(
    path.join(cassaDir, "modules", "orders", "order-state-machine.js"),
    "utf8",
  );
  const lineCount = serverSource.split(/\r?\n/).length;
  const serverBudget = 39_500;

  assert.match(
    budgetSource,
    /const SERVER_LINE_BUDGET = 39_500;/,
    "M5 deve abbassare il budget server.js rispetto al margine K-PRE iniziale"
  );
  assert.ok(
    lineCount <= serverBudget,
    `server.js deve restare sotto ${serverBudget} righe, attuali ${lineCount}`
  );
  assert.ok(
    serverBudget - lineCount >= 700,
    `M5 e il canary lastWriteAt devono lasciare almeno 700 righe di margine per wiring N, margine attuale ${serverBudget - lineCount}`
  );
  assert.match(
    orderStateMachineSource,
    /export function createIntegrationWorkflowStateMachine/,
    "modules/orders deve restare la destinazione per le state machine ordine di Fase N"
  );
});

test("Fase N1 collega la payment state machine al boundary pagamenti", () => {
  const serverSource = backendSource;
  const paymentDomainSource = readFileSync(
    path.join(cassaDir, "modules", "payments", "payments.domain.js"),
    "utf8",
  );
  const paymentHandlersSource = readFileSync(
    path.join(cassaDir, "modules", "payments", "payments.handlers.js"),
    "utf8",
  );
  const paymentStateMachineSource = readFileSync(
    path.join(cassaDir, "modules", "payments", "payment-state-machine.js"),
    "utf8",
  );

  assert.match(
    serverSource,
    /PAYMENT_STATE_MACHINE_ENABLED\s*=\s*process\.env\.PAYMENT_STATE_MACHINE_ENABLED !== ["']0["']/,
    "N1 deve avere flag canary default-on per la state machine pagamenti",
  );
  assert.match(
    serverSource,
    /paymentStateMachineEnabled:\s*PAYMENT_STATE_MACHINE_ENABLED/,
    "il flag N1 deve essere passato agli handler pagamenti",
  );
  assert.match(
    paymentDomainSource,
    /resolvePaymentRuntimeState[\s\S]+paymentState[\s\S]+paymentStatePath/,
    "il boundary realtime pagamenti deve esporre lo stato canonico N1",
  );
  assert.match(
    paymentHandlersSource,
    /paymentStateMachineEnabled[\s\S]+buildPaymentRealtimeBoundary\([\s\S]+paymentStateMachineEnabled/,
    "gli handler pagamenti devono chiamare il boundary con il flag N1",
  );
  assert.match(
    paymentStateMachineSource,
    /INVALID_PAYMENT_STATE_TRANSITION/,
    "N1 deve avere un errore esplicito per transizioni pagamento invalide",
  );
  assert.match(
    paymentStateMachineSource,
    /canTransitionPaymentState[\s\S]+applyPaymentStateTransition/,
    "N1 deve avere canTransition/applyTransition ed errore esplicito",
  );
});

test("Fase N2 collega la order state machine al sync ordini", () => {
  const serverSource = backendSource;
  const orderStateMachineSource = readFileSync(
    path.join(cassaDir, "modules", "orders", "order-state-machine.js"),
    "utf8",
  );

  assert.match(
    serverSource,
    /ORDER_STATE_MACHINE_ENABLED\s*=\s*process\.env\.ORDER_STATE_MACHINE_ENABLED !== ["']0["']/,
    "N2 deve avere flag canary default-on per la state machine ordini",
  );
  assert.match(
    serverSource,
    /createIntegrationWorkflowStateMachine\(\{\s*enabled:\s*ORDER_STATE_MACHINE_ENABLED/s,
    "il flag N2 deve essere passato alla state machine workflow ordini",
  );
  assert.match(
    orderStateMachineSource,
    /ORDER_STATE_MACHINE_STATES[\s\S]+draft[\s\S]+emitted[\s\S]+queued[\s\S]+preparing[\s\S]+ready[\s\S]+delivered[\s\S]+partially_paid[\s\S]+paid/,
    "N2 deve dichiarare gli stati canonici ordine della roadmap",
  );
  assert.match(
    orderStateMachineSource,
    /INVALID_ORDER_STATE_TRANSITION/,
    "N2 deve avere un errore esplicito per transizioni ordine invalide",
  );
  assert.match(
    orderStateMachineSource,
    /canTransitionOrderState[\s\S]+applyOrderStateTransition[\s\S]+resolveOrderRuntimeState/,
    "N2 deve avere canTransition/applyTransition e proiezione runtime",
  );
});

test("Fase N3 collega la print state machine allo spool stampa", () => {
  const serverSource = backendSource;
  const printStateMachineSource = readFileSync(
    path.join(cassaDir, "modules", "print-spool", "print-state-machine.js"),
    "utf8",
  );

  assert.match(
    serverSource,
    /PRINT_STATE_MACHINE_ENABLED\s*=\s*process\.env\.PRINT_STATE_MACHINE_ENABLED !== ["']0["']/,
    "N3 deve avere flag canary default-on per la state machine stampa",
  );
  assert.match(
    serverSource,
    /createPrintStateMachine\(\{\s*enabled:\s*PRINT_STATE_MACHINE_ENABLED/s,
    "il flag N3 deve essere passato alla state machine stampa",
  );
  assert.match(
    serverSource,
    /applyPrintSpoolClaimStateTransition[\s\S]+applyPrintSpoolCompletionStateTransition/,
    "lo spool deve usare transizioni esplicite per claim e completamento",
  );
  assert.match(
    serverSource,
    /printState[\s\S]+printStatePath/,
    "i job spool devono esporre stato canonico e path N3",
  );
  assert.match(
    printStateMachineSource,
    /PRINT_STATE_MACHINE_STATES[\s\S]+queued[\s\S]+claimed[\s\S]+sent[\s\S]+confirmed[\s\S]+failed_retryable[\s\S]+failed_final/,
    "N3 deve dichiarare gli stati canonici stampa della roadmap",
  );
  assert.match(
    printStateMachineSource,
    /INVALID_PRINT_STATE_TRANSITION/,
    "N3 deve avere un errore esplicito per transizioni stampa invalide",
  );
  assert.match(
    printStateMachineSource,
    /canTransitionPrintState[\s\S]+applyPrintStateTransition[\s\S]+resolvePrintRuntimeState/,
    "N3 deve avere canTransition/applyTransition e proiezione runtime",
  );
});

test("P3.18 riconcilia table_states relazionale all'avvio prima delle scoped reads", () => {
  const serverSource = backendSource;

  assert.match(
    serverSource,
    /RELATIONAL_TABLES_STARTUP_RECONCILE\s*=\s*process\.env\.BACKEND_RELATIONAL_TABLES_STARTUP_RECONCILE === ["']1["']/,
    "P3.18 deve avere un flag esplicito per il reconcile table_states di startup",
  );
  assert.match(
    serverSource,
    /async function reconcileRelationalTablesAtStartup\(appState\)[\s\S]+syncTablesBillsFromAppState\(relationalRuntime\.db, appState, \{ nowIso \}\)/,
    "P3.18 deve riallineare table_states/table_bills/table_locks dal db idratato",
  );
  assert.match(
    serverSource,
    /await reconcileRelationalTablesAtStartup\(initialAppState\);[\s\S]+await stationStateLastWriteFlush\.recoverFromAppState\(initialAppState\);\s*if \(SHOULD_RUN_BACKEND_OWNER_JOBS\) await relationalRuntime\.syncAfterAppStateWrite\(initialAppState\);/,
    "reconcile tavoli e recovery lastWriteAt devono girare prima della shadow sync generica",
  );
});

test("P3.19 layout usa table_states relazionale solo dietro flag e fallback", () => {
  const serverSource = backendSource;

  assert.match(
    serverSource,
    /RELATIONAL_LAYOUT_TABLES_READ_PRIMARY\s*=\s*process\.env\.BACKEND_RELATIONAL_LAYOUT_TABLES_READ_PRIMARY === ["']1["']/,
    "P3.19 deve avere un flag dedicato per il layout read-primary parziale",
  );
  assert.match(
    serverSource,
    /async function buildLayoutSettingsWithRelationalTableStates\(settings\)[\s\S]+new TablesBillsRelationalRepository\(relationalRuntime\.db\)[\s\S]+repository\.listTableStates\(\)/,
    "P3.19 deve leggere table_states relazionale prima di costruire il layout",
  );
  assert.match(
    serverSource,
    /missingTableIds\.length > 0[\s\S]+integrationLayoutRelationalTablesFallback[\s\S]+source: ["']legacy["']/,
    "P3.19 deve fare fallback legacy se il relazionale non copre tutti i tavoli",
  );
  assert.match(
    serverSource,
    /baseState:\s*\{ \.\.\.db, posSettings:\s*layoutSettingsSource\.settings \}[\s\S]+syncPosTableFinancialsFromIntegrationOrders\(layoutFinancialSource\.state\)[\s\S]+buildIntegrationLayoutFromSettings\(settings, tableOrderStats\)/,
    "P3.19 deve propagare gli settings arricchiti dal relazionale fino al layout",
  );
});


test("API responses include defensive headers", async (t) => {
  const { baseUrl } = await startBackend(t);
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
});

test("public mutation body limits are enforced before handler execution", async (t) => {
  const { baseUrl } = await startBackend(t);
  const oversizedId = "x".repeat(20_000);
  const response = await fetch(`${baseUrl}/api/integration/notifications/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: oversizedId, consumer: "test" }),
  });
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, "Payload troppo grande.");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});
