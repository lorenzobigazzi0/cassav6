#!/usr/bin/env node
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { buildP43RuntimeFeatureProfile, formatRuntimeFeature } from "../backend/modules/runtime-feature-profile.js";

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), "..");

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function isEnabledMode(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return Boolean(text) && !["0", "false", "no", "off", "disabled"].includes(text);
}

function dirtyTrackingMode() {
  const explicit = env("APP_STATE_DIRTY_TRACKING_MODE", "");
  const legacy = env("APP_STATE_DIRTY_TRACKING", "0");
  const value = explicit || legacy;
  const text = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled", "write"].includes(text)) return "write";
  if (["shadow", "warn", "enforce"].includes(text)) return text;
  return "off";
}

function commandInboxMode() {
  const fallback = isTruthy(env("COMMAND_INBOX_ENABLED")) ? "shadow" : "off";
  const text = String(env("COMMAND_INBOX_MODE", fallback) ?? "").trim().toLowerCase();
  if (["off", "shadow", "write", "enforce", "enforce_pilot"].includes(text)) return text;
  return fallback;
}

function mqttCommandGateEnabled() {
  return (
    isTruthy(env("MQTT_COMMANDS_ENABLED")) &&
    isTruthy(env("COMMAND_INBOX_ENABLED")) &&
    ["write", "enforce", "enforce_pilot"].includes(commandInboxMode()) &&
    isTruthy(env("MQTT_COMMAND_ACK_ENABLED"))
  );
}

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function onOff(name, fallback = "0") {
  return isTruthy(env(name, fallback)) ? "ON" : "OFF";
}

function maskSensitiveValue(name, value) {
  if (!/(token|secret|password|pwd|key|credential)/i.test(name)) return value;
  const text = String(value ?? "");
  if (!text) return "";
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function releaseDirtinessHints(rootDir = ROOT_DIR) {
  const hints = [];
  const checks = [
    ["backend/.print-spool", "cartella spool runtime presente"],
    ["logs", "logs di runtime presenti"],
    ["backend/logs", "backend logs presenti"],
    ["backend/app-state.before-*.json", "backup app-state da verificare"],
    ["backend/backend-relational.sqlite", "sqlite runtime backend presente"],
    ["backend/app-state-split.sqlite", "sqlite split runtime presente"],
  ];
  for (const [relative, message] of checks) {
    const target = path.join(rootDir, relative.replace("*", ""));
    if (relative.includes("*")) continue;
    if (!existsSync(target)) continue;
    try {
      const stats = statSync(target);
      if (stats.isDirectory() || stats.isFile()) hints.push(message);
    } catch {}
  }
  return hints;
}

export function collectRuntimeProfile() {
  const profileName = env("CASSA_RUNTIME_PROFILE", env("CASSAV4_RUNTIME_PROFILE", env("RUNTIME_PROFILE", "standard")));
  const p43Profile = buildP43RuntimeFeatureProfile({ env: process.env });
  const rows = [
    ["Runtime", "profile", profileName],
    ["Runtime", "app version", readPackageVersion()],
    ["Runtime", "node", process.version],
    ["Runtime", "platform", `${process.platform}/${process.arch}`],
    ["Runtime", "pid", String(process.pid)],
    ["Runtime", "cwd", process.cwd()],
    ["Runtime", "timestamp", new Date().toISOString()],

    ["Database", "BACKEND_DB_MODE", env("BACKEND_DB_MODE", env("DB_MODE", "json"))],
    ["Database", "BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS", onOff("BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS")],
    ["Database", "BACKEND_MYSQL_SPLIT_SESSIONS", onOff("BACKEND_MYSQL_SPLIT_SESSIONS")],
    ["Database", "BACKEND_MYSQL_SPLIT_AUDIT_EVENTS", onOff("BACKEND_MYSQL_SPLIT_AUDIT_EVENTS")],
    ["Database", "APP_STATE_DIRTY_TRACKING", env("APP_STATE_DIRTY_TRACKING", "0")],
    ["Database", "APP_STATE_DIRTY_TRACKING_MODE", dirtyTrackingMode()],
    ["Database", "SCOPED_READS", onOff("SCOPED_READS")],
    ["Database", "BACKEND_RELATIONAL_ORDERS_READ_PRIMARY", onOff("BACKEND_RELATIONAL_ORDERS_READ_PRIMARY")],
    ["Database", "BACKEND_RELATIONAL_TABLES_READ_PRIMARY", onOff("BACKEND_RELATIONAL_TABLES_READ_PRIMARY")],

    ["Realtime", "EVENT_OUTBOX_ENABLED", onOff("EVENT_OUTBOX_ENABLED")],
    ["Realtime", "COMMAND_INBOX_ENABLED", onOff("COMMAND_INBOX_ENABLED")],
    ["Realtime", "COMMAND_INBOX_MODE", commandInboxMode()],
    ["Realtime", "IDEMPOTENCY_STORE_ENABLED", onOff("IDEMPOTENCY_STORE_ENABLED")],
    ["Realtime", "SSE_EVENT_PAYLOAD", onOff("SSE_EVENT_PAYLOAD")],
    ["Realtime", "SSE_LEGACY_REFRESH", env("SSE_LEGACY_REFRESH", "1") === "0" ? "OFF" : "ON"],
    ["Realtime", "REALTIME_REPLAY_ENABLED", onOff("REALTIME_REPLAY_ENABLED")],
    ["Realtime", "BACKEND_REALTIME_SCOPED_DELIVERY", onOff("BACKEND_REALTIME_SCOPED_DELIVERY")],
    ["Realtime", "BACKEND_REALTIME_HEARTBEAT_MS", env("BACKEND_REALTIME_HEARTBEAT_MS", "5000")],
    ["Realtime", "BACKEND_REALTIME_BOOTSTRAP_PADDING_BYTES", env("BACKEND_REALTIME_BOOTSTRAP_PADDING_BYTES", "2048")],
    ["Realtime", "BACKEND_REALTIME_GATEWAY_ENABLED", onOff("BACKEND_REALTIME_GATEWAY_ENABLED")],
    ["Realtime", "MQTT_ENABLED", onOff("MQTT_ENABLED")],
    ["Realtime", "MQTT_EVENTS_ENABLED", onOff("MQTT_EVENTS_ENABLED")],
    ["Realtime", "MQTT_COMMANDS_ENABLED", onOff("MQTT_COMMANDS_ENABLED")],
    ["Realtime", "MQTT_COMMAND_ACK_ENABLED", onOff("MQTT_COMMAND_ACK_ENABLED")],
    ["Realtime", "MQTT_COMMAND_GATE", mqttCommandGateEnabled() ? "ON" : "OFF"],
    ["Realtime", "MQTT_URL_CONFIGURED", env("MQTT_URL", "").trim() ? "ON" : "default"],

    ["Redis", "REDIS_ENABLED", onOff("REDIS_ENABLED")],
    ["Redis", "REDIS_CACHE_ENABLED", onOff("REDIS_CACHE_ENABLED")],
    ["Redis", "REDIS_SESSIONS_ENABLED", onOff("REDIS_SESSIONS_ENABLED")],
    ["Redis", "REDIS_PRESENCE_ENABLED", onOff("REDIS_PRESENCE_ENABLED")],
    ["Redis", "REDIS_LOCKS_ENABLED", onOff("REDIS_LOCKS_ENABLED")],
    ["Redis", "REDIS_PERSISTENT_CLIENT", onOff("REDIS_PERSISTENT_CLIENT")],
    ["Redis", "REDIS_PERSISTENT_POOL_SIZE", env("REDIS_PERSISTENT_POOL_SIZE", "4")],

    ["Print", "PRINTING_ENABLED", onOff("PRINTING_ENABLED", "1")],
    ["Print", "PRINT_ASYNC_DISPATCH", onOff("PRINT_ASYNC_DISPATCH")],
    ["Print", "PRINT_SPOOL_SQL_PRIMARY", onOff("PRINT_SPOOL_SQL_PRIMARY")],
    ["Print", "PRINT_SPOOL_FAST_WORKER", onOff("PRINT_SPOOL_FAST_WORKER")],
    ["Print", "PRINT_CIRCUIT_BREAKER", onOff("PRINT_CIRCUIT_BREAKER")],
    ["Print", "PRINT_SPOOL_CLAIM_LEASE_MS", env("PRINT_SPOOL_CLAIM_LEASE_MS", "30000")],
    ["Print", "PRINT_CIRCUIT_BREAKER_THRESHOLD", env("PRINT_CIRCUIT_BREAKER_THRESHOLD", "3")],
    ["Print", "PRINT_CIRCUIT_BREAKER_COOLDOWN_MS", env("PRINT_CIRCUIT_BREAKER_COOLDOWN_MS", "15000")],
    ["Print", "AUTO_PRINT_ENQUEUE_DELAY_MS", env("AUTO_PRINT_ENQUEUE_DELAY_MS", "0")],
    ["Print", "PRINT_SPOOL_PRINTER_PROBE_TIMEOUT_MS", env("PRINT_SPOOL_PRINTER_PROBE_TIMEOUT_MS", "1500")],
    ["Print", "PRINT_TCP_TIMEOUT_MS", env("PRINT_TCP_TIMEOUT_MS", "2500")],

    ["Performance", "RUNTIME_METRICS", onOff("RUNTIME_METRICS")],
    ["Performance", "DIAGNOSTICS_BASELINE", onOff("DIAGNOSTICS_BASELINE")],
    ["Performance", "DIAGNOSTICS_SAMPLE_RATE", env("DIAGNOSTICS_SAMPLE_RATE", "1")],
    ["Performance", "DIAGNOSTICS_BASELINE_LOG_PATH", env("DIAGNOSTICS_BASELINE_LOG_PATH", env("DIAGNOSTICS_LOG_PATH", "backend/logs/performance-baseline.ndjson"))],
    ["Performance", "LANE_PAYMENTS", env("LANE_PAYMENTS", "default")],
    ["Performance", "LANE_ROOMS", env("LANE_ROOMS", "default")],
    ["Performance", "LANE_PRINT", env("LANE_PRINT", "default")],
    ["Performance", "PRINT_LANE_ENABLED", env("PRINT_LANE_ENABLED", "default")],
    ["Performance", "PAYMENT_LANE_ENABLED", env("PAYMENT_LANE_ENABLED", "default")],
    ["Performance", "ROOM_LANE_ENABLED", env("ROOM_LANE_ENABLED", "default")],
    ["Performance", "BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY", onOff("BACKEND_RELATIONAL_ORDERS_WRITE_PRIMARY")],
    ["Performance", "BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY", onOff("BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY")],
    ["Performance", "BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY", onOff("BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY")],
    ["Performance", "BACKEND_RELATIONAL_TABLE_MOVE_WRITE_PRIMARY", onOff("BACKEND_RELATIONAL_TABLE_MOVE_WRITE_PRIMARY")],
    ["Performance", "BACKEND_RELATIONAL_AGGREGATE_LAST_EVENT_BINDING", onOff("BACKEND_RELATIONAL_AGGREGATE_LAST_EVENT_BINDING")],
    ["Performance", "BACKEND_RELATIONAL_PAYMENTS_REPORTS_READS", onOff("BACKEND_RELATIONAL_PAYMENTS_REPORTS_READS")],
    ["Performance", "BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY", onOff("BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY")],
    ["Performance", "BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY", onOff("BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY")],
    ["Performance", "BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY", onOff("BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY")],
    ["Performance", "BACKEND_RELATIONAL_FISCAL_COMMAND_WRITE_PRIMARY", onOff("BACKEND_RELATIONAL_FISCAL_COMMAND_WRITE_PRIMARY")],
    ["Performance", "BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY", onOff("BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY")],
    ["Performance", "BACKEND_FISCAL_OUTBOX_ENABLED", onOff("BACKEND_FISCAL_OUTBOX_ENABLED")],
    ["Performance", "BACKEND_FISCAL_OUTBOX_WORKER_ENABLED", onOff("BACKEND_FISCAL_OUTBOX_WORKER_ENABLED")],
    ["Performance", "BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH", onOff("BACKEND_ORDERS_ASYNC_APPSTATE_FLUSH")],
    ["Performance", "BACKEND_API_WORKER_ENABLED", onOff("BACKEND_API_WORKER_ENABLED")],
    ["Performance", "BACKEND_MULTI_PROCESS_ORDER_WORKERS", onOff("BACKEND_MULTI_PROCESS_ORDER_WORKERS")],

    ["Frontend", "CLIENT_PUSH_FIRST", onOff("CLIENT_PUSH_FIRST")],
    ["Frontend", "CLIENT_WIDE_INVALIDATE_DISABLED", onOff("CLIENT_WIDE_INVALIDATE_DISABLED")],
    ["Frontend", "CLIENT_OPTIMISTIC_ACTIONS", onOff("CLIENT_OPTIMISTIC_ACTIONS")],
    ["Android", "ANDROID_POLLER_FALLBACK_ONLY", onOff("ANDROID_POLLER_FALLBACK_ONLY")],
    ...Object.entries(p43Profile.features).map(([name, entry]) => [
      "P4.3",
      name,
      formatRuntimeFeature(name, entry),
    ]),
    [
      "P4.3",
      "paymentMirrorRetention",
      `intervalMs=${p43Profile.paymentMirrorRetention.intervalMs} completedDays=${p43Profile.paymentMirrorRetention.completedDays} failedDays=${p43Profile.paymentMirrorRetention.failedDays} batchSize=${p43Profile.paymentMirrorRetention.batchSize}`,
    ],
    [
      "P4.3",
      "paymentMirrorScheduling",
      `intervalMs=${p43Profile.paymentMirrorScheduling.intervalMs} batchSize=${p43Profile.paymentMirrorScheduling.batchSize} foregroundIdleGraceMs=${p43Profile.paymentMirrorScheduling.foregroundIdleGraceMs} foregroundDeferralMaxAgeMs=${p43Profile.paymentMirrorScheduling.foregroundDeferralMaxAgeMs}`,
    ],
  ];

  const warnings = [];
  if (/near/i.test(profileName)) {
    if (!isTruthy(env("SSE_EVENT_PAYLOAD"))) warnings.push("NEAR_REALTIME attivo ma SSE_EVENT_PAYLOAD e spento.");
    if (env("SSE_LEGACY_REFRESH", "1") !== "0") warnings.push("NEAR_REALTIME attivo ma SSE_LEGACY_REFRESH e acceso.");
    if (!isTruthy(env("REALTIME_REPLAY_ENABLED"))) warnings.push("NEAR_REALTIME attivo ma REALTIME_REPLAY_ENABLED e spento.");
    if (!isTruthy(env("EVENT_OUTBOX_ENABLED"))) warnings.push("NEAR_REALTIME attivo ma EVENT_OUTBOX_ENABLED e spento.");
    if (!isTruthy(env("COMMAND_INBOX_ENABLED"))) warnings.push("NEAR_REALTIME attivo ma COMMAND_INBOX_ENABLED e spento: idempotenza generica non misurata.");
    if (!isTruthy(env("PRINT_SPOOL_SQL_PRIMARY"))) warnings.push("NEAR_REALTIME attivo ma PRINT_SPOOL_SQL_PRIMARY e spento.");
    if (!isTruthy(env("PRINT_CIRCUIT_BREAKER"))) warnings.push("NEAR_REALTIME attivo ma PRINT_CIRCUIT_BREAKER e spento.");
    if (!isTruthy(env("PRINT_SPOOL_FAST_WORKER"))) warnings.push("NEAR_REALTIME attivo ma PRINT_SPOOL_FAST_WORKER e spento.");
    if (!isTruthy(env("CLIENT_OPTIMISTIC_ACTIONS"))) warnings.push("NEAR_REALTIME attivo ma CLIENT_OPTIMISTIC_ACTIONS e spento.");
    if (!isTruthy(env("SCOPED_READS"))) warnings.push("NEAR_REALTIME attivo ma SCOPED_READS e spento.");
    if (dirtyTrackingMode() === "off") warnings.push("NEAR_REALTIME attivo ma dirty tracking e spento: usare shadow prima di warn/enforce.");
    if (dirtyTrackingMode() === "write") warnings.push("NEAR_REALTIME usa dirty tracking write-fastpath: per questo step preferire shadow e validare il report prima del cutover.");
    if (dirtyTrackingMode() === "enforce") warnings.push("NEAR_REALTIME usa dirty tracking enforce: verificare che shadow/warn siano gia stati validati.");
  }
  if (/redis/i.test(profileName)) {
    if (!isTruthy(env("REDIS_ENABLED"))) warnings.push("Profilo Redis attivo ma REDIS_ENABLED e spento.");
    if (!isTruthy(env("REDIS_CACHE_ENABLED"))) warnings.push("Profilo Redis attivo ma REDIS_CACHE_ENABLED e spento.");
    if (!isTruthy(env("REDIS_SESSIONS_ENABLED"))) warnings.push("Profilo Redis attivo ma REDIS_SESSIONS_ENABLED e spento.");
    if (!isTruthy(env("REDIS_PRESENCE_ENABLED"))) warnings.push("Profilo Redis attivo ma REDIS_PRESENCE_ENABLED e spento.");
    if (isTruthy(env("REDIS_LOCKS_ENABLED"))) warnings.push("REDIS_LOCKS_ENABLED attivo: Redis non deve diventare lock autoritativo in Step 10.");
  }
  if (/mqtt/i.test(profileName)) {
    if (!isTruthy(env("MQTT_ENABLED"))) warnings.push("Profilo MQTT attivo ma MQTT_ENABLED e spento.");
    if (!isTruthy(env("MQTT_EVENTS_ENABLED"))) warnings.push("Profilo MQTT attivo ma MQTT_EVENTS_ENABLED e spento.");
    if (!isTruthy(env("EVENT_OUTBOX_ENABLED"))) warnings.push("Profilo MQTT attivo ma EVENT_OUTBOX_ENABLED e spento: MQTT deve derivare da event_outbox.");
    if (isTruthy(env("MQTT_COMMANDS_ENABLED")) && !mqttCommandGateEnabled()) {
      warnings.push("Profilo MQTT richiede MQTT_COMMANDS_ENABLED ma il gate Step 15 e bloccato: servono command-inbox enforce/write e MQTT_COMMAND_ACK_ENABLED=1.");
    }
    if (mqttCommandGateEnabled()) {
      warnings.push("MQTT command gate attivo: usare solo il pilot Step 17 e verificare wiring command_inbox/ACK prima del cutover.");
    }
  }
  if (isTruthy(env("MQTT_COMMANDS_ENABLED")) && !mqttCommandGateEnabled()) {
    warnings.push("MQTT_COMMANDS_ENABLED attivo ma non effettivo: il gate Step 15 mantiene i comandi bloccati.");
  }
  if (isTruthy(env("PRINTING_ENABLED", "1")) && !isTruthy(env("PRINT_ASYNC_DISPATCH"))) {
    warnings.push("PRINTING_ENABLED attivo ma PRINT_ASYNC_DISPATCH spento: verificare che la stampa non blocchi i flussi.");
  }
  if ((isTruthy(env("LANE_PRINT")) || isTruthy(env("PRINT_LANE_ENABLED"))) && !isTruthy(env("PRINT_SPOOL_SQL_PRIMARY"))) {
    warnings.push("LANE_PRINT attiva ma PRINT_SPOOL_SQL_PRIMARY spento: usare la print lane solo dopo lo spool SQL-primary.");
  }
  const relationalAggregatePilot =
    isTruthy(env("BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY")) ||
    isTruthy(env("BACKEND_RELATIONAL_ORDERS_SYNC_WRITE_PRIMARY")) ||
    isTruthy(env("BACKEND_RELATIONAL_TABLE_MOVE_WRITE_PRIMARY"));
  if (relationalAggregatePilot && !isTruthy(env("BACKEND_RELATIONAL_ENABLED"))) {
    warnings.push("Step 12A attivo ma BACKEND_RELATIONAL_ENABLED e spento: il pilot table/order non puo usare il primary relazionale.");
  }
  if (relationalAggregatePilot && !isTruthy(env("EVENT_OUTBOX_ENABLED"))) {
    warnings.push("Step 12A attivo ma EVENT_OUTBOX_ENABLED e spento: aggregateVersion non e replayabile dallo stream outbox.");
  }
  if (isTruthy(env("BACKEND_RELATIONAL_AGGREGATE_LAST_EVENT_BINDING")) && !isTruthy(env("EVENT_OUTBOX_ENABLED"))) {
    warnings.push("Step 12B attivo ma EVENT_OUTBOX_ENABLED e spento: last_event_id non puo essere aggiornato dagli eventi.");
  }
  if (isTruthy(env("BACKEND_RELATIONAL_TABLES_READ_PRIMARY")) && !isTruthy(env("BACKEND_RELATIONAL_ENABLED"))) {
    warnings.push("Step 12C attivo ma BACKEND_RELATIONAL_ENABLED e spento: le letture tavoli non possono usare il primary relazionale.");
  }
  if (isTruthy(env("BACKEND_RELATIONAL_TABLES_READ_PRIMARY")) && !isTruthy(env("SCOPED_READS"))) {
    warnings.push("Step 12C attivo ma SCOPED_READS e spento: gli endpoint tavoli restano sul fallback full-state.");
  }
  if (isTruthy(env("BACKEND_RELATIONAL_ORDERS_READ_PRIMARY")) && !isTruthy(env("BACKEND_RELATIONAL_ENABLED"))) {
    warnings.push("Step 12D attivo ma BACKEND_RELATIONAL_ENABLED e spento: le letture ordini non possono usare il primary relazionale.");
  }
  if (isTruthy(env("BACKEND_RELATIONAL_ORDERS_READ_PRIMARY")) && !isTruthy(env("SCOPED_READS"))) {
    warnings.push("Step 12D attivo ma SCOPED_READS e spento: l'ordine aperto tavolo resta sul fallback full-state.");
  }
  const relationalPaymentsPilot =
    isTruthy(env("BACKEND_RELATIONAL_PAYMENTS_REPORTS_READS")) ||
    isTruthy(env("BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY")) ||
    isTruthy(env("BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY")) ||
    isTruthy(env("BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY"));
  const relationalPaymentsWritePrimary =
    isTruthy(env("BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY")) ||
    isTruthy(env("BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY")) ||
    isTruthy(env("BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY"));
  if (relationalPaymentsPilot && !isTruthy(env("BACKEND_RELATIONAL_ENABLED"))) {
    warnings.push("Step 12E attivo ma BACKEND_RELATIONAL_ENABLED e spento: i pagamenti non possono usare il primary relazionale.");
  }
  if (relationalPaymentsWritePrimary && !isTruthy(env("EVENT_OUTBOX_ENABLED"))) {
    warnings.push("Step 12E write-primary attivo ma EVENT_OUTBOX_ENABLED e spento: gli eventi pagamento non sono replayable.");
  }
  if (relationalPaymentsWritePrimary && !isTruthy(env("IDEMPOTENCY_STORE_ENABLED"))) {
    warnings.push("Step 12E write-primary attivo ma IDEMPOTENCY_STORE_ENABLED e spento: retry/doppi tap non sono persistenti.");
  }
  const relationalFiscalPilot =
    isTruthy(env("BACKEND_RELATIONAL_FISCAL_COMMAND_WRITE_PRIMARY")) ||
    isTruthy(env("BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY"));
  if (relationalFiscalPilot && !isTruthy(env("BACKEND_RELATIONAL_ENABLED"))) {
    warnings.push("Step 12F attivo ma BACKEND_RELATIONAL_ENABLED e spento: il fiscale non puo usare il primary relazionale.");
  }
  if (relationalFiscalPilot && !isTruthy(env("EVENT_OUTBOX_ENABLED"))) {
    warnings.push("Step 12F attivo ma EVENT_OUTBOX_ENABLED e spento: gli eventi fiscali non sono replayable.");
  }
  if (isTruthy(env("BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY")) && !relationalPaymentsWritePrimary) {
    warnings.push("Step 12F ricevute fiscali attivo senza pagamenti write-primary: abilitare prima i flag Step 12E.");
  }
  if (isTruthy(env("BACKEND_FISCAL_OUTBOX_ENABLED")) && !isTruthy(env("BACKEND_RELATIONAL_ENABLED"))) {
    warnings.push("Step 13A fiscal_outbox attivo ma BACKEND_RELATIONAL_ENABLED e spento: la coda fiscale durabile non puo essere scritta.");
  }
  if (isTruthy(env("BACKEND_FISCAL_OUTBOX_ENABLED")) && !isTruthy(env("BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY"))) {
    warnings.push("Step 13A fiscal_outbox attivo senza ricevute fiscali write-primary: abilitare prima Step 12F.");
  }
  if (isTruthy(env("BACKEND_FISCAL_OUTBOX_ENABLED")) && !isTruthy(env("EVENT_OUTBOX_ENABLED"))) {
    warnings.push("Step 13A fiscal_outbox attivo ma EVENT_OUTBOX_ENABLED e spento: lo stato fiscale non e accompagnato da evento replayable.");
  }
  if (isTruthy(env("BACKEND_FISCAL_OUTBOX_WORKER_ENABLED")) && !isTruthy(env("BACKEND_FISCAL_OUTBOX_ENABLED"))) {
    warnings.push("Step 13D worker fiscal_outbox attivo ma BACKEND_FISCAL_OUTBOX_ENABLED e spento: nessun job durabile da processare.");
  }
  if (isTruthy(env("BACKEND_FISCAL_OUTBOX_WORKER_ENABLED")) && !isTruthy(env("BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY"))) {
    warnings.push("Step 13D worker fiscal_outbox attivo senza ricevute fiscali write-primary: il registro relazionale non puo essere aggiornato.");
  }
  if (isTruthy(env("BACKEND_FISCAL_OUTBOX_WORKER_ENABLED")) && !relationalPaymentsWritePrimary) {
    warnings.push("Step 13G worker fiscal_outbox attivo senza pagamenti write-primary: nessun flusso pagamento puo garantire enqueue fiscale relazionale.");
  }
  if (
    isTruthy(env("BACKEND_FISCAL_OUTBOX_WORKER_ENABLED")) &&
    (!isTruthy(env("BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY")) ||
      !isTruthy(env("BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY")) ||
      !isTruthy(env("BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY")))
  ) {
    warnings.push("Step 13G worker fiscal_outbox attivo con pagamenti write-primary parziali: ticket, tavolo e split libero devono essere coerenti nel profilo staging.");
  }
  if (dirtyTrackingMode() === "off") warnings.push("APP_STATE_DIRTY_TRACKING spento: i path full-state possono restare disponibili.");
  for (const hint of releaseDirtinessHints(ROOT_DIR)) warnings.push(hint);

  return { rows, warnings };
}

export function formatRuntimeProfile(profile = collectRuntimeProfile()) {
  const header = "CASSAv4 runtime profile";
  const maxCat = Math.max(...profile.rows.map((row) => row[0].length), 8);
  const maxKey = Math.max(...profile.rows.map((row) => row[1].length), 8);
  const lines = [header, "=".repeat(header.length)];
  for (const [category, key, value] of profile.rows) {
    lines.push(`${category.padEnd(maxCat)}  ${key.padEnd(maxKey)}  ${maskSensitiveValue(key, value)}`);
  }
  if (profile.warnings.length) {
    lines.push("", "WARNING");
    for (const warning of profile.warnings) lines.push(`- ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  process.stdout.write(formatRuntimeProfile());
}
