import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import {
  apiPost,
  authPayload,
  createSimpleOrder,
  loginJson,
  readJson,
  startBackend,
} from "./helpers/test-server.mjs";

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

function normalActiveWindow(price) {
  const now = currentRomeMinutes();
  return now < 12 * 60
    ? [{ id: "normal", label: "Normale", start: "00:00", end: "12:00", price, enabled: true }]
    : [{ id: "normal", label: "Normale", start: "12:00", end: "23:59", price, enabled: true }];
}

function crossMidnightActiveWindow(price) {
  const now = currentRomeMinutes();
  return now < 12 * 60
    ? [{ id: "cross", label: "Notte", start: "22:00", end: "12:00", price, enabled: true }]
    : [{ id: "cross", label: "Notte", start: "12:00", end: "02:00", price, enabled: true }];
}

function menuItem(id, name, price, extra = {}) {
  return {
    id,
    name,
    price,
    category: "Bevande",
    enabled: true,
    imageUrl: null,
    createdByUserId: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

async function boot(t, items) {
  const deviceUuid = `listino-device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const app = await startBackend(t, {
    stateOverrides(state) {
      state.menuItems.push(...items);
      state.meta.lastWriteAt = new Date().toISOString();
    },
  });
  const session = await loginJson(app.baseUrl, "cashier", "2222", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  return { ...app, session, deviceUuid };
}

async function runtimeProduct(baseUrl, id) {
  const response = await fetch(`${baseUrl}/api/integration/menu`);
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.products.find((item) => item.id === id);
}

async function startFakeTcpPrinter(t) {
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
  t.after(() => server.close());
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

function installListinoPrinterConfig(state, port) {
  const printer = {
    id: "printer_listino_tcp",
    name: "Listino TCP Printer",
    host: "127.0.0.1",
    port,
    purpose: "generic",
    active: true,
  };
  state.posSettings.printers = [printer];
  state.posSettings.activities = [
    {
      id: "activity_bar",
      name: "Bar",
      printerIds: [printer.id],
      precontoPrinterIds: [printer.id],
      fiscalDeviceIds: [],
      workstationIds: ["workstation_bar_1", "room_pedana_station"],
    },
  ];
  state.posSettings.activityRoomBindings = [
    {
      id: "activity_bar_room_pedana",
      activityId: "activity_bar",
      roomId: "room_pedana",
      status: "active",
    },
  ];
  state.posSettings.workstations = [
    {
      id: "workstation_bar_1",
      name: "BAR-1",
      stationName: "BAR-1",
      printerIds: [printer.id],
      active: true,
      status: "active",
      roomIds: ["room_pedana"],
      activityIds: ["activity_bar"],
    },
    ...(Array.isArray(state.posSettings.workstations) ? state.posSettings.workstations : []),
  ].filter(
    (entry, index, items) =>
      items.findIndex((candidate) => String(candidate?.id ?? "") === String(entry?.id ?? "")) === index
  );
  state.posSettings.areas = [
    {
      id: "room_pedana",
      name: "Pedana",
      printerIds: [printer.id],
      cashPoints: [
        {
          id: "room_pedana_cash",
          name: "Pedana cassa",
          printerIds: [printer.id],
          fiscalPrinterId: null,
        },
      ],
      workstations: [
        {
          id: "room_pedana_station",
          name: "BAR PRINCIPALE",
          stationName: "BAR PRINCIPALE",
          printerIds: [printer.id],
        },
      ],
    },
  ];
}

async function stopBackend(child) {
  if (!child || child.killed) return;
  child.kill();
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1_500)),
  ]);
}

async function waitForPrintedJob(dbPath, predicate, timeoutMs = 8_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const db = await readJson(dbPath);
    const job = (db.printSpoolJobs ?? []).find((entry) => entry?.status === "printed" && predicate(entry));
    if (job) return { db, job };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timeout in attesa stampa listino temporizzato");
}

async function syncReady(baseUrl, session, deviceUuid, orderId) {
  return apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(session, deviceUuid, {
      id: orderId,
      order: {
        workflowStatus: "ready",
        station: "BAR PRINCIPALE",
        ownerStation: "BAR PRINCIPALE",
      },
    })
  );
}

async function lockTable(baseUrl, session, deviceUuid, tableId, purpose) {
  return apiPost(
    baseUrl,
    "/api/tables/lock/acquire",
    authPayload(session, deviceUuid, {
      tableId,
      purpose,
    })
  );
}

async function payOrder(baseUrl, session, deviceUuid, orderId, amount) {
  const tableId = "room_pedana_t05";
  await lockTable(baseUrl, session, deviceUuid, tableId, "payment.free_split");
  return apiPost(
    baseUrl,
    "/api/payments/free-split",
    authPayload(session, deviceUuid, {
      tableId,
      roomId: "room_pedana",
      orderId,
      splitType: "FREE_SPLIT",
      idempotencyKey: `listino-snapshot-pay-${orderId}`,
      parts: [
        {
          amountDue: amount,
          transactions: [
            {
              method: "CASH",
              methodId: "pay_cash",
              methodLabel: "Contanti",
              amountPaid: amount,
              cashGiven: amount,
            },
          ],
        },
      ],
    })
  );
}

test("[BE][LISTINO-01] fascia normale attiva applica il prezzo runtime", async (t) => {
  const id = "menu_test_listino_normale";
  const { baseUrl } = await boot(t, [menuItem(id, "Listino Normale", 10, { priceSchedule: normalActiveWindow(4.5) })]);
  const product = await runtimeProduct(baseUrl, id);
  assert.equal(product.price, 4.5);
  assert.equal(product.basePrice, 10);
  assert.equal(product.currentPriceScheduleId, "normal");
});

test("[BE][LISTINO-02] fascia che attraversa mezzanotte applica il prezzo runtime", async (t) => {
  const id = "menu_test_listino_cross";
  const { baseUrl } = await boot(t, [menuItem(id, "Listino Cross", 11, { priceSchedule: crossMidnightActiveWindow(6) })]);
  const product = await runtimeProduct(baseUrl, id);
  assert.equal(product.price, 6);
  assert.equal(product.currentPriceScheduleId, "cross");
});

test("[BE][LISTINO-03] fascia disabilitata usa il prezzo base", async (t) => {
  const id = "menu_test_listino_disabled";
  const { baseUrl } = await boot(t, [
    menuItem(id, "Listino Disabled", 9, {
      priceSchedule: normalActiveWindow(3).map((rule) => ({ ...rule, enabled: false })),
    }),
  ]);
  const product = await runtimeProduct(baseUrl, id);
  assert.equal(product.price, 9);
  assert.equal(product.currentPriceScheduleId, null);
});

test("[BE][LISTINO-04] fascia invalida usa il prezzo base", async (t) => {
  const id = "menu_test_listino_invalid";
  const { baseUrl } = await boot(t, [
    menuItem(id, "Listino Invalid", 8, {
      priceSchedule: [{ id: "bad", start: "26:00", end: "27:00", price: 2, enabled: true }],
    }),
  ]);
  const product = await runtimeProduct(baseUrl, id);
  assert.equal(product.price, 8);
  assert.deepEqual(product.priceSchedule, []);
});

test("[BE][LISTINO-05] alias timedPrices resta supportato", async (t) => {
  const id = "menu_test_listino_timed";
  const { baseUrl } = await boot(t, [menuItem(id, "Listino Timed", 10, { timedPrices: normalActiveWindow(5.5) })]);
  const product = await runtimeProduct(baseUrl, id);
  assert.equal(product.price, 5.5);
});

test("[BE][LISTINO-06] alias timePriceSchedule resta supportato", async (t) => {
  const id = "menu_test_listino_time_price";
  const { baseUrl } = await boot(t, [menuItem(id, "Listino Time Price", 10, { timePriceSchedule: normalActiveWindow(5) })]);
  const product = await runtimeProduct(baseUrl, id);
  assert.equal(product.price, 5);
});

test("[BE][LISTINO-07] alias listinoTemporizzato resta supportato", async (t) => {
  const id = "menu_test_listino_temporizzato";
  const { baseUrl } = await boot(t, [menuItem(id, "Listino Temporizzato", 10, { listinoTemporizzato: normalActiveWindow(4) })]);
  const product = await runtimeProduct(baseUrl, id);
  assert.equal(product.price, 4);
});

test("[BE][LISTINO-08] ordine ignora total client vecchio più alto per prodotto di catalogo", async (t) => {
  const id = "menu_test_listino_order_total";
  const { baseUrl, session, deviceUuid } = await boot(t, [
    menuItem(id, "Listino Order Total", 10, { priceSchedule: normalActiveWindow(3.5) }),
  ]);
  const created = await createSimpleOrder(baseUrl, session, {
    deviceUuid,
    lines: [{ name: "Listino Order Total", productId: id, qty: 2, unitPriceApplied: 10, lineTotal: 20, price: 10 }],
    extraPayload: { total: 99 },
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.order.total, 7);
  assert.equal(created.body.order.items[0].unitPriceApplied, 3.5);
});

test("[BE][LISTINO-09] productId prevale sul nome quando risolve il prodotto", async (t) => {
  const id = "menu_test_listino_product_id";
  const { baseUrl, session, deviceUuid } = await boot(t, [
    menuItem(id, "Listino ProductId", 10, { priceSchedule: normalActiveWindow(4.25) }),
  ]);
  const created = await createSimpleOrder(baseUrl, session, {
    deviceUuid,
    lines: [{ name: "Nome Client Sbagliato", productId: id, qty: 1, unitPriceApplied: 99, lineTotal: 99 }],
    extraPayload: { total: 99 },
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.order.total, 4.25);
  assert.equal(created.body.order.items[0].productId, id);
});

test("[BE][LISTINO-10] fallback per nome funziona se productId manca", async (t) => {
  const id = "menu_test_listino_name_fallback";
  const { baseUrl, session, deviceUuid } = await boot(t, [
    menuItem(id, "Listino Nome Fallback", 10, { priceSchedule: normalActiveWindow(3.75) }),
  ]);
  const created = await createSimpleOrder(baseUrl, session, {
    deviceUuid,
    lines: [{ name: "Listino Nome Fallback", qty: 2, unitPriceApplied: 10, lineTotal: 20 }],
    extraPayload: { total: 20 },
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.order.total, 7.5);
  assert.equal(created.body.order.items[0].productId, id);
});

test("[BE][LISTINO-11] riga manuale non di catalogo mantiene il fallback esistente", async (t) => {
  const { baseUrl, session, deviceUuid } = await boot(t, []);
  const created = await createSimpleOrder(baseUrl, session, {
    deviceUuid,
    lines: [{ name: "Manuale fuori catalogo test", qty: 2, unitPriceApplied: 7, lineTotal: 14 }],
    extraPayload: { total: 99 },
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.order.total, 14);
  assert.equal(created.body.order.items[0].unitPriceApplied, 7);
});

test("[BE][LISTINO-12] variante usa prezzo runtime backend più delta", async (t) => {
  const id = "menu_test_listino_variant";
  const { baseUrl, session, deviceUuid } = await boot(t, [
    menuItem(id, "Listino Variante", 10, {
      priceSchedule: normalActiveWindow(4),
      variants: [{ id: "premium", name: "Premium", priceDelta: 1.5, enabled: true }],
      variantRequired: true,
    }),
  ]);
  const created = await createSimpleOrder(baseUrl, session, {
    deviceUuid,
    lines: [{ name: "Listino Variante", productId: id, qty: 1, variant: "Premium", unitPriceApplied: 10, lineTotal: 10 }],
    extraPayload: { total: 10 },
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.order.total, 5.5);
  assert.equal(created.body.order.items[0].selectedVariantPriceDelta, 1.5);
});

test("[BE][LISTINO-13] lineTotal client vecchio non sovrascrive riga catalogo", async (t) => {
  const id = "menu_test_listino_line_total";
  const { baseUrl, session, deviceUuid } = await boot(t, [
    menuItem(id, "Listino Line Total", 10, { priceSchedule: normalActiveWindow(2.5) }),
  ]);
  const created = await createSimpleOrder(baseUrl, session, {
    deviceUuid,
    lines: [{ name: "Listino Line Total", productId: id, qty: 3, lineTotal: 30, unitPriceApplied: 10 }],
    extraPayload: { total: 30 },
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.order.total, 7.5);
  assert.ok(created.body.order.items.every((item) => item.lineTotal === 2.5));
});

test("[BE][LISTINO-14] cache menu usa la finestra fascia attiva e non solo day/night", async (t) => {
  const id = "menu_test_listino_multi_boundary";
  const { baseUrl } = await boot(t, [
    menuItem(id, "Listino Multi Boundary", 10, {
      priceSchedule: [
        ...normalActiveWindow(4).map((rule) => ({ ...rule, id: "active-window" })),
        { id: "other-window", start: "20:00", end: "21:00", price: 2, enabled: true },
      ],
    }),
  ]);
  const first = await runtimeProduct(baseUrl, id);
  const second = await runtimeProduct(baseUrl, id);
  assert.equal(first.price, 4);
  assert.equal(second.price, 4);
  assert.equal(second.currentPriceScheduleId, "active-window");
});

test("[BE][LISTINO-15] prodotto senza schedule resta invariato", async (t) => {
  const id = "menu_test_listino_static";
  const { baseUrl } = await boot(t, [menuItem(id, "Listino Statico", 6)]);
  const product = await runtimeProduct(baseUrl, id);
  assert.equal(product.price, 6);
  assert.equal(product.basePrice, 6);
  assert.deepEqual(product.priceSchedule, []);
});

test("[BE][LISTINO-16] prezzo ordine resta quello delle 17:30 anche se pagato e stampato alle 18:30", async (t) => {
  const id = "menu_test_listino_snapshot_1730";
  const deviceUuid = "listino-snapshot-device";
  const printer = await startFakeTcpPrinter(t);
  const firstBackend = await startBackend(t, {
    env: {
      MENU_PRICE_SCHEDULE_NOW_ISO: "2026-05-22T15:30:00.000Z",
      PRINTING_ENABLED: "1",
      PRINT_TCP_TIMEOUT_MS: "1500",
    },
    stateOverrides(state) {
      installListinoPrinterConfig(state, printer.port);
      state.menuItems.push(
        menuItem(id, "Listino Snapshot 1730", 4, {
          priceSchedule: [
            { id: "diurno", label: "Diurno", start: "08:00", end: "18:00", price: 3.5, enabled: true },
            { id: "serale", label: "Serale", start: "18:00", end: "08:00", price: 4, enabled: true },
          ],
        })
      );
      state.meta.lastWriteAt = new Date().toISOString();
    },
  });
  const session = await loginJson(firstBackend.baseUrl, "cashier", "2222", {
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  const created = await createSimpleOrder(firstBackend.baseUrl, session, {
    deviceUuid,
    lines: [{ name: "Listino Snapshot 1730", productId: id, qty: 2, unitPriceApplied: 4, lineTotal: 8 }],
    extraPayload: { total: 8 },
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.order.total, 7);
  assert.equal(created.body.order.items[0].unitPriceApplied, 3.5);

  await waitForPrintedJob(
    firstBackend.dbPath,
    (job) => job.orderId === created.body.order.id && job.kind === "order"
  );
  await stopBackend(firstBackend.child);

  const secondBackend = await startBackend(t, {
    dbPath: firstBackend.dbPath,
    preserveDb: true,
    env: {
      MENU_PRICE_SCHEDULE_NOW_ISO: "2026-05-22T16:30:00.000Z",
      PRINTING_ENABLED: "1",
      PRINT_TCP_TIMEOUT_MS: "1500",
    },
  });

  const productAtPaymentTime = await runtimeProduct(secondBackend.baseUrl, id);
  assert.equal(productAtPaymentTime.price, 4);
  assert.equal(productAtPaymentTime.currentPriceScheduleId, "serale");

  const preconto = await apiPost(
    secondBackend.baseUrl,
    "/api/integration/print",
    authPayload(session, deviceUuid, { kind: "preconto", orderId: created.body.order.id })
  );
  assert.equal(preconto.response.status, 202);
  await waitForPrintedJob(
    secondBackend.dbPath,
    (job) => job.id === preconto.body.jobId && job.kind === "preconto"
  );

  const ready = await syncReady(secondBackend.baseUrl, session, deviceUuid, created.body.order.id);
  assert.equal(ready.response.status, 200);
  const paid = await payOrder(secondBackend.baseUrl, session, deviceUuid, created.body.order.id, 7);
  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.payment.status, "COMPLETED");
  assert.match(paid.body.paymentReceiptJobs?.[0]?.id ?? "", /^print_/);

  const { db, job: receiptJob } = await waitForPrintedJob(
    secondBackend.dbPath,
    (job) => job.id === paid.body.paymentReceiptJobs[0].id && ["payment", "payment_receipt"].includes(job.kind)
  );
  const persistedOrder = db.integration.orders.find((order) => order.id === created.body.order.id);
  assert.equal(persistedOrder.total, 7);
  assert.ok(persistedOrder.items.every((item) => item.unitPriceApplied === 3.5));
  assert.match(receiptJob.textPreview, /7[,.]00|7\s*€/i);
  assert.doesNotMatch(receiptJob.textPreview, /8[,.]00|8\s*€/i);
  const printedText = printer.text();
  assert.match(printedText, /LISTINO SNAPSHOT 1730/i);
  assert.match(printedText, /7[,.]00|7\s*€/i);
  assert.doesNotMatch(printedText, /8[,.]00|8\s*€/i);
});
