import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../../../api/baseUrl";
import {
  readLocalPreference,
  removeLocalPreference,
  writeLocalPreference,
} from "../../../shared/storage/preferenceStorage";
import {
  applyThemeToDocument,
  CUSTOM_DARK_START_KEY,
  CUSTOM_LIGHT_START_KEY,
  isDarkByWindow,
  MANUAL_THEME_KEY,
  MODE_KEY,
  readStoredCustomDarkStart,
  readStoredCustomLightStart,
  readStoredManualTheme,
  readStoredThemeMode,
  resolveSystemDarkPreference,
  shouldRefreshAutomaticSunCoordinates,
  SUN_COORDINATES_KEY,
  SUNSET_DARK_START_FALLBACK,
  SUNSET_LIGHT_START_FALLBACK,
  type ManualTheme,
  type SunCoordinates,
  type SunLocationSource,
  type SunsetStatus,
  type ThemeMode,
} from "./themeModeCore";

const GEO_PERMISSION_DENIED = 1;
const GEO_POSITION_UNAVAILABLE = 2;
const GEO_TIMEOUT = 3;
const GEOLOCATION_RESOLUTION_TIMEOUT_MS = 18000;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const parseStoredCoordinates = (): SunCoordinates | null => {
  const raw = readLocalPreference(SUN_COORDINATES_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<SunCoordinates>;
    if (
      typeof parsed.lat !== "number" ||
      !Number.isFinite(parsed.lat) ||
      typeof parsed.lng !== "number" ||
      !Number.isFinite(parsed.lng)
    ) {
      return null;
    }

    const source: SunLocationSource =
      parsed.source === "manual" || parsed.source === "device" || parsed.source === "ip"
        ? parsed.source
        : "ip";
    const updatedAt =
      typeof parsed.updatedAt === "number" &&
      Number.isFinite(parsed.updatedAt) &&
      parsed.updatedAt > 0
        ? parsed.updatedAt
        : null;

    return {
      lat: clamp(parsed.lat, -90, 90),
      lng: clamp(parsed.lng, -180, 180),
      source,
      ...(updatedAt !== null ? { updatedAt } : {}),
    };
  } catch {
    return null;
  }
};

const toHHMM = (date: Date) => {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
};

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timeoutId: number | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
};

const fetchSunTimesByCoords = async (lat: number, lng: number) => {
  const res = await fetch(`https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lng}&formatted=0`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("sun-api-failed");
  const data = (await res.json()) as {
    status?: string;
    results?: { sunrise?: string; sunset?: string };
  };
  if (data.status !== "OK" || !data.results?.sunrise || !data.results?.sunset) {
    throw new Error("sun-api-invalid");
  }

  return {
    lightStart: toHHMM(new Date(data.results.sunrise)),
    darkStart: toHHMM(new Date(data.results.sunset)),
  };
};

const fetchCoordsFromIp = async () => {
  const token = readLocalPreference("pos_token") || "";
  const userId = readLocalPreference("pos_user_id") || "";
  const deviceUuid = readLocalPreference("pos_device_uuid") || "";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (userId) headers["X-User-Id"] = userId;
  if (deviceUuid) headers["X-Device-Uuid"] = deviceUuid;

  const response = await apiFetch("/api/ip-coords", { cache: "no-store", headers });
  if (!response.ok) throw new Error("ip-api-failed");
  const data = (await response.json()) as { lat?: number; lng?: number };
  if (typeof data.lat !== "number" || typeof data.lng !== "number") {
    throw new Error("ip-api-invalid");
  }
  return { lat: data.lat, lng: data.lng };
};

const getCoordsFromGeolocation = () =>
  new Promise<{ lat: number; lng: number }>((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("geo-not-supported"));
      return;
    }
    if (!window.isSecureContext) {
      reject(new Error("geo-insecure-context"));
      return;
    }

    const onSuccess = (pos: GeolocationPosition) => {
      resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    };

    const onFailure = (error?: GeolocationPositionError) => {
      if (error?.code === GEO_PERMISSION_DENIED) {
        reject(new Error("geo-denied"));
        return;
      }
      if (error?.code === GEO_POSITION_UNAVAILABLE) {
        reject(new Error("geo-unavailable"));
        return;
      }
      if (error?.code === GEO_TIMEOUT) {
        reject(new Error("geo-timeout"));
        return;
      }
      reject(new Error("geo-error"));
    };

    const lowAccuracyFallback = (error?: GeolocationPositionError) => {
      if (error?.code === GEO_PERMISSION_DENIED) {
        onFailure(error);
        return;
      }
      navigator.geolocation.getCurrentPosition(onSuccess, onFailure, {
        enableHighAccuracy: false,
        timeout: 6000,
        maximumAge: 1000 * 60 * 5,
      });
    };

    navigator.geolocation.getCurrentPosition(onSuccess, (error) => lowAccuracyFallback(error), {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    });
  });

export function useThemeMode() {
  const [mode, setModeState] = useState<ThemeMode>(readStoredThemeMode);
  const [manualTheme, setManualTheme] = useState<ManualTheme>(readStoredManualTheme);
  const [customLightStart, setCustomLightStart] = useState(readStoredCustomLightStart);
  const [customDarkStart, setCustomDarkStart] = useState(readStoredCustomDarkStart);
  const [systemDark, setSystemDark] = useState(resolveSystemDarkPreference);
  const [now, setNow] = useState(() => new Date());
  const [sunsetLightStart, setSunsetLightStart] = useState(SUNSET_LIGHT_START_FALLBACK);
  const [sunsetDarkStart, setSunsetDarkStart] = useState(SUNSET_DARK_START_FALLBACK);
  const [sunsetStatus, setSunsetStatus] = useState<SunsetStatus>("loading");
  const [sunCoordinates, setSunCoordinatesState] = useState<SunCoordinates | null>(() =>
    parseStoredCoordinates()
  );
  const sunCoordinatesRef = useRef(sunCoordinates);
  sunCoordinatesRef.current = sunCoordinates;
  const previousModeRef = useRef(mode);
  const usesTimeWindowTheme = mode === "auto_sunset" || mode === "auto_custom";

  useEffect(() => {
    if (!usesTimeWindowTheme) return undefined;

    let minuteIntervalId: number | undefined;
    let alignTimeoutId: number | undefined;

    const tick = () => setNow(new Date());
    const alignToMinute = () => {
      const msToNextMinute = 60000 - (Date.now() % 60000);
      alignTimeoutId = window.setTimeout(() => {
        tick();
        minuteIntervalId = window.setInterval(tick, 60000);
      }, msToNextMinute);
    };

    // Keep theme clock synchronized with exact minute boundaries.
    tick();
    alignToMinute();

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      if (alignTimeoutId !== undefined) window.clearTimeout(alignTimeoutId);
      if (minuteIntervalId !== undefined) window.clearInterval(minuteIntervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [usesTimeWindowTheme]);

  const updateSolarTimes = async (
    coords: { lat: number; lng: number },
    source: SunLocationSource
  ): Promise<boolean> => {
    const lat = clamp(coords.lat, -90, 90);
    const lng = clamp(coords.lng, -180, 180);
    setSunsetStatus("loading");

    try {
      const sunTimes = await withTimeout(fetchSunTimesByCoords(lat, lng), 3500);
      setSunsetLightStart(sunTimes.lightStart);
      setSunsetDarkStart(sunTimes.darkStart);
      setSunCoordinatesState({ lat, lng, source, updatedAt: Date.now() });
      setSunsetStatus("ready");
      return true;
    } catch {
      setSunsetStatus("unavailable");
      return false;
    }
  };

  const setSunCoordinates = async (coords: { lat: number; lng: number }) => {
    return updateSolarTimes(coords, "manual");
  };

  const useDeviceCoordinates = async () => {
    try {
      const coords = await withTimeout(
        getCoordsFromGeolocation(),
        GEOLOCATION_RESOLUTION_TIMEOUT_MS
      );
      return updateSolarTimes(coords, "device");
    } catch (geoError) {
      if (
        geoError instanceof Error &&
        (geoError.message === "geo-denied" ||
          geoError.message === "geo-insecure-context" ||
          geoError.message === "geo-not-supported")
      ) {
        throw geoError;
      }
      try {
        const fallbackCoords = await withTimeout(fetchCoordsFromIp(), 3500);
        return updateSolarTimes(fallbackCoords, "ip");
      } catch {
        throw geoError;
      }
    }
  };

  useEffect(() => {
    const enteredSolarMode = previousModeRef.current !== "auto_sunset";
    previousModeRef.current = mode;

    if (mode !== "auto_sunset") {
      setSunsetStatus("unavailable");
      return undefined;
    }

    let active = true;

    const loadSunsetFromInternet = async () => {
      setSunsetStatus("loading");
      try {
        const currentSunCoordinates = sunCoordinatesRef.current;
        const cachedCoords = currentSunCoordinates
          ? {
              lat: clamp(currentSunCoordinates.lat, -90, 90),
              lng: clamp(currentSunCoordinates.lng, -180, 180),
              source: currentSunCoordinates.source,
              ...(currentSunCoordinates.updatedAt !== undefined
                ? { updatedAt: currentSunCoordinates.updatedAt }
                : {}),
            }
          : null;
        let coords = cachedCoords;

        if (enteredSolarMode || shouldRefreshAutomaticSunCoordinates(cachedCoords, Date.now())) {
          try {
            coords = {
              ...(await withTimeout(getCoordsFromGeolocation(), GEOLOCATION_RESOLUTION_TIMEOUT_MS)),
              source: "device" as SunLocationSource,
              updatedAt: Date.now(),
            };
          } catch {
            try {
              coords = {
                ...(await withTimeout(fetchCoordsFromIp(), 3500)),
                source: "ip" as SunLocationSource,
                updatedAt: Date.now(),
              };
            } catch {
              coords = cachedCoords;
            }
          }
        }

        if (!coords) throw new Error("solar-coordinates-unavailable");
        const sunTimes = await withTimeout(fetchSunTimesByCoords(coords.lat, coords.lng), 3500);

        if (!active) return;
        setSunsetLightStart(sunTimes.lightStart);
        setSunsetDarkStart(sunTimes.darkStart);
        setSunCoordinatesState({
          lat: coords.lat,
          lng: coords.lng,
          source: coords.source,
          ...(coords.updatedAt !== undefined ? { updatedAt: coords.updatedAt } : {}),
        });
        setSunsetStatus("ready");
      } catch {
        if (!active) return;
        setSunsetStatus("unavailable");
      }
    };

    void loadSunsetFromInternet();
    return () => {
      active = false;
    };
  }, [mode]);

  useEffect(() => {
    if (!sunCoordinates) {
      removeLocalPreference(SUN_COORDINATES_KEY);
      return;
    }
    writeLocalPreference(SUN_COORDINATES_KEY, JSON.stringify(sunCoordinates));
  }, [sunCoordinates]);

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    const legacy = mq as MediaQueryList & {
      addListener?: (listener: (ev: MediaQueryListEvent) => void) => void;
      removeListener?: (listener: (ev: MediaQueryListEvent) => void) => void;
    };
    legacy.addListener?.(onChange);
    return () => legacy.removeListener?.(onChange);
  }, []);

  useEffect(() => {
    writeLocalPreference(MODE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    writeLocalPreference(MANUAL_THEME_KEY, manualTheme);
  }, [manualTheme]);

  useEffect(() => {
    writeLocalPreference(CUSTOM_LIGHT_START_KEY, customLightStart);
  }, [customLightStart]);

  useEffect(() => {
    writeLocalPreference(CUSTOM_DARK_START_KEY, customDarkStart);
  }, [customDarkStart]);

  const effectiveTheme = useMemo(() => {
    if (mode === "manual") return manualTheme;
    if (mode === "auto_sunset") {
      if (sunsetStatus !== "ready") {
        return isDarkByWindow(now, customLightStart, customDarkStart) ? "dark" : "light";
      }
      return isDarkByWindow(now, sunsetLightStart, sunsetDarkStart) ? "dark" : "light";
    }
    if (mode === "auto_custom") {
      return isDarkByWindow(now, customLightStart, customDarkStart) ? "dark" : "light";
    }
    return systemDark ? "dark" : "light";
  }, [
    mode,
    manualTheme,
    now,
    customLightStart,
    customDarkStart,
    systemDark,
    sunsetStatus,
    sunsetLightStart,
    sunsetDarkStart,
  ]);

  useEffect(() => {
    applyThemeToDocument(effectiveTheme);
  }, [effectiveTheme]);

  const isDark = effectiveTheme === "dark";

  const setTheme = (next: "system" | "light" | "dark") => {
    if (next === "system") {
      setModeState("system");
      return;
    }
    setManualTheme(next);
    setModeState("manual");
  };

  const setMode = (next: ThemeMode) => {
    setModeState(next);
  };

  return {
    mode,
    setMode,
    theme: effectiveTheme,
    manualTheme,
    setManualTheme,
    customLightStart,
    customDarkStart,
    sunsetLightStart,
    sunsetDarkStart,
    sunCoordinates,
    sunsetStatus,
    sunsetAvailable: sunsetStatus === "ready",
    setSunCoordinates,
    useDeviceCoordinates,
    setCustomLightStart,
    setCustomDarkStart,
    setTheme,
    isDark,
  };
}
