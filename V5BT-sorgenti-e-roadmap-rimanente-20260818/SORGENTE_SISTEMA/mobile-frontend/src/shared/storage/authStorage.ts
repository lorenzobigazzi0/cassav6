import {
  readDualStorageString,
  removeDualStorageString,
  writeDualStorageString,
} from "./storageAdapter";

export const AUTH_STORAGE_KEYS = {
  token: "pos_token",
  userId: "pos_user_id",
  username: "pos_user",
  fullName: "pos_full_name",
  role: "pos_role",
  roleLabel: "pos_role_label",
  permissions: "pos_permissions",
  allowedPaymentMethodIds: "pos_allowed_payment_method_ids",
  sessionStartedAt: "pos_auth_session_started_at",
  deviceUuid: "pos_device_uuid",
  roomId: "pos_room_id",
  roomName: "pos_room_name",
  activityId: "pos_activity_id",
  activityName: "pos_activity_name",
} as const;

export type AuthStorageKey = (typeof AUTH_STORAGE_KEYS)[keyof typeof AUTH_STORAGE_KEYS];

export function readAuthStorage(key: AuthStorageKey) {
  return readDualStorageString(key);
}

export function writeAuthStorage(key: AuthStorageKey, value: string) {
  writeDualStorageString(key, value);
}

export function removeAuthStorage(key: AuthStorageKey) {
  removeDualStorageString(key);
}

export function readAuthTimestamp(key: AuthStorageKey) {
  const raw = readAuthStorage(key);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
}
