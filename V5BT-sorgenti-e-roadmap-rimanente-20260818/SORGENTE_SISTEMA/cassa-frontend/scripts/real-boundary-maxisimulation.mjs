import { promises as fs } from "node:fs";
import path from "node:path";
import { readJson, startBackend } from "../backend/tests/helpers/test-server.mjs";

const REAL_PRINTER_HOST = process.env.REAL_TEST_PRINTER_HOST || "192.168.1.100";
const REAL_PRINTER_PORT = Number(process.env.REAL_TEST_PRINTER_PORT || 9100);
const TABLE_5 = { id: "room_pedana_t05", roomId: "room_pedana", number: 5 };
const TABLE_6 = { id: "room_pedana_t06", roomId: "room_pedana", number: 6 };
const TABLE_SALA_1 = { id: "room_sala_t01", roomId: "room_sala", number: 1 };
const TABLE_SALA_2 = { id: "room_sala_t02", roomId: "room_sala", number: 2 };

function installRealPrinterConfig(state) {
  const printer = {
    id: "printer_real_boundary",
    name: "Stampante Reale Boundary",
    host: REAL_PRINTER_HOST,
    port: REAL_PRINTER_PORT,
    purpose: "generic",
    active: true,
  };
  const roomIds = ["room_pedana", "room_sala", "sala_terrazza"];
  state.posSettings.printers = [printer];
  state.posSettings.areas = roomIds.map((id) => ({
    id,
    name: id === "sala_terrazza" ? "Terrazza" : id === "room_sala" ? "Sala" : "Pedana",
    printerIds: [printer.id],
    cashPoints: [
      {
        id: `${id}_cash`,
        name: `${id} cassa`,
        printerIds: [printer.id],
        fiscalPrinterId: null,
      },
    ],
    workstations: [
      {
        id: `${id}_station`,
        name: "BAR PRINCIPALE",
        stationName: "BAR PRINCIPALE",
        printerIds: [printer.id],
      },
    ],
  }));
}

function line(name, price, quantity = 1, extra = {}) {
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

function total(lines) {
  return Number(
    lines
      .reduce((sum, entry) => sum + (Number(entry.price ?? entry.unitPrice) || 0) * (Number(entry.qty ?? entry.quantity) || 1), 0)
      .toFixed(2)
  );
}

function findOrder(state, orderId) {
  return state.integration.orders.find((order) => String(order.id) === String(orderId));
}

async function waitForPrintJobs(dbPath, options = {}) {
  const minJobs = options.minJobs ?? 1;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const startedAt = Date.now();
  let lastState = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await readJson(dbPath);
    const jobs = Array.isArray(lastState.printSpoolJobs) ? lastState.printSpoolJobs : [];
    const relevant = jobs.filter((job) => ["queued", "processing", "printed", "failed"].includes(String(job?.status ?? "")));
    const pending = relevant.filter((job) => ["queued", "processing"].includes(String(job?.status ?? "")));
    if (relevant.length >= minJobs && pending.length === 0) return lastState;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return lastState || readJson(dbPath);
}

function orderLineId(order, productId) {
  const item = (order.items ?? []).find((entry) => String(entry.productId ?? "") === productId);
  if (!item) throw new Error(`Linea non trovata per ${productId}`);
  return item.lineId;
}

async function main() {
  const cleanups = [];
  const harness = {
    after(fn) {
      cleanups.push(fn);
    },
  };
  const backend = await startBackend(harness, {
    env: {
      PRINTING_ENABLED: "1",
      PRINT_TCP_TIMEOUT_MS: "3500",
    },
    stateOverrides: installRealPrinterConfig,
  });

  let auth = null;
  const deviceUuid = `real-boundary-${Date.now()}`;

  async function request(pathName, payload = {}, options = {}) {
    const method = options.method || "POST";
    const headers = { "Content-Type": "application/json" };
    let url = `${backend.baseUrl}${pathName}`;
    const bodyPayload = {
      ...(auth || {}),
      ...payload,
    };
    if (auth) {
      headers.Authorization = `Bearer ${auth.token}`;
      headers["X-User-Id"] = auth.userId;
      headers["X-Device-Uuid"] = auth.deviceUuid;
    }
    const init = { method, headers };
    if (method === "GET") {
      const params = new URLSearchParams();
      Object.entries(bodyPayload).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
      });
      url += `?${params}`;
    } else {
      init.body = JSON.stringify(bodyPayload);
    }
    const response = await fetch(url, init);
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    const expectedStatus = options.expectedStatus || 200;
    if (response.status !== expectedStatus) {
      throw new Error(`${method} ${pathName} expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(body)}`);
    }
    return body;
  }

  async function login() {
    const body = await request("/api/auth/login", {
      username: "manager",
      pin: "4444",
      deviceUuid,
      clientApp: "mobile-frontend",
    });
    auth = {
      token: body.token,
      userId: body.user?.id || "u_manager",
      username: body.user?.username || "manager",
      fullName: body.user?.fullName || "Manager Test",
      deviceUuid,
      roomId: "room_pedana",
      roomName: "Pedana",
      clientApp: "mobile-frontend",
    };
  }

  async function lock(table, purpose) {
    return request("/api/tables/lock/acquire", { tableId: table.id, purpose });
  }

  async function syncTable(table, payload) {
    await lock(table, "real.boundary.table.sync");
    return request("/api/integration/layout/table/sync", {
      tableId: table.id,
      roomId: table.roomId,
      tableNumber: table.number,
      ...payload,
    });
  }

  async function createOrder(table, lines, payload = {}) {
    await lock(table, "real.boundary.order.create");
    return request("/api/integration/orders/create", {
      source: "mobile-frontend",
      tableId: table.id,
      roomId: table.roomId,
      tableNumber: table.number,
      covers: payload.covers ?? 2,
      note: payload.note || "",
      orderNote: payload.note || "",
      communications: payload.communications || "",
      orderComment: payload.communications || "",
      total: payload.total ?? total(lines),
      lines,
    });
  }

  async function ready(orderId) {
    return request("/api/integration/orders/sync", {
      id: orderId,
      order: {
        workflowStatus: "ready",
        station: "BAR PRINCIPALE",
        ownerStation: "BAR PRINCIPALE",
      },
    });
  }

  async function pay(table, orderId, amount, payload = {}) {
    await lock(table, "real.boundary.payment");
    return request("/api/payments/free-split", {
      tableId: table.id,
      roomId: table.roomId,
      orderId,
      splitType: "FREE_SPLIT",
      splitMode: payload.splitMode,
      articleUnitIds: payload.articleUnitIds,
      idempotencyKey: payload.idempotencyKey || `real-pay-${orderId}-${Date.now()}-${Math.random()}`,
      note: payload.note,
      parts: [
        {
          amountDue: amount,
          transactions: [
            {
              method: payload.method || "CASH",
              methodId: payload.methodId || "pay_cash",
              methodLabel: payload.methodLabel || "Contanti",
              amountPaid: amount,
              cashGiven: payload.cashGiven ?? amount,
              note: payload.txNote,
              posProvider: payload.posProvider,
              posTxRef: payload.posTxRef,
            },
          ],
        },
      ],
    }, { expectedStatus: payload.expectedStatus || 200 });
  }

  async function comp(order, table, payload = {}) {
    await lock(table, "real.boundary.comp");
    return request("/api/integration/orders/comp", {
      tableId: table.id,
      roomId: table.roomId,
      orderId: order.id,
      originalLineId: payload.originalLineId || order.items?.[0]?.lineId,
      quantity: payload.quantity || 1,
      reason: payload.reason || "Reso boundary reale",
      sendReplacement: payload.sendReplacement,
      idempotencyKey: `real-comp-${order.id}-${Date.now()}-${Math.random()}`,
    });
  }

  async function cancel(order, table, reason) {
    await lock(table, "real.boundary.cancel");
    return request("/api/integration/orders/cancel", {
      tableId: table.id,
      roomId: table.roomId,
      orderId: order.id,
      expectedRevision: order.revision || order.currentRevision || 1,
      reason,
      idempotencyKey: `real-cancel-${order.id}-${Date.now()}`,
    });
  }

  try {
    await login();
    await request("/api/integration/stations/state", {
      station: "BAR PRINCIPALE",
      active: true,
      autoPrintOrders: true,
      autoPrintPreconto: true,
      operatorUserId: "u_manager",
      operatorUsername: "manager",
      operatorName: "Manager Test",
      operatorRole: "Responsabile",
    });

    await syncTable(TABLE_5, {
      occupancyState: "seated",
      covers: 5,
      note: "TEST REALE BOUNDARY - tavolo principale",
    });
    const main = await createOrder(
      TABLE_5,
      [
        line("Bloody Mary", 8, 1, { productId: "menu_drink_bloody_mary" }),
        line("Caffe", 1.3, 1, { productId: "menu_caffetteria_caffe" }),
      ],
      {
        total: 9.3,
        note: "TEST REALE: ordine, preconto, storno e pagamento",
        communications: "Documento generato da maxisimulazione automatica",
      }
    );
    await ready(main.order.id);
    await request("/api/integration/print", { kind: "order", orderId: main.order.id });
    await request("/api/integration/print", { kind: "preconto", orderId: main.order.id });

    await pay(TABLE_5, main.order.id, 1.3, {
      articleUnitIds: [`${main.order.id}_1_0`],
      note: "TEST REALE pagamento articolo caffe",
      txNote: "TEST REALE transazione articolo",
    });
    let state = await readJson(backend.dbPath);
    const afterPayment = findOrder(state, main.order.id);
    await comp(afterPayment, TABLE_5, {
      originalLineId: orderLineId(afterPayment, "menu_caffetteria_caffe"),
      reason: "TEST REALE storno articolo gia pagato",
    });

    await lock(TABLE_5, "real.boundary.move.source");
    await lock(TABLE_SALA_1, "real.boundary.move.target");
    await request("/api/integration/layout/table/move", {
      fromTableId: TABLE_5.id,
      toTableId: TABLE_SALA_1.id,
      roomId: TABLE_5.roomId,
      targetRoomId: TABLE_SALA_1.roomId,
    });
    await request("/api/integration/print", { kind: "order", orderId: main.order.id });
    await request("/api/integration/print", { kind: "preconto", orderId: main.order.id });

    await request("/api/integration/table-groups/save", {
      groups: [
        {
          id: TABLE_SALA_1.id,
          type: "complex",
          children: [
            { id: TABLE_SALA_1.id, type: "simple" },
            { id: TABLE_SALA_2.id, type: "simple" },
          ],
        },
      ],
    });
    const child = await createOrder(TABLE_SALA_2, [line("Latte Macchiato", 1.5, 1, { productId: "menu_caffetteria_latte_macchiato" })], {
      total: 1.5,
      note: "TEST REALE sostituzione a carico bar",
    });
    await ready(child.order.id);
    state = await waitForPrintJobs(backend.dbPath, { minJobs: 12 });
    const childReady = findOrder(state, child.order.id);
    await comp(childReady, TABLE_SALA_1, {
      originalLineId: orderLineId(childReady, "menu_caffetteria_latte_macchiato"),
      sendReplacement: true,
      reason: "TEST REALE sostituzione prodotto",
    });

    const cancelCandidate = await createOrder(TABLE_6, [line("Cappuccino", 1.6, 1, { productId: "menu_caffetteria_cappuccino" })], {
      total: 1.6,
      note: "TEST REALE ordine da annullare",
    });
    await cancel(cancelCandidate.order, TABLE_6, "TEST REALE annullamento comanda");

    state = await waitForPrintJobs(backend.dbPath, { minJobs: 18 });
    const mainAfterComp = findOrder(state, main.order.id);
    await pay(TABLE_SALA_1, main.order.id, mainAfterComp.dueAmount, {
      note: "TEST REALE saldo finale",
      txNote: "TEST REALE chiusura maxisimulazione",
    });

    await syncTable(TABLE_SALA_1, { occupancyState: "free" });
    await syncTable(TABLE_SALA_2, { occupancyState: "free" });
    await syncTable(TABLE_6, { occupancyState: "free" });
    await request("/api/integration/table-groups/save", { groups: [] });

    state = await waitForPrintJobs(backend.dbPath, { minJobs: 18 });
    const printJobs = (state.printSpoolJobs || []).map((job) => ({
      id: job.id,
      kind: job.kind,
      orderId: job.orderId,
      status: job.status,
      printerName: job.printerName,
      printerHost: job.printerHost,
      printerPort: job.printerPort,
    }));
    const report = {
      ok: true,
      printer: `${REAL_PRINTER_HOST}:${REAL_PRINTER_PORT}`,
      backendDbPath: backend.dbPath,
      orders: {
        main: main.order.id,
        child: child.order.id,
        cancelled: cancelCandidate.order.id,
      },
      printJobs,
      printedCount: printJobs.filter((job) => job.status === "printed").length,
      failedPrints: printJobs.filter((job) => job.status === "failed"),
    };
    const reportPath = `/srv/applicazione/data/real-boundary-maxisim-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: true, reportPath, printedCount: report.printedCount, failedPrints: report.failedPrints.length }, null, 2));
    if (report.failedPrints.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        // best effort shutdown
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
