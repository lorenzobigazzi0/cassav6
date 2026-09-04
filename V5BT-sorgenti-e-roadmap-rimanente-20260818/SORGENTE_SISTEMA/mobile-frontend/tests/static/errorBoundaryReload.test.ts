import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("error boundary reload fallback", () => {
  it("ricarica la pagina quando l'utente preme Riprova", () => {
    const source = readSource("src/shared/errors/ErrorBoundary.tsx");
    const resetStart = source.indexOf("private reset = () => {");
    const resetEnd = source.indexOf("render() {", resetStart);
    const resetBody = source.slice(resetStart, resetEnd);

    expect(resetBody).toContain("window.location.reload()");
    expect(resetBody.indexOf("window.location.reload()")).toBeLessThan(
      resetBody.indexOf("this.setState({ error: null })")
    );
    expect(source).toContain("Riprova");
  });
});
