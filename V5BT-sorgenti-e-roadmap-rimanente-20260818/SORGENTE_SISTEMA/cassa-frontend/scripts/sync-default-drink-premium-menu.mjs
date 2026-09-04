#!/usr/bin/env node

import {
  DEFAULT_DRINK_PREMIUM_CONFIG,
  DEFAULT_DRINK_PREMIUM_ITEMS,
  replaceMenuCategoryItems,
} from "../backend/modules/menu/default-menu-catalog.js";

const apiBaseUrl = String(
  process.env.CASSA_API_BASE_URL ?? "http://127.0.0.1:5281",
)
  .trim()
  .replace(/\/$/, "");
const username = String(process.env.CASSA_MENU_SYNC_USERNAME ?? "").trim();
const pin = String(process.env.CASSA_MENU_SYNC_PIN ?? "");
const deviceUuid = `menu-premium-sync-${process.pid}`;
const clientApp = "settings-frontend";

if (!username || !pin) {
  throw new Error(
    "Impostare CASSA_MENU_SYNC_USERNAME e CASSA_MENU_SYNC_PIN prima della sincronizzazione.",
  );
}

async function postJson(pathname, payload) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    const message = String(
      body?.message ?? body?.error ?? response.statusText,
    ).trim();
    throw new Error(`${pathname} ha risposto ${response.status}: ${message}`);
  }
  return body;
}

function validateSavedCatalog(savedItems) {
  const managedIds = new Set(
    DEFAULT_DRINK_PREMIUM_ITEMS.map((item) => item.id),
  );
  const premiumItems = savedItems.filter((item) =>
    managedIds.has(String(item.id)),
  );
  if (premiumItems.length !== DEFAULT_DRINK_PREMIUM_ITEMS.length) {
    throw new Error(
      `Catalogo Premium persistito incompleto: ${premiumItems.length}/${DEFAULT_DRINK_PREMIUM_ITEMS.length}.`,
    );
  }

  const savedById = new Map(
    premiumItems.map((item) => [String(item.id), item]),
  );
  for (const expected of DEFAULT_DRINK_PREMIUM_ITEMS) {
    const actual = savedById.get(expected.id);
    if (!actual) {
      throw new Error(`Articolo Premium non persistito: ${expected.id}.`);
    }
    if (
      actual.name !== expected.name ||
      Number(actual.price) !== Number(expected.price) ||
      actual.section !== expected.section
    ) {
      throw new Error(
        `Articolo Premium persistito con dati diversi: ${expected.id}.`,
      );
    }
  }

  return premiumItems;
}

const login = await postJson("/api/auth/login", {
  username,
  pin,
  deviceUuid,
  clientApp,
});
const auth = {
  token: login.token,
  userId: login.user?.id,
  deviceUuid,
  clientApp,
};
const current = await postJson("/api/settings/menu", auth);
const managedIds = new Set(DEFAULT_DRINK_PREMIUM_ITEMS.map((item) => item.id));
const previousPremiumCount = current.items.filter(
  (item) =>
    item.category === DEFAULT_DRINK_PREMIUM_CONFIG.category ||
    managedIds.has(String(item.id)),
).length;
const nextItems = replaceMenuCategoryItems(
  current.items,
  DEFAULT_DRINK_PREMIUM_ITEMS,
  DEFAULT_DRINK_PREMIUM_CONFIG.category,
);
const expectedTotal =
  current.items.length -
  previousPremiumCount +
  DEFAULT_DRINK_PREMIUM_ITEMS.length;
if (nextItems.length !== expectedTotal) {
  throw new Error(
    `Conteggio catalogo inatteso prima del salvataggio: ${nextItems.length}/${expectedTotal}.`,
  );
}

const saved = await postJson("/api/settings/menu", {
  ...auth,
  items: nextItems,
  menus: current.menus,
  areaMenus: current.areaMenus,
  priceLists: current.priceLists,
  priceListSchedules: current.priceListSchedules,
  menuSchedules: current.menuSchedules,
});
const savedPremiumItems = validateSavedCatalog(saved.items);
const sectionCounts = Object.fromEntries(
  DEFAULT_DRINK_PREMIUM_CONFIG.sections.map((section) => [
    section.name,
    savedPremiumItems.filter((item) => item.section === section.name).length,
  ]),
);
const categoryCounts = Object.fromEntries(
  [...new Set(DEFAULT_DRINK_PREMIUM_ITEMS.map((item) => item.category))].map(
    (category) => [
      category,
      savedPremiumItems.filter((item) => item.category === category).length,
    ],
  ),
);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      apiBaseUrl,
      beforeTotal: current.items.length,
      beforePremium: previousPremiumCount,
      afterTotal: saved.items.length,
      afterPremium: savedPremiumItems.length,
      sectionCounts,
      categoryCounts,
      version: saved.version,
    },
    null,
    2,
  )}\n`,
);
