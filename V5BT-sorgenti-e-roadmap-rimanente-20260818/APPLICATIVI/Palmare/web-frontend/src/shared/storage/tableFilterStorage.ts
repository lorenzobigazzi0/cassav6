import { readLocalStorageString, writeLocalStorageString } from "./storageAdapter";

export type StoredTableFilterMode = "exclude" | "single";

export const TABLE_FILTER_MODE_KEY = "settings_table_filter_mode";

export function readTableFilterMode(): StoredTableFilterMode {
  return readLocalStorageString(TABLE_FILTER_MODE_KEY) === "single" ? "single" : "exclude";
}

export function writeTableFilterMode(mode: StoredTableFilterMode) {
  writeLocalStorageString(TABLE_FILTER_MODE_KEY, mode);
}
