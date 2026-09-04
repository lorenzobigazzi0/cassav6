import { test } from "./fixtures/app-fixture.mjs";
import { openMobileLoggedIn, createOrder, TABLE_5, line, readyOrder, payFreeSplit } from "./helpers/operational-gui.mjs";

test("__inspect order detail states", async ({ browser, app }) => {
  const { context, page } = await openMobileLoggedIn(browser, app);
  try {
    const created = await createOrder(page, {
      table: TABLE_5,
      lines: [
        line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" }),
        line("K Prosecco", 6, 1, { productId: "menu_vino_k_prosecco" }),
      ],
      total: 7.3,
    });
    await page.locator(".bottom-btn").nth(2).click();
    await page.getByRole("button", { name: "Apri dettagli Tavolo 5", exact: true }).click();
    await page.waitForTimeout(1200);
    console.log("OPEN ORDER", await page.locator("body").innerText().then((text) => text.slice(0, 4000)));
    console.log("BUTTONS OPEN", JSON.stringify(await page.locator("button").evaluateAll((nodes) => nodes.slice(-80).map((node) => ({
      text: node.innerText.slice(0, 120),
      aria: node.getAttribute("aria-label"),
      cls: node.className,
    })))));
    await readyOrder(page, created.order.id);
    const overlayText = await page.locator("body").innerText().then((text) => text.slice(0, 2000));
    console.log("READY BODY", overlayText);
    await page.getByRole("button", { name: /Conferma|OK|Chiudi/i }).last().click().catch(() => undefined);
    await page.waitForTimeout(800);
    console.log("READY AFTER CONFIRM", await page.locator("body").innerText().then((text) => text.slice(0, 4000)));
    await payFreeSplit(page, TABLE_5, created.order.id, 7.3);
    await page.waitForTimeout(800);
    console.log("PAID AFTER PAY", await page.locator("body").innerText().then((text) => text.slice(0, 4000)));
  } finally {
    await context.close();
  }
});
