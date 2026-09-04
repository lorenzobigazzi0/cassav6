import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("settings theme controls", () => {
  it("usa il metodo come selettore diretto senza il toggle automatico separato", () => {
    const source = readFileSync(resolve(repoRoot, "src/pages/SettingsPage.tsx"), "utf8");

    expect(source).not.toContain("Tema Automatico");
    expect(source).toContain('className="settings-ios-row settings-ios-row-method"');
    expect(source).toContain('onClick={() => setMode("auto_sunset")}');
    expect(source).toContain('onClick={() => setMode("auto_custom")}');
  });

  it("mostra soltanto alba e tramonto come dettagli della modalita solare", () => {
    const source = readFileSync(resolve(repoRoot, "src/pages/SettingsPage.tsx"), "utf8");

    expect(source).toContain('{mode === "auto_sunset" && (');
    expect(source).toContain('className="settings-ios-key">Alba');
    expect(source).toContain('className="settings-ios-key">Tramonto');
    expect(source).not.toContain("settings-ios-row-solar");
    expect(source).not.toContain("solar-city-input");
    expect(source).not.toMatch(/Cerca citt/i);
    expect(source).not.toContain('className="settings-ios-key">Posizione');
  });
});
