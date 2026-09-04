function bucketCount(value) {
  const count = Math.max(0, Math.trunc(Number(value) || 0));
  if (count <= 1) return String(count);
  if (count <= 3) return "2-3";
  if (count <= 5) return "4-5";
  if (count <= 10) return "6-10";
  if (count <= 20) return "11-20";
  return "21p";
}

function countUnits(items) {
  return (Array.isArray(items) ? items : []).reduce(
    (sum, item) => sum + Math.max(1, Math.trunc(Number(item?.qty) || 1)),
    0,
  );
}

function reasonBucket(value) {
  const reason = String(value ?? "").trim().toLowerCase();
  if (!reason) return "none";
  if (reason.includes("prep") || reason.includes("preparation")) return "prep";
  if (reason.includes("ready")) return "ready";
  if (reason.includes("deliver")) return "deliver";
  if (reason.includes("cancel")) return "cancel";
  if (reason.includes("correct")) return "correct";
  if (reason.includes("comp") || reason.includes("storno")) return "comp";
  return "other";
}

function workflowBucket(value) {
  const workflow = String(value ?? "").trim().toLowerCase();
  if (!workflow) return "none";
  if (workflow.includes("deliver") || workflow.includes("consegn") || workflow.includes("pagata")) return "delivered";
  if (workflow.includes("ready") || workflow.includes("pronta") || workflow.includes("consegna")) return "ready";
  if (workflow.includes("prep") || workflow.includes("prepar")) return "prep";
  if (workflow.includes("wait") || workflow.includes("queued") || workflow.includes("attesa")) return "waiting";
  if (workflow.includes("cancel") || workflow.includes("annull")) return "cancelled";
  return "other";
}

function readOrderId(payload, rawOrder) {
  return String(
    payload?.id ?? payload?.orderId ?? rawOrder?.id ?? rawOrder?.orderId ?? "",
  ).trim();
}

function summarizeItems(items, rawOrder = {}) {
  const safeItems = Array.isArray(items) ? items : [];
  const noteText = String(rawOrder.orderNote ?? rawOrder.orderComment ?? "").trim();
  return {
    lines: safeItems.length,
    qty: countUnits(safeItems),
    routes: Array.isArray(rawOrder.lineRoutes) ? rawOrder.lineRoutes.length : 0,
    notes: Boolean(noteText) || safeItems.some((item) => String(item?.note ?? item?.notes ?? "").trim()),
  };
}

export function createOrderLaneMetricLabeler({ maxEntries = 2000 } = {}) {
  const cache = new Map();
  const rememberOrder = (order) => {
    const id = String(order?.id ?? order?.orderId ?? "").trim();
    if (!id) return;
    cache.delete(id);
    cache.set(id, summarizeItems(order?.items, order));
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  };
  const buildLabel = (req, pathname) => {
    const payload = req?.__jsonBodyPayload && typeof req.__jsonBodyPayload === "object" ? req.__jsonBodyPayload : {};
    const safePath = String(pathname ?? "").trim();
    const rawOrder = payload.order && typeof payload.order === "object" ? payload.order : null;
    const sourceItems = safePath === "/api/integration/orders/create" ? payload.lines : rawOrder?.items;
    const id = readOrderId(payload, rawOrder);
    const summary = Array.isArray(sourceItems) ? summarizeItems(sourceItems, { ...rawOrder, orderNote: payload.orderNote ?? rawOrder?.orderNote, orderComment: payload.orderComment ?? rawOrder?.orderComment }) : cache.get(id) ?? summarizeItems([], rawOrder ?? {});
    return `${req?.method ?? "POST"} ${safePath} lines=${bucketCount(summary.lines)} qty=${bucketCount(summary.qty)} routes=${bucketCount(summary.routes)} wf=${workflowBucket(rawOrder?.workflowStatus ?? payload.workflowStatus)} reason=${reasonBucket(payload.workflowReason ?? payload.reason ?? rawOrder?.workflowStatus)} notes=${summary.notes ? 1 : 0}`;
  };
  return { buildLabel, rememberOrder };
}
