export const TRANSIENT_MYSQL_ROUTE_RETRY_CODES = new Set([
  "ER_CHECKREAD",
  "ER_LOCK_DEADLOCK",
  "ER_LOCK_WAIT_TIMEOUT",
]);

const TRANSIENT_MYSQL_ROUTE_RETRY_ATTEMPTS = 3;
const TRANSIENT_MYSQL_ROUTE_RETRY_BASE_DELAY_MS = 45;
const TRANSIENT_MYSQL_ORDER_WORKFLOW_RETRY_ATTEMPTS = 3;
const TRANSIENT_MYSQL_ORDER_WORKFLOW_RETRY_BASE_DELAY_MS = 60;
const TRANSIENT_MYSQL_PAYMENT_RETRY_ATTEMPTS = 3;
const TRANSIENT_MYSQL_PAYMENT_RETRY_BASE_DELAY_MS = 60;
const TRANSIENT_MYSQL_NOTIFICATION_ACK_RETRY_ATTEMPTS = 3;
const TRANSIENT_MYSQL_NOTIFICATION_ACK_RETRY_BASE_DELAY_MS = 45;

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, Number(ms) || 0)),
  );
}

function resolveTransientMysqlErrorCode(error) {
  let current = error;
  let depth = 0;
  while (current && depth < 4) {
    const code = String(current.code ?? "").trim();
    if (code) return code;
    current = current.cause;
    depth += 1;
  }
  return "unknown";
}

function appendUnique(values, value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return Array.isArray(values) ? values : [];
  return [...new Set([...(Array.isArray(values) ? values : []), normalized])].sort();
}

function recordRequestRetry(req, { scope, pathname, error }) {
  const context = req?.__requestMetricsContext;
  if (!context || typeof context !== "object") return;
  context.mysqlRetryCount = Math.max(0, Number(context.mysqlRetryCount) || 0) + 1;
  context.mysqlRetryScopes = appendUnique(context.mysqlRetryScopes, scope);
  context.mysqlRetryCodes = appendUnique(
    context.mysqlRetryCodes,
    resolveTransientMysqlErrorCode(error),
  );
  context.mysqlRetryStages = appendUnique(context.mysqlRetryStages, "route-retry");
  context.mysqlRetryLabels = appendUnique(context.mysqlRetryLabels, pathname);
}

export function isTransientMysqlRouteError(error) {
  let current = error;
  let depth = 0;
  while (current && depth < 4) {
    const code = String(current.code ?? "").trim();
    const errno = Number(current.errno);
    const message = String(
      current.message ?? current.sqlMessage ?? current,
    ).trim();
    if (TRANSIENT_MYSQL_ROUTE_RETRY_CODES.has(code)) return true;
    if (errno === 1020 || errno === 1205 || errno === 1213) return true;
    if (/Record has changed since last read|Deadlock found when trying to get lock|Lock wait timeout exceeded/i.test(message)) {
      return true;
    }
    current = current.cause;
    depth += 1;
  }
  return false;
}

export function shouldRetryTransientMysqlStationStateRequest({
  req,
  res,
  pathname,
  error,
  isStationStateFastPathRequest,
}) {
  if (typeof isStationStateFastPathRequest !== "function") return false;
  if (!isStationStateFastPathRequest(req?.method, pathname)) return false;
  if (res?.headersSent || res?.writableEnded) return false;
  if (!isTransientMysqlRouteError(error)) return false;
  return Number(req.__transientMysqlRouteRetryCount || 0) < TRANSIENT_MYSQL_ROUTE_RETRY_ATTEMPTS;
}

export function shouldRetryTransientMysqlOrderWorkflowRequest({
  req,
  res,
  pathname,
  error,
  isOrderSyncFastLaneRequest,
}) {
  if (typeof isOrderSyncFastLaneRequest !== "function") return false;
  if (!isOrderSyncFastLaneRequest(req?.method, pathname)) return false;
  if (res?.headersSent || res?.writableEnded) return false;
  if (!isTransientMysqlRouteError(error)) return false;
  return Number(req.__transientMysqlOrderWorkflowRetryCount || 0) <
    TRANSIENT_MYSQL_ORDER_WORKFLOW_RETRY_ATTEMPTS;
}

export function shouldRetryTransientMysqlPaymentRequest({
  req,
  res,
  pathname,
  error,
  isPaymentLaneRequest,
}) {
  if (typeof isPaymentLaneRequest !== "function") return false;
  if (!isPaymentLaneRequest(req?.method, pathname)) return false;
  if (res?.headersSent || res?.writableEnded) return false;
  if (!isTransientMysqlRouteError(error)) return false;
  return Number(req.__transientMysqlPaymentRetryCount || 0) <
    TRANSIENT_MYSQL_PAYMENT_RETRY_ATTEMPTS;
}

export function shouldRetryTransientMysqlNotificationAckRequest({
  req,
  res,
  pathname,
  error,
}) {
  if (req?.method !== "POST" || pathname !== "/api/integration/notifications/ack") {
    return false;
  }
  if (res?.headersSent || res?.writableEnded) return false;
  if (!isTransientMysqlRouteError(error)) return false;
  return Number(req.__transientMysqlNotificationAckRetryCount || 0) <
    TRANSIENT_MYSQL_NOTIFICATION_ACK_RETRY_ATTEMPTS;
}

export async function retryTransientMysqlStationStateRequest({
  req,
  res,
  pathname,
  error,
  isStationStateFastPathRequest,
  retry,
}) {
  if (
    !shouldRetryTransientMysqlStationStateRequest({
      req,
      res,
      pathname,
      error,
      isStationStateFastPathRequest,
    })
  ) {
    return false;
  }
  const attempt = Number(req.__transientMysqlRouteRetryCount || 0) + 1;
  req.__transientMysqlRouteRetryCount = attempt;
  const message = error instanceof Error ? error.message : String(error);
  const errorCode = resolveTransientMysqlErrorCode(error);
  recordRequestRetry(req, { scope: "station-state", pathname, error });
  console.warn(
    `[backend] Retry MySQL route=${pathname} scope=station-state ` +
      `requestId=${req?.__requestMetricsContext?.requestId ?? "unknown"} ` +
      `code=${errorCode} attempt=${attempt}/${TRANSIENT_MYSQL_ROUTE_RETRY_ATTEMPTS}: ${message}`,
  );
  await sleep(
    TRANSIENT_MYSQL_ROUTE_RETRY_BASE_DELAY_MS * attempt +
      Math.floor(Math.random() * 35),
  );
  await retry();
  return true;
}

export async function retryTransientMysqlOrderWorkflowRequest({
  req,
  res,
  pathname,
  error,
  isOrderSyncFastLaneRequest,
  retry,
}) {
  if (
    !shouldRetryTransientMysqlOrderWorkflowRequest({
      req,
      res,
      pathname,
      error,
      isOrderSyncFastLaneRequest,
    })
  ) {
    return false;
  }
  const attempt = Number(req.__transientMysqlOrderWorkflowRetryCount || 0) + 1;
  req.__transientMysqlOrderWorkflowRetryCount = attempt;
  const message = error instanceof Error ? error.message : String(error);
  const errorCode = resolveTransientMysqlErrorCode(error);
  recordRequestRetry(req, { scope: "order", pathname, error });
  console.warn(
    `[backend] Retry MySQL route=${pathname} scope=order ` +
      `requestId=${req?.__requestMetricsContext?.requestId ?? "unknown"} ` +
      `code=${errorCode} attempt=${attempt}/${TRANSIENT_MYSQL_ORDER_WORKFLOW_RETRY_ATTEMPTS}: ${message}`,
  );
  await sleep(
    TRANSIENT_MYSQL_ORDER_WORKFLOW_RETRY_BASE_DELAY_MS * attempt +
      Math.floor(Math.random() * 45),
  );
  await retry();
  return true;
}

export async function retryTransientMysqlPaymentRequest({
  req,
  res,
  pathname,
  error,
  isPaymentLaneRequest,
  retry,
}) {
  if (!shouldRetryTransientMysqlPaymentRequest({
    req,
    res,
    pathname,
    error,
    isPaymentLaneRequest,
  })) {
    return false;
  }
  const attempt = Number(req.__transientMysqlPaymentRetryCount || 0) + 1;
  req.__transientMysqlPaymentRetryCount = attempt;
  const message = error instanceof Error ? error.message : String(error);
  const errorCode = resolveTransientMysqlErrorCode(error);
  recordRequestRetry(req, { scope: "payment", pathname, error });
  console.warn(
    `[backend] Retry MySQL route=${pathname} scope=payment ` +
      `requestId=${req?.__requestMetricsContext?.requestId ?? "unknown"} ` +
      `code=${errorCode} attempt=${attempt}/${TRANSIENT_MYSQL_PAYMENT_RETRY_ATTEMPTS}: ${message}`,
  );
  await sleep(
    TRANSIENT_MYSQL_PAYMENT_RETRY_BASE_DELAY_MS * attempt +
      Math.floor(Math.random() * 45),
  );
  await retry();
  return true;
}

export async function retryTransientMysqlNotificationAckRequest({
  req,
  res,
  pathname,
  error,
  retry,
}) {
  if (!shouldRetryTransientMysqlNotificationAckRequest({ req, res, pathname, error })) {
    return false;
  }
  const attempt = Number(req.__transientMysqlNotificationAckRetryCount || 0) + 1;
  req.__transientMysqlNotificationAckRetryCount = attempt;
  const message = error instanceof Error ? error.message : String(error);
  const errorCode = resolveTransientMysqlErrorCode(error);
  recordRequestRetry(req, { scope: "notification-ack", pathname, error });
  console.warn(
    `[backend] Retry MySQL route=${pathname} scope=notification-ack ` +
      `requestId=${req?.__requestMetricsContext?.requestId ?? "unknown"} ` +
      `code=${errorCode} attempt=${attempt}/${TRANSIENT_MYSQL_NOTIFICATION_ACK_RETRY_ATTEMPTS}: ${message}`,
  );
  await sleep(
    TRANSIENT_MYSQL_NOTIFICATION_ACK_RETRY_BASE_DELAY_MS * attempt +
      Math.floor(Math.random() * 35),
  );
  await retry();
  return true;
}
