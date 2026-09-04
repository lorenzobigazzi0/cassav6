import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const componentsCss = readFileSync(
  new URL("../../postazione/css/components.css", import.meta.url),
  "utf8"
);
const appSource = readFileSync(
  new URL("../../postazione/src/App.jsx", import.meta.url),
  "utf8"
);
const indexHtml = readFileSync(
  new URL("../../postazione/index.html", import.meta.url),
  "utf8"
);
const layoutCss = readFileSync(
  new URL("../../postazione/css/layout.css", import.meta.url),
  "utf8"
);
const layoutOverridesCss = readFileSync(
  new URL("../../postazione/public/assets/postazione-layout-overrides.css", import.meta.url),
  "utf8"
);

test("[FE][P2] tema scuro usa stati annullati ad alto contrasto", () => {
  assert.match(
    componentsCss,
    /body\[data-theme="dark"\] \.postazione-cancelled-alert-badge[\s\S]*?background:\s*#b91c1c\s*!important;/
  );
  assert.match(
    componentsCss,
    /body\[data-theme="dark"\] \.detail-view\.postazione-cancelled-detail \.btn-done\.postazione-cancelled-ok[\s\S]*?background:\s*#2563eb\s*!important;[\s\S]*?color:\s*#fff\s*!important;/
  );
});

test("[FE][P2] intestazione comanda mantiene numero a destra", () => {
  assert.match(layoutCss, /\.card-header > \.card-right\s*\{[^}]*margin-left:\s*auto;/);
});

test("[FE][P2] dettaglio arriva fino al bordo della lista comande in ogni stato", () => {
  assert.match(
    layoutOverridesCss,
    /main\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) minmax\(0, 20%\);/
  );
  assert.match(
    appSource,
    /<main\s+className=\{\s*selectedCancelled\s*\?\s*"postazione-cancelled-layout"\s*:\s*undefined\s*\}\s*>/s,
  );
  assert.match(
    layoutOverridesCss,
    /main\.postazione-cancelled-layout\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) minmax\(0, 20%\);/
  );
  assert.match(
    layoutOverridesCss,
    /main\.postazione-cancelled-layout[\s\S]*?#ordersSidebar[\s\S]*?\.order-card\.postazione-cancelled-card\.selected\s*\{[^}]*height:\s*auto;[^}]*flex:\s*1 0 var\(--order-card-min-h\);/
  );
});

test("[FE][P1] React possiede dettaglio e righe della comanda annullata", () => {
  assert.doesNotMatch(indexHtml, /postazione-[^"']*bridge\.js/i);
  assert.match(appSource, /const correctionStateForOrder = \(order\) => \{/);
  assert.match(
    appSource,
    /const selectedCorrectionState = useMemo\(\s*\(\) => correctionStateForOrder\(selected\),\s*\[selected\],?\s*\);/s,
  );
  assert.match(
    appSource,
    /const selectedDetailWatermark = selectedCancelled\s*\?\s*"ANNULLATO"\s*:\s*selectedCorrected\s*\?\s*"MODIFICATO"\s*:\s*undefined;/s,
  );
  assert.match(appSource, /data-state-watermark=\{selectedDetailWatermark\}/);
  assert.doesNotMatch(appSource, /postazione-correction-detail-badge|postazione-cancelled-detail-badge/);
  assert.match(appSource, /selectedCancelled \? " postazione-cancelled-item" : ""/);
});

test("[FE][P2] filigrana stato resta dietro ai dati della detail header", () => {
  assert.match(layoutCss, /\.detail-header\[data-state-watermark\]::before\s*\{[\s\S]*?content:\s*attr\(data-state-watermark\);[\s\S]*?z-index:\s*0;/);
  assert.match(layoutCss, /transform:\s*translate\(-50%, -50%\);/);
  assert.doesNotMatch(layoutCss, /\.detail-header\[data-state-watermark\]::before\s*\{[^}]*rotate\(/);
  assert.match(layoutCss, /\.detail-header\[data-state-watermark\] > div\s*\{[\s\S]*?z-index:\s*1;/);
});

test("[FE][P2] articoli annullati e rimossi hanno diagonale da angolo ad angolo", () => {
  const cornerStripe = /clip-path:\s*polygon\(0 calc\(100% - 4px\), 0 100%, 100% 4px, 100% 0\);/g;
  assert.equal([...layoutCss.matchAll(cornerStripe)].length >= 2, true);
  assert.match(layoutCss, /\.postazione-correction-removed-item::after\s*\{/);
  assert.match(layoutCss, /\.postazione-cancelled-item::after\s*\{/);
  assert.doesNotMatch(layoutCss, /\.postazione-(?:correction-removed|cancelled)-item[^}]*::after\s*\{[^}]*transform:\s*rotate/);
});
