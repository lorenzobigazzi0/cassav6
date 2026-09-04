import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildRouteRegistry } from "../routes/index.js";
import { createAutomaticCashHandlers } from "../modules/automatic-cash/automatic-cash.handlers.js";
import { createAutomaticCashGatewayClient } from "../modules/automatic-cash/automatic-cash.gateway.js";
import {
  buildAutomaticCashPreflight,
  CASH_EXCHANGE_DENOMINATION_CENTS,
  createAutomaticCashReserveConfigSet,
  getActiveCashExchange,
  resolveAutomaticCashSettlementFeedback,
  sanitizeAutomaticCashSettings,
  selectAutomaticCashCombination,
  sumCashExchangePieces,
  transitionCashExchange,
  validateCashExchangePieces,
  validateAutomaticCashConfigFile,
  validateAutomaticCashReserveConfigFile,
} from "../modules/automatic-cash/automatic-cash.domain.js";
import {
  buildCashWithdrawalAvailability,
  extractCashMovementPiecesFromGateway,
  getActiveCashMovement,
  selectCashWithdrawalPieces,
  transitionCashMovement,
  validateCashWithdrawalPieces,
} from "../modules/automatic-cash/cash-movement.domain.js";
import { buildCashMovementReportText } from "../modules/automatic-cash/cash-movement-report.js";

class TestHttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.status = status;
    this.statusCode = status;
    this.code = options.code;
    this.details = options.details;
  }
}

const exampleUrl = new URL(
  "./fixtures/fondo_cassa_15_combinazioni_casuali.example.json",
  import.meta.url,
);
const v5btTenEuroTestUrl = new URL(
  "../fixtures/fondo_cassa_test_10_euro.json",
  import.meta.url,
);

async function readExampleConfig() {
  return JSON.parse(await readFile(exampleUrl, "utf8"));
}

test("preset V5BT usa una sola banconota da 10 euro", async () => {
  const config = JSON.parse(await readFile(v5btTenEuroTestUrl, "utf8"));
  const result = validateAutomaticCashConfigFile(config);

  assert.equal(result.ok, true);
  assert.equal(result.summary?.combinationsCount, 1);
  assert.equal(result.summary?.minTotalCents, 1000);
  assert.equal(result.summary?.maxTotalCents, 1000);
  assert.deepEqual(config.combinazioni[0]?.tagli, { "10_euro": 1 });
  assert.equal(config.combinazioni[0]?.pezzi_totali, 1);
});

function buildReserveConfig() {
  return {
    schema_version: 1,
    id: "reserve-test-v1",
    nome: "Riserva test",
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

function buildGatewayInventory() {
  return {
    ok: true,
    inventory: {
      ok: true,
      listCassette: [
        { Value_Money: 2000, Stock: 20, IsExist: true, IsEmpty: false },
        { Value_Money: 1000, Stock: 20, IsExist: true, IsEmpty: false },
        { Value_Money: 500, Stock: 20, IsExist: true, IsEmpty: false },
        { Value_Money: 200, Stock: 40, IsExist: true, IsEmpty: false },
        { Value_Money: 100, Stock: 40, IsExist: true, IsEmpty: false },
        { Value_Money: 50, Stock: 40, IsExist: true, IsEmpty: false },
        { Value_Money: 20, Stock: 40, IsExist: true, IsEmpty: false },
        { Value_Money: 10, Stock: 40, IsExist: true, IsEmpty: false },
        { Value_Money: 5, Stock: 40, IsExist: true, IsEmpty: false },
        { Value_Money: 2, Stock: 40, IsExist: true, IsEmpty: false },
        { Value_Money: 1, Stock: 40, IsExist: true, IsEmpty: false },
      ],
    },
  };
}

function sanitizeTestPosSettings(settings = {}) {
  return {
    ...settings,
    automaticCash: sanitizeAutomaticCashSettings(settings.automaticCash),
  };
}

function createHarness({
  db,
  payload,
  user,
  automaticCashGateway = null,
  enqueuePrintSpoolJob = null,
}) {
  let response = null;
  let writeCount = 0;
  let currentPayload = payload;
  const handlers = createAutomaticCashHandlers({
    automaticCashGateway,
    enqueuePrintSpoolJob,
    HttpError: TestHttpError,
    hasPermission(candidate, permission) {
      return (
        Array.isArray(candidate?.permissions) &&
        candidate.permissions.includes(permission)
      );
    },
    isPosPrivilegedRole(role) {
      return ["admin", "responsabile"].includes(
        String(role ?? "").toLowerCase(),
      );
    },
    nowIso() {
      return "2026-06-26T10:00:00.000Z";
    },
    async readDb() {
      return db;
    },
    async readJsonBody() {
      return currentPayload;
    },
    resolveSettingsLastWriteAt(meta) {
      return String(
        meta?.settingsLastWriteAt ?? meta?.lastWriteAt ?? "",
      ).trim();
    },
    resolveSettingsVersion() {
      return 1782468000000;
    },
    sanitizePosSettings: sanitizeTestPosSettings,
    sendJson(_res, status, body) {
      response = { status, body };
    },
    touchSettingsMetadata(target, updatedAt) {
      target.meta = {
        ...(target.meta ?? {}),
        lastWriteAt: updatedAt,
        settingsLastWriteAt: updatedAt,
      };
    },
    validateSessionContext() {
      return {
        user,
        session: {
          deviceUuid: currentPayload.deviceUuid,
        },
      };
    },
    async writeDb(nextDb) {
      db = nextDb;
      writeCount += 1;
    },
  });
  return {
    handlers,
    get response() {
      return response;
    },
    get db() {
      return db;
    },
    get writeCount() {
      return writeCount;
    },
    setPayload(nextPayload) {
      currentPayload = nextPayload;
    },
  };
}

test("automatic cash config validator accetta il file esempio", async () => {
  const result = validateAutomaticCashConfigFile(await readExampleConfig());

  assert.equal(result.ok, true);
  assert.equal(result.summary.currency, "EUR");
  assert.equal(result.summary.combinationsCount, 15);
  assert.equal(result.summary.minTotalCents, 12030);
  assert.match(result.warnings.join(" "), /riparte a ciclo/);
});

test("automatic cash config validator rifiuta valori denominazione duplicati", () => {
  const result = validateAutomaticCashConfigFile({
    nome: "Config con tagli duplicati",
    valuta: "EUR",
    denominazioni_centesimi: {
      "1_euro": 100,
      "100_cent": 100,
    },
    combinazioni: [
      {
        id: "DUPLICATE_DENOMINATION",
        totale_centesimi: 200,
        pezzi_totali: 2,
        tagli: { "1_euro": 1, "100_cent": 1 },
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.config, null);
  assert.equal(result.summary, null);
  assert.match(
    result.errors.join(" "),
    /100_cent e 1_euro valgono entrambi 100 centesimi/,
  );
});

test("route registry espone le rotte automatic-cash V5BT", () => {
  const routes = buildRouteRegistry().filter((route) =>
    String(route.path ?? "").startsWith("/api/automatic-cash"),
  );

  assert.deepEqual(
    routes.map(
      (route) => `${route.method} ${route.path} -> ${route.handlerKey}`,
    ),
    [
      "GET /api/automatic-cash/settings -> automaticCash.settings",
      "PUT /api/automatic-cash/settings -> automaticCash.saveSettings",
      "POST /api/automatic-cash/config-sets -> automaticCash.uploadConfigSet",
      "POST /api/automatic-cash/config-sets/default-100 -> automaticCash.uploadDefaultConfigSet",
      "POST /api/automatic-cash/reserve-configs -> automaticCash.uploadReserveConfig",
      "GET /api/automatic-cash/status -> automaticCash.status",
      "GET /api/automatic-cash/gateway/state -> automaticCash.gatewayState",
      "POST /api/automatic-cash/gateway/restart -> automaticCash.gatewayRestart",
      "POST /api/automatic-cash/gateway/reset -> automaticCash.gatewayReset",
      "GET /api/automatic-cash/cash-movements -> automaticCash.cashMovements",
      "GET /api/automatic-cash/cash-movements/active -> automaticCash.activeCashMovement",
      "GET /api/automatic-cash/cash-movements/withdrawal-availability -> automaticCash.cashMovementWithdrawalAvailability",
      "GET /api/automatic-cash/cash-movements/:movementId/state -> automaticCash.cashMovementState",
      "POST /api/automatic-cash/cash-movements/start -> automaticCash.startCashMovement",
      "POST /api/automatic-cash/cash-movements/:movementId/prepare -> automaticCash.prepareCashMovement",
      "POST /api/automatic-cash/cash-movements/:movementId/complete -> automaticCash.completeCashMovement",
      "POST /api/automatic-cash/cash-movements/:movementId/print -> automaticCash.printCashMovementReport",
      "POST /api/automatic-cash/cash-movements/:movementId/cancel -> automaticCash.cancelCashMovement",
      "GET /api/automatic-cash/cash-float/preflight -> automaticCash.cashFloatPreflight",
      "GET /api/automatic-cash/cash-float/active -> automaticCash.activeCashFloatWorkflow",
      "POST /api/automatic-cash/cash-float/generate -> automaticCash.generateCashFloat",
      "POST /api/automatic-cash/cash-float/confirm-removed -> automaticCash.confirmCashFloatRemoved",
      "POST /api/automatic-cash/cash-float/ticket/printed -> automaticCash.cashFloatTicketPrinted",
      "POST /api/automatic-cash/cash-float/confirm-ticket-in-pouch -> automaticCash.confirmCashFloatTicketInPouch",
      "POST /api/automatic-cash/cash-float/load-from-qr -> automaticCash.loadCashFloatFromQr",
      "GET /api/automatic-cash/settlements -> automaticCash.listSettlementRecords",
      "GET /api/automatic-cash/settlements/latest -> automaticCash.latestSettlementRecord",
      "POST /api/automatic-cash/settlements -> automaticCash.saveSettlementRecord",
      "POST /api/automatic-cash/deposit/start -> automaticCash.startDeposit",
      "POST /api/automatic-cash/deposit/close -> automaticCash.closeDeposit",
      "POST /api/automatic-cash/deposit/cancel -> automaticCash.cancelDeposit",
      "GET /api/automatic-cash/exchange/active -> automaticCash.activeCashExchange",
      "POST /api/automatic-cash/payment/start -> automaticCash.startCashPayment",
      "GET /api/automatic-cash/payment/:operationId/state -> automaticCash.cashPaymentState",
      "POST /api/automatic-cash/payment/:operationId/complete -> automaticCash.completeCashPayment",
      "POST /api/automatic-cash/payment/:operationId/cancel -> automaticCash.cancelCashPayment",
      "POST /api/automatic-cash/exchange/start -> automaticCash.startCashExchange",
      "GET /api/automatic-cash/exchange/:exchangeId/state -> automaticCash.cashExchangeState",
      "POST /api/automatic-cash/exchange/:exchangeId/cancel -> automaticCash.cancelCashExchange",
      "POST /api/automatic-cash/exchange/:exchangeId/confirm-deposit -> automaticCash.confirmCashExchangeDeposit",
      "POST /api/automatic-cash/exchange/:exchangeId/execute -> automaticCash.executeCashExchange",
      "POST /api/automatic-cash/exchange/:exchangeId/confirm-removed -> automaticCash.confirmCashExchangeRemoved",
    ],
  );
  assert.equal(routes[0].mutation, false);
  assert.equal(routes[0].authRequired, true);
  assert.equal(routes[2].maxBodySize, 524_288);
  const handlerKeys = new Set(
    Object.keys(
      createHarness({
        db: { meta: {}, posSettings: {} },
        payload: { token: "t", userId: "u", deviceUuid: "d" },
        user: { id: "u", role: "admin", permissions: [] },
      }).handlers,
    ),
  );
  for (const route of routes) {
    assert.equal(
      handlerKeys.has(route.handlerKey),
      true,
      `handler mancante: ${route.handlerKey}`,
    );
  }
});

test("cash movement domain rispetta riserva, tagli e transizioni", () => {
  const availability = buildCashWithdrawalAvailability({
    gatewayInventory: buildGatewayInventory(),
    reserveConfigId: "reserve-test-v1",
    reserveConfigs: [buildReserveConfig()],
  });

  assert.equal(
    availability.find((entry) => entry.cents === 2000)?.availablePieces,
    19,
  );
  assert.equal(
    availability.find((entry) => entry.cents === 1000)?.reservedPieces,
    1,
  );
  assert.deepEqual(selectCashWithdrawalPieces(3500, availability), {
    ok: true,
    pieces: { 2000: 1, 1000: 1, 500: 1 },
    totalCents: 3500,
  });
  assert.deepEqual(
    validateCashWithdrawalPieces({ 2000: 1, 500: 1 }, availability),
    {
      ok: true,
      pieces: { 2000: 1, 500: 1 },
      totalCents: 2500,
    },
  );
  assert.equal(
    validateCashWithdrawalPieces({ 2000: 20 }, availability).code,
    "CASH_MOVEMENT_INVENTORY_INSUFFICIENT",
  );
  assert.deepEqual(
    extractCashMovementPiecesFromGateway({
      inventory: {
        listCassette: [{ Value_Money: 2000, Stock: 99 }],
      },
      deposit: {
        cassettesMonitor: [
          { Value_Money: 1000, ReplenishmentStock: 1 },
          { Value_Money: 500, DepositedStock: 2 },
        ],
      },
    }),
    { 1000: 1, 500: 2 },
  );

  const waiting = transitionCashMovement(
    {
      movementId: "cashmov_test",
      type: "withdrawal",
      status: "STARTING",
      amountCents: 3500,
      requestedAmountCents: 3500,
      startedAtMs: Date.now(),
      updatedAtMs: Date.now(),
    },
    "WAITING_CASH_REMOVAL",
  );
  assert.equal(waiting.status, "WAITING_CASH_REMOVAL");
  assert.throws(
    () => transitionCashMovement(waiting, "ACTIVE"),
    /Transizione movimento cassa non valida/,
  );
});

test("wizard caricamento persiste riepilogo e stampa idempotente senza riaprire il gateway", async () => {
  const gatewayCalls = [];
  const printJobs = [];
  const automaticCashGateway = {
    configured: true,
    async startReplenishment() {
      gatewayCalls.push("start");
      return { ok: true };
    },
    async getState() {
      gatewayCalls.push("state");
      return {
        ...buildGatewayInventory(),
        deposit: {
          depositedTotalCents: 2000,
          cassettesMonitor: [
            { Value_Money: 1000, ReplenishmentStock: 1 },
            { Value_Money: 500, ReplenishmentStock: 2 },
          ],
        },
      };
    },
    async closeReplenishment() {
      gatewayCalls.push("close");
      return {
        payload: {
          depositedTotalCents: 2000,
          deposit: {
            cassettesMonitor: [
              { Value_Money: 1000, ReplenishmentStock: 1 },
              { Value_Money: 500, ReplenishmentStock: 2 },
            ],
          },
        },
        state: null,
      };
    },
    async cancelReplenishment() {
      gatewayCalls.push("cancel");
      return { ok: true };
    },
  };
  const harness = createHarness({
    db: {
      meta: {},
      posSettings: { automaticCash: { enabled: true } },
    },
    payload: {
      token: "t",
      userId: "u_admin",
      deviceUuid: "dev_1",
      clientRequestId: "guided-load-1",
      type: "load",
      justification: "Reintegro guidato",
      activityId: "activity_1",
      roomId: "room_1",
      roomName: "Sala principale",
    },
    user: {
      id: "u_admin",
      fullName: "Admin Test",
      role: "admin",
      permissions: [],
    },
    automaticCashGateway,
    async enqueuePrintSpoolJob(payload) {
      const job = {
        id: `print-${printJobs.length + 1}`,
        status: "queued",
        printerId: "printer-1",
        printerName: "Preconti",
        payload,
      };
      printJobs.push(job);
      return job;
    },
  });

  await harness.handlers["automaticCash.startCashMovement"]({}, {});
  const movementId = harness.response.body.movement.movementId;
  assert.equal(harness.response.body.movement.status, "ACTIVE");

  harness.setPayload({ token: "t", userId: "u_admin", deviceUuid: "dev_1" });
  await harness.handlers["automaticCash.cashMovementState"](
    { params: { movementId } },
    {},
  );
  assert.equal(harness.response.body.movement.amountCents, 2000);
  assert.deepEqual(harness.response.body.movement.pieces, {
    1000: 1,
    500: 2,
  });

  await harness.handlers["automaticCash.prepareCashMovement"](
    { params: { movementId } },
    {},
  );
  assert.equal(harness.response.body.movement.status, "REVIEW_REQUIRED");
  assert.equal(gatewayCalls.filter((entry) => entry === "close").length, 1);

  harness.setPayload({
    token: "t",
    userId: "u_admin",
    deviceUuid: "dev_1",
    awaitingReport: true,
  });
  await harness.handlers["automaticCash.completeCashMovement"](
    { params: { movementId } },
    {},
  );
  assert.equal(harness.response.body.movement.status, "WAITING_REPORT");
  assert.equal(
    getActiveCashMovement(harness.db.posSettings.automaticCash).movementId,
    movementId,
  );

  harness.setPayload({
    token: "t",
    userId: "u_admin",
    deviceUuid: "dev_1",
    clientRequestId: `cash-report-${movementId}-initial`,
  });
  await harness.handlers["automaticCash.printCashMovementReport"](
    { params: { movementId } },
    {},
  );
  assert.equal(harness.response.body.movement.status, "COMPLETED");
  assert.equal(harness.response.body.movement.reportPrintCount, 1);
  assert.match(printJobs[0].payload.text, /REPORT CARICAMENTO/);
  assert.match(printJobs[0].payload.text, /Admin Test/);
  assert.match(printJobs[0].payload.text, /20,00 EUR/);

  await harness.handlers["automaticCash.printCashMovementReport"](
    { params: { movementId } },
    {},
  );
  assert.equal(harness.response.body.deduplicated, true);
  assert.equal(printJobs.length, 1);
  assert.equal(gatewayCalls.filter((entry) => entry === "start").length, 1);
  assert.equal(gatewayCalls.filter((entry) => entry === "close").length, 1);

  harness.setPayload({
    token: "t",
    userId: "u_admin",
    deviceUuid: "dev_1",
    clientRequestId: `cash-report-${movementId}-reprint-1`,
    reprint: true,
  });
  await harness.handlers["automaticCash.printCashMovementReport"](
    { params: { movementId } },
    {},
  );
  assert.equal(harness.response.body.movement.reportPrintCount, 2);
  assert.equal(printJobs.length, 2);
});

test("wizard prelievo usa i tagli scelti e non eroga di nuovo durante stampa e ristampa", async () => {
  const gatewayCalls = [];
  const printJobs = [];
  const automaticCashGateway = {
    configured: true,
    async refreshInventory() {
      gatewayCalls.push("refresh");
      return buildGatewayInventory();
    },
    async executeWithdrawal(payload) {
      gatewayCalls.push({ type: "withdrawal", payload });
      return { ok: true };
    },
    async confirmWithdrawalRemoved() {
      gatewayCalls.push("removed");
      return { ok: true };
    },
  };
  const harness = createHarness({
    db: {
      meta: {},
      posSettings: {
        automaticCash: {
          enabled: true,
          reserveConfigId: "reserve-test-v1",
          reserveConfigs: [buildReserveConfig()],
        },
      },
    },
    payload: {
      token: "t",
      userId: "u_operator",
      deviceUuid: "dev_2",
      clientRequestId: "guided-withdrawal-1",
      type: "withdrawal",
      amountCents: 2500,
      pieces: { 1000: 2, 500: 1 },
      justification: "Acquisto urgente",
      activityId: "activity_1",
      roomId: "room_1",
    },
    user: {
      id: "u_operator",
      fullName: "Operatore Test",
      role: "cameriere",
      permissions: ["collect_payments"],
    },
    automaticCashGateway,
    async enqueuePrintSpoolJob(payload) {
      const job = {
        id: `withdrawal-print-${printJobs.length + 1}`,
        status: "queued",
        printerId: "printer-1",
        printerName: "Preconti",
        payload,
      };
      printJobs.push(job);
      return job;
    },
  });

  await harness.handlers["automaticCash.startCashMovement"]({}, {});
  const movementId = harness.response.body.movement.movementId;
  assert.deepEqual(
    gatewayCalls.find((entry) => entry?.type === "withdrawal").payload.pieces,
    { 1000: 2, 500: 1 },
  );
  assert.equal(harness.response.body.movement.status, "WAITING_CASH_REMOVAL");

  harness.setPayload({
    token: "t",
    userId: "u_operator",
    deviceUuid: "dev_2",
    awaitingReport: true,
  });
  await harness.handlers["automaticCash.completeCashMovement"](
    { params: { movementId } },
    {},
  );
  assert.equal(harness.response.body.movement.status, "WAITING_REPORT");

  harness.setPayload({
    token: "t",
    userId: "u_operator",
    deviceUuid: "dev_2",
    clientRequestId: `cash-report-${movementId}-initial`,
  });
  await harness.handlers["automaticCash.printCashMovementReport"](
    { params: { movementId } },
    {},
  );
  assert.equal(harness.response.body.movement.status, "COMPLETED");
  assert.equal(harness.response.body.movement.signedAmountCents, -2500);
  assert.equal(
    gatewayCalls.filter((entry) => entry?.type === "withdrawal").length,
    1,
  );
  assert.equal(gatewayCalls.filter((entry) => entry === "removed").length, 1);
  assert.equal(printJobs.length, 1);
});

test("report movimento conserva il dettaglio tagli e l'operatore", () => {
  const report = buildCashMovementReportText({
    movementId: "cashmov_report",
    type: "withdrawal",
    status: "COMPLETED",
    amountCents: 2500,
    requestedAmountCents: 2500,
    pieces: { 1000: 2, 500: 1 },
    justification: "Test report",
    ownerFullName: "Lorenzo Bigazzi",
    startedAtMs: Date.now(),
    updatedAtMs: Date.now(),
    completedAtMs: Date.now(),
  });
  assert.match(report, /REPORT PRELIEVO/);
  assert.match(report, /Lorenzo Bigazzi/);
  assert.match(report, /10,00 EUR/);
  assert.match(report, /25,00 EUR/);
});

test("movimento caricamento e persistente, idempotente e visibile nelle statistiche", async () => {
  const calls = [];
  const automaticCashGateway = {
    configured: true,
    async startReplenishment() {
      calls.push("start");
      return { ok: true };
    },
    async getState() {
      calls.push("state");
      return buildGatewayInventory();
    },
    async closeReplenishment() {
      calls.push("close");
      return {
        payload: { depositedTotalCents: 2750 },
        state: buildGatewayInventory(),
      };
    },
    async cancelReplenishment() {
      calls.push("cancel");
      return { ok: true };
    },
  };
  const payload = {
    token: "t",
    userId: "u_admin",
    deviceUuid: "dev_1",
    clientRequestId: "cash-load-request-1",
    type: "load",
    justification: "Caricamento monete inizio turno",
    activityId: "activity_1",
    roomId: "room_1",
    roomName: "Sala",
  };
  const harness = createHarness({
    db: {
      meta: {},
      posSettings: { automaticCash: { enabled: true } },
    },
    payload,
    user: {
      id: "u_admin",
      fullName: "Admin Test",
      role: "admin",
      permissions: ["view_analytics"],
    },
    automaticCashGateway,
  });

  await harness.handlers["automaticCash.startCashMovement"]({}, {});
  const movementId = harness.response.body.movement.movementId;
  assert.equal(harness.response.status, 200);
  assert.equal(harness.response.body.movement.status, "ACTIVE");
  assert.equal(
    getActiveCashMovement(harness.db.posSettings.automaticCash).movementId,
    movementId,
  );

  await harness.handlers["automaticCash.startCashMovement"]({}, {});
  assert.equal(harness.response.body.resumed, true);
  assert.deepEqual(calls, ["start"]);

  harness.setPayload({
    token: "t",
    userId: "u_admin",
    deviceUuid: "dev_1",
  });
  await harness.handlers["automaticCash.completeCashMovement"](
    { params: { movementId } },
    {},
  );
  assert.equal(harness.response.body.movement.status, "COMPLETED");
  assert.equal(harness.response.body.movement.amountCents, 2750);
  assert.equal(harness.response.body.movement.signedAmountCents, 2750);
  assert.equal(getActiveCashMovement(harness.db.posSettings.automaticCash), null);

  harness.db.posSettings.automaticCash.cashExchanges.push({
    exchangeId: "exchange_completed_1",
    operationId: "exchange_op_1",
    ownerUserId: "u_admin",
    ownerFullName: "Admin Test",
    ownerDeviceUuid: "dev_1",
    activityId: "activity_1",
    roomId: "room_1",
    status: "COMPLETED",
    depositedCents: 2000,
    selectedPieces: { 2000: 1 },
    startedAtMs: Date.now() - 2000,
    updatedAtMs: Date.now() - 1000,
    completedAtMs: Date.now() - 1000,
  });
  await harness.handlers["automaticCash.cashMovements"]({}, {});
  assert.deepEqual(
    new Set(harness.response.body.movements.map((entry) => entry.type)),
    new Set(["load", "exchange"]),
  );
  assert.deepEqual(calls, ["start", "state", "close"]);
});

test("movimento prelievo richiede giustificazione ed eroga i tagli una sola volta", async () => {
  const calls = [];
  const automaticCashGateway = {
    configured: true,
    async refreshInventory() {
      calls.push({ type: "refresh" });
      return buildGatewayInventory();
    },
    async executeWithdrawal(payload) {
      calls.push({ type: "withdrawal", payload });
      return { ok: true };
    },
    async confirmWithdrawalRemoved() {
      calls.push({ type: "removed" });
      return { ok: true };
    },
  };
  const basePayload = {
    token: "t",
    userId: "u_operator",
    deviceUuid: "dev_2",
    clientRequestId: "cash-withdrawal-request-1",
    type: "withdrawal",
    amountCents: 3500,
    activityId: "activity_1",
    roomId: "room_1",
  };
  const harness = createHarness({
    db: {
      meta: {},
      posSettings: {
        automaticCash: {
          enabled: true,
          reserveConfigId: "reserve-test-v1",
          reserveConfigs: [buildReserveConfig()],
        },
      },
    },
    payload: basePayload,
    user: {
      id: "u_operator",
      fullName: "Operatore Test",
      role: "cameriere",
      permissions: ["collect_payments"],
    },
    automaticCashGateway,
  });

  await assert.rejects(
    () => harness.handlers["automaticCash.startCashMovement"]({}, {}),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "CASH_MOVEMENT_JUSTIFICATION_REQUIRED");
      return true;
    },
  );
  assert.equal(calls.length, 0);

  harness.setPayload({
    ...basePayload,
    justification: "Prelievo contanti per acquisto urgente",
  });
  await harness.handlers["automaticCash.startCashMovement"]({}, {});
  const movementId = harness.response.body.movement.movementId;
  assert.equal(
    harness.response.body.movement.status,
    "WAITING_CASH_REMOVAL",
  );
  assert.deepEqual(
    calls.find((entry) => entry.type === "withdrawal")?.payload.pieces,
    { 2000: 1, 1000: 1, 500: 1 },
  );

  await harness.handlers["automaticCash.startCashMovement"]({}, {});
  assert.equal(harness.response.body.resumed, true);
  assert.equal(
    calls.filter((entry) => entry.type === "withdrawal").length,
    1,
  );

  harness.setPayload({
    token: "t",
    userId: "u_operator",
    deviceUuid: "dev_2",
  });
  await harness.handlers["automaticCash.completeCashMovement"](
    { params: { movementId } },
    {},
  );
  assert.equal(harness.response.body.movement.status, "COMPLETED");
  assert.equal(harness.response.body.movement.signedAmountCents, -3500);
  assert.deepEqual(
    calls.map((entry) => entry.type),
    ["refresh", "withdrawal", "removed"],
  );
});

test("automaticCash.uploadConfigSet valida e salva la configurazione in posSettings", async () => {
  const config = await readExampleConfig();
  const harness = createHarness({
    db: { meta: {}, posSettings: { automaticCash: { enabled: false } } },
    payload: { token: "t", userId: "u_admin", deviceUuid: "dev_1", config },
    user: { id: "u_admin", username: "admin", role: "admin", permissions: [] },
  });

  await harness.handlers["automaticCash.uploadConfigSet"]({}, {});

  assert.equal(harness.writeCount, 1);
  assert.equal(harness.response.status, 200);
  assert.equal(harness.response.body.enabled, true);
  assert.equal(harness.response.body.autoCashFloatMode, "random_file");
  assert.equal(harness.response.body.configSet.combinationsCount, 15);
  assert.equal(harness.db.posSettings.automaticCash.configSets.length, 1);
  assert.equal(
    harness.db.posSettings.automaticCash.configSets[0].config.combinazioni
      .length,
    15,
  );
  assert.equal(harness.db.meta.settingsLastWriteAt, "2026-06-26T10:00:00.000Z");
});

test("automaticCash.uploadConfigSet rifiuta duplicati e totali incoerenti", async () => {
  const harness = createHarness({
    db: { meta: {}, posSettings: {} },
    payload: {
      token: "t",
      userId: "u_admin",
      deviceUuid: "dev_1",
      config: {
        nome: "Config errata",
        valuta: "EUR",
        denominazioni_centesimi: { "1_euro": 100 },
        combinazioni: [
          {
            id: "DUP",
            totale_centesimi: 100,
            pezzi_totali: 1,
            tagli: { "1_euro": 1 },
          },
          {
            id: "DUP",
            totale_centesimi: 250,
            pezzi_totali: 3,
            tagli: { "1_euro": 2 },
          },
        ],
      },
    },
    user: { id: "u_admin", username: "admin", role: "admin", permissions: [] },
  });

  await assert.rejects(
    () => harness.handlers["automaticCash.uploadConfigSet"]({}, {}),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, "AUTOMATIC_CASH_CONFIG_INVALID");
      assert.match(
        error.details.errors.join(" "),
        /Combinazione duplicata: DUP/,
      );
      assert.match(
        error.details.errors.join(" "),
        /totale calcolato 200 diverso da 250/,
      );
      return true;
    },
  );
  assert.equal(harness.writeCount, 0);
});

test("automaticCash gateway restart/reset usa il gateway solo a cassa libera", async () => {
  const calls = [];
  const automaticCashGateway = {
    configured: true,
    async restartMachine(payload) {
      calls.push({ type: "restart", payload });
      return { ok: true, command: "restart" };
    },
    async resetMachine(payload) {
      calls.push({ type: "reset", payload });
      return { ok: true, command: "reset" };
    },
  };
  const harness = createHarness({
    db: { meta: {}, posSettings: { automaticCash: { enabled: true } } },
    payload: {
      token: "t",
      userId: "u_admin",
      deviceUuid: "dev_1",
      reason: "test_admin",
    },
    user: {
      id: "u_admin",
      username: "admin",
      fullName: "Admin Test",
      role: "admin",
      permissions: [],
    },
    automaticCashGateway,
  });

  await harness.handlers["automaticCash.gatewayRestart"]({}, {});
  assert.equal(harness.response.status, 200);
  assert.equal(harness.response.body.command, "restart");

  harness.setPayload({
    token: "t",
    userId: "u_admin",
    deviceUuid: "dev_1",
    reason: "test_admin",
  });
  await harness.handlers["automaticCash.gatewayReset"]({}, {});
  assert.equal(harness.response.status, 200);
  assert.equal(harness.response.body.command, "reset");
  assert.deepEqual(
    calls.map((entry) => entry.type),
    ["restart", "reset"],
  );
  assert.equal(calls[0].payload.requestedBy, "Admin Test");

  const busyHarness = createHarness({
    db: {
      meta: {},
      posSettings: {
        automaticCash: {
          enabled: true,
          deposits: [
            {
              operationId: "dep_busy",
              cashFloatId: "cf_busy",
              ownerUserId: "u_admin",
              ownerDeviceUuid: "dev_1",
              status: "ACTIVE",
              startedAtMs: Date.now(),
              depositedTotalCents: 0,
            },
          ],
        },
      },
    },
    payload: {
      token: "t",
      userId: "u_admin",
      deviceUuid: "dev_1",
      reason: "busy",
    },
    user: { id: "u_admin", username: "admin", role: "admin", permissions: [] },
    automaticCashGateway,
  });
  await assert.rejects(
    () => busyHarness.handlers["automaticCash.gatewayReset"]({}, {}),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "CASH_GATEWAY_LOCKED");
      return true;
    },
  );
  assert.deepEqual(
    calls.map((entry) => entry.type),
    ["restart", "reset"],
  );
});

test("automaticCash pagamento contanti usa cashin Pagamento con dovuto e resto", async () => {
  const calls = [];
  const automaticCashGateway = {
    configured: true,
    async getState() {
      calls.push({ type: "state" });
      return {
        ...buildGatewayInventory(),
        activeOperation: null,
      };
    },
    async startCashinPayment(payload) {
      calls.push({ type: "start-payment", payload });
      return { ok: true };
    },
    async getCashinDeposit(payload) {
      calls.push({ type: "deposit", payload });
      return {
        payload: {
          depositedTotalCents: 2000,
        },
        state: {
          deposit: {
            raw: {
              depositedTotalCents: 2000,
            },
          },
        },
      };
    },
    async completeCashinPayment(payload) {
      calls.push({ type: "complete-payment", payload });
      return { ok: true };
    },
    async cancelCashinPayment(payload) {
      calls.push({ type: "cancel-payment", payload });
      return { ok: true };
    },
  };
  const harness = createHarness({
    db: {
      meta: {},
      posSettings: {
        automaticCash: {
          enabled: true,
          gatewayConfigured: true,
          gatewayInventory: buildGatewayInventory(),
        },
      },
    },
    payload: {
      token: "t",
      userId: "u_operator",
      deviceUuid: "dev_1",
      expectedTotalCents: 1500,
      note: "Banco test",
    },
    user: {
      id: "u_operator",
      username: "lorenzo",
      fullName: "Lorenzo Test",
      role: "operator",
      permissions: [],
    },
    automaticCashGateway,
  });

  await harness.handlers["automaticCash.startCashPayment"]({}, {});
  assert.equal(harness.response.status, 200);
  assert.equal(harness.response.body.expectedTotalCents, 1500);
  const operationId = harness.response.body.operationId;
  assert.match(operationId, /^paycash_/);
  assert.equal(harness.writeCount, 1);

  await harness.handlers["automaticCash.cashPaymentState"](
    { params: { operationId } },
    {},
  );
  assert.equal(harness.response.status, 200);
  assert.equal(harness.response.body.expectedTotalCents, 1500);
  assert.equal(harness.response.body.depositedTotalCents, 2000);
  assert.equal(harness.response.body.changeDueCents, 500);
  assert.equal(harness.response.body.readyToComplete, true);
  assert.equal(harness.writeCount, 1);

  harness.setPayload({
    token: "t",
    userId: "u_operator",
    deviceUuid: "dev_1",
    operationId,
    expectedTotalCents: 1500,
    depositedTotalCents: 2000,
    changeDueCents: 500,
  });
  await harness.handlers["automaticCash.completeCashPayment"](
    { params: { operationId } },
    {},
  );
  assert.equal(harness.response.status, 200);
  assert.equal(harness.response.body.gatewayResponse.ok, true);
  assert.equal(harness.response.body.expectedTotalCents, 1500);
  assert.equal(harness.response.body.depositedTotalCents, 2000);
  assert.equal(harness.response.body.changeDueCents, 500);
  assert.equal(harness.response.body.status, "COMPLETED");
  assert.equal(harness.writeCount, 2);

  harness.setPayload({
    token: "t",
    userId: "u_operator",
    deviceUuid: "dev_1",
    operationId,
  });
  await harness.handlers["automaticCash.cancelCashPayment"](
    { params: { operationId } },
    {},
  );
  assert.equal(harness.response.status, 200);
  assert.equal(harness.response.body.status, "COMPLETED");

  assert.deepEqual(
    calls.map((entry) => entry.type),
    ["state", "start-payment", "deposit", "deposit", "complete-payment"],
  );
  assert.equal(calls[1].payload.operationId, operationId);
  assert.equal(calls[1].payload.userId, "u_operator");
  assert.equal(calls[1].payload.note, "Banco test");
  assert.equal(calls[1].payload.expectedTotalCents, 1500);
  assert.equal(calls[2].payload.operationId, operationId);
  assert.equal(calls[3].payload.operationId, operationId);
  assert.equal(calls[4].payload.operationId, operationId);
  assert.equal(calls[4].payload.expectedTotalCents, 1500);
  assert.equal(calls[4].payload.depositedTotalCents, 2000);
  assert.equal(calls[4].payload.changeDueCents, 500);
  assert.equal(harness.db.posSettings.automaticCash.cashPayments[0].status, "COMPLETED");
});

test("automaticCash pagamento contanti blocca la chiusura se mancano contanti", async () => {
  const calls = [];
  const automaticCashGateway = {
    configured: true,
    async getState() {
      calls.push({ type: "state" });
      return {
        ...buildGatewayInventory(),
        activeOperation: null,
      };
    },
    async startCashinPayment(payload) {
      calls.push({ type: "start-payment", payload });
      return { ok: true };
    },
    async getCashinDeposit(payload) {
      calls.push({ type: "deposit", payload });
      return {
        payload: {
          depositedTotalCents: 1000,
        },
        state: null,
      };
    },
    async completeCashinPayment(payload) {
      calls.push({ type: "complete-payment", payload });
      return { ok: true };
    },
  };
  const harness = createHarness({
    db: {
      meta: {},
      posSettings: {
        automaticCash: {
          enabled: true,
          gatewayConfigured: true,
          gatewayInventory: buildGatewayInventory(),
        },
      },
    },
    payload: {
      token: "t",
      userId: "u_operator",
      deviceUuid: "dev_1",
      expectedTotalCents: 2000,
    },
    user: {
      id: "u_operator",
      username: "lorenzo",
      fullName: "Lorenzo Test",
      role: "operator",
      permissions: [],
    },
    automaticCashGateway,
  });

  await harness.handlers["automaticCash.startCashPayment"]({}, {});
  const operationId = harness.response.body.operationId;
  harness.setPayload({
    token: "t",
    userId: "u_operator",
    deviceUuid: "dev_1",
    operationId,
  });

  await assert.rejects(
    () =>
      harness.handlers["automaticCash.completeCashPayment"](
        { params: { operationId } },
        {},
      ),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "CASH_PAYMENT_INCOMPLETE");
      assert.equal(error.details.expectedTotalCents, 2000);
      assert.equal(error.details.depositedTotalCents, 1000);
      return true;
    },
  );
  assert.deepEqual(
    calls.map((entry) => entry.type),
    ["state", "start-payment", "deposit"],
  );
});

test("automatic cash reserve validator accetta il secondo file riserva", () => {
  const result = validateAutomaticCashReserveConfigFile(buildReserveConfig());

  assert.equal(result.ok, true);
  assert.equal(result.summary.id, "reserve-test-v1");
  assert.equal(result.summary.minimumPiecesTotal, 9);
});

test("cash exchange domain valida tagli e transizioni atomiche", () => {
  assert.deepEqual(
    CASH_EXCHANGE_DENOMINATION_CENTS,
    [2000, 1000, 500, 200, 100, 50, 20, 10, 5],
  );
  assert.equal(sumCashExchangePieces({ 2000: 1, 500: 1, 2: 9 }), 2500);
  const validation = validateCashExchangePieces({ 2000: 1, 500: 1 }, 2500);
  assert.equal(validation.ok, true);
  assert.equal(validation.selectedTotalCents, 2500);
  const mismatch = validateCashExchangePieces({ 2000: 1 }, 2500);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "CASH_EXCHANGE_TOTAL_MISMATCH");

  const started = transitionCashExchange(
    {
      exchangeId: "EXC-1",
      status: "CREATED",
      depositedCents: 0,
      startedAtMs: 1,
      updatedAtMs: 1,
    },
    "CHANGE_STARTED",
    { nowMs: 2 },
  );
  assert.equal(started.ok, true);
  assert.equal(started.exchange.status, "CHANGE_STARTED");
  const invalid = transitionCashExchange(started.exchange, "COMPLETED", {
    nowMs: 3,
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /Transizione cambio non valida/);
});

test("automaticCash.uploadReserveConfig valida e salva la riserva in posSettings", async () => {
  const harness = createHarness({
    db: { meta: {}, posSettings: { automaticCash: { enabled: true } } },
    payload: {
      token: "t",
      userId: "u_admin",
      deviceUuid: "dev_1",
      config: buildReserveConfig(),
    },
    user: { id: "u_admin", username: "admin", role: "admin", permissions: [] },
  });

  await harness.handlers["automaticCash.uploadReserveConfig"]({}, {});

  assert.equal(harness.writeCount, 1);
  assert.equal(harness.response.status, 200);
  assert.equal(harness.response.body.reserveConfig.id, "reserve-test-v1");
  assert.equal(harness.db.posSettings.automaticCash.reserveConfigs.length, 1);
});

test("preflight richiede inventario e riserva minima", async () => {
  const config = await readExampleConfig();
  const reserve = buildReserveConfig();
  const settings = sanitizeAutomaticCashSettings({
    enabled: true,
    gatewayConfigured: true,
    gatewayInventory: buildGatewayInventory(),
    configSets: [
      {
        id: "config-v1",
        name: "Config",
        currency: "EUR",
        combinationsCount: 15,
        minTotalCents: 12030,
        maxTotalCents: 17140,
        uniquePerUserPerBusinessEvening: true,
        config,
      },
    ],
    configSetId: "config-v1",
    reserveConfigs: [
      {
        id: "reserve-test-v1",
        name: "Riserva test",
        currency: "EUR",
        enabled: true,
        missingDenominationPolicy: "reject",
        denominationsCount: 11,
        minimumPiecesTotal: 9,
        denominazioni_centesimi: reserve.denominazioni_centesimi,
        riserva_minima_pezzi: reserve.riserva_minima_pezzi,
        config: reserve,
      },
    ],
    reserveConfigId: "reserve-test-v1",
  });

  const preflight = buildAutomaticCashPreflight(settings, {
    userId: "u_admin",
    nowMs: new Date("2026-06-26T10:00:00.000Z").getTime(),
  });

  assert.equal(preflight.canCreate, true);
  assert.equal(preflight.reasonCode, "OK");
  assert.equal(preflight.eligibleCombinationCount > 0, true);
});

test("fondo cassa automatico riusa il pool quando le combinazioni serata sono esaurite", async () => {
  const config = await readExampleConfig();
  const reserve = buildReserveConfig();
  const businessEveningKey = "2026-06-26";
  const settings = sanitizeAutomaticCashSettings({
    enabled: true,
    gatewayConfigured: true,
    gatewayInventory: buildGatewayInventory(),
    configSets: [
      {
        id: "config-v1",
        name: "Config",
        currency: "EUR",
        combinationsCount: config.combinazioni.length,
        minTotalCents: 12030,
        maxTotalCents: 17140,
        uniquePerUserPerBusinessEvening: true,
        config,
      },
    ],
    configSetId: "config-v1",
    reserveConfigs: [
      {
        id: "reserve-test-v1",
        name: "Riserva test",
        currency: "EUR",
        enabled: true,
        missingDenominationPolicy: "reject",
        denominationsCount: 11,
        minimumPiecesTotal: 9,
        denominazioni_centesimi: reserve.denominazioni_centesimi,
        riserva_minima_pezzi: reserve.riserva_minima_pezzi,
        config: reserve,
      },
    ],
    reserveConfigId: "reserve-test-v1",
    assignments: config.combinazioni.map((combination, index) => ({
      assignmentId: `assign-${index}`,
      cashFloatId: `FCA-${index}`,
      workflowId: `fcw-${index}`,
      ownerUserId: `u_${index}`,
      ownerDeviceUuid: `dev_${index}`,
      businessEveningKey,
      combinationId: combination.id,
      configSetId: "config-v1",
      reserveConfigId: "reserve-test-v1",
      status: "assigned",
      createdAtMs: 1_782_468_000_000 + index,
    })),
  });

  const context = {
    userId: "u_admin",
    businessEveningKey,
    nowMs: new Date("2026-06-26T10:00:00.000Z").getTime(),
  };
  const preflight = buildAutomaticCashPreflight(settings, context);

  assert.equal(preflight.canCreate, true);
  assert.equal(preflight.reasonCode, "OK");
  assert.equal(preflight.unusedCombinationCount, 0);
  assert.equal(preflight.cycledCombinationPool, true);
  assert.equal(preflight.eligibleCombinationCount > 0, true);

  const selected = selectAutomaticCashCombination(settings, context);
  assert.equal(selected.preflight.canCreate, true);
  assert.equal(selected.preflight.cycledCombinationPool, true);
  assert.ok(selected.combination);
  assert.equal(
    config.combinazioni.some(
      (combination) => combination.id === selected.combination.id,
    ),
    true,
  );
});

test("feedback scarico normalizza soglia rossa e usa il limite configurato", () => {
  const settings = sanitizeAutomaticCashSettings({
    warningThresholdCents: 1500,
    dangerThresholdCents: 500,
  });
  assert.equal(settings.warningThresholdCents, 1500);
  assert.equal(settings.dangerThresholdCents, 1500);
  assert.equal(
    resolveAutomaticCashSettlementFeedback({
      expectedDepositTotalCents: 10_000,
      depositedTotalCents: 9_500,
      warningThresholdCents: 100,
      dangerThresholdCents: 500,
    }),
    "sad",
  );
  assert.equal(
    resolveAutomaticCashSettlementFeedback({
      expectedDepositTotalCents: 10_000,
      depositedTotalCents: 9_499,
      warningThresholdCents: 100,
      dangerThresholdCents: 500,
    }),
    "angry",
  );
});

test("workflow fondo cassa resta occupato fino a conferma scontrino nel borsellino", async () => {
  const config = await readExampleConfig();
  const reserve = buildReserveConfig();
  const db = {
    meta: {},
    posSettings: {
      automaticCash: {
        enabled: true,
        gatewayConfigured: true,
        gatewayInventory: buildGatewayInventory(),
        configSets: [
          {
            id: "config-v1",
            name: "Config",
            currency: "EUR",
            combinationsCount: 15,
            minTotalCents: 12030,
            maxTotalCents: 17140,
            uniquePerUserPerBusinessEvening: true,
            config,
          },
        ],
        configSetId: "config-v1",
        reserveConfigs: [
          {
            id: "reserve-test-v1",
            name: "Riserva test",
            currency: "EUR",
            enabled: true,
            missingDenominationPolicy: "reject",
            denominationsCount: 11,
            minimumPiecesTotal: 9,
            denominazioni_centesimi: reserve.denominazioni_centesimi,
            riserva_minima_pezzi: reserve.riserva_minima_pezzi,
            config: reserve,
          },
        ],
        reserveConfigId: "reserve-test-v1",
      },
    },
  };
  const harness = createHarness({
    db,
    payload: {
      token: "t",
      userId: "u_admin",
      deviceUuid: "dev_1",
      reason: "operator_cash_float",
    },
    user: { id: "u_admin", username: "admin", role: "admin", permissions: [] },
  });

  await harness.handlers["automaticCash.generateCashFloat"]({}, {});
  const generated = harness.response.body;

  assert.equal(harness.response.status, 200);
  assert.equal(generated.step, "WAITING_CASH_REMOVAL");
  assert.equal(harness.db.posSettings.automaticCash.cashFloats.length, 0);
  assert.equal(
    harness.db.posSettings.automaticCash.workflows[0].step,
    "WAITING_CASH_REMOVAL",
  );

  const writeCountAfterGenerate = harness.writeCount;
  const activeOwnerPreflight = buildAutomaticCashPreflight(
    harness.db.posSettings.automaticCash,
    {
      userId: "u_admin",
      nowMs: new Date("2026-06-26T10:00:00.000Z").getTime(),
    },
  );
  assert.equal(activeOwnerPreflight.canCreate, false);
  assert.equal(activeOwnerPreflight.reasonCode, "FCA_ACTIVE_WORKFLOW");
  assert.equal(
    activeOwnerPreflight.activeWorkflow.resumableByCurrentUser,
    true,
  );
  assert.equal(
    activeOwnerPreflight.activeWorkflow.operationId,
    generated.operationId,
  );
  assert.equal(
    activeOwnerPreflight.activeWorkflow.qrPayload,
    generated.qrPayload,
  );

  const activeManagerPreflight = buildAutomaticCashPreflight(
    harness.db.posSettings.automaticCash,
    {
      userId: "u_manager",
      canManageAutomaticCash: true,
      nowMs: new Date("2026-06-26T10:00:00.000Z").getTime(),
    },
  );
  assert.equal(
    activeManagerPreflight.activeWorkflow.resumableByCurrentUser,
    false,
  );
  assert.equal(
    activeManagerPreflight.activeWorkflow.blockedByOperationLock,
    true,
  );
  assert.equal(activeManagerPreflight.activeWorkflow.operationId, undefined);

  const activeOtherPreflight = buildAutomaticCashPreflight(
    harness.db.posSettings.automaticCash,
    {
      userId: "u_other",
      nowMs: new Date("2026-06-26T10:00:00.000Z").getTime(),
    },
  );
  assert.equal(
    activeOtherPreflight.activeWorkflow.resumableByCurrentUser,
    false,
  );
  assert.equal(
    activeOtherPreflight.activeWorkflow.blockedByOperationLock,
    true,
  );
  assert.equal(activeOtherPreflight.activeWorkflow.operationId, undefined);
  assert.equal(activeOtherPreflight.activeWorkflow.qrPayload, undefined);

  harness.setPayload({
    token: "t",
    userId: "u_admin",
    deviceUuid: "dev_1",
    reason: "operator_cash_float",
    preferExistingAssignmentForEvening: true,
  });
  await harness.handlers["automaticCash.generateCashFloat"]({}, {});
  assert.equal(harness.response.body.resumed, true);
  assert.equal(harness.response.body.workflowId, generated.workflowId);
  assert.equal(harness.response.body.qrPayload, generated.qrPayload);
  assert.equal(harness.writeCount, writeCountAfterGenerate + 1);

  const adminResumeHarness = createHarness({
    db: harness.db,
    payload: {
      token: "t",
      userId: "u_manager",
      deviceUuid: "dev_manager",
      reason: "operator_cash_float",
      preferExistingAssignmentForEvening: true,
    },
    user: {
      id: "u_manager",
      username: "manager",
      role: "admin",
      permissions: [],
    },
  });
  await assert.rejects(
    () =>
      adminResumeHarness.handlers["automaticCash.generateCashFloat"]({}, {}),
    (error) => {
      assert.equal(error.statusCode, 423);
      assert.equal(error.code, "AUTOMATIC_CASH_LOCKED");
      return true;
    },
  );

  const otherResumeHarness = createHarness({
    db: harness.db,
    payload: {
      token: "t",
      userId: "u_other",
      deviceUuid: "dev_other",
      reason: "operator_cash_float",
      preferExistingAssignmentForEvening: true,
    },
    user: {
      id: "u_other",
      username: "other",
      role: "cassiere",
      permissions: [],
    },
  });
  await assert.rejects(
    () =>
      otherResumeHarness.handlers["automaticCash.generateCashFloat"]({}, {}),
    (error) => {
      assert.equal(error.statusCode, 423);
      assert.equal(error.code, "AUTOMATIC_CASH_LOCKED");
      return true;
    },
  );

  harness.setPayload({
    token: "t",
    userId: "u_admin",
    deviceUuid: "dev_1",
    workflowId: generated.workflowId,
    operationId: generated.operationId,
    cashFloatId: generated.cashFloatId,
  });
  await harness.handlers["automaticCash.confirmCashFloatRemoved"]({}, {});
  assert.equal(
    harness.db.posSettings.automaticCash.workflows[0].step,
    "TICKET_READY",
  );
  assert.equal(harness.db.posSettings.automaticCash.cashFloats.length, 0);
  await assert.rejects(
    () => harness.handlers["automaticCash.confirmCashFloatTicketInPouch"]({}, {}),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "FCA_WORKFLOW_STEP_CONFLICT");
      assert.match(error.message, /stampa scontrino accettata/);
      return true;
    },
  );

  await harness.handlers["automaticCash.cashFloatTicketPrinted"]({}, {});
  assert.equal(
    harness.db.posSettings.automaticCash.workflows[0].step,
    "WAITING_TICKET_IN_POUCH",
  );
  await harness.handlers["automaticCash.confirmCashFloatTicketInPouch"]({}, {});

  assert.equal(
    harness.db.posSettings.automaticCash.workflows[0].step,
    "COMPLETED",
  );
  assert.equal(harness.db.posSettings.automaticCash.cashFloats.length, 0);
  assert.equal(harness.response.body.cashFloat, null);
  assert.equal(harness.response.body.cashFloatId, generated.cashFloatId);
  assert.equal(harness.response.body.settlementAllowed, false);
  harness.setPayload({
    token: "t",
    userId: "u_admin",
    deviceUuid: "dev_other_same_user",
  });
  await harness.handlers["automaticCash.status"]({}, {});
  assert.equal(harness.response.body.settlementAllowed, false);
  assert.equal(harness.response.body.cashFloat, null);

  harness.setPayload({
    token: "t",
    userId: "u_admin",
    deviceUuid: "dev_1",
    qrPayload: generated.qrPayload,
  });
  await harness.handlers["automaticCash.loadCashFloatFromQr"]({}, {});
  assert.equal(
    harness.db.posSettings.automaticCash.cashFloats[0].cashFloatId,
    generated.cashFloatId,
  );

  harness.setPayload({
    token: "t",
    userId: "u_admin",
    deviceUuid: "dev_other_same_user",
  });
  await harness.handlers["automaticCash.status"]({}, {});
  assert.equal(harness.response.body.settlementAllowed, true);
  assert.equal(harness.response.body.cashFloat.cashFloatId, generated.cashFloatId);
  assert.equal(harness.response.body.cashFloat.totalCents, generated.totalCents);

  harness.db.posSettings.automaticCash.cashFloats[0].status = "ARCHIVED";
  harness.setPayload({
    token: "t",
    userId: "u_admin",
    deviceUuid: "dev_1",
    qrPayload: generated.qrPayload,
  });
  await assert.rejects(
    () => harness.handlers["automaticCash.loadCashFloatFromQr"]({}, {}),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "AUTOMATIC_CASH_QR_USED");
      assert.equal(error.message, "QR non valido");
      return true;
    },
  );
});

test("workflow fondo cassa puo essere preso da un admin e blocca altri admin concorrenti", async () => {
  const config = await readExampleConfig();
  const reserve = buildReserveConfig();
  const db = {
    meta: {},
    posSettings: {
      automaticCash: {
        enabled: true,
        gatewayConfigured: true,
        gatewayInventory: buildGatewayInventory(),
        configSets: [
          {
            id: "config-v1",
            name: "Config",
            currency: "EUR",
            combinationsCount: 15,
            minTotalCents: 12030,
            maxTotalCents: 17140,
            uniquePerUserPerBusinessEvening: true,
            config,
          },
        ],
        configSetId: "config-v1",
        reserveConfigs: [
          {
            id: "reserve-test-v1",
            name: "Riserva test",
            currency: "EUR",
            enabled: true,
            missingDenominationPolicy: "reject",
            denominationsCount: 11,
            minimumPiecesTotal: 9,
            denominazioni_centesimi: reserve.denominazioni_centesimi,
            riserva_minima_pezzi: reserve.riserva_minima_pezzi,
            config: reserve,
          },
        ],
        reserveConfigId: "reserve-test-v1",
      },
    },
  };
  const operatorHarness = createHarness({
    db,
    payload: {
      token: "t",
      userId: "u_cashier",
      deviceUuid: "dev_cashier",
      reason: "operator_cash_float",
    },
    user: {
      id: "u_cashier",
      username: "cashier",
      role: "cassiere",
      permissions: [],
    },
  });

  await operatorHarness.handlers["automaticCash.generateCashFloat"]({}, {});
  const generated = operatorHarness.response.body;
  assert.equal(generated.step, "WAITING_CASH_REMOVAL");
  assert.equal(
    operatorHarness.db.posSettings.automaticCash.workflows[0].operationLock
      .ownerCanManageAutomaticCash,
    false,
  );

  const adminPreflight = buildAutomaticCashPreflight(
    operatorHarness.db.posSettings.automaticCash,
    {
      userId: "u_manager_1",
      canManageAutomaticCash: true,
      nowMs: new Date("2026-06-26T10:00:00.000Z").getTime(),
    },
  );
  assert.equal(adminPreflight.activeWorkflow.resumableByCurrentUser, true);
  assert.equal(adminPreflight.activeWorkflow.resumableByManager, true);

  const firstAdminHarness = createHarness({
    db: operatorHarness.db,
    payload: {
      token: "t",
      userId: "u_manager_1",
      deviceUuid: "dev_manager_1",
      reason: "operator_cash_float",
      preferExistingAssignmentForEvening: true,
    },
    user: {
      id: "u_manager_1",
      username: "manager1",
      role: "admin",
      permissions: [],
    },
  });
  await firstAdminHarness.handlers["automaticCash.generateCashFloat"]({}, {});
  assert.equal(firstAdminHarness.response.body.resumed, true);
  assert.equal(
    firstAdminHarness.response.body.workflowId,
    generated.workflowId,
  );
  assert.equal(
    firstAdminHarness.db.posSettings.automaticCash.workflows[0].operationLock
      .ownerCanManageAutomaticCash,
    true,
  );
  assert.equal(
    firstAdminHarness.db.posSettings.automaticCash.workflows[0].operationLock
      .ownerUserId,
    "u_manager_1",
  );

  const secondAdminHarness = createHarness({
    db: firstAdminHarness.db,
    payload: {
      token: "t",
      userId: "u_manager_2",
      deviceUuid: "dev_manager_2",
      reason: "operator_cash_float",
      preferExistingAssignmentForEvening: true,
    },
    user: {
      id: "u_manager_2",
      username: "manager2",
      role: "admin",
      permissions: [],
    },
  });
  await assert.rejects(
    () =>
      secondAdminHarness.handlers["automaticCash.generateCashFloat"]({}, {}),
    (error) => {
      assert.equal(error.statusCode, 423);
      assert.equal(error.code, "AUTOMATIC_CASH_LOCKED");
      assert.equal(error.details.lock.ownerUserId, "u_manager_1");
      return true;
    },
  );
});

test("workflow fondo cassa usa il gateway reale quando configurato", async () => {
  const config = await readExampleConfig();
  const reserve = buildReserveConfig();
  const calls = [];
  const automaticCashGateway = {
    configured: true,
    async refreshInventory() {
      calls.push({ type: "refresh" });
      return buildGatewayInventory();
    },
    async getState() {
      calls.push({ type: "state" });
      return {
        ...buildGatewayInventory(),
        deposit: {
          cassettesMonitor: [
            { Value_Money: 1000, ReplenishmentStock: 1 },
            { Value_Money: 500, ReplenishmentStock: 2 },
          ],
        },
      };
    },
    async executeWithdrawal(payload) {
      calls.push({ type: "withdrawal", payload });
      return { ok: true };
    },
    async confirmWithdrawalRemoved() {
      calls.push({ type: "removed" });
      return { ok: true };
    },
    async startReplenishment() {
      calls.push({ type: "deposit-start" });
      return { ok: true };
    },
    async closeReplenishment() {
      calls.push({ type: "deposit-close" });
      return { payload: { ok: true }, state: null };
    },
    async cancelReplenishment() {
      calls.push({ type: "deposit-cancel" });
      return { ok: true };
    },
  };
  const db = {
    meta: {},
    posSettings: {
      automaticCash: {
        enabled: true,
        gatewayConfigured: false,
        configSets: [
          {
            id: "config-v1",
            name: "Config",
            currency: "EUR",
            combinationsCount: 15,
            minTotalCents: 12030,
            maxTotalCents: 17140,
            uniquePerUserPerBusinessEvening: true,
            config,
          },
        ],
        configSetId: "config-v1",
        reserveConfigs: [
          {
            id: "reserve-test-v1",
            name: "Riserva test",
            currency: "EUR",
            enabled: true,
            missingDenominationPolicy: "reject",
            denominationsCount: 11,
            minimumPiecesTotal: 9,
            denominazioni_centesimi: reserve.denominazioni_centesimi,
            riserva_minima_pezzi: reserve.riserva_minima_pezzi,
            config: reserve,
          },
        ],
        reserveConfigId: "reserve-test-v1",
      },
    },
  };
  const harness = createHarness({
    db,
    payload: {
      token: "t",
      userId: "u_admin",
      deviceUuid: "dev_1",
      reason: "operator_cash_float",
    },
    user: { id: "u_admin", username: "admin", role: "admin", permissions: [] },
    automaticCashGateway,
  });

  await harness.handlers["automaticCash.cashFloatPreflight"]({}, {});
  assert.equal(harness.response.body.canCreate, true);

  await harness.handlers["automaticCash.generateCashFloat"]({}, {});
  const generated = harness.response.body;
  const withdrawal = calls.find((entry) => entry.type === "withdrawal");
  assert.equal(generated.step, "WAITING_CASH_REMOVAL");
  assert.equal(Boolean(withdrawal), true);
  assert.equal(withdrawal.payload.note, `Fondo cassa ${generated.cashFloatId}`);
  assert.equal(
    Object.values(withdrawal.payload.pieces).every(
      (value) => Number.isInteger(value) && value > 0,
    ),
    true,
  );
  assert.deepEqual(
    harness.db.posSettings.automaticCash.workflows[0].gatewayPieces,
    withdrawal.payload.pieces,
  );

  harness.setPayload({
    token: "t",
    userId: "u_admin",
    deviceUuid: "dev_1",
    workflowId: generated.workflowId,
    operationId: generated.operationId,
    cashFloatId: generated.cashFloatId,
    loadAsActiveCashFloat: true,
  });
  await harness.handlers["automaticCash.confirmCashFloatRemoved"]({}, {});
  await harness.handlers["automaticCash.cashFloatTicketPrinted"]({}, {});
  await harness.handlers["automaticCash.confirmCashFloatTicketInPouch"]({}, {});

  harness.setPayload({
    token: "t",
    userId: "u_admin",
    deviceUuid: "dev_1",
    cashFloatId: generated.cashFloatId,
  });
  await harness.handlers["automaticCash.startDeposit"]({}, {});
  const depositOperationId = harness.response.body.operationId;
  harness.setPayload({
    token: "t",
    userId: "u_admin",
    deviceUuid: "dev_1",
    operationId: depositOperationId,
  });
  await harness.handlers["automaticCash.closeDeposit"]({}, {});

  assert.equal(harness.response.body.depositedTotalCents, 2_000);
  assert.deepEqual(
    calls.map((entry) => entry.type),
    [
      "refresh",
      "refresh",
      "withdrawal",
      "removed",
      "deposit-start",
      "state",
      "deposit-close",
    ],
  );
});

test("cash exchange orchestra deposito, selezione tagli ed erogazione via backend", async () => {
  const calls = [];
  const automaticCashGateway = {
    configured: true,
    async refreshInventory() {
      calls.push({ type: "refresh" });
      return buildGatewayInventory();
    },
    async getState() {
      calls.push({ type: "state" });
      return {
        ...buildGatewayInventory(),
        deposit: {
          cachedAt: new Date().toISOString(),
          raw: {
            Values: {
              deposit: "20",
              cassettesMonitor: [],
            },
          },
          deposit: "20",
          cassettesMonitor: [],
        },
        raw: {
          history: [
            {
              liveDeposit: {
                deposit: "10",
                updatedAt: "2026-06-29T01:49:57",
              },
              resultTransaction: {
                Give: [{ Value_Money: 1000, Stock: 1 }],
              },
            },
          ],
        },
      };
    },
    async startCashinChange(payload) {
      calls.push({ type: "start-cashin-change", payload });
      return { ok: true };
    },
    async getCashinDeposit(payload) {
      calls.push({ type: "get-deposit", payload });
      return { payload: { deposit: { deposit: "20" } }, state: null };
    },
    async getReturnChange(payload) {
      calls.push({ type: "return-change", payload });
      return {
        ok: true,
        availableDenominations: [
          { cents: 2000, availablePieces: 19, label: "20,00 EUR" },
          { cents: 1000, availablePieces: 20, label: "10,00 EUR" },
        ],
      };
    },
    async executeNativeChange(payload) {
      calls.push({ type: "change", payload });
      return { ok: true };
    },
    async getChangeRemoved(payload) {
      calls.push({ type: "change-removed", payload });
      return { ok: true };
    },
    async cancelCashinChange(payload) {
      calls.push({ type: "change-cancel", payload });
      return { ok: true };
    },
  };
  const harness = createHarness({
    db: {
      meta: {},
      posSettings: {
        automaticCash: {
          enabled: true,
          gatewayConfigured: false,
        },
      },
    },
    payload: {
      token: "t",
      userId: "u_admin",
      deviceUuid: "dev_1",
      activityId: "activity_1",
      roomId: "room_1",
    },
    user: { id: "u_admin", username: "admin", role: "admin", permissions: [] },
    automaticCashGateway,
  });

  await harness.handlers["automaticCash.startCashExchange"]({}, {});
  const exchangeId = harness.response.body.exchangeId;
  assert.equal(harness.response.status, 200);
  assert.equal(harness.response.body.status, "DEPOSITING");
  assert.equal(harness.db.posSettings.automaticCash.cashExchanges.length, 1);
  assert.equal(
    getActiveCashExchange(harness.db.posSettings.automaticCash).exchangeId,
    exchangeId,
  );

  harness.setPayload({ token: "t", userId: "u_admin", deviceUuid: "dev_1" });
  await harness.handlers["automaticCash.cashExchangeState"](
    { params: { exchangeId } },
    {},
  );
  assert.equal(harness.response.body.depositedCents, 2000);

  await harness.handlers["automaticCash.confirmCashExchangeDeposit"](
    { params: { exchangeId } },
    {},
  );
  assert.equal(harness.response.body.status, "SELECTING_DENOMINATIONS");
  assert.deepEqual(
    harness.response.body.allowedDenominationsCents,
    CASH_EXCHANGE_DENOMINATION_CENTS,
  );
  assert.deepEqual(harness.response.body.availableDenominations.slice(0, 2), [
    { cents: 2000, label: "20,00 EUR", availablePieces: 19, reservedPieces: 0 },
    { cents: 1000, label: "10,00 EUR", availablePieces: 20, reservedPieces: 0 },
  ]);

  harness.setPayload({
    token: "t",
    userId: "u_admin",
    deviceUuid: "dev_1",
    pieces: { 2000: 1 },
  });
  await harness.handlers["automaticCash.executeCashExchange"](
    { params: { exchangeId } },
    {},
  );
  assert.equal(harness.response.body.status, "WAITING_CHANGE_REMOVAL");
  const change = calls.find((entry) => entry.type === "change");
  assert.deepEqual(change.payload.pieces, { 2000: 1 });
  assert.equal(change.payload.note, `Cambio denaro ${exchangeId}`);
  assert.equal(change.payload.operationId, harness.response.body.operationId);
  assert.equal("confirm" in change.payload, false);

  await harness.handlers["automaticCash.confirmCashExchangeRemoved"](
    { params: { exchangeId } },
    {},
  );
  assert.equal(harness.response.body.status, "COMPLETED");
  const completedExchange =
    harness.db.posSettings.automaticCash.cashExchanges[0];
  assert.equal(completedExchange.status, "COMPLETED");
  const auditActions = completedExchange.auditEvents.map(
    (entry) => entry.action,
  );
  assert.deepEqual(auditActions, [
    "cash_exchange.created",
    "cash_exchange.change_started",
    "cash_exchange.deposit_poll",
    "cash_exchange.deposit_confirmed",
    "cash_exchange.denominations_selected",
    "cash_exchange.change_execute_requested",
    "cash_exchange.change_waiting_removal",
    "cash_exchange.change_removed_confirmed",
    "cash_exchange.completed",
  ]);
  assert.equal(
    completedExchange.auditEvents.find(
      (entry) => entry.action === "cash_exchange.deposit_poll",
    ).depositedCents,
    2000,
  );
  assert.deepEqual(
    completedExchange.auditEvents.find(
      (entry) => entry.action === "cash_exchange.denominations_selected",
    ).selectedPieces,
    { 2000: 1 },
  );
  assert.equal(
    completedExchange.auditEvents.find(
      (entry) => entry.action === "cash_exchange.change_waiting_removal",
    ).snapshot.gatewayResponse.ok,
    true,
  );
  assert.equal(
    getActiveCashExchange(harness.db.posSettings.automaticCash),
    null,
  );

  await harness.handlers["automaticCash.activeCashExchange"]({}, {});
  assert.equal(harness.response.body.activeExchange, null);
  assert.deepEqual(
    calls.map((entry) => entry.type),
    [
      "refresh",
      "start-cashin-change",
      "get-deposit",
      "get-deposit",
      "return-change",
      "refresh",
      "change",
      "change-removed",
    ],
  );
  const serializedCalls = JSON.stringify(calls);
  assert.equal(serializedCalls.includes("withdrawal"), false);
  assert.equal(serializedCalls.includes("replenishment"), false);
  assert.equal(serializedCalls.includes("PRELEVA_REALE"), false);
});

test("cash exchange usa deposito legacy se il gateway non espone cashin", async () => {
  const calls = [];
  const automaticCashGateway = {
    configured: true,
    async refreshInventory() {
      calls.push({ type: "refresh" });
      return buildGatewayInventory();
    },
    async startCashinChange(payload) {
      calls.push({ type: "start-cashin-change", payload });
      const error = new Error("Endpoint non trovato: /api/cashin/start");
      error.status = 404;
      error.body = { error: "Endpoint non trovato: /api/cashin/start" };
      throw error;
    },
    async startReplenishment() {
      calls.push({ type: "replenishment-start" });
      return { ok: true };
    },
    async getState() {
      calls.push({ type: "state" });
      return {
        ...buildGatewayInventory(),
        deposit: {
          cachedAt: new Date().toISOString(),
          raw: {
            Values: {
              deposit: "20",
              cassettesMonitor: [],
            },
          },
          deposit: "20",
          cassettesMonitor: [],
        },
      };
    },
    async closeReplenishment() {
      calls.push({ type: "close-replenishment" });
      return {
        payload: { deposit: { deposit: "20" } },
        state: {
          ...buildGatewayInventory(),
          deposit: {
            cachedAt: new Date().toISOString(),
            deposit: "20",
          },
        },
      };
    },
    async executeWithdrawal(payload) {
      calls.push({ type: "withdrawal", payload });
      return { ok: true };
    },
    async confirmWithdrawalRemoved() {
      calls.push({ type: "removed" });
      return { ok: true };
    },
  };
  const harness = createHarness({
    db: {
      meta: {},
      posSettings: {
        automaticCash: {
          enabled: true,
          gatewayConfigured: false,
        },
      },
    },
    payload: {
      token: "t",
      userId: "u_admin",
      deviceUuid: "dev_1",
      activityId: "activity_1",
      roomId: "room_1",
    },
    user: { id: "u_admin", username: "admin", role: "admin", permissions: [] },
    automaticCashGateway,
  });

  await harness.handlers["automaticCash.startCashExchange"]({}, {});
  const exchangeId = harness.response.body.exchangeId;
  assert.equal(harness.response.status, 200);
  assert.equal(harness.response.body.status, "DEPOSIT_STARTED");

  harness.setPayload({ token: "t", userId: "u_admin", deviceUuid: "dev_1" });
  await harness.handlers["automaticCash.cashExchangeState"](
    { params: { exchangeId } },
    {},
  );
  assert.equal(harness.response.body.depositedCents, 2000);

  await harness.handlers["automaticCash.confirmCashExchangeDeposit"](
    { params: { exchangeId } },
    {},
  );
  assert.equal(harness.response.body.status, "SELECTING_DENOMINATIONS");
  assert.equal(harness.response.body.depositedCents, 2000);

  harness.setPayload({
    token: "t",
    userId: "u_admin",
    deviceUuid: "dev_1",
    pieces: { 2000: 1 },
  });
  await harness.handlers["automaticCash.executeCashExchange"](
    { params: { exchangeId } },
    {},
  );
  assert.equal(harness.response.body.status, "WAITING_CASH_REMOVAL");
  const withdrawal = calls.find((entry) => entry.type === "withdrawal");
  assert.deepEqual(withdrawal.payload.pieces, { 2000: 1 });
  assert.equal(withdrawal.payload.note, `Cambio denaro ${exchangeId}`);

  await harness.handlers["automaticCash.confirmCashExchangeRemoved"](
    { params: { exchangeId } },
    {},
  );
  assert.equal(harness.response.body.status, "COMPLETED");
  const completedExchange =
    harness.db.posSettings.automaticCash.cashExchanges[0];
  assert.deepEqual(
    completedExchange.auditEvents.map((entry) => entry.action),
    [
      "cash_exchange.created",
      "cash_exchange.deposit_started",
      "cash_exchange.deposit_poll",
      "cash_exchange.deposit_confirmed",
      "cash_exchange.denominations_selected",
      "cash_exchange.withdrawal_execute_requested",
      "cash_exchange.withdrawal_started",
      "cash_exchange.cash_removed_confirmed",
      "cash_exchange.completed",
    ],
  );
  assert.equal(
    completedExchange.auditEvents.find(
      (entry) => entry.action === "cash_exchange.deposit_poll",
    ).depositedCents,
    2000,
  );
  assert.deepEqual(
    calls.map((entry) => entry.type),
    [
      "refresh",
      "start-cashin-change",
      "replenishment-start",
      "state",
      "close-replenishment",
      "refresh",
      "withdrawal",
      "removed",
    ],
  );
});

test("gateway cancel deposito e idempotente se l'operazione reale e gia chiusa", async () => {
  const calls = [];
  const gateway = createAutomaticCashGatewayClient({
    enabled: true,
    baseUrl: "http://gateway.test",
    username: "amalia",
    password: "182018",
    fetchWithTimeout: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method ?? "GET" });
      if (String(url).endsWith("/api/login")) {
        return new Response(JSON.stringify({ token: "session-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (String(url).endsWith("/api/replenishment/cancel")) {
        return new Response(
          JSON.stringify({ error: "Nessuna operazione reale attiva" }),
          {
            status: 409,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const result = await gateway.cancelReplenishment();
  assert.equal(result.ok, true);
  assert.equal(result.alreadyClosed, true);
  assert.deepEqual(
    calls.map((entry) => entry.url.replace("http://gateway.test", "")),
    ["/api/login", "/api/replenishment/cancel"],
  );
});

test("gateway invia Content-Length zero sui POST senza body", async () => {
  const calls = [];
  const gateway = createAutomaticCashGatewayClient({
    enabled: true,
    baseUrl: "http://gateway.test",
    username: "amalia",
    password: "182018",
    fetchWithTimeout: async (url, options = {}) => {
      calls.push({
        url: String(url),
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      });
      if (String(url).endsWith("/api/login")) {
        return new Response(JSON.stringify({ token: "session-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (String(url).endsWith("/api/state")) {
        return new Response(JSON.stringify(buildGatewayInventory()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const state = await gateway.refreshInventory();

  assert.equal(state.ok, true);
  const refreshCall = calls.find((entry) =>
    entry.url.endsWith("/api/inventory/refresh"),
  );
  assert.equal(refreshCall?.method, "POST");
  assert.equal(refreshCall?.headers["Content-Length"], "0");
  assert.equal(refreshCall?.headers["X-Session-Token"], "session-token");
});

test("gateway riavvio e reset macchina usano gli endpoint macchina con fallback", async () => {
  const calls = [];
  const gateway = createAutomaticCashGatewayClient({
    enabled: true,
    baseUrl: "http://gateway.test",
    username: "amalia",
    password: "182018",
    fetchWithTimeout: async (url, options = {}) => {
      const body = options.body ? JSON.parse(String(options.body)) : null;
      calls.push({ url: String(url), method: options.method ?? "GET", body });
      if (String(url).endsWith("/api/login")) {
        return new Response(JSON.stringify({ token: "session-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (String(url).endsWith("/api/machine/restart")) {
        return new Response(
          JSON.stringify({ error: "Endpoint non trovato: /api/machine/restart" }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await gateway.restartMachine({ reason: "test", requestedBy: "Admin Test" });
  await gateway.resetMachine({ reason: "test", requestedBy: "Admin Test" });

  assert.deepEqual(
    calls.map((entry) => entry.url.replace("http://gateway.test", "")),
    [
      "/api/login",
      "/api/machine/restart",
      "/api/machine/reboot",
      "/api/machine/reset",
    ],
  );
  assert.equal(calls[1].body.source, "cassa-v4");
  assert.equal(calls[1].body.requestedBy, "Admin Test");
  assert.equal(calls[3].body.reason, "test");
});

test("gateway cambio nativo usa StartCashin Cambio, Change e GetChangeRemoved", async () => {
  const calls = [];
  const gateway = createAutomaticCashGatewayClient({
    enabled: true,
    baseUrl: "http://gateway.test",
    username: "amalia",
    password: "182018",
    fetchWithTimeout: async (url, options = {}) => {
      const body = options.body ? JSON.parse(String(options.body)) : null;
      calls.push({ url: String(url), method: options.method ?? "GET", body });
      if (String(url).endsWith("/api/login")) {
        return new Response(JSON.stringify({ token: "session-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (String(url).includes("/api/cashin/deposit")) {
        return new Response(JSON.stringify({ depositedTotalCents: 2000 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (String(url).endsWith("/api/state")) {
        return new Response(JSON.stringify(buildGatewayInventory()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (String(url).endsWith("/api/change/return-change")) {
        return new Response(
          JSON.stringify({
            availableDenominations: [
              { cents: 2000, availablePieces: 2, label: "20,00 EUR" },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await gateway.startCashinChange({ operationId: "op_change_1", userId: "u1" });
  await gateway.getCashinDeposit({ operationId: "op_change_1" });
  const returnChange = await gateway.getReturnChange({
    operationId: "op_change_1",
    totalToChangeCents: 2000,
  });
  await gateway.executeNativeChange({
    operationId: "op_change_1",
    pieces: { 2000: 1 },
  });
  await gateway.getChangeRemoved({ operationId: "op_change_1" });

  assert.deepEqual(returnChange.availableDenominations, [
    { cents: 2000, availablePieces: 2, label: "20,00 EUR" },
  ]);
  assert.deepEqual(
    calls.map((entry) => entry.url.replace("http://gateway.test", "")),
    [
      "/api/login",
      "/api/cashin/start",
      "/api/cashin/deposit?operationId=op_change_1",
      "/api/state",
      "/api/change/return-change",
      "/api/change/execute",
      "/api/change/removed",
    ],
  );
  assert.equal(calls[1].body.typeOperation, "Cambio");
  assert.deepEqual(calls[5].body.listCassette, [
    { Value_Money: 2000, Stock: 1 },
  ]);
  const serializedCalls = JSON.stringify(calls);
  assert.equal(serializedCalls.includes("/api/withdrawal/execute"), false);
  assert.equal(serializedCalls.includes("/api/replenishment/start"), false);
  assert.equal(serializedCalls.includes("PRELEVA_REALE"), false);
});

test("gateway pagamento contanti invia importo dovuto, inserito e resto in centesimi", async () => {
  const calls = [];
  const gateway = createAutomaticCashGatewayClient({
    enabled: true,
    baseUrl: "http://gateway.test",
    username: "amalia",
    password: "182018",
    fetchWithTimeout: async (url, options = {}) => {
      const body = options.body ? JSON.parse(String(options.body)) : null;
      calls.push({ url: String(url), method: options.method ?? "GET", body });
      if (String(url).endsWith("/api/login")) {
        return new Response(JSON.stringify({ token: "session-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await gateway.startCashinPayment({
    operationId: "op_pay_1",
    userId: "u1",
    note: "Banco test",
    expectedTotalCents: 1500,
  });
  await gateway.completeCashinPayment({
    operationId: "op_pay_1",
    expectedTotalCents: 1500,
    depositedTotalCents: 2000,
    changeDueCents: 500,
  });

  assert.deepEqual(
    calls.map((entry) => entry.url.replace("http://gateway.test", "")),
    ["/api/login", "/api/cashin/start", "/api/cashin/complete"],
  );
  assert.equal(calls[1].body.typeOperation, "Pagamento");
  assert.equal(calls[1].body.operationKind, "payment");
  assert.equal(calls[1].body.expectedTotalCents, 1500);
  assert.equal(calls[1].body.TotalToPay, 1500);
  assert.equal(calls[2].body.typeOperation, "Pagamento");
  assert.equal(calls[2].body.depositedTotalCents, 2000);
  assert.equal(calls[2].body.TotalInserted, 2000);
  assert.equal(calls[2].body.changeDueCents, 500);
  assert.equal(calls[2].body.ChangeDue, 500);
});

test("cash exchange recupera ritiro da stato WITHDRAWAL_STARTED", async () => {
  const calls = [];
  const automaticCashGateway = {
    configured: true,
    async confirmWithdrawalRemoved() {
      calls.push({ type: "removed" });
      return { ok: true };
    },
  };
  const nowMs = new Date("2026-06-26T10:00:00.000Z").getTime();
  const harness = createHarness({
    db: {
      meta: {},
      posSettings: {
        automaticCash: {
          enabled: true,
          cashExchanges: [
            {
              exchangeId: "exch_recover_1",
              operationId: "op_recover_1",
              ownerUserId: "u_admin",
              ownerFullName: "Admin",
              ownerDeviceUuid: "dev_1",
              status: "WITHDRAWAL_STARTED",
              depositedCents: 2000,
              selectedPieces: { 2000: 1 },
              operationLock: {
                ownerUserId: "u_admin",
                ownerDeviceUuid: "dev_1",
                expiresAtMs: nowMs + 60_000,
              },
              startedAtMs: nowMs - 10_000,
              updatedAtMs: nowMs - 1_000,
              auditEvents: [
                {
                  action: "cash_exchange.withdrawal_execute_requested",
                  atMs: nowMs - 1_000,
                },
              ],
            },
          ],
        },
      },
    },
    payload: {
      token: "t",
      userId: "u_admin",
      deviceUuid: "dev_1",
    },
    user: { id: "u_admin", username: "admin", role: "admin", permissions: [] },
    automaticCashGateway,
  });

  await harness.handlers["automaticCash.confirmCashExchangeRemoved"](
    { params: { exchangeId: "exch_recover_1" } },
    {},
  );

  assert.equal(harness.response.status, 200);
  assert.equal(harness.response.body.status, "COMPLETED");
  const completedExchange =
    harness.db.posSettings.automaticCash.cashExchanges[0];
  assert.equal(completedExchange.status, "COMPLETED");
  assert.deepEqual(
    completedExchange.auditEvents.map((entry) => entry.action),
    [
      "cash_exchange.withdrawal_execute_requested",
      "cash_exchange.withdrawal_started",
      "cash_exchange.cash_removed_confirmed",
      "cash_exchange.completed",
    ],
  );
  assert.equal(
    completedExchange.auditEvents.find(
      (entry) => entry.action === "cash_exchange.withdrawal_started",
    ).snapshot.recoveredFrom,
    "WITHDRAWAL_STARTED",
  );
  assert.deepEqual(calls, [{ type: "removed" }]);
});

test("cash exchange rispetta la riserva minima prima dell'erogazione", async () => {
  const calls = [];
  const { reserveConfig } = createAutomaticCashReserveConfigSet({
    config: buildReserveConfig(),
    uploadedAt: "2026-06-26T10:00:00.000Z",
    uploadedBy: "admin",
  });
  assert.ok(reserveConfig);
  const automaticCashGateway = {
    configured: true,
    async refreshInventory() {
      calls.push({ type: "refresh" });
      return {
        ok: true,
        inventory: {
          ok: true,
          listCassette: [
            { Value_Money: 2000, Stock: 1, IsExist: true, IsEmpty: false },
          ],
        },
        activeOperation: null,
        updatedAtMs: 1782468000000,
      };
    },
    async getState() {
      calls.push({ type: "state" });
      return {
        deposit: {
          depositedTotalCents: 2000,
        },
      };
    },
    async startCashinChange(payload) {
      calls.push({ type: "start-cashin-change", payload });
      return { ok: true };
    },
    async getCashinDeposit(payload) {
      calls.push({ type: "get-deposit", payload });
      return { payload: { depositedTotalCents: 2000 }, state: null };
    },
    async getReturnChange(payload) {
      calls.push({ type: "return-change", payload });
      return {
        ok: true,
        availableDenominations: [
          { cents: 2000, availablePieces: 1, label: "20,00 EUR" },
        ],
      };
    },
    async executeNativeChange(payload) {
      calls.push({ type: "change", payload });
      return { ok: true };
    },
    async getChangeRemoved(payload) {
      calls.push({ type: "change-removed", payload });
      return { ok: true };
    },
    async cancelCashinChange(payload) {
      calls.push({ type: "change-cancel", payload });
      return { ok: true };
    },
  };
  const harness = createHarness({
    db: {
      meta: {},
      posSettings: {
        automaticCash: {
          enabled: true,
          gatewayConfigured: false,
          reserveConfigId: reserveConfig.id,
          reserveConfig,
          reserveConfigs: [reserveConfig],
        },
      },
    },
    payload: {
      token: "t",
      userId: "u_admin",
      deviceUuid: "dev_1",
    },
    user: { id: "u_admin", username: "admin", role: "admin", permissions: [] },
    automaticCashGateway,
  });

  await harness.handlers["automaticCash.startCashExchange"]({}, {});
  const exchangeId = harness.response.body.exchangeId;

  await harness.handlers["automaticCash.confirmCashExchangeDeposit"](
    { params: { exchangeId } },
    {},
  );
  assert.equal(harness.response.body.status, "SELECTING_DENOMINATIONS");

  harness.setPayload({
    token: "t",
    userId: "u_admin",
    deviceUuid: "dev_1",
    pieces: { 2000: 1 },
  });
  await assert.rejects(
    () =>
      harness.handlers["automaticCash.executeCashExchange"](
        { params: { exchangeId } },
        {},
      ),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "CASH_EXCHANGE_INVENTORY_INSUFFICIENT");
      assert.equal(error.details.denominationCents, 2000);
      assert.equal(error.details.availablePieces, 1);
      assert.equal(error.details.minimumReservePieces, 1);
      assert.equal(error.details.remainingPieces, 0);
      return true;
    },
  );
  assert.equal(
    calls.some((entry) => entry.type === "change"),
    false,
  );
});

test("scarico automatico salva in DB il dettaglio di quadratura", async () => {
  const harness = createHarness({
    db: {
      meta: {},
      posSettings: {
        automaticCash: {
          enabled: true,
          warningThresholdCents: 100,
          dangerThresholdCents: 600,
          settlementRecords: [],
        },
      },
    },
    payload: {
      token: "t",
      userId: "u_admin",
      deviceUuid: "dev_1",
      id: "FCA-1:1782468000000",
      operationId: "dep_1",
      cashFloatId: "FCA-1",
      assignmentId: "ASN-1",
      combinationId: "COMBO-1",
      businessEveningKey: "2026-06-26",
      operatorName: "Admin",
      station: "postazione-1",
      roomId: "room-main",
      roomName: "Sala",
      expectedDepositTotalCents: 18_450,
      depositedTotalCents: 17_900,
      differenceCents: 550,
      feedbackKind: "happy",
      printText: "SCARICO CASSA\nDETTAGLIO",
      details: {
        snapshot: {
          cashTotal: 42.3,
          amountToDeposit: 184.5,
        },
      },
      completedAtMs: 1_782_468_000_000,
    },
    user: { id: "u_admin", username: "admin", role: "admin", permissions: [] },
  });

  await harness.handlers["automaticCash.saveSettlementRecord"]({}, {});

  assert.equal(harness.response.status, 200);
  assert.equal(
    harness.db.posSettings.automaticCash.settlementRecords.length,
    1,
  );
  assert.equal(
    harness.db.posSettings.automaticCash.settlementRecords[0].differenceCents,
    550,
  );
  assert.equal(
    harness.db.posSettings.automaticCash.settlementRecords[0].details.snapshot
      .amountToDeposit,
    184.5,
  );

  await harness.handlers["automaticCash.latestSettlementRecord"]({}, {});
  assert.equal(harness.response.body.record.id, "FCA-1:1782468000000");
  assert.equal(harness.response.body.record.feedbackKind, "sad");
});
