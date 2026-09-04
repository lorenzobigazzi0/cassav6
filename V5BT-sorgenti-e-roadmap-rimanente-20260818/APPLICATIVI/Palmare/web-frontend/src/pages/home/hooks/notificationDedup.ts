import type { ServerNotification } from "../../../api/notifications";

const MAX_DEDUPED_NOTIFICATIONS = 600;

const normalizeNotificationKeyPart = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

export const notificationDedupKey = (item: ServerNotification) => {
  const id = String(item.id ?? "").trim();
  if (id) return `id:${id}`;
  const meta = item.meta && typeof item.meta === "object" ? item.meta : {};
  return [
    "fallback",
    item.type,
    normalizeNotificationKeyPart(meta.tableId ?? meta.tableName),
    normalizeNotificationKeyPart(item.createdAt),
    normalizeNotificationKeyPart(item.title),
    normalizeNotificationKeyPart(item.description),
  ].join("|");
};

export const rememberNotificationKey = (seen: Set<string>, key: string) => {
  if (seen.has(key)) return false;
  seen.add(key);
  while (seen.size > MAX_DEDUPED_NOTIFICATIONS) {
    const oldest = seen.values().next().value as string | undefined;
    if (!oldest) break;
    seen.delete(oldest);
  }
  return true;
};
