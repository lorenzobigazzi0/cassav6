import { readDualPreference, writeDualPreference } from "../shared/storage/preferenceStorage";

const STORAGE_KEY = "mobile:menu:station-badge-enabled";
const CHANGE_EVENT = "mobile:menu:station-badge-setting";

function readStoredValue() {
  return readDualPreference(STORAGE_KEY);
}

export function getMenuStationBadgeEnabled() {
  const rawValue = String(readStoredValue() ?? "").trim();
  if (!rawValue) return true;
  return rawValue !== "0" && rawValue.toLowerCase() !== "false";
}

export function setMenuStationBadgeEnabled(enabled: boolean) {
  const value = enabled ? "1" : "0";
  writeDualPreference(STORAGE_KEY, value);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { enabled } }));
}

export function subscribeMenuStationBadge(callback: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) callback();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}
