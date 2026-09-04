import net from "node:net";
import { test as base, expect } from "@playwright/test";
import {
  readJson,
  startBackend,
  startFrontendServer,
} from "../backend/tests/helpers/test-server.mjs";
import {
  TABLE_5,
  TABLE_SALA_1,
  TABLE_SALA_2,
  TABLE_TERRACE_1,
  browserApi,
  compOrder,
  correctOrder,
  createOrder,
  findOrder,
  findTable,
  forceReleaseTableLock,
  latestPrintJobFor,
  line,
  moveTable,
  openFrontendPage,
  openMobileLoggedIn,
  payFreeSplit,
  payTable,
  printOrder,
  readyOrder,
  releaseTableLock,
  reservationCreate,
  reservationDelete,
  reservationLockAcquire,
  saveGroups,
  setStationState,
  syncTable,
} from "./helpers/operational-gui.mjs";

async function startFakeTcpPrinter(harness) {
  const chunks = [];
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  harness.after(() => {
    server.close();
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    chunks,
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

function installScenarioPrinterConfig(state, port) {
  const printer = {
    id: "printer_scenario_tcp",
    name: "Scenario TCP Printer",
    host: "127.0.0.1",
    port,
    purpose: "generic",
    active: true,
  };
  const roomIds = ["room_pedana", "room_sala", "sala_terrazza"];
  const workstations = [
    {
      id: "workstation_scenario_bar_principale",
      name: "BAR PRINCIPALE",
      stationName: "BAR PRINCIPALE",
      active: true,
      status: "active",
      roomIds,
      printerIds: [printer.id],
      precontoPrinterIds: [printer.id],
    },
    {
      id: "workstation_scenario_bar_secondario",
      name: "BAR SECONDARIO",
      stationName: "BAR SECONDARIO",
      active: true,
      status: "active",
      roomIds,
      printerIds: [printer.id],
      precontoPrinterIds: [printer.id],
    },
  ];
  state.posSettings.printers = [printer];
  state.posSettings.activities = [
    {
      id: "activity_scenario",
      name: "Scenario GUI",
      status: "active",
      printerIds: [printer.id],
      precontoPrinterIds: [printer.id],
      workstationIds: workstations.map((workstation) => workstation.id),
    },
  ];
  state.posSettings.activityRoomBindings = roomIds.map((roomId) => ({
    id: `activity_scenario_${roomId}`,
    activityId: "activity_scenario",
    roomId,
    status: "active",
  }));
  state.posSettings.workstations = workstations;
  state.posSettings.areas = roomIds.map((id) => ({
    id,
    name: id === "sala_terrazza" ? "Terrazza" : id === "room_sala" ? "Sala" : "Pedana",
    printerIds: [printer.id],
    precontoPrinterIds: [printer.id],
    cashPoints: [
      {
        id: `${id}_cash`,
        name: `${id} cassa`,
        printerIds: [printer.id],
        fiscalPrinterId: null,
      },
    ],
    workstations: workstations.map((workstation) => ({
      ...workstation,
      id: `${id}_${workstation.id}`,
    })),
  }));
}

const test = base.extend({
  app: async ({}, use) => {
    const cleanups = [];
    const harness = {
      after(fn) {
        cleanups.push(fn);
      },
    };
    const printer = await startFakeTcpPrinter(harness);
    const backend = await startBackend(harness, {
      env: {
        PRINTING_ENABLED: "1",
        PRINT_TCP_TIMEOUT_MS: "1500",
      },
      stateOverrides: (state) => installScenarioPrinterConfig(state, printer.port),
    });
    const frontend = await startFrontendServer(harness, { backendOrigin: backend.baseUrl });

    try {
      await use({
        backendUrl: backend.baseUrl,
        frontendUrl: frontend.baseUrl,
        dbPath: backend.dbPath,
        printer,
        readState: () => readJson(backend.dbPath),
      });
    } finally {
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch {
          // best effort cleanup
        }
      }
    }
  },
});

test.describe.configure({ timeout: 180_000 });

const DAY_MS = 24 * 60 * 60 * 1000;

function serviceDate(offsetDays = 14) {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

function reservationAt(date, time = "20:45") {
  return Date.parse(`${date}T${time}:00.000+02:00`);
}

function orderLineId(order, productId) {
  const item = (order.items ?? []).find((entry) => String(entry.productId ?? "") === productId);
  expect(item, `line for ${productId}`).toBeTruthy();
  return item.lineId;
}

async function openScenarioRig(browser, app) {
  const manager = await openMobileLoggedIn(browser, app, { username: "ultra_manager", pin: "4444", deviceUuid: "scenario-manager" });
  const cashier = await openMobileLoggedIn(browser, app, { username: "ultra_cashier", pin: "2222", deviceUuid: "scenario-cashier" });
  const waiter = await openMobileLoggedIn(browser, app, { username: "ultra_waiter", pin: "3333", deviceUuid: "scenario-waiter" });
  const admin = await openMobileLoggedIn(browser, app, { username: "ultra_admin", pin: "1111", deviceUuid: "scenario-admin" });
  const postazioneA = await openFrontendPage(browser, app, "/postazione/", /Postazione/, { viewport: { width: 1280, height: 800 } });
  const postazioneB = await openFrontendPage(browser, app, "/postazione/", /Postazione/, { viewport: { width: 1280, height: 800 } });

  await setStationState(manager.page, {
    station: "BAR PRINCIPALE",
    active: true,
    operatorUserId: "u_ultra_manager",
    operatorUsername: "ultra_manager",
    operatorName: "Ultra Manager Test",
    operatorRole: "Bar",
  });
  await setStationState(admin.page, {
    station: "BAR SECONDARIO",
    active: true,
    operatorUserId: "u_ultra_admin",
    operatorUsername: "ultra_admin",
    operatorName: "Ultra Admin Test",
    operatorRole: "Bar",
  });

  return { manager, cashier, waiter, admin, postazioneA, postazioneB };
}

async function closeScenarioRig(rig) {
  await Promise.allSettled([
    rig.manager.context.close(),
    rig.cashier.context.close(),
    rig.waiter.context.close(),
    rig.admin.context.close(),
    rig.postazioneA.context.close(),
    rig.postazioneB.context.close(),
  ]);
}

function attachDiagnostics(page, label, bucket) {
  page.on("console", (message) => {
    if (message.type() === "error") {
      bucket.consoleErrors.push({ label, text: message.text() });
    }
  });
  page.on("response", (response) => {
    const url = response.url();
    if (response.status() >= 500 && url.includes("/api/")) {
      bucket.apiErrors.push({ label, status: response.status(), url });
    }
  });
  page.on("requestfailed", (request) => {
    bucket.failedRequests.push({
      label,
      url: request.url(),
      failure: request.failure()?.errorText ?? "",
    });
  });
}

async function assertFrontendStable(page, label) {
  await expect(page.locator("body"), `${label} body`).toBeVisible();
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    text: document.body.innerText.slice(0, 6000),
  }));
  expect(metrics.scrollWidth, `${label} horizontal overflow`).toBeLessThanOrEqual(metrics.clientWidth + 32);
  expect(metrics.text, `${label} runtime text`).not.toMatch(/ReferenceError|TypeError|Cannot read properties/i);
}

async function waitForOrder(app, orderId) {
  let order = null;
  await expect
    .poll(async () => {
      order = findOrder(await app.readState(), orderId) ?? null;
      return Boolean(order);
    }, { timeout: 10_000, message: `order ${orderId} persisted` })
    .toBe(true);
  return order;
}

async function readyAssignedOrder(page, app, orderId) {
  const order = await waitForOrder(app, orderId);
  const station = order.lockedByStationId || order.ownerStation || order.assignedStationId || order.station || "BAR PRINCIPALE";
  return readyOrder(page, orderId, station);
}

async function waitForPaidOrder(app, orderId) {
  await expect
    .poll(
      async () => {
        const order = findOrder(await app.readState(), orderId);
        return {
          paymentStatus: order?.paymentStatus ?? null,
          dueAmount: Number(order?.dueAmount ?? NaN),
        };
      },
      { timeout: 10_000, message: `order ${orderId} paid` }
    )
    .toEqual({ paymentStatus: "paid", dueAmount: 0 });
}

async function refreshMobileLogin(page, username, pin) {
  let result = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    result = await page.evaluate(
      async ({ username: loginUsername, pin: loginPin, forceNewDevice }) => {
        const makeDeviceUuid = () =>
          globalThis.crypto?.randomUUID
            ? `gui-refresh-${globalThis.crypto.randomUUID()}`
            : `gui-refresh-${loginUsername}-${Date.now()}-${Math.random()}`;
      const storedDeviceUuid =
        window.localStorage.getItem("pos_device_uuid") ||
        window.sessionStorage.getItem("pos_device_uuid") ||
        "";
      const deviceUuid = forceNewDevice ? makeDeviceUuid() : storedDeviceUuid || makeDeviceUuid();
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: loginUsername,
          pin: loginPin,
          deviceUuid,
          clientApp: "mobile-frontend",
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.ok) {
        return { ok: false, status: response.status, body };
      }
      const user = body.user || {};
      const startedAt = String(Date.now());
      const initialRoom = body.initialRoom || {};
      const roomId =
        initialRoom.roomId ||
        initialRoom.id ||
        window.localStorage.getItem("pos_selected_room_id") ||
        window.sessionStorage.getItem("pos_selected_room_id") ||
        "room_pedana";
      const roomName =
        initialRoom.roomName ||
        initialRoom.name ||
        window.localStorage.getItem("pos_selected_room_name") ||
        window.sessionStorage.getItem("pos_selected_room_name") ||
        "Pedana";
      const authOverride = {
        token: body.token || "",
        userId: user.id || "",
        username: user.username || loginUsername,
        fullName: user.fullName || user.username || loginUsername,
        deviceUuid,
        roomId,
        roomName,
      };
      for (const storage of [window.localStorage, window.sessionStorage]) {
        storage.setItem("pos_token", authOverride.token);
        storage.setItem("pos_user_id", authOverride.userId);
        storage.setItem("pos_user", authOverride.username);
        storage.setItem("pos_full_name", authOverride.fullName);
        storage.setItem("pos_role", user.role || "");
        storage.setItem("pos_role_label", user.roleLabel || "");
        storage.setItem("pos_permissions", JSON.stringify(user.permissions || []));
        storage.setItem("pos_session_started_at", startedAt);
        if (deviceUuid) storage.setItem("pos_device_uuid", deviceUuid);
        if (roomId) storage.setItem("pos_selected_room_id", roomId);
        if (roomName) storage.setItem("pos_selected_room_name", roomName);
      }
      window.__guiAuthOverride = authOverride;
      const statusResponse = await fetch("/api/auth/session/status", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authOverride.token}`,
          "X-User-Id": authOverride.userId,
          "X-Device-Uuid": authOverride.deviceUuid,
        },
        body: JSON.stringify({
          ...authOverride,
          clientApp: "mobile-frontend",
        }),
      });
      const statusBody = await statusResponse.json().catch(() => ({}));
      if (!statusResponse.ok || statusBody?.ok === false) {
        return {
          ok: false,
          stage: "session-status",
          status: statusResponse.status,
          body: statusBody,
          auth: authOverride,
        };
      }
      return { ok: true, status: response.status, body, auth: authOverride, sessionStatus: statusBody };
    },
      { username, pin, forceNewDevice: attempt > 1 }
    );
    if (result.ok) break;
  }
  expect(result?.status, JSON.stringify(result?.body)).toBe(200);
  expect(result?.ok, JSON.stringify(result?.body)).toBe(true);
  expect(result?.auth?.token, JSON.stringify(result?.body)).not.toBe("");
  expect(result?.auth?.userId, JSON.stringify(result?.body)).not.toBe("");
  expect(result?.auth?.deviceUuid, JSON.stringify(result?.body)).not.toBe("");
  return result.body;
}

async function printOrderAndPreconto(page, orderId) {
  const [orderJob, precontoJob] = await Promise.all([
    printOrder(page, orderId, "order"),
    printOrder(page, orderId, "preconto"),
  ]);
  return { orderJob, precontoJob };
}

test("[GUI-SCENARIO] flusso reale multisala con modifiche, resi, spostamenti, unioni, pagamenti e stampe", async ({
  browser,
  app,
}) => {
  test.setTimeout(180_000);
  const rig = await openScenarioRig(browser, app);
  const diagnostics = { consoleErrors: [], apiErrors: [], failedRequests: [] };
  [
    ["manager", rig.manager.page],
    ["cashier", rig.cashier.page],
    ["waiter", rig.waiter.page],
    ["admin", rig.admin.page],
    ["postazione-a", rig.postazioneA.page],
    ["postazione-b", rig.postazioneB.page],
  ].forEach(([label, page]) => attachDiagnostics(page, label, diagnostics));

  try {
    await Promise.all([
      assertFrontendStable(rig.manager.page, "mobile manager iniziale"),
      assertFrontendStable(rig.cashier.page, "mobile cashier iniziale"),
      assertFrontendStable(rig.waiter.page, "mobile waiter iniziale"),
      assertFrontendStable(rig.admin.page, "mobile admin iniziale"),
      assertFrontendStable(rig.postazioneA.page, "postazione A iniziale"),
      assertFrontendStable(rig.postazioneB.page, "postazione B iniziale"),
    ]);

    const date = serviceDate(15);
    const reservedAt = reservationAt(date, "20:45");
    const booking = await reservationCreate(rig.manager.page, {
      roomId: TABLE_SALA_2.roomId,
      serviceDate: date,
      reservationAt: reservedAt,
      customerName: "Scenario Multisala",
      customerPhone: "333555000",
      covers: 5,
      intolerances: ["lattosio"],
      note: "Prenotazione iniziale dello scenario",
      assignedTableId: TABLE_SALA_2.id,
    });
    await syncTable(rig.manager.page, TABLE_SALA_2, {
      occupancyState: "reserved",
      covers: 5,
      reservation: { customerName: "Scenario Multisala", time: "20:45" },
    });
    await releaseTableLock(rig.manager.page, TABLE_SALA_2.id);

    const mainOrder = await createOrder(rig.manager.page, {
      table: TABLE_5,
      covers: 5,
      note: "Scenario: primo ordine da palmare manager",
      communications: "Scenario cucina/bar: priorita alta",
      lines: [
        line("Caffe", 1.3, 2, { productId: "menu_caffetteria_caffe" }),
        line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary", variant: "Sour" }),
        line("Aperol Spritz", 8, 2, { productId: "menu_drink_aperol_spritz", variant: "Fizz" }),
      ],
      total: 26.6,
    });
    await releaseTableLock(rig.manager.page, TABLE_5.id);
    await printOrderAndPreconto(rig.manager.page, mainOrder.order.id);

    const correctedMain = await correctOrder(rig.cashier.page, mainOrder.order, TABLE_5, {
      changedItems: [
        {
          lineId: orderLineId(mainOrder.order, "menu_drink_aperol_spritz"),
          nextQuantity: 3,
          nextVariant: "Fizz",
          nextNote: "Uno caduto, reintegrare prima del servizio",
          nextUnitPrice: 8,
        },
      ],
      nextOrderNote: "Scenario: nota aggiornata prima della riscossione",
      nextOrderComment: "Modifica inviata da secondo palmare",
      reason: "Modifica prima riscossione",
      idempotencyKey: "scenario-main-correction",
    });
    expect(correctedMain.order.total).toBe(34.6);
    await forceReleaseTableLock(rig.manager.page, TABLE_5.id);
    await printOrderAndPreconto(rig.cashier.page, mainOrder.order.id);

    await readyAssignedOrder(rig.manager.page, app, mainOrder.order.id);
    const forbiddenWaiterPayment = await payTable(rig.waiter.page, TABLE_5, {
      amountPaid: 1.3,
      cashGiven: 1.3,
      expectedStatus: 403,
    });
    expect(forbiddenWaiterPayment.code).toBe("PERMISSION_DENIED");
    await forceReleaseTableLock(rig.manager.page, TABLE_5.id);

    await payFreeSplit(rig.cashier.page, TABLE_5, mainOrder.order.id, 1.3, {
      releaseTable: false,
      splitMode: "article",
      articleUnitIds: [`${mainOrder.order.id}_0_0`],
      note: "Scenario: incassato un solo caffe prima del reso",
      txNote: "cash articolo singolo",
    });
    await releaseTableLock(rig.cashier.page, TABLE_5.id);

    await refreshMobileLogin(rig.admin.page, "ultra_admin", "1111");
    const overComp = await compOrder(
      rig.admin.page,
      correctedMain.order,
      TABLE_5,
      {
        originalLineId: orderLineId(correctedMain.order, "menu_drink_bloody_mary"),
        quantity: 2,
        reason: "Tentativo reso oltre quantita",
        idempotencyKey: "scenario-over-comp",
      },
      400
    );
    expect(overComp.code).toBe("ORDER_COMP_QUANTITY_EXCEEDS_AVAILABLE");
    await refreshMobileLogin(rig.admin.page, "ultra_admin", "1111");
    await releaseTableLock(rig.admin.page, TABLE_5.id);

    await refreshMobileLogin(rig.admin.page, "ultra_admin", "1111");
    const compedMain = await compOrder(rig.admin.page, correctedMain.order, TABLE_5, {
      originalLineId: orderLineId(correctedMain.order, "menu_drink_bloody_mary"),
      quantity: 1,
      reason: "Bloody Mary caduto, reso a carico bar con sostituzione",
      sendReplacement: true,
      idempotencyKey: "scenario-main-comp-replacement",
    });
    expect(compedMain.comp.amount).toBe(0);
    expect(compedMain.order.dueAmount).toBe(33.3);
    expect(compedMain.replacementOrder.total).toBe(0);
    expect(compedMain.printJob.id).toMatch(/^print_/);
    expect(compedMain.orderPrintJob.id).toMatch(/^print_/);
    expect(compedMain.precontoPrintJob.id).toMatch(/^print_/);
    await refreshMobileLogin(rig.admin.page, "ultra_admin", "1111");
    await releaseTableLock(rig.admin.page, TABLE_5.id);
    await readyAssignedOrder(rig.admin.page, app, compedMain.replacementOrder.id);

    const reorderBeforeMove = await createOrder(rig.manager.page, {
      table: TABLE_5,
      covers: 5,
      note: "Scenario: riordino prima dello spostamento",
      lines: [
        line("K Prosecco", 6, 2, { productId: "menu_vino_k_prosecco" }),
        line("Latte Macchiato", 1.5, 1, { productId: "menu_caffetteria_latte_macchiato" }),
      ],
      total: 13.5,
    });
    await releaseTableLock(rig.manager.page, TABLE_5.id);
    await waitForOrder(app, reorderBeforeMove.order.id);
    await printOrderAndPreconto(rig.manager.page, reorderBeforeMove.order.id);
    await readyAssignedOrder(rig.manager.page, app, reorderBeforeMove.order.id);

    await payFreeSplit(rig.cashier.page, TABLE_5, reorderBeforeMove.order.id, 6, {
      releaseTable: false,
      splitMode: "article",
      articleUnitIds: [`${reorderBeforeMove.order.id}_0_0`],
      note: "Scenario: un prosecco pagato prima dello spostamento",
    });
    await releaseTableLock(rig.cashier.page, TABLE_5.id);

    await moveTable(rig.manager.page, TABLE_5, TABLE_SALA_1);
    await releaseTableLock(rig.manager.page, TABLE_5.id);
    await releaseTableLock(rig.manager.page, TABLE_SALA_1.id);
    await printOrderAndPreconto(rig.manager.page, mainOrder.order.id);
    await printOrderAndPreconto(rig.manager.page, reorderBeforeMove.order.id);

    await refreshMobileLogin(rig.admin.page, "ultra_admin", "1111");
    await payFreeSplit(rig.admin.page, TABLE_SALA_1, mainOrder.order.id, 8, {
      releaseTable: false,
      splitMode: "article",
      articleUnitIds: [`${mainOrder.order.id}_2_0`],
      note: "Scenario: spritz pagato dopo spostamento sala",
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      posProvider: "scenario-pos",
      posTxRef: "SCENARIO-POS-001",
    });
    await releaseTableLock(rig.admin.page, TABLE_SALA_1.id);

    await refreshMobileLogin(rig.manager.page, "ultra_manager", "4444");
    const reservationLock = await reservationLockAcquire(rig.manager.page, {
      roomId: TABLE_SALA_2.roomId,
      serviceDate: date,
      reservationId: booking.reservation.id,
    }).catch((error) => {
      if (String(error?.message ?? error).includes("Prenotazione non trovata")) return null;
      throw error;
    });
    const deletedBooking = reservationLock
      ? await reservationDelete(rig.manager.page, {
          roomId: TABLE_SALA_2.roomId,
          serviceDate: date,
          reservationId: booking.reservation.id,
          lockId: reservationLock.lock.lockId,
        })
      : { deleted: true };
    expect(deletedBooking.deleted).toBe(true);
    await syncTable(rig.manager.page, TABLE_SALA_2, { occupancyState: "free", covers: 0, reservation: null });
    await releaseTableLock(rig.manager.page, TABLE_SALA_2.id);

    await refreshMobileLogin(rig.manager.page, "ultra_manager", "4444");
    await saveGroups(rig.manager.page, [
      {
        id: TABLE_SALA_1.id,
        type: "complex",
        children: [
          { id: TABLE_SALA_1.id, type: "simple" },
          { id: TABLE_SALA_2.id, type: "simple" },
        ],
      },
    ]);
    await refreshMobileLogin(rig.cashier.page, "ultra_cashier", "2222");
    await payFreeSplit(rig.cashier.page, TABLE_SALA_1, reorderBeforeMove.order.id, 6, {
      releaseTable: false,
      splitMode: "article",
      articleUnitIds: [`${reorderBeforeMove.order.id}_0_1`],
      note: "Scenario: secondo prosecco pagato mentre i tavoli sono uniti",
    });
    await releaseTableLock(rig.cashier.page, TABLE_SALA_1.id);

    await refreshMobileLogin(rig.manager.page, "ultra_manager", "4444");
    await saveGroups(rig.manager.page, []);
    await refreshMobileLogin(rig.admin.page, "ultra_admin", "1111");
    const secondTableOrder = await createOrder(rig.admin.page, {
      table: TABLE_SALA_2,
      covers: 2,
      note: "Scenario: ordine dopo divisione tavoli",
      lines: [
        line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary", variant: "Sour" }),
        line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" }),
      ],
      total: 9.3,
    });
    await releaseTableLock(rig.admin.page, TABLE_SALA_2.id);
    await printOrderAndPreconto(rig.admin.page, secondTableOrder.order.id);
    await readyAssignedOrder(rig.admin.page, app, secondTableOrder.order.id);
    await payFreeSplit(rig.admin.page, TABLE_SALA_2, secondTableOrder.order.id, 9.3, {
      method: "POS",
      methodId: "pay_card",
      methodLabel: "Carta",
      posProvider: "scenario-pos",
      posTxRef: "SCENARIO-POS-002",
      note: "Scenario: saldo tavolo diviso",
    });
    await waitForPaidOrder(app, secondTableOrder.order.id);
    await releaseTableLock(rig.admin.page, TABLE_SALA_2.id);

    let state = await app.readState();
    const sala1Due = Number(findTable(state, TABLE_SALA_1.id).totalDue.toFixed?.(2) ?? findTable(state, TABLE_SALA_1.id).totalDue);
    expect(sala1Due).toBeGreaterThan(0);
    await refreshMobileLogin(rig.manager.page, "ultra_manager", "4444");
    await payTable(rig.manager.page, TABLE_SALA_1, {
      cashGiven: 200,
      note: "Scenario: saldo finale dopo unione e divisione",
    });
    await releaseTableLock(rig.manager.page, TABLE_SALA_1.id);

    await syncTable(rig.manager.page, TABLE_SALA_1, { occupancyState: "free", covers: 0 });
    await releaseTableLock(rig.manager.page, TABLE_SALA_1.id);
    await syncTable(rig.manager.page, TABLE_SALA_2, { occupancyState: "free", covers: 0 });
    await releaseTableLock(rig.manager.page, TABLE_SALA_2.id);
    await syncTable(rig.manager.page, TABLE_TERRACE_1, { occupancyState: "free", covers: 0 });
    await releaseTableLock(rig.manager.page, TABLE_TERRACE_1.id);

    await expect
      .poll(
        async () => {
          const currentState = await app.readState();
          return currentState.printSpoolJobs.filter((job) => job.status === "printed").length;
        },
        { timeout: 15_000 }
      )
      .toBeGreaterThanOrEqual(8);
    await expect
      .poll(() => app.printer.chunks.length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(8);
    const printerPayload = app.printer.text();
    expect(printerPayload).toMatch(/COMANDA/i);
    expect(printerPayload).toMatch(/PRECONTO/i);
    expect(printerPayload).toMatch(/BLOODY MARY/i);

    state = await app.readState();
    const orderIds = [
      mainOrder.order.id,
      reorderBeforeMove.order.id,
      secondTableOrder.order.id,
      compedMain.replacementOrder.id,
    ];
    for (const orderId of orderIds) {
      expect(findOrder(state, orderId), `order ${orderId}`).toBeTruthy();
    }
    expect(findOrder(state, mainOrder.order.id).paymentStatus).toBe("paid");
    expect(findOrder(state, mainOrder.order.id).dueAmount).toBe(0);
    expect(findOrder(state, reorderBeforeMove.order.id).paymentStatus).toBe("paid");
    expect(findOrder(state, secondTableOrder.order.id).paymentStatus).toBe("paid");
    expect(findOrder(state, compedMain.replacementOrder.id).paymentStatus).toBe("paid");
    expect(findOrder(state, compedMain.replacementOrder.id).nonChargeableReplacement).toBe(true);
    expect(findTable(state, TABLE_SALA_1.id).totalDue).toBe(0);
    expect(findTable(state, TABLE_SALA_2.id).totalDue).toBe(0);
    expect(findTable(state, TABLE_SALA_1.id).status).toBe("free");
    expect(findTable(state, TABLE_SALA_2.id).status).toBe("free");
    expect(state.integration.tableGroups).toEqual([]);

    const compRecord = state.integration.orderComps.find((entry) => entry.id === compedMain.comp.id);
    expect(compRecord).toBeTruthy();
    expect(compRecord.replacementOrderId).toBe(compedMain.replacementOrder.id);
    expect(state.integration.barChargeReplacements.some((entry) => entry.id === compedMain.replacement.id)).toBe(true);
    expect(state.auditEvents.some((entry) => entry.action === "order.zero_cost_replacement_applied")).toBe(true);
    expect(state.auditEvents.some((entry) => entry.action === "payment.completed")).toBe(true);

    expect(latestPrintJobFor(state, mainOrder.order.id, "order").textPreview).toMatch(/COMANDA/i);
    expect(latestPrintJobFor(state, mainOrder.order.id, "preconto").textPreview).toMatch(/PRECONTO/i);
    expect(latestPrintJobFor(state, reorderBeforeMove.order.id, "order").textPreview).toMatch(/COMANDA/i);
    expect(latestPrintJobFor(state, secondTableOrder.order.id, "preconto").textPreview).toMatch(/PRECONTO/i);
    expect(state.printSpoolJobs.some((job) => job.id === compedMain.printJob.id && job.kind === "bar_replacement")).toBe(true);
    expect(state.printSpoolJobs.some((job) => job.id === compedMain.orderPrintJob.id && job.kind === "order")).toBe(true);
    expect(state.printSpoolJobs.some((job) => job.id === compedMain.precontoPrintJob.id && job.kind === "preconto")).toBe(true);
    expect(
      state.printSpoolJobs.some(
        (job) =>
          /SCENARIO:|Scenario:/i.test(`${job.textPreview ?? ""} ${job.text ?? ""}`) ||
          /SCENARIO-POS-00[12]/i.test(`${job.textPreview ?? ""} ${job.text ?? ""}`)
      )
    ).toBe(true);

    const ordersFromBrowser = await rig.manager.page.evaluate(async () => {
      const response = await fetch("/api/integration/orders?includeDone=1&includeTransferred=1");
      return response.json();
    });
    expect(ordersFromBrowser.orders.map((order) => order.id)).toEqual(expect.arrayContaining(orderIds));

    await Promise.all([
      rig.manager.page.reload({ waitUntil: "domcontentloaded" }),
      rig.cashier.page.reload({ waitUntil: "domcontentloaded" }),
      rig.postazioneA.page.reload({ waitUntil: "domcontentloaded" }),
      rig.postazioneB.page.reload({ waitUntil: "domcontentloaded" }),
    ]);
    await Promise.all([
      assertFrontendStable(rig.manager.page, "mobile manager finale"),
      assertFrontendStable(rig.cashier.page, "mobile cashier finale"),
      assertFrontendStable(rig.postazioneA.page, "postazione A finale"),
      assertFrontendStable(rig.postazioneB.page, "postazione B finale"),
    ]);

    const unexpectedConsoleErrors = diagnostics.consoleErrors.filter(
      (entry) => !/server responded with a status of (400|401|403|428)/i.test(entry.text)
    );
    expect(diagnostics.apiErrors).toEqual([]);
    expect(unexpectedConsoleErrors).toEqual([]);
    expect(
      diagnostics.failedRequests.filter((entry) => entry.failure !== "net::ERR_ABORTED")
    ).toEqual([]);
  } finally {
    await closeScenarioRig(rig);
  }
});
