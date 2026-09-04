function clampInteger(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function checkpointValue(row, names) {
  for (const name of names) {
    const value = Number(row?.[name]);
    if (Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  }
  return 0;
}

export function createRelationalWalCheckpointScheduler(options = {}) {
  const enabled = options.enabled === true;
  const getDb = typeof options.getDb === "function" ? options.getDb : () => null;
  const runtimeMetrics = options.runtimeMetrics ?? null;
  const logger = options.logger ?? console;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const scheduleTimeout = options.setTimeoutFn ?? setTimeout;
  const cancelTimeout = options.clearTimeoutFn ?? clearTimeout;
  const intervalMs = clampInteger(options.intervalMs, 1_000, 250, 300_000);
  const autoCheckpointPages = clampInteger(options.autoCheckpointPages, enabled ? 0 : 1_000, 0, 1_000_000);
  let timer = null;
  let running = false;
  let stopped = true;

  function setGauge(name, value) {
    runtimeMetrics?.setGauge?.(name, value);
  }

  function schedule() {
    if (!enabled || stopped || timer) return;
    timer = scheduleTimeout(() => {
      timer = null;
      runNow();
      schedule();
    }, intervalMs);
    timer?.unref?.();
  }

  function runNow() {
    if (!enabled) return { ok: false, skipped: "disabled" };
    if (running) return { ok: false, skipped: "running" };
    const db = getDb();
    if (!db || typeof db.prepare !== "function") return { ok: false, skipped: "database_unavailable" };
    const startedAt = now();
    running = true;
    setGauge("relationalWalCheckpointRunning", 1);
    runtimeMetrics?.incrementCounter?.("relationalWalCheckpointRuns");
    try {
      const row = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() ?? {};
      const busy = checkpointValue(row, ["busy"]);
      const logPages = checkpointValue(row, ["log", "log_pages"]);
      const checkpointedPages = checkpointValue(row, ["checkpointed", "checkpointed_pages"]);
      const backlogPages = Math.max(0, logPages - checkpointedPages);
      if (busy > 0) runtimeMetrics?.incrementCounter?.("relationalWalCheckpointBusy");
      runtimeMetrics?.incrementCounter?.("relationalWalCheckpointPages", checkpointedPages);
      setGauge("relationalWalCheckpointBusy", busy);
      setGauge("relationalWalLogPages", logPages);
      setGauge("relationalWalCheckpointedPages", checkpointedPages);
      setGauge("relationalWalBacklogPages", backlogPages);
      setGauge("relationalWalLastCheckpointAtMs", now());
      return { ok: true, busy, logPages, checkpointedPages, backlogPages };
    } catch (error) {
      runtimeMetrics?.incrementCounter?.("relationalWalCheckpointErrors");
      logger.warn?.(`[relational:wal] checkpoint PASSIVE fallito: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      running = false;
      setGauge("relationalWalCheckpointRunning", 0);
      runtimeMetrics?.recordOperation?.("relationalWalCheckpoint", "passive", now() - startedAt);
    }
  }

  function start() {
    setGauge("relationalWalAutoCheckpointPages", autoCheckpointPages);
    if (!enabled || !stopped) return false;
    stopped = false;
    schedule();
    return true;
  }

  function stop() {
    stopped = true;
    if (timer) cancelTimeout(timer);
    timer = null;
  }

  return {
    autoCheckpointPages,
    enabled,
    intervalMs,
    runNow,
    start,
    stop,
  };
}
