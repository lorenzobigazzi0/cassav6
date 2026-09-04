export function normalizeIntegrationOrderTimestamp(value) {
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value.trim();
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(Math.trunc(numeric)).toISOString();
  }
  return null;
}

export function resolveIntegrationReadyAtMs(order, options = {}) {
  const readyAtMs = Number(order?.readyAtMs);
  if (Number.isFinite(readyAtMs) && readyAtMs > 0) {
    return Math.trunc(readyAtMs);
  }
  const fallbackNowMs = Number(options.fallbackNowMs);
  if (Number.isFinite(fallbackNowMs) && fallbackNowMs > 0) {
    return Math.trunc(fallbackNowMs);
  }
  return Date.now();
}
