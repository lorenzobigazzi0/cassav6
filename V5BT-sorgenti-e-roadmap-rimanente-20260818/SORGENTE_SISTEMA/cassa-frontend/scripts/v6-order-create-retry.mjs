const retryableOrderCreateResult = (result) => {
  const status = Number(result?.status ?? 0);
  const code = String(result?.body?.code ?? "").trim().toUpperCase();
  return (
    status === 0 ||
    status === 428 ||
    (status === 409 && code === "TABLE_LOCKED")
  );
};

export async function runV6OrderCreateRetry({
  idempotencyKey,
  maxAttempts = 5,
  attempt,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  onRetry = () => undefined,
} = {}) {
  const stableKey = String(idempotencyKey || "").trim();
  if (!stableKey) throw new Error("Il retry comanda richiede una idempotencyKey stabile.");
  if (typeof attempt !== "function") throw new TypeError("attempt deve essere una funzione.");
  const limit = Math.max(1, Math.trunc(Number(maxAttempts) || 1));
  let lastResult = null;
  for (let index = 0; index < limit; index += 1) {
    lastResult = await attempt({
      attempt: index + 1,
      idempotencyKey: stableKey,
    });
    if (lastResult?.status === 200 && lastResult?.body?.order) return lastResult;
    if (!retryableOrderCreateResult(lastResult) || index + 1 >= limit) return lastResult;
    const delayMs = 200 + index * 150;
    onRetry({
      attempt: index + 1,
      delayMs,
      status: Number(lastResult?.status ?? 0),
      code: String(lastResult?.body?.code ?? ""),
    });
    await wait(delayMs);
  }
  return lastResult;
}
