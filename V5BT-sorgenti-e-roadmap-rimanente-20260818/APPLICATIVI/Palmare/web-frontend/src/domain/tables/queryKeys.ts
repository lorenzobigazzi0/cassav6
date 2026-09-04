export const TABLE_SESSION_HISTORY_GRACE_MS = 1000;

export const tablesQueryKey = (roomId: string, activityId = "") =>
  ["tables-room", roomId, activityId] as const;
