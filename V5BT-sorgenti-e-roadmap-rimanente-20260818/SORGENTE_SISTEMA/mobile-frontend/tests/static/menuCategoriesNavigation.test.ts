import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readSource(relativePath: string) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("menu navigation", () => {
  it("mostra le categorie come livello iniziale senza passare dai reparti", () => {
    const source = readSource("src/pages/home/menu/MenuWorkspace.tsx");

    expect(source).not.toContain("MenuDepartmentList");
    expect(source).not.toContain('"departments"');
    expect(source).not.toContain("Reparti");
    expect(source).toContain(
      'type MenuStage = "categories" | "products" | "search-results" | "product-detail"'
    );
    expect(source).toContain('if (stage === "categories") return "Categorie"');
    expect(source).toContain('if (stage === "search-results") return "Risultati ricerca"');
  });

  it("non mostra il sottotitolo sotto al titolo dello stage", () => {
    const source = readSource("src/pages/home/menu/MenuWorkspace.tsx");
    const menuStyles = readSource("src/styles/menu.css");
    const glassStyles = readSource("src/styles/glass.css");

    expect(source).not.toContain("menu-stage-subtitle");
    expect(source).not.toContain("stageSubTitle");
    expect(menuStyles).not.toContain(".menu-stage-subtitle");
    expect(glassStyles).not.toContain(".menu-stage-subtitle");
  });

  it("mantiene il reparto nel dettaglio prodotto del menu mobile", () => {
    const source = readSource("src/pages/home/menu/components/MenuProductDetail.tsx");

    expect(source).toContain("departmentName");
    expect(source).toContain("<span>Reparto</span>");
    expect(source).toContain("<span>Categoria</span>");
  });

  it("riporta la lista in alto quando apre una categoria", () => {
    const source = readSource("src/pages/home/menu/MenuWorkspace.tsx");
    const openCategoryHandler = source.slice(
      source.indexOf("const onOpenCategory"),
      source.indexOf("const onOpenProduct")
    );

    expect(openCategoryHandler).toContain("clearMenuProductScrollState();");
    expect(openCategoryHandler).toContain("menuContentRef.current.scrollTop = 0;");
  });

  it("mantiene visibile la freccia indietro nei livelli categoria e dettaglio prodotto", () => {
    const source = readSource("src/pages/home/menu/MenuWorkspace.tsx");
    const styles = readSource("src/styles/menu.css");
    const dashboardOverrides = readSource(
      "legacy-mobile-assets/assets/mobile-home-dashboard-overrides.css"
    );

    expect(source).toContain('const canGoBack = stage !== "categories"');
    expect(source).toContain('className="menu-back-btn"');
    expect(source).toContain('src="/mobile/assets/menu-back-indietro.png"');
    expect(source).toContain('className="menu-back-icon"');
    expect(source).not.toContain("M15 18l-6-6 6-6");
    expect(source).toContain('className="menu-nav-row"');
    expect(styles).toContain(".menu-browser-head .menu-nav-row");
    expect(styles).toContain("display: grid !important");
    expect(styles).toContain("grid-template-columns: 98px minmax(0, 1fr) 98px;");
    expect(styles).toContain(".menu-back-icon");
    expect(styles).toContain("align-items: center;");
    expect(styles).toContain("text-align: center;");
    expect(dashboardOverrides).toContain(".menu-browser-head .menu-nav-row");
    expect(dashboardOverrides).toContain("display: grid !important");
    expect(existsSync(resolve(repoRoot, "public/assets/menu-back-indietro.png"))).toBe(true);
  });
});
