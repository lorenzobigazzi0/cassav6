import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readSource(relativePath: string) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("runtime senza copy mock visibile", () => {
  it("non mostra credenziali o diciture mock nella richiesta cambio sala", () => {
    const source = readSource("src/pages/SettingsPage.tsx");

    expect(source).not.toContain("mock:");
    expect(source).not.toContain("lorenzo / 1234");
    expect(source).toContain("In attesa di autorizzazione da un responsabile.");
  });

  it("non etichetta come mock il fallback al catalogo reale", () => {
    const source = readSource("src/pages/home/menu/MenuWorkspace.tsx");

    expect(source).not.toContain("Fallback mock");
    expect(source).toContain("Fallback al catalogo generale reale");
  });

  it("non espone simulazioni di notifiche nella home produzione", () => {
    const source = readSource("src/pages/home/components/HomeCard.tsx");

    expect(source).toContain("const showSimulationPanel = import.meta.env.DEV");
    expect(source).toContain("{showSimulationPanel && (");
    expect(source).toContain("Simula notifiche in arrivo.");
  });

  it("non usa la coda locale mock delle notifiche in produzione", () => {
    const source = readSource("src/api/notifications.ts");

    expect(source).toContain("const allowLocalNotificationFallback = () => import.meta.env.DEV");
    expect(source).toContain("!sent && allowLocalNotificationFallback()");
    expect(source).toContain("allowLocalNotificationFallback() && queue.length > 0");
    expect(source).toContain('throw new Error("notification-backend-unavailable")');
  });
});
