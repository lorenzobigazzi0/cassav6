import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compactPersonName, ownerDisplayLabel } from "../../postazione/src/personDisplay.js";

const appSource = readFileSync(new URL("../../postazione/src/App.jsx", import.meta.url), "utf8");
const baseCss = readFileSync(new URL("../../postazione/css/base.css", import.meta.url), "utf8");
const layoutCss = readFileSync(new URL("../../postazione/css/layout.css", import.meta.url), "utf8");
const layoutOverridesCss = readFileSync(
  new URL("../../postazione/public/assets/postazione-layout-overrides.css", import.meta.url),
  "utf8",
);

test("[FE][P2] assegnatario comanda mostra nome e iniziale del cognome", () => {
  assert.equal(compactPersonName("Roberto Pratesi"), "Roberto P.");
  assert.equal(compactPersonName("  Anna   Campana  "), "Anna C.");
  assert.equal(compactPersonName("admin"), "admin");
  assert.equal(ownerDisplayLabel({ ownerOperator: "Roberto Pratesi", ownerStation: "BAR-1" }), "Roberto P. - BAR-1");
  assert.equal(ownerDisplayLabel({ ownerOperator: "Roberto Pratesi" }), "-");
});

test("[FE][P2] orario header usa solo ore e minuti accanto alla data", () => {
  assert.match(appSource, /return `\$\{pad2\(d\.getHours\(\)\)\}:\$\{pad2\(d\.getMinutes\(\)\)\}`;/);
  assert.doesNotMatch(appSource, /d\.getSeconds\(\)/);
  assert.match(appSource, /<span className="date-display">\{dateText\}<\/span>\s*<span className="time-display">\{timeText\}<\/span>/);
  assert.match(baseCss, /\.date-display,\s*\.time-display\s*\{[^}]*font-size:\s*1\.8rem;[^}]*font-weight:\s*800;/);
});

test("[FE][P2] lista ordini e ridotta del dieci per cento senza tagliare ombre", () => {
  assert.match(baseCss, /--orders-sidebar-w:\s*clamp\(234px, 22\.5vw, 378px\);/);
  assert.match(baseCss, /--orders-sidebar-w-touch:\s*clamp\(252px, 25\.2vw, 414px\);/);
  assert.match(
    layoutOverridesCss,
    /main\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) minmax\(0, 20%\);/,
  );
  assert.match(layoutCss, /#ordersSidebar \.orders-list\s*\{[^}]*padding:\s*8px 8px 16px;[^}]*margin:\s*-8px -8px -12px;/);
  assert.match(layoutOverridesCss, /#ordersSidebar \.orders-list\s*\{[^}]*padding-right:\s*8px;/);
  assert.match(layoutCss, /#ordersSidebar \.order-card\.selected\s*\{[^}]*box-shadow:/);
});
