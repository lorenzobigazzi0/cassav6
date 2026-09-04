import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { projectRoot } from "./helpers/bridge-env.mjs";

const readSource = (relativePath) => fs.readFile(path.join(projectRoot, relativePath), "utf8");

test("[FE][LISTINO-01] il listino a orario non usa piu hot-cache bridge legacy", async () => {
  const viteConfig = await readSource("mobile-frontend/vite.config.ts");
  const hook = await readSource("mobile-frontend/src/pages/home/menu/hooks/useTimedPricingRefresh.ts");
  const pricing = await readSource("mobile-frontend/src/shared/pricing/productPricing.ts");

  assert.match(viteConfig, /const mobileLegacyBridgeScripts:\s*string\[\]\s*=\s*\[\]/);
  assert.doesNotMatch(viteConfig, /frontend-hot-fetch-cache\.js/);
  assert.match(hook, /useTimedPricingRefresh/);
  assert.match(pricing, /getTimedPricingRefreshDelay/);
});

test("[FE][LISTINO-02] refresh prezzi usa nextPriceChangeAt del backend invece di bucket statici day-night", async () => {
  const hook = await readSource("mobile-frontend/src/pages/home/menu/hooks/useTimedPricingRefresh.ts");
  const pricing = await readSource("mobile-frontend/src/shared/pricing/productPricing.ts");
  const hookTest = await readSource("mobile-frontend/tests/useTimedPricingRefresh.test.tsx");

  assert.match(hook, /getTimedPricingRefreshDelay\(products\)/);
  assert.match(hook, /window\.setTimeout/);
  assert.match(hook, /visibilitychange/);
  assert.match(hook, /focus/);
  assert.match(pricing, /export function getTimedPricingRefreshDelay/);
  assert.match(pricing, /getNextProductPriceChangeAt/);
  assert.match(hookTest, /schedules one refresh shortly after the next price change/);
  assert.doesNotMatch(hook, /day|night|diurno|notturno/i);
});

test("[FE][LISTINO-03] il frontend mostra activePrice ma non calcola il prezzo business da schedule", async () => {
  const pricing = await readSource("mobile-frontend/src/shared/pricing/productPricing.ts");
  const pricingTest = await readSource("mobile-frontend/tests/productPricing.test.ts");

  assert.match(pricing, /activePrice !== undefined/);
  assert.match(pricing, /currentPrice !== undefined/);
  assert.match(pricing, /getSchedules\(input\)/);
  assert.match(pricingTest, /does not calculate a final price from schedule without an explicit active price/);
  assert.match(pricingTest, /prefers activePrice over basePrice/);
});

test("[FE][LISTINO-04] composizione ordine mantiene productId e snapshot prezzo client solo come traccia", async () => {
  const draftPricing = await readSource("mobile-frontend/src/pages/home/tables/orderDraftPricing.ts");
  const composer = await readSource("mobile-frontend/src/pages/home/tables/components/TableOrderComposer.tsx");
  const draftTest = await readSource("mobile-frontend/tests/orderDraftPricing.test.ts");

  assert.match(draftPricing, /productId: isCustom \? undefined : product\?\.id/);
  assert.match(draftPricing, /clientPriceSnapshot/);
  assert.match(composer, /buildOrderDraftSubmit/);
  assert.match(composer, /refreshDraftPricingSnapshots/);
  assert.match(draftTest, /preserves productId and client price snapshot in submit lines/);
  assert.match(draftTest, /leaves custom rows without productId or timed pricing snapshot/);
});

test("[FE][LISTINO-05] payload orders/create propaga productId ma lascia il backend autoritativo sul totale", async () => {
  const tablesApi = await readSource("mobile-frontend/src/api/tables.ts");
  const integrationClient = await readSource("mobile-frontend/src/api/tables/integrationClient.ts");
  const draftTest = await readSource("mobile-frontend/tests/orderDraftPricing.test.ts");

  assert.match(integrationClient, /\/api\/integration\/orders\/create/);
  assert.match(tablesApi, /sendIntegrationOrderCreateRequest/);
  assert.match(tablesApi, /productId/);
  assert.match(tablesApi, /clientPriceSnapshot/);
  assert.match(draftTest, /expect\(result\.total\)\.toBe/);
});

test("[FE][LISTINO-06] prodotti custom/manuali restano compatibili senza productId obbligatorio", async () => {
  const draftPricing = await readSource("mobile-frontend/src/pages/home/tables/orderDraftPricing.ts");
  const draftTest = await readSource("mobile-frontend/tests/orderDraftPricing.test.ts");

  assert.match(draftPricing, /customProductId/);
  assert.match(draftPricing, /customName/);
  assert.match(draftPricing, /customPrice/);
  assert.match(draftTest, /leaves custom rows without productId or timed pricing snapshot/);
});

test("[FE][LISTINO-07] ricerca ordine continua a includere sottocategoria, ingredienti e reparto", async () => {
  const composer = await readSource("mobile-frontend/src/pages/home/tables/components/TableOrderComposer.tsx");
  const searchTest = await readSource("mobile-frontend/tests/static/orderComposerSearchSubcategory.test.ts");

  assert.match(composer, /const productMatchesOrderSearch/);
  assert.match(composer, /getProductIngredients\(product\)\.join\(" "\)/);
  assert.match(composer, /getMenuProductSection\(product\)/);
  assert.match(composer, /categoryName/);
  assert.match(composer, /departmentName/);
  assert.match(searchTest, /sezione, categoria e reparto/);
});

test("[FE][LISTINO-08] prezzo emesso resta congelato sull'ordine anche se cambia fascia prima del pagamento", async () => {
  const emissionPricing = await readSource("mobile-frontend/src/shared/pricing/orderEmissionPricing.ts");
  const emissionTest = await readSource("mobile-frontend/tests/orderEmissionPricing.test.ts");

  assert.match(emissionPricing, /unitFinalPrice/);
  assert.match(emissionTest, /uses unitFinalPrice locked at order emission/);
  assert.match(emissionTest, /does not reprice an emitted order when the later menu price is different/);
});

test("[FE][LISTINO-09] menu e ordine consumano il catalogo runtime del backend", async () => {
  const menuWorkspace = await readSource("mobile-frontend/src/pages/home/menu/MenuWorkspace.tsx");
  const menuApi = await readSource("mobile-frontend/src/api/menu.ts");
  const tablesApi = await readSource("mobile-frontend/src/api/tables.ts");
  const integrationClient = await readSource("mobile-frontend/src/api/tables/integrationClient.ts");

  assert.match(menuApi, /\/api\/integration\/menu/);
  assert.match(menuWorkspace, /fetchMenuCatalog/);
  assert.match(tablesApi, /sendIntegrationOrderCreateRequest/);
  assert.match(integrationClient, /\/api\/integration\/orders\/create/);
});

test("[FE][LISTINO-10] la suite mobile contiene test nativi dedicati al listino temporizzato", async () => {
  const tests = [
    "mobile-frontend/tests/productPricing.test.ts",
    "mobile-frontend/tests/orderDraftPricing.test.ts",
    "mobile-frontend/tests/orderEmissionPricing.test.ts",
    "mobile-frontend/tests/useTimedPricingRefresh.test.tsx",
  ];

  for (const relativePath of tests) {
    const source = await readSource(relativePath);
    assert.ok(source.length > 0, `${relativePath} deve esistere ed essere non vuoto`);
  }
});
