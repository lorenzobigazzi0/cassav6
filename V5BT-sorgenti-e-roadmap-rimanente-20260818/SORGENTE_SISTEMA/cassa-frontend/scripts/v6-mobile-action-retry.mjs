export const V6_MOBILE_TABLE_LOCK_MAX_ATTEMPTS = 2;
export const V6_MOBILE_TABLE_LOCK_RETRY_DELAY_MS = 150;

export function isV6TransientMobileTableLock(result) {
  return (
    Number(result?.status ?? 0) === 409 &&
    String(result?.body?.code ?? "").trim() === "TABLE_LOCKED"
  );
}

export async function runV6MobileBusinessActionRetry({
  actionType,
  logicalActionId,
  idempotencyKey,
  maxAttempts = V6_MOBILE_TABLE_LOCK_MAX_ATTEMPTS,
  attempt,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  onRetry = () => undefined,
} = {}) {
  const stableActionType = String(actionType ?? "").trim();
  const stableLogicalActionId = String(logicalActionId ?? "").trim();
  const stableIdempotencyKey = String(idempotencyKey ?? "").trim();
  if (!stableActionType) throw new Error("Il retry mobile richiede actionType.");
  if (!stableLogicalActionId) {
    throw new Error("Il retry mobile richiede un logicalActionId stabile.");
  }
  if (!stableIdempotencyKey) {
    throw new Error("Il retry mobile richiede una idempotencyKey stabile.");
  }
  if (typeof attempt !== "function") {
    throw new TypeError("attempt deve essere una funzione.");
  }
  if (typeof wait !== "function") throw new TypeError("wait deve essere una funzione.");
  if (typeof onRetry !== "function") {
    throw new TypeError("onRetry deve essere una funzione.");
  }

  const requestedAttempts = Math.max(1, Math.trunc(Number(maxAttempts) || 1));
  const attemptLimit = Math.min(
    requestedAttempts,
    V6_MOBILE_TABLE_LOCK_MAX_ATTEMPTS,
  );
  let lastResult = null;
  for (let index = 0; index < attemptLimit; index += 1) {
    const context = Object.freeze({
      actionType: stableActionType,
      logicalActionId: stableLogicalActionId,
      idempotencyKey: stableIdempotencyKey,
      attempt: index + 1,
    });
    lastResult = await attempt(context);
    if (
      !isV6TransientMobileTableLock(lastResult) ||
      index + 1 >= attemptLimit
    ) {
      return lastResult;
    }

    const retryDetail = Object.freeze({
      ...context,
      delayMs: V6_MOBILE_TABLE_LOCK_RETRY_DELAY_MS,
      status: 409,
      code: "TABLE_LOCKED",
    });
    await onRetry(retryDetail);
    await wait(V6_MOBILE_TABLE_LOCK_RETRY_DELAY_MS);
  }
  return lastResult;
}
