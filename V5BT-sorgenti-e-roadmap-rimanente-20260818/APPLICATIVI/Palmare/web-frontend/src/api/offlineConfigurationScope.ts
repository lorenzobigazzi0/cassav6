import { AUTH_STORAGE_KEYS, readAuthStorage } from "../shared/storage/authStorage";
import type { OfflineConfigurationScope } from "../domain/offlineConfiguration/types";

export function resolveOfflineConfigurationScope(input: {
  userId: string;
  activityId?: string;
}): OfflineConfigurationScope | null {
  const userId = input.userId.trim();
  if (!userId) return null;

  const explicitActivityId = String(input.activityId ?? "").trim();
  if (explicitActivityId) return { userId, activityId: explicitActivityId };

  const authenticatedUserId = String(readAuthStorage(AUTH_STORAGE_KEYS.userId) ?? "").trim();
  if (authenticatedUserId !== userId) return null;
  const activityId = String(readAuthStorage(AUTH_STORAGE_KEYS.activityId) ?? "").trim();
  return activityId ? { userId, activityId } : null;
}
