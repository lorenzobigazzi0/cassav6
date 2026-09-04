import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThemeModeRuntime } from "../src/app/runtime/useThemeModeRuntime";

function ThemeRuntimeHarness() {
  useThemeModeRuntime();
  return null;
}

describe("theme mode runtime", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("riapplica il tema salvato su route che non montano useThemeMode", () => {
    window.localStorage.setItem("theme_mode", "manual");
    window.localStorage.setItem("theme_manual_value", "dark");

    render(<ThemeRuntimeHarness />);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    document.documentElement.removeAttribute("data-theme");
    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("sincronizza i temi automatici anche senza passare dalla pagina impostazioni", () => {
    vi.useFakeTimers();
    window.localStorage.setItem("theme_mode", "auto_custom");
    window.localStorage.setItem("theme_custom_light_start", "08:00");
    window.localStorage.setItem("theme_custom_dark_start", "20:00");
    vi.setSystemTime(new Date(2026, 0, 1, 21, 0));

    render(<ThemeRuntimeHarness />);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    vi.setSystemTime(new Date(2026, 0, 2, 10, 0));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });
});
