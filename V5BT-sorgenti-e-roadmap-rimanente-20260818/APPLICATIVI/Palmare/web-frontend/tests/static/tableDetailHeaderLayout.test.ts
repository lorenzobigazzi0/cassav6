import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("table detail header layout", () => {
  it("aumenta del 10% e centra verticalmente la riga del titolo", () => {
    const css = readFileSync(resolve(repoRoot, "src/styles/tables.css"), "utf8");

    expect(css).toMatch(
      /\.table-detail-head\s*\{[^}]*padding:\s*12px;[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/s
    );
    expect(css).toMatch(
      /\.table-detail-title-wrap\s*\{[^}]*height:\s*37\.4px;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s
    );
    expect(css).toMatch(
      /\.table-detail-title-row\s*\{[^}]*height:\s*37\.4px;[^}]*flex-direction:\s*column;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*gap:\s*0;/s
    );
    expect(css).toMatch(
      /\.table-detail-arrival-time\s*\{[^}]*padding:\s*0 8px;[^}]*line-height:\s*1\.1;/s
    );
  });
});
