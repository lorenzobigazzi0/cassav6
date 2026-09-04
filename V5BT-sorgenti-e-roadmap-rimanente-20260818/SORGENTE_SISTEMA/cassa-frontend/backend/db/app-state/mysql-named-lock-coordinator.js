import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

function lockName(value) {
  const raw = String(value ?? "app-state").trim() || "app-state";
  if (Buffer.byteLength(raw, "utf8") <= 64) return raw;
  return `${raw.slice(0, 39)}:${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
}

export function createMysqlNamedLockCoordinator(options = {}) {
  const enabled = options.enabled === true;
  const name = lockName(options.name);
  const timeoutSeconds = Math.max(0, Math.min(Math.trunc(Number(options.timeoutSeconds) || 5), 30));
  const metrics = options.runtimeMetrics;
  const localQueue = [];
  const reservationStorage = new AsyncLocalStorage();
  const activeReservations = new WeakSet();
  const foregroundBurstLimit = 8;
  let localRunning = false;
  let foregroundBurst = 0;

  function normalizePriority(value) {
    return value === "background" ? "background" : "foreground";
  }

  function dequeueNext() {
    if (localQueue.length === 0) return null;
    const foregroundIndex = localQueue.findIndex(
      (task) => task.priority === "foreground",
    );
    const backgroundIndex = localQueue.findIndex(
      (task) => task.priority === "background",
    );
    const selectedIndex =
      foregroundIndex >= 0 &&
      (backgroundIndex < 0 || foregroundBurst < foregroundBurstLimit)
        ? foregroundIndex
        : backgroundIndex >= 0
          ? backgroundIndex
          : foregroundIndex;
    const [task] = localQueue.splice(selectedIndex, 1);
    return task;
  }

  async function executeMysqlTask(task) {
    const metricLabel = `${task.label}.${task.priority}`;
    metrics?.recordOperation?.(
      "mysqlNamedLock",
      `${metricLabel}.localWait`,
      Date.now() - task.enqueuedAt,
    );

    const pool = await options.mysqlRepository?.getPool?.();
    if (!pool?.getConnection) throw new Error("Pool MySQL non disponibile per il lock di dominio.");
    const connection = await pool.getConnection();
    const startedAt = Date.now();
    let acquired = false;
    try {
      const [rows] = await connection.query("SELECT GET_LOCK(?, ?) AS acquired", [name, timeoutSeconds]);
      acquired = Number(rows?.[0]?.acquired) === 1;
      metrics?.recordOperation?.("mysqlNamedLock", `${metricLabel}.wait`, Date.now() - startedAt);
      if (!acquired) {
        const error = new Error(`Timeout lock MySQL di dominio: ${task.label}.`);
        error.code = "MYSQL_DOMAIN_NAMED_LOCK_TIMEOUT";
        throw error;
      }
      metrics?.incrementCounter?.("mysqlDomainNamedLockAcquired");
      return await task.action();
    } finally {
      if (acquired) {
        try {
          await connection.query("SELECT RELEASE_LOCK(?) AS released", [name]);
        } catch {
          metrics?.incrementCounter?.("mysqlDomainNamedLockReleaseErrors");
        }
      }
      connection.release();
    }
  }

  function currentReservation() {
    const reservation = reservationStorage.getStore();
    return reservation && activeReservations.has(reservation)
      ? reservation
      : null;
  }

  async function executeReservation(task) {
    const metricLabel = `${task.label}.${task.priority}`;
    metrics?.recordOperation?.(
      "mysqlNamedLock",
      `${metricLabel}.localAdmissionWait`,
      Date.now() - task.enqueuedAt,
    );
    const reservation = {
      label: task.label,
      priority: task.priority,
      mysqlTail: Promise.resolve(),
    };
    activeReservations.add(reservation);
    metrics?.incrementCounter?.("mysqlDomainNamedLockLocalReservationAcquired");
    try {
      return await reservationStorage.run(reservation, () =>
        task.action(reservation),
      );
    } finally {
      await reservation.mysqlTail.catch(() => {});
      activeReservations.delete(reservation);
    }
  }

  function executeLocalTask(task) {
    return task.kind === "reservation"
      ? executeReservation(task)
      : executeMysqlTask(task);
  }

  function scheduleNext() {
    if (localRunning) return;
    const task = dequeueNext();
    if (!task) {
      foregroundBurst = 0;
      return;
    }
    localRunning = true;
    foregroundBurst = task.priority === "foreground" ? foregroundBurst + 1 : 0;
    void executeLocalTask(task)
      .then(task.resolve, task.reject)
      .finally(() => {
        localRunning = false;
        scheduleNext();
      });
  }

  function enqueueLocalTask(task) {
    return new Promise((resolve, reject) => {
      const queuedLocally = localRunning || localQueue.length > 0;
      localQueue.push({
        ...task,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      });
      if (queuedLocally) {
        metrics?.incrementCounter?.("mysqlDomainNamedLockLocalQueued");
      }
      scheduleNext();
    });
  }

  async function run(label, action, runOptions = {}) {
    if (!enabled) return action();
    const priority = normalizePriority(runOptions.priority);
    const reservation = currentReservation();
    if (reservation) {
      const task = {
        kind: "mysql",
        label,
        action,
        priority,
        enqueuedAt: Date.now(),
      };
      const result = reservation.mysqlTail.then(() => executeMysqlTask(task));
      reservation.mysqlTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }
    return enqueueLocalTask({ kind: "mysql", label, action, priority });
  }

  async function reserveLocal(label, action, runOptions = {}) {
    if (!enabled) return action(null);
    const reservation = currentReservation();
    if (reservation) return action(reservation);
    return enqueueLocalTask({
      kind: "reservation",
      label,
      action,
      priority: normalizePriority(runOptions.priority),
    });
  }

  function runInLocalReservation(reservation, action) {
    if (!enabled || !reservation) return action();
    if (!activeReservations.has(reservation)) {
      const error = new Error("Prenotazione locale del lock di dominio non attiva.");
      error.code = "MYSQL_DOMAIN_LOCAL_RESERVATION_INACTIVE";
      throw error;
    }
    return reservationStorage.run(reservation, action);
  }

  return { enabled, name, reserveLocal, run, runInLocalReservation };
}
