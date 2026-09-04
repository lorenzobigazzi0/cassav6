import { promises as fs } from "node:fs";
import { test, expect } from "./fixtures/app-fixture.mjs";
import {
  TABLE_5,
  createOrder,
  line,
  openMobileLoggedIn,
} from "./helpers/operational-gui.mjs";

function currentRomeMinutes() {
  const parts = new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === "hour")?.value) * 60 +
    Number(parts.find((part) => part.type === "minute")?.value);
}

function activeWindow(price) {
  return currentRomeMinutes() < 12 * 60
    ? [{ id: "gui-active", start: "00:00", end: "12:00", price, enabled: true }]
    : [{ id: "gui-active", start: "12:00", end: "23:59", price, enabled: true }];
}

async function addGuiListinoItem(app, { id, name, basePrice, runtimePrice }) {
  const state = JSON.parse(await fs.readFile(app.dbPath, "utf8"));
  const now = new Date().toISOString();
  state.menuItems = (state.menuItems ?? []).filter((item) => item.id !== id);
  state.menuItems.push({
    id,
    name,
    price: basePrice,
    category: "Bevande",
    enabled: true,
    imageUrl: null,
    priceSchedule: activeWindow(runtimePrice),
    createdByUserId: "gui-test",
    createdAt: now,
    updatedAt: now,
  });
  state.meta = state.meta && typeof state.meta === "object" ? state.meta : {};
  state.meta.lastWriteAt = now;
  await fs.writeFile(app.dbPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

test("[GUI][LISTINO-01] browser mobile reale legge dal backend il prezzo runtime del listino", async ({ browser, app }) => {
  const id = "menu_gui_listino_runtime";
  await addGuiListinoItem(app, {
    id,
    name: "GUI Listino Runtime",
    basePrice: 10,
    runtimePrice: 4.5,
  });

  const { context, page } = await openMobileLoggedIn(browser, app, { deviceUuid: "gui-listino-runtime" });
  try {
    const product = await page.evaluate(async (productId) => {
      const response = await fetch("/api/integration/menu");
      const body = await response.json();
      return body.products.find((item) => item.id === productId);
    }, id);
    expect(product.price).toBe(4.5);
    expect(product.basePrice).toBe(10);
    expect(product.currentPriceScheduleId).toBe("gui-active");
  } finally {
    await context.close();
  }
});

test("[GUI][LISTINO-02] ordine da browser reale usa il totale backend anche con totale client vecchio", async ({ browser, app }) => {
  const id = "menu_gui_listino_order";
  await addGuiListinoItem(app, {
    id,
    name: "GUI Listino Ordine",
    basePrice: 12,
    runtimePrice: 5,
  });

  const { context, page } = await openMobileLoggedIn(browser, app, { deviceUuid: "gui-listino-order" });
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      total: 99,
      lines: [
        line("GUI Listino Ordine", 99, 2, {
          productId: id,
          unitPriceApplied: 99,
          lineTotal: 198,
        }),
      ],
    });
    expect(created.order.total).toBe(10);
    expect(created.order.items).toHaveLength(2);
    expect(created.order.items.every((item) => item.unitPriceApplied === 5)).toBe(true);
  } finally {
    await context.close();
  }
});

