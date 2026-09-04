#!/usr/bin/env node
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cassaRoot = path.resolve(scriptDir, "..");
const projectRoot = path.resolve(cassaRoot, "..");

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function rel(filePath) {
  return path.relative(projectRoot, filePath).replace(/\\/g, "/");
}

function shellQuote(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function envPrefix(env) {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
}

function buildCommand({ env = {}, command, args = [] }) {
  return `${envPrefix(env)} ${[command, ...args].map(shellQuote).join(" ")}`.trim();
}

function checkFile(filePath, label) {
  return {
    label,
    path: rel(filePath),
    ok: existsSync(filePath),
  };
}

function phasePProfiles(nodeBin = process.execPath) {
  const baseLoadEnv = {
    NODE_BIN: nodeBin,
    POS_FISCAL_API_BASE_URL: "http://127.0.0.1:9290",
    LOADTEST_MULTIPROCESS: "1",
    LOADTEST_API_WORKERS: "2",
    LOADTEST_GUI_HEADLESS: "1",
    LOADTEST_CHROMIUM_EXECUTABLE_PATH: process.env.LOADTEST_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
    LOADTEST_CHROMIUM_NO_SANDBOX: "1",
    LOADTEST_FISCAL_SAMPLE_LIMIT: "5",
    LOADTEST_PRINTING_ENABLED: "1",
    LOADTEST_PRINTER_HOST: "127.0.0.1",
    LOADTEST_PRINTER_PORT: "9109",
    LOADTEST_ALLOW_NON_LOOPBACK_IO: "0",
    APP_STATE_DIRTY_TRACKING: "write",
    APP_STATE_DIRTY_TRACKING_MODE: "write",
    PRINT_SPOOL_FAST_WORKER: "1",
  };
  const loadProfiles = [
    { name: "load-10", handhelds: 10, stations: 10, gui: 1, opsPerDevice: 30 },
    { name: "load-25", handhelds: 25, stations: 10, gui: 2, opsPerDevice: 50 },
    { name: "load-50", handhelds: 50, stations: 10, gui: 3, opsPerDevice: 70 },
    { name: "load-100", handhelds: 100, stations: 10, gui: 5, opsPerDevice: 80 },
  ].map((profile) => ({
    name: profile.name,
    kind: "loadtest-full-capacity",
    expectedDuration: "breve/medio, dipende da host e MySQL",
    command: buildCommand({
      env: {
        ...baseLoadEnv,
        LOADTEST_RUN_ID: `phaseP_${profile.name}`,
        LOADTEST_HANDHELDS: String(profile.handhelds),
        LOADTEST_STATIONS: String(profile.stations),
        LOADTEST_GUI: String(profile.gui),
        LOADTEST_OPS_PER_DEVICE: String(profile.opsPerDevice),
      },
      command: nodeBin,
      args: ["cassa-frontend/scripts/loadtest-full-capacity.mjs"],
    }),
  }));

  const enduranceEnv = {
    ENDURANCE_DURATION_MS: "5400000",
    ENDURANCE_ACTIONS: "50000",
    ENDURANCE_MOBILE_DEVICES: "120",
    ENDURANCE_MOBILE_USERS: "10",
    ENDURANCE_STATIONS: "50",
    ENDURANCE_RADIO_CLIENTS: "100",
    ENDURANCE_MAX_CONCURRENCY: "80",
    ENDURANCE_CRITICAL_HEADROOM: "16",
    ENDURANCE_PRINTING_ENABLED: "1",
    ENDURANCE_MOCK_PRINTER_HOST: "127.0.0.1",
    ENDURANCE_MOCK_PRINTER_PORT: "9109",
    ENDURANCE_FISCAL_BASE_URL: "http://127.0.0.1:9290",
    ENDURANCE_TIMEOUT_MS: "30000",
    ENDURANCE_DRAIN_TIMEOUT_MS: "300000",
  };
  const enduranceProfile = {
    name: "endurance-90m-virtual",
    kind: "endurance-sim-50k",
    expectedDuration: "90 minuti + drain",
    command: buildCommand({
      env: enduranceEnv,
      command: nodeBin,
      args: ["cassa-frontend/scripts/endurance-sim-50k.mjs"],
    }),
  };

  const mockFiscal = {
    name: "mock-fiscal",
    kind: "support",
    command: buildCommand({
      env: { MOCK_FISCAL_HOST: "127.0.0.1", MOCK_FISCAL_PORT: "9290" },
      command: nodeBin,
      args: ["tools/mock-fiscal-server.mjs"],
    }),
  };
  const mockPrinter = {
    name: "mock-printer",
    kind: "support",
    command: buildCommand({
      env: { MOCK_PRINTER_HOST: "127.0.0.1", MOCK_PRINTER_PORT: "9109" },
      command: nodeBin,
      args: ["tools/mock-tcp-printer.mjs"],
    }),
  };
  const pdf = {
    name: "endurance-pdf",
    kind: "report",
    command: buildCommand({
      command: nodeBin,
      args: ["cassa-frontend/scripts/endurance-report-pdf.mjs", "<cartella-log-endurance>"],
    }),
  };

  return {
    support: [mockFiscal, mockPrinter],
    loadProfiles,
    endurance: enduranceProfile,
    report: pdf,
  };
}

function phasePMultiProcessProfiles(nodeBin = process.execPath) {
  const commonEnv = {
    CANARY_FRONTEND_ORIGIN: "https://127.0.0.1:5380",
    CANARY_API_WORKER_ORIGIN: "http://127.0.0.1:5383",
    CANARY_INSECURE_TLS: "1",
  };
  return {
    requiredRuntime: [
      "frontend multiplexer HTTPS su 5380",
      "backend owner su 5381 con BACKEND_PROCESS_ROLE=api-owner",
      "realtime-gateway su 5382 con BACKEND_PROCESS_ROLE=realtime-gateway",
      "api-worker su 5383 con BACKEND_PROCESS_ROLE=api-worker",
      "preset operativo orders/create+sync con BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANARY=1",
      "preset operativo orders/create+sync+cancel con BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_CANARY=1",
      "preset operativo orders/create+sync+cancel+comp con BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CANARY=1",
      "preset operativo orders/create+sync+cancel+comp+correct con BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_CANARY=1",
      "preset operativo orders/create+sync+cancel+comp+correct+barReplacement con BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_CANARY=1",
      "preset operativo orders/create+sync+cancel+comp+correct+barReplacement+lineSplit con BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_CANARY=1",
      "preset operativo orders/create+sync+cancel+comp+correct+barReplacement+lineSplit+transferResolve con BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_CANARY=1",
      "preset operativo orders/create+sync+cancel+comp+correct+barReplacement+lineSplit+transferResolve+transferRequest con BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_CANARY=1",
      "preset operativo orders/create+sync+cancel+comp+correct+barReplacement+lineSplit+transferResolve+transferRequest+priceOverride con BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_CANARY=1",
      "preset operativo orders/create+sync+cancel+comp+correct+barReplacement+lineSplit+transferResolve+transferRequest+priceOverride+transferForce con BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_TRANSFER_FORCE_CANARY=1",
      "preset operativo orders/create+sync+cancel+comp+correct+barReplacement+lineSplit+transferResolve+transferRequest+priceOverride+transferForce+storno con BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_TRANSFER_FORCE_STORNO_CANARY=1",
      "realtime backbone con EVENT_OUTBOX_ENABLED=1 per notifiche cross-process",
      "table-state condiviso con BACKEND_APP_STATE_SPLIT_TABLE_STATES=externalized",
      "notification-record condiviso con BACKEND_MYSQL_SPLIT_APP_STATE_DOMAINS=1",
      "proxy con BACKEND_MULTI_PROCESS_READ_WORKERS=1",
      "proxy con BACKEND_MULTI_PROCESS_READ_STATE_EXTERNALIZED=1",
      "order worker futuri solo con BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST esplicita",
      "canary orders/create+sync+cancel solo dopo BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1 e BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST=\"POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel\"",
      "canary orders/create+sync+cancel+comp solo dopo BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1 e BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST=\"POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel,POST /api/integration/orders/comp\"",
      "canary orders/create+sync+cancel+comp+correct solo dopo BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1 e BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST=\"POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel,POST /api/integration/orders/comp,POST /api/integration/orders/correct\"",
      "canary orders/create+sync+cancel+comp+correct+barReplacement solo dopo BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1 e BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST=\"POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel,POST /api/integration/orders/comp,POST /api/integration/orders/correct,POST /api/integration/orders/replacement/bar-charge,POST /api/orders/replacement/bar-charge\"",
      "canary orders/create+sync+cancel+comp+correct+barReplacement+lineSplit solo dopo BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1 e BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST=\"POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel,POST /api/integration/orders/comp,POST /api/integration/orders/correct,POST /api/integration/orders/replacement/bar-charge,POST /api/orders/replacement/bar-charge,POST /api/integration/orders/line/split\"",
      "canary finale order-worker 13 route solo dopo BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=1 e BACKEND_MULTI_PROCESS_ORDER_WORKER_ROUTE_ALLOWLIST=\"POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel,POST /api/integration/orders/comp,POST /api/integration/orders/correct,POST /api/integration/orders/replacement/bar-charge,POST /api/orders/replacement/bar-charge,POST /api/integration/orders/line/split,POST /api/integration/orders/transfer/resolve,POST /api/integration/orders/transfer/request,POST /api/integration/orders/line/price-override,POST /api/integration/orders/transfer/force,POST /api/integration/orders/storno\"",
      "canary e2e orders/create+sync+cancel solo dopo restart con PRINTING_ENABLED=0 o stampanti virtuali confermate",
      "wildcard order worker * solo con BACKEND_MULTI_PROCESS_ORDER_WORKER_ALLOW_WILDCARD=1",
    ],
    canaries: [
      {
        name: "api-worker-reads-30s",
        kind: "multiprocess-read-routing",
        command: buildCommand({
          env: {
            ...commonEnv,
            CANARY_READ_DURATION_MS: "30000",
            CANARY_READ_CONCURRENCY: "12",
            CANARY_READ_DELAY_MS: "250",
            CANARY_READ_MAX_PROBES: "5000",
            CANARY_TIMEOUT_MS: "20000",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/api-worker-read-canary.mjs"],
        }),
      },
      {
        name: "realtime-gateway-8x8",
        kind: "multiprocess-realtime-routing",
        command: buildCommand({
          env: {
            ...commonEnv,
            CANARY_STREAMS: "8",
            CANARY_EVENTS: "8",
            CANARY_EVENT_INTERVAL_MS: "500",
            CANARY_TIMEOUT_MS: "20000",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/realtime-gateway-canary.mjs"],
        }),
      },
      {
        name: "mixed-30s",
        kind: "multiprocess-mixed-routing",
        command: buildCommand({
          env: {
            ...commonEnv,
            CANARY_READ_DURATION_MS: "30000",
            CANARY_READ_CONCURRENCY: "8",
            CANARY_READ_DELAY_MS: "250",
            CANARY_EVENTS: "10",
            CANARY_STREAMS: "4",
            CANARY_EVENT_INTERVAL_MS: "500",
            CANARY_TIMEOUT_MS: "20000",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/multiprocess-mixed-canary.mjs"],
        }),
      },
      {
        name: "order-worker-fuse",
        kind: "multiprocess-order-fuse",
        command: buildCommand({
          env: {
            ...commonEnv,
            CANARY_TIMEOUT_MS: "10000",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-fuse-canary.mjs"],
        }),
      },
      {
        name: "order-worker-create-allowlist",
        kind: "multiprocess-order-route-allowlist",
        command: buildCommand({
          env: {
            ...commonEnv,
            CANARY_TIMEOUT_MS: "10000",
            CANARY_ORDER_WORKER_ROUTE_KEY: "POST /api/integration/orders/create",
            CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY: "POST /api/integration/orders/correct/resolve",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-route-canary.mjs"],
        }),
      },
      {
        name: "order-worker-sync-allowlist",
        kind: "multiprocess-order-route-allowlist",
        command: buildCommand({
          env: {
            ...commonEnv,
            CANARY_TIMEOUT_MS: "10000",
            CANARY_ORDER_WORKER_ROUTE_KEY: "POST /api/integration/orders/sync",
            CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY: "POST /api/integration/orders/correct/resolve",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-route-canary.mjs"],
        }),
      },
      {
        name: "order-worker-cancel-allowlist",
        kind: "multiprocess-order-route-allowlist",
        command: buildCommand({
          env: {
            ...commonEnv,
            CANARY_TIMEOUT_MS: "10000",
            CANARY_ORDER_WORKER_ROUTE_KEY: "POST /api/integration/orders/cancel",
            CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY: "POST /api/integration/orders/correct/resolve",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-route-canary.mjs"],
        }),
      },
      {
        name: "order-worker-comp-allowlist",
        kind: "multiprocess-order-route-allowlist",
        command: buildCommand({
          env: {
            ...commonEnv,
            CANARY_TIMEOUT_MS: "10000",
            CANARY_ORDER_WORKER_ROUTE_KEY: "POST /api/integration/orders/comp",
            CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY: "POST /api/integration/orders/correct/resolve",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-route-canary.mjs"],
        }),
      },
      {
        name: "order-worker-correct-allowlist",
        kind: "multiprocess-order-route-allowlist",
        command: buildCommand({
          env: {
            ...commonEnv,
            CANARY_TIMEOUT_MS: "10000",
            CANARY_ORDER_WORKER_ROUTE_KEY: "POST /api/integration/orders/correct",
            CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY: "POST /api/integration/orders/correct/resolve",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-route-canary.mjs"],
        }),
      },
      {
        name: "order-worker-bar-replacement-allowlist",
        kind: "multiprocess-order-route-allowlist",
        command: buildCommand({
          env: {
            ...commonEnv,
            CANARY_TIMEOUT_MS: "10000",
            CANARY_ORDER_WORKER_ROUTE_KEY: "POST /api/integration/orders/replacement/bar-charge",
            CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY: "POST /api/integration/orders/correct/resolve",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-route-canary.mjs"],
        }),
      },
      {
        name: "order-worker-bar-replacement-legacy-allowlist",
        kind: "multiprocess-order-route-allowlist",
        command: buildCommand({
          env: {
            ...commonEnv,
            CANARY_TIMEOUT_MS: "10000",
            CANARY_ORDER_WORKER_ROUTE_KEY: "POST /api/orders/replacement/bar-charge",
            CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY: "POST /api/integration/orders/correct/resolve",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-route-canary.mjs"],
        }),
      },
      {
        name: "order-worker-line-split-allowlist",
        kind: "multiprocess-order-route-allowlist",
        command: buildCommand({
          env: {
            ...commonEnv,
            CANARY_TIMEOUT_MS: "10000",
            CANARY_ORDER_WORKER_ROUTE_KEY: "POST /api/integration/orders/line/split",
            CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY: "POST /api/integration/orders/correct/resolve",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-route-canary.mjs"],
        }),
      },
      {
        name: "order-worker-transfer-resolve-allowlist",
        kind: "multiprocess-order-route-allowlist",
        command: buildCommand({
          env: {
            ...commonEnv,
            CANARY_TIMEOUT_MS: "10000",
            CANARY_ORDER_WORKER_ROUTE_KEY: "POST /api/integration/orders/transfer/resolve",
            CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY: "POST /api/integration/orders/transfer/force",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-route-canary.mjs"],
        }),
      },
      {
        name: "order-worker-create-sync-e2e",
        kind: "multiprocess-order-sync-e2e",
        command: buildCommand({
          env: {
            ...commonEnv,
            PRINTING_ENABLED: "0",
            CANARY_REQUIRE_PRINTING_DISABLED: "1",
            CANARY_SKIP_CLEANUP: "1",
            CANARY_REQUIRE_CLEANUP: "0",
            CANARY_EXPECT_CREATE_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_SYNC_PROXY_ROLE: "api-worker",
            CANARY_USERNAME: "lorenzo",
            CANARY_PIN: "1234",
            CANARY_TIMEOUT_MS: "15000",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-sync-e2e-canary.mjs"],
        }),
      },
      {
        name: "order-worker-create-sync-cancel-e2e",
        kind: "multiprocess-order-sync-e2e",
        command: buildCommand({
          env: {
            ...commonEnv,
            PRINTING_ENABLED: "0",
            CANARY_REQUIRE_PRINTING_DISABLED: "1",
            CANARY_REQUIRE_CLEANUP: "1",
            CANARY_EXPECT_CREATE_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_SYNC_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_CLEANUP_PROXY_ROLE: "api-worker",
            CANARY_USERNAME: "lorenzo",
            CANARY_PIN: "1234",
            CANARY_TIMEOUT_MS: "15000",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-sync-e2e-canary.mjs"],
        }),
      },
      {
        name: "order-worker-create-correct-sync-comp-e2e",
        kind: "multiprocess-order-correct-sync-comp-e2e",
        command: buildCommand({
          env: {
            ...commonEnv,
            PRINTING_ENABLED: "0",
            CANARY_REQUIRE_PRINTING_DISABLED: "1",
            CANARY_REQUIRE_CORRECT: "1",
            CANARY_SYNC_WORKFLOW_STATUS: "ready",
            CANARY_REQUIRE_COMP: "1",
            CANARY_SKIP_CLEANUP: "1",
            CANARY_REQUIRE_CLEANUP: "0",
            CANARY_EXPECT_CREATE_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_CORRECT_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_SYNC_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_COMP_PROXY_ROLE: "api-worker",
            CANARY_USERNAME: "lorenzo",
            CANARY_PIN: "1234",
            CANARY_TIMEOUT_MS: "15000",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-sync-e2e-canary.mjs"],
        }),
      },
      {
        name: "order-worker-create-bar-replacement-correct-sync-comp-e2e",
        kind: "multiprocess-order-bar-replacement-correct-sync-comp-e2e",
        command: buildCommand({
          env: {
            ...commonEnv,
            PRINTING_ENABLED: "0",
            CANARY_REQUIRE_PRINTING_DISABLED: "1",
            CANARY_REQUIRE_BAR_REPLACEMENT: "1",
            CANARY_REQUIRE_CORRECT: "1",
            CANARY_SYNC_WORKFLOW_STATUS: "ready",
            CANARY_REQUIRE_COMP: "1",
            CANARY_SKIP_CLEANUP: "1",
            CANARY_REQUIRE_CLEANUP: "0",
            CANARY_EXPECT_CREATE_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_BAR_REPLACEMENT_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_CORRECT_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_SYNC_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_COMP_PROXY_ROLE: "api-worker",
            CANARY_USERNAME: "lorenzo",
            CANARY_PIN: "1234",
            CANARY_TIMEOUT_MS: "15000",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-sync-e2e-canary.mjs"],
        }),
      },
      {
        name: "order-worker-create-line-split-sync-e2e",
        kind: "multiprocess-order-line-split-sync-e2e",
        command: buildCommand({
          env: {
            ...commonEnv,
            PRINTING_ENABLED: "0",
            CANARY_REQUIRE_PRINTING_DISABLED: "1",
            CANARY_REQUIRE_LINE_SPLIT: "1",
            CANARY_SYNC_WORKFLOW_STATUS: "ready",
            CANARY_SKIP_CLEANUP: "1",
            CANARY_REQUIRE_CLEANUP: "0",
            CANARY_EXPECT_CREATE_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_LINE_SPLIT_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_SYNC_PROXY_ROLE: "api-worker",
            CANARY_USERNAME: "lorenzo",
            CANARY_PIN: "1234",
            CANARY_TIMEOUT_MS: "15000",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-sync-e2e-canary.mjs"],
        }),
      },
      {
        name: "order-worker-create-transfer-resolve-sync-e2e",
        kind: "multiprocess-order-transfer-resolve-sync-e2e",
        command: buildCommand({
          env: {
            ...commonEnv,
            PRINTING_ENABLED: "0",
            CANARY_REQUIRE_PRINTING_DISABLED: "1",
            CANARY_REQUIRE_TRANSFER_RESOLVE: "1",
            CANARY_SYNC_WORKFLOW_STATUS: "ready",
            CANARY_SKIP_CLEANUP: "1",
            CANARY_REQUIRE_CLEANUP: "0",
            CANARY_EXPECT_CREATE_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_TRANSFER_REQUEST_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_TRANSFER_RESOLVE_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_SYNC_PROXY_ROLE: "api-worker",
            CANARY_USERNAME: "lorenzo",
            CANARY_PIN: "1234",
            CANARY_TIMEOUT_MS: "15000",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-sync-e2e-canary.mjs"],
        }),
      },
      {
        name: "order-worker-transfer-request-allowlist",
        kind: "multiprocess-order-route-allowlist",
        command: buildCommand({
          env: {
            ...commonEnv,
            CANARY_TIMEOUT_MS: "10000",
            CANARY_ORDER_WORKER_ROUTE_KEY: "POST /api/integration/orders/transfer/request",
            CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY: "POST /api/integration/orders/transfer/force",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-route-canary.mjs"],
        }),
      },
      {
        name: "order-worker-price-override-allowlist",
        kind: "multiprocess-order-route-allowlist",
        command: buildCommand({
          env: {
            ...commonEnv,
            CANARY_TIMEOUT_MS: "10000",
            CANARY_ORDER_WORKER_ROUTE_KEY: "POST /api/integration/orders/line/price-override",
            CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY: "POST /api/integration/orders/transfer/force",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-route-canary.mjs"],
        }),
      },
      {
        name: "order-worker-transfer-force-allowlist",
        kind: "multiprocess-order-route-allowlist",
        command: buildCommand({
          env: {
            ...commonEnv,
            CANARY_TIMEOUT_MS: "10000",
            CANARY_ORDER_WORKER_ROUTE_KEY: "POST /api/integration/orders/transfer/force",
            CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY: "POST /api/integration/orders/storno",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-route-canary.mjs"],
        }),
      },
      {
        name: "order-worker-storno-allowlist",
        kind: "multiprocess-order-route-allowlist",
        command: buildCommand({
          env: {
            ...commonEnv,
            CANARY_TIMEOUT_MS: "10000",
            CANARY_ORDER_WORKER_ROUTE_KEY: "POST /api/integration/orders/storno",
            CANARY_ORDER_WORKER_CONTROL_ROUTE_KEY: "POST /api/payments/table",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-route-canary.mjs"],
        }),
      },
      {
        name: "order-worker-create-price-override-sync-e2e",
        kind: "multiprocess-order-price-override-sync-e2e",
        command: buildCommand({
          env: {
            ...commonEnv,
            PRINTING_ENABLED: "0",
            CANARY_REQUIRE_PRINTING_DISABLED: "1",
            CANARY_REQUIRE_PRICE_OVERRIDE: "1",
            CANARY_SYNC_WORKFLOW_STATUS: "ready",
            CANARY_SKIP_CLEANUP: "1",
            CANARY_REQUIRE_CLEANUP: "0",
            CANARY_EXPECT_CREATE_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_PRICE_OVERRIDE_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_SYNC_PROXY_ROLE: "api-worker",
            CANARY_USERNAME: "lorenzo",
            CANARY_PIN: "1234",
            CANARY_TIMEOUT_MS: "15000",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-sync-e2e-canary.mjs"],
        }),
      },
      {
        name: "order-worker-create-transfer-force-sync-e2e",
        kind: "multiprocess-order-transfer-force-sync-e2e",
        command: buildCommand({
          env: {
            ...commonEnv,
            PRINTING_ENABLED: "0",
            CANARY_REQUIRE_PRINTING_DISABLED: "1",
            CANARY_REQUIRE_LINE_SPLIT: "1",
            CANARY_REQUIRE_PRICE_OVERRIDE: "1",
            CANARY_REQUIRE_TRANSFER_RESOLVE: "1",
            CANARY_REQUIRE_TRANSFER_FORCE: "1",
            CANARY_SYNC_WORKFLOW_STATUS: "ready",
            CANARY_SKIP_CLEANUP: "1",
            CANARY_REQUIRE_CLEANUP: "0",
            CANARY_EXPECT_CREATE_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_LINE_SPLIT_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_PRICE_OVERRIDE_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_TRANSFER_REQUEST_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_TRANSFER_RESOLVE_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_TRANSFER_FORCE_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_SYNC_PROXY_ROLE: "api-worker",
            CANARY_USERNAME: "lorenzo",
            CANARY_PIN: "1234",
            CANARY_TIMEOUT_MS: "15000",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-sync-e2e-canary.mjs"],
        }),
      },
      {
        name: "order-worker-create-transfer-force-storno-sync-e2e",
        kind: "multiprocess-order-transfer-force-storno-sync-e2e",
        command: buildCommand({
          env: {
            ...commonEnv,
            PRINTING_ENABLED: "0",
            CANARY_REQUIRE_PRINTING_DISABLED: "1",
            CANARY_REQUIRE_LINE_SPLIT: "1",
            CANARY_REQUIRE_PRICE_OVERRIDE: "1",
            CANARY_REQUIRE_TRANSFER_RESOLVE: "1",
            CANARY_REQUIRE_TRANSFER_FORCE: "1",
            CANARY_REQUIRE_STORNO: "1",
            CANARY_SYNC_WORKFLOW_STATUS: "delivered",
            CANARY_SKIP_CLEANUP: "1",
            CANARY_REQUIRE_CLEANUP: "0",
            CANARY_EXPECT_CREATE_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_LINE_SPLIT_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_PRICE_OVERRIDE_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_TRANSFER_REQUEST_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_TRANSFER_RESOLVE_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_TRANSFER_FORCE_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_STORNO_PROXY_ROLE: "api-worker",
            CANARY_EXPECT_SYNC_PROXY_ROLE: "api-worker",
            CANARY_USERNAME: "lorenzo",
            CANARY_PIN: "1234",
            CANARY_TIMEOUT_MS: "20000",
          },
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-worker-sync-e2e-canary.mjs"],
        }),
      },
    ],
    restartPresets: [
      {
        name: "order-create-sync-worker-canary-dry-run",
        kind: "multiprocess-order-route-restart-dry-run",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANARY: "1",
            BACKEND_RESTART_DRY_RUN: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-worker-canary-restart",
        kind: "multiprocess-order-route-restart",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANARY: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-worker-canary-dry-run",
        kind: "multiprocess-order-route-restart-dry-run",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_CANARY: "1",
            BACKEND_RESTART_DRY_RUN: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-worker-canary-restart",
        kind: "multiprocess-order-route-restart",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_CANARY: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-comp-worker-canary-dry-run",
        kind: "multiprocess-order-route-restart-dry-run",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CANARY: "1",
            BACKEND_RESTART_DRY_RUN: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-comp-worker-canary-restart",
        kind: "multiprocess-order-route-restart",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CANARY: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-comp-correct-worker-canary-dry-run",
        kind: "multiprocess-order-route-restart-dry-run",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_CANARY: "1",
            BACKEND_RESTART_DRY_RUN: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-comp-correct-worker-canary-restart",
        kind: "multiprocess-order-route-restart",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_CANARY: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-comp-correct-bar-replacement-worker-canary-dry-run",
        kind: "multiprocess-order-route-restart-dry-run",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_CANARY: "1",
            BACKEND_RESTART_DRY_RUN: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-comp-correct-bar-replacement-worker-canary-restart",
        kind: "multiprocess-order-route-restart",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_CANARY: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-comp-correct-bar-replacement-line-split-worker-canary-dry-run",
        kind: "multiprocess-order-route-restart-dry-run",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_CANARY: "1",
            BACKEND_RESTART_DRY_RUN: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-comp-correct-bar-replacement-line-split-worker-canary-restart",
        kind: "multiprocess-order-route-restart",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_CANARY: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-worker-canary-dry-run",
        kind: "multiprocess-order-route-restart-dry-run",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_CANARY: "1",
            BACKEND_RESTART_DRY_RUN: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-worker-canary-restart",
        kind: "multiprocess-order-route-restart",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_CANARY: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-worker-canary-dry-run",
        kind: "multiprocess-order-route-restart-dry-run",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_CANARY: "1",
            BACKEND_RESTART_DRY_RUN: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-worker-canary-restart",
        kind: "multiprocess-order-route-restart",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_CANARY: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-price-override-worker-canary-dry-run",
        kind: "multiprocess-order-route-restart-dry-run",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_CANARY: "1",
            BACKEND_RESTART_DRY_RUN: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-price-override-worker-canary-restart",
        kind: "multiprocess-order-route-restart",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_CANARY: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-price-override-transfer-force-worker-canary-dry-run",
        kind: "multiprocess-order-route-restart-dry-run",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_TRANSFER_FORCE_CANARY: "1",
            BACKEND_RESTART_DRY_RUN: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-price-override-transfer-force-worker-canary-restart",
        kind: "multiprocess-order-route-restart",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_TRANSFER_FORCE_CANARY: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-price-override-transfer-force-storno-worker-canary-dry-run",
        kind: "multiprocess-order-route-restart-dry-run",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_TRANSFER_FORCE_STORNO_CANARY: "1",
            BACKEND_RESTART_DRY_RUN: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
      {
        name: "order-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-price-override-transfer-force-storno-worker-canary-restart",
        kind: "multiprocess-order-route-restart",
        command: buildCommand({
          env: {
            BACKEND_MULTI_PROCESS_ORDER_CREATE_SYNC_CANCEL_COMP_CORRECT_BAR_REPLACEMENT_LINE_SPLIT_TRANSFER_RESOLVE_TRANSFER_REQUEST_PRICE_OVERRIDE_TRANSFER_FORCE_STORNO_CANARY: "1",
          },
          command: "tools/restart-v5bt-linux.sh",
        }),
      },
    ],
    audits: [
      {
        name: "order-workflow-externalization",
        kind: "multiprocess-order-readiness",
        command: buildCommand({
          command: nodeBin,
          args: ["cassa-frontend/scripts/order-workflow-externalization-audit.mjs"],
        }),
      },
      {
        name: "order-worker-create-sync-allowlist-audit",
        kind: "multiprocess-order-allowlist-readiness",
        command: buildCommand({
          command: nodeBin,
          args: [
            "cassa-frontend/scripts/order-workflow-externalization-audit.mjs",
            "--route-allowlist",
            "POST /api/integration/orders/create,POST /api/integration/orders/sync",
          ],
        }),
      },
      {
        name: "order-worker-create-sync-cancel-allowlist-audit",
        kind: "multiprocess-order-allowlist-readiness",
        command: buildCommand({
          command: nodeBin,
          args: [
            "cassa-frontend/scripts/order-workflow-externalization-audit.mjs",
            "--route-allowlist",
            "POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel",
          ],
        }),
      },
      {
        name: "order-worker-create-sync-cancel-comp-allowlist-audit",
        kind: "multiprocess-order-allowlist-readiness",
        command: buildCommand({
          command: nodeBin,
          args: [
            "cassa-frontend/scripts/order-workflow-externalization-audit.mjs",
            "--route-allowlist",
            "POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel,POST /api/integration/orders/comp",
          ],
        }),
      },
      {
        name: "order-worker-create-sync-cancel-comp-correct-allowlist-audit",
        kind: "multiprocess-order-allowlist-readiness",
        command: buildCommand({
          command: nodeBin,
          args: [
            "cassa-frontend/scripts/order-workflow-externalization-audit.mjs",
            "--route-allowlist",
            "POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel,POST /api/integration/orders/comp,POST /api/integration/orders/correct",
          ],
        }),
      },
      {
        name: "order-worker-create-sync-cancel-comp-correct-bar-replacement-allowlist-audit",
        kind: "multiprocess-order-allowlist-readiness",
        command: buildCommand({
          command: nodeBin,
          args: [
            "cassa-frontend/scripts/order-workflow-externalization-audit.mjs",
            "--route-allowlist",
            "POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel,POST /api/integration/orders/comp,POST /api/integration/orders/correct,POST /api/integration/orders/replacement/bar-charge,POST /api/orders/replacement/bar-charge",
          ],
        }),
      },
      {
        name: "order-worker-create-sync-cancel-comp-correct-bar-replacement-line-split-allowlist-audit",
        kind: "multiprocess-order-allowlist-readiness",
        command: buildCommand({
          command: nodeBin,
          args: [
            "cassa-frontend/scripts/order-workflow-externalization-audit.mjs",
            "--route-allowlist",
            "POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel,POST /api/integration/orders/comp,POST /api/integration/orders/correct,POST /api/integration/orders/replacement/bar-charge,POST /api/orders/replacement/bar-charge,POST /api/integration/orders/line/split",
          ],
        }),
      },
      {
        name: "order-worker-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-allowlist-audit",
        kind: "multiprocess-order-allowlist-readiness",
        command: buildCommand({
          command: nodeBin,
          args: [
            "cassa-frontend/scripts/order-workflow-externalization-audit.mjs",
            "--route-allowlist",
            "POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel,POST /api/integration/orders/comp,POST /api/integration/orders/correct,POST /api/integration/orders/replacement/bar-charge,POST /api/orders/replacement/bar-charge,POST /api/integration/orders/line/split,POST /api/integration/orders/transfer/resolve",
          ],
        }),
      },
      {
        name: "order-worker-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-allowlist-audit",
        kind: "multiprocess-order-allowlist-readiness",
        command: buildCommand({
          command: nodeBin,
          args: [
            "cassa-frontend/scripts/order-workflow-externalization-audit.mjs",
            "--route-allowlist",
            "POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel,POST /api/integration/orders/comp,POST /api/integration/orders/correct,POST /api/integration/orders/replacement/bar-charge,POST /api/orders/replacement/bar-charge,POST /api/integration/orders/line/split,POST /api/integration/orders/transfer/resolve,POST /api/integration/orders/transfer/request",
          ],
        }),
      },
      {
        name: "order-worker-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-price-override-allowlist-audit",
        kind: "multiprocess-order-allowlist-readiness",
        command: buildCommand({
          command: nodeBin,
          args: [
            "cassa-frontend/scripts/order-workflow-externalization-audit.mjs",
            "--route-allowlist",
            "POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel,POST /api/integration/orders/comp,POST /api/integration/orders/correct,POST /api/integration/orders/replacement/bar-charge,POST /api/orders/replacement/bar-charge,POST /api/integration/orders/line/split,POST /api/integration/orders/transfer/resolve,POST /api/integration/orders/transfer/request,POST /api/integration/orders/line/price-override",
          ],
        }),
      },
      {
        name: "order-worker-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-price-override-transfer-force-allowlist-audit",
        kind: "multiprocess-order-allowlist-readiness",
        command: buildCommand({
          command: nodeBin,
          args: [
            "cassa-frontend/scripts/order-workflow-externalization-audit.mjs",
            "--route-allowlist",
            "POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel,POST /api/integration/orders/comp,POST /api/integration/orders/correct,POST /api/integration/orders/replacement/bar-charge,POST /api/orders/replacement/bar-charge,POST /api/integration/orders/line/split,POST /api/integration/orders/transfer/resolve,POST /api/integration/orders/transfer/request,POST /api/integration/orders/line/price-override,POST /api/integration/orders/transfer/force",
          ],
        }),
      },
      {
        name: "order-worker-create-sync-cancel-comp-correct-bar-replacement-line-split-transfer-resolve-transfer-request-price-override-transfer-force-storno-allowlist-audit",
        kind: "multiprocess-order-allowlist-readiness",
        command: buildCommand({
          command: nodeBin,
          args: [
            "cassa-frontend/scripts/order-workflow-externalization-audit.mjs",
            "--route-allowlist",
            "POST /api/integration/orders/create,POST /api/integration/orders/sync,POST /api/integration/orders/cancel,POST /api/integration/orders/comp,POST /api/integration/orders/correct,POST /api/integration/orders/replacement/bar-charge,POST /api/orders/replacement/bar-charge,POST /api/integration/orders/line/split,POST /api/integration/orders/transfer/resolve,POST /api/integration/orders/transfer/request,POST /api/integration/orders/line/price-override,POST /api/integration/orders/transfer/force,POST /api/integration/orders/storno",
          ],
        }),
      },
    ],
  };
}

export function buildPhasePValidationPlan({ now = new Date(), nodeBin = process.execPath } = {}) {
  const requiredFiles = [
    checkFile(path.join(cassaRoot, "scripts", "loadtest-full-capacity.mjs"), "full capacity loadtest"),
    checkFile(path.join(cassaRoot, "scripts", "run-p4-load100-raspberry.sh"), "Raspberry load-100 guarded runner"),
    checkFile(path.join(cassaRoot, "scripts", "endurance-sim-50k.mjs"), "90m endurance simulator"),
    checkFile(path.join(cassaRoot, "scripts", "endurance-report-pdf.mjs"), "PDF report generator"),
    checkFile(path.join(cassaRoot, "scripts", "api-worker-read-canary.mjs"), "multi-process api-worker read canary"),
    checkFile(path.join(cassaRoot, "scripts", "realtime-gateway-canary.mjs"), "multi-process realtime gateway canary"),
    checkFile(path.join(cassaRoot, "scripts", "multiprocess-mixed-canary.mjs"), "multi-process mixed canary"),
    checkFile(path.join(cassaRoot, "scripts", "order-worker-fuse-canary.mjs"), "multi-process order worker fuse canary"),
    checkFile(path.join(cassaRoot, "scripts", "order-worker-route-canary.mjs"), "multi-process order worker route allowlist canary"),
    checkFile(path.join(cassaRoot, "scripts", "order-worker-sync-e2e-canary.mjs"), "multi-process order sync e2e canary"),
    checkFile(path.join(cassaRoot, "scripts", "order-workflow-externalization-audit.mjs"), "multi-process order workflow externalization audit"),
    checkFile(path.join(projectRoot, "tools", "restart-v5bt-linux.sh"), "multi-process restart preset script"),
    checkFile(path.join(projectRoot, "tools", "mock-fiscal-server.mjs"), "virtual fiscal gateway"),
    checkFile(path.join(projectRoot, "tools", "mock-tcp-printer.mjs"), "virtual TCP printer"),
    checkFile(path.join(cassaRoot, "backend", "tests", "helpers", "concurrency-harness.mjs"), "real concurrency harness"),
    checkFile(path.join(cassaRoot, "backend", "tests", "fiscal-optimism-boundary.e2e.test.mjs"), "fiscal optimism boundary test"),
    checkFile(path.join(cassaRoot, "backend", "tests", "relational-payments-table-write-primary.test.mjs"), "table payment write-primary test"),
    checkFile(path.join(cassaRoot, "backend", "tests", "relational-payments-ticket-write-primary.test.mjs"), "ticket payment write-primary test"),
    checkFile(path.join(cassaRoot, "backend", "tests", "relational-payments-free-split-write-primary.test.mjs"), "free split write-primary test"),
  ];
  const profile = phasePProfiles(nodeBin);
  const multiProcess = phasePMultiProcessProfiles(nodeBin);
  const missing = requiredFiles.filter((entry) => !entry.ok);
  const warnings = [];
  if (!existsSync(nodeBin)) {
    warnings.push(`Node binario non trovato: ${nodeBin}`);
  }
  warnings.push(
    "I profili P usano gateway fiscale e stampante virtuali. Abilitare hardware reale solo con override esplicito.",
  );
  warnings.push(
    "Il full gate backend completo e l'endurance 90 minuti vanno eseguiti in una finestra operativa dedicata.",
  );

  return {
    ok: missing.length === 0 && existsSync(nodeBin),
    generatedAt: now.toISOString(),
    nodeBin,
    root: rel(projectRoot),
    phase: "P",
    requiredFiles,
    missing,
    warnings,
    acceptanceSequence: [
      "1. Avviare mock fiscal e mock printer.",
      "2. Eseguire smoke load-10.",
      "3. Scalare load-25, load-50, load-100 con 10 postazioni e 5 GUI al livello finale.",
      "4. Eseguire endurance-90m-virtual con 50.000 azioni, 120 device, 50 postazioni e 100 client radio.",
      "5. Generare PDF dal report endurance.",
      "6. Eseguire full gate backend e test GUI/Android reali prima del go/no-go.",
    ],
    thresholds: {
      waiterOrReadyNotificationP95Ms: 500,
      radioBusyFeedbackMs: 150,
      batteryEventP95Ms: 500,
      orderCreateP95Ms: 300,
      paymentTableP95Ms: 200,
      fiscalDuplicateReceipts: 0,
      paymentDuplicates: 0,
      pendingPrintJobsAtDrain: 0,
      pendingFiscalReceiptsAtDrain: 0,
      enduranceDurationMs: 5_400_000,
      enduranceActions: 50_000,
      multiProcessReadP95Ms: 200,
      multiProcessFirstDeliveryP95Ms: 500,
      multiProcessAllStreamsDeliveryP95Ms: 750,
      multiProcessOutboxUnpublished: 0,
      multiProcessDirectWorkerMutationBlocked: true,
    },
    profiles: profile,
    multiProcess,
  };
}

function renderMarkdown(plan) {
  const rows = plan.requiredFiles
    .map((entry) => `| ${entry.ok ? "OK" : "FAIL"} | ${entry.label} | \`${entry.path}\` |`)
    .join("\n");
  const loadCommands = plan.profiles.loadProfiles
    .map((profile) => `### ${profile.name}\n\n\`\`\`bash\n${profile.command}\n\`\`\``)
    .join("\n\n");
  return `# Fase P validation preflight

Generato: ${plan.generatedAt}

Esito: ${plan.ok ? "OK" : "FAIL"}

## Checklist file

| Esito | Voce | Path |
|---|---|---|
${rows}

## Sequenza accettazione

${plan.acceptanceSequence.map((entry) => `- ${entry}`).join("\n")}

## Simulatori da avviare

\`\`\`bash
${plan.profiles.support.map((entry) => entry.command).join("\n")}
\`\`\`

## Profili load progressivi

${loadCommands}

## Multi-process canary

Runtime richiesto:

${plan.multiProcess.requiredRuntime.map((entry) => `- ${entry}`).join("\n")}

Preset restart:

${plan.multiProcess.restartPresets.map((profile) => `### ${profile.name}\n\n\`\`\`bash\n${profile.command}\n\`\`\``).join("\n\n")}

Comandi:

${plan.multiProcess.canaries.map((profile) => `### ${profile.name}\n\n\`\`\`bash\n${profile.command}\n\`\`\``).join("\n\n")}

Audit MP-3:

${plan.multiProcess.audits.map((profile) => `### ${profile.name}\n\n\`\`\`bash\n${profile.command}\n\`\`\``).join("\n\n")}

## Endurance 90 minuti virtuale

\`\`\`bash
${plan.profiles.endurance.command}
\`\`\`

## Report PDF

\`\`\`bash
${plan.profiles.report.command}
\`\`\`

## Soglie principali

${Object.entries(plan.thresholds).map(([key, value]) => `- ${key}: ${value}`).join("\n")}

## Warning

${plan.warnings.map((entry) => `- ${entry}`).join("\n")}
`;
}

export async function writePhasePValidationPreflight({ outputDir = "", now = new Date(), nodeBin = process.execPath } = {}) {
  const plan = buildPhasePValidationPlan({ now, nodeBin });
  const targetDir =
    outputDir ||
    path.join(cassaRoot, "logs", `phase-p-preflight-${timestampId(now)}`);
  await fs.mkdir(targetDir, { recursive: true });
  const reportJsonPath = path.join(targetDir, "report.json");
  const reportMdPath = path.join(targetDir, "REPORT.md");
  await fs.writeFile(reportJsonPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await fs.writeFile(reportMdPath, renderMarkdown(plan), "utf8");
  return { ...plan, reportJsonPath, reportMdPath };
}

async function main() {
  const outputArgIndex = process.argv.findIndex((arg) => arg === "--output-dir");
  const outputDir =
    outputArgIndex >= 0 ? String(process.argv[outputArgIndex + 1] ?? "").trim() : "";
  const jsonOnly = process.argv.includes("--json-only");
  const result = await writePhasePValidationPreflight({ outputDir });
  const payload = {
    ok: result.ok,
    reportJsonPath: result.reportJsonPath,
    reportMdPath: result.reportMdPath,
    missing: result.missing,
    warnings: result.warnings,
  };
  console.log(JSON.stringify(payload, null, 2));
  if (!jsonOnly && result.reportMdPath) {
    console.log(`REPORT=${result.reportMdPath}`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
