#!/usr/bin/env node
/**
 * Cronometra la catena completa di una singola comanda, fase per fase:
 *
 *   lock tavolo -> orders/create -> sync prep -> sync ready -> sync delivered
 *                -> payments/free-split -> release lock
 *
 * Gli strumenti esistenti (loadtest-full-capacity, run-v5bt-operations-30) misurano le
 * stesse operazioni ma come campioni indipendenti sotto carico misto: non dicono quanto
 * impiega una comanda ad attraversare il flusso. Serve per separare la latenza del
 * percorso da quella dovuta alla contesa.
 *
 * Opera su un server gia avviato (locale o Raspberry), non ne avvia uno.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { summarizeP5LatencySamples } from "./p5-latency-checkpoint.mjs";
import {
  V5BT_ACTION_MAX_MS,
  V5BT_ACTION_P95_MAX_MS,
} from "./v5bt-operations-gates.mjs";

// I banchi V5BT usano certificati self-signed di LAN.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const PHASES = Object.freeze([
  "lock",
  "create",
  "sync.prep",
  "sync.ready",
  "sync.delivered",
  "payment",
  "release",
]);

function parseArgs(argv) {
  const options = {
    baseUrl: "https://127.0.0.1:5380",
    username: "lorenzo",
    pin: "1234",
    cycles: 10,
    concurrency: 1,
    roomId: "",
    station: "",
    productId: "",
    price: 0,
    skipPayment: false,
    skipWorkflow: false,
    outDir: "",
    label: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inlineValue] = argv[index].split("=");
    const value = inlineValue ?? argv[index + 1];
    const consume = () => {
      if (inlineValue === undefined) index += 1;
    };
    switch (flag) {
      case "--base-url": options.baseUrl = value; consume(); break;
      case "--username": options.username = value; consume(); break;
      case "--pin": options.pin = value; consume(); break;
      case "--cycles": options.cycles = Number(value); consume(); break;
      case "--concurrency": options.concurrency = Number(value); consume(); break;
      case "--room": options.roomId = value; consume(); break;
      case "--station": options.station = value; consume(); break;
      case "--product": options.productId = value; consume(); break;
      case "--price": options.price = Number(value); consume(); break;
      case "--label": options.label = value; consume(); break;
      case "--out-dir": options.outDir = value; consume(); break;
      case "--skip-payment": options.skipPayment = true; break;
      // Salta prep/ready/delivered: serve a isolare la corsia pagamenti dal tetto di
      // comande in preparazione per postazione, che a concorrenza alta domina i fallimenti.
      case "--skip-workflow": options.skipWorkflow = true; break;
      default:
        if (flag.startsWith("--")) throw new Error(`Argomento non riconosciuto: ${flag}`);
    }
  }
  if (!Number.isInteger(options.cycles) || options.cycles < 1) {
    throw new Error("--cycles deve essere un intero positivo.");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("--concurrency deve essere un intero positivo.");
  }
  return options;
}

async function postJson(baseUrl, pathName, payload, timeoutMs = 60_000) {
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
      ok: response.ok && body?.ok !== false,
      status: response.status,
      body,
      durationMs: performance.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: error?.name === "AbortError" ? `timeout ${timeoutMs}ms` : String(error?.message ?? error),
      durationMs: performance.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(baseUrl, pathName, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${pathName}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    return await response.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function login(baseUrl, username, pin, deviceUuid) {
  const result = await postJson(baseUrl, "/api/auth/login", {
    username,
    pin,
    deviceUuid,
    clientApp: "mobile-frontend",
  });
  if (!result.ok || !result.body?.token) {
    throw new Error(`Login fallito per ${username}: HTTP ${result.status} ${result.error ?? ""}`);
  }
  return {
    token: result.body.token,
    userId: result.body.user.id,
    username: result.body.user.username,
    deviceUuid,
  };
}

const auth = (session, extra = {}) => ({
  token: session.token,
  userId: session.userId,
  deviceUuid: session.deviceUuid,
  ...extra,
});

/**
 * Un ciclo completo. Registra la durata di ogni fase separatamente; si ferma alla prima
 * fase fallita, cosi il campione non contiene tempi di fasi mai realmente eseguite.
 */
async function runCycle({ baseUrl, session, table, product, station, ordinal, skipPayment, skipWorkflow }) {
  const phases = [];
  const record = (phase, result) => {
    phases.push({
      phase,
      durationMs: result.durationMs,
      ok: result.ok,
      status: result.status,
      error: result.error ?? (result.ok ? undefined : result.body?.error),
    });
    return result;
  };

  const purpose = "order-payment-chain-latency";
  const lock = record(
    "lock",
    await postJson(baseUrl, "/api/tables/lock/acquire", auth(session, { tableId: table.id, purpose })),
  );
  if (!lock.ok) return { ordinal, phases, orderId: null, completed: false };

  const create = record(
    "create",
    await postJson(baseUrl, "/api/integration/orders/create", auth(session, {
      source: "mobile-frontend",
      clientApp: "mobile-frontend",
      tableId: table.id,
      roomId: table.roomId,
      tableNumber: table.number ?? 1,
      lines: [{ name: product.name, productId: product.id, qty: 1, price: product.price }],
      idempotencyKey: `chain-lat-${session.deviceUuid}-${ordinal}`,
    })),
  );
  const orderId = String(create.body?.order?.id ?? "").trim();
  if (!create.ok || !orderId) {
    await postJson(baseUrl, "/api/tables/lock/release", auth(session, { tableId: table.id, purpose }));
    return { ordinal, phases, orderId: null, completed: false };
  }

  const sync = (workflowStatus) =>
    postJson(baseUrl, "/api/integration/orders/sync", auth(session, {
      id: orderId,
      order: { workflowStatus, station, ownerStation: station },
      workflowReason: "chain-latency-bench",
    }));

  if (!skipWorkflow) {
    for (const status of ["prep", "ready", "delivered"]) {
      const result = record(`sync.${status}`, await sync(status));
      if (!result.ok) {
        await postJson(baseUrl, "/api/tables/lock/release", auth(session, { tableId: table.id, purpose }));
        return { ordinal, phases, orderId, completed: false };
      }
    }
  }

  if (!skipPayment) {
    // receiptType assente: il backend emette scontrino solo con "scontrino" o "fattura",
    // quindi la misura non tocca l'RT fiscale.
    const payment = record(
      "payment",
      await postJson(baseUrl, "/api/payments/free-split", auth(session, {
        tableId: table.id,
        roomId: table.roomId,
        orderId,
        splitType: "FREE_SPLIT",
        idempotencyKey: `chain-lat-pay-${session.deviceUuid}-${ordinal}`,
        releaseTable: true,
        parts: [{
          amountDue: product.price,
          transactions: [{
            method: "CASH",
            methodId: "pay_cash",
            methodLabel: "Contanti",
            amountPaid: product.price,
            cashGiven: product.price,
          }],
        }],
      })),
    );
    if (!payment.ok) {
      await postJson(baseUrl, "/api/tables/lock/release", auth(session, { tableId: table.id, purpose }));
      return { ordinal, phases, orderId, completed: false };
    }
  }

  record(
    "release",
    await postJson(baseUrl, "/api/tables/lock/release", auth(session, { tableId: table.id, purpose })),
  );
  return { ordinal, phases, orderId, completed: true };
}

async function resolveFixtures(baseUrl, options) {
  const layout = await getJson(baseUrl, "/api/integration/layout");
  if (!layout?.tables?.length) throw new Error("Layout non disponibile: nessun tavolo.");
  const roomId = options.roomId || layout.rooms?.[0]?.id;
  const tables = layout.tables
    .filter((entry) => String(entry.roomId ?? "") === String(roomId))
    .map((entry, index) => ({
      id: String(entry.id),
      roomId: String(entry.roomId),
      number: Number(entry.number) || index + 1,
    }));
  if (tables.length === 0) throw new Error(`Nessun tavolo nella sala ${roomId}.`);

  let product = { id: options.productId, name: "Caffe", price: options.price };
  if (!product.id || !product.price) {
    const menu = await getJson(baseUrl, "/api/integration/menu");
    const candidate = (menu?.products ?? []).find(
      (entry) => Number(entry?.price) > 0 && String(entry?.id ?? "").trim(),
    );
    if (!candidate) throw new Error("Nessun prodotto con prezzo nel menu.");
    product = {
      id: String(candidate.id),
      name: String(candidate.name ?? "Articolo"),
      price: Number(candidate.price),
    };
  }

  const menu = await getJson(baseUrl, "/api/integration/menu");
  const station = options.station || menu?.stations?.[0] || "BAR-1";
  return { tables, product, station, roomId };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { tables, product, station, roomId } = await resolveFixtures(options.baseUrl, options);

  const startedAt = new Date();
  const runLabel = options.label || `chain-${startedAt.toISOString().replace(/[:.]/g, "").slice(0, 15)}`;
  process.stdout.write(
    `[chain] ${options.baseUrl} sala=${roomId} postazione=${station} articolo=${product.name} ` +
      `${product.price}€ cicli=${options.cycles} concorrenza=${options.concurrency}\n`,
  );

  // Una sessione per worker: device distinti, come palmari diversi.
  const workers = await Promise.all(
    Array.from({ length: options.concurrency }, (_, index) =>
      login(options.baseUrl, options.username, options.pin, `chain-lat-${runLabel}-w${index}`),
    ),
  );

  const cycles = [];
  let nextOrdinal = 0;
  const wallStart = performance.now();

  await Promise.all(
    workers.map(async (session, workerIndex) => {
      // Insiemi di tavoli disgiunti per costruzione: due worker non possono contendersi
      // lo stesso lock, altrimenti si misurerebbe la collisione del banco invece della
      // catena. Con meno tavoli che worker qualcuno resta senza, e va detto.
      const ownTables = tables.filter((_, index) => index % options.concurrency === workerIndex);
      let localCycle = 0;
      while (true) {
        const ordinal = nextOrdinal++;
        if (ordinal >= options.cycles) return;
        if (ownTables.length === 0) return;
        const table = ownTables[localCycle++ % ownTables.length];
        const cycle = await runCycle({
          baseUrl: options.baseUrl,
          session,
          table,
          product,
          station,
          ordinal,
          skipPayment: options.skipPayment,
          skipWorkflow: options.skipWorkflow,
        });
        cycles.push({ ...cycle, worker: workerIndex, tableId: table.id });
        const failed = cycle.phases.find((entry) => !entry.ok);
        process.stdout.write(
          failed
            ? `  ciclo ${ordinal} FALLITO in ${failed.phase} (HTTP ${failed.status}) ${failed.error ?? ""}\n`
            : `  ciclo ${ordinal} ok in ${Math.round(cycle.phases.reduce((sum, p) => sum + p.durationMs, 0))} ms\n`,
        );
      }
    }),
  );

  const wallMs = performance.now() - wallStart;
  const byPhase = {};
  for (const phase of PHASES) {
    const samples = cycles
      .flatMap((cycle) => cycle.phases)
      .filter((entry) => entry.phase === phase && entry.ok)
      .map((entry) => ({ durationMs: entry.durationMs }));
    if (samples.length > 0) {
      const summary = summarizeP5LatencySamples(samples);
      byPhase[phase] = { ...summary, maxMs: Math.round(summary.maxMs) };
    }
  }
  const totals = cycles
    .filter((cycle) => cycle.completed)
    .map((cycle) => ({ durationMs: cycle.phases.reduce((sum, entry) => sum + entry.durationMs, 0) }));

  const report = {
    schemaVersion: 1,
    mode: "ORDER_PAYMENT_CHAIN_LATENCY",
    label: runLabel,
    generatedAt: startedAt.toISOString(),
    target: { baseUrl: options.baseUrl, roomId, station, product },
    profile: {
      cycles: options.cycles,
      concurrency: options.concurrency,
      skipPayment: options.skipPayment,
      skipWorkflow: options.skipWorkflow,
    },
    execution: {
      cyclesCompleted: cycles.filter((cycle) => cycle.completed).length,
      cyclesFailed: cycles.filter((cycle) => !cycle.completed).length,
      wallClockMs: Math.round(wallMs),
    },
    budgets: { actionP95MaxMs: V5BT_ACTION_P95_MAX_MS, actionMaxMs: V5BT_ACTION_MAX_MS },
    byPhase,
    chainTotal: (() => {
      const summary = summarizeP5LatencySamples(totals);
      return { ...summary, maxMs: Math.round(summary.maxMs) };
    })(),
    failures: cycles
      .filter((cycle) => !cycle.completed)
      .map((cycle) => {
        const failed = cycle.phases.find((entry) => !entry.ok);
        return {
          ordinal: cycle.ordinal,
          phase: failed?.phase ?? "unknown",
          status: failed?.status ?? 0,
          error: failed?.error ?? null,
        };
      }),
    orderIds: cycles.map((cycle) => cycle.orderId).filter(Boolean),
  };

  process.stdout.write("\n=== Latenza per fase (ms) ===\n");
  process.stdout.write("fase              n     p50     p95     max   budget\n");
  for (const phase of PHASES) {
    const summary = byPhase[phase];
    if (!summary) continue;
    const over = summary.p95ms > V5BT_ACTION_P95_MAX_MS ? "  FUORI BUDGET" : "";
    process.stdout.write(
      `${phase.padEnd(16)} ${String(summary.count).padStart(3)} ` +
        `${String(summary.p50ms).padStart(7)} ${String(summary.p95ms).padStart(7)} ` +
        `${String(summary.maxMs).padStart(7)} ${String(V5BT_ACTION_P95_MAX_MS).padStart(8)}${over}\n`,
    );
  }
  process.stdout.write(
    `${"CATENA".padEnd(16)} ${String(report.chainTotal.count).padStart(3)} ` +
      `${String(report.chainTotal.p50ms).padStart(7)} ${String(report.chainTotal.p95ms).padStart(7)} ` +
      `${String(report.chainTotal.maxMs).padStart(7)}\n`,
  );
  process.stdout.write(
    `\ncicli completati ${report.execution.cyclesCompleted}/${options.cycles}, ` +
      `falliti ${report.execution.cyclesFailed}, durata ${Math.round(wallMs)} ms\n`,
  );

  if (options.outDir) {
    await mkdir(options.outDir, { recursive: true });
    const file = path.join(options.outDir, `${runLabel}.json`);
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`report: ${file}\n`);
  }
  return report.execution.cyclesFailed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`[chain] errore: ${error?.message ?? error}\n`);
    process.exit(2);
  });
