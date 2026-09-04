import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) =>
  readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("reservation release decision prompt", () => {
  it("chiede solo a prenotazione arrivata e permette rimando o liberazione manuale", () => {
    const hook = readSource("src/pages/home/tables/hooks/useReservationReleasePrompt.ts");
    const dialog = readSource(
      "src/pages/home/tables/components/TableReservationReleaseDialog.tsx"
    );
    const workspace = readSource("src/pages/home/tables/TablesWorkspace.tsx");

    expect(hook).toContain("const RESERVATION_RELEASE_PROMPT_SNOOZE_MS = 10 * 60_000");
    expect(hook).toContain("if (preview.reservationAt > now) return null");
    expect(dialog).toContain("Rimanda 10 min");
    expect(dialog).toContain("Libera");
    expect(workspace).toContain("freeReservationReleasePromptTable");
    expect(workspace).toContain("TABLE_LAYOUT_SYNC_LOCK_PURPOSE");
  });

  it("non apre il prompt sopra ordini, pagamenti o altre modali operative", () => {
    const workspace = readSource("src/pages/home/tables/TablesWorkspace.tsx");

    expect(workspace).toContain("const canShowReservationReleasePrompt = Boolean");
    expect(workspace).toContain("!orderComposerOpen");
    expect(workspace).toContain("!paymentWizardOpen");
    expect(workspace).toContain("!tableGroupsDialog");
    expect(workspace).toContain("!serviceRecoveryDialog");
    expect(workspace).toContain("!actionBusy");
    expect(workspace).toContain("!tableLockBusy");
  });
});
