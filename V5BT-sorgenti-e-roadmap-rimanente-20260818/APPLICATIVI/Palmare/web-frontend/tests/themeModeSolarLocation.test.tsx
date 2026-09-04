import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThemeMode } from "../src/pages/home/hooks/useThemeMode";

const solarResponse = {
  ok: true,
  json: async () => ({
    status: "OK",
    results: {
      sunrise: "2026-07-15T03:45:00+00:00",
      sunset: "2026-07-15T18:45:00+00:00",
    },
  }),
} as Response;

const setSecureContext = () => {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
};

const setGeolocation = (getCurrentPosition: Geolocation["getCurrentPosition"]) => {
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: { getCurrentPosition },
  });
};

describe("automatic solar theme location", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("theme_mode", "auto_sunset");
    setSecureContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: undefined,
    });
  });

  it("replaces legacy IP coordinates with the device position before loading solar times", async () => {
    window.localStorage.setItem(
      "theme_solar_coordinates",
      JSON.stringify({ lat: 41.9028, lng: 12.4964, source: "ip" })
    );

    const getCurrentPosition = vi.fn<Geolocation["getCurrentPosition"]>((success) => {
      success({
        coords: { latitude: 43.7696, longitude: 11.2558 },
      } as GeolocationPosition);
    });
    setGeolocation(getCurrentPosition);

    const fetchMock = vi.fn(async () => solarResponse);
    vi.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useThemeMode());

    await waitFor(() => {
      expect(result.current.sunCoordinates?.source).toBe("device");
    });

    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("lat=43.7696&lng=11.2558"),
      expect.objectContaining({ cache: "no-store" })
    );
    expect(result.current.sunCoordinates?.updatedAt).toEqual(expect.any(Number));
    unmount();
  });

  it("keeps an explicitly selected city without requesting device location", async () => {
    window.localStorage.setItem(
      "theme_solar_coordinates",
      JSON.stringify({ lat: 45.4642, lng: 9.19, source: "manual" })
    );

    const getCurrentPosition = vi.fn<Geolocation["getCurrentPosition"]>();
    setGeolocation(getCurrentPosition);

    const fetchMock = vi.fn(async () => solarResponse);
    vi.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useThemeMode());

    await waitFor(() => {
      expect(result.current.sunsetStatus).toBe("ready");
    });

    expect(getCurrentPosition).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("lat=45.4642&lng=9.19"),
      expect.objectContaining({ cache: "no-store" })
    );
    unmount();
  });

  it("requests device location when the user explicitly switches to solar mode", async () => {
    window.localStorage.setItem("theme_mode", "auto_custom");
    window.localStorage.setItem(
      "theme_solar_coordinates",
      JSON.stringify({
        lat: 41.9028,
        lng: 12.4964,
        source: "ip",
        updatedAt: Date.now(),
      })
    );

    const getCurrentPosition = vi.fn<Geolocation["getCurrentPosition"]>((success) => {
      success({
        coords: { latitude: 44.4949, longitude: 11.3426 },
      } as GeolocationPosition);
    });
    setGeolocation(getCurrentPosition);

    const fetchMock = vi.fn(async () => solarResponse);
    vi.stubGlobal("fetch", fetchMock);

    const { result, unmount } = renderHook(() => useThemeMode());
    expect(getCurrentPosition).not.toHaveBeenCalled();

    act(() => {
      result.current.setMode("auto_sunset");
    });

    await waitFor(() => {
      expect(result.current.sunCoordinates?.source).toBe("device");
    });

    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("lat=44.4949&lng=11.3426"),
      expect.objectContaining({ cache: "no-store" })
    );
    unmount();
  });
});
