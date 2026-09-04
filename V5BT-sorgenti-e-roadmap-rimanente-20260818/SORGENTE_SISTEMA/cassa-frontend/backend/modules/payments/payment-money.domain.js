export function createPaymentMoneyHelpers(options = {}) {
  const {
    normalizeUsername = (value) => String(value ?? "").trim().toLowerCase(),
    roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100,
  } = options;

  function moneyToCents(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return 0;
    return Math.max(Math.round(amount * 100), 0);
  }

  function centsToMoney(cents) {
    return roundMoney(Math.max(Math.trunc(Number(cents) || 0), 0) / 100);
  }

  function normalizePaymentBillIds(value) {
    return [
      ...new Set(
        (Array.isArray(value) ? value : [])
          .map((entry) => String(entry ?? "").trim())
          .filter(Boolean)
      ),
    ];
  }

  function findPaymentBillLine(bill, selection) {
    const lines = Array.isArray(bill?.lines) ? bill.lines : [];
    const lineId = String(selection?.lineId ?? selection?.id ?? "").trim();
    const productId = String(selection?.productId ?? "").trim();
    const name = normalizeUsername(selection?.name ?? selection?.productName ?? selection?.itemName);
    return (
      (lineId
        ? lines.find((line) => String(line?.lineId ?? line?.id ?? "").trim() === lineId) ?? null
        : null) ??
      (productId
        ? lines.find((line) => String(line?.productId ?? "").trim() === productId) ?? null
        : null) ??
      (name
        ? lines.find((line) => normalizeUsername(line?.name ?? line?.productName ?? line?.itemName) === name) ?? null
        : null)
    );
  }

  return {
    centsToMoney,
    findPaymentBillLine,
    moneyToCents,
    normalizePaymentBillIds,
  };
}
