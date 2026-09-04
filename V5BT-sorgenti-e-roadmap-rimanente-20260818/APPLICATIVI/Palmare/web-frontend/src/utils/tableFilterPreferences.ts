import {
  readTableFilterMode,
  writeTableFilterMode,
  type StoredTableFilterMode,
} from "../shared/storage/tableFilterStorage";

export type TableFilterMode = "exclude" | "single";

const TABLE_FILTER_MODE_EVENT = "table_filter_mode_changed";

export const getTableFilterMode = (): TableFilterMode => {
  if (typeof window === "undefined") return "exclude";
  return readTableFilterMode();
};

export const setTableFilterMode = (mode: TableFilterMode) => {
  if (typeof window === "undefined") return;
  writeTableFilterMode(mode as StoredTableFilterMode);
  window.dispatchEvent(new Event(TABLE_FILTER_MODE_EVENT));
};

export const subscribeTableFilterMode = (handler: () => void) => {
  if (typeof window === "undefined") return () => {};
  const listener = () => handler();
  window.addEventListener(TABLE_FILTER_MODE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(TABLE_FILTER_MODE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
};
