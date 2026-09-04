import test from "node:test";
import assert from "node:assert/strict";
import { apiPost, authPayload, loginJson, readJson, startBackend } from "./helpers/test-server.mjs";

test("[BE][P0] catalogo menu autenticato espone categorie, prodotti e varianti abilitate", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "menu-cashier",
    clientApp: "mobile-frontend",
  });

  const catalog = await apiPost(
    baseUrl,
    "/api/menu/catalog",
    authPayload(cashier, "menu-cashier")
  );

  assert.equal(catalog.response.status, 200);
  assert.equal(catalog.body.ok, true);
  assert.ok(catalog.body.categories.length > 0);
  const coffee = catalog.body.items.find((entry) => entry.id === "menu_caffetteria_caffe");
  assert.equal(coffee?.enabled, true);
  assert.equal(typeof coffee?.price, "number");
  const variantItem = catalog.body.items.find((entry) => Array.isArray(entry.variants) && entry.variants.length > 0);
  assert.ok(variantItem);

  const persisted = await readJson(dbPath);
  assert.equal(persisted.menuItems.some((entry) => entry.id === "menu_caffetteria_caffe"), true);
});

test("[BE][P0] salvataggio menu crea/modifica prodotto e aggiorna audit", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const admin = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "menu-admin",
    clientApp: "cassa-frontend",
  });

  const current = await apiPost(
    baseUrl,
    "/api/settings/menu",
    authPayload(admin, "menu-admin")
  );
  assert.equal(current.response.status, 200);

  const nextItems = current.body.items
    .filter((entry) => entry.id !== "menu_test_limonata")
    .concat({
      id: "menu_test_limonata",
      name: "Limonata Test",
      price: 3.5,
      category: "Bibite",
      enabled: true,
      variants: [{ id: "ice", name: "Con ghiaccio", priceDelta: 0 }],
    });

  const saved = await apiPost(
    baseUrl,
    "/api/settings/menu",
    authPayload(admin, "menu-admin", { items: nextItems })
  );
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.ok, true);
  const savedItem = saved.body.items.find((entry) => entry.id === "menu_test_limonata");
  assert.equal(savedItem.name, "Limonata Test");
  assert.equal(savedItem.price, 3.5);
  assert.deepEqual(savedItem.variants.map((entry) => entry.id), ["ice"]);

  const persisted = await readJson(dbPath);
  const dbItem = persisted.menuItems.find((entry) => entry.id === "menu_test_limonata");
  assert.equal(dbItem.category, "Bibite");
  assert.ok(persisted.auditEvents.some((entry) => entry.action === "menu.item_created"));
});

test("[BE][P0] prodotto disabilitato non compare nel catalogo operativo", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t, {
    stateOverrides(state) {
      state.menuItems.push({
        id: "menu_hidden_test",
        name: "Prodotto Nascosto Test",
        category: "Test",
        price: 9,
        enabled: false,
      });
    },
  });
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "menu-hidden-cashier",
    clientApp: "mobile-frontend",
  });

  const catalog = await apiPost(
    baseUrl,
    "/api/menu/catalog",
    authPayload(cashier, "menu-hidden-cashier")
  );

  assert.equal(catalog.response.status, 200);
  assert.equal(catalog.body.items.some((entry) => entry.id === "menu_hidden_test"), false);

  const persisted = await readJson(dbPath);
  assert.equal(persisted.menuItems.some((entry) => entry.id === "menu_hidden_test"), true);
});
