export function createOrderAsyncFlushMysqlLockRunner(options = {}) {
  const enabled = options.enabled === true;
  const mysqlRepository = options.mysqlRepository ?? null;
  const lockName = String(options.lockName ?? "").trim();
  const timeoutSeconds = Math.max(0, Math.trunc(Number(options.timeoutSeconds) || 0));
  const runtimeMetrics = options.runtimeMetrics ?? null;
  const logger = options.logger ?? console;

  return async function runWithOrderAsyncFlushMysqlLock(action) {
    if (!enabled || !mysqlRepository?.getPool) return action();
    const lockStartedAt = Date.now();
    const pool = await mysqlRepository.getPool();
    const connection = await pool.getConnection();
    let acquired = false;
    try {
      const [rows] = await connection.query(
        "SELECT GET_LOCK(?, ?) AS acquired",
        [lockName, timeoutSeconds],
      );
      acquired = Number(rows?.[0]?.acquired ?? 0) === 1;
      runtimeMetrics?.recordOperation?.(
        "orderWorkflow",
        "orders.asyncFlush.mysqlLockWait",
        Date.now() - lockStartedAt,
      );
      if (!acquired) {
        const error = new Error("Timeout lock MySQL flush asincrono ordini.");
        error.code = "ORDERS_ASYNC_FLUSH_MYSQL_LOCK_TIMEOUT";
        throw error;
      }
      runtimeMetrics?.incrementCounter?.("ordersAsyncFlushMysqlLockAcquired");
      return await action();
    } finally {
      if (acquired) {
        try {
          await connection.query("SELECT RELEASE_LOCK(?)", [lockName]);
        } catch (error) {
          logger?.warn?.(
            "[db:orders-async-flush] rilascio lock MySQL fallito:",
            error?.message || error,
          );
        }
      }
      connection.release();
    }
  };
}

