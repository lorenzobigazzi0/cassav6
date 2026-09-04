import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("dashboard dark mode", () => {
  it("mantiene il numero dei tavoli liberi dello stesso colore degli altri widget", () => {
    const css = readFileSync(resolve(repoRoot, "src/styles/glass.css"), "utf8");

    expect(css).toMatch(
      /:root\[data-theme="dark"\]\s+\.mobile-dashboard-widget\.is-free strong\s*\{[^}]*color:\s*rgba\(245,\s*249,\s*255,\s*0\.98\);/s
    );
  });
});
