import {
  readLocalPreference,
  writeLocalPreference,
} from "../../../shared/storage/preferenceStorage";

export type ThemeMode = "system" | "manual" | "auto_sunset" | "auto_custom";
export type ManualTheme = "light" | "dark";
export type SunsetStatus = "loading" | "ready" | "unavailable";
export type SunLocationSource = "ip" | "manual" | "device";

export type SunCoordinates = {
  lat: number;
  lng: number;
  source: SunLocationSource;
  updatedAt?: number;
};

export const MODE_KEY = "theme_mode";
export const MANUAL_THEME_KEY = "theme_manual_value";
export const CUSTOM_LIGHT_START_KEY = "theme_custom_light_start";
export const CUSTOM_DARK_START_KEY = "theme_custom_dark_start";
export const SUN_COORDINATES_KEY = "theme_solar_coordinates";
export const LEGACY_THEME_KEY = "theme";

export const SUNSET_LIGHT_START_FALLBACK = "06:45";
export const SUNSET_DARK_START_FALLBACK = "19:30";
export const DEVICE_SUN_COORDINATES_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const IP_SUN_COORDINATES_MAX_AGE_MS = 15 * 60 * 1000;

const HHMM_PATTERN = /^\d{2}:\d{2}$/;

export const parseMinutes = (hhmm: string) => {
  const parts = hhmm.split(":");
  if (parts.length !== 2) return 0;
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return 0;
  return Math.max(0, Math.min(23, hh)) * 60 + Math.max(0, Math.min(59, mm));
};

export const isDarkByWindow = (nowDate: Date, lightStart: string, darkStart: string) => {
  const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
  const lightMinutes = parseMinutes(lightStart);
  const darkMinutes = parseMinutes(darkStart);

  if (lightMinutes === darkMinutes) return true;

  const isLightWindow =
    lightMinutes < darkMinutes
      ? nowMinutes >= lightMinutes && nowMinutes < darkMinutes
      : nowMinutes >= lightMinutes || nowMinutes < darkMinutes;

  return !isLightWindow;
};

export const shouldRefreshAutomaticSunCoordinates = (
  coordinates: SunCoordinates | null,
  nowMs: number
) => {
  if (!coordinates) return true;
  if (coordinates.source === "manual") return false;

  const updatedAt = coordinates.updatedAt;
  if (
    typeof updatedAt !== "number" ||
    !Number.isFinite(updatedAt) ||
    updatedAt <= 0 ||
    updatedAt > nowMs
  ) {
    return true;
  }

  const maxAge =
    coordinates.source === "device"
      ? DEVICE_SUN_COORDINATES_MAX_AGE_MS
      : IP_SUN_COORDINATES_MAX_AGE_MS;
  return nowMs - updatedAt >= maxAge;
};

export const readStoredThemeMode = (): ThemeMode => {
  const savedMode = readLocalPreference(MODE_KEY);
  if (
    savedMode === "system" ||
    savedMode === "manual" ||
    savedMode === "auto_sunset" ||
    savedMode === "auto_custom"
  ) {
    return savedMode;
  }

  const legacyTheme = readLocalPreference(LEGACY_THEME_KEY);
  if (legacyTheme === "light" || legacyTheme === "dark") {
    return "manual";
  }

  return "system";
};

export const readStoredManualTheme = (): ManualTheme => {
  const savedManual = readLocalPreference(MANUAL_THEME_KEY);
  if (savedManual === "light" || savedManual === "dark") return savedManual;

  const legacyTheme = readLocalPreference(LEGACY_THEME_KEY);
  if (legacyTheme === "light" || legacyTheme === "dark") return legacyTheme;

  return "dark";
};

export const readStoredCustomLightStart = () => {
  const saved = readLocalPreference(CUSTOM_LIGHT_START_KEY);
  return saved && HHMM_PATTERN.test(saved) ? saved : "07:00";
};

export const readStoredCustomDarkStart = () => {
  const saved = readLocalPreference(CUSTOM_DARK_START_KEY);
  return saved && HHMM_PATTERN.test(saved) ? saved : "20:00";
};

export const resolveSystemDarkPreference = () => {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
};

export const resolveStoredEffectiveTheme = (nowDate = new Date()): ManualTheme => {
  const mode = readStoredThemeMode();
  const manualTheme = readStoredManualTheme();

  if (mode === "manual") return manualTheme;
  if (mode === "auto_sunset" || mode === "auto_custom") {
    return isDarkByWindow(nowDate, readStoredCustomLightStart(), readStoredCustomDarkStart())
      ? "dark"
      : "light";
  }

  return resolveSystemDarkPreference() ? "dark" : "light";
};

export const applyThemeToDocument = (theme: ManualTheme) => {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  writeLocalPreference(LEGACY_THEME_KEY, theme);
};

export const bootstrapStoredTheme = () => {
  applyThemeToDocument(resolveStoredEffectiveTheme());
};
