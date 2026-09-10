import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/tables.css"), "utf8");

describe("analytics payment pill", () => {
  it("allinea a sinistra icona e testo mantenendo la misura uniforme", () => {
    expect(css).toMatch(
      /\.analytics-kind-pill\.kind-payment\[class\*="method-"\]\s*\{\s*justify-content:\s*flex-start;/
    );
    expect(css).toMatch(
      /\.analytics-kind-pill\.kind-payment\[class\*="method-"\],[\s\S]*?width:\s*132px;[\s\S]*?height:\s*28px;/
    );
  });
});
