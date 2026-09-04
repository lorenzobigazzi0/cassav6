import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("waiter pause card visual contract", () => {
  it("usa icone play/stop nel pulsante e non mostra il messaggio pausa", () => {
    const source = readSource("src/pages/home/components/WaiterPauseCard.tsx");
    const css = readSource("src/styles/glass.css");

    expect(source).toContain("const WaiterPauseActionIcon");
    expect(source).toContain("<WaiterPauseActionIcon active={pauseActive} />");
    expect(source).toContain('pauseActive ? "STOP" : "AVVIA"');
    expect(source).not.toContain('"STOP PAUSA"');
    expect(source).not.toContain('"AVVIA PAUSA"');
    expect(source).toContain('active ? <path d="M7 6h10v12H7z" />');
    expect(source).toContain('<path d="M8 5v14l11-7z" />');
    expect(source).not.toContain("waiter-pause-message");
    expect(css).toContain(".waiter-pause-action-icon");
    expect(css).toMatch(
      /\.waiter-pause-action-icon\s*\{[\s\S]*?width:\s*68px;[\s\S]*?height:\s*68px;/
    );
    expect(css).not.toContain(".waiter-pause-message");
  });
});
