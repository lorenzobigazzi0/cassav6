import { test, expect } from "./fixtures/app-fixture.mjs";

async function openApp(context, baseUrl, pathName, titlePattern) {
  const page = await context.newPage();
  const sameOriginAssetFailures = [];
  page.on("response", (response) => {
    const url = response.url();
    if (!url.startsWith(baseUrl)) return;
    if (response.status() === 404 && /\.(?:js|css|png|avif|jpg|jpeg|gif)(?:\?|$)/i.test(url)) {
      sameOriginAssetFailures.push(url);
    }
  });

  const response = await page.goto(`${baseUrl}${pathName}`, { waitUntil: "domcontentloaded" });
  expect(response?.status(), pathName).toBe(200);
  await expect(page).toHaveTitle(titlePattern);
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  expect(sameOriginAssetFailures, `${pathName} asset 404`).toEqual([]);
  return page;
}

test("[GUI][P0] frontend statici caricabili in contesti separati", async ({ browser, app }) => {
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const cassaContext = await browser.newContext({
    viewport: { width: 1366, height: 768 },
  });
  const postazioneContext = await browser.newContext({
    viewport: { width: 1024, height: 768 },
  });

  try {
    const [mobilePage, cassaPage, postazionePage, settingsPage] = await Promise.all([
      openApp(mobileContext, app.frontendUrl, "/mobile/", /Mobile Frontend/),
      openApp(cassaContext, app.frontendUrl, "/cassa/", /Cassa Frontend/),
      openApp(postazioneContext, app.frontendUrl, "/postazione/", /Postazione/),
      openApp(cassaContext, app.frontendUrl, "/impostazioni/", /Impostazioni|Settings/i),
    ]);

    await expect(mobilePage.locator("body")).toBeVisible();
    await expect(cassaPage.locator("body")).toBeVisible();
    await expect(postazionePage.locator("body")).toBeVisible();
    await expect(settingsPage.locator("body")).toBeVisible();

    const state = await app.readState();
    expect(state.sessions).toHaveLength(0);
    expect(state.integration.orders).toHaveLength(0);
  } finally {
    await mobileContext.close();
    await cassaContext.close();
    await postazioneContext.close();
  }
});

test("[GUI][P0] login mobile crea sessione backend e resta isolato da cassa/postazione", async ({ browser, app }) => {
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const cassaContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const postazioneContext = await browser.newContext({ viewport: { width: 1024, height: 768 } });

  try {
    const mobilePage = await openApp(mobileContext, app.frontendUrl, "/mobile/", /Mobile Frontend/);
    const cassaPage = await openApp(cassaContext, app.frontendUrl, "/cassa/", /Cassa Frontend/);
    const postazionePage = await openApp(postazioneContext, app.frontendUrl, "/postazione/", /Postazione/);

    await expect(mobilePage.getByRole("heading", { name: /Accedi/i })).toBeVisible();
    await mobilePage.getByPlaceholder("Username").fill("cashier");
    await mobilePage.getByPlaceholder("PIN").fill("2222");
    await mobilePage.getByRole("button", { name: /Entra/i }).click();
    await expect(mobilePage.getByRole("button", { name: /Operatore Cashier Test/i })).toBeVisible({
      timeout: 15_000,
    });

    await expect.poll(async () => (await app.readState()).sessions.length).toBe(1);
    const state = await app.readState();
    expect(state.sessions[0].userId).toBe("u_cashier");
    expect(state.sessions[0].clientApp).toBe("mobile-frontend");
    expect(state.auditEvents.some((entry) => entry.action === "auth.login_success")).toBe(true);

    const [cassaKeys, postazioneKeys] = await Promise.all([
      cassaPage.evaluate(() => Object.keys(window.localStorage)),
      postazionePage.evaluate(() => Object.keys(window.localStorage)),
    ]);
    expect(cassaKeys.join(" ")).not.toContain("u_cashier");
    expect(postazioneKeys.join(" ")).not.toContain("u_cashier");
  } finally {
    await mobileContext.close();
    await cassaContext.close();
    await postazioneContext.close();
  }
});

test("[GUI][P1] browser reali pubblicano e leggono notifiche tramite proxy backend", async ({ browser, app }) => {
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const postazioneContext = await browser.newContext({ viewport: { width: 1024, height: 768 } });

  try {
    const mobilePage = await openApp(mobileContext, app.frontendUrl, "/mobile/", /Mobile Frontend/);
    const postazionePage = await openApp(postazioneContext, app.frontendUrl, "/postazione/", /Postazione/);

    const published = await mobilePage.evaluate(async () => {
      const response = await fetch("/api/integration/notifications/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "general",
          title: "GUI smoke notification",
          description: "Messaggio da browser reale",
          meta: { targetClientApp: "postazione" },
        }),
      });
      return { status: response.status, body: await response.json() };
    });
    expect(published.status).toBe(200);
    expect(published.body.notification.title).toBe("GUI smoke notification");

    const pulled = await postazionePage.evaluate(async () => {
      const response = await fetch(
        "/api/integration/notifications/pull?consumer=gui-postazione&clientApp=postazione"
      );
      return { status: response.status, body: await response.json() };
    });
    expect(pulled.status).toBe(200);
    expect(pulled.body.items.map((entry) => entry.title)).toContain("GUI smoke notification");

    const state = await app.readState();
    const notification = state.integration.notifications.find((entry) => entry.title === "GUI smoke notification");
    expect(notification.deliveredTo).toContain("gui-postazione");
  } finally {
    await mobileContext.close();
    await postazioneContext.close();
  }
});
