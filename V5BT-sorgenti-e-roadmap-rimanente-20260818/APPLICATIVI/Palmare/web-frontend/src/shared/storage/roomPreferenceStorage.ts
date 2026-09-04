import {
  readDualStorageString,
  removeDualStorageString,
  writeDualStorageString,
} from "./storageAdapter";

export const ROOM_PREFERENCE_KEY = "pos_last_room_by_user";
export const ROOM_USER_ID_KEY = "pos_user_id";
export const ROOM_ID_KEY = "pos_room_id";
export const ROOM_NAME_KEY = "pos_room_name";
export const ROOM_ACTIVITY_ID_KEY = "pos_activity_id";
export const ROOM_ACTIVITY_NAME_KEY = "pos_activity_name";

export type StoredRoomPreference = {
  roomId?: string;
  roomName?: string;
  activityId?: string;
  activityName?: string;
  updatedAt?: string;
};

export function readRoomStorage(key: string) {
  return readDualStorageString(key);
}

export function writeRoomStorage(key: string, value: string) {
  writeDualStorageString(key, value);
}

export function removeRoomStorage(key: string) {
  removeDualStorageString(key);
}

export function readRoomPreferenceMap() {
  try {
    const parsed = JSON.parse(readRoomStorage(ROOM_PREFERENCE_KEY) || "{}");
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, StoredRoomPreference>)
      : {};
  } catch {
    return {};
  }
}

export function writeRoomPreferenceMap(map: Record<string, StoredRoomPreference>) {
  writeRoomStorage(ROOM_PREFERENCE_KEY, JSON.stringify(map || {}));
}
