import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapStoredTheme,
  resolveStoredEffectiveTheme,
} from "../../src/pages/home/hooks/themeModeCore";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("theme mode bootstrap", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("applies the stored manual theme before route-specific hooks mount", () => {
    window.localStorage.setItem("theme_mode", "manual");
    window.localStorage.setItem("theme_manual_value", "dark");

    bootstrapStoredTheme();

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(window.localStorage.getItem("theme")).toBe("dark");
  });

  it("keeps legacy theme values compatible during bootstrap", () => {
    window.localStorage.setItem("theme", "light");

    bootstrapStoredTheme();

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("resolves automatic custom windows without needing the settings page hook", () => {
    window.localStorage.setItem("theme_mode", "auto_custom");
    window.localStorage.setItem("theme_custom_light_start", "08:00");
    window.localStorage.setItem("theme_custom_dark_start", "20:00");

    expect(resolveStoredEffectiveTheme(new Date(2026, 0, 1, 10, 0))).toBe("light");
    expect(resolveStoredEffectiveTheme(new Date(2026, 0, 1, 21, 0))).toBe("dark");
  });

  it("bootstraps the theme globally instead of mounting a duplicate Radio hook", () => {
    const main = readSource("src/main.tsx");
    const appRuntime = readSource("src/app/AppRuntime.tsx");
    const radioPage = readSource("src/pages/RadioPage.tsx");
    const hook = readSource("src/pages/home/hooks/useThemeMode.ts");
    const core = readSource("src/pages/home/hooks/themeModeCore.ts");

    expect(main).toContain("bootstrapStoredTheme");
    expect(main.indexOf("bootstrapStoredTheme();")).toBeLessThan(
      main.indexOf("await loadRuntimeConfig();")
    );
    expect(appRuntime).toContain("useThemeModeRuntime");
    expect(radioPage).not.toContain("useThemeMode");
    expect(hook).toContain("applyThemeToDocument(effectiveTheme)");
    expect(core).not.toMatch(/window\.localStorage|localStorage\./);
  });
});
