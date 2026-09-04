#!/usr/bin/env node
/**
 * Misura la latenza di ogni operazione del ciclo di vita di una comanda, isolandola.
 *
 * Per ciascuna operazione viene preparata una comanda nuova nello stato richiesto e poi
 * cronometrata solo la chiamata bersaglio: la preparazione non entra nel campione, quindi
 * i numeri sono confrontabili fra operazioni con prerequisiti diversi.
 *
 * L'emissione fiscale non e inclusa: sul banco punta a un registratore reale e una misura
 * significherebbe stampare scontrini veri.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { summarizeP5LatencySamples } from "./p5-latency-checkpoint.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

function parseArgs(argv) {
  const options = {
    baseUrl: "https://127.0.0.1:5380",
    username: "lorenzo",
    pin: "1234",
    iterations: 8,
    roomId: "",
    station: "",
    outDir: "",
    only: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inlineValue] = argv[index].split("=");
    const value = inlineValue ?? argv[index + 1];
    const consume = () => { if (inlineValue === undefined) index += 1; };
    switch (flag) {
      case "--base-url": options.baseUrl = value; consume(); break;
      case "--username": options.username = value; consume(); break;
      case "--pin": options.pin = value; consume(); break;
      case "--iterations": options.iterations = Number(value); consume(); break;
      case "--room": options.roomId = value; consume(); break;
      case "--station": options.station = value; consume(); break;
      case "--out-dir": options.outDir = value; consume(); break;
      case "--only": options.only = value; consume(); break;
      default: if (flag.startsWith("--")) throw new Error(`Argomento non riconosciuto: ${flag}`);
    }
  }
  return options;
}

async function post(baseUrl, pathName, payload, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}${pathName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return {
      ok: response.status < 400 && body?.ok !== false,
      status: response.status,
      body,
      durationMs: performance.now() - startedAt,
    };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: String(error?.message ?? error), durationMs: performance.now() - startedAt };
  } finally { clearTimeout(timer); }
}

async function get(baseUrl, pathName) {
  const startedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}${pathName}`, { headers: { Accept: "application/json" } });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body, durationMs: performance.now() - startedAt };
  } catch (error) {
    return { ok: false, status: 0, body: null, error: String(error?.message ?? error), durationMs: performance.now() - startedAt };
  }
}

const auth = (s, extra = {}) => ({ token: s.token, userId: s.userId, deviceUuid: s.deviceUuid, ...extra });

async function login(baseUrl, username, pin, deviceUuid) {
  const r = await post(baseUrl, "/api/auth/login", { username, pin, deviceUuid, clientApp: "mobile-frontend" });
  if (!r.ok || !r.body?.token) throw new Error(`login fallito: HTTP ${r.status}`);
  return { token: r.body.token, userId: r.body.user.id, deviceUuid };
}

export function buildOperationMatrix(context) {
  const { baseUrl, session, product, station } = context;
  const lock = (tableId, purpose) => post(baseUrl, "/api/tables/lock/acquire", auth(session, { tableId, purpose }));
  const release = (tableId, purpose) => post(baseUrl, "/api/tables/lock/release", auth(session, { tableId, purpose }));
  const createOrder = (table, seq) => post(baseUrl, "/api/integration/orders/create", auth(session, {
    source: "mobile-frontend", clientApp: "mobile-frontend",
    tableId: table.id, roomId: table.roomId, tableNumber: table.number ?? 1,
    lines: [{ name: product.name, productId: product.id, qty: 2, price: product.price }],
    idempotencyKey: `opmatrix-${session.deviceUuid}-${seq}`,
  }));
  const sync = (orderId, workflowStatus) => post(baseUrl, "/api/integration/orders/sync", auth(session, {
    id: orderId, order: { workflowStatus, station, ownerStation: station }, workflowReason: "operation-latency-matrix",
  }));

  /** Prepara una comanda e la porta allo stato richiesto, fuori dal cronometro. */
  const prepare = async (table, seq, target = "created") => {
    await lock(table.id, "opmatrix");
    const created = await createOrder(table, seq);
    const order = created.body?.order;
    if (!created.ok || !order?.id) throw new Error(`preparazione fallita: HTTP ${created.status}`);
    if (target === "created") return order;
    for (const stage of ["prep", "ready", "delivered"]) {
      const r = await sync(order.id, stage);
      if (!r.ok) throw new Error(`preparazione ${stage} fallita: HTTP ${r.status}`);
      if (stage === target) break;
    }
    const fresh = await get(baseUrl, `/api/integration/orders?includeDone=1&orderId=${order.id}`);
    const refreshed = (fresh.body?.orders ?? []).find((entry) => String(entry.id) === String(order.id));
    return refreshed ?? order;
  };

  return [
    { key: "lock.acquire", label: "Blocco tavolo", run: async (t) => { await release(t.id, "opmatrix"); return lock(t.id, "opmatrix"); } },
    { key: "lock.release", label: "Rilascio tavolo", setup: async (t) => { await lock(t.id, "opmatrix"); }, run: (t) => release(t.id, "opmatrix") },
    { key: "order.create", label: "Creazione comanda", setup: async (t) => { await lock(t.id, "opmatrix"); }, run: (t, seq) => createOrder(t, seq) },
    { key: "order.prep", label: "Presa in carico", prepare: "created", run: (t, seq, o) => sync(o.id, "prep") },
    { key: "order.ready", label: "Comanda pronta", prepare: "prep", run: (t, seq, o) => sync(o.id, "ready") },
    { key: "order.delivered", label: "Segna consegnato", prepare: "ready", run: (t, seq, o) => sync(o.id, "delivered") },
    { key: "print.order", label: "Stampa comanda", prepare: "created", run: (t, seq, o) => post(baseUrl, "/api/integration/print", auth(session, { kind: "order", orderId: o.id })) },
    { key: "print.preconto", label: "Stampa preconto", prepare: "ready", run: (t, seq, o) => post(baseUrl, "/api/integration/print", auth(session, { kind: "preconto", orderId: o.id, tableId: t.id, roomId: t.roomId })) },
    { key: "order.correct", label: "Modifica comanda", prepare: "created", run: (t, seq, o) => post(baseUrl, "/api/integration/orders/correct", auth(session, {
        tableId: t.id, roomId: t.roomId, orderId: o.id, expectedRevision: o.currentRevision ?? o.revision ?? 1,
        changedItems: [{ lineId: o.items?.[0]?.lineId, nextQuantity: 1 }], reason: "matrice latenze",
        idempotencyKey: `opmatrix-correct-${session.deviceUuid}-${seq}` })) },
    { key: "order.line.split", label: "Divisione riga", prepare: "created", run: (t, seq, o) => post(baseUrl, "/api/integration/orders/line/split", auth(session, {
        orderId: o.id, lineId: o.items?.[0]?.lineId, qty: 1, expectedRevision: o.currentRevision ?? o.revision ?? 1 })) },
    { key: "order.price.override", label: "Modifica prezzo riga", prepare: "created", run: (t, seq, o) => post(baseUrl, "/api/integration/orders/line/price-override", auth(session, {
        tableId: t.id, roomId: t.roomId, orderId: o.id, lineId: o.items?.[0]?.lineId, unitPriceApplied: 0.99,
        reason: "matrice latenze", expectedRevision: o.currentRevision ?? o.revision ?? 1,
        idempotencyKey: `opmatrix-price-${session.deviceUuid}-${seq}` })) },
    { key: "order.cancel", label: "Annullamento comanda", prepare: "created", run: (t, seq, o) => post(baseUrl, "/api/integration/orders/cancel", auth(session, {
        tableId: t.id, roomId: t.roomId, orderId: o.id, expectedRevision: o.currentRevision ?? o.revision ?? 1,
        reason: "matrice latenze", idempotencyKey: `opmatrix-cancel-${session.deviceUuid}-${seq}` })) },
    { key: "order.comp", label: "Reso / omaggio riga", prepare: "ready", run: (t, seq, o) => post(baseUrl, "/api/integration/orders/comp", auth(session, {
        tableId: t.id, roomId: t.roomId, orderId: o.id, originalLineId: o.items?.[0]?.lineId, quantity: 1,
        reason: "matrice latenze", idempotencyKey: `opmatrix-comp-${session.deviceUuid}-${seq}` })) },
    { key: "order.storno", label: "Storno riga", prepare: "ready", run: (t, seq, o) => post(baseUrl, "/api/integration/orders/storno", auth(session, {
        orderId: o.id, tableId: t.id, roomId: t.roomId, originalLineId: o.items?.[0]?.lineId, quantity: 1,
        reason: "matrice latenze", expectedRevision: o.currentRevision ?? o.revision ?? 1,
        idempotencyKey: `opmatrix-storno-${session.deviceUuid}-${seq}` })) },
    { key: "payment.table", label: "Pagamento tavolo", prepare: "delivered", run: (t, seq, o) => post(baseUrl, "/api/payments/table", auth(session, {
        // Il tavolo puo avere piu comande aperte: si passa contante abbondante, il resto
        // viene calcolato dal backend e non altera la misura della chiamata.
        tableId: t.id, paymentMethodId: "pay_cash", cashGiven: 500,
        idempotencyKey: `opmatrix-paytable-${session.deviceUuid}-${seq}` })) },
    { key: "payment.free_split", label: "Pagamento diviso", prepare: "delivered", run: (t, seq, o) => post(baseUrl, "/api/payments/free-split", auth(session, {
        tableId: t.id, roomId: t.roomId, orderId: o.id, splitType: "FREE_SPLIT", releaseTable: true,
        idempotencyKey: `opmatrix-split-${session.deviceUuid}-${seq}`,
        parts: [{ amountDue: Number((product.price * 2).toFixed(2)), transactions: [{ method: "CASH", methodId: "pay_cash", methodLabel: "Contanti", amountPaid: Number((product.price * 2).toFixed(2)), cashGiven: Number((product.price * 2).toFixed(2)) }] }] })) },
    { key: "table.sync", label: "Aggiornamento tavolo", run: (t) => post(baseUrl, "/api/integration/layout/table/sync", auth(session, {
        tableId: t.id, roomId: t.roomId, status: "occupied", occupancyState: "seated", covers: 2 })) },
    { key: "table.move", label: "Spostamento tavolo", needsSecondTable: true, setup: async (t, seq, o, t2) => {
        // Origine occupata e destinazione libera: lo spostamento e rifiutato altrimenti.
        await post(baseUrl, "/api/integration/layout/table/sync", auth(session, { tableId: t2.id, roomId: t2.roomId, status: "free", occupancyState: "free", covers: 0 }));
        await post(baseUrl, "/api/integration/layout/table/sync", auth(session, { tableId: t.id, roomId: t.roomId, status: "occupied", occupancyState: "seated", covers: 2 }));
        await lock(t.id, "table.move_source"); await lock(t2.id, "table.move_target"); },
      run: (t, seq, o, t2) => post(baseUrl, "/api/integration/layout/table/move", auth(session, { fromTableId: t.id, toTableId: t2.id })) },
    { key: "room.move.request", label: "Richiesta cambio sala", needsOtherRoom: true, setup: async (t) => { await lock(t.id, "opmatrix"); },
      run: (t, seq, o, t2, otherRoomId, targetTableId) => post(baseUrl, "/api/integration/layout/table/room-move/request", auth(session, {
        fromRoomId: t.roomId, targetRoomId: otherRoomId, fromTableId: t.id, fromTableLabel: String(t.number),
        targetTableIds: [targetTableId], targetTableLabels: ["1"] })) },
    { key: "drawer.open", label: "Apertura cassetto", run: () => post(baseUrl, "/api/integration/drawer/open", auth(session, {})) },
    { key: "station.state", label: "Stato postazione", run: () => post(baseUrl, "/api/integration/stations/state", auth(session, {
        clientApp: "postazione", station, active: true })) },
    { key: "read.orders", label: "Lettura comande", run: () => get(baseUrl, "/api/integration/orders?includeDone=1") },
    { key: "read.layout", label: "Lettura sala", run: () => get(baseUrl, "/api/integration/layout") },
    { key: "read.menu", label: "Lettura menu", run: () => get(baseUrl, "/api/integration/menu") },
  ];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const layout = await get(options.baseUrl, "/api/integration/layout");
  const rooms = layout.body?.rooms ?? [];
  const roomId = options.roomId || rooms[0]?.id;
  const otherRoomId = rooms.map((r) => r.id).find((id) => id !== roomId) ?? roomId;
  const tables = (layout.body?.tables ?? [])
    .filter((entry) => String(entry.roomId) === String(roomId))
    .map((entry, index) => ({ id: String(entry.id), roomId: String(entry.roomId), number: Number(entry.number) || index + 1 }));
  if (tables.length < 2) throw new Error(`servono almeno 2 tavoli nella sala ${roomId}`);

  const menu = await get(options.baseUrl, "/api/integration/menu");
  const candidate = (menu.body?.products ?? []).find((entry) => Number(entry?.price) > 0);
  const product = { id: String(candidate.id), name: String(candidate.name), price: Number(candidate.price) };
  const station = options.station || menu.body?.stations?.[0] || "BAR-1";

  const session = await login(options.baseUrl, options.username, options.pin, `opmatrix-${Date.now()}`);
  const operations = buildOperationMatrix({ baseUrl: options.baseUrl, session, product, station })
    .filter((op) => !options.only || op.key.includes(options.only));

  // Le esecuzioni precedenti usano un device diverso e lasciano lock attivi sui tavoli:
  // senza rilascio forzato ogni operazione fallirebbe con "tavolo gia in modifica".
  for (const table of tables) {
    await post(options.baseUrl, "/api/tables/lock/force-release", auth(session, { tableId: table.id }));
  }
  const pending = await get(options.baseUrl, "/api/integration/orders?includeDone=1");
  const stuck = (pending.body?.orders ?? []).filter((entry) => ["prep", "waiting"].includes(String(entry.workflowStatus)));
  for (const entry of stuck) await drainOrder(options.baseUrl, session, station, entry.id);
  process.stdout.write(
    `[matrice] ${options.baseUrl} sala=${roomId} postazione=${station} iterazioni=${options.iterations}` +
      (stuck.length > 0 ? ` (svuotate ${stuck.length} comande rimaste in preparazione)` : "") + "\n\n",
  );
  const results = [];
  let seq = Date.now();
  const otherRoomTableId = String(
    (layout.body?.tables ?? []).find((entry) => String(entry.roomId) === String(otherRoomId))?.id ?? "",
  );

  for (const operation of operations) {
    const samples = [];
    const failures = [];
    for (let round = 0; round < options.iterations; round += 1) {
      seq += 1;
      const table = tables[round % tables.length];
      const secondTable = tables[(round + 1) % tables.length];
      try {
        let order = null;
        if (operation.prepare) order = await prepareFor(operation, table, seq);
        if (operation.setup) await operation.setup(table, seq, order, secondTable);
        const result = await operation.run(table, seq, order, secondTable, otherRoomId, otherRoomTableId);
        if (order?.id) await drainOrder(options.baseUrl, session, station, order.id);
        if (result.ok) samples.push({ durationMs: result.durationMs });
        else failures.push(`HTTP ${result.status}${result.body?.error ? ` ${String(result.body.error).slice(0, 60)}` : ""}`);
      } catch (error) {
        failures.push(String(error?.message ?? error).slice(0, 70));
      }
    }
    const summary = samples.length > 0 ? summarizeP5LatencySamples(samples) : null;
    results.push({ key: operation.key, label: operation.label, ok: samples.length, failed: failures.length, summary, failures: [...new Set(failures)].slice(0, 2) });
    process.stdout.write(
      `${operation.label.padEnd(26)} ${String(samples.length).padStart(2)}/${options.iterations}` +
        (summary ? `  p50 ${String(summary.p50ms).padStart(5)} ms  p95 ${String(summary.p95ms).padStart(5)} ms  max ${String(Math.round(summary.maxMs)).padStart(5)} ms` : "  non misurata") +
        (failures.length > 0 ? `  [${[...new Set(failures)][0]}]` : "") + "\n",
    );

    async function prepareFor(op, tableRef, sequence) {
      const context = buildOperationMatrix({ baseUrl: options.baseUrl, session, product, station });
      void context;
      return prepareOrder(options.baseUrl, session, product, station, tableRef, sequence, op.prepare);
    }
  }

  if (options.outDir) {
    await mkdir(options.outDir, { recursive: true });
    const file = path.join(options.outDir, `operation-matrix-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await writeFile(file, `${JSON.stringify({ baseUrl: options.baseUrl, roomId, station, iterations: options.iterations, results }, null, 2)}\n`, "utf8");
    process.stdout.write(`\nreport: ${file}\n`);
  }
  return 0;
}

/** Porta la comanda fuori dalla corsia di preparazione, che accetta al massimo 3 comande. */
async function drainOrder(baseUrl, session, station, orderId) {
  for (const stage of ["ready", "delivered"]) {
    await post(baseUrl, "/api/integration/orders/sync", auth(session, {
      id: orderId, order: { workflowStatus: stage, station, ownerStation: station }, workflowReason: "opmatrix-drain",
    }));
  }
}

/** Preparazione condivisa: fuori dal cronometro dell'operazione misurata. */
async function prepareOrder(baseUrl, session, product, station, table, seq, target) {
  await post(baseUrl, "/api/tables/lock/acquire", auth(session, { tableId: table.id, purpose: "opmatrix" }));
  const created = await post(baseUrl, "/api/integration/orders/create", auth(session, {
    source: "mobile-frontend", clientApp: "mobile-frontend",
    tableId: table.id, roomId: table.roomId, tableNumber: table.number ?? 1,
    lines: [{ name: product.name, productId: product.id, qty: 2, price: product.price }],
    idempotencyKey: `opmatrix-prep-${session.deviceUuid}-${seq}`,
  }));
  const order = created.body?.order;
  if (!created.ok || !order?.id) throw new Error(`preparazione fallita HTTP ${created.status}`);
  if (target === "created") return order;
  for (const stage of ["prep", "ready", "delivered"]) {
    const r = await post(baseUrl, "/api/integration/orders/sync", auth(session, {
      id: order.id, order: { workflowStatus: stage, station, ownerStation: station }, workflowReason: "opmatrix-prep",
    }));
    if (!r.ok) throw new Error(`preparazione ${stage} HTTP ${r.status}`);
    if (stage === target) break;
  }
  const fresh = await get(baseUrl, `/api/integration/orders?includeDone=1&orderId=${order.id}`);
  return (fresh.body?.orders ?? []).find((entry) => String(entry.id) === String(order.id)) ?? order;
}

main().then((code) => process.exit(code)).catch((error) => {
  process.stderr.write(`[matrice] errore: ${error?.message ?? error}\n`);
  process.exit(2);
});
