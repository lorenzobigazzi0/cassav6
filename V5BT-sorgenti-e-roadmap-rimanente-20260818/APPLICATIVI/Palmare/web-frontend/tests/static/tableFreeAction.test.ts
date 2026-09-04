import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) =>
  readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("table free action availability", () => {
  it("mostra Libera anche per tavoli occupati senza ordini e prenotati senza conti sospesi", () => {
    const detailPanel = readSource(
      "src/pages/home/tables/components/TableDetailPanel.tsx"
    );

    expect(detailPanel).toContain(
      "const canFree = Boolean(table && !isFree && table.ordersInProgress <= 0 && table.amountDue <= 0)"
    );
    expect(detailPanel).toContain("const showFreeAction = canFree;");
    expect(detailPanel).toContain("(isSeated || isReserved) && (canOrder || canPay || showFreeAction)");
    expect(detailPanel).not.toContain("showFreeAction = Boolean(canFree && hasAnyOrder)");
  });

  it("l'API mobile libera anche una prenotazione se non ci sono ordini o pagamenti aperti", () => {
    const tablesApi = readSource("src/api/tables.ts");
    const freeFunctionStart = tablesApi.indexOf("export async function freeDiningTable");
    expect(freeFunctionStart).toBeGreaterThan(-1);
    const freeFunction = tablesApi.slice(freeFunctionStart, tablesApi.indexOf("export async function moveDiningTable"));

    expect(freeFunction).toContain("table.ordersInProgress > 0 || table.amountDue > 0");
    expect(freeFunction).not.toContain("occupancyState === \"reserved\"");
    expect(freeFunction).toContain("occupancyState: \"free\"");
  });
});
