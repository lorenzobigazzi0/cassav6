export type OfflineRequestMode = "read-cache" | "automatic" | "none";

export type OfflineRequestPolicy = {
  mode: OfflineRequestMode;
  maxAgeMs: number;
  expiresInMs: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const READ_METHODS = new Set(["GET", "HEAD"]);
const RETRYABLE_FAILURE_STATUSES = new Set([502, 503, 504]);

const POST_READ_PATTERNS = [
  /\/api\/auth\/session\/status$/,
  /\/api\/pos\/rooms$/,
  /\/api\/.*\/(list|status|overview|availability|state)$/,
  /\/api\/settings\/(pos|order-workflow)$/,
  /\/api\/mobile\/radio\/config$/,
];

const POST_AUTOMATIC_PATTERNS = [/\/api\/pos\/reservations\/status$/];

const NEVER_QUEUE_PATTERNS = [
  /\/api\/auth\/(login|logout|change-pin)$/,
  /\/api\/health$/,
  /\/api\/.*\/locks?(\/|$)/,
  /\/api\/integration\/(orders\/create|orders\/sync|layout\/table\/sync)$/,
  /\/api\/integration\/layout\/table\/(move|room-move\/.*)$/,
];

const AUTOMATIC_FISCAL_RECONCILIATION_PATTERNS = [
  /\/api\/reports\/payment-movement\/fiscal\/(issue|void)$/,
];

const NEVER_QUEUE_CRITICAL_PATTERNS = [
  /\/api\/payments?(\/|$)/,
  /\/api\/.*fiscal/i,
  /\/api\/automatic-cash(\/|$)/,
  /\/api\/cash-exchange(\/|$)/,
  /\/api\/commercial-benefits(\/|$)/,
  /\/api\/mobile\/radio\/config\/save$/,
  /\/api\/mobile\/waiter-pause\/(start|stop)$/,
  /\/api\/monitor\/control$/,
  /\/api\/tables\/counter\/orders\/collect$/,
  /\/api\/.*(settlement|scarico)/i,
  /\/api\/integration\/print$/,
  /\/api\/.*(return|refund|cancel|correction|service-recovery)/i,
];

const SHORT_LIVED_PATTERNS = [/\/api\/integration\/notifications\/(ack|publish)$/];

const pathnameOf = (value: string) => {
  try {
    return new URL(value, "https://appassets.androidplatform.net").pathname;
  } catch {
    return value.split("?")[0] || value;
  }
};

const normalizedMethod = (method?: string) =>
  String(method || "GET")
    .trim()
    .toUpperCase() || "GET";

export function classifyOfflineRequest(url: string, method?: string): OfflineRequestPolicy {
  const pathname = pathnameOf(url);
  const requestMethod = normalizedMethod(method);

  if (pathname === "/api/health" || pathname.includes("/notifications/pull")) {
    return { mode: "none", maxAgeMs: 0, expiresInMs: 0 };
  }

  if (
    requestMethod === "POST" &&
    POST_AUTOMATIC_PATTERNS.some((pattern) => pattern.test(pathname))
  ) {
    return { mode: "automatic", maxAgeMs: 0, expiresInMs: 2 * DAY_MS };
  }

  if (
    READ_METHODS.has(requestMethod) ||
    (requestMethod === "POST" && POST_READ_PATTERNS.some((pattern) => pattern.test(pathname)))
  ) {
    const maxAgeMs = pathname === "/api/auth/session/status" ? 12 * 60 * 60 * 1000 : 7 * DAY_MS;
    return { mode: "read-cache", maxAgeMs, expiresInMs: 0 };
  }

  if (NEVER_QUEUE_PATTERNS.some((pattern) => pattern.test(pathname))) {
    return { mode: "none", maxAgeMs: 0, expiresInMs: 0 };
  }

  if (AUTOMATIC_FISCAL_RECONCILIATION_PATTERNS.some((pattern) => pattern.test(pathname))) {
    return { mode: "automatic", maxAgeMs: 0, expiresInMs: 7 * DAY_MS };
  }

  if (NEVER_QUEUE_CRITICAL_PATTERNS.some((pattern) => pattern.test(pathname))) {
    return { mode: "none", maxAgeMs: 0, expiresInMs: 0 };
  }

  const expiresInMs = SHORT_LIVED_PATTERNS.some((pattern) => pattern.test(pathname))
    ? 5 * 60 * 1000
    : 2 * DAY_MS;
  return { mode: "automatic", maxAgeMs: 0, expiresInMs };
}

export function isOfflineFailureStatus(status: number) {
  return status === 0 || RETRYABLE_FAILURE_STATUSES.has(status);
}

export function shouldQueueMutationAfterHttpResponse(policy: OfflineRequestPolicy, status: number) {
  if (!isOfflineFailureStatus(status)) return false;
  return policy.mode === "automatic";
}
