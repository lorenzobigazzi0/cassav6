import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(testDir, "..", "..");
const deployDir = path.join(cassaRoot, "deploy", "raspberry-final");
const systemdDropinDir = path.join(cassaRoot, "deploy", "systemd");

function readDeployFile(name) {
  return fs.readFileSync(path.join(deployDir, name), "utf8");
}

function readSystemdDropin(name) {
  return fs.readFileSync(path.join(systemdDropinDir, name), "utf8");
}

test("[DEPLOY][RASPBERRY] profilo finale espone realtime gateway e pool api-worker", () => {
  const serverSource = fs.readFileSync(path.join(cassaRoot, "backend", "server.js"), "utf8");
  const backendUnit = readDeployFile("cassav4-backend.service");
  const frontendUnit = readDeployFile("cassav4-frontend.service");
  const realtimeUnit = readDeployFile("cassav4-realtime.service");
  const workerUnit = readDeployFile("cassav4-api-worker@.service");
  const lockWorkerUnit = readDeployFile("cassav4-table-lock-worker.service");
  const envExample = readDeployFile("cassav4.env.example");
  const lockWorkerEnv = readDeployFile("cassav4-table-lock-worker.env");
  const walCheckpointDropin = readSystemdDropin("60-p3-relational-wal-checkpoint.conf");

  assert.match(backendUnit, /Environment=BACKEND_PROCESS_ROLE=api-owner/);
  assert.match(realtimeUnit, /Environment=BACKEND_PROCESS_ROLE=realtime-gateway/);
  assert.match(realtimeUnit, /Environment=PORT=5282/);
  assert.match(workerUnit, /Environment=BACKEND_PROCESS_ROLE=api-worker/);
  assert.match(workerUnit, /Environment=PORT=%i/);
  assert.match(workerUnit, /Environment=PRINTING_ENABLED=0/);
  assert.match(lockWorkerUnit, /Environment=BACKEND_PROCESS_ROLE=table-lock-worker/);
  assert.match(lockWorkerUnit, /Environment=BACKEND_MYSQL_POOL_METRICS=1/);
  assert.match(lockWorkerUnit, /Environment=PORT=5285/);
  assert.match(lockWorkerUnit, /Environment=PRINTING_ENABLED=0/);
  assert.match(lockWorkerUnit, /CPUAffinity=0 1 2 3/);
  for (const unit of [backendUnit, realtimeUnit, workerUnit, lockWorkerUnit, frontendUnit]) {
    assert.match(unit, /EnvironmentFile=-\/etc\/cassav4\/cassav4-table-lock-worker\.env/);
  }
  assert.match(lockWorkerEnv, /BACKEND_MULTI_PROCESS_TABLE_LOCK_WORKERS=1/);
  assert.match(lockWorkerEnv, /BACKEND_MYSQL_CONNECTION_LIMIT=8/);
  assert.match(lockWorkerEnv, /BACKEND_MYSQL_TABLE_LOCK_NAMED_LOCKS=1/);
  assert.match(lockWorkerEnv, /BACKEND_MYSQL_TABLE_LOCK_HYBRID=1/);
  assert.match(lockWorkerEnv, /BACKEND_MYSQL_TABLE_LOCK_TOMBSTONES=1/);
  assert.match(serverSource, /createMysqlTableLocksRepository\(\{[\s\S]*?namedLocksEnabled:\s*process\.env\.BACKEND_MYSQL_TABLE_LOCK_NAMED_LOCKS !== "0"/);
  assert.match(serverSource, /createMysqlTableLocksRepository\(\{[\s\S]*?tombstonesEnabled:\s*MYSQL_TABLE_LOCKS_TOMBSTONES/);
  assert.match(lockWorkerEnv, /BACKEND_TABLE_LOCK_WORKER_REQUEST_FASTPATH=1/);
  assert.match(lockWorkerEnv, /BACKEND_MYSQL_TABLE_LOCKS=1/);
  assert.match(lockWorkerEnv, /POST \/api\/tables\/lock\/force-release/);

  assert.match(frontendUnit, /cassav4-api-worker@5283\.service/);
  assert.match(frontendUnit, /cassav4-api-worker@5284\.service/);
  assert.match(frontendUnit, /cassav4-table-lock-worker\.service/);
  assert.match(frontendUnit, /Environment=BACKEND_REALTIME_ORIGIN=http:\/\/127\.0\.0\.1:5282/);
  assert.match(frontendUnit, /Environment=BACKEND_API_WORKER_ORIGIN=http:\/\/127\.0\.0\.1:5283,http:\/\/127\.0\.0\.1:5284/);
  assert.match(frontendUnit, /Environment=BACKEND_TABLE_LOCK_WORKER_ORIGIN=http:\/\/127\.0\.0\.1:5285/);

  assert.match(envExample, /BACKEND_RELATIONAL_SHADOW_SYNC_ENABLED=0/);
  assert.match(envExample, /BACKEND_MULTI_PROCESS_READ_WORKERS=1/);
  assert.match(envExample, /BACKEND_MULTI_PROCESS_ORDER_WORKERS=1/);
  assert.match(envExample, /BACKEND_APP_STATE_SPLIT_TABLE_STATES=externalized/);
  assert.match(envExample, /BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY=1/);
  assert.match(envExample, /BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH=1/);
  assert.match(envExample, /BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1/);
  assert.match(envExample, /BACKEND_MULTI_PROCESS_TABLE_LOCK_WORKERS=1/);
  assert.match(envExample, /BACKEND_MYSQL_TABLE_LOCK_NAMED_LOCKS=1/);
  assert.match(envExample, /BACKEND_MYSQL_TABLE_LOCK_HYBRID=1/);
  assert.match(envExample, /BACKEND_MYSQL_TABLE_LOCK_TOMBSTONES=0/);
  assert.match(envExample, /BACKEND_TABLE_LOCK_WORKER_REQUEST_FASTPATH=1/);
  assert.match(envExample, /BACKEND_MYSQL_TABLE_LOCKS=1/);
  assert.match(envExample, /POST \/api\/tables\/lock\/force-release/);
  assert.match(envExample, /BACKEND_RELATIONAL_WAL_CHECKPOINT_OWNER=1/);
  assert.match(envExample, /BACKEND_RELATIONAL_WAL_CHECKPOINT_INTERVAL_MS=1000/);
  assert.match(envExample, /BACKEND_RELATIONAL_LAYOUT_ORDERS_READ_PRIMARY=1/);
  assert.match(walCheckpointDropin, /Environment=BACKEND_RELATIONAL_WAL_CHECKPOINT_OWNER=1/);
  assert.match(walCheckpointDropin, /Environment=BACKEND_RELATIONAL_WAL_CHECKPOINT_INTERVAL_MS=1000/);
  assert.match(envExample, /POST \/api\/integration\/orders\/storno/);
});

test("[DEPLOY][RASPBERRY] telemetria hardware persiste crash evidence a basso impatto", () => {
  const telemetryScript = readDeployFile("cassav4-hardware-telemetry.sh");
  const telemetryUnit = readDeployFile("cassav4-hardware-telemetry.service");
  const readme = readDeployFile("README.md");

  assert.match(telemetryScript, /journalctl -b -1 -k/);
  assert.match(telemetryScript, /journalctl -b -1 -p warning\.\.alert/);
  assert.match(telemetryScript, /vcgencmd_value get_throttled/);
  assert.match(telemetryScript, /\/sys\/class\/thermal\/thermal_zone\*\/temp/);
  assert.match(telemetryScript, /\/proc\/pressure\/cpu/);
  assert.match(telemetryScript, /sync -d "\$LOG_FILE"/);
  assert.match(telemetryScript, /CASSAV4_TELEMETRY_MAX_BYTES/);

  assert.match(telemetryUnit, /User=cassav4/);
  assert.match(telemetryUnit, /SupplementaryGroups=systemd-journal video/);
  assert.match(telemetryUnit, /Restart=always/);
  assert.match(telemetryUnit, /CPUAffinity=0 1 2 3/);
  assert.match(telemetryUnit, /CPUWeight=10/);
  assert.match(telemetryUnit, /IOWeight=10/);
  assert.match(telemetryUnit, /MemoryMax=64M/);
  assert.match(telemetryUnit, /NoNewPrivileges=true/);
  assert.match(telemetryUnit, /ProtectSystem=strict/);
  assert.match(telemetryUnit, /ReadWritePaths=\/var\/log\/cassav4 \/var\/lib\/cassav4/);
  assert.match(readme, /systemctl enable --now cassav4-hardware-telemetry\.service/);
});

test("[DEPLOY][RASPBERRY] collector P4 crea bundle forense senza toccare servizi", () => {
  const collector = readDeployFile("cassav4-p4-crash-forensics.sh");
  const readme = readDeployFile("README.md");

  assert.match(collector, /run_id non valido/);
  assert.match(collector, /journalctl -b -1 -k/);
  assert.match(collector, /previous-boot-critical-signals/);
  assert.match(collector, /oom\|out of memory\|killed process\|watchdog\|panic/);
  assert.match(collector, /vcgencmd get_throttled/);
  assert.match(collector, /copy_artifact_tree "\$CONTROL_DIR"/);
  assert.match(collector, /copy_artifact_tree "\$LOADTEST_DIR"/);
  assert.match(collector, /MANIFEST\.sha256/);
  assert.match(collector, /sha256sum "\$ARCHIVE_PATH"/);
  assert.match(collector, /sync -d "\$ARCHIVE_PATH" "\$CHECKSUM_PATH"/);
  assert.doesNotMatch(collector, /systemctl\s+(?:stop|restart|poweroff|reboot)/);
  assert.match(readme, /cassav4-p4-crash-forensics/);
});

test("[DEPLOY][RASPBERRY] installer osservabilita P4 e transazionale e non riavvia app", () => {
  const installer = readDeployFile("install-p4-observability.sh");
  const readme = readDeployFile("README.md");

  assert.match(installer, /P4_OBSERVABILITY_DRY_RUN/);
  assert.match(installer, /P4_OBSERVABILITY_SYSTEM_ROOT/);
  assert.match(installer, /SYSTEMCTL_BIN="\$\{SYSTEMCTL_BIN:-\/usr\/bin\/systemctl\}"/);
  assert.match(installer, /BACKUP_ROOT=.*p4-observability/);
  assert.match(installer, /rollback\(\)/);
  assert.match(installer, /restore_file/);
  assert.match(installer, /"\$SYSTEMCTL_BIN" enable --now "\$TELEMETRY_UNIT"/);
  assert.match(installer, /--test --test-isolation=none/);
  assert.match(installer, /P4_PREFLIGHT_ONLY=1/);
  assert.match(installer, /5281 5282 5283 5284 5285/);
  assert.match(installer, /https:\/\/127\.0\.0\.1:5280\/mobile\//);
  assert.doesNotMatch(installer, /systemctl\s+restart/);
  assert.match(readme, /Deploy transazionale degli strumenti P4/);
});
