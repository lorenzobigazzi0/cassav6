export function buildIntegrationOrderLineSignature(item = {}) {
  return [
    String(item.name ?? "").trim(),
    String(item.variant ?? "").trim(),
    String(item.note ?? "").trim(),
    String(item.unitPriceApplied ?? 0),
    String(item.listPriceAtTime ?? 0),
    Array.isArray(item.routeStations) ? item.routeStations.join("|") : "",
  ].join("||");
}

export function nextIntegrationOrderLineId(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  let max = 0;
  items.forEach((item) => {
    const parsed = Number.parseInt(String(item?.lineId ?? "").replace(/[^\d]/g, ""), 10);
    if (Number.isFinite(parsed)) max = Math.max(max, parsed);
  });
  return `line_${String(max + 1).padStart(4, "0")}`;
}
