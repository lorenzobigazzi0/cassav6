#!/usr/bin/env node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { hashPin } from "../backend/auth/password.js";
import {
  createAuditEventsSplitRepository,
  createDeviceStatusSplitRepository,
  createOrdersSplitRepository,
  createPaymentsFiscalSplitRepository,
  createPrintSpoolJobsSplitRepository,
  createTableLocksSplitRepository,
  createTableStateSplitRepository,
} from "../backend/db/app-state/index.js";
import {
  createAutomaticCashConfigSet,
  createAutomaticCashReserveConfigSet,
} from "../backend/modules/automatic-cash/index.js";
import { readJson, startBackend } from "../backend/tests/helpers/test-server.mjs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");
const projectRoot = path.resolve(cassaRoot, "..");

const RADIO_MAGIC = "RPT1";
const RADIO_HEADER_BYTES = 16;

const options = parseArgs(process.argv.slice(2));
const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const outputDir = path.resolve(projectRoot, "cassa-frontend", "logs", `endurance-50k-${runId}`);
const reportJsonPath = path.join(outputDir, "report.json");
const reportMdPath = path.join(outputDir, "REPORT.md");
const eventsPath = path.join(outputDir, "events.jsonl");
const virtualPrinterHost =
  String(process.env.ENDURANCE_MOCK_PRINTER_HOST ?? "127.0.0.1").trim() ||
  "127.0.0.1";
const virtualPrinterPort = clampInt(
  process.env.ENDURANCE_MOCK_PRINTER_PORT ?? process.env.MOCK_PRINTER_PORT,
  1,
  65535,
  9109,
);
const virtualFiscalBaseUrl =
  String(process.env.ENDURANCE_FISCAL_BASE_URL ?? "http://127.0.0.1:9290")
    .trim()
    .replace(/\/+$/, "") || "http://127.0.0.1:9290";
const virtualPrintingEnabled =
  String(process.env.ENDURANCE_PRINTING_ENABLED ?? "0").trim() === "1";

const rooms = [
  { id: "room_pedana", name: "Pedana" },
  { id: "room_sala", name: "Sala" },
  { id: "room_bar", name: "Bar" },
  { id: "room_terrazza", name: "Terrazza" },
  { id: "room_spiaggia", name: "Spiaggia" },
];

const catalog = [
  ["menu_caffetteria_caffe", "Caffe", 1.3],
  ["menu_caffetteria_cappuccino", "Cappuccino", 1.6],
  ["menu_caffetteria_latte_macchiato", "Latte Macchiato", 1.5],
  ["menu_bevande_acqua_0_5l_nat", "Acqua 0,5L Nat", 1.3],
  ["menu_bevande_coca_cola", "Coca Cola", 4],
  ["menu_drink_aperol_spritz", "Aperol Spritz", 8],
  ["menu_drink_gin_tonic", "Gin Tonic", 8],
  ["menu_drink_bloody_mary", "Bloody Mary", 8],
  ["menu_apericena_standard", "Apericena", 12],
  ["menu_birre_ichnusa", "Ichnusa", 4.5],
  ["menu_vino_k_prosecco", "K Prosecco", 6],
];

const permissions = [
  "manage_users",
  "manage_settings",
  "manage_reservations",
  "manage_menu",
  "manage_tables",
  "manage_sale_sessions",
  "approve_room_change",
  "collect_payments",
  "open_drawer",
  "print_orders",
  "fiscal_operations",
  "override_order_price",
  "manage_smart_customers",
  "view_analytics",
  "create_bar_replacement",
  "automatic_cash_admin",
];

const operatorPermissions = [
  "collect_payments",
  "approve_room_change",
  "manage_tables",
  "print_orders",
  "view_analytics",
  "manage_reservations",
  "create_bar_replacement",
];

let eventFile = null;
let automaticCashSeed = null;

function mobileUserName(index) {
  return `end_user_${String(index + 1).padStart(2, "0")}`;
}

function stationUserName(index) {
  return `end_station_user_${String(index + 1).padStart(2, "0")}`;
}

function parseArgs(argv) {
  const parsed = {
    durationMs: Number(process.env.ENDURANCE_DURATION_MS || 3_600_000),
    actions: Number(process.env.ENDURANCE_ACTIONS || 50_000),
    mobileDevices: Number(process.env.ENDURANCE_MOBILE_DEVICES || 120),
    mobileUsers: Number(process.env.ENDURANCE_MOBILE_USERS || 10),
    stations: Number(process.env.ENDURANCE_STATIONS || 50),
    radioClients: Number(process.env.ENDURANCE_RADIO_CLIENTS || 100),
    timeoutMs: Number(process.env.ENDURANCE_TIMEOUT_MS || 30_000),
    actionTimeoutMs: Number(process.env.ENDURANCE_ACTION_TIMEOUT_MS || NaN),
    inFlightDrainTimeoutMs: Number(process.env.ENDURANCE_INFLIGHT_DRAIN_TIMEOUT_MS || NaN),
    maxConcurrency: Number(process.env.ENDURANCE_MAX_CONCURRENCY || 80),
    criticalHeadroom:
      process.env.ENDURANCE_CRITICAL_HEADROOM === undefined
        ? NaN
        : Number(process.env.ENDURANCE_CRITICAL_HEADROOM),
    monitorIntervalMs: Number(process.env.ENDURANCE_MONITOR_INTERVAL_MS || 5_000),
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--duration-ms") parsed.durationMs = Number(argv[++index]);
    else if (arg.startsWith("--duration-ms=")) parsed.durationMs = Number(arg.slice("--duration-ms=".length));
    else if (arg === "--actions") parsed.actions = Number(argv[++index]);
    else if (arg.startsWith("--actions=")) parsed.actions = Number(arg.slice("--actions=".length));
    else if (arg === "--mobile-devices") parsed.mobileDevices = Number(argv[++index]);
    else if (arg.startsWith("--mobile-devices=")) parsed.mobileDevices = Number(arg.slice("--mobile-devices=".length));
    else if (arg === "--mobile-users") parsed.mobileUsers = Number(argv[++index]);
    else if (arg.startsWith("--mobile-users=")) parsed.mobileUsers = Number(arg.slice("--mobile-users=".length));
    else if (arg === "--stations") parsed.stations = Number(argv[++index]);
    else if (arg.startsWith("--stations=")) parsed.stations = Number(arg.slice("--stations=".length));
    else if (arg === "--radio-clients") parsed.radioClients = Number(argv[++index]);
    else if (arg.startsWith("--radio-clients=")) parsed.radioClients = Number(arg.slice("--radio-clients=".length));
    else if (arg === "--timeout-ms") parsed.timeoutMs = Number(argv[++index]);
    else if (arg.startsWith("--timeout-ms=")) parsed.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    else if (arg === "--action-timeout-ms") parsed.actionTimeoutMs = Number(argv[++index]);
    else if (arg.startsWith("--action-timeout-ms=")) parsed.actionTimeoutMs = Number(arg.slice("--action-timeout-ms=".length));
    else if (arg === "--in-flight-drain-timeout-ms") parsed.inFlightDrainTimeoutMs = Number(argv[++index]);
    else if (arg.startsWith("--in-flight-drain-timeout-ms=")) parsed.inFlightDrainTimeoutMs = Number(arg.slice("--in-flight-drain-timeout-ms=".length));
    else if (arg === "--max-concurrency") parsed.maxConcurrency = Number(argv[++index]);
    else if (arg.startsWith("--max-concurrency=")) parsed.maxConcurrency = Number(arg.slice("--max-concurrency=".length));
    else if (arg === "--critical-headroom") parsed.criticalHeadroom = Number(argv[++index]);
    else if (arg.startsWith("--critical-headroom=")) parsed.criticalHeadroom = Number(arg.slice("--critical-headroom=".length));
  }

  parsed.durationMs = clampInt(parsed.durationMs, 10_000, 8 * 60 * 60_000, 3_600_000);
  parsed.actions = clampInt(parsed.actions, 100, 500_000, 50_000);
  parsed.mobileDevices = clampInt(parsed.mobileDevices, 1, 1_000, 120);
  parsed.mobileUsers = clampInt(parsed.mobileUsers, 1, parsed.mobileDevices, 10);
  parsed.stations = clampInt(parsed.stations, 1, 200, 50);
  parsed.radioClients = clampInt(parsed.radioClients, 0, parsed.mobileDevices, Math.min(100, parsed.mobileDevices));
  parsed.timeoutMs = clampInt(parsed.timeoutMs, 1_000, 120_000, 30_000);
  parsed.actionTimeoutMs = clampInt(
    parsed.actionTimeoutMs,
    parsed.timeoutMs,
    10 * 60_000,
    Math.max(120_000, parsed.timeoutMs * 4),
  );
  parsed.inFlightDrainTimeoutMs = clampInt(
    parsed.inFlightDrainTimeoutMs,
    5_000,
    30 * 60_000,
    Math.max(parsed.actionTimeoutMs, Math.min(10 * 60_000, parsed.timeoutMs * 4)),
  );
  parsed.maxConcurrency = clampInt(parsed.maxConcurrency, 1, 500, 80);
  const defaultHeadroom = Math.min(32, Math.max(4, Math.ceil(parsed.maxConcurrency * 0.2)));
  parsed.criticalHeadroom = clampInt(
    parsed.criticalHeadroom,
    0,
    Math.max(0, parsed.maxConcurrency - 1),
    defaultHeadroom,
  );
  parsed.actionConcurrency = Math.max(1, parsed.maxConcurrency - parsed.criticalHeadroom);
  return parsed;
}

function clampInt(value, min, max, fallback) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function printHelp() {
  console.log(`Uso:
  node cassa-frontend/scripts/endurance-sim-50k.mjs

Opzioni principali:
  --duration-ms N       durata minima, default 3600000
  --actions N           azioni high-level da schedulare, default 50000
  --mobile-devices N    device mobili attivi, default 120
  --stations N          postazioni attive, default 50
  --radio-clients N     websocket radio, default 100
  --timeout-ms N         timeout HTTP, default 30000
  --action-timeout-ms N  timeout massimo azione high-level, default max(120s, timeout*4)
  --max-concurrency N   limite totale richieste contemporanee, default 80
  --critical-headroom N posti riservati a login/radio/cassa, default 20% maxConcurrency
`);
}

function nowIso() {
  return new Date().toISOString();
}

function cloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function money(value) {
  return Number((Math.round((Number(value) || 0) * 100) / 100).toFixed(2));
}

function rnd(max) {
  return Math.floor(Math.random() * max);
}

function pick(items) {
  if (!items.length) return null;
  return items[rnd(items.length)];
}

function stationName(index) {
  const base = [
    "BAR PRINCIPALE",
    "BAR-1",
    "BAR-2",
    "COCKTAIL",
    "CAFFETTERIA",
    "CUCINA",
    "PIZZA",
    "DOLCI",
    "SPIAGGIA",
    "TERRAZZA",
  ];
  if (index < base.length) return base[index];
  return `POSTAZIONE-${String(index + 1).padStart(2, "0")}`;
}

function buildLine(multiplier = 1) {
  const [productId, name, price] = pick(catalog);
  const qty = Math.max(1, Math.min(4, multiplier));
  return {
    name,
    productName: name,
    productId,
    qty,
    quantity: qty,
    price,
    unitPrice: price,
    lineTotal: money(price * qty),
  };
}

function linesTotal(lines) {
  return money(lines.reduce((sum, line) => sum + Number(line.lineTotal ?? line.price * line.qty), 0));
}

function tableNumberFromId(tableId) {
  return Number(String(tableId).match(/_t(\d+)$/)?.[1] ?? 0);
}

function createUser(id, username, fullName, role = "operator", pin = "2222") {
  const timestamp = nowIso();
  return {
    id,
    username,
    fullName,
    role,
    roleLabel: role === "admin" ? "Amministratore" : role === "responsabile" ? "Responsabile" : "Operatore",
    permissions: role === "admin" || role === "responsabile" ? permissions : operatorPermissions,
    authorizedRoomIds: rooms.map((room) => room.id),
    enabledRoomIds: rooms.map((room) => room.id),
    allowedPaymentMethodIds: ["pay_cash", "pay_card"],
    pinHash: hashPin(pin),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function forceAutomaticCashSeed(dbPath) {
  const db = await readJson(dbPath);
  db.posSettings = {
    ...(db.posSettings ?? {}),
    automaticCash: automaticCashSeed.automaticCash,
  };
  db.meta = {
    ...(db.meta ?? {}),
    lastWriteAt: nowIso(),
    settingsLastWriteAt: nowIso(),
  };
  await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
}

async function readHydratedBackendState(backend) {
  let db = await readJson(backend.dbPath);
  const splitDbPath = path.join(backend.runDir ?? path.dirname(backend.dbPath), "app-state-split.sqlite");
  const splitOptions = {
    mode: "externalized",
    dbPath: splitDbPath,
    nowIso,
    cloneJson,
    logger: { warn() {} },
  };
  const repositories = [
    createAuditEventsSplitRepository(splitOptions),
    createPrintSpoolJobsSplitRepository(splitOptions),
    createDeviceStatusSplitRepository(splitOptions),
    createTableLocksSplitRepository(splitOptions),
    createTableStateSplitRepository(splitOptions),
    createOrdersSplitRepository(splitOptions),
    createPaymentsFiscalSplitRepository(splitOptions),
  ];
  try {
    for (const repository of repositories) {
      db = await repository.hydrateAppState(db);
    }
    return db;
  } finally {
    for (const repository of repositories) {
      repository.close();
    }
  }
}

function summarizeBackendDrains(db) {
  const jobs = Array.isArray(db.printSpoolJobs) ? db.printSpoolJobs : [];
  const pendingPrintJobs = jobs.filter((job) =>
    ["queued", "processing"].includes(String(job?.status ?? "").trim().toLowerCase()),
  );
  const failedPrintJobs = jobs.filter((job) =>
    String(job?.status ?? "").trim().toLowerCase().startsWith("failed"),
  );
  const fiscalReceipts = Array.isArray(db.fiscalReceipts) ? db.fiscalReceipts : [];
  const pendingFiscalReceipts = fiscalReceipts.filter((receipt) => {
    const status = String(receipt?.fiscalStatus ?? receipt?.status ?? "").trim().toUpperCase();
    return ["PENDING", "PROCESSING"].includes(status);
  });
  return {
    pendingPrintJobs: pendingPrintJobs.length,
    failedPrintJobs: failedPrintJobs.length,
    pendingFiscalReceipts: pendingFiscalReceipts.length,
    printSpoolJobs: jobs.length,
    fiscalReceipts: fiscalReceipts.length,
  };
}

async function waitForBackendDrains(backend) {
  const timeoutMs = clampInt(
    process.env.ENDURANCE_DRAIN_TIMEOUT_MS,
    5_000,
    30 * 60_000,
    Math.max(120_000, Math.min(5 * 60_000, Math.trunc(options.durationMs * 0.15))),
  );
  const started = performance.now();
  let last = null;
  while (performance.now() - started < timeoutMs) {
    const db = await readHydratedBackendState(backend);
    last = summarizeBackendDrains(db);
    if (
      last.pendingPrintJobs === 0 &&
      last.pendingFiscalReceipts === 0
    ) {
      return {
        ok: true,
        waitedMs: Math.round(performance.now() - started),
        timeoutMs,
        ...last,
      };
    }
    await sleep(1_000);
  }
  return {
    ok: false,
    waitedMs: Math.round(performance.now() - started),
    timeoutMs,
    ...(last ?? {
      pendingPrintJobs: 0,
      failedPrintJobs: 0,
      pendingFiscalReceipts: 0,
      printSpoolJobs: 0,
      fiscalReceipts: 0,
    }),
  };
}

function buildGatewayInventory() {
  const denominations = [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
  return {
    ok: true,
    inventory: {
      ok: true,
      error: null,
      listCassette: denominations.map((cents) => ({
        Value_Money: cents,
        Stock: cents >= 5000 ? 100 : 300,
        IsExist: true,
        IsEmpty: false,
      })),
    },
    activeOperation: null,
    deposit: {
      depositedTotalCents: 2000,
    },
    updatedAtMs: Date.now(),
  };
}

function buildAutomaticCashReserveConfig() {
  return {
    schema_version: 1,
    id: "reserve-endurance-v1",
    nome: "Riserva minima endurance",
    valuta: "EUR",
    enabled: true,
    missing_denomination_policy: "reject",
    denominazioni_centesimi: {
      "20_euro": 2000,
      "10_euro": 1000,
      "5_euro": 500,
      "2_euro": 200,
      "1_euro": 100,
      "50_cent": 50,
      "20_cent": 20,
      "10_cent": 10,
      "5_cent": 5,
      "2_cent": 2,
      "1_cent": 1,
    },
    riserva_minima_pezzi: {
      "20_euro": 1,
      "10_euro": 1,
      "5_euro": 1,
      "2_euro": 1,
      "1_euro": 1,
      "50_cent": 1,
      "20_cent": 1,
      "10_cent": 1,
      "5_cent": 1,
      "2_cent": 0,
      "1_cent": 0,
    },
  };
}

async function prepareAutomaticCashSeed() {
  const candidates = [
    path.resolve(projectRoot, "cassa-frontend/backend/fixtures/fondo_cassa_100_combinazioni.json"),
    path.resolve(projectRoot, "../../fondo_cassa_100_combinazioni.json"),
    path.resolve(projectRoot, "../../mobile_fondo_cassa_auto_codex_guides_v2/examples/fondo_cassa_15_combinazioni_casuali.example.json"),
    path.resolve(projectRoot, "mobile_fondo_cassa_auto_codex_guides_v2/examples/fondo_cassa_15_combinazioni_casuali.example.json"),
  ];
  let configSet = null;
  let configPath = "";
  let selectedRawConfig = null;
  let lastConfigError = "";
  for (const candidate of candidates) {
    try {
      const rawConfig = JSON.parse(await fs.readFile(candidate, "utf8"));
      const { validation, configSet: candidateConfigSet } = createAutomaticCashConfigSet({
        config: rawConfig,
        uploadedAt: nowIso(),
        uploadedBy: "endurance-sim",
      });
      if (!validation.ok || !candidateConfigSet) {
        lastConfigError = `${candidate}: ${validation.errors.join("; ")}`;
        continue;
      }
      configSet = candidateConfigSet;
      selectedRawConfig = rawConfig;
      configPath = candidate;
      break;
    } catch (error) {
      lastConfigError = `${candidate}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const uploadedAt = nowIso();
  const uploadedBy = "endurance-sim";
  if (!configSet) {
    throw new Error(`config fondo cassa non valida o non trovata: ${lastConfigError || candidates.join(", ")}`);
  }
  const { validation: reserveValidation, reserveConfig } = createAutomaticCashReserveConfigSet({
    config: buildAutomaticCashReserveConfig(),
    uploadedAt,
    uploadedBy,
  });
  if (!reserveValidation.ok || !reserveConfig) {
    throw new Error(`riserva fondo cassa non valida: ${reserveValidation.errors.join("; ")}`);
  }
  return {
    configPath,
    rawConfig: selectedRawConfig,
    reserveRawConfig: buildAutomaticCashReserveConfig(),
    automaticCash: {
      enabled: true,
      gatewayConfigured: true,
      feedbackEnabled: true,
      warningThresholdCents: 1000,
      dangerThresholdCents: 1000,
      autoCashFloatMode: "random_file",
      configSetId: configSet.id,
      configSet,
      configSets: [configSet],
      reserveConfigId: reserveConfig.id,
      reserveConfig,
      reserveConfigs: [reserveConfig],
      gatewayInventory: buildGatewayInventory(),
      workflows: [],
      assignments: [],
      cashFloats: [],
      deposits: [],
      cashExchanges: [],
      settlementRecords: [],
    },
  };
}

function seedState(state) {
  const timestamp = nowIso();
  const syntheticUsers = [
    createUser("u_end_admin", "end_admin", "Endurance Admin", "admin", "1111"),
    createUser("u_end_manager", "end_manager", "Endurance Manager", "responsabile", "4444"),
    ...Array.from({ length: options.mobileUsers }, (_, index) =>
      createUser(
        `u_end_mobile_${String(index + 1).padStart(2, "0")}`,
        mobileUserName(index),
        `Endurance User ${index + 1}`,
        "operator",
        "2222",
      ),
    ),
    ...Array.from({ length: options.stations }, (_, index) =>
      createUser(
        `u_end_station_${String(index + 1).padStart(2, "0")}`,
        stationUserName(index),
        `Endurance Station User ${index + 1}`,
        "operator",
        "2222",
      ),
    ),
  ];

  state.users = [...syntheticUsers, ...(Array.isArray(state.users) ? state.users : [])].filter(
    (entry, index, items) => items.findIndex((candidate) => candidate.username === entry.username) === index,
  );

  const tables = [];
  for (const room of rooms) {
    for (let index = 1; index <= 80; index += 1) {
      tables.push({
        id: `${room.id}_t${String(index).padStart(2, "0")}`,
        number: index,
        type: room.name,
        roomId: room.id,
        status: "free",
        covers: 0,
        totalDue: 0,
        amountDue: 0,
        dueAmount: 0,
        pendingBills: [],
        note: "",
      });
    }
  }

  const stations = Array.from({ length: options.stations }, (_, index) => stationName(index));
  state.sessions = [];
  state.auditEvents = [];
  state.saleSessions = [];
  state.printSpoolJobs = [];
  state.paymentContainers = [];
  state.paymentParts = [];
  state.paymentTransactions = [];
  state.payments = [];
  state.fiscalReceipts = [];
  state.fiscalEvents = [];
  state.tableLocks = [];
  state.handheldCashSessions = [];

  state.integration = {
    ...(state.integration ?? {}),
    orders: [],
    tickets: [],
    notifications: [],
    orderComps: [],
    orderCorrections: [],
    barChargeReplacements: [],
    waiterPauses: [],
    waiterDeferredCalls: [],
    stationStates: stations.map((station, index) => ({
      station,
      stationName: station,
      active: true,
      realStation: true,
      stale: false,
      updatedAtMs: Date.now(),
      operatorUserId: `u_end_station_${String(index + 1).padStart(2, "0")}`,
      operatorUsername: stationUserName(index),
      printerIds: ["end_printer_mock"],
      printerId: "end_printer_mock",
      printerHost: virtualPrinterHost,
      printerPort: virtualPrinterPort,
    })),
    sequence: { order: 0, notification: 0 },
  };

  state.posSettings = {
    ...(state.posSettings ?? {}),
    rooms: rooms.map((room) => ({
      ...room,
      roomId: room.id,
      label: room.name,
      enabled: true,
      printerIds: ["end_printer_mock"],
      precontoPrinterIds: ["end_printer_mock"],
      fiscalDeviceIds: ["rt_endurance_mock"],
    })),
    tables,
    workstations: stations.map((station, index) => ({
      id: `end_workstation_${String(index + 1).padStart(2, "0")}`,
      name: station,
      stationName: station,
      active: true,
      status: "active",
      roomIds: rooms.map((room) => room.id),
      printerIds: ["end_printer_mock"],
      precontoPrinterIds: ["end_printer_mock"],
      printOrderEnabled: true,
      printPrecontoEnabled: true,
      printTableChangesEnabled: true,
    })),
    printers: [
      {
        id: "end_printer_mock",
        name: "Endurance Printer TCP Virtuale",
        host: virtualPrinterHost,
        port: virtualPrinterPort,
        purpose: "generic",
        active: true,
      },
      {
        id: "end_fiscal_mock",
        name: "Endurance RT TCP Virtuale",
        host: virtualPrinterHost,
        port: virtualPrinterPort,
        purpose: "fiscal",
        active: true,
      },
    ],
    areas: rooms.map((room) => ({
      id: room.id,
      name: room.name,
      printerIds: ["end_printer_mock"],
      precontoPrinterIds: ["end_printer_mock"],
      fiscalDeviceIds: ["rt_endurance_mock"],
      cashPoints: [
        {
          id: `${room.id}_cash`,
          name: `${room.name} Cassa`,
          printerIds: ["end_printer_mock"],
          precontoPrinterIds: ["end_printer_mock"],
          fiscalPrinterId: "end_fiscal_mock",
        },
      ],
      workstations: stations.map((station, index) => ({
        id: `${room.id}_station_${index + 1}`,
        name: station,
        stationName: station,
        printerIds: ["end_printer_mock"],
        precontoPrinterIds: ["end_printer_mock"],
        printOrderEnabled: true,
        printPrecontoEnabled: true,
        printTableChangesEnabled: true,
      })),
    })),
    mobileDevices: [
      ...Array.from({ length: options.mobileDevices }, (_, index) => ({
        id: `end-mobile-${String(index + 1).padStart(3, "0")}`,
        deviceId: `end-mobile-${String(index + 1).padStart(3, "0")}`,
        deviceUuid: `end-mobile-${String(index + 1).padStart(3, "0")}`,
        name: `Endurance mobile ${index + 1}`,
        fiscalEnabled: true,
        cashPaymentEnabled: true,
        electronicPaymentEnabled: true,
      })),
      ...Array.from({ length: options.stations }, (_, index) => ({
        id: `end-station-${String(index + 1).padStart(3, "0")}`,
        deviceId: `end-station-${String(index + 1).padStart(3, "0")}`,
        deviceUuid: `end-station-${String(index + 1).padStart(3, "0")}`,
        name: `Endurance station device ${index + 1}`,
        fiscalEnabled: true,
        cashPaymentEnabled: true,
        electronicPaymentEnabled: true,
      })),
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `end-extra-${String(index + 1).padStart(3, "0")}`,
        deviceId: `end-extra-${String(index + 1).padStart(3, "0")}`,
        deviceUuid: `end-extra-${String(index + 1).padStart(3, "0")}`,
        name: `Endurance extra device ${index + 1}`,
        fiscalEnabled: true,
        cashPaymentEnabled: true,
        electronicPaymentEnabled: true,
      })),
    ],
    radioChannels: [
      { id: "bar", name: "Bar", enabled: true, color: "#ff9f43", sortOrder: 10 },
      { id: "generale", name: "Generale", enabled: true, color: "#00d2ff", sortOrder: 20 },
      { id: "cassa", name: "Cassa", enabled: true, color: "#2ed573", sortOrder: 30 },
    ],
    radioPreferences: [],
    paymentMethods: [
      { id: "pay_cash", label: "Contanti", type: "CASH", enabled: true, fiscal: true },
      { id: "pay_card", label: "Carta", type: "POS", enabled: true, fiscal: true },
    ],
    fiscalDevices: [
      {
        id: "rt_endurance_mock",
        name: "RT Endurance Virtuale",
        type: "api",
        fiscalProvider: "pos-fiscal-api",
        apiBaseUrl: virtualFiscalBaseUrl,
        statusEndpoint: "/api/fiscal/status",
        receiptEndpoint: "/api/fiscal/receipt",
        reprintEndpoint: "/api/fiscal/reprint",
        paymentMethodIds: ["pay_cash", "pay_card"],
        supportsCash: true,
        supportsElectronic: true,
        supportsReprint: true,
        active: true,
      },
    ],
    orderWorkflow: {
      ...(state.posSettings?.orderWorkflow ?? {}),
      deliveryConfirmationEnabled: false,
      requireReadyForDelivery: false,
      requireDeliveredForPayment: false,
    },
    automaticCash: {
      ...(automaticCashSeed?.automaticCash ?? state.posSettings?.automaticCash ?? {}),
      enabled: true,
      gatewayConfigured: true,
      gatewayInventory: buildGatewayInventory(),
    },
  };

  state.meta = {
    ...(state.meta ?? {}),
    lastWriteAt: timestamp,
    settingsLastWriteAt: timestamp,
    settingsVersion: Date.now(),
  };
}

class Recorder {
  constructor() {
    this.startedAtMs = Date.now();
    this.http = new Map();
    this.actions = new Map();
    this.failures = [];
    this.checkpoints = [];
    this.radio = {
      clientsOpened: 0,
      framesSent: 0,
      incomingStarts: 0,
      incomingStops: 0,
      binaryFramesReceived: 0,
      busyResponses: 0,
      restarts: 0,
      errors: [],
    };
    this.reconnections = [];
    this.automaticCash = [];
  }

  phase() {
    const elapsed = Date.now() - this.startedAtMs;
    if (elapsed <= options.durationMs * 0.1) return "early";
    if (elapsed >= options.durationMs * 0.9) return "late";
    if (elapsed >= options.durationMs * 0.45 && elapsed <= options.durationMs * 0.55) return "middle";
    return "steady";
  }

  recordBucket(map, name, ok, ms, status = 0, detail = "") {
    const phase = this.phase();
    const entry =
      map.get(name) ??
      {
        name,
        count: 0,
        ok: 0,
        fail: 0,
        latencies: [],
        phases: {
          early: [],
          middle: [],
          steady: [],
          late: [],
        },
        statuses: new Map(),
      };
    entry.count += 1;
    entry.ok += ok ? 1 : 0;
    entry.fail += ok ? 0 : 1;
    entry.latencies.push(ms);
    entry.phases[phase].push(ms);
    if (status) entry.statuses.set(status, (entry.statuses.get(status) ?? 0) + 1);
    map.set(name, entry);
    if (!ok && this.failures.length < 1_000) {
      this.failures.push({
        at: nowIso(),
        name,
        status,
        phase,
        detail: String(detail ?? "").slice(0, 700),
      });
    }
  }

  recordHttp(name, ok, ms, status, detail) {
    this.recordBucket(this.http, name, ok, ms, status, detail);
  }

  recordAction(name, ok, ms, detail) {
    this.recordBucket(this.actions, name, ok, ms, ok ? 200 : 500, detail);
  }

  pushCheckpoint(checkpoint) {
    this.checkpoints.push({
      at: nowIso(),
      elapsedMs: Date.now() - this.startedAtMs,
      ...checkpoint,
    });
  }

  summarizeMap(map) {
    return [...map.values()]
      .map((entry) => {
        const sorted = [...entry.latencies].sort((a, b) => a - b);
        const early = [...entry.phases.early].sort((a, b) => a - b);
        const middle = [...entry.phases.middle].sort((a, b) => a - b);
        const late = [...entry.phases.late].sort((a, b) => a - b);
        const earlyP95 = percentile(early, 0.95);
        const lateP95 = percentile(late, 0.95);
        return {
          name: entry.name,
          count: entry.count,
          ok: entry.ok,
          fail: entry.fail,
          p50Ms: percentile(sorted, 0.5),
          p95Ms: percentile(sorted, 0.95),
          p99Ms: percentile(sorted, 0.99),
          maxMs: sorted.length ? round(sorted[sorted.length - 1]) : 0,
          earlyP95Ms: earlyP95,
          middleP95Ms: percentile(middle, 0.95),
          lateP95Ms: lateP95,
          lateVsEarlyP95: earlyP95 > 0 && lateP95 > 0 ? round(lateP95 / earlyP95) : null,
          statuses: Object.fromEntries([...entry.statuses.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
        };
      })
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  }

  summary() {
    return {
      startedAt: new Date(this.startedAtMs).toISOString(),
      finishedAt: nowIso(),
      durationMs: Date.now() - this.startedAtMs,
      http: this.summarizeMap(this.http),
      actions: this.summarizeMap(this.actions),
      failures: this.failures,
      checkpoints: this.checkpoints,
      radio: this.radio,
      reconnections: this.reconnections,
      automaticCash: this.automaticCash,
    };
  }
}

const recorder = new Recorder();

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return round(sorted[index]);
}

function round(value) {
  return Math.round(Number(value) * 10) / 10;
}

async function writeEvent(event) {
  if (!eventFile) eventFile = await fs.open(eventsPath, "a");
  await eventFile.write(`${JSON.stringify({ at: nowIso(), ...event })}\n`);
}

function authHeaders(session) {
  return {
    Authorization: `Bearer ${session.token}`,
    "X-User-Id": session.user.id,
    "X-Device-Uuid": session.deviceUuid,
    "Content-Type": "application/json",
  };
}

function authPayload(session, extra = {}) {
  return {
    token: session.token,
    userId: session.user.id,
    username: session.user.username,
    fullName: session.user.fullName,
    deviceUuid: session.deviceUuid,
    clientApp: session.clientApp,
    roomId: session.roomId,
    roomName: session.roomName,
    ...extra,
  };
}

async function requestJson(baseUrl, name, method, route, session = null, body = {}, requestOptions = {}) {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestOptions.timeoutMs ?? options.timeoutMs);
  let status = 0;
  let parsed = null;
  let text = "";
  try {
    let url = `${baseUrl}${route}`;
    const headers = session ? authHeaders(session) : { "Content-Type": "application/json" };
    const init = { method, headers, signal: controller.signal };
    if (method === "GET") {
      const params = new URLSearchParams();
      if (session && requestOptions.authQuery !== false) {
        Object.entries(authPayload(session)).forEach(([key, value]) => {
          if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
        });
      }
      Object.entries(body ?? {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
      });
      const query = params.toString();
      if (query) url += `${url.includes("?") ? "&" : "?"}${query}`;
    } else {
      init.body = JSON.stringify(session ? authPayload(session, body) : body);
    }
    const response = await fetch(url, init);
    status = response.status;
    text = await response.text();
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
    const okStatuses = requestOptions.okStatuses ?? [200];
    const ok = okStatuses.includes(status) || (requestOptions.allow409 && status === 409) || (requestOptions.allow423 && status === 423);
    recorder.recordHttp(name, ok, performance.now() - started, status, ok ? "" : parsed?.error ?? parsed?.code ?? text);
    if (!ok && requestOptions.throwOnError !== false) {
      throw new Error(`${name} ${method} ${route} -> ${status}: ${parsed?.error ?? parsed?.code ?? text}`);
    }
    return { ok, status, body: parsed, ms: performance.now() - started };
  } catch (error) {
    recorder.recordHttp(name, false, performance.now() - started, status, error instanceof Error ? error.message : String(error));
    if (requestOptions.throwOnError === false) return { ok: false, status, body: parsed, error };
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRuntimeMetrics(baseUrl, session, action = "snapshot") {
  if (!session?.token) return null;
  const method = action === "reset" ? "POST" : "GET";
  const route = action === "reset" ? "/api/monitor/runtime-metrics/reset" : "/api/monitor/runtime-metrics";
  const result = await requestJson(baseUrl, `monitor.runtime_metrics.${action}`, method, route, session, {}, {
    okStatuses: [200, 401, 403, 404],
    throwOnError: false,
  });
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: result.body?.error || result.body?.code || "runtime_metrics_unavailable",
    };
  }
  return result.body?.runtimeMetrics || null;
}

async function login(baseUrl, username, pin, deviceUuid, clientApp = "mobile-frontend", extra = {}) {
  const result = await requestJson(
    baseUrl,
    "auth.login",
    "POST",
    "/api/auth/login",
    null,
    { username, pin, deviceUuid, clientApp, ...extra },
  );
  const user = result.body?.user;
  if (!result.body?.token || !user?.id) throw new Error(`login fallito per ${username}/${deviceUuid}`);
  const room = rooms[rnd(rooms.length)];
  return {
    token: result.body.token,
    user,
    username: user.username,
    deviceUuid,
    clientApp,
    roomId: room.id,
    roomName: room.name,
    online: true,
  };
}

async function loginWithRetry(baseUrl, username, pin, deviceUuid, clientApp = "mobile-frontend", extra = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await login(baseUrl, username, pin, deviceUuid, clientApp, extra);
    } catch (error) {
      lastError = error;
      if (attempt === 0) await sleep(600 + rnd(500));
    }
  }
  throw lastError;
}

async function logout(baseUrl, session) {
  if (!session?.token) return;
  await requestJson(baseUrl, "auth.logout", "POST", "/api/auth/logout", session, {}, {
    okStatuses: [200, 401],
    throwOnError: false,
  });
  session.online = false;
}

async function lockTable(baseUrl, session, tableId, purpose) {
  return requestJson(baseUrl, "lock.acquire", "POST", "/api/tables/lock/acquire", session, { tableId, purpose }, {
    okStatuses: [200, 409],
    throwOnError: false,
  });
}

async function releaseTable(baseUrl, session, tableId) {
  return requestJson(baseUrl, "lock.release", "POST", "/api/tables/lock/release", session, { tableId }, {
    okStatuses: [200, 401, 403, 404],
    throwOnError: false,
  });
}

async function stationHeartbeat(baseUrl, session, station, active = true, extra = {}) {
  return requestJson(baseUrl, "station.heartbeat", "POST", "/api/integration/stations/state", session, {
    clientApp: "postazione",
    station,
    stationName: station,
    active,
    autoPrintOrders: false,
    autoPrintPreconto: false,
    printerIds: ["end_printer_mock"],
    printerId: "end_printer_mock",
    printerHost: virtualPrinterHost,
    printerPort: virtualPrinterPort,
    operatorUserId: session.user.id,
    operatorUsername: session.user.username,
    operatorName: session.user.fullName,
    operatorRole: session.user.roleLabel,
    ...extra,
  }, {
    okStatuses: [200, 409],
    throwOnError: false,
  });
}

async function createOrder(baseUrl, session, table, state, long = false) {
  const lock = await lockTable(baseUrl, session, table.id, "endurance.order.create");
  if (lock.status !== 200) return lock;
  const lines = Array.from({ length: long ? 5 + rnd(7) : 1 + rnd(3) }, (_, index) => buildLine((index % 3) + 1));
  const result = await requestJson(baseUrl, long ? "order.create.long" : "order.create", "POST", "/api/integration/orders/create", session, {
    source: "mobile-frontend",
    tableId: table.id,
    roomId: table.roomId,
    tableNumber: table.number,
    covers: 1 + rnd(6),
    note: `endurance note ${runId}`,
    orderNote: `endurance ordine ${runId}`,
    communications: long ? "comunicazione cucina/bar endurance" : "",
    orderComment: long ? "commento ordine endurance" : "",
    total: linesTotal(lines),
    lines,
  }, {
    okStatuses: [200, 409],
    throwOnError: false,
  });
  await releaseTable(baseUrl, session, table.id);
  if (result.body?.order) {
    rememberOrder(state, result.body.order);
  }
  return result;
}

function rememberOrder(state, order) {
  if (!order?.id) return;
  state.ordersById.set(order.id, order);
  state.orderIds.push(order.id);
  if (state.orderIds.length > 5_000) {
    const old = state.orderIds.shift();
    state.ordersById.delete(old);
  }
}

function pickOrder(state, predicate = null) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = pick(state.orderIds);
    const order = state.ordersById.get(id);
    if (order && (!predicate || predicate(order))) return order;
  }
  return null;
}

function orderWorkflow(order) {
  return String(order?.workflowStatus ?? order?.status ?? "")
    .trim()
    .toLowerCase();
}

async function syncOrder(baseUrl, session, order, workflowStatus) {
  if (!order?.id) return null;
  const result = await requestJson(baseUrl, `order.sync.${workflowStatus}`, "POST", "/api/integration/orders/sync", session, {
    id: order.id,
    order: {
      ...order,
      workflowStatus,
      station: pick(Array.from({ length: options.stations }, (_, index) => stationName(index))),
      ownerStation: pick(Array.from({ length: options.stations }, (_, index) => stationName(index))),
      items: Array.isArray(order.items) ? order.items.map((item) => ({ ...item, done: workflowStatus !== "prep" })) : [],
    },
    workflowReason: "endurance",
  }, {
    okStatuses: [200, 409],
    throwOnError: false,
  });
  if (result.body?.order) rememberOrder({ ordersById: globalState.ordersById, orderIds: globalState.orderIds }, result.body.order);
  return result;
}

async function correctOrder(baseUrl, session, order) {
  if (!order?.items?.length || !order.tableId) return null;
  const lock = await lockTable(baseUrl, session, order.tableId, "endurance.order.correct");
  if (lock.status !== 200) return lock;
  const first = order.items.find((item) => !item.voidedAt) ?? order.items[0];
  const body = {
    orderId: order.id,
    tableId: order.tableId,
    roomId: order.roomId,
    expectedRevision: order.currentRevision ?? order.revision ?? 1,
    idempotencyKey: `end-corr-${order.id}-${Date.now()}-${rnd(100000)}`,
  };
  const roll = rnd(3);
  if (roll === 0) body.changedItems = [{ lineId: first.lineId ?? first.id, nextQuantity: Math.max(1, Number(first.qty ?? first.quantity ?? 1) + 1) }];
  else if (roll === 1) body.removedItems = [{ lineId: first.lineId ?? first.id, quantity: 1 }];
  else body.addedItems = [{ productId: "menu_caffetteria_cappuccino", quantity: 1 }];
  const result = await requestJson(baseUrl, "order.correct", "POST", "/api/integration/orders/correct", session, body, {
    okStatuses: [200, 409],
    throwOnError: false,
  });
  await releaseTable(baseUrl, session, order.tableId);
  if (result.body?.order) rememberOrder(globalState, result.body.order);
  return result;
}

async function compOrder(baseUrl, session, order) {
  if (!order?.items?.length || !order.tableId) return null;
  const lock = await lockTable(baseUrl, session, order.tableId, "endurance.order.comp");
  if (lock.status !== 200) return lock;
  const first = order.items.find((item) => !item.voidedAt) ?? order.items[0];
  const result = await requestJson(baseUrl, "order.comp", "POST", "/api/integration/orders/comp", session, {
    tableId: order.tableId,
    roomId: order.roomId,
    orderId: order.id,
    originalLineId: first.lineId ?? first.id,
    quantity: 1,
    reason: "Endurance storno/parziale",
    sendReplacement: rnd(2) === 0,
    idempotencyKey: `end-comp-${order.id}-${Date.now()}-${rnd(100000)}`,
  }, {
    okStatuses: [200, 409],
    throwOnError: false,
  });
  await releaseTable(baseUrl, session, order.tableId);
  if (result.body?.order) rememberOrder(globalState, result.body.order);
  return result;
}

async function cancelOrder(baseUrl, session, order) {
  if (!order?.tableId) return null;
  const lock = await lockTable(baseUrl, session, order.tableId, "endurance.order.cancel");
  if (lock.status !== 200) return lock;
  const result = await requestJson(baseUrl, "order.cancel", "POST", "/api/integration/orders/cancel", session, {
    tableId: order.tableId,
    roomId: order.roomId,
    orderId: order.id,
    expectedRevision: order.currentRevision ?? order.revision ?? 1,
    reason: "Endurance annullamento comanda",
    idempotencyKey: `end-cancel-${order.id}-${Date.now()}-${rnd(100000)}`,
  }, {
    okStatuses: [200, 409],
    throwOnError: false,
  });
  await releaseTable(baseUrl, session, order.tableId);
  if (result.body?.order) rememberOrder(globalState, result.body.order);
  return result;
}

async function payOrder(baseUrl, session, order, partial = false) {
  if (!order?.tableId) return null;
  const amount = money(Math.max(0.5, Number(order.dueAmount ?? order.total ?? 1.3) * (partial ? 0.5 : 1)));
  const method = rnd(4) === 0 ? "POS" : "CASH";
  const lock = await lockTable(baseUrl, session, order.tableId, "endurance.payment");
  if (lock.status !== 200) return lock;
  const result = await requestJson(baseUrl, partial ? "payment.free_split.partial" : "payment.free_split", "POST", "/api/payments/free-split", session, {
    tableId: order.tableId,
    roomId: order.roomId,
    orderId: order.id,
    splitType: "FREE_SPLIT",
    splitMode: partial ? "amount" : "single",
    issueFiscal: true,
    fiscalDocType: "RECEIPT",
    fiscalDeviceId: "rt_endurance_mock",
    idempotencyKey: `end-pay-${order.id}-${Date.now()}-${rnd(100000)}`,
    releaseTable: !partial,
    note: "nota pagamento endurance",
    parts: [
      {
        amountDue: amount,
        transactions: [
          {
            method,
            methodId: method === "POS" ? "pay_card" : "pay_cash",
            methodLabel: method === "POS" ? "Carta" : "Contanti",
            amountPaid: amount,
            cashGiven: method === "CASH" ? amount + (rnd(3) === 0 ? 5 : 0) : undefined,
            posProvider: method === "POS" ? "mock-endurance" : undefined,
            posTxRef: method === "POS" ? `END-POS-${order.id}-${Date.now()}` : undefined,
          },
        ],
      },
    ],
  }, {
    okStatuses: [200, 409],
    throwOnError: false,
  });
  await releaseTable(baseUrl, session, order.tableId);
  if (result.body?.order) rememberOrder(globalState, result.body.order);
  return result;
}

async function printOrder(baseUrl, session, order, kind = "preconto") {
  if (!order?.id) return null;
  return requestJson(baseUrl, `print.${kind}`, "POST", "/api/integration/print", session, {
    kind,
    orderId: order.id,
    tableId: order.tableId,
    tablePrecontoMode: kind === "preconto" ? "complete" : undefined,
  }, {
    okStatuses: [200, 409, 503],
    throwOnError: false,
    timeoutMs: Math.max(options.timeoutMs, 90_000),
  });
}

async function moveTable(baseUrl, session, from, to) {
  if (!from?.id || !to?.id || from.id === to.id) return null;
  const sourceLock = await lockTable(baseUrl, session, from.id, "endurance.table.move.source");
  const targetLock = await lockTable(baseUrl, session, to.id, "endurance.table.move.target");
  if (sourceLock.status !== 200 || targetLock.status !== 200) {
    if (sourceLock.status === 200) await releaseTable(baseUrl, session, from.id);
    if (targetLock.status === 200) await releaseTable(baseUrl, session, to.id);
    return sourceLock.status !== 200 ? sourceLock : targetLock;
  }
  const result = await requestJson(baseUrl, "table.move", "POST", "/api/integration/layout/table/move", session, {
    fromTableId: from.id,
    toTableId: to.id,
    roomId: from.roomId,
    targetRoomId: to.roomId,
  }, {
    okStatuses: [200, 409],
    throwOnError: false,
  });
  await releaseTable(baseUrl, session, from.id);
  await releaseTable(baseUrl, session, to.id);
  return result;
}

async function syncTable(baseUrl, session, table) {
  const lock = await lockTable(baseUrl, session, table.id, "endurance.table.sync");
  if (lock.status !== 200) return lock;
  const result = await requestJson(baseUrl, "table.sync", "POST", "/api/integration/layout/table/sync", session, {
    tableId: table.id,
    roomId: table.roomId,
    tableNumber: table.number,
    occupancyState: rnd(2) ? "seated" : "free",
    covers: rnd(8),
    note: rnd(3) === 0 ? `nota tavolo endurance ${rnd(9999)}` : "",
  }, {
    okStatuses: [200, 409],
    throwOnError: false,
  });
  await releaseTable(baseUrl, session, table.id);
  return result;
}

async function tableGroup(baseUrl, session, tables) {
  const first = pick(tables);
  const second = pick(tables.filter((table) => table.id !== first?.id && table.roomId === first?.roomId));
  if (!first || !second) return null;
  return requestJson(baseUrl, "table.groups.save", "POST", "/api/integration/table-groups/save", session, {
    groups: rnd(4) === 0 ? [] : [
      {
        id: first.id,
        type: "complex",
        children: [
          { id: first.id, type: "simple" },
          { id: second.id, type: "simple" },
        ],
      },
    ],
  }, {
    okStatuses: [200, 409],
    throwOnError: false,
  });
}

async function reservationFlow(baseUrl, session, table) {
  const serviceDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const create = await requestJson(baseUrl, "reservation.create", "POST", "/api/pos/reservations/create", session, {
    roomId: table.roomId,
    serviceDate,
    reservationAt: Date.now() + 3_600_000 + rnd(7_200_000),
    customerName: `Cliente endurance ${rnd(10000)}`,
    customerPhone: `333${String(rnd(9999999)).padStart(7, "0")}`,
    covers: 1 + rnd(6),
    assignedTableId: table.id,
    assignedTableIds: [table.id],
    note: "prenotazione endurance",
  }, {
    okStatuses: [200, 409],
    throwOnError: false,
  });
  const reservationId = create.body?.reservation?.id;
  if (!reservationId) return create;
  return requestJson(baseUrl, "reservation.status", "POST", "/api/pos/reservations/status", session, {
    roomId: table.roomId,
    serviceDate,
    reservationId,
    action: pick(["arrived", "no_show", "cancelled"]),
  }, {
    okStatuses: [200, 409],
    throwOnError: false,
  });
}

async function notification(baseUrl, session, table) {
  const ready = rnd(2) === 0;
  return requestJson(baseUrl, ready ? "notification.ready" : "notification.waiter", "POST", "/api/integration/notifications/publish", session, {
    type: ready ? "order_ready" : "waiter",
    title: ready ? "Comanda pronta endurance" : "Chiamata cameriere endurance",
    description: ready ? `Comanda pronta tavolo ${table.number}` : `Tavolo ${table.number} richiede cameriere`,
    meta: {
      eventType: ready ? "order_ready" : "waiter_call",
      tableId: table.id,
      roomId: table.roomId,
      tableNumber: table.number,
      targetRoomId: table.roomId,
    },
  }, {
    okStatuses: [200],
    throwOnError: false,
  });
}

async function monitorControlCancel(baseUrl, session, table) {
  return requestJson(baseUrl, "monitor.table_cancel_full", "POST", "/api/monitor/control", session, {
    action: "table_cancel_full",
    tableId: table.id,
    confirm: true,
    reason: "Endurance annulla tavolo",
  }, {
    okStatuses: [200, 409],
    throwOnError: false,
  });
}

async function readTask(baseUrl, session, station) {
  const roll = rnd(12);
  if (roll === 0) return requestJson(baseUrl, "layout.get", "GET", "/api/integration/layout", session, { _: Date.now() }, { throwOnError: false });
  if (roll === 1) return requestJson(baseUrl, "orders.poll", "GET", "/api/integration/orders", session, { station, includeDone: 1, includeTransferred: 1, _: Date.now() }, { throwOnError: false });
  if (roll === 2) return requestJson(baseUrl, "stations.active", "GET", "/api/integration/stations/active", session, { _: Date.now() }, { throwOnError: false });
  if (roll === 3) return requestJson(baseUrl, "table.groups.get", "GET", "/api/integration/table-groups", session, { _: Date.now() }, { throwOnError: false });
  if (roll === 4) return requestJson(baseUrl, "notifications.pull", "GET", "/api/integration/notifications/pull", session, { deviceUuid: session.deviceUuid, _: Date.now() }, { throwOnError: false });
  if (roll === 5) return requestJson(baseUrl, "automatic_cash.status", "GET", "/api/automatic-cash/status", session, { _: Date.now() }, { throwOnError: false });
  if (roll === 6) return requestJson(baseUrl, "automatic_cash.gateway", "GET", "/api/automatic-cash/gateway/state", session, { _: Date.now() }, { throwOnError: false });
  if (roll === 7) return requestJson(baseUrl, "radio.config", "POST", "/api/mobile/radio/config", session, {}, { throwOnError: false });
  if (roll === 8) return requestJson(baseUrl, "settings.pos", "POST", "/api/settings/pos", session, {}, { throwOnError: false });
  if (roll === 9) return requestJson(baseUrl, "menu.catalog", "POST", "/api/menu/catalog", session, {}, { throwOnError: false });
  if (roll === 10) return requestJson(baseUrl, "battery.get", "GET", "/api/mobile/battery", session, { deviceUuid: session.deviceUuid, _: Date.now() }, { throwOnError: false });
  return requestJson(baseUrl, "reservations.list", "POST", "/api/pos/reservations/list", session, {
    roomId: session.roomId,
    serviceDate: new Date().toISOString().slice(0, 10),
  }, { throwOnError: false });
}

function buildActionList(baseUrl, state) {
  return [
    {
      name: "read.mix",
      weight: 22,
      run: async () => readTask(baseUrl, pickOnline(state.mobileSessions), stationName(rnd(options.stations))),
    },
    {
      name: "station.heartbeat",
      weight: 8,
      run: async () => {
        const pair = pick(state.stationSessions);
        return stationHeartbeat(baseUrl, pair.session, pair.station, true);
      },
    },
    {
      name: "order.create",
      weight: 14,
      run: async () => createOrder(baseUrl, pickOnline(state.mobileSessions), pick(state.tables), state, rnd(5) === 0),
    },
    {
      name: "order.ready",
      weight: 7,
      run: async () =>
        syncOrder(
          baseUrl,
          pick(state.stationSessions)?.session,
          pickOrder(state, (order) => ["", "waiting", "prep"].includes(orderWorkflow(order))),
          "ready",
        ),
    },
    {
      name: "order.delivered",
      weight: 6,
      run: async () =>
        syncOrder(
          baseUrl,
          pick(state.stationSessions)?.session,
          pickOrder(state, (order) => orderWorkflow(order) === "ready"),
          "delivered",
        ),
    },
    {
      name: "payment",
      weight: 16,
      run: async () => payOrder(baseUrl, pickOnline(state.mobileSessions), pickOrder(state, (order) => !["paid", "cancelled"].includes(String(order.paymentStatus ?? ""))), rnd(4) === 0),
    },
    {
      name: "order.correct",
      weight: 4,
      run: async () => correctOrder(baseUrl, pickOnline(state.mobileSessions), pickOrder(state, (order) => !["paid", "cancelled"].includes(String(order.paymentStatus ?? "")))),
    },
    {
      name: "order.comp",
      weight: 4,
      run: async () => compOrder(baseUrl, pickOnline(state.mobileSessions), pickOrder(state)),
    },
    {
      name: "order.cancel",
      weight: 2,
      run: async () => cancelOrder(baseUrl, pickOnline(state.mobileSessions), pickOrder(state, (order) => String(order.paymentStatus ?? "") !== "paid")),
    },
    {
      name: "print",
      weight: 5,
      run: async () => printOrder(baseUrl, pickOnline(state.mobileSessions), pickOrder(state), rnd(2) === 0 ? "order" : "preconto"),
    },
    {
      name: "notification",
      weight: 4,
      run: async () => notification(baseUrl, pickOnline(state.mobileSessions), pick(state.tables)),
    },
    {
      name: "table.move",
      weight: 3,
      run: async () => moveTable(baseUrl, pickOnline(state.mobileSessions), pick(state.tables), pick(state.tables)),
    },
    {
      name: "table.sync",
      weight: 3,
      run: async () => syncTable(baseUrl, pickOnline(state.mobileSessions), pick(state.tables)),
    },
    {
      name: "table.group",
      weight: 2,
      run: async () => tableGroup(baseUrl, pickOnline(state.mobileSessions), state.tables),
    },
    {
      name: "reservation",
      weight: 2,
      run: async () => reservationFlow(baseUrl, pickOnline(state.mobileSessions), pick(state.tables)),
    },
    {
      name: "table.cancel.full",
      weight: 1,
      run: async () => monitorControlCancel(baseUrl, state.adminSession, pick(state.tables)),
    },
  ];
}

function pickOnline(sessions) {
  const online = sessions.filter((session) => session.online !== false && session.token);
  return pick(online.length ? online : sessions);
}

function weightedPicker(tasks) {
  const expanded = [];
  for (const task of tasks) {
    for (let index = 0; index < task.weight; index += 1) expanded.push(task);
  }
  return () => pick(expanded);
}

async function waitForBackgroundActionSlot(inFlight, stopSignal) {
  while (!stopSignal.done) {
    stopSignal.backgroundInFlight = inFlight.size;
    if (stopSignal.criticalActive !== true && inFlight.size < options.actionConcurrency) {
      return true;
    }
    if (inFlight.size > 0) {
      await Promise.race([...inFlight, sleep(50)]);
    } else {
      await sleep(50);
    }
  }
  return false;
}

async function withCriticalHeadroom(stopSignal, reason, task) {
  const previousReason = stopSignal.criticalReason;
  stopSignal.criticalDepth = Number(stopSignal.criticalDepth ?? 0) + 1;
  stopSignal.criticalActive = true;
  stopSignal.criticalReason = reason;
  const backgroundInFlightAtStart = Number(stopSignal.backgroundInFlight ?? 0);
  const waitStarted = performance.now();
  while (
    !stopSignal.done &&
    Number(stopSignal.backgroundInFlight ?? 0) > options.actionConcurrency &&
    performance.now() - waitStarted < 8_000
  ) {
    await sleep(100);
  }
  const info = {
    criticalWaitMs: Math.round(performance.now() - waitStarted),
    backgroundInFlightAtStart,
    backgroundInFlightAfterWait: Number(stopSignal.backgroundInFlight ?? 0),
  };
  try {
    return await task(info);
  } finally {
    stopSignal.criticalDepth = Math.max(0, Number(stopSignal.criticalDepth ?? 1) - 1);
    if (stopSignal.criticalDepth === 0) {
      stopSignal.criticalActive = false;
      stopSignal.criticalReason = previousReason ?? "";
    } else {
      stopSignal.criticalReason = previousReason ?? reason;
    }
  }
}

async function runActionWithTimeout(task) {
  let timeout = null;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`timeout azione ${task.name} dopo ${options.actionTimeoutMs}ms`));
      }, options.actionTimeoutMs);
      timeout.unref?.();
    });
    return await Promise.race([
      Promise.resolve().then(() => task.run()),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForInFlightActions(inFlight) {
  const started = performance.now();
  let lastLogAt = 0;
  while (inFlight.size > 0 && performance.now() - started < options.inFlightDrainTimeoutMs) {
    await Promise.race([...inFlight, sleep(1_000)]);
    const now = performance.now();
    if (inFlight.size > 0 && now - lastLogAt > 30_000) {
      lastLogAt = now;
      const waitedMs = Math.round(now - started);
      console.log(`[endurance] attesa azioni in volo: pending=${inFlight.size} waited=${waitedMs}ms/${options.inFlightDrainTimeoutMs}ms`);
      await writeEvent({
        event: "in_flight_drain_progress",
        pending: inFlight.size,
        waitedMs,
        timeoutMs: options.inFlightDrainTimeoutMs,
      });
    }
  }
  if (inFlight.size === 0) {
    await writeEvent({
      event: "in_flight_drain",
      ok: true,
      waitedMs: Math.round(performance.now() - started),
      timeoutMs: options.inFlightDrainTimeoutMs,
    });
    return { ok: true, pending: 0 };
  }
  const pending = inFlight.size;
  const waitedMs = Math.round(performance.now() - started);
  console.log(`[endurance] timeout azioni in volo: pending=${pending} waited=${waitedMs}ms/${options.inFlightDrainTimeoutMs}ms`);
  recorder.recordAction("endurance.inflight.drain", false, waitedMs, `azioni ancora in volo: ${pending}`);
  await writeEvent({
    event: "in_flight_drain",
    ok: false,
    pending,
    waitedMs,
    timeoutMs: options.inFlightDrainTimeoutMs,
  });
  return { ok: false, pending };
}

async function runScheduledActions(baseUrl, state, stopSignal) {
  const tasks = buildActionList(baseUrl, state);
  const pickTask = weightedPicker(tasks);
  const started = performance.now();
  const inFlight = new Set();
  let launched = 0;
  let lastProgressAt = 0;

  while (launched < options.actions) {
    const dueAt = started + (launched * options.durationMs) / Math.max(1, options.actions);
    const waitMs = dueAt - performance.now();
    if (waitMs > 0) await sleep(Math.min(waitMs, 1_000));
    if (!(await waitForBackgroundActionSlot(inFlight, stopSignal))) break;
    const task = pickTask();
    const actionStarted = performance.now();
    launched += 1;
    const promise = Promise.resolve()
      .then(() => runActionWithTimeout(task))
      .then(
        () => recorder.recordAction(task.name, true, performance.now() - actionStarted, ""),
        (error) => recorder.recordAction(task.name, false, performance.now() - actionStarted, error instanceof Error ? error.message : String(error)),
      )
      .finally(() => {
        inFlight.delete(promise);
        stopSignal.backgroundInFlight = inFlight.size;
      });
    inFlight.add(promise);
    stopSignal.backgroundInFlight = inFlight.size;
    const now = performance.now();
    if (now - lastProgressAt > 60_000) {
      lastProgressAt = now;
      const elapsed = Math.round((now - started) / 1000);
      const pct = Math.round((launched / options.actions) * 1000) / 10;
      console.log(`[endurance] azioni=${launched}/${options.actions} (${pct}%) elapsed=${elapsed}s inFlight=${inFlight.size}/${options.actionConcurrency} headroom=${options.criticalHeadroom} critical=${stopSignal.criticalReason || "-"}`);
      await writeEvent({
        event: "progress",
        launched,
        target: options.actions,
        elapsedSeconds: elapsed,
        inFlight: inFlight.size,
        actionConcurrency: options.actionConcurrency,
        criticalHeadroom: options.criticalHeadroom,
        criticalReason: stopSignal.criticalReason || "",
      });
    }
  }
  await waitForInFlightActions(inFlight);
  stopSignal.backgroundInFlight = 0;
  const remaining = started + options.durationMs - performance.now();
  if (remaining > 0) {
    console.log(`[endurance] 50k azioni completate, tengo vivo il carico leggero per ${Math.round(remaining / 1000)}s`);
    while (performance.now() < started + options.durationMs) {
      if (stopSignal.criticalActive === true) {
        await sleep(250);
        continue;
      }
      const session = pickOnline(state.mobileSessions);
      await readTask(baseUrl, session, stationName(rnd(options.stations)));
      await sleep(2_000);
    }
  }
  stopSignal.done = true;
}

function buildRadioFrame(streamId, seq, payloadSize = 160) {
  const buffer = Buffer.alloc(RADIO_HEADER_BYTES + payloadSize);
  buffer.write(RADIO_MAGIC, 0, 4, "ascii");
  buffer.writeUInt32BE(Number(streamId) >>> 0, 4);
  buffer.writeUInt32BE(Number(seq) >>> 0, 8);
  buffer.writeUInt32BE(Date.now() >>> 0, 12);
  for (let index = RADIO_HEADER_BYTES; index < buffer.length; index += 1) {
    buffer[index] = (seq + index) % 255;
  }
  return buffer;
}

function wsEndpoint(baseUrl, pathName) {
  const url = new URL(pathName, `${baseUrl}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function waitForRadioEvent(client, predicate, timeoutMs = options.timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timeout radio event"));
    }, timeoutMs);
    function onEvent(message) {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    }
    function cleanup() {
      clearTimeout(timeout);
      client.listeners.delete(onEvent);
    }
    client.listeners.add(onEvent);
  });
}

async function waitForRadioGrantOrBusy(client, txId, timeoutMs = options.timeoutMs) {
  const message = await waitForRadioEvent(
    client,
    (entry) =>
      (entry?.type === "ptt:grant" && entry.txId === txId) ||
      (entry?.type === "ptt:busy" && (!entry.txId || entry.txId === txId)),
    timeoutMs,
  );
  if (message?.type === "ptt:busy") {
    return { busy: true, message };
  }
  return { busy: false, message };
}

async function openRadioClient(baseUrl, session, channelIds) {
  const socket = new WebSocket(wsEndpoint(baseUrl, "/api/radio/ws"), {
    rejectUnauthorized: false,
    perMessageDeflate: false,
  });
  const client = {
    session,
    socket,
    listeners: new Set(),
    binaryFrames: 0,
    incomingStarts: 0,
    incomingStops: 0,
    busy: 0,
  };
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      client.binaryFrames += 1;
      recorder.radio.binaryFramesReceived += 1;
      return;
    }
    let message = null;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message?.type === "ptt:incoming-start") {
      client.incomingStarts += 1;
      recorder.radio.incomingStarts += 1;
    }
    if (message?.type === "ptt:incoming-stop") {
      client.incomingStops += 1;
      recorder.radio.incomingStops += 1;
    }
    if (message?.type === "ptt:busy") {
      client.busy += 1;
      recorder.radio.busyResponses += 1;
    }
    for (const listener of [...client.listeners]) listener(message);
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timeout apertura radio WS")), options.timeoutMs);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      token: session.token,
      userId: session.user.id,
      deviceUuid: session.deviceUuid,
      clientApp: session.clientApp,
      protocolVersion: 1,
    }),
  );
  await waitForRadioEvent(client, (message) => message?.type === "ready");
  socket.send(JSON.stringify({ type: "subscribe", channelIds }));
  await waitForRadioEvent(client, (message) => message?.type === "subscribed");
  return client;
}

async function runRadioChannel(client, channelId, stopSignal) {
  let streamId = null;
  let seq = 0;
  while (!stopSignal.done) {
    const txId = `end-${channelId}-${Date.now()}-${rnd(100000)}`;
    try {
      client.socket.send(JSON.stringify({ type: "ptt:start", txId, channelId, codec: "mulaw", sampleRate: 16000, frameMs: 20 }));
      const grantResult = await waitForRadioGrantOrBusy(
        client,
        txId,
        Math.min(options.timeoutMs, 12_000),
      );
      if (grantResult.busy) {
        await sleep(400);
        continue;
      }
      const grant = grantResult.message;
      streamId = grant.streamId;
      recorder.radio.restarts += 1;
      const segmentEnd = Date.now() + 25_000;
      while (!stopSignal.done && Date.now() < segmentEnd) {
        client.socket.send(buildRadioFrame(streamId, seq));
        recorder.radio.framesSent += 1;
        seq += 1;
        await sleep(50);
      }
      client.socket.send(JSON.stringify({ type: "ptt:stop", txId }));
      await sleep(100);
    } catch (error) {
      recorder.radio.errors.push({ at: nowIso(), channelId, error: error instanceof Error ? error.message : String(error) });
      if (recorder.radio.errors.length > 50) recorder.radio.errors.shift();
      await sleep(1_000);
    }
  }
}

async function runRadioLoad(baseUrl, sessions, stopSignal) {
  const channelIds = ["bar", "generale", "cassa"];
  const selected = sessions.slice(0, options.radioClients);
  const clients = [];
  try {
    for (let index = 0; index < selected.length; index += 10) {
      const batch = await Promise.all(
        selected.slice(index, index + 10).map((session) =>
          openRadioClient(baseUrl, session, channelIds).catch((error) => {
            recorder.radio.errors.push({ at: nowIso(), channelId: "open", error: error instanceof Error ? error.message : String(error) });
            return null;
          }),
        ),
      );
      clients.push(...batch.filter(Boolean));
    }
    recorder.radio.clientsOpened = clients.length;
    if (clients.length < 4) return;
    const loops = [
      runRadioChannel(clients[0], "bar", stopSignal),
      runRadioChannel(clients[1], "generale", stopSignal),
    ];
    while (!stopSignal.done) {
      const contender = clients[2 + rnd(Math.max(1, clients.length - 2))];
      contender.socket.send(JSON.stringify({ type: "ptt:start", txId: `busy-${Date.now()}-${rnd(9999)}`, channelId: rnd(2) ? "bar" : "generale", codec: "mulaw", sampleRate: 16000, frameMs: 20 }));
      await sleep(5_000);
    }
    await Promise.allSettled(loops);
  } finally {
    for (const client of clients) {
      try {
        client.socket.close();
      } catch {
        // best effort
      }
    }
  }
}

async function automaticCashCycle(baseUrl, state, stopSignal) {
  const admin = state.adminSession;
  const cashUsers = state.mobileSessions.slice(0, Math.min(10, state.mobileSessions.length));
  let userIndex = 0;
  while (!stopSignal.done && userIndex < cashUsers.length) {
    const owner = cashUsers[userIndex];
    userIndex += 1;
    try {
      await withCriticalHeadroom(stopSignal, "automatic_cash", async (critical) => {
        const generated = await requestJson(baseUrl, "automatic_cash.generate", "POST", "/api/automatic-cash/cash-float/generate", owner, {
          reason: "operator_cash_float",
          activityId: "activity_endurance",
          roomId: owner.roomId,
        }, { okStatuses: [200, 409, 423], throwOnError: false });
        recorder.automaticCash.push({
          at: nowIso(),
          step: "generate",
          user: owner.username,
          status: generated.status,
          critical,
          body: compactAutomaticCashBody(generated.body),
        });
        if (generated.status !== 200 || !generated.body?.workflowId) {
          return;
        }

        if (userIndex === 1) {
          await logout(baseUrl, owner);
          const resumed = await requestJson(baseUrl, "automatic_cash.resume_admin", "POST", "/api/automatic-cash/cash-float/generate", admin, {
            reason: "operator_cash_float",
            preferExistingAssignmentForEvening: true,
          }, { okStatuses: [200, 409, 423], throwOnError: false });
          recorder.automaticCash.push({ at: nowIso(), step: "resume_admin_after_owner_disconnect", status: resumed.status, body: compactAutomaticCashBody(resumed.body) });
          Object.assign(owner, await loginWithRetry(baseUrl, owner.username, "2222", owner.deviceUuid, "mobile-frontend"));
        }

        const payload = {
          workflowId: generated.body.workflowId,
          operationId: generated.body.operationId,
          cashFloatId: generated.body.cashFloatId,
        };
        await requestJson(baseUrl, "automatic_cash.confirm_removed", "POST", "/api/automatic-cash/cash-float/confirm-removed", admin, payload, { okStatuses: [200], throwOnError: false });
        await requestJson(baseUrl, "automatic_cash.ticket_printed", "POST", "/api/automatic-cash/cash-float/ticket/printed", admin, {
          ...payload,
          printJobId: `end-float-ticket-${Date.now()}`,
        }, { okStatuses: [200], throwOnError: false });
        const completed = await requestJson(baseUrl, "automatic_cash.confirm_pouch", "POST", "/api/automatic-cash/cash-float/confirm-ticket-in-pouch", admin, payload, { okStatuses: [200], throwOnError: false });
        recorder.automaticCash.push({ at: nowIso(), step: "cash_float_completed", status: completed.status, body: compactAutomaticCashBody(completed.body) });

        const exchange = await requestJson(baseUrl, "automatic_cash.exchange.start", "POST", "/api/automatic-cash/exchange/start", admin, {
          activityId: "activity_endurance",
          roomId: admin.roomId,
        }, { okStatuses: [200, 409, 423], throwOnError: false });
        const exchangeId = exchange.body?.exchangeId;
        if (exchangeId) {
          await requestJson(baseUrl, "automatic_cash.exchange.state", "GET", `/api/automatic-cash/exchange/${exchangeId}/state`, admin, {}, { okStatuses: [200], throwOnError: false });
          await requestJson(baseUrl, "automatic_cash.exchange.confirm_deposit", "POST", `/api/automatic-cash/exchange/${exchangeId}/confirm-deposit`, admin, {
            depositedCents: 2000,
          }, { okStatuses: [200], throwOnError: false });
          await requestJson(baseUrl, "automatic_cash.exchange.execute", "POST", `/api/automatic-cash/exchange/${exchangeId}/execute`, admin, {
            pieces: { 1000: 2 },
          }, { okStatuses: [200], throwOnError: false });
          await requestJson(baseUrl, "automatic_cash.exchange.confirm_removed", "POST", `/api/automatic-cash/exchange/${exchangeId}/confirm-removed`, admin, {}, { okStatuses: [200], throwOnError: false });
          recorder.automaticCash.push({ at: nowIso(), step: "exchange_completed", exchangeId });
        }
      });
    } catch (error) {
      recorder.automaticCash.push({ at: nowIso(), step: "error", error: error instanceof Error ? error.message : String(error) });
    }
    await sleep(Math.min(120_000, Math.max(15_000, Math.floor(options.durationMs / 12))));
  }
}

function compactAutomaticCashBody(body) {
  if (!body || typeof body !== "object") return body;
  return {
    ok: body.ok,
    workflowId: body.workflowId,
    operationId: body.operationId,
    cashFloatId: body.cashFloatId,
    exchangeId: body.exchangeId,
    status: body.status,
    step: body.step,
    totalCents: body.totalCents,
    depositedCents: body.depositedCents,
    depositedTotalCents: body.depositedTotalCents,
    code: body.code,
  };
}

async function runReconnectionChecks(baseUrl, state, stopSignal) {
  const checkpoints = [0.25, 0.55, 0.82].map((ratio) => Date.now() + Math.round(options.durationMs * ratio));
  for (const checkpointAt of checkpoints) {
    while (!stopSignal.done && Date.now() < checkpointAt) await sleep(1_000);
    if (stopSignal.done) break;
    const result = await withCriticalHeadroom(stopSignal, "reconnection", async (critical) => {
      const selectedUsers = state.mobileSessions.slice(0, 10);
      const selectedStations = state.stationSessions.slice(0, 2);
      const started = performance.now();
      const snapshots = [];
      for (const session of selectedUsers) {
        try {
          const beforeRadio = await requestJson(baseUrl, "reconnect.radio.before", "POST", "/api/mobile/radio/config", session, {}, { throwOnError: false });
          await logout(baseUrl, session);
          const denied = await requestJson(baseUrl, "reconnect.old_token_probe", "POST", "/api/mobile/radio/config", session, {}, {
            okStatuses: [200, 401, 403],
            throwOnError: false,
          });
          const fresh = await loginWithRetry(baseUrl, session.username, "2222", session.deviceUuid, "mobile-frontend");
          Object.assign(session, fresh, { online: true });
          const afterRadio = await requestJson(baseUrl, "reconnect.radio.after", "POST", "/api/mobile/radio/config", session, {}, { throwOnError: false });
          const status = await requestJson(baseUrl, "reconnect.automatic_cash.status", "GET", "/api/automatic-cash/status", session, { _: Date.now() }, { throwOnError: false });
          snapshots.push({
            username: session.username,
            oldTokenProbeStatus: denied.status,
            radioStable: JSON.stringify(beforeRadio.body?.slots ?? []) === JSON.stringify(afterRadio.body?.slots ?? []),
            cashStatusOk: status.status === 200,
          });
        } catch (error) {
          snapshots.push({
            username: session.username,
            reconnectError: error instanceof Error ? error.message : String(error),
            radioStable: false,
            cashStatusOk: false,
          });
          session.online = false;
        }
      }
      for (const pair of selectedStations) {
        try {
          await stationHeartbeat(baseUrl, pair.session, pair.station, false);
          await logout(baseUrl, pair.session);
          const fresh = await loginWithRetry(baseUrl, pair.session.username, "2222", pair.session.deviceUuid, "postazione");
          Object.assign(pair.session, fresh, { online: true });
          await stationHeartbeat(baseUrl, pair.session, pair.station, true);
        } catch (error) {
          recorder.failures.push({
            at: nowIso(),
            name: "reconnect.station",
            status: 0,
            phase: recorder.phase(),
            detail: `${pair.station}: ${error instanceof Error ? error.message : String(error)}`,
          });
          pair.session.online = false;
        }
      }
      return {
        at: nowIso(),
        elapsedMs: Math.round(performance.now() - started),
        usersChecked: snapshots.length,
        stationsChecked: selectedStations.length,
        allRadioStable: snapshots.every((entry) => entry.radioStable),
        allCashStatusOk: snapshots.every((entry) => entry.cashStatusOk),
        critical,
        snapshots,
      };
    });
    recorder.reconnections.push(result);
    await writeEvent({ event: "reconnection_check", result });
  }
}

async function monitorLoop(backend, stopSignal) {
  const samples = [];
  while (!stopSignal.done) {
    const sample = {
      at: nowIso(),
      load1: os.loadavg()[0],
      freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      dbSizeMb: 0,
      backend: await readProcSample(backend.child.pid),
      runner: await readProcSample(process.pid),
    };
    try {
      const stat = await fs.stat(backend.dbPath);
      sample.dbSizeMb = round(stat.size / 1024 / 1024);
    } catch {
      sample.dbSizeMb = 0;
    }
    samples.push(sample);
    await sleep(options.monitorIntervalMs);
  }
  return samples;
}

async function readProcSample(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
    const parts = stat.split(" ");
    return {
      pid,
      cpuTicks: (Number(parts[13]) || 0) + (Number(parts[14]) || 0),
      rssMb: round((Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0) / 1024)),
    };
  } catch {
    return { pid, missing: true };
  }
}

function summarizeMonitor(samples) {
  if (!samples.length) return { samples: 0 };
  const backendRss = samples.map((sample) => sample.backend?.rssMb ?? 0).filter(Boolean);
  const dbSize = samples.map((sample) => sample.dbSizeMb ?? 0);
  return {
    samples: samples.length,
    load1Max: round(Math.max(...samples.map((sample) => sample.load1 || 0))),
    backendRssStartMb: backendRss[0] ?? 0,
    backendRssEndMb: backendRss[backendRss.length - 1] ?? 0,
    backendRssMaxMb: round(Math.max(...backendRss, 0)),
    dbSizeStartMb: dbSize[0] ?? 0,
    dbSizeEndMb: dbSize[dbSize.length - 1] ?? 0,
    dbSizeMaxMb: round(Math.max(...dbSize, 0)),
  };
}

async function saveInitialRadioPreferences(baseUrl, sessions) {
  const slots = ["bar", "generale", "cassa"];
  await Promise.all(
    sessions.slice(0, Math.min(20, sessions.length)).map((session) =>
      requestJson(baseUrl, "radio.save_config.seed", "POST", "/api/mobile/radio/config/save", session, { slots }, {
        okStatuses: [200],
        throwOnError: false,
      }),
    ),
  );
}

async function bootstrap(baseUrl) {
  const state = {
    mobileSessions: [],
    stationSessions: [],
    tables: [],
    ordersById: new Map(),
    orderIds: [],
    adminSession: null,
  };
  state.tables = rooms.flatMap((room) =>
    Array.from({ length: 80 }, (_, index) => ({
      id: `${room.id}_t${String(index + 1).padStart(2, "0")}`,
      roomId: room.id,
      number: index + 1,
    })),
  );
  state.adminSession = await login(baseUrl, "end_admin", "1111", "end-admin-device", "mobile-frontend");
  await configureAutomaticCash(baseUrl, state.adminSession);
  for (let index = 0; index < options.mobileDevices; index += 1) {
    const userNo = (index % options.mobileUsers) + 1;
    const username = mobileUserName(userNo - 1);
    const session = await login(baseUrl, username, "2222", `end-mobile-${String(index + 1).padStart(3, "0")}`, "mobile-frontend");
    state.mobileSessions.push(session);
  }
  for (let index = 0; index < options.stations; index += 1) {
    const station = stationName(index);
    const username = stationUserName(index);
    const session = await login(baseUrl, username, "2222", `end-station-${String(index + 1).padStart(3, "0")}`, "postazione", {
      station,
      stationName: station,
    });
    state.stationSessions.push({ session, station });
    await stationHeartbeat(baseUrl, session, station, true);
  }
  await saveInitialRadioPreferences(baseUrl, state.mobileSessions);
  return state;
}

async function warmupFiscalizedPayments(baseUrl, state) {
  const count = clampInt(
    process.env.ENDURANCE_FISCAL_WARMUP_PAYMENTS,
    0,
    100,
    12,
  );
  if (count <= 0) return { created: 0, paid: 0 };
  let created = 0;
  let paid = 0;
  for (let index = 0; index < count; index += 1) {
    const session = state.mobileSessions[index % state.mobileSessions.length];
    const table = state.tables[(index * 7) % state.tables.length];
    const createdResult = await createOrder(
      baseUrl,
      session,
      table,
      state,
      index % 4 === 0,
    );
    const order = createdResult?.body?.order ?? pickOrder(state);
    if (order?.id) {
      created += 1;
      const paidResult = await payOrder(baseUrl, session, order, false);
      if (paidResult?.ok) paid += 1;
    }
    await sleep(50);
  }
  await sleep(1500);
  const checkpoint = { event: "fiscal_warmup", created, paid };
  recorder.pushCheckpoint(checkpoint);
  await writeEvent(checkpoint);
  console.log(`[endurance] fiscal warmup created=${created} paid=${paid}`);
  return { created, paid };
}

async function configureAutomaticCash(baseUrl, adminSession) {
  const uploadedConfig = await requestJson(
    baseUrl,
    "automatic_cash.upload_config",
    "POST",
    "/api/automatic-cash/config-sets",
    adminSession,
    { config: automaticCashSeed.rawConfig },
    { okStatuses: [200], throwOnError: false, timeoutMs: 30_000 },
  );
  const uploadedReserve = await requestJson(
    baseUrl,
    "automatic_cash.upload_reserve",
    "POST",
    "/api/automatic-cash/reserve-configs",
    adminSession,
    { config: automaticCashSeed.reserveRawConfig },
    { okStatuses: [200], throwOnError: false, timeoutMs: 30_000 },
  );
  const configSetId = uploadedConfig.body?.configSetId ?? uploadedConfig.body?.automaticCash?.configSetId ?? automaticCashSeed.automaticCash.configSetId;
  const reserveConfigId =
    uploadedReserve.body?.reserveConfigId ?? uploadedReserve.body?.automaticCash?.reserveConfigId ?? automaticCashSeed.automaticCash.reserveConfigId;
  await requestJson(
    baseUrl,
    "automatic_cash.save_settings",
    "PUT",
    "/api/automatic-cash/settings",
    adminSession,
    {
      enabled: true,
      gatewayConfigured: true,
      gatewayInventory: buildGatewayInventory(),
      feedbackEnabled: true,
      warningThresholdCents: 1000,
      dangerThresholdCents: 1000,
      autoCashFloatMode: "random_file",
      configSetId,
      reserveConfigId,
    },
    { okStatuses: [200], throwOnError: false, timeoutMs: 30_000 },
  );
  const status = await requestJson(
    baseUrl,
    "automatic_cash.configure_status",
    "GET",
    "/api/automatic-cash/status",
    adminSession,
    { _: Date.now() },
    { okStatuses: [200], throwOnError: false },
  );
  if (status.body?.enabled !== true || status.body?.gatewayConfigured !== true) {
    throw new Error(`configurazione automatic-cash non attiva: ${JSON.stringify(status.body)}`);
  }
}

async function finalScarichi(baseUrl, state, dbPath) {
  await completeActiveAutomaticCashWorkflows(baseUrl, state, dbPath);
  const db = await readJson(dbPath);
  const automaticCash = db.posSettings?.automaticCash ?? {};
  const activeCashFloats = (automaticCash.cashFloats ?? []).filter((cashFloat) => cashFloat.status === "ACTIVE");
  for (const cashFloat of activeCashFloats) {
    const start = await requestJson(baseUrl, "automatic_cash.deposit.start", "POST", "/api/automatic-cash/deposit/start", state.adminSession, {
      cashFloatId: cashFloat.cashFloatId,
    }, { okStatuses: [200, 400, 404], throwOnError: false });
    const operationId = start.body?.operationId;
    if (operationId) {
      await requestJson(baseUrl, "automatic_cash.deposit.close", "POST", "/api/automatic-cash/deposit/close", state.adminSession, {
        operationId,
        depositedTotalCents: cashFloat.totalCents,
      }, { okStatuses: [200], throwOnError: false });
      await requestJson(baseUrl, "automatic_cash.settlement.save", "POST", "/api/automatic-cash/settlements", state.adminSession, {
        id: `end-settlement-${cashFloat.cashFloatId}`,
        cashFloatId: cashFloat.cashFloatId,
        expectedDepositTotalCents: cashFloat.totalCents,
        depositedTotalCents: cashFloat.totalCents,
        completedAtMs: Date.now(),
        note: "Scarico finale endurance",
      }, { okStatuses: [200], throwOnError: false });
    }
  }
}

async function completeActiveAutomaticCashWorkflows(baseUrl, state, dbPath) {
  const db = await readJson(dbPath);
  const automaticCash = db.posSettings?.automaticCash ?? {};
  const activeWorkflows = (automaticCash.workflows ?? []).filter(
    (entry) => !["COMPLETED", "FAILED_BEFORE_DISPENSE", "CANCELLED", "INCIDENT_REVIEW"].includes(String(entry?.step ?? "")),
  );
  for (const workflow of activeWorkflows) {
    const resume = await requestJson(baseUrl, "automatic_cash.final_resume_admin", "POST", "/api/automatic-cash/cash-float/generate", state.adminSession, {
      reason: workflow.reason || "operator_cash_float",
      activityId: workflow.activityId || "activity_endurance",
      roomId: workflow.roomId || state.adminSession.roomId,
      preferExistingAssignmentForEvening: true,
    }, { okStatuses: [200, 409, 423], throwOnError: false, timeoutMs: 30_000 });
    recorder.automaticCash.push({
      at: nowIso(),
      step: "final_resume_admin",
      status: resume.status,
      body: compactAutomaticCashBody(resume.body),
    });
    const payload = {
      workflowId: resume.body?.workflowId || workflow.workflowId,
      operationId: resume.body?.operationId || workflow.operationId,
      cashFloatId: resume.body?.cashFloatId || workflow.cashFloatId,
    };
    if (!payload.workflowId && !payload.operationId && !payload.cashFloatId) continue;
    await requestJson(baseUrl, "automatic_cash.final_confirm_removed", "POST", "/api/automatic-cash/cash-float/confirm-removed", state.adminSession, payload, {
      okStatuses: [200, 409, 404, 423, 503],
      throwOnError: false,
      timeoutMs: 30_000,
    });
    await requestJson(baseUrl, "automatic_cash.final_ticket_printed", "POST", "/api/automatic-cash/cash-float/ticket/printed", state.adminSession, {
      ...payload,
      printJobId: `end-final-float-ticket-${Date.now()}`,
    }, {
      okStatuses: [200, 409, 404, 423, 503],
      throwOnError: false,
      timeoutMs: 30_000,
    });
    const completed = await requestJson(
      baseUrl,
      "automatic_cash.final_confirm_pouch",
      "POST",
      "/api/automatic-cash/cash-float/confirm-ticket-in-pouch",
      state.adminSession,
      payload,
      { okStatuses: [200, 409, 404, 423, 503], throwOnError: false, timeoutMs: 30_000 },
    );
    recorder.automaticCash.push({
      at: nowIso(),
      step: "final_cash_float_completed",
      status: completed.status,
      body: compactAutomaticCashBody(completed.body),
    });
  }
}

function validateFinalState(db, state, monitorSummary) {
  const findings = [];
  const warnings = [];
  const stationStates = Array.isArray(db.integration?.stationStates) ? db.integration.stationStates : [];
  const activeStations = stationStates.filter((entry) => entry.active === true && entry.stale !== true);
  if (activeStations.length < options.stations) findings.push(`postazioni attive ${activeStations.length}/${options.stations}`);
  const notifications = Array.isArray(db.integration?.notifications) ? db.integration.notifications : [];
  const notificationIds = notifications.map((entry) => String(entry?.id ?? "")).filter(Boolean);
  const duplicateNotifications = duplicates(notificationIds);
  if (duplicateNotifications.length) findings.push(`notification duplicate: ${duplicateNotifications.slice(0, 5).join(", ")}`);
  const paymentContainers = Array.isArray(db.paymentContainers) ? db.paymentContainers : [];
  const idemKeys = paymentContainers.map((entry) => String(entry?.idempotencyKey ?? "")).filter(Boolean);
  const duplicateIdemKeys = duplicates(idemKeys);
  if (duplicateIdemKeys.length) findings.push(`payment idempotency duplicate: ${duplicateIdemKeys.slice(0, 5).join(", ")}`);
  const orders = Array.isArray(db.integration?.orders) ? db.integration.orders : [];
  const negativeOrders = orders.filter((order) => Number(order?.dueAmount ?? 0) < -0.01 || Number(order?.paidAmount ?? 0) < -0.01);
  if (negativeOrders.length) findings.push(`ordini con saldi negativi: ${negativeOrders.length}`);
  const tables = Array.isArray(db.posSettings?.tables) ? db.posSettings.tables : [];
  const negativeTables = tables.filter((table) => Number(table?.totalDue ?? 0) < -0.01);
  if (negativeTables.length) findings.push(`tavoli con totale negativo: ${negativeTables.length}`);
  const jobs = Array.isArray(db.printSpoolJobs) ? db.printSpoolJobs : [];
  const jobIds = jobs.map((job) => String(job?.id ?? "")).filter(Boolean);
  const duplicateJobIds = duplicates(jobIds);
  if (duplicateJobIds.length) findings.push(`print job duplicate: ${duplicateJobIds.slice(0, 5).join(", ")}`);
  const failedPrintJobs = jobs.filter((job) => String(job?.status ?? "").trim().toLowerCase().startsWith("failed"));
  if (failedPrintJobs.length) findings.push(`print job falliti/configurazione errata: ${failedPrintJobs.length}`);
  const pendingPrintJobs = jobs.filter((job) => ["queued", "processing"].includes(String(job?.status ?? "").trim().toLowerCase()));
  if (pendingPrintJobs.length) findings.push(`print job non drenati: ${pendingPrintJobs.length}`);
  const fiscalReceipts = Array.isArray(db.fiscalReceipts) ? db.fiscalReceipts : [];
  const fiscalEvents = Array.isArray(db.fiscalEvents) ? db.fiscalEvents : [];
  const pendingFiscalReceipts = fiscalReceipts.filter((receipt) => {
    const status = String(receipt?.fiscalStatus ?? receipt?.status ?? "").trim().toUpperCase();
    return ["PENDING", "PROCESSING"].includes(status);
  });
  if (pendingFiscalReceipts.length) findings.push(`ricevute fiscali non drenate: ${pendingFiscalReceipts.length}`);
  const automaticCash = db.posSettings?.automaticCash ?? {};
  const activeWorkflows = (automaticCash.workflows ?? []).filter((entry) => !["COMPLETED", "FAILED_BEFORE_DISPENSE", "CANCELLED"].includes(String(entry?.step ?? "")));
  if (activeWorkflows.length) warnings.push(`workflow fondo cassa ancora attivi: ${activeWorkflows.length}`);
  const activeExchanges = (automaticCash.cashExchanges ?? []).filter((entry) => !["COMPLETED", "FAILED", "CANCELLED"].includes(String(entry?.status ?? "")));
  if (activeExchanges.length) warnings.push(`cambi automatici ancora attivi: ${activeExchanges.length}`);
  const activeCashFloats = (automaticCash.cashFloats ?? []).filter((entry) => entry.status === "ACTIVE");
  if (activeCashFloats.length) warnings.push(`fondi cassa ancora active dopo scarico finale: ${activeCashFloats.length}`);
  const radioPreferences = Array.isArray(db.posSettings?.radioPreferences) ? db.posSettings.radioPreferences : [];
  const usersWithPrefs = new Set(radioPreferences.map((entry) => String(entry?.userId ?? "")));
  const expectedPrefUsers = Array.from({ length: Math.min(10, options.mobileUsers) }, (_, index) => `u_end_mobile_${String(index + 1).padStart(2, "0")}`);
  const missingPrefs = expectedPrefUsers.filter((userId) => !usersWithPrefs.has(userId));
  if (missingPrefs.length) warnings.push(`preferenze radio mancanti per utenti: ${missingPrefs.join(", ")}`);
  if (!recorder.reconnections.length) warnings.push("nessun checkpoint riconnessione eseguito");
  const failedReconnects = recorder.reconnections.filter(
    (entry) =>
      entry.allRadioStable !== true ||
      entry.allCashStatusOk !== true ||
      entry.snapshots?.some((snapshot) => snapshot.reconnectError),
  );
  if (failedReconnects.length) {
    findings.push(`checkpoint riconnessione falliti: ${failedReconnects.length}`);
  }
  if (recorder.radio.clientsOpened < options.radioClients) {
    findings.push(`radio WS aperti ${recorder.radio.clientsOpened}/${options.radioClients}`);
  }
  const radioTimeoutErrors = recorder.radio.errors.filter((entry) =>
    /timeout|timed out/i.test(String(entry?.error ?? "")),
  );
  if (radioTimeoutErrors.length) {
    findings.push(`timeout radio rilevati: ${radioTimeoutErrors.length}`);
  }
  const loginBucket = recorder.http.get("auth.login");
  if (loginBucket?.fail) {
    findings.push(`login falliti o in timeout: ${loginBucket.fail}/${loginBucket.count}`);
  }
  const stationHeartbeatBucket = recorder.http.get("station.heartbeat");
  if (stationHeartbeatBucket?.fail) {
    findings.push(`heartbeat postazioni falliti o in timeout: ${stationHeartbeatBucket.fail}/${stationHeartbeatBucket.count}`);
  }
  const orderSyncReadyBucket = recorder.http.get("order.sync.ready");
  if (orderSyncReadyBucket?.fail) {
    findings.push(`sync comande ready falliti o in timeout: ${orderSyncReadyBucket.fail}/${orderSyncReadyBucket.count}`);
  }
  const orderSyncDeliveredBucket = recorder.http.get("order.sync.delivered");
  if (orderSyncDeliveredBucket?.fail) {
    findings.push(`sync comande delivered falliti o in timeout: ${orderSyncDeliveredBucket.fail}/${orderSyncDeliveredBucket.count}`);
  }
  const lockAcquireBucket = recorder.http.get("lock.acquire");
  if (lockAcquireBucket?.fail) {
    findings.push(`lock acquire falliti o in timeout: ${lockAcquireBucket.fail}/${lockAcquireBucket.count}`);
  }
  const lockReleaseBucket = recorder.http.get("lock.release");
  if (lockReleaseBucket?.fail) {
    findings.push(`lock release falliti o in timeout: ${lockReleaseBucket.fail}/${lockReleaseBucket.count}`);
  }
  if (monitorSummary.backendRssEndMb > monitorSummary.backendRssStartMb + 300) {
    warnings.push(`RSS backend cresciuto di ${round(monitorSummary.backendRssEndMb - monitorSummary.backendRssStartMb)} MB`);
  }
  return {
    ok: findings.length === 0,
    findings,
    warnings,
    counts: {
      orders: orders.length,
      tables: tables.length,
      notifications: notifications.length,
      paymentContainers: paymentContainers.length,
      paymentTransactions: Array.isArray(db.paymentTransactions) ? db.paymentTransactions.length : 0,
      printSpoolJobs: jobs.length,
      failedPrintJobs: failedPrintJobs.length,
      pendingPrintJobs: pendingPrintJobs.length,
      fiscalReceipts: fiscalReceipts.length,
      fiscalEvents: fiscalEvents.length,
      pendingFiscalReceipts: pendingFiscalReceipts.length,
      activeStations: activeStations.length,
      radioPreferences: radioPreferences.length,
      automaticCashWorkflows: Array.isArray(automaticCash.workflows) ? automaticCash.workflows.length : 0,
      automaticCashExchanges: Array.isArray(automaticCash.cashExchanges) ? automaticCash.cashExchanges.length : 0,
      automaticCashSettlements: Array.isArray(automaticCash.settlementRecords) ? automaticCash.settlementRecords.length : 0,
    },
  };
}

function duplicates(values) {
  const seen = new Set();
  const dupes = new Set();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}

function renderMarkdown(report) {
  const topHttp = report.recorder.http.slice(0, 18);
  const topActions = report.recorder.actions.slice(0, 18);
  const actionCount = report.recorder.actions.reduce((sum, entry) => sum + entry.count, 0);
  const httpCount = report.recorder.http.reduce((sum, entry) => sum + entry.count, 0);
  const drift = report.recorder.http
    .filter((entry) => entry.lateVsEarlyP95 && entry.count >= 20)
    .sort((left, right) => (right.lateVsEarlyP95 ?? 0) - (left.lateVsEarlyP95 ?? 0))
    .slice(0, 12);
  return `# Endurance 50k ${report.runId}

## Sintesi
- Durata: ${Math.round(report.recorder.durationMs / 1000)} s
- Azioni: ${actionCount}/${report.options.actions}
- HTTP totali: ${httpCount}
- Concorrenza: background ${report.options.actionConcurrency}, headroom critico ${report.options.criticalHeadroom}, limite totale ${report.options.maxConcurrency}
- Timeout azione: ${report.options.actionTimeoutMs} ms, drain azioni in volo: ${report.options.inFlightDrainTimeoutMs} ms
- Device mobili: ${report.options.mobileDevices}
- Postazioni: ${report.options.stations}
- Radio WS aperti: ${report.recorder.radio.clientsOpened}
- Esito invarianti: ${report.validation.ok ? "OK" : "FAIL"}
- Finding: ${report.validation.findings.length}
- Warning: ${report.validation.warnings.length}

## Conteggi Finali
${Object.entries(report.validation.counts).map(([key, value]) => `- ${key}: ${value}`).join("\n")}

## Monitor
- RSS backend: start ${report.monitor.backendRssStartMb} MB, end ${report.monitor.backendRssEndMb} MB, max ${report.monitor.backendRssMaxMb} MB
- DB JSON: start ${report.monitor.dbSizeStartMb} MB, end ${report.monitor.dbSizeEndMb} MB, max ${report.monitor.dbSizeMaxMb} MB
- Load1 max: ${report.monitor.load1Max}

## Drain Finale
- Esito: ${report.drain?.ok ? "OK" : "TIMEOUT"}
- Attesa: ${report.drain?.waitedMs ?? 0} ms / ${report.drain?.timeoutMs ?? 0} ms
- Print pending: ${report.drain?.pendingPrintJobs ?? 0}
- Print failed: ${report.drain?.failedPrintJobs ?? 0}
- Fiscal pending: ${report.drain?.pendingFiscalReceipts ?? 0}

${renderRuntimeMetricsMarkdown(report.runtimeMetrics)}

## Radio
- Frame TX: ${report.recorder.radio.framesSent}
- Frame RX binari: ${report.recorder.radio.binaryFramesReceived}
- Start RX: ${report.recorder.radio.incomingStarts}
- Stop RX: ${report.recorder.radio.incomingStops}
- Busy response: ${report.recorder.radio.busyResponses}
- Restart segmenti TX: ${report.recorder.radio.restarts}
- Errori radio campionati: ${report.recorder.radio.errors.length}

## HTTP Principali
| Endpoint | Count | Fail | p50 | p95 | p99 | Max | Early p95 | Late p95 | Late/Early |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${topHttp.map((entry) => `| ${entry.name} | ${entry.count} | ${entry.fail} | ${entry.p50Ms} | ${entry.p95Ms} | ${entry.p99Ms} | ${entry.maxMs} | ${entry.earlyP95Ms} | ${entry.lateP95Ms} | ${entry.lateVsEarlyP95 ?? ""} |`).join("\n")}

## Azioni High-Level
| Azione | Count | Fail | p50 | p95 | p99 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${topActions.map((entry) => `| ${entry.name} | ${entry.count} | ${entry.fail} | ${entry.p50Ms} | ${entry.p95Ms} | ${entry.p99Ms} | ${entry.maxMs} |`).join("\n")}

## Drift Latenza Fine/Inizio
${drift.length ? drift.map((entry) => `- ${entry.name}: early p95 ${entry.earlyP95Ms} ms, late p95 ${entry.lateP95Ms} ms, ratio ${entry.lateVsEarlyP95}`).join("\n") : "- Nessun drift calcolabile con campione sufficiente."}

## Riconnessioni
${report.recorder.reconnections.map((entry) => `- ${entry.at}: utenti ${entry.usersChecked}, postazioni ${entry.stationsChecked}, radio stabile=${entry.allRadioStable}, cash status=${entry.allCashStatusOk}, wait critico=${entry.critical?.criticalWaitMs ?? 0} ms, bg start=${entry.critical?.backgroundInFlightAtStart ?? ""}, bg dopo=${entry.critical?.backgroundInFlightAfterWait ?? ""}`).join("\n") || "- Nessuna."}

## Automatic Cash
${report.recorder.automaticCash.slice(-30).map((entry) => `- ${entry.at}: ${entry.step} ${entry.status ?? ""} ${entry.exchangeId ?? entry.body?.cashFloatId ?? ""}`).join("\n") || "- Nessun evento."}

## Finding
${report.validation.findings.length ? report.validation.findings.map((item) => `- ${item}`).join("\n") : "- Nessun finding bloccante."}

## Warning
${report.validation.warnings.length ? report.validation.warnings.map((item) => `- ${item}`).join("\n") : "- Nessun warning."}

## File
- DB isolato: ${report.backend.dbPath}
- Eventi: ${eventsPath}
- Report JSON: ${reportJsonPath}
`;
}

function histogramBucketAt(snapshot, percentile = 0.95) {
  if (!snapshot?.count) return "n/d";
  const target = Math.max(1, Math.ceil(snapshot.count * percentile));
  let running = 0;
  for (const [bucket, count] of Object.entries(snapshot.buckets || {})) {
    running += Number(count) || 0;
    if (running >= target) return `<=${bucket}`;
  }
  return `>${Object.keys(snapshot.buckets || {}).at(-1) || "bucket"}`;
}

function topHistogramRows(map, limit = 8) {
  return Object.entries(map || {})
    .sort((left, right) => (right[1]?.count || 0) - (left[1]?.count || 0))
    .slice(0, limit);
}

function renderRuntimeMetricsMarkdown(metrics) {
  if (!metrics) {
    return `## Runtime Metrics
- Non disponibili.`;
  }
  if (metrics.ok === false) {
    return `## Runtime Metrics
- Non disponibili: status ${metrics.status ?? "n/d"} ${metrics.error ?? ""}`;
  }
  const counters = metrics.counters || {};
  const appState = metrics.appState || {};
  const queues = metrics.queues || {};
  const lastQueue = queues.lastSample || {};
  const dbWaitRows = topHistogramRows(queues.dbMutation?.waitMsByLabel);
  const dbRunRows = topHistogramRows(queues.dbMutation?.runMsByLabel);
  const orderLaneWaitRows = topHistogramRows(queues.orderLane?.waitMsByLabel);
  const appStateWriteRows = topHistogramRows(appState.writeRunMsByLabel);
  const operationRows = topHistogramRows(metrics.operations?.runMsByLabel);
  const readRows = topHistogramRows(metrics.requests?.readDbCountByRoute);
  const writeRows = topHistogramRows(metrics.requests?.writeDbCountByRoute);
  const orderSyncRequests = metrics.requests?.runMsByRoute?.["POST /api/integration/orders/sync"]?.count ?? 0;
  const terminalSyncNoops = counters.orderTerminalDuplicateSyncNoops ?? 0;
  const terminalSyncPreLaneNoops = counters.orderTerminalDuplicateSyncPreLaneNoops ?? 0;
  const terminalSyncNoopRate = orderSyncRequests ? money((terminalSyncNoops / orderSyncRequests) * 100) : 0;
  const orderSyncTableStateChanged = counters.orderSyncTableStateChanged ?? 0;
  const orderSyncTableStateNoops = counters.orderSyncTableStateNoops ?? 0;
  const orderSyncTableStateChangeRate = orderSyncRequests ? money((orderSyncTableStateChanged / orderSyncRequests) * 100) : 0;
  return `## Runtime Metrics
- Abilitate: ${metrics.enabled === true ? "si" : "no"}
- Richieste osservate: ${counters.requests ?? 0}
- readDb/writeDb totali: ${counters.readDb ?? 0} / ${counters.writeDb ?? 0}
- writeDb persistiti/noop comparable/noop persistedComparable/dirty externalized: ${counters.writeDbPersisted ?? 0} / ${counters.writeDbNoopComparable ?? 0} / ${counters.writeDbNoopPersistedComparable ?? 0} / ${counters.writeDbDirtyExternalized ?? 0}
- Sync terminali duplicate no-op: ${terminalSyncNoops} / ${orderSyncRequests} (${terminalSyncNoopRate}%), pre-lane ${terminalSyncPreLaneNoops}
- Sync table-state changed/no-op: ${orderSyncTableStateChanged} / ${orderSyncTableStateNoops} (${orderSyncTableStateChangeRate}% changed)
- Order lane enqueue: ${counters.orderLaneEnqueued ?? 0}
- Coda finale dbMutation/orderLane: ${lastQueue.dbDepth ?? 0} / ${lastQueue.orderLaneDepth ?? 0}
- writeDb run p95 bucket: ${histogramBucketAt(appState.writeRunMs)}
- readDb run p95 bucket: ${histogramBucketAt(appState.readRunMs)}
- Byte comparable per write p95 bucket: ${histogramBucketAt(appState.writeComparableBytes)}
- Byte persistiti per write p95 bucket: ${histogramBucketAt(appState.writePersistedBytes)}

### Runtime Metrics - dbMutation wait
| Label | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${dbWaitRows.map(([label, item]) => `| ${label} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - dbMutation run
| Label | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${dbRunRows.map(([label, item]) => `| ${label} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - order lane wait
| Label | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${orderLaneWaitRows.map(([label, item]) => `| ${label} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - app-state write per label
| Label | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${appStateWriteRows.map(([label, item]) => `| ${label} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - operations
| Label | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${operationRows.map(([label, item]) => `| ${label} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - readDb per request
| Route | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${readRows.map(([label, item]) => `| ${label} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}

### Runtime Metrics - writeDb per request
| Route | Count | Avg | p95 bucket | Max |
| --- | ---: | ---: | ---: | ---: |
${writeRows.map(([label, item]) => `| ${label} | ${item.count} | ${item.avg} | ${histogramBucketAt(item)} | ${item.max} |`).join("\n") || "| n/d | 0 | 0 | n/d | 0 |"}`;
}

const globalState = {
  mobileSessions: [],
  stationSessions: [],
  tables: [],
  ordersById: new Map(),
  orderIds: [],
  adminSession: null,
};

async function main() {
  if (options.help) {
    printHelp();
    return;
  }
  await fs.mkdir(outputDir, { recursive: true });
  automaticCashSeed = await prepareAutomaticCashSeed();
  await writeEvent({ event: "start", runId, options, outputDir });
  console.log(`[endurance] avvio backend isolato: actions=${options.actions} durationMs=${options.durationMs} mobile=${options.mobileDevices} stations=${options.stations}`);
  console.log(`[endurance] automatic-cash config=${automaticCashSeed.configPath}`);
  console.log(
    `[endurance] stampa=${virtualPrintingEnabled ? "tcp-virtuale" : "disabilitata"} target=${virtualPrinterHost}:${virtualPrinterPort} fiscale=${virtualFiscalBaseUrl}`,
  );

  const cleanups = [];
  const harness = {
    after(fn) {
      cleanups.push(fn);
    },
  };
  const backendRunDir = path.join(outputDir, "backend-run");
  await fs.mkdir(backendRunDir, { recursive: true });
  const backend = await startBackend(harness, {
    timeoutMs: 30_000,
    runDir: backendRunDir,
    env: {
      PRINTING_ENABLED: virtualPrintingEnabled ? "1" : "0",
      FISCAL_PROVIDER: "mock",
      APP_STATE_DIRTY_TRACKING: "shadow",
      APP_STATE_DIRTY_TRACKING_MODE: "shadow",
      SCOPED_READS: "1",
      SSE_EVENT_PAYLOAD: "1",
      PRINT_SPOOL_FAST_WORKER: "1",
      PRINT_TCP_TIMEOUT_MS: "1500",
      POS_FISCAL_API_BASE_URL: virtualFiscalBaseUrl,
      POS_FISCAL_API_TIMEOUT_MS: "2000",
      POS_FISCAL_API_JOB_RETRY_DELAY_MS: "50",
      POS_FISCAL_API_JOB_MAX_ATTEMPTS: "3",
      LOGIN_RATE_LIMIT_MAX_ATTEMPTS: "100000",
      LOGIN_RATE_LIMIT_WINDOW_MS: "1000",
      RUNTIME_METRICS: "1",
      RUNTIME_METRICS_QUEUE_SAMPLE_LIMIT: String(Math.max(5000, options.actions)),
      INTEGRATION_MAX_STATION_STATES: String(Math.max(256, options.stations * 4)),
      INTEGRATION_STATION_HEARTBEAT_WRITE_MIN_INTERVAL_MS: "0",
      SESSION_HEARTBEAT_WRITE_MIN_INTERVAL_MS: "300000",
      BACKEND_APP_STATE_SPLIT_AUDIT_EVENTS: "externalized",
      BACKEND_APP_STATE_SPLIT_PRINT_SPOOL_JOBS: "externalized",
      BACKEND_APP_STATE_SPLIT_DEVICE_STATUS: "externalized",
      BACKEND_APP_STATE_SPLIT_TABLE_LOCKS: "externalized",
      BACKEND_APP_STATE_SPLIT_TABLE_STATES: "externalized",
      BACKEND_APP_STATE_SPLIT_ORDERS: "externalized",
      BACKEND_APP_STATE_SPLIT_PAYMENTS_FISCAL: "externalized",
      BACKEND_APP_STATE_SPLIT_DB_PATH: path.join(backendRunDir, "app-state-split.sqlite"),
      AUTOMATIC_CASH_SIMULATOR_SEED: "1",
      AUTOMATIC_CASH_SIMULATOR_CONFIG_PATH: path.resolve(
        projectRoot,
        "cassa-frontend/backend/fixtures/fondo_cassa_100_combinazioni.json",
      ),
    },
    stateOverrides: seedState,
  });
  console.log(`[endurance] backend=${backend.baseUrl} db=${backend.dbPath}`);
  await forceAutomaticCashSeed(backend.dbPath);
  const seededDb = await readJson(backend.dbPath);
  const seededAutomaticCash = seededDb.posSettings?.automaticCash ?? {};
  console.log(
    `[endurance] automatic-cash seeded enabled=${seededAutomaticCash.enabled === true} configSets=${Array.isArray(seededAutomaticCash.configSets) ? seededAutomaticCash.configSets.length : 0} reserveConfigs=${Array.isArray(seededAutomaticCash.reserveConfigs) ? seededAutomaticCash.reserveConfigs.length : 0}`,
  );

  const stopSignal = { done: false };
  const monitorPromise = monitorLoop(backend, stopSignal);
  try {
    const boot = await bootstrap(backend.baseUrl);
    Object.assign(globalState, boot);
    await fetchRuntimeMetrics(backend.baseUrl, globalState.adminSession, "reset");
    recorder.pushCheckpoint({
      event: "bootstrapped",
      mobileSessions: globalState.mobileSessions.length,
      stationSessions: globalState.stationSessions.length,
      tables: globalState.tables.length,
    });
    await writeEvent({ event: "bootstrapped", mobile: globalState.mobileSessions.length, stations: globalState.stationSessions.length });
    await warmupFiscalizedPayments(backend.baseUrl, globalState);

    const radioStop = { done: false };
    const radioPromise = runRadioLoad(backend.baseUrl, globalState.mobileSessions, radioStop).catch((error) => {
      recorder.radio.errors.push({ at: nowIso(), channelId: "radio_load", error: error instanceof Error ? error.message : String(error) });
    });
    const reconnectPromise = runReconnectionChecks(backend.baseUrl, globalState, stopSignal).catch((error) => {
      recorder.failures.push({
        at: nowIso(),
        name: "reconnection.loop",
        status: 0,
        phase: recorder.phase(),
        detail: error instanceof Error ? error.message : String(error),
      });
    });
    const automaticCashPromise = automaticCashCycle(backend.baseUrl, globalState, stopSignal).catch((error) => {
      recorder.failures.push({
        at: nowIso(),
        name: "automatic_cash.loop",
        status: 0,
        phase: recorder.phase(),
        detail: error instanceof Error ? error.message : String(error),
      });
    });

    await runScheduledActions(backend.baseUrl, globalState, stopSignal);
    radioStop.done = true;
    await Promise.allSettled([radioPromise, reconnectPromise, automaticCashPromise]);
    await finalScarichi(backend.baseUrl, globalState, backend.dbPath);
    const drain = await waitForBackendDrains(backend);
    await writeEvent({ event: "drain", result: drain });

    stopSignal.done = true;
    const monitorSamples = await monitorPromise;
    const monitor = summarizeMonitor(monitorSamples);
    const db = await readHydratedBackendState(backend);
    const validation = validateFinalState(db, globalState, monitor);
    const runtimeMetrics = await fetchRuntimeMetrics(backend.baseUrl, globalState.adminSession, "snapshot");
    const report = {
      ok: validation.ok,
      runId,
      options,
      backend: {
        baseUrl: backend.baseUrl,
        dbPath: backend.dbPath,
        port: backend.port,
      },
      recorder: recorder.summary(),
      monitor,
      drain,
      validation,
      runtimeMetrics,
    };
    await fs.writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(reportMdPath, renderMarkdown(report), "utf8");
    await writeEvent({ event: "finished", ok: report.ok, reportJsonPath, reportMdPath, validation });
    console.log(JSON.stringify({
      ok: report.ok,
      reportJsonPath,
      reportMdPath,
      durationSeconds: Math.round(report.recorder.durationMs / 1000),
      actions: report.recorder.actions.reduce((sum, entry) => sum + entry.count, 0),
      http: report.recorder.http.reduce((sum, entry) => sum + entry.count, 0),
      validation: report.validation,
    }, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    stopSignal.done = true;
    if (eventFile) await eventFile.close().catch(() => undefined);
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        // best effort shutdown
      }
    }
  }
}

await main().catch(async (error) => {
  try {
    await writeEvent({ event: "fatal", error: error instanceof Error ? error.stack ?? error.message : String(error) });
  } catch {
    // noop
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
