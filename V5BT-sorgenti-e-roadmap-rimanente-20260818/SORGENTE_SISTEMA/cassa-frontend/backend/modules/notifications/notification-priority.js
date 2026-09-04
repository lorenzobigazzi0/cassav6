export const NOTIFICATION_PRIORITY_LEVELS = Object.freeze({
  ordine: Object.freeze({ key: "ordine", rank: 10, label: "Ordine" }),
  consegna: Object.freeze({ key: "consegna", rank: 20, label: "Consegna" }),
  ritiro: Object.freeze({ key: "ritiro", rank: 30, label: "Ritiro" }),
});

const PRIORITY_ALIASES = new Map([
  ["order", "ordine"],
  ["orders", "ordine"],
  ["ordine", "ordine"],
  ["ordini", "ordine"],
  ["new_order", "ordine"],
  ["order_created", "ordine"],
  ["order_sent", "ordine"],
  ["delivery", "consegna"],
  ["deliver", "consegna"],
  ["delivered", "consegna"],
  ["consegna", "consegna"],
  ["consegne", "consegna"],
  ["pickup", "ritiro"],
  ["pick_up", "ritiro"],
  ["ritiro", "ritiro"],
  ["ritiri", "ritiro"],
  ["bell", "ritiro"],
  ["order_ready", "ritiro"],
  ["bell_pickup", "ritiro"],
]);

function normalizePriorityKey(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return PRIORITY_ALIASES.get(normalized) ?? "";
}

export function resolveNotificationPriority(meta = {}, type = "") {
  const source =
    meta.notificationPriority ??
    meta.priorityLevel ??
    meta.priorityType ??
    meta.priority ??
    meta.eventType ??
    type;
  const key = normalizePriorityKey(source);
  return key ? NOTIFICATION_PRIORITY_LEVELS[key] : null;
}

export function applyNotificationPriorityToMeta(meta = {}, type = "") {
  if (!meta || typeof meta !== "object") return meta;
  const priority = resolveNotificationPriority(meta, type);
  if (!priority) return meta;
  meta.notificationPriority = priority.key;
  meta.notificationPriorityRank = priority.rank;
  meta.notificationPriorityLabel = priority.label;
  return meta;
}

export function compareIntegrationNotifications(left, right) {
  const leftRank = Number(left?.meta?.notificationPriorityRank ?? 0);
  const rightRank = Number(right?.meta?.notificationPriorityRank ?? 0);
  const safeLeftRank = Number.isFinite(leftRank) ? leftRank : 0;
  const safeRightRank = Number.isFinite(rightRank) ? rightRank : 0;
  if (safeLeftRank !== safeRightRank) return safeRightRank - safeLeftRank;
  return (Number(right?.createdAt) || 0) - (Number(left?.createdAt) || 0);
}
