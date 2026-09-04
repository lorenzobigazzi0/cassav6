import { useEffect } from "react";
import {
  bootstrapStoredTheme,
  readStoredThemeMode,
  CUSTOM_DARK_START_KEY,
  CUSTOM_LIGHT_START_KEY,
  LEGACY_THEME_KEY,
  MANUAL_THEME_KEY,
  MODE_KEY,
} from "../../pages/home/hooks/themeModeCore";

const THEME_STORAGE_KEYS = new Set([
  MODE_KEY,
  MANUAL_THEME_KEY,
  CUSTOM_LIGHT_START_KEY,
  CUSTOM_DARK_START_KEY,
  LEGACY_THEME_KEY,
]);

const THEME_CLOCK_SYNC_MS = 60_000;

export function useThemeModeRuntime() {
  useEffect(() => {
    const applyStoredTheme = () => {
      bootstrapStoredTheme();
    };
    const applyStoredThemeOnReturn = () => {
      if (document.visibilityState === "visible") applyStoredTheme();
    };
    const applySystemThemeWhenNeeded = () => {
      if (readStoredThemeMode() === "system") applyStoredTheme();
    };
    const applyClockThemeWhenNeeded = () => {
      const mode = readStoredThemeMode();
      if (mode === "auto_custom" || mode === "auto_sunset") applyStoredTheme();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key && !THEME_STORAGE_KEYS.has(event.key)) return;
      applyStoredTheme();
    };

    applyStoredTheme();
    window.addEventListener("pageshow", applyStoredTheme);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", applyStoredThemeOnReturn);
    const clockTimer = window.setInterval(applyClockThemeWhenNeeded, THEME_CLOCK_SYNC_MS);

    const mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (typeof mediaQuery?.addEventListener === "function") {
      mediaQuery.addEventListener("change", applySystemThemeWhenNeeded);
    } else {
      mediaQuery?.addListener?.(applySystemThemeWhenNeeded);
    }

    return () => {
      window.clearInterval(clockTimer);
      window.removeEventListener("pageshow", applyStoredTheme);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", applyStoredThemeOnReturn);
      if (typeof mediaQuery?.removeEventListener === "function") {
        mediaQuery.removeEventListener("change", applySystemThemeWhenNeeded);
      } else {
        mediaQuery?.removeListener?.(applySystemThemeWhenNeeded);
      }
    };
  }, []);
}
