import { test, expect } from "./fixtures/app-fixture.mjs";

const DEVICE_UUID = "gui-battery-device-001";

async function openMobileAndLogin(context, app) {
  await context.addInitScript((deviceUuid) => {
    window.localStorage.setItem("pos_device_uuid", deviceUuid);
  }, DEVICE_UUID);

  const page = await context.newPage();
  const response = await page.goto(`${app.frontendUrl}/mobile/`, { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(/Mobile Frontend/);
  await page.getByPlaceholder("Username").fill("cashier");
  await page.getByPlaceholder("PIN").fill("2222");
  await page.getByRole("button", { name: /Entra/i }).click();
  await expect(page.getByRole("button", { name: /Operatore Cashier Test/i })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator(".avatar.avatar-connection-ring")).toBeVisible();
  return page;
}

test("[GUI][P1] mobile mostra percentuale batteria, fulmine e led ridotto senza sovrapposizioni", async ({ browser, app }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  let batteryState = { level: 100, charging: true, online: true };

  await context.route("**/api/mobile/battery**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        matched: true,
        stale: false,
        requestedDeviceUuid: DEVICE_UUID,
        device: {
          deviceId: DEVICE_UUID,
          deviceName: "GUI Battery Device",
          ...batteryState,
        },
      }),
    });
  });

  try {
    const page = await openMobileAndLogin(context, app);
    const widget = page.locator(".mobile-battery-widget");
    const percent = page.locator(".mobile-battery-percent");
    const shell = page.locator(".mobile-battery-shell");
    const bolt = page.locator(".mobile-battery-bolt");
    const connectionRing = page.locator(".avatar.avatar-connection-ring");

    await expect(percent).toHaveText("100");
    await expect(widget).toHaveClass(/is-charging/);
    await expect(bolt).toBeVisible();
    await expect(connectionRing).toHaveClass(/avatar-connection-state-online/);

    const geometry = await page.evaluate(() => {
      const widgetEl = document.querySelector(".mobile-battery-widget");
      const percentEl = document.querySelector(".mobile-battery-percent");
      const shellEl = document.querySelector(".mobile-battery-shell");
      const connectionRingEl = document.querySelector(".avatar.avatar-connection-ring");
      const fillEl = document.querySelector(".mobile-battery-fill");
      const box = (element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
      };
      return {
        widget: box(widgetEl),
        percent: box(percentEl),
        shell: box(shellEl),
        fill: box(fillEl),
        connectionRing: box(connectionRingEl),
      };
    });

    expect(geometry.percent.x).toBeGreaterThanOrEqual(geometry.shell.x);
    expect(geometry.percent.right).toBeLessThanOrEqual(geometry.shell.right);
    const widgetOverlapsConnectionRing =
      geometry.widget.x < geometry.connectionRing.right &&
      geometry.widget.right > geometry.connectionRing.x &&
      geometry.widget.y < geometry.connectionRing.bottom &&
      geometry.widget.bottom > geometry.connectionRing.y;
    expect(widgetOverlapsConnectionRing).toBe(false);
    expect(geometry.percent.y).toBeGreaterThanOrEqual(-10);
    expect(geometry.connectionRing.y).toBeGreaterThanOrEqual(-10);
    expect(geometry.fill.right).toBeLessThanOrEqual(geometry.shell.right);
    expect(geometry.connectionRing.width).toBeLessThanOrEqual(56);
    expect(geometry.connectionRing.height).toBeLessThanOrEqual(56);

    batteryState = { level: 15, charging: false, online: true };
    await page.evaluate(() => window.dispatchEvent(new Event("storage")));

    await expect(percent).toHaveText("15");
    await expect(widget).toHaveClass(/is-low/);
    await expect(widget).not.toHaveClass(/is-charging/);
    await expect(bolt).toBeHidden();
  } finally {
    await context.close();
  }
});

test("[GUI][P1] mobile non espone dati batteria di altri device se il device non combacia", async ({ browser, app }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  await context.route("**/api/mobile/battery**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        matched: false,
        requestedDeviceUuid: DEVICE_UUID,
        device: null,
      }),
    });
  });

  try {
    const page = await openMobileAndLogin(context, app);
    const widget = page.locator(".mobile-battery-widget");

    await expect(page.locator(".mobile-battery-percent")).toHaveText("--");
    await expect(widget).toHaveClass(/is-unknown/);
    await expect(widget).not.toHaveClass(/is-charging/);
    await expect(page.locator(".mobile-battery-bolt")).toBeHidden();
  } finally {
    await context.close();
  }
});

test("[GUI][P1] mobile permette override batteria per nome o IP reale del device", async ({ browser, app }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript((deviceUuid) => {
    window.localStorage.setItem("pos_device_uuid", deviceUuid);
  }, DEVICE_UUID);

  const requestedIdentifiers = [];
  await context.route("**/api/mobile/battery**", async (route) => {
    const requestUrl = new URL(route.request().url());
    requestedIdentifiers.push(requestUrl.searchParams.get("deviceUuid"));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        matched: true,
        matchedBy: "device_id",
        requestedDeviceUuid: "Amalia-3",
        device: {
          deviceId: "2d6f3f24-a8da-4644-b6b0-571b2640790b",
          deviceName: "Amalia-3",
          level: 88,
          charging: true,
          online: true,
        },
      }),
    });
  });

  try {
    const page = await context.newPage();
    const response = await page.goto(`${app.frontendUrl}/mobile/?batteryDevice=Amalia-3`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await page.getByPlaceholder("Username").fill("cashier");
    await page.getByPlaceholder("PIN").fill("2222");
    await page.getByRole("button", { name: /Entra/i }).click();

    await expect(page.locator(".mobile-battery-percent")).toHaveText("88");
    await expect(page.locator(".mobile-battery-widget")).toHaveAttribute("title", /Amalia-3/);
    await expect
      .poll(() => requestedIdentifiers.includes("Amalia-3"), { timeout: 5_000 })
      .toBe(true);
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem("pos_battery_device_id")))
      .toBe("Amalia-3");
  } finally {
    await context.close();
  }
});
