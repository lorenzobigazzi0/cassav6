import type { ServerNotification } from "../../../api/notifications";

export const normalizeNotificationSessionStartedAt = (value: unknown): number | null => {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
};

export const isNotificationFreshForSession = (
  item: ServerNotification,
  sessionStartedAt: number | null
) => {
  if (sessionStartedAt === null) return false;
  const createdAt = Number(item.createdAt);
  return Number.isFinite(createdAt) && createdAt > 0 && createdAt >= sessionStartedAt;
};
