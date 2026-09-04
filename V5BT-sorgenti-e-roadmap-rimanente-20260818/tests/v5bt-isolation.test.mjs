import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

test("gli script usano soltanto i namespace operativi V5BT", async () => {
  const [startSource, stopSource, provisionSource] = await Promise.all([
    read("start-v5bt.sh"),
    read("stop-v5bt.sh"),
    read("database/provision-cassa-v5bt.sh"),
  ]);
  const combined = `${startSource}\n${stopSource}\n${provisionSource}`;

  assert.doesNotMatch(combined, /CASSAV5_/);
  assert.doesNotMatch(combined, /(?:^|[^a-z0-9_])cassav5(?:[^a-z0-9_]|$)/i);
  assert.doesNotMatch(combined, /(?:^|[^a-z0-9_])cassa_v5(?:[^a-z0-9_]|$)/i);
  assert.doesNotMatch(combined, /(?:start|stop|provision)-v5\.sh/);
  assert.match(startSource, /\.runtime\/cassav5bt/);
  assert.match(startSource, /cassa_v5bt_app/);
  assert.match(startSource, /cassa_v5bt/);
  assert.match(startSource, /CASSAV5BT_LAN_IP:-192\.168\.0\.67/);
});

test("l'avvio elimina l'ambiente ereditato e isola dati e processi dalle installazioni precedenti", async () => {
  const source = await read("start-v5bt.sh");

  assert.ok((source.match(/\benv -i\b/g) ?? []).length >= 4);
  assert.doesNotMatch(source, /BACKEND_MYSQL_URL|MYSQL_URL|DATABASE_URL/);
  assert.match(source, /BACKEND_API_WORKER_PORTS=/);
  assert.match(source, /BACKEND_REALTIME_ORIGIN=/);
  assert.match(source, /BACKEND_API_WORKER_ORIGIN=/);
  assert.match(source, /BACKEND_READ_ORIGIN=/);
  assert.match(source, /BACKEND_TABLE_LOCK_WORKER_ORIGIN=/);
  assert.match(source, /BACKEND_RUNTIME_METRICS_PEER_URLS=/);
  assert.match(source, /BACKEND_REALTIME_GATEWAY_ENABLED=0/);
  assert.match(source, /BACKEND_API_WORKER_ENABLED=0/);
  assert.match(source, /REDIS_ENABLED=0/);
  assert.match(source, /MQTT_ENABLED=0/);
  assert.match(source, /SSE_EVENT_PAYLOAD=1/);
  assert.match(source, /SSE_LEGACY_REFRESH=0/);
  assert.match(source, /BACKEND_REALTIME_SCOPED_DELIVERY=1/);
  assert.match(source, /HARDWARE_MODE="\$\{CASSAV5BT_HARDWARE_MODE:-real\}"/);
  assert.match(source, /PRINTING_ENABLED_VALUE=1/);
  assert.match(source, /FISCAL_PROVIDER_VALUE=pos-fiscal-api/);
  assert.match(source, /FISCAL_REAL_IO_DISABLED_VALUE=0/);
  assert.match(source, /AUTOMATIC_CASH_REAL_ENABLED_VALUE=1/);
  assert.match(source, /PRINT_SPOOL_SQL_PRIMARY=0/);
  assert.match(source, /BACKEND_FISCAL_OUTBOX_ENABLED=0/);
  assert.match(source, /BACKEND_FISCAL_OUTBOX_WORKER_ENABLED=0/);
  assert.match(source, /BACKEND_MYSQL_TABLE_LOCK_NAMED_LOCKS=0/);
  assert.match(source, /ORDERS_ASYNC_FLUSH_MYSQL_LOCK=0/);
  assert.match(source, /ORDERS_ASYNC_FLUSH_MYSQL_LOCK_NAME=cassav5bt:/);
});

test("il profilo reale richiede un file hardware protetto e non avvia simulatori", async () => {
  const source = await read("start-v5bt.sh");

  assert.match(source, /HARDWARE_FILE="\$RUNTIME_DIR\/hardware\.env"/);
  assert.match(source, /richiesti proprietario corrente e 0600/);
  assert.match(source, /Endpoint loopback vietato nel profilo hardware reale/);
  assert.match(source, /if \[\[ "\$HARDWARE_MODE" == "simulated" \]\]; then/);
  assert.match(source, /tools\/mock-fiscal-server\.mjs/);
  assert.match(source, /tools\/fake-automatic-cash-gateway\.mjs/);
  assert.match(source, /AUTOMATIC_CASH_GATEWAY_TIMEOUT_MS=120000/);
});

test("la configurazione reale allinea BAR-1 e BAR-2 alle postazioni operative", async () => {
  const source = await read("database/configure-v5bt-real-hardware.mjs");

  assert.match(source, /barWorkstationId = "workstation_bar_principale"/);
  assert.match(source, /barIntegrationStationName = "BAR-1"/);
  assert.match(source, /kitchenWorkstationId = "workstation_cucina"/);
  assert.match(source, /kitchenIntegrationStationName = "BAR-2"/);
  assert.match(source, /stationName: barIntegrationStationName/);
  assert.match(source, /stationName: kitchenIntegrationStationName/);
  assert.match(source, /workstationIds: \[barWorkstationId, kitchenWorkstationId\]/);
  assert.match(source, /fondo_cassa_test_10_euro\.json/);
  assert.match(source, /configSetId: testCashFloatConfigSet\.id/);
  assert.match(source, /printer_bar_1921681195_9100/);
  assert.match(source, /host: "192\.168\.1\.195"/);
  assert.match(source, /ip: "192\.168\.1\.195"/);
  assert.doesNotMatch(source, /192\.168\.1\.102/);
});

test("la Postazione V5BT mostra solo camerieri online e usa presenza breve", async () => {
  const [startSource, appSource] = await Promise.all([
    read("start-v5bt.sh"),
    read("SORGENTE_SISTEMA/postazione/src/App.jsx"),
  ]);

  assert.match(startSource, /SESSION_HEARTBEAT_WRITE_MIN_INTERVAL_MS=15000/);
  assert.match(startSource, /INTEGRATION_WAITER_ACTIVE_WINDOW_MS=90000/);
  assert.match(appSource, /const WAITER_ACTIVE_MS = 90000/);
  assert.match(appSource, /\/api\/integration\/waiters\?source=mobile-frontend&activeMs=\$\{WAITER_ACTIVE_MS\}/);
  assert.match(appSource, /entry\.clientApp === "mobile-frontend"/);
  assert.match(appSource, /entry\.online && entry\.activeNow/);
  assert.doesNotMatch(appSource, /includeInactive=1/);
});

test("database e file laterali richiedono un provisioning completo", async () => {
  const [startSource, provisionSource] = await Promise.all([
    read("start-v5bt.sh"),
    read("database/provision-cassa-v5bt.sh"),
  ]);

  assert.match(startSource, /cassav5bt_provisioning_marker/);
  assert.match(startSource, /production_table_count/);
  assert.match(startSource, /!= "480"/);
  assert.match(startSource, /BACKEND_ALLOW_EMPTY_DB_INIT=0/);
  assert.match(startSource, /BACKEND_ALLOW_MYSQL_IMPORT_JSON=0/);
  assert.match(startSource, /BACKEND_RELATIONAL_DB_PATH=/);
  assert.match(startSource, /BACKEND_APP_STATE_SPLIT_DB_PATH=/);

  assert.match(provisionSource, /cassav5bt_production_seed_20260719\.sql\.gz/);
  assert.match(
    provisionSource,
    /9c1bcdd6095c669440a524987dc173874edd6186f64571eb98788f957ec613f8/,
  );
  assert.match(provisionSource, /cassa_v5bt_app/);
  assert.doesNotMatch(provisionSource, /\bDROP\s+DATABASE\b/i);
  const importIndex = provisionSource.indexOf("gzip --decompress --stdout");
  const markerIndex = provisionSource.indexOf(
    "CREATE TABLE cassav5bt_provisioning_marker",
  );
  assert.ok(importIndex >= 0, "comando import dump mancante");
  assert.ok(markerIndex >= 0, "creazione marker mancante");
  assert.ok(importIndex < markerIndex, "il marker precede l'import");
});

test("gli script eseguibili e i dump sensibili hanno permessi corretti", async () => {
  for (const relativePath of [
    "start-v5bt.sh",
    "stop-v5bt.sh",
    "tools/run-v5bt-service.sh",
    "database/provision-cassa-v5bt.sh",
    "SORGENTE_SISTEMA/tools/restart-v5bt-linux.sh",
  ]) {
    const metadata = await stat(path.join(root, relativePath));
    assert.equal(metadata.mode & 0o111, 0o111, `${relativePath} non eseguibile`);
  }

  for (const relativePath of [
    "database/cassav5bt_production_seed_20260719.sql.gz",
    "database/cassa_local_v46_snapshot_20260719.sql.gz",
  ]) {
    const metadata = await stat(path.join(root, relativePath));
    assert.equal(metadata.mode & 0o077, 0, `${relativePath} leggibile da altri utenti`);
  }

  const runtimeMetadata = await stat(path.join(root, ".runtime", "cassav5bt"));
  assert.equal(runtimeMetadata.mode & 0o077, 0, "runtime V5BT accessibile ad altri utenti");
});

test("il launcher condiviso rispetta i blocchi V5BT", async () => {
  const source = await read("SORGENTE_SISTEMA/tools/restart-v5bt-linux.sh");
  assert.match(source, /BACKEND_PORT="\$\{BACKEND_PORT:-5381\}"/);
  assert.match(source, /FRONTEND_PORT="\$\{FRONTEND_PORT:-5380\}"/);
  assert.match(source, /REALTIME_PORT="\$\{BACKEND_REALTIME_PORT:-5382\}"/);
  assert.match(source, /API_WORKER_PORT="\$\{BACKEND_API_WORKER_PORT:-5383\}"/);
  assert.match(
    source,
    /BACKEND_ALLOW_EMPTY_DB_INIT="\$\{BACKEND_ALLOW_EMPTY_DB_INIT:-1\}"/,
  );
  assert.match(
    source,
    /BACKEND_ALLOW_MYSQL_IMPORT_JSON="\$\{BACKEND_ALLOW_MYSQL_IMPORT_JSON:-1\}"/,
  );
  assert.match(source, /is_managed_process/);
  assert.match(source, /\/proc\/\$pid\/stat/);
});

test("frontend e proxy operativi espongono soltanto endpoint e nomi V5BT", async () => {
  const [serverSource, appSource, mobileHtml, stationHtml] =
    await Promise.all([
      read("SORGENTE_SISTEMA/serve-frontends.mjs"),
      read("SORGENTE_SISTEMA/postazione/src/App.jsx"),
      read("SORGENTE_SISTEMA/mobile-frontend/index.html"),
      read("SORGENTE_SISTEMA/postazione/index.html"),
    ]);

  assert.match(serverSource, /FRONTEND_PORT \?\? "5380"/);
  assert.match(serverSource, /BACKEND_ORIGIN \?\? "http:\/\/127\.0\.0\.1:5381"/);
  assert.match(serverSource, /BATTERY_ORIGIN \?\? "http:\/\/127\.0\.0\.1:8865"/);
  assert.match(serverSource, /FRONTEND_LAN_IP \?\? "192\.168\.0\.67"/);
  assert.match(serverSource, /"x-cassav5bt-proxy-backend-role"/);
  assert.doesNotMatch(serverSource, /x-cassav4-proxy/i);
  assert.match(appSource, /window\.API_BASE/);
  assert.match(appSource, /window\.location\?\.origin/);
  assert.doesNotMatch(appSource, /5381/);
  assert.doesNotMatch(appSource, /5281/);
  assert.match(mobileHtml, /<title>Palmare Advanced<\/title>/);
  assert.match(stationHtml, /<title>Postazione Advanced<\/title>/);
  assert.match(stationHtml, /<script type="module" src="\/src\/main\.jsx"><\/script>/);
  assert.doesNotMatch(stationHtml, /postazione-[^"']*bridge\.js/i);
});

test("il servizio V5BT supervisiona runtime e salute al riavvio", async () => {
  const [supervisorSource, unitSource] = await Promise.all([
    read("tools/run-v5bt-service.sh"),
    read("deploy/systemd/cassav5bt.service"),
  ]);

  assert.match(supervisorSource, /bash "\$ROOT\/start-v5bt\.sh"/);
  assert.match(supervisorSource, /bash "\$ROOT\/stop-v5bt\.sh"/);
  assert.match(supervisorSource, /backend-linux-current\.pid/);
  assert.match(supervisorSource, /frontends-linux-current\.pid/);
  assert.match(supervisorSource, /127\.0\.0\.1:\$\{BACKEND_PORT\}\/api\/health/);
  assert.match(supervisorSource, /127\.0\.0\.1:\$\{BATTERY_PORT\}\/api\/health/);
  assert.match(unitSource, /^Description=Cassa V5BT$/m);
  assert.match(unitSource, /^User=admin$/m);
  assert.match(unitSource, /^Restart=on-failure$/m);
  assert.match(unitSource, /^KillMode=mixed$/m);
  assert.match(unitSource, /^WantedBy=multi-user\.target$/m);
});

test("il launcher secondario richiede segreti espliciti prima di arrestare processi", async () => {
  const source = await read("SORGENTE_SISTEMA/tools/restart-v5bt-linux.sh");
  const validationIndex = source.indexOf("require_runtime_setting");
  const stopIndex = source.indexOf('stop_pid_file "$BACKEND_PID"');

  assert.ok(validationIndex >= 0, "validazione impostazioni runtime mancante");
  assert.ok(stopIndex > validationIndex, "la validazione deve precedere gli stop");
  for (const setting of [
    "BACKEND_MYSQL_HOST",
    "BACKEND_MYSQL_PORT",
    "BACKEND_MYSQL_USER",
    "BACKEND_MYSQL_PASSWORD",
    "BACKEND_MYSQL_DATABASE",
    "AUTOMATIC_CASH_GATEWAY_BASE_URL",
    "AUTOMATIC_CASH_GATEWAY_USERNAME",
    "AUTOMATIC_CASH_GATEWAY_PASSWORD",
  ]) {
    assert.match(source, new RegExp(`require_runtime_setting[\\s\\S]*${setting}`));
    assert.doesNotMatch(
      source,
      new RegExp(`${setting}="\\\\\\$\\\\\\{${setting}:-[^}]+\\\\\\}"`),
      `${setting} contiene ancora un fallback non vuoto`,
    );
  }
});

test("il quick check SQLite usa il runtime incluso e non il client di sistema", async () => {
  const [startSource, stopSource, provisionSource, helperSource, resolverSource] =
    await Promise.all([
      read("start-v5bt.sh"),
      read("stop-v5bt.sh"),
      read("database/provision-cassa-v5bt.sh"),
      read("tools/v5bt-sqlite-quick-check.mjs"),
      read("tools/v5bt-node-runtime.sh"),
    ]);

  assert.doesNotMatch(`${startSource}\n${provisionSource}`, /\bsqlite3\b/);
  assert.match(startSource, /v5bt-sqlite-quick-check\.mjs/);
  assert.match(provisionSource, /v5bt-sqlite-quick-check\.mjs/);
  for (const source of [startSource, stopSource, provisionSource]) {
    assert.match(source, /source "\$ROOT\/tools\/v5bt-node-runtime\.sh"/);
    assert.match(source, /resolve_v5bt_node_bin "\$ROOT"/);
  }
  assert.match(
    resolverSource,
    /BASELINE_SERVER_RASPBERRY\/runtime\/node-v24\.15\.0-linux-arm64\/bin\/node/,
  );
  assert.match(
    resolverSource,
    /\.runtime\/node-v22\.23\.1-linux-x64\/bin\/node/,
  );
  assert.match(resolverSource, /process\.arch/);
  assert.match(helperSource, /DatabaseSync/);
  assert.match(helperSource, /PRAGMA quick_check/);
  assert.match(helperSource, /readOnly: true/);
});

test("lo stop ignora un PID estraneo e continua la pulizia", async () => {
  const runtimeDirectory = await mkdtemp(path.join(tmpdir(), "cassav5bt-stop-test-"));
  const foreignPidFile = path.join(runtimeDirectory, "battery.pid");
  try {
    await writeFile(foreignPidFile, `${process.pid}\n`, { mode: 0o600 });

    const result = spawnSync("bash", [path.join(root, "stop-v5bt.sh")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CASSAV5BT_RUNTIME_DIR: runtimeDirectory,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /PID file V5BT obsoleto ignorato/);
    assert.doesNotThrow(() => process.kill(process.pid, 0));
    await assert.rejects(
      stat(foreignPidFile),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});
