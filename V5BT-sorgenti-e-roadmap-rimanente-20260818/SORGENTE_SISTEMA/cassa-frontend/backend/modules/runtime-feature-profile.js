function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(text(value).toLowerCase());
}

function sourceFor(env, flag) {
  if (!Object.prototype.hasOwnProperty.call(env, flag)) return "default";
  return env.INVOCATION_ID || env.JOURNAL_STREAM ? "systemd" : "env";
}

function prerequisite(name, satisfied) {
  return { name, satisfied: satisfied === true };
}

function feature({ flag, requested, effective, source, prerequisites = [], fallback }) {
  const unmetPrerequisites = prerequisites
    .filter((entry) => entry.satisfied !== true)
    .map((entry) => entry.name);
  return {
    flag,
    requested: requested === true,
    effective: effective === true,
    source,
    prerequisites,
    unmetPrerequisites,
    fallback: {
      active: requested === true && effective !== true,
      mode: requested === true && effective !== true ? fallback : null,
    },
  };
}

export function buildP43RuntimeFeatureProfile(options = {}) {
  const env = options.env ?? process.env;
  const dbMode = text(options.dbMode ?? env.BACKEND_DB_MODE ?? env.DB_MODE, "json").toLowerCase();
  const relationalFreeSplit = enabled(env.BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY);
  const relationalTablesRead = enabled(env.BACKEND_RELATIONAL_TABLES_READ_PRIMARY) || enabled(env.TABLES_RELATIONAL_READ_PRIMARY);
  const relationalLayoutTablesRead = enabled(env.BACKEND_RELATIONAL_LAYOUT_TABLES_READ_PRIMARY);
  const tableStatesExternalized = text(env.BACKEND_APP_STATE_SPLIT_TABLE_STATES, "off").toLowerCase() === "externalized";
  const mysqlDomains = dbMode === "mysql" && enabled(env.BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS);
  const mysqlSessions = dbMode === "mysql" && enabled(env.BACKEND_MYSQL_SPLIT_SESSIONS);
  const mysqlAudit = dbMode === "mysql" && enabled(env.BACKEND_MYSQL_SPLIT_AUDIT_EVENTS);
  const durableRequested = enabled(env.BACKEND_PAYMENT_FREE_SPLIT_DURABLE_MIRROR);
  const durableEffective = options.effective?.durablePaymentMirror ?? (durableRequested && relationalFreeSplit);
  const skipTablesRequested = enabled(env.BACKEND_PAYMENT_MIRROR_SKIP_POSSETTINGS_TABLES);
  const skipTablesEffective = options.effective?.paymentMirrorSkipTables ?? (
    skipTablesRequested && relationalTablesRead && relationalLayoutTablesRead && tableStatesExternalized
  );
  const statelessRequested = enabled(env.BACKEND_PAYMENT_MIRROR_STATELESS_CONSUMER);
  const statelessEffective = options.effective?.statelessPaymentMirror ?? (
    statelessRequested && durableEffective && skipTablesEffective && mysqlDomains && mysqlAudit
  );
  const settingsReuseRequested = enabled(env.BACKEND_PAYMENT_FREE_SPLIT_SETTINGS_REUSE);
  const settingsReuseEffective = options.effective?.paymentSettingsReuse ?? settingsReuseRequested;
  const waiterFastRequested = enabled(env.BACKEND_WAITER_PAUSE_SESSION_AUDIT_FASTPATH);
  const waiterFastEffective = options.effective?.waiterPauseFastWriter ?? (
    waiterFastRequested && mysqlDomains && mysqlSessions && mysqlAudit
  );
  const telemetryRequested = enabled(env.RUNTIME_METRICS);
  const telemetryEffective = options.effective?.waiterPauseTelemetry ?? telemetryRequested;
  const notificationPunctualRequested = enabled(env.BACKEND_NOTIFICATION_PUNCTUAL_WRITER);
  const notificationPunctualEffective = options.effective?.notificationPunctualWriter ?? (
    notificationPunctualRequested && mysqlDomains
  );
  const counterAtomicRequested = enabled(env.BACKEND_COUNTER_COLLECTION_ATOMIC_FASTPATH);
  const counterAtomicEffective = options.effective?.counterCollectionAtomicWriter ?? (
    counterAtomicRequested && mysqlDomains && mysqlAudit
  );
  const scopedRealtimeRequested = enabled(env.BACKEND_REALTIME_SCOPED_DELIVERY);
  const scopedRealtimeEffective = options.effective?.scopedRealtimeDelivery ?? scopedRealtimeRequested;

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    processRole: text(options.processRole ?? env.BACKEND_PROCESS_ROLE, "monolith"),
    dbMode,
    features: {
      durablePaymentMirror: feature({
        flag: "BACKEND_PAYMENT_FREE_SPLIT_DURABLE_MIRROR",
        requested: durableRequested,
        effective: durableEffective,
        source: sourceFor(env, "BACKEND_PAYMENT_FREE_SPLIT_DURABLE_MIRROR"),
        prerequisites: [prerequisite("relationalPaymentsFreeSplitWritePrimary", relationalFreeSplit)],
        fallback: "synchronous_app_state_mirror",
      }),
      paymentMirrorSkipTables: feature({
        flag: "BACKEND_PAYMENT_MIRROR_SKIP_POSSETTINGS_TABLES",
        requested: skipTablesRequested,
        effective: skipTablesEffective,
        source: sourceFor(env, "BACKEND_PAYMENT_MIRROR_SKIP_POSSETTINGS_TABLES"),
        prerequisites: [
          prerequisite("relationalTablesReadPrimary", relationalTablesRead),
          prerequisite("relationalLayoutTablesReadPrimary", relationalLayoutTablesRead),
          prerequisite("tableStatesExternalized", tableStatesExternalized),
        ],
        fallback: "mirror_pos_settings_tables",
      }),
      statelessPaymentMirror: feature({
        flag: "BACKEND_PAYMENT_MIRROR_STATELESS_CONSUMER",
        requested: statelessRequested,
        effective: statelessEffective,
        source: sourceFor(env, "BACKEND_PAYMENT_MIRROR_STATELESS_CONSUMER"),
        prerequisites: [
          prerequisite("durablePaymentMirror", durableEffective),
          prerequisite("paymentMirrorSkipTables", skipTablesEffective),
          prerequisite("mysqlSplitAppStateDomains", mysqlDomains),
          prerequisite("mysqlSplitAuditEvents", mysqlAudit),
        ],
        fallback: "legacy_durable_mirror_consumer",
      }),
      paymentSettingsReuse: feature({
        flag: "BACKEND_PAYMENT_FREE_SPLIT_SETTINGS_REUSE",
        requested: settingsReuseRequested,
        effective: settingsReuseEffective,
        source: sourceFor(env, "BACKEND_PAYMENT_FREE_SPLIT_SETTINGS_REUSE"),
        fallback: "reload_sanitized_pos_settings",
      }),
      waiterPauseFastWriter: feature({
        flag: "BACKEND_WAITER_PAUSE_SESSION_AUDIT_FASTPATH",
        requested: waiterFastRequested,
        effective: waiterFastEffective,
        source: sourceFor(env, "BACKEND_WAITER_PAUSE_SESSION_AUDIT_FASTPATH"),
        prerequisites: [
          prerequisite("mysqlSplitAppStateDomains", mysqlDomains),
          prerequisite("mysqlSplitSessions", mysqlSessions),
          prerequisite("mysqlSplitAuditEvents", mysqlAudit),
        ],
        fallback: "sequential_split_or_full_writer",
      }),
      waiterPauseTelemetry: feature({
        flag: "RUNTIME_METRICS",
        requested: telemetryRequested,
        effective: telemetryEffective,
        source: sourceFor(env, "RUNTIME_METRICS"),
        fallback: "telemetry_not_recorded",
      }),
      notificationPunctualWriter: feature({
        flag: "BACKEND_NOTIFICATION_PUNCTUAL_WRITER",
        requested: notificationPunctualRequested,
        effective: notificationPunctualEffective,
        source: sourceFor(env, "BACKEND_NOTIFICATION_PUNCTUAL_WRITER"),
        prerequisites: [
          prerequisite("mysqlSplitAppStateDomains", mysqlDomains),
        ],
        fallback: "notification_split_full_writer",
      }),
      counterCollectionAtomicWriter: feature({
        flag: "BACKEND_COUNTER_COLLECTION_ATOMIC_FASTPATH",
        requested: counterAtomicRequested,
        effective: counterAtomicEffective,
        source: sourceFor(env, "BACKEND_COUNTER_COLLECTION_ATOMIC_FASTPATH"),
        prerequisites: [
          prerequisite("mysqlSplitAppStateDomains", mysqlDomains),
          prerequisite("mysqlSplitAuditEvents", mysqlAudit),
        ],
        fallback: "counter_full_app_state_writer",
      }),
      scopedRealtimeDelivery: feature({
        flag: "BACKEND_REALTIME_SCOPED_DELIVERY",
        requested: scopedRealtimeRequested,
        effective: scopedRealtimeEffective,
        source: sourceFor(env, "BACKEND_REALTIME_SCOPED_DELIVERY"),
        fallback: "legacy_global_broadcast",
      }),
    },
    paymentMirrorRetention: {
      intervalMs: Number(options.paymentMirrorRetention?.intervalMs ?? env.BACKEND_PAYMENT_MIRROR_RETENTION_INTERVAL_MS ?? 3_600_000),
      completedDays: Number(options.paymentMirrorRetention?.completedDays ?? env.BACKEND_PAYMENT_MIRROR_COMPLETED_RETENTION_DAYS ?? 30),
      failedDays: Number(options.paymentMirrorRetention?.failedDays ?? env.BACKEND_PAYMENT_MIRROR_FAILED_RETENTION_DAYS ?? 90),
      batchSize: Number(options.paymentMirrorRetention?.batchSize ?? env.BACKEND_PAYMENT_MIRROR_CLEANUP_BATCH_SIZE ?? 250),
    },
    paymentMirrorScheduling: {
      intervalMs: Number(options.paymentMirrorScheduling?.intervalMs ?? env.BACKEND_PAYMENT_MIRROR_WORKER_INTERVAL_MS ?? 100),
      batchSize: Number(options.paymentMirrorScheduling?.batchSize ?? env.BACKEND_PAYMENT_MIRROR_WORKER_BATCH_SIZE ?? 5),
      foregroundIdleGraceMs: Number(options.paymentMirrorScheduling?.foregroundIdleGraceMs ?? env.BACKEND_PAYMENT_MIRROR_FOREGROUND_IDLE_GRACE_MS ?? 3_000),
      foregroundDeferralMaxAgeMs: Number(options.paymentMirrorScheduling?.foregroundDeferralMaxAgeMs ?? env.BACKEND_PAYMENT_MIRROR_FOREGROUND_DEFERRAL_MAX_AGE_MS ?? 15_000),
    },
    dbMutationScheduler: {
      starvationWaitMs: Number(
        options.dbMutationScheduler?.starvationWaitMs ??
          env.DB_MUTATION_STARVATION_WAIT_MS ??
          5_000,
      ),
      source: sourceFor(env, "DB_MUTATION_STARVATION_WAIT_MS"),
    },
  };
}

export function formatRuntimeFeature(featureName, entry) {
  const unmet = Array.isArray(entry?.unmetPrerequisites) && entry.unmetPrerequisites.length > 0
    ? entry.unmetPrerequisites.join(",")
    : "none";
  return `${featureName}: requested=${entry?.requested ? "ON" : "OFF"} effective=${entry?.effective ? "ON" : "OFF"} source=${entry?.source ?? "default"} fallback=${entry?.fallback?.active ? entry.fallback.mode : "none"} unmet=${unmet}`;
}
