import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("settings home back icon", () => {
  it("uses the downloaded back icon through the shared button", () => {
    const component = readSource("src/pages/shared/HomeBackButton.tsx");
    const pages = [
      "src/pages/ProfilePage.tsx",
      "src/pages/PaymentsPage.tsx",
      "src/pages/SettingsPage.tsx",
      "src/pages/RadioPage.tsx",
    ].map(readSource);

    expect(existsSync(resolve(repoRoot, "src/assets/icons/indietro.png"))).toBe(true);
    expect(component).toContain("../../assets/icons/indietro.png");
    expect(component).toContain("settings-home-icon");
    expect(pages.every((source) => source.includes("<HomeBackButton"))).toBe(true);
    expect(pages.every((source) => !source.includes('className="icon settings-home-icon"'))).toBe(
      true
    );
  });
});
