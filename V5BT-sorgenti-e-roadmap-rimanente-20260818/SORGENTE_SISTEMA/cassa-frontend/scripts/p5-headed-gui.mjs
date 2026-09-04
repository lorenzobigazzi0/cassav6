import { promises as fs } from "node:fs";
import path from "node:path";

import { createExpectedInterruptionRequestTracker } from "./p5-expected-interruption.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createDiagnostics(kind, index) {
  return {
    kind,
    index,
    requests: 0,
    requestsByRoute: {},
    requestFailures: 0,
    expectedRequestFailures: 0,
    responses4xx: 0,
    expected4xx: 0,
    expectedConflicts: 0,
    responses5xx: 0,
    expected5xx: 0,
    consoleErrors: 0,
    expectedConsoleErrors: 0,
    interactions: 0,
    touchTaps: 0,
    longPresses: 0,
    reloads: 0,
    disconnects: 0,
    consoleErrorSamples: [],
    requestFailureSamples: [],
    responseErrorSamples: [],
  };
}

export function resetP5GuiRequestTraffic(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") {
    throw new TypeError("diagnostics deve essere un oggetto.");
  }
  diagnostics.requests = 0;
  diagnostics.requestsByRoute = {};
  return diagnostics;
}

function attachDiagnostics(context, page, diagnostics, isExpectedInterruption) {
  let expectedConsoleCredits = 0;
  let expectedConsoleCreditsExpireAt = 0;
  const interruptionRequests = createExpectedInterruptionRequestTracker(isExpectedInterruption);
  context.on("request", (request) => {
    diagnostics.requests += 1;
    try {
      const pathname = new URL(request.url()).pathname;
      const route = `${request.method().toUpperCase()} ${pathname}`;
      diagnostics.requestsByRoute[route] = (diagnostics.requestsByRoute[route] || 0) + 1;
    } catch {
      // Le URL non HTTP restano nel totale, ma non nel budget per route.
    }
    interruptionRequests.observe(request);
  });
  context.on("requestfailed", (request) => {
    const errorText = String(request.failure()?.errorText || "request-failed");
    const expected =
      isExpectedInterruption() ||
      interruptionRequests.includes(request) ||
      /ERR_ABORTED/i.test(errorText);
    if (expected) {
      diagnostics.expectedRequestFailures += 1;
      return;
    }
    diagnostics.requestFailures += 1;
    if (diagnostics.requestFailureSamples.length >= 12) return;
    let pathname = "";
    try {
      pathname = new URL(request.url()).pathname;
    } catch {
      pathname = "";
    }
    diagnostics.requestFailureSamples.push({
      at: new Date().toISOString(),
      method: request.method(),
      pathname,
      errorText,
    });
  });
  context.on("response", (response) => {
    const status = response.status();
    const request = response.request();
    let pathname = "";
    try {
      pathname = new URL(response.url()).pathname;
    } catch {
      pathname = "";
    }
    const expectedConflict = status === 409 && pathname === "/api/integration/orders/sync";
    const expected =
      ((isExpectedInterruption() || interruptionRequests.includes(request)) && status >= 400) ||
      expectedConflict;
    if (expected && status >= 500) {
      diagnostics.expected5xx += 1;
      expectedConsoleCredits += 1;
      expectedConsoleCreditsExpireAt = Date.now() + 5_000;
    } else if (status >= 500) diagnostics.responses5xx += 1;
    else if (expected) {
      diagnostics.expected4xx += 1;
      if (expectedConflict) diagnostics.expectedConflicts += 1;
      expectedConsoleCredits += 1;
      expectedConsoleCreditsExpireAt = Date.now() + 5_000;
    }
    else if (status >= 400) diagnostics.responses4xx += 1;
    if (status >= 400 && !expected && diagnostics.responseErrorSamples.length < 12) {
      const headers = request.headers();
      let payload = null;
      try {
        payload = JSON.parse(request.postData() || "null");
      } catch {
        payload = null;
      }
      diagnostics.responseErrorSamples.push({
        at: new Date().toISOString(),
        status,
        url: response.url(),
        method: request.method(),
        auth: {
          authorization: Boolean(headers.authorization),
          userId: headers["x-user-id"] || String(payload?.userId ?? ""),
          deviceUuid: headers["x-device-uuid"] || String(payload?.deviceUuid ?? ""),
          bodyToken: Boolean(payload?.token),
        },
      });
    }
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (
      isExpectedInterruption() &&
      /ERR_INTERNET_DISCONNECTED|Failed to fetch|Failed to load resource/i.test(message.text())
    ) {
      diagnostics.expectedConsoleErrors += 1;
      return;
    }
    if (expectedConsoleCredits > 0 && Date.now() > expectedConsoleCreditsExpireAt) {
      expectedConsoleCredits = 0;
    }
    if (
      expectedConsoleCredits > 0 &&
      /Failed to load resource.*(?:401|403|409|502|503|504)/i.test(message.text())
    ) {
      expectedConsoleCredits -= 1;
      diagnostics.expectedConsoleErrors += 1;
      return;
    }
    diagnostics.consoleErrors += 1;
    if (diagnostics.consoleErrorSamples.length < 12) {
      diagnostics.consoleErrorSamples.push(message.text());
    }
  });
}

async function visible(locator) {
  return locator.isVisible().catch(() => false);
}

async function screenshot(page, targetPath) {
  await page.screenshot({ path: targetPath, fullPage: true }).catch(() => undefined);
}

export async function longPressLocator(locator, durationMs = 2_100) {
  if (!(await visible(locator))) return false;
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  const box = await locator.boundingBox();
  if (!box) return false;
  const page = locator.page();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  try {
    await sleep(Math.max(2_000, durationMs));
  } finally {
    await page.mouse.up();
  }
  return true;
}

async function touchTap(locator) {
  if (!(await visible(locator))) return false;
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  const box = await locator.boundingBox();
  if (!box) return false;
  await locator.page().touchscreen.tap(
    box.x + box.width / 2,
    box.y + box.height / 2,
  );
  return true;
}

function mobileAuthSeed(session) {
  return {
    token: session.token,
    userId: session.user.id,
    username: session.user.username,
    fullName: session.user.fullName,
    role: session.user.role,
    roleLabel: session.user.roleLabel,
    permissions: Array.isArray(session.user.permissions) ? session.user.permissions : [],
    allowedPaymentMethodIds: Array.isArray(session.user.allowedPaymentMethodIds)
      ? session.user.allowedPaymentMethodIds
      : [],
    sessionStartedAt: Date.now(),
    deviceUuid: session.deviceUuid,
    roomId: "room_pedana",
    roomName: "Pedana",
  };
}

async function installMobileAuth(context, session) {
  await context.addInitScript((auth) => {
    const values = {
      pos_token: auth.token,
      pos_user_id: auth.userId,
      pos_user: auth.username,
      pos_full_name: auth.fullName,
      pos_role: auth.role,
      pos_role_label: auth.roleLabel,
      pos_permissions: JSON.stringify(auth.permissions),
      pos_allowed_payment_method_ids: JSON.stringify(auth.allowedPaymentMethodIds),
      pos_session_started_at: String(auth.sessionStartedAt),
      pos_device_uuid: auth.deviceUuid,
      pos_room_id: auth.roomId,
      pos_room_name: auth.roomName,
      pos_selected_room_id: auth.roomId,
      pos_selected_room_name: auth.roomName,
    };
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (const [key, value] of Object.entries(values)) {
        storage.setItem(key, String(value ?? ""));
      }
    }
  }, mobileAuthSeed(session));
}

async function verifyMobileSession(page) {
  return page.evaluate(async () => {
    const read = (key) => window.localStorage.getItem(key) || window.sessionStorage.getItem(key) || "";
    const token = read("pos_token");
    const userId = read("pos_user_id");
    const deviceUuid = read("pos_device_uuid");
    if (!token || !userId || !deviceUuid) return { valid: false, status: 0, reason: "storage" };
    try {
      const response = await window.fetch("/api/auth/session/status", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token, userId, deviceUuid, clientApp: "mobile-frontend" }),
      });
      const body = await response.json().catch(() => null);
      return {
        valid: response.status === 200 && body?.ok === true && body?.valid === true,
        status: response.status,
        reason: body?.error || body?.code || null,
      };
    } catch (error) {
      return { valid: false, status: 0, reason: error instanceof Error ? error.message : "network" };
    }
  });
}

function stationAuthSeed(session, stationName, apiBase) {
  return {
    apiBase,
    stationName,
    auth: {
      token: session.token,
      userId: session.user.id,
      username: session.user.username,
      fullName: session.user.fullName,
      roleLabel: session.user.roleLabel,
      deviceUuid: session.deviceUuid,
    },
  };
}

async function installStationAuth(context, session, stationName, apiBase) {
  await context.addInitScript(({ apiBase: origin, auth, stationName: station }) => {
    window.localStorage.setItem("postazione_device_uuid", JSON.stringify(auth.deviceUuid));
    window.localStorage.setItem("BAR_POSTAZIONE_STATION_V1", JSON.stringify(station));
    window.localStorage.setItem("BAR_API_BASE_URL", JSON.stringify(origin));
    window.API_BASE = origin;
  }, stationAuthSeed(session, stationName, apiBase));
}

async function readStationAuth(page) {
  return page.evaluate(() => {
    for (const storage of [window.sessionStorage, window.localStorage]) {
      try {
        const value = JSON.parse(storage.getItem("BAR_OPERATOR_AUTH_V1") || "null");
        if (value?.token) return value;
      } catch {
        // Prova lo storage successivo.
      }
    }
    return null;
  });
}

function normalizeStationUiLabel(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

export function resolveStationWorkstationOptionIndex(options, stationName) {
  const target = normalizeStationUiLabel(stationName);
  if (!target || !Array.isArray(options)) return -1;
  return options.findIndex((option) =>
    [option?.stationName, option?.name].some(
      (candidate) => normalizeStationUiLabel(candidate) === target,
    ),
  );
}

async function waitForStationLoginEntry(page, timeoutMs = 15_000) {
  await page.waitForFunction(
    () => {
      const isVisibleElement = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      return [
        document.querySelector(".launch-btn"),
        document.querySelector('input[placeholder="Utente"]'),
      ].some(isVisibleElement);
    },
    null,
    { timeout: timeoutMs },
  );
}

async function waitForStationInitialLoginState(page, timeoutMs = 15_000) {
  const handle = await page.waitForFunction(
    () => {
      const isVisibleElement = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      if (isVisibleElement(document.querySelector(".logout-btn"))) return "operational";
      if (
        isVisibleElement(
          document.querySelector(
            '[role="dialog"][aria-labelledby="workstation-login-title"]',
          ),
        )
      ) {
        return "workstation";
      }
      if (isVisibleElement(document.querySelector('input[placeholder="Utente"]'))) {
        return "form";
      }
      if (isVisibleElement(document.querySelector(".launch-btn"))) return "launcher";
      return "";
    },
    null,
    { timeout: timeoutMs },
  );
  return handle.jsonValue();
}

async function waitForStationPostLoginState(page, timeoutMs = 25_000) {
  const handle = await page.waitForFunction(
    () => {
      const isVisibleElement = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      if (isVisibleElement(document.querySelector(".logout-btn"))) return "operational";
      if (
        isVisibleElement(
          document.querySelector(
            '[role="dialog"][aria-labelledby="workstation-login-title"]',
          ),
        )
      ) {
        return "workstation";
      }
      return "";
    },
    null,
    { timeout: timeoutMs },
  );
  return handle.jsonValue();
}

async function waitForStationOperational(page, stationName, timeoutMs = 25_000) {
  const target = normalizeStationUiLabel(stationName);
  await page.waitForFunction(
    (expectedStation) => {
      const logout = document.querySelector(".logout-btn");
      if (!(logout instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(logout);
      const rect = logout.getBoundingClientRect();
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        rect.width <= 0 ||
        rect.height <= 0
      ) {
        return false;
      }
      const readJsonStorage = (key) => {
        for (const storage of [window.sessionStorage, window.localStorage]) {
          try {
            const parsed = JSON.parse(storage.getItem(key) || "null");
            if (parsed !== null && parsed !== undefined) return parsed;
          } catch {
            // Prova lo storage successivo.
          }
        }
        return null;
      };
      const auth = readJsonStorage("BAR_OPERATOR_AUTH_V1");
      const selectedStation = readJsonStorage("BAR_POSTAZIONE_STATION_V1");
      const normalize = (value) =>
        String(value || "")
          .trim()
          .toUpperCase()
          .replace(/\s+/g, " ");
      return (
        Boolean(auth?.token) &&
        normalize(selectedStation) === expectedStation
      );
    },
    target,
    { timeout: timeoutMs },
  );
  const auth = await readStationAuth(page);
  if (!auth?.token) {
    throw new Error("Token postazione assente dopo l'apertura della UI operativa.");
  }
  return auth;
}

async function selectStationWorkstationViaUi(page, stationName) {
  const dialog = page.locator(
    '[role="dialog"][aria-labelledby="workstation-login-title"]',
  );
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const optionLocator = dialog.locator(".workstation-login-option");
  const hasOptions = await optionLocator
    .first()
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!hasOptions) {
    const emptyMessage = await dialog
      .locator(".workstation-login-empty")
      .textContent()
      .catch(() => "");
    throw new Error(
      String(emptyMessage || "Nessuna postazione abilitata per l'utente.").trim(),
    );
  }

  const options = await optionLocator.evaluateAll((nodes) =>
    nodes.map((node) => ({
      name: String(
        node.querySelector(".workstation-login-option-copy > strong")?.textContent || "",
      ).trim(),
      stationName: String(
        node.querySelector(".workstation-login-option-copy > span")?.textContent || "",
      ).trim(),
    })),
  );
  const targetIndex = resolveStationWorkstationOptionIndex(options, stationName);
  if (targetIndex < 0) {
    const available = options
      .map((option) => option.stationName || option.name)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Postazione target ${stationName} non disponibile nella lista abilitata${
        available ? ` (${available})` : ""
      }.`,
    );
  }

  const selectResponsePromise = page.waitForResponse(
    (response) => {
      try {
        return (
          new URL(response.url()).pathname === "/api/auth/workstation/select" &&
          response.request().method() === "POST"
        );
      } catch {
        return false;
      }
    },
    { timeout: 20_000 },
  );
  const [response] = await Promise.all([
    selectResponsePromise,
    optionLocator.nth(targetIndex).click({ timeout: 5_000 }),
  ]);
  const payload = await response.json().catch(() => null);
  if (!response.ok() || payload?.ok !== true) {
    throw new Error(
      `Selezione postazione fallita (${response.status()}): ${
        payload?.error || "risposta non valida"
      }.`,
    );
  }
  const selected = payload?.selectedWorkstation || payload?.workstation || {};
  if (
    normalizeStationUiLabel(selected.stationName || selected.station) !==
    normalizeStationUiLabel(stationName)
  ) {
    throw new Error("La risposta di selezione non conferma la postazione target.");
  }
  return {
    id: String(selected.id || "").trim(),
    name: String(selected.name || "").trim(),
    stationName: String(selected.stationName || selected.station || "").trim(),
  };
}

async function verifyStationAuthCleared(page) {
  let lastError = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => undefined);
      return await page.evaluate(() => (
        !window.localStorage.getItem("BAR_OPERATOR_AUTH_V1") &&
        !window.sessionStorage.getItem("BAR_OPERATOR_AUTH_V1")
      ));
    } catch (error) {
      lastError = error;
      await sleep(350);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "errore sconosciuto");
  throw new Error(`Verifica storage postazione non completata dopo il logout: ${detail}`);
}

function isLogoutResponse(response) {
  try {
    return new URL(response.url()).pathname === "/api/auth/logout";
  } catch {
    return false;
  }
}

async function stationLogoutFailureContext(page, responsePromises, requestFailures) {
  const responses = (await Promise.allSettled(responsePromises))
    .filter((entry) => entry.status === "fulfilled")
    .map((entry) => entry.value);
  const ui = await page.evaluate(() => ({
    apiBase: String(window.API_BASE || ""),
    authStored: Boolean(
      window.localStorage.getItem("BAR_OPERATOR_AUTH_V1") ||
      window.sessionStorage.getItem("BAR_OPERATOR_AUTH_V1")
    ),
    confirmVisible: Boolean(document.querySelector('[data-logout-action="confirm"]')),
    launchVisible: Boolean(document.querySelector(".launch-btn")),
    loginFormVisible: Boolean(document.querySelector('input[placeholder="Utente"]')),
    workstationDialogVisible: Boolean(
      document.querySelector(
        '[role="dialog"][aria-labelledby="workstation-login-title"]',
      ),
    ),
    logoutVisible: Boolean(document.querySelector(".logout-btn")),
    toast: String(document.querySelector(".toast.show")?.textContent || "").trim(),
  })).catch(() => ({ unavailable: true }));
  return { responses, requestFailures, ui };
}

async function confirmStationLogout(page) {
  let lastError = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const entryVisible = await waitForStationLoginEntry(page, 250)
      .then(() => true)
      .catch(() => false);
    if (entryVisible) return;
    const confirm = page.locator('[data-logout-action="confirm"]');
    try {
      const confirmVisible = await confirm.isVisible().catch(() => false);
      if (!confirmVisible) {
        const logout = page.locator(".logout-btn");
        await logout.waitFor({ state: "visible", timeout: 1_000 });
        await logout.click({ timeout: 2_000 });
      }
      await confirm.waitFor({ state: "visible", timeout: 1_500 });
      await confirm.click({ timeout: 2_000 });
      const completed = await waitForStationLoginEntry(page, 3_000)
        .then(() => true)
        .catch(() => false);
      if (completed) return;
      lastError = new Error("La conferma logout non ha aperto la schermata di accesso.");
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  const detail = lastError instanceof Error
    ? lastError.message
    : String(lastError ?? "conferma non disponibile");
  throw new Error(`Conferma logout postazione non completata: ${detail}`);
}

async function loginStationViaUi({ page, session, pin, longPressMs, stationName }) {
  let lastError = null;
  let longPresses = 0;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => undefined);
      await clearBlockingDialogs(page);
      let state = await waitForStationInitialLoginState(page);
      if (state === "operational") {
        const auth = await waitForStationOperational(page, stationName);
        return { auth, longPresses, flow: "existing", targetBound: true };
      }
      if (state === "workstation") {
        const selectedWorkstation = await selectStationWorkstationViaUi(page, stationName);
        const auth = await waitForStationOperational(page, stationName);
        return {
          auth,
          longPresses,
          flow: "two-stage-resume",
          selectedWorkstation,
          targetBound: true,
        };
      }
      const username = page.getByPlaceholder("Utente");
      const pinInput = page.getByPlaceholder("PIN");
      if (state === "launcher") {
        const launch = page.locator(".launch-btn");
        if (!(await longPressLocator(launch, longPressMs))) {
          throw new Error("Pressione prolungata AVVIA postazione non eseguita.");
        }
        longPresses += 1;
      }
      await username.waitFor({ state: "visible", timeout: 8_000 });
      await username.fill(session.user.username);
      await pinInput.waitFor({ state: "visible", timeout: 8_000 });
      await pinInput.fill(pin);
      const loginResponsePromise = page.waitForResponse(
        (response) => {
          try {
            return (
              new URL(response.url()).pathname === "/api/auth/login" &&
              response.request().method() === "POST"
            );
          } catch {
            return false;
          }
        },
        { timeout: 20_000 },
      );
      const [loginResponse] = await Promise.all([
        loginResponsePromise,
        page.getByRole("button", { name: /^Accedi$/ }).click(),
      ]);
      const loginPayload = await loginResponse.json().catch(() => null);
      if (!loginResponse.ok() || loginPayload?.ok !== true || !loginPayload?.token) {
        throw new Error(
          `Login reale postazione fallito (${loginResponse.status()}): ${
            loginPayload?.error || "risposta non valida"
          }.`,
        );
      }

      state = await waitForStationPostLoginState(page);
      const selectionRequired =
        loginPayload.workstationSelectionRequired === true ||
        (loginPayload.workstationSelectionRequired == null &&
          Array.isArray(loginPayload.availableWorkstations) &&
          loginPayload.availableWorkstations.length > 0);
      if (state === "operational" && selectionRequired) {
        throw new Error(
          "Il login richiede la scelta postazione, ma la modale non e stata mostrata.",
        );
      }
      let selectedWorkstation = null;
      let flow = "legacy";
      if (state === "workstation") {
        selectedWorkstation = await selectStationWorkstationViaUi(page, stationName);
        flow = "two-stage";
      }
      const auth = await waitForStationOperational(page, stationName);
      return {
        auth,
        longPresses,
        flow,
        selectedWorkstation,
        targetBound: true,
      };
    } catch (error) {
      lastError = error;
      await page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => undefined);
      await sleep(450);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "errore sconosciuto");
  throw new Error(`Login GUI postazione non completato dopo 4 tentativi: ${detail}`);
}

async function clearBlockingDialogs(page) {
  let cleared = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const selectors = [
      '.call-overlay:visible .call-confirm:visible',
      '.call-overlay:visible .call-close:visible',
      '.postazione-pause-transfer-btn.keep[data-choice="suspend"]:visible',
    ];
    let handled = false;
    for (const selector of selectors) {
      const button = page.locator(selector).first();
      if (!(await visible(button))) continue;
      await button.click({ force: true, timeout: 3_000 });
      await sleep(100);
      cleared += 1;
      handled = true;
      break;
    }
    if (!handled) break;
  }
  return cleared;
}

async function clickExposedPoint(locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  const box = await locator.boundingBox();
  if (!box) return false;
  const page = locator.page();
  for (const xRatio of [0.2, 0.5, 0.8]) {
    for (const yRatio of [0.2, 0.5, 0.8]) {
      const x = box.x + box.width * xRatio;
      const y = box.y + box.height * yRatio;
      const exposed = await locator.evaluate((element, point) => {
        const top = document.elementFromPoint(point.x, point.y);
        return top === element || Boolean(top && element.contains(top));
      }, { x, y }).catch(() => false);
      if (!exposed) continue;
      await page.mouse.click(x, y);
      return true;
    }
  }
  return false;
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await visible(locator))) continue;
    try {
      await locator.click({ timeout: 2_000 });
    } catch (error) {
      const cleared = await clearBlockingDialogs(page);
      if (cleared > 0) {
        await locator.click({ timeout: 5_000 });
      } else if (!(await clickExposedPoint(locator))) {
        await locator.focus();
        await page.keyboard.press("Enter");
      }
    }
    return selector;
  }
  return null;
}

export async function createP5MobileGuiController({
  browser,
  index,
  session,
  frontendBaseUrl,
  evidenceDir,
  totalActions = 1_000,
  longPressMs = 2_100,
  networkOutageMs = 60_000,
  onCoverage = () => undefined,
  onComplete = () => undefined,
}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await installMobileAuth(context, session);
  const page = await context.newPage();
  const diagnostics = createDiagnostics("mobile-p5-headed", index);
  let expectedInterruption = false;
  let outageDone = false;
  let longPressEvidenceDone = false;
  let tablesCounterEvidenceDone = false;
  let actionCount = 0;
  const startedAt = Date.now();
  attachDiagnostics(context, page, diagnostics, () => expectedInterruption);
  await fs.mkdir(evidenceDir, { recursive: true });
  await page.goto(`${frontendBaseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
  await page.locator(".bottom-btn").first().waitFor({ state: "visible", timeout: 25_000 });
  const initialSession = await verifyMobileSession(page);
  onCoverage("gui.mobile_session_initial", initialSession.valid, {
    device: index + 1,
    status: initialSession.status,
    reason: initialSession.reason,
  });
  if (!initialSession.valid) {
    throw new Error(`Sessione GUI mobile ${index + 1} non valida all'avvio (${initialSession.status}).`);
  }
  await screenshot(page, path.join(evidenceDir, `mobile-${index + 1}-start.png`));

  async function simulateOutage() {
    expectedInterruption = true;
    diagnostics.disconnects += 1;
    const started = Date.now();
    await context.setOffline(true);
    await sleep(networkOutageMs);
    await context.setOffline(false);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    diagnostics.reloads += 1;
    const recovered = await page.locator(".bottom-btn").first()
      .waitFor({ state: "visible", timeout: 25_000 })
      .then(() => true)
      .catch(() => false);
    const sessionStatus = recovered
      ? await verifyMobileSession(page)
      : { valid: false, status: 0, reason: "frontend" };
    if (recovered) {
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    }
    expectedInterruption = false;
    onCoverage("network.mobile_disconnect_reconnect", recovered && sessionStatus.valid, {
      device: index + 1,
      offlineMs: Date.now() - started,
      sessionStatus: sessionStatus.status,
      sessionReason: sessionStatus.reason,
    });
    if (!recovered || !sessionStatus.valid) {
      throw new Error(
        `GUI mobile ${index + 1} non recuperata dopo il blackout (sessione ${sessionStatus.status}).`,
      );
    }
  }

  return {
    page,
    diagnostics,
    resetRequestTraffic() {
      resetP5GuiRequestTraffic(diagnostics);
    },
    async performTablesCounterSwitch(ordinal) {
      await page.bringToFront();
      diagnostics.interactions += await clearBlockingDialogs(page);
      const tablesButton = await clickFirstVisible(page, [
        '.bottom-btn[aria-label="TAVOLI"]',
        '.bottom-btn[aria-label="BANCO"]',
      ]);
      if (!tablesButton) {
        throw new Error("Navigazione TAVOLI/BANCO non disponibile nella GUI mobile.");
      }
      const title = page.locator(".topbar-title.is-long-pressable").first();
      await title.waitFor({ state: "visible", timeout: 10_000 });
      const before = String(await title.textContent()).trim().toUpperCase();
      const pressed = await longPressLocator(title, longPressMs);
      if (pressed) diagnostics.longPresses += 1;
      const changed = await page.waitForFunction(
        ({ previous }) => {
          const value = String(document.querySelector(".topbar-title")?.textContent ?? "")
            .trim()
            .toUpperCase();
          return (value === "TAVOLI" || value === "BANCO") && value !== previous;
        },
        { previous: before },
        { timeout: 5_000 },
      ).then(() => true).catch(() => false);
      const after = String(await page.locator(".topbar-title").first().textContent())
        .trim()
        .toUpperCase();
      const ok = pressed && changed && ["TAVOLI", "BANCO"].includes(before) &&
        ["TAVOLI", "BANCO"].includes(after) && before !== after;
      if (ok && !tablesCounterEvidenceDone) {
        tablesCounterEvidenceDone = true;
        await screenshot(page, path.join(evidenceDir, `mobile-${index + 1}-tables-counter.png`));
      }
      diagnostics.interactions += 1;
      onCoverage("gui.mobile.tables_counter_switch", ok, {
        device: index + 1,
        ordinal,
        before,
        after,
      });
      if (!ok) throw new Error(`Cambio TAVOLI/BANCO non riuscito (${before} -> ${after}).`);
      return { kind: "tables-counter-switch", ok, before, after };
    },
    async performAction(ordinal) {
      await page.bringToFront();
      actionCount += 1;
      diagnostics.interactions += await clearBlockingDialogs(page);
      if (!outageDone && ordinal >= Math.ceil(totalActions * 0.62)) {
        outageDone = true;
        await simulateOutage();
        diagnostics.interactions += 1;
        return { kind: "network-reconnect", ok: true };
      }

      const variant = (actionCount + index * 3) % 8;
      let kind = "mobile-navigation";
      let ok = false;
      if (variant === 0) {
        kind = "touch-bottom-navigation";
        const buttons = page.locator(".bottom-btn");
        const count = await buttons.count();
        if (count > 0) ok = await touchTap(buttons.nth(ordinal % count));
        if (ok) diagnostics.touchTaps += 1;
      } else if (variant === 1) {
        kind = "search-from-first-character";
        const search = page.locator('input[type="search"]:visible').first();
        if (await visible(search)) {
          await search.fill(ordinal % 2 ? "k " : "prosecco");
          ok = true;
        } else {
          ok = Boolean(await clickFirstVisible(page, ['.bottom-btn[aria-label="MENU"]', '.bottom-btn[aria-label="BANCO"]']));
        }
      } else if (variant === 2) {
        kind = "favorite-real-click";
        const selector = await clickFirstVisible(page, [
          'button[aria-label*="prefer" i]:visible',
          'button[title*="prefer" i]:visible',
          'button[aria-label*="vendut" i]:visible',
          '.bottom-btn[aria-label="MENU"]',
        ]);
        ok = Boolean(selector);
      } else if (variant === 3) {
        kind = "radio-real-long-press";
        const target = page.locator(".bottom-bar").first();
        ok = await longPressLocator(target, longPressMs);
        if (ok) {
          diagnostics.longPresses += 1;
          if (!longPressEvidenceDone) {
            longPressEvidenceDone = true;
            await screenshot(page, path.join(evidenceDir, `mobile-${index + 1}-long-press.png`));
          }
        }
      } else if (variant === 4) {
        kind = "statistics-navigation";
        ok = Boolean(await clickFirstVisible(page, [
          '.bottom-btn[aria-label="STATISTICHE"]',
          '.bottom-btn[aria-label="TAVOLI"]',
          '.bottom-btn',
        ]));
      } else if (variant === 5) {
        kind = "modal-open-close";
        const opened = await clickFirstVisible(page, [
          '.mobile-analytics-payment-row-native:visible',
          'button[aria-label*="impost" i]:visible',
          '.bottom-btn[aria-label="PRENOTAZIONI"]',
        ]);
        if (opened) {
          await clickFirstVisible(page, [
            '.modal-card:visible button[aria-label="Chiudi"]',
            '.mobile-analytics-detail-close:visible',
            'button[aria-label="Chiudi"]:visible',
          ]).catch(() => undefined);
          ok = true;
        }
      } else if (variant === 6) {
        kind = "reload-session-retained";
        await page.reload({ waitUntil: "domcontentloaded" });
        diagnostics.reloads += 1;
        const frontendRecovered = await page.locator(".bottom-btn").first()
          .waitFor({ state: "visible", timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        const sessionStatus = frontendRecovered
          ? await verifyMobileSession(page)
          : { valid: false, status: 0 };
        ok = frontendRecovered && sessionStatus.valid;
      } else {
        kind = "real-scroll";
        await page.mouse.wheel(0, ordinal % 2 ? 520 : -520);
        ok = true;
      }
      diagnostics.interactions += 1;
      onCoverage(`gui.mobile.${kind}`, ok, { device: index + 1, ordinal });
      if (!ok) throw new Error(`Interazione GUI mobile non eseguita: ${kind}.`);
      return { kind, ok };
    },
    async close() {
      await page.bringToFront().catch(() => undefined);
      await screenshot(page, path.join(evidenceDir, `mobile-${index + 1}-end.png`));
      const result = { ...diagnostics, durationMs: Date.now() - startedAt, deviceUuid: session.deviceUuid };
      onComplete(result);
      await context.close();
      return result;
    },
  };
}

export async function createP5StationGuiController({
  browser,
  index = 0,
  session,
  stationName,
  frontendBaseUrl,
  evidenceDir,
  totalActions = 1_000,
  longPressMs = 2_100,
  networkOutageMs = 60_000,
  logoutMs = 600_000,
  pin = "2222",
  onCoverage = () => undefined,
  onSessionAuth = () => undefined,
  onBeforeLogout = () => undefined,
  onAfterLogin = () => undefined,
  onComplete = () => undefined,
}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await installStationAuth(context, session, stationName, frontendBaseUrl);
  const page = await context.newPage();
  const diagnostics = createDiagnostics("station-p5-headed", index);
  let expectedInterruption = false;
  let logoutDone = false;
  let outageDone = false;
  let longPressEvidenceDone = false;
  let actionCount = 0;
  const startedAt = Date.now();
  attachDiagnostics(context, page, diagnostics, () => expectedInterruption);
  await fs.mkdir(evidenceDir, { recursive: true });
  await page.goto(`${frontendBaseUrl}/postazione/`, { waitUntil: "domcontentloaded" });
  const logout = page.locator(".logout-btn");
  const hasActiveSession = await logout.waitFor({ state: "visible", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!hasActiveSession) {
    const login = await loginStationViaUi({
      page,
      session,
      pin,
      longPressMs,
      stationName,
    });
    diagnostics.longPresses += login.longPresses;
    diagnostics.interactions += login.longPresses;
    longPressEvidenceDone = login.longPresses > 0;
    await onSessionAuth(login.auth);
    await onAfterLogin(login.auth);
    onCoverage("gui.station_workstation_target_bound", login.targetBound === true, {
      stationName,
      flow: login.flow,
    });
    onCoverage("gui.station_real_initial_login", true, { stationName });
    if (longPressEvidenceDone) {
      await screenshot(page, path.join(evidenceDir, "station-1-long-press.png"));
    }
  }
  await screenshot(page, path.join(evidenceDir, "station-1-start.png"));

  async function logoutAndLogin() {
    expectedInterruption = true;
    const responsePromises = [];
    const requestFailures = [];
    const onResponse = (response) => {
      if (!isLogoutResponse(response) || responsePromises.length >= 8) return;
      responsePromises.push((async () => ({
        status: response.status(),
        url: response.url(),
        body: String(await response.text().catch(() => "")).slice(0, 500),
      }))());
    };
    const onRequestFailed = (request) => {
      try {
        if (new URL(request.url()).pathname !== "/api/auth/logout" || requestFailures.length >= 8) return;
        requestFailures.push({
          url: request.url(),
          error: String(request.failure()?.errorText || "request-failed"),
        });
      } catch {
        // Ignora URL non validi: non appartengono al flusso logout.
      }
    };
    page.on("response", onResponse);
    page.on("requestfailed", onRequestFailed);
    try {
      await onBeforeLogout();
      await sleep(250);
      diagnostics.interactions += await clearBlockingDialogs(page);
      await page.locator(".logout-btn").click();
      await confirmStationLogout(page);
      await waitForStationLoginEntry(page, 45_000);
      const authCleared = await verifyStationAuthCleared(page);
      onCoverage("gui.station_logout_auth_storage_cleared", authCleared, { stationName });
      if (!authCleared) throw new Error("Il logout GUI postazione non ha rimosso l'autenticazione.");
      await sleep(logoutMs);
      const login = await loginStationViaUi({
        page,
        session,
        pin,
        longPressMs,
        stationName,
      });
      diagnostics.longPresses += login.longPresses;
      await onSessionAuth(login.auth);
      await onAfterLogin(login.auth);
      onCoverage("gui.station_workstation_target_bound", login.targetBound === true, {
        stationName,
        flow: login.flow,
      });
      onCoverage("station.logout_10m_relogin", true, { stationName, logoutMs });
    } catch (error) {
      const context = await stationLogoutFailureContext(page, responsePromises, requestFailures);
      const message = error instanceof Error ? error.message : String(error ?? "errore sconosciuto");
      const enriched = new Error(`${message}; logoutContext=${JSON.stringify(context)}`);
      enriched.cause = error;
      enriched.p5ActionKind = "logout-longpress-login";
      throw enriched;
    } finally {
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
      expectedInterruption = false;
    }
  }

  async function simulateOutage() {
    expectedInterruption = true;
    diagnostics.disconnects += 1;
    const started = Date.now();
    await context.setOffline(true);
    await sleep(networkOutageMs);
    await context.setOffline(false);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    diagnostics.reloads += 1;
    const recovered = await page.locator(".logout-btn")
      .waitFor({ state: "visible", timeout: 25_000 })
      .then(() => true)
      .catch(() => false);
    if (recovered) {
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    }
    expectedInterruption = false;
    onCoverage("network.station_disconnect_reconnect", recovered, {
      stationName,
      offlineMs: Date.now() - started,
    });
    if (!recovered) throw new Error("GUI postazione non recuperata dopo il blackout.");
  }

  return {
    page,
    diagnostics,
    resetRequestTraffic() {
      resetP5GuiRequestTraffic(diagnostics);
    },
    async performAction(ordinal) {
      await page.bringToFront();
      actionCount += 1;
      diagnostics.interactions += await clearBlockingDialogs(page);
      if (!logoutDone && ordinal >= Math.ceil(totalActions * 0.25)) {
        logoutDone = true;
        await logoutAndLogin();
        diagnostics.interactions += 1;
        return { kind: "logout-longpress-login", ok: true };
      }
      if (!outageDone && ordinal >= Math.ceil(totalActions * 0.62)) {
        outageDone = true;
        await simulateOutage();
        diagnostics.interactions += 1;
        return { kind: "network-reconnect", ok: true };
      }

      const variant = actionCount % 6;
      let kind = "station-navigation";
      let ok = false;
      if (variant === 0) {
        kind = "history-toggle";
        ok = Boolean(await clickFirstVisible(page, [
          'label[title="Storico comande"] .toggle-slider',
          'label[title="Storico comande"]',
          "#historyToggle",
          ".history-toggle",
        ]));
      } else if (variant === 1) {
        kind = "station-search";
        const search = page.locator(".search-input:visible").first();
        if (await visible(search)) {
          await search.fill(ordinal % 2 ? "#" : "tavolo");
          ok = true;
        }
      } else if (variant === 2) {
        kind = "station-menu";
        const opened = await clickFirstVisible(page, [
          "button.menu-btn",
          'button:has-text("MENU")',
        ]);
        if (opened) {
          await clickFirstVisible(page, [
            '.modal-card:visible button[aria-label="Chiudi"]',
            'button[aria-label="Chiudi"]:visible',
          ]).catch(() => undefined);
          ok = true;
        }
      } else if (variant === 3) {
        kind = "station-real-long-press";
        const target = page.locator("#historyToggle:visible, .logout-btn:visible").first();
        ok = await longPressLocator(target, longPressMs);
        if (ok) {
          diagnostics.longPresses += 1;
          if (!longPressEvidenceDone) {
            longPressEvidenceDone = true;
            await screenshot(page, path.join(evidenceDir, "station-1-long-press.png"));
          }
        }
      } else if (variant === 4) {
        kind = "station-reload-session-retained";
        await page.reload({ waitUntil: "domcontentloaded" });
        diagnostics.reloads += 1;
        ok = await page.locator(".logout-btn").waitFor({ state: "visible", timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
      } else {
        kind = "station-real-scroll";
        await page.mouse.wheel(0, ordinal % 2 ? 600 : -600);
        ok = true;
      }
      diagnostics.interactions += 1;
      onCoverage(`gui.station.${kind}`, ok, { stationName, ordinal });
      if (!ok) throw new Error(`Interazione GUI postazione non eseguita: ${kind}.`);
      return { kind, ok };
    },
    async close() {
      await page.bringToFront().catch(() => undefined);
      await screenshot(page, path.join(evidenceDir, "station-1-end.png"));
      const result = { ...diagnostics, durationMs: Date.now() - startedAt, station: stationName };
      onComplete(result);
      await context.close();
      return result;
    },
  };
}
