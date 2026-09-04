import { expect } from "@playwright/test";

export const TABLE_5 = { id: "room_pedana_t05", roomId: "room_pedana", number: 5 };
export const TABLE_6 = { id: "room_pedana_t06", roomId: "room_pedana", number: 6 };
export const TABLE_7 = { id: "room_pedana_t07", roomId: "room_pedana", number: 7 };
export const TABLE_8 = { id: "room_pedana_t08", roomId: "room_pedana", number: 8 };
export const TABLE_SALA_1 = { id: "room_sala_t01", roomId: "room_sala", number: 1 };
export const TABLE_SALA_2 = { id: "room_sala_t02", roomId: "room_sala", number: 2 };
export const TABLE_TERRACE_1 = { id: "sala_terrazza_t01", roomId: "sala_terrazza", number: 1 };

export function line(name, price, quantity = 1, extra = {}) {
  return {
    name,
    productName: name,
    qty: quantity,
    quantity,
    price,
    unitPrice: price,
    ...extra,
  };
}

export function total(lines) {
  return Number(
    lines
      .reduce((sum, entry) => sum + (Number(entry.price ?? entry.unitPrice) || 0) * (Number(entry.qty ?? entry.quantity) || 1), 0)
      .toFixed(2)
  );
}

export async function openMobileLoggedIn(browser, app, options = {}) {
  const username = options.username ?? "manager";
  const pin = options.pin ?? "4444";
  const deviceUuid = options.deviceUuid ?? `gui-op-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript((uuid) => {
    window.localStorage.setItem("pos_device_uuid", uuid);
  }, deviceUuid);
  const page = await context.newPage();
  const response = await page.goto(`${app.frontendUrl}/mobile/`, { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(/Mobile Frontend/);
  await page.getByPlaceholder("Username").fill(username);
  await page.getByPlaceholder("PIN").fill(pin);
  await page.getByRole("button", { name: /Entra/i }).click();
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Boolean(window.localStorage.getItem("pos_token") && window.localStorage.getItem("pos_user_id"))
        ),
      { timeout: 15_000 }
    )
    .toBe(true);
  const homeReady = page.getByRole("button", { name: /Operatore .*Server connesso/i });
  const systemStatus = page.locator(".system-status");
  const appReady = homeReady.or(systemStatus).first();
  try {
    await expect(appReady).toBeVisible({ timeout: 15_000 });
  } catch (error) {
    const hasStoredSession = await page.evaluate(() =>
      Boolean(window.localStorage.getItem("pos_token") && window.localStorage.getItem("pos_user_id"))
    );
    if (!hasStoredSession) throw error;
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(appReady).toBeVisible({ timeout: 15_000 });
  }
  return { context, page, deviceUuid };
}

export async function openFrontendPage(browser, app, pathName, titlePattern, options = {}) {
  const context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 800 } });
  const page = await context.newPage();
  const response = await page.goto(`${app.frontendUrl}${pathName}`, { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle(titlePattern);
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  return { context, page };
}

export async function readAuth(page, extra = {}) {
  const auth = await page.evaluate(() => ({
    token:
      window.__guiAuthOverride?.token ||
      window.localStorage.getItem("pos_token") ||
      window.sessionStorage.getItem("pos_token") ||
      "",
    userId:
      window.__guiAuthOverride?.userId ||
      window.localStorage.getItem("pos_user_id") ||
      window.sessionStorage.getItem("pos_user_id") ||
      "",
    username:
      window.__guiAuthOverride?.username ||
      window.localStorage.getItem("pos_user") ||
      window.sessionStorage.getItem("pos_user") ||
      "",
    fullName:
      window.__guiAuthOverride?.fullName ||
      window.localStorage.getItem("pos_user_full_name") ||
      window.sessionStorage.getItem("pos_user_full_name") ||
      window.localStorage.getItem("pos_full_name") ||
      window.sessionStorage.getItem("pos_full_name") ||
      "",
    deviceUuid:
      window.__guiAuthOverride?.deviceUuid ||
      window.localStorage.getItem("pos_device_uuid") ||
      window.sessionStorage.getItem("pos_device_uuid") ||
      "",
    roomId:
      window.__guiAuthOverride?.roomId ||
      window.localStorage.getItem("pos_selected_room_id") ||
      window.sessionStorage.getItem("pos_selected_room_id") ||
      "room_pedana",
    roomName:
      window.__guiAuthOverride?.roomName ||
      window.localStorage.getItem("pos_selected_room_name") ||
      window.sessionStorage.getItem("pos_selected_room_name") ||
      "Pedana",
  }));
  return {
    ...auth,
    username: auth.username || "manager",
    fullName: auth.fullName || auth.username || "Manager Test",
    clientApp: "mobile-frontend",
    ...extra,
  };
}

export async function browserApi(page, pathName, payload = {}, options = {}) {
  const method = options.method ?? "POST";
  const expectedStatus = options.expectedStatus ?? 200;
  const attempts = Math.max(1, Number(options.fetchRetries ?? 3));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 150));
  const auth = await readAuth(page, options.auth ?? {});
  let result = null;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      result = await page.evaluate(
        async ({ pathName: path, method: requestMethod, payload: bodyPayload, authPayload }) => {
          const url = new URL(path, window.location.origin);
          const init = {
            method: requestMethod,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authPayload.token}`,
              "X-User-Id": authPayload.userId,
              "X-Device-Uuid": authPayload.deviceUuid,
            },
          };
          if (requestMethod === "GET") {
            Object.entries({ ...authPayload, ...bodyPayload }).forEach(([key, value]) => {
              if (value !== undefined && value !== null && value !== "") {
                url.searchParams.set(key, String(value));
              }
            });
          } else {
            init.body = JSON.stringify({ ...authPayload, ...bodyPayload });
          }
          const response = await fetch(url.toString(), init);
          const text = await response.text();
          let body = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          return { status: response.status, body };
        },
        { pathName, method, payload, authPayload: auth }
      );
      break;
    } catch (error) {
      lastError = error;
      const message = String(error?.message ?? error);
      const isTransientFetchFailure = /Failed to fetch|NetworkError|Load failed|ERR_CONNECTION/i.test(message);
      if (!isTransientFetchFailure || attempt >= attempts) {
        throw error;
      }
      await page.waitForTimeout(retryDelayMs * attempt);
    }
  }
  if (!result && lastError) {
    throw lastError;
  }
  expect(result.status, `${method} ${pathName}: ${JSON.stringify(result.body)}`).toBe(expectedStatus);
  return result.body;
}

export async function lockTable(page, tableId, purpose = "gui.test") {
  return browserApi(page, "/api/tables/lock/acquire", { tableId, purpose });
}

export async function releaseTableLock(page, tableId) {
  const result = await browserApi(page, "/api/tables/lock/release", { tableId });
  await waitForTableLockReleased(page, tableId);
  return result;
}

export async function forceReleaseTableLock(page, tableId) {
  const result = await browserApi(page, "/api/tables/lock/force-release", { tableId });
  await waitForTableLockReleased(page, tableId);
  return result;
}

async function waitForTableLockReleased(page, tableId) {
  await expect
    .poll(
      async () => {
        const layout = await browserApi(
          page,
          "/api/integration/layout",
          { cacheBust: Date.now() },
          { method: "GET" }
        );
        const table = (Array.isArray(layout?.tables) ? layout.tables : []).find((entry) => entry.id === tableId);
        return Boolean(table?.workLock);
      },
      { timeout: 10_000, message: `table ${tableId} lock released` }
    )
    .toBe(false);
}

async function releaseTableLockBestEffort(page, tableId) {
  try {
    await releaseTableLock(page, tableId);
  } catch {
    // I test GUI usano lock sintetici per simulare il palmare: il rilascio e'
    // best-effort per non mascherare l'esito dell'operazione appena testata.
  }
}

export async function syncTable(page, table, payload = {}) {
  await lockTable(page, table.id, "table.sync");
  return browserApi(page, "/api/integration/layout/table/sync", {
    tableId: table.id,
    roomId: table.roomId,
    tableNumber: table.number,
    ...payload,
  });
}

export async function createOrder(page, options = {}) {
  const table = options.table ?? TABLE_5;
  const lines = options.lines ?? [line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" })];
  await lockTable(page, table.id, "order.create");
  try {
    return await browserApi(
      page,
      "/api/integration/orders/create",
      {
        source: "mobile-frontend",
        tableId: table.id,
        roomId: table.roomId,
        tableNumber: table.number,
        covers: options.covers ?? 2,
        apericena: options.apericena ?? 0,
        note: options.note ?? "",
        orderNote: options.orderNote ?? options.note ?? "",
        communications: options.communications ?? "",
        orderComment: options.orderComment ?? options.communications ?? "",
        total: options.total ?? total(lines),
        lines,
      },
      { expectedStatus: options.expectedStatus ?? 200 }
    );
  } finally {
    await releaseTableLockBestEffort(page, table.id);
  }
}

export async function syncOrder(page, orderId, order, expectedStatus = 200) {
  return browserApi(page, "/api/integration/orders/sync", { id: orderId, order }, { expectedStatus });
}

export async function readyOrder(page, orderId, station = "BAR PRINCIPALE") {
  return syncOrder(page, orderId, {
    workflowStatus: "ready",
    station,
    ownerStation: station,
  });
}

export async function prepOrder(page, orderId, station = "BAR PRINCIPALE") {
  return syncOrder(page, orderId, {
    workflowStatus: "prep",
    station,
    ownerStation: station,
    ownerOperator: "GUI Postazione",
  });
}

export async function payFreeSplit(page, table, orderId, amount, options = {}) {
  const payload = {
    tableId: table.id,
    roomId: table.roomId,
    orderId,
    splitType: options.splitType ?? "FREE_SPLIT",
    splitMode: options.splitMode,
    releaseTable: options.releaseTable,
    articleUnitIds: options.articleUnitIds,
    idempotencyKey: options.idempotencyKey ?? `gui-pay-${orderId}-${amount}-${Date.now()}-${Math.random()}`,
    note: options.note,
    parts: [
      {
        amountDue: amount,
        transactions: [
          {
            method: options.method ?? "CASH",
            methodId: options.methodId ?? "pay_cash",
            methodLabel: options.methodLabel ?? "Contanti",
            amountPaid: amount,
            cashGiven: options.cashGiven ?? amount,
            note: options.txNote,
            posProvider: options.posProvider,
            posTxRef: options.posTxRef,
          },
        ],
      },
    ],
  };
  const expectedStatus = options.expectedStatus ?? 200;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await lockTable(page, table.id, "payment.free_split");
    try {
      return await browserApi(page, "/api/payments/free-split", payload, { expectedStatus });
    } catch (error) {
      const message = String(error?.message ?? error);
      if (attempt >= 2 || !message.includes("TABLE_LOCK_REQUIRED")) {
        throw error;
      }
      await page.waitForTimeout(150);
    }
  }
  throw new Error("Pagamento free-split non completato.");
}

export async function payTable(page, table, options = {}) {
  const payload = {
    tableId: table.id,
    roomId: table.roomId,
    method: options.method ?? "CASH",
    methodId: options.methodId ?? "pay_cash",
    paymentMethodId: options.paymentMethodId ?? options.methodId ?? "pay_cash",
    amountPaid: options.amountPaid,
    cashGiven: options.cashGiven,
    idempotencyKey: options.idempotencyKey ?? `gui-pay-table-${table.id}-${Date.now()}-${Math.random()}`,
    releaseTable: options.releaseTable,
    note: options.note,
  };
  const expectedStatus = options.expectedStatus ?? 200;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await lockTable(page, table.id, "payment.table");
    try {
      return await browserApi(page, "/api/payments/table", payload, { expectedStatus });
    } catch (error) {
      const message = String(error?.message ?? error);
      if (attempt >= 2 || !message.includes("TABLE_LOCK_REQUIRED")) {
        throw error;
      }
      await page.waitForTimeout(150);
    }
  }
  throw new Error("Pagamento tavolo non completato.");
}

export async function moveTable(page, fromTable, toTable, expectedStatus = 200) {
  await lockTable(page, fromTable.id, "table.move_source");
  await lockTable(page, toTable.id, "table.move_target");
  return browserApi(
    page,
    "/api/integration/layout/table/move",
    {
      fromTableId: fromTable.id,
      toTableId: toTable.id,
      roomId: fromTable.roomId,
      targetRoomId: toTable.roomId,
    },
    { expectedStatus }
  );
}

export async function saveGroups(page, groups) {
  return browserApi(page, "/api/integration/table-groups/save", { groups });
}

export async function printOrder(page, orderId, kind = "order") {
  return browserApi(page, "/api/integration/print", { kind, orderId });
}

export async function correctOrder(page, order, table, payload = {}, expectedStatus = 200) {
  await lockTable(page, table.id, "order.correction");
  return browserApi(
    page,
    "/api/integration/orders/correct",
    {
      tableId: table.id,
      roomId: table.roomId,
      orderId: order.id,
      expectedRevision: order.revision ?? order.currentRevision ?? 1,
      reason: payload.reason ?? "Correzione GUI",
      idempotencyKey: payload.idempotencyKey ?? `gui-correct-${order.id}-${Date.now()}-${Math.random()}`,
      ...payload,
    },
    { expectedStatus }
  );
}

export async function cancelOrder(page, order, table, payload = {}, expectedStatus = 200) {
  await lockTable(page, table.id, "order.cancel");
  return browserApi(
    page,
    "/api/integration/orders/cancel",
    {
      tableId: table.id,
      roomId: table.roomId,
      orderId: order.id,
      expectedRevision: order.revision ?? order.currentRevision ?? 1,
      reason: payload.reason ?? "Annullamento GUI",
      idempotencyKey: payload.idempotencyKey ?? `gui-cancel-${order.id}-${Date.now()}-${Math.random()}`,
      ...payload,
    },
    { expectedStatus }
  );
}

export async function compOrder(page, order, table, payload = {}, expectedStatus = 200) {
  await lockTable(page, table.id, "order.comp");
  return browserApi(
    page,
    "/api/integration/orders/comp",
    {
      tableId: table.id,
      roomId: table.roomId,
      orderId: order.id,
      originalLineId: payload.originalLineId ?? order.items?.[0]?.lineId,
      quantity: payload.quantity ?? 1,
      reason: payload.reason ?? "Reso GUI",
      idempotencyKey: payload.idempotencyKey ?? `gui-comp-${order.id}-${Date.now()}-${Math.random()}`,
      ...payload,
    },
    { expectedStatus }
  );
}

export async function publishNotification(page, payload = {}) {
  return browserApi(page, "/api/integration/notifications/publish", {
    type: "general",
    title: `GUI notification ${Date.now()}`,
    description: "Notifica GUI",
    ...payload,
  });
}

export async function pullNotifications(page, consumer = `gui-consumer-${Date.now()}`) {
  return browserApi(
    page,
    "/api/integration/notifications/pull",
    { consumer, clientApp: "postazione" },
    { method: "GET" }
  );
}

export async function setStationState(page, payload = {}) {
  return browserApi(page, "/api/integration/stations/state", {
    station: "BAR PRINCIPALE",
    active: true,
    autoPrintOrders: false,
    autoPrintPreconto: false,
    operatorUserId: "u_manager",
    operatorUsername: "manager",
    operatorName: "Manager Test",
    operatorRole: "Responsabile",
    ...payload,
  });
}

export async function reservationCreate(page, payload = {}, expectedStatus = 200) {
  return browserApi(page, "/api/pos/reservations/create", payload, { expectedStatus });
}

export async function reservationList(page, payload = {}, expectedStatus = 200) {
  return browserApi(page, "/api/pos/reservations/list", payload, { expectedStatus });
}

export async function reservationAvailability(page, payload = {}, expectedStatus = 200) {
  return browserApi(page, "/api/pos/reservations/availability", payload, { expectedStatus });
}

export async function reservationLockAcquire(page, payload = {}, expectedStatus = 200) {
  return browserApi(page, "/api/pos/reservations/lock/acquire", payload, { expectedStatus });
}

export async function reservationUpdate(page, payload = {}, expectedStatus = 200) {
  return browserApi(page, "/api/pos/reservations/update", payload, { expectedStatus });
}

export async function reservationDelete(page, payload = {}, expectedStatus = 200) {
  return browserApi(page, "/api/pos/reservations/delete", payload, { expectedStatus });
}

export function findOrder(state, orderId) {
  return state.integration.orders.find((order) => String(order.id) === String(orderId));
}

export function findTable(state, tableId) {
  return state.posSettings.tables.find((table) => table.id === tableId);
}

export function latestPrintJobFor(state, orderId, kind) {
  const jobs = (state.printSpoolJobs ?? []).filter((job) => job.orderId === orderId && (!kind || job.kind === kind));
  expect(jobs.length, `print job for ${orderId} ${kind ?? ""}`).toBeGreaterThan(0);
  return jobs.at(-1);
}

export function complexGroup(root = TABLE_5, child = TABLE_6) {
  return [
    {
      id: root.id,
      type: "complex",
      children: [
        { id: root.id, type: "simple" },
        { id: child.id, type: "simple" },
      ],
    },
  ];
}
