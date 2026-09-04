import { test, expect } from "./fixtures/app-fixture.mjs";

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const TABLET_VIEWPORT = { width: 768, height: 1024 };
const DESKTOP_VIEWPORT = { width: 1366, height: 768 };

async function trackedPage(context, baseUrl, pathName, titlePattern) {
  const page = await context.newPage();
  const diagnostics = {
    asset404: [],
    consoleErrors: [],
    failedRequests: [],
    apiErrors: [],
  };

  page.on("console", (message) => {
    if (message.type() === "error") {
      diagnostics.consoleErrors.push(message.text());
    }
  });
  page.on("requestfailed", (request) => {
    diagnostics.failedRequests.push({
      url: request.url(),
      failure: request.failure()?.errorText || "",
    });
  });
  page.on("response", (response) => {
    const url = response.url();
    const status = response.status();
    if (url.startsWith(baseUrl) && status === 404 && /\.(?:js|css|png|avif|jpg|jpeg|gif|svg|woff2?)(?:\?|$)/i.test(url)) {
      diagnostics.asset404.push(url);
    }
    if (url.startsWith(baseUrl) && status >= 500 && url.includes("/api/")) {
      diagnostics.apiErrors.push({ url, status });
    }
  });

  const response = await page.goto(`${baseUrl}${pathName}`, { waitUntil: "domcontentloaded" });
  expect(response?.status(), `${pathName} status`).toBe(200);
  await expect(page).toHaveTitle(titlePattern);
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  return { page, diagnostics };
}

function assertCleanDiagnostics(diagnostics, note = "diagnostics", options = {}) {
  const failedRequests = options.allowAbortedRequests
    ? diagnostics.failedRequests.filter((entry) => entry.failure !== "net::ERR_ABORTED")
    : diagnostics.failedRequests;
  const consoleErrors = options.allowUnauthorizedConsole
    ? diagnostics.consoleErrors.filter((entry) => !/401 \(Unauthorized\)/i.test(entry))
    : diagnostics.consoleErrors;
  expect(diagnostics.asset404, `${note} asset 404`).toEqual([]);
  expect(failedRequests, `${note} request failures`).toEqual([]);
  expect(diagnostics.apiErrors, `${note} api 5xx`).toEqual([]);
  expect(consoleErrors, `${note} console errors`).toEqual([]);
}

async function mobileContext(browser, deviceUuid = `gui-device-${Date.now()}-${Math.random().toString(16).slice(2)}`) {
  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript((uuid) => {
    window.localStorage.setItem("pos_device_uuid", uuid);
  }, deviceUuid);
  return context;
}

async function openMobile(context, app) {
  return trackedPage(context, app.frontendUrl, "/mobile/", /Mobile Frontend/);
}

async function loginMobile(page, username = "cashier", pin = "2222") {
  await page.getByPlaceholder("Username").fill(username);
  await page.getByPlaceholder("PIN").fill(pin);
  await page.getByRole("button", { name: /Entra/i }).click();
  await expect(page.getByRole("button", { name: /Operatore Cashier Test/i })).toBeVisible({
    timeout: 15_000,
  });
}

async function loginMobileWithBatteryMock(browser, app, batteryPayload, deviceUuid = "gui-expanded-battery") {
  const context = await mobileContext(browser, deviceUuid);
  await context.route("**/api/mobile/battery**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(batteryPayload),
    });
  });
  const { page, diagnostics } = await openMobile(context, app);
  await loginMobile(page);
  await expect(page.locator(".mobile-battery-widget")).toBeVisible({ timeout: 10_000 });
  return { context, page, diagnostics };
}

test("[GUI][P1] mobile login mostra form iniziale senza errori asset", async ({ browser, app }) => {
  const context = await mobileContext(browser);
  try {
    const { page, diagnostics } = await openMobile(context, app);
    await expect(page.getByRole("heading", { name: /Accedi/i })).toBeVisible();
    await expect(page.getByPlaceholder("Username")).toBeVisible();
    await expect(page.getByPlaceholder("PIN")).toBeVisible();
    await expect(page.getByRole("button", { name: /Entra/i })).toBeVisible();
    assertCleanDiagnostics(diagnostics, "mobile login");
  } finally {
    await context.close();
  }
});

test("[GUI][P1] mobile rifiuta PIN troppo corto restando sulla schermata login", async ({ browser, app }) => {
  const context = await mobileContext(browser);
  try {
    const { page, diagnostics } = await openMobile(context, app);
    await page.getByPlaceholder("Username").fill("cashier");
    await page.getByPlaceholder("PIN").fill("12");
    await expect(page.getByRole("button", { name: /Entra/i })).toBeDisabled();
    await expect(page.getByRole("heading", { name: /Accedi/i })).toBeVisible();
    assertCleanDiagnostics(diagnostics, "mobile short pin");
  } finally {
    await context.close();
  }
});

test("[GUI][P1] mobile rifiuta credenziali errate senza creare home", async ({ browser, app }) => {
  const context = await mobileContext(browser);
  try {
    const { page, diagnostics } = await openMobile(context, app);
    await page.getByPlaceholder("Username").fill("cashier");
    await page.getByPlaceholder("PIN").fill("9999");
    await page.getByRole("button", { name: /Entra/i }).click();
    await expect(page.getByText(/Credenziali non valide/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Operatore Cashier Test/i })).toHaveCount(0);
    assertCleanDiagnostics(diagnostics, "mobile wrong credentials", { allowUnauthorizedConsole: true });
  } finally {
    await context.close();
  }
});

test("[GUI][P1] mobile login valido salva token, utente e device nel browser", async ({ browser, app }) => {
  const deviceUuid = "gui-expanded-session-device";
  const context = await mobileContext(browser, deviceUuid);
  try {
    const { page, diagnostics } = await openMobile(context, app);
    await loginMobile(page);
    const storage = await page.evaluate(() => ({
      token: window.localStorage.getItem("pos_token"),
      userId: window.localStorage.getItem("pos_user_id"),
      user: window.localStorage.getItem("pos_user"),
      deviceUuid: window.localStorage.getItem("pos_device_uuid"),
    }));
    expect(storage.token).toBeTruthy();
    expect(storage.userId).toBe("u_cashier");
    expect(storage.user).toContain("cashier");
    expect(storage.deviceUuid).toBe(deviceUuid);
    assertCleanDiagnostics(diagnostics, "mobile valid login storage");
  } finally {
    await context.close();
  }
});

test("[GUI][P1] mobile reload mantiene sessione e non torna al login", async ({ browser, app }) => {
  const context = await mobileContext(browser);
  try {
    const { page, diagnostics } = await openMobile(context, app);
    await loginMobile(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: /Operatore Cashier Test/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("heading", { name: /Accedi/i })).toHaveCount(0);
    assertCleanDiagnostics(diagnostics, "mobile reload session", { allowAbortedRequests: true });
  } finally {
    await context.close();
  }
});

test("[GUI][P1] mobile bottom navigation ha cinque tab e cambia tab attivo al click", async ({ browser, app }) => {
  const context = await mobileContext(browser);
  try {
    const { page, diagnostics } = await openMobile(context, app);
    await loginMobile(page);
    const tabs = page.locator(".bottom-btn");
    await expect(tabs).toHaveCount(5);
    for (let index = 0; index < 5; index += 1) {
      await tabs.nth(index).click();
      await expect(tabs.nth(index)).toHaveClass(/is-active/);
    }
    assertCleanDiagnostics(diagnostics, "mobile bottom nav");
  } finally {
    await context.close();
  }
});

test("[GUI][P1] mobile topbar mantiene titolo centrato e bottoni laterali separati", async ({ browser, app }) => {
  const context = await mobileContext(browser);
  try {
    const { page, diagnostics } = await openMobile(context, app);
    await loginMobile(page);
    const layout = await page.evaluate(() => {
      const title = document.querySelector(".topbar-title").getBoundingClientRect();
      const left = document.querySelector(".topbar-left").getBoundingClientRect();
      const right = document.querySelector(".topbar-right").getBoundingClientRect();
      return {
        title,
        left,
        right,
        viewportWidth: window.innerWidth,
      };
    });
    expect(layout.left.right).toBeLessThan(layout.title.x + layout.title.width / 2);
    expect(layout.right.x).toBeGreaterThan(layout.title.x + layout.title.width / 2);
    expect(Math.abs(layout.title.x + layout.title.width / 2 - layout.viewportWidth / 2)).toBeLessThan(5);
    assertCleanDiagnostics(diagnostics, "mobile topbar");
  } finally {
    await context.close();
  }
});

test("[GUI][P1] mobile dashboard card iniziali non si sovrappongono", async ({ browser, app }) => {
  const context = await mobileContext(browser);
  try {
    const { page, diagnostics } = await openMobile(context, app);
    await loginMobile(page);
    const cards = await page.locator(".workspace-item, .workspace-row, .home-card").evaluateAll((items) =>
      items.slice(0, 8).map((item) => {
        const rect = item.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom, right: rect.right };
      })
    );
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.width).toBeGreaterThan(20);
      expect(card.height).toBeGreaterThan(20);
      expect(card.x).toBeGreaterThanOrEqual(0);
      expect(card.right).toBeLessThanOrEqual(MOBILE_VIEWPORT.width + 1);
    }
    assertCleanDiagnostics(diagnostics, "mobile dashboard cards");
  } finally {
    await context.close();
  }
});

test("[GUI][P1] mobile widget batteria verde sopra soglia e con percentuale", async ({ browser, app }) => {
  const { context, page, diagnostics } = await loginMobileWithBatteryMock(browser, app, {
    ok: true,
    matched: true,
    device: {
      deviceId: "gui-expanded-battery",
      deviceName: "Mock Battery",
      level: 80,
      charging: false,
      online: true,
    },
  });
  try {
    await expect(page.locator(".mobile-battery-percent")).toHaveText("80");
    await expect(page.locator(".mobile-battery-widget")).not.toHaveClass(/is-low/);
    await expect(page.locator(".mobile-battery-bolt")).toBeHidden();
    assertCleanDiagnostics(diagnostics, "mobile battery green");
  } finally {
    await context.close();
  }
});

test("[GUI][P1] mobile widget batteria rosso sotto soglia", async ({ browser, app }) => {
  const { context, page, diagnostics } = await loginMobileWithBatteryMock(browser, app, {
    ok: true,
    matched: true,
    device: {
      deviceId: "gui-expanded-battery",
      deviceName: "Mock Battery",
      level: 19,
      charging: false,
      online: true,
    },
  });
  try {
    await expect(page.locator(".mobile-battery-percent")).toHaveText("19");
    await expect(page.locator(".mobile-battery-widget")).toHaveClass(/is-low/);
    assertCleanDiagnostics(diagnostics, "mobile battery red");
  } finally {
    await context.close();
  }
});

test("[GUI][P1] mobile widget mostra fulmine solo se in carica", async ({ browser, app }) => {
  const { context, page, diagnostics } = await loginMobileWithBatteryMock(browser, app, {
    ok: true,
    matched: true,
    device: {
      deviceId: "gui-expanded-battery",
      deviceName: "Mock Battery",
      level: 56,
      charging: true,
      online: true,
    },
  });
  try {
    await expect(page.locator(".mobile-battery-percent")).toHaveText("56");
    await expect(page.locator(".mobile-battery-widget")).toHaveClass(/is-charging/);
    await expect(page.locator(".mobile-battery-bolt")).toBeVisible();
    assertCleanDiagnostics(diagnostics, "mobile battery charging");
  } finally {
    await context.close();
  }
});

test("[GUI][P1] mobile widget batteria non mostra dati quando non c'e match device", async ({ browser, app }) => {
  const { context, page, diagnostics } = await loginMobileWithBatteryMock(browser, app, {
    ok: true,
    matched: false,
    device: null,
  });
  try {
    await expect(page.locator(".mobile-battery-percent")).toHaveText("--");
    await expect(page.locator(".mobile-battery-widget")).toHaveClass(/is-unknown/);
    assertCleanDiagnostics(diagnostics, "mobile battery no match");
  } finally {
    await context.close();
  }
});

test("[GUI][P1] mobile widget batteria non crea duplicati dopo reload", async ({ browser, app }) => {
  const { context, page, diagnostics } = await loginMobileWithBatteryMock(browser, app, {
    ok: true,
    matched: true,
    device: {
      deviceId: "gui-expanded-battery",
      deviceName: "Mock Battery",
      level: 70,
      charging: true,
      online: true,
    },
  });
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".mobile-battery-widget")).toHaveCount(1);
    await expect(page.locator(".mobile-battery-percent")).toHaveText("70", { timeout: 15_000 });
    assertCleanDiagnostics(diagnostics, "mobile battery reload", { allowAbortedRequests: true });
  } finally {
    await context.close();
  }
});

test("[GUI][P1] mobile widget batteria resta tra percentuale e led senza overlap", async ({ browser, app }) => {
  const { context, page, diagnostics } = await loginMobileWithBatteryMock(browser, app, {
    ok: true,
    matched: true,
    device: {
      deviceId: "gui-expanded-battery",
      deviceName: "Mock Battery",
      level: 99,
      charging: true,
      online: true,
    },
  });
  try {
    const geometry = await page.evaluate(() => {
      const box = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right };
      };
      return {
        percent: box(".mobile-battery-percent"),
        shell: box(".mobile-battery-shell"),
        widget: box(".mobile-battery-widget"),
        fill: box(".mobile-battery-fill"),
        status: box(".system-status"),
      };
    });
    expect(geometry.percent).toBeTruthy();
    expect(geometry.shell).toBeTruthy();
    expect(geometry.widget).toBeTruthy();
    expect(geometry.fill).toBeTruthy();
    expect(geometry.status).toBeTruthy();
    expect(geometry.percent.y).toBeGreaterThanOrEqual(-10);
    expect(geometry.widget.y).toBeGreaterThanOrEqual(-10);
    expect(geometry.percent.x).toBeGreaterThanOrEqual(geometry.shell.x);
    expect(geometry.percent.right).toBeLessThanOrEqual(geometry.shell.right);
    expect(geometry.fill.right).toBeLessThanOrEqual(geometry.shell.right);
    expect(geometry.widget.x).toBeGreaterThanOrEqual(geometry.status.x - 1);
    expect(geometry.widget.right).toBeLessThanOrEqual(geometry.status.right + 1);
    assertCleanDiagnostics(diagnostics, "mobile battery geometry");
  } finally {
    await context.close();
  }
});

test("[GUI][P1] mobile fetch proxy pubblico /api/flags funziona dal browser", async ({ browser, app }) => {
  const context = await mobileContext(browser);
  try {
    const { page, diagnostics } = await openMobile(context, app);
    const flags = await page.evaluate(async () => {
      const response = await fetch("/api/flags");
      return { status: response.status, body: await response.json() };
    });
    expect(flags.status).toBe(200);
    expect(flags.body.allowTransferWaiting).toBe(false);
    assertCleanDiagnostics(diagnostics, "mobile flags proxy");
  } finally {
    await context.close();
  }
});

test("[GUI][P1] mobile endpoint protetto city-search resta protetto dal browser anonimo", async ({ browser, app }) => {
  const context = await mobileContext(browser);
  try {
    const { page, diagnostics } = await openMobile(context, app);
    const result = await page.evaluate(async () => {
      const response = await fetch("/api/city-search?q=Roma");
      return { status: response.status };
    });
    expect(result.status).toBe(401);
    assertCleanDiagnostics(diagnostics, "mobile protected city search", { allowUnauthorizedConsole: true });
  } finally {
    await context.close();
  }
});

test("[GUI][P1] postazione carica senza asset 404 e senza console error", async ({ browser, app }) => {
  const context = await browser.newContext({ viewport: TABLET_VIEWPORT });
  try {
    const { page, diagnostics } = await trackedPage(context, app.frontendUrl, "/postazione/", /Postazione/);
    await expect(page.locator("body")).toBeVisible();
    assertCleanDiagnostics(diagnostics, "postazione load");
  } finally {
    await context.close();
  }
});

test("[GUI][P1] postazione puo leggere stati postazioni attive dal browser", async ({ browser, app }) => {
  const context = await browser.newContext({ viewport: TABLET_VIEWPORT });
  try {
    const { page, diagnostics } = await trackedPage(context, app.frontendUrl, "/postazione/", /Postazione/);
    const active = await page.evaluate(async () => {
      const response = await fetch("/api/integration/stations/active");
      return { status: response.status, body: await response.json() };
    });
    expect(active.status).toBe(200);
    expect(active.body.ok).toBe(true);
    expect(Array.isArray(active.body.stations)).toBe(true);
    assertCleanDiagnostics(diagnostics, "postazione active stations");
  } finally {
    await context.close();
  }
});

test("[GUI][P1] postazione puo pubblicare e ricevere notifica da browser", async ({ browser, app }) => {
  const context = await browser.newContext({ viewport: TABLET_VIEWPORT });
  try {
    const { page, diagnostics } = await trackedPage(context, app.frontendUrl, "/postazione/", /Postazione/);
    const title = `GUI expanded ${Date.now()}`;
    const publish = await page.evaluate(async (notificationTitle) => {
      const response = await fetch("/api/integration/notifications/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "general",
          title: notificationTitle,
          description: "Expanded GUI notification",
          meta: { targetClientApp: "postazione" },
        }),
      });
      return { status: response.status, body: await response.json() };
    }, title);
    expect(publish.status).toBe(200);
    const pull = await page.evaluate(async () => {
      const response = await fetch("/api/integration/notifications/pull?consumer=expanded-gui&clientApp=postazione");
      return { status: response.status, body: await response.json() };
    });
    expect(pull.status).toBe(200);
    expect(pull.body.items.map((item) => item.title)).toContain(title);
    assertCleanDiagnostics(diagnostics, "postazione notifications");
  } finally {
    await context.close();
  }
});

test("[GUI][P1] cassa carica senza asset 404 e senza console error", async ({ browser, app }) => {
  const context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
  try {
    const { page, diagnostics } = await trackedPage(context, app.frontendUrl, "/cassa/", /Cassa Frontend/);
    await expect(page.locator("body")).toBeVisible();
    assertCleanDiagnostics(diagnostics, "cassa load");
  } finally {
    await context.close();
  }
});

test("[GUI][P1] impostazioni carica senza asset 404 e senza console error", async ({ browser, app }) => {
  const context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
  try {
    const { page, diagnostics } = await trackedPage(context, app.frontendUrl, "/impostazioni/", /Impostazioni|Settings/i);
    await expect(page.locator("body")).toBeVisible();
    assertCleanDiagnostics(diagnostics, "impostazioni load");
  } finally {
    await context.close();
  }
});

test("[GUI][P1] cassa e postazione non ricevono localStorage del login mobile", async ({ browser, app }) => {
  const mobile = await mobileContext(browser, "gui-expanded-isolation");
  const desktop = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
  try {
    const { page: mobilePage, diagnostics: mobileDiagnostics } = await openMobile(mobile, app);
    await loginMobile(mobilePage);
    const { page: cassaPage, diagnostics: cassaDiagnostics } = await trackedPage(desktop, app.frontendUrl, "/cassa/", /Cassa Frontend/);
    const { page: postazionePage, diagnostics: postazioneDiagnostics } = await trackedPage(desktop, app.frontendUrl, "/postazione/", /Postazione/);
    const [cassaKeys, postazioneKeys] = await Promise.all([
      cassaPage.evaluate(() => Object.keys(window.localStorage).sort()),
      postazionePage.evaluate(() => Object.keys(window.localStorage).sort()),
    ]);
    expect(cassaKeys.join(" ")).not.toContain("u_cashier");
    expect(postazioneKeys.join(" ")).not.toContain("u_cashier");
    assertCleanDiagnostics(mobileDiagnostics, "isolation mobile");
    assertCleanDiagnostics(cassaDiagnostics, "isolation cassa");
    assertCleanDiagnostics(postazioneDiagnostics, "isolation postazione");
  } finally {
    await mobile.close();
    await desktop.close();
  }
});

test("[GUI][P1] tablet mobile mantiene layout dentro viewport", async ({ browser, app }) => {
  const context = await browser.newContext({
    viewport: TABLET_VIEWPORT,
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(() => window.localStorage.setItem("pos_device_uuid", "gui-expanded-tablet"));
  try {
    const { page, diagnostics } = await openMobile(context, app);
    await loginMobile(page);
    const overflow = await page.evaluate(() => ({
      bodyScrollWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      bottomButtons: document.querySelectorAll(".bottom-btn").length,
      statusVisible: Boolean(document.querySelector(".system-status .mobile-battery-widget")),
    }));
    expect(overflow.bodyScrollWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);
    expect(overflow.bottomButtons).toBe(5);
    expect(overflow.statusVisible).toBe(true);
    assertCleanDiagnostics(diagnostics, "tablet mobile layout");
  } finally {
    await context.close();
  }
});
