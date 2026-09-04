import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { V6_BATTERY_NOTIFICATION_INTERVAL_MS } from "./v6-operations-gates.mjs";
import { V6_MOBILE_OPERATION_TYPES } from "./v6-operations-scheduler.mjs";
import {
  B4_WEB_WORKLOAD_ACTIONS_PER_DEVICE,
  B4_WEB_WORKLOAD_ORDERS_PER_DEVICE,
  B4_WEB_WORKLOAD_PAGE_COUNT,
  B4_WEB_WORKLOAD_TOTAL_ACTIONS,
  B4_WEB_WORKLOAD_TOTAL_ORDERS,
  B4WebWorkloadError,
  buildB4WebWorkloadEnvelope,
  buildB4WebWorkloadPlan,
  buildB4WebWorkloadReport,
  buildB4WebWorkloadRequest,
  buildB4WebWorkloadResult,
  runB4WebWorkload,
  validateB4WebMutationResponse,
  validateB4WebWorkloadEnvelope,
  validateB4WebWorkloadReport,
  validateB4WebWorkloadRequest,
  validateB4WebWorkloadResult,
} from "./v6-b4-web-workload.mjs";

const REQUEST_NONCE = "request_nonce_1234567890ABC";
const ENVELOPE_NONCE = "envelope_nonce_123456789ABC";

function requestAndEnvelope(suffix = "") {
  const request = buildB4WebWorkloadRequest({
    requestNonce: `${REQUEST_NONCE}${suffix}`,
    requestedAt: "2026-08-10T08:00:00.000Z",
  });
  const envelope = buildB4WebWorkloadEnvelope(request, {
    envelopeNonce: `${ENVELOPE_NONCE}${suffix}`,
    createdAt: "2026-08-10T08:00:01.000Z",
  });
  return { request, envelope };
}

function passingMetrics() {
  return {
    completedActions: 160,
    successfulActions: 160,
    failedActions: 0,
    completedOrders: 64,
    maximumInFlightPerPalmare: 1,
    maximumInFlightGlobal: 8,
    plannedOperationTypes: 35,
    domScenarioTypes: 10,
    actionsOriginatedFromDom: 160,
    domExecutorBuiltIn: true,
    internalErrors: 0,
    pendingRequestsAtEnd: 0,
    quiescenceAchieved: true,
    pageErrors: 0,
    consoleErrors: 0,
    httpFailures: 0,
    requestFailures: 0,
    actionAverageGapMs: 3_000,
    commandAverageGapMs: 7_285.714,
    actionLatencyP95Ms: 25,
    commandLatencyP95Ms: 40,
    actionCadenceOk: true,
    commandCadenceOk: true,
    contexts: 8,
    pages: 8,
    sessions: 8,
    storageIsolated: true,
    contextOwnershipVerified: true,
    sessionPreserved: true,
    mobileViewportMatched: true,
    touchEnabled: true,
    resourcesAfterCleanup: 0,
    ledgerUnchanged: true,
  };
}

function fakePages() {
  const browser = { engine: "chromium" };
  return Array.from({ length: B4_WEB_WORKLOAD_PAGE_COUNT }, (_, index) => {
    const listeners = new Map();
    const identity = {
      token: `private-session-${index}`,
      userId: `private-user-${index}`,
      deviceUuid: `private-device-${index}`,
    };
    let page;
    const context = {
      browser: () => browser,
      pages: () => [page],
      slot: index,
    };
    page = {
      workloadIndex: index,
      context: () => context,
      evaluate: async (callback) =>
        String(callback).includes("maxTouchPoints") ? true : { ...identity },
      isClosed: () => false,
      emit(event, value) {
        for (const listener of listeners.get(event) ?? []) listener(value);
      },
      listeners: (event) => [...(listeners.get(event) ?? [])],
      off(event, listener) {
        listeners.get(event)?.delete(listener);
      },
      on(event, listener) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(listener);
      },
      screenshot: async () => Buffer.from(`png-${index}`),
      viewportSize: () => ({ width: 390, height: 844 }),
    };
    return page;
  });
}

function clone(value) {
  return structuredClone(value);
}

function fakeMutationResponse({ pathname, payload, body, status = 200 }) {
  const request = {
    method: () => "POST",
    postData: () => JSON.stringify(payload),
    postDataJSON: () => payload,
    url: () => `http://127.0.0.1${pathname}`,
  };
  return {
    json: async () => body,
    request: () => request,
    status: () => status,
  };
}

test("il piano copre 8 Palmare, 160 azioni, 64 ordini e tutti i 35 tipi", () => {
  const plan = buildB4WebWorkloadPlan();
  assert.equal(B4_WEB_WORKLOAD_PAGE_COUNT, 8);
  assert.equal(B4_WEB_WORKLOAD_ACTIONS_PER_DEVICE, 20);
  assert.equal(B4_WEB_WORKLOAD_ORDERS_PER_DEVICE, 8);
  assert.equal(B4_WEB_WORKLOAD_TOTAL_ACTIONS, 160);
  assert.equal(B4_WEB_WORKLOAD_TOTAL_ORDERS, 64);
  assert.equal(plan.length, 8);
  assert.deepEqual(
    plan.map((entry) => entry.logicalSlot),
    [3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.deepEqual(
    plan.flatMap((entry) => [entry.primaryTableNumber, entry.alternateTableNumber]),
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
  assert.equal(plan.every((entry) => entry.actions.length === 20), true);

  const actions = plan.flatMap((entry) => entry.actions);
  const orderActions = actions.filter((action) => action.operationType === "order.create");
  assert.equal(actions.length, 160);
  assert.equal(orderActions.length, 64);
  assert.equal(new Set(actions.map((action) => action.operationType)).size, 35);
  assert.equal(
    new Set(actions.map((action) => action.operationType)).size,
    V6_MOBILE_OPERATION_TYPES.length + 1,
  );
  assert.equal(new Set(actions.map((action) => action.scenario)).size, 10);
  for (const entry of plan) {
    assert.deepEqual(
      entry.actions
        .filter((action) => action.operationType === "order.create")
        .map((action) => action.ordinal),
      [1, 3, 6, 8, 11, 13, 16, 18],
    );
  }
});

test("request, envelope e result sono legati e non scambiabili", () => {
  const { request, envelope } = requestAndEnvelope();
  assert.deepEqual(validateB4WebWorkloadRequest(request), request);
  assert.deepEqual(validateB4WebWorkloadEnvelope(envelope, request), envelope);

  const report = buildB4WebWorkloadReport(passingMetrics());
  const result = buildB4WebWorkloadResult({ request, envelope, report });
  assert.deepEqual(validateB4WebWorkloadResult(result, { request, envelope }), result);

  const other = requestAndEnvelope("_different");
  assert.throws(
    () => validateB4WebWorkloadEnvelope(envelope, other.request),
    (error) => error instanceof B4WebWorkloadError && error.code === "WORKLOAD_ENVELOPE_INVALID",
  );
  assert.throws(
    () => validateB4WebWorkloadResult(result, other),
    (error) => error instanceof B4WebWorkloadError,
  );

  assert.match(result.requestCommitmentSha256, /^[a-f0-9]{64}$/u);
  assert.match(result.envelopeCommitmentSha256, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(result.report).includes(result.requestCommitmentSha256), false);
  assert.equal(JSON.stringify(result.report).includes(result.envelopeCommitmentSha256), false);
});

test("il report resta NON_GATE, non promuove gate e non dichiara batteria osservata", () => {
  const report = buildB4WebWorkloadReport(passingMetrics());
  assert.equal(report.verdict, "NON_GATE_PASS");
  assert.equal(report.evidenceClass, "NON_GATE_EVIDENCE");
  assert.equal(report.gateImpact, "NONE");
  assert.equal(report.profile.batteryIntervalConfiguredMs, 120_000);
  assert.equal(
    report.profile.batteryIntervalConfiguredMs,
    V6_BATTERY_NOTIFICATION_INTERVAL_MS,
  );
  assert.equal(report.profile.batteryNotificationsObserved, 0);
  assert.equal(report.profile.batteryObservationClaimed, false);
  assert.equal(report.gates.b4TenPhysicalDeviceGate, "PENDING");
  assert.equal(report.gates.b5HundredSessionGate, "PENDING");
  assert.equal(report.gates.b6AndroidPairGate, "BLOCKED");
  assert.equal(report.gates.simulatedDevicesCountedTowardGate, 0);
  assert.equal(report.gates.officialSessionsRecorded, 0);
  assert.equal(report.effects.gatePromoted, false);
  assert.equal(report.browserIsolation.hardwareAccessed, false);

  const promoted = clone(report);
  promoted.gates.b4TenPhysicalDeviceGate = "PASS";
  assert.throws(() => validateB4WebWorkloadReport(promoted), B4WebWorkloadError);
  const hardwareClaim = clone(report);
  hardwareClaim.browserIsolation.hardwareAccessed = true;
  assert.throws(() => validateB4WebWorkloadReport(hardwareClaim), B4WebWorkloadError);
  const acceleratedBattery = clone(report);
  acceleratedBattery.profile.batteryIntervalConfiguredMs = 30_000;
  assert.throws(() => validateB4WebWorkloadReport(acceleratedBattery), B4WebWorkloadError);
  const observedBattery = clone(report);
  observedBattery.profile.batteryObservationClaimed = true;
  assert.throws(() => validateB4WebWorkloadReport(observedBattery), B4WebWorkloadError);
});

test("il report pubblico non contiene binding o identificatori privati", () => {
  const reportText = JSON.stringify(buildB4WebWorkloadReport(passingMetrics()));
  for (const forbidden of [
    "requestNonce",
    "envelopeNonce",
    "CommitmentSha256",
    "private-session",
    "private-user",
    "private-device",
    "pos_token",
    "127.0.0.1",
    "http://",
    "ws://",
    "/home/",
  ]) {
    assert.equal(reportText.includes(forbidden), false, forbidden);
  }
});

test("le invarianti esatte impediscono PASS con DOM, slot, in-flight o cleanup falsi", () => {
  for (const patch of [
    { actionsOriginatedFromDom: 0 },
    { domExecutorBuiltIn: false, actionsOriginatedFromDom: 0 },
    { maximumInFlightGlobal: 0 },
    { maximumInFlightPerPalmare: 0 },
    { internalErrors: 1 },
    { pendingRequestsAtEnd: 1, quiescenceAchieved: false },
    { resourcesAfterCleanup: 1 },
    { contextOwnershipVerified: false },
  ]) {
    assert.equal(
      buildB4WebWorkloadReport({ ...passingMetrics(), ...patch }).verdict,
      "NON_GATE_FAIL",
      JSON.stringify(patch),
    );
  }

  const shortSlots = clone(buildB4WebWorkloadReport(passingMetrics()));
  shortSlots.browserIsolation.slots = [3];
  assert.throws(() => validateB4WebWorkloadReport(shortSlots), B4WebWorkloadError);
  const falseEffect = clone(buildB4WebWorkloadReport(passingMetrics()));
  falseEffect.effects.isolatedRuntimeStateWritten = false;
  assert.throws(() => validateB4WebWorkloadReport(falseEffect), B4WebWorkloadError);
});

test("le risposte order, move, correction e reso devono correlare request e body", async () => {
  const order = await validateB4WebMutationResponse(
    fakeMutationResponse({
      pathname: "/api/integration/orders/create",
      payload: { tableId: "table-1", lines: [{ productId: "caffe", quantity: 1 }] },
      body: {
        ok: true,
        order: { id: "order-1", tableId: "table-1", items: [{ lineId: "line-1" }] },
      },
    }),
    { kind: "ORDER_CREATE", expectedTableId: "table-1" },
  );
  assert.equal(order.orderId, "order-1");
  assert.deepEqual(order.lineIds, ["line-1"]);

  const move = await validateB4WebMutationResponse(
    fakeMutationResponse({
      pathname: "/api/integration/layout/table/move",
      payload: { fromTableId: "table-1", toTableId: "table-2" },
      body: {
        ok: true,
        fromTable: { id: "table-1" },
        toTable: { id: "table-2" },
      },
    }),
    { kind: "TABLE_MOVE", expectedTableId: "table-1" },
  );
  assert.equal(move.toTableId, "table-2");

  await validateB4WebMutationResponse(
    fakeMutationResponse({
      pathname: "/api/integration/orders/correct",
      payload: {
        orderId: "order-1",
        tableId: "table-2",
        changedItems: [{ lineId: "line-1", nextQuantity: 2 }],
      },
      body: {
        ok: true,
        order: { id: "order-1", tableId: "table-2", items: [{ lineId: "line-1" }] },
      },
    }),
    { kind: "ORDER_CORRECT", expectedOrderId: "order-1", expectedTableId: "table-2" },
  );

  await validateB4WebMutationResponse(
    fakeMutationResponse({
      pathname: "/api/integration/orders/correct",
      payload: {
        orderId: "order-1",
        tableId: "table-2",
        recoveryMode: "return_without_replacement",
        removedItems: [{ lineId: "line-1", quantity: 1 }],
      },
      body: {
        ok: true,
        order: { id: "order-1", tableId: "table-2", items: [{ lineId: "line-1" }] },
      },
    }),
    { kind: "ORDER_RESO", expectedOrderId: "order-1", expectedTableId: "table-2" },
  );

  await assert.rejects(
    validateB4WebMutationResponse(
      fakeMutationResponse({
        pathname: "/api/integration/orders/create",
        payload: { tableId: "table-1", lines: [{}] },
        body: {
          ok: true,
          order: { id: "order-1", tableId: "table-other", items: [{ lineId: "line-1" }] },
        },
      }),
      { kind: "ORDER_CREATE", expectedTableId: "table-1" },
    ),
    (error) =>
      error instanceof B4WebWorkloadError && error.code === "DOM_MUTATION_CORRELATION_INVALID",
  );
  await assert.rejects(
    validateB4WebMutationResponse(
      fakeMutationResponse({
        pathname: "/api/integration/layout/table/move",
        payload: { fromTableId: "table-1", toTableId: "table-2" },
        body: { ok: true, fromTable: { id: "table-1" }, toTable: { id: "table-3" } },
      }),
      { kind: "TABLE_MOVE", expectedTableId: "table-1" },
    ),
    B4WebWorkloadError,
  );
  await assert.rejects(
    validateB4WebMutationResponse(
      fakeMutationResponse({
        pathname: "/api/integration/orders/storno",
        payload: {
          orderId: "order-1",
          tableId: "table-2",
          originalLineId: "line-1",
          quantity: 1,
        },
        body: { ok: false, order: { id: "order-1" } },
      }),
      { kind: "ORDER_RESO", expectedOrderId: "order-1", expectedTableId: "table-2" },
    ),
    B4WebWorkloadError,
  );
});

test("il contratto DOM recupera overlay e richiede linee canoniche dopo refresh", async () => {
  const source = await fs.readFile(new URL("./v6-b4-web-workload.mjs", import.meta.url), "utf8");
  assert.match(source, /async function recoverDomOverlays\(page\)/u);
  assert.match(source, /name: "Conferma spostamento tavolo"/u);
  assert.match(source, /name: "Sposta tavolo"/u);
  assert.match(source, /getByRole\("alertdialog"\)/u);
  assert.match(source, /await recoverDomOverlays\(page\);[\s\S]*?catch \(error\)/u);
  assert.match(source, /page\.reload\(\{ waitUntil: "domcontentloaded"/u);
  assert.match(source, /expectedLineIds\.some\(\(lineId\) => lineIds\.includes\(lineId\)\)/u);
  assert.match(source, /mode !== "BANCO"[\s\S]*?switchTablesWorkspaceMode\(page, "TAVOLI"\)/u);
  assert.match(source, /switchTablesWorkspaceMode\(page, "BANCO"\)[\s\S]*?switchTablesWorkspaceMode\(page, "TAVOLI"\)/u);
  assert.match(source, /row\.locator\("\.table-history-copy"\)\.first\(\)/u);
  assert.match(
    source,
    /locator\("button\.msr-choice-card"\)[\s\S]*?filter\(\{ hasText: "Modifica comanda" \}\)/u,
  );
  assert.match(source, /MUTATION_RESPONSE_TIMEOUT_MS = 45_000/u);
  assert.match(
    source,
    /waitForResponse\([\s\S]*?timeout: MUTATION_RESPONSE_TIMEOUT_MS/u,
  );
  assert.doesNotMatch(source, /await row\.click\(/u);
  assert.match(source, /button\.msr-close"\)\.click\(\{ timeout: ACTION_TIMEOUT_MS \}\)/u);
  assert.match(source, /await product\.click\([^;]+;\s*await product\.click\(/u);
  assert.match(source, /\.locator\("\.msr-replacement-qty-input"\)[\s\S]*?\.fill\("1"\)/u);
  assert.match(source, /maximumQuantity < 2[\s\S]*?DOM_RESO_PARTIAL_UNAVAILABLE/u);
  assert.doesNotMatch(
    source,
    /getByRole\("button", \{\s*name: new RegExp\(`Tavolo \$\{destination\}\.\*Destinazione libera/u,
  );
});

test("lo scheduler finto rispetta max uno in-flight ma non attesta azioni DOM", async () => {
  const pages = fakePages();
  const plan = buildB4WebWorkloadPlan();
  const inFlight = Array(8).fill(0);
  const maximumInFlight = Array(8).fill(0);
  const progress = [];
  let virtualNow = 0;
  let ledgerChecks = 0;
  const { request, envelope } = requestAndEnvelope();

  const result = await runB4WebWorkload(pages, {
    request,
    envelope,
    now: () => virtualNow,
    wait: async (milliseconds) => {
      virtualNow += milliseconds;
      await Promise.resolve();
    },
    actionExecutor: async ({ page, ordinal }) => {
      const index = page.workloadIndex;
      inFlight[index] += 1;
      maximumInFlight[index] = Math.max(maximumInFlight[index], inFlight[index]);
      await Promise.resolve();
      inFlight[index] -= 1;
      return {
        ok: true,
        scenario: plan[index].actions[ordinal - 1].scenario,
      };
    },
    onProgress: (entry) => progress.push(entry),
    verifyLedgerUnchanged: async () => {
      ledgerChecks += 1;
      return true;
    },
  });

  validateB4WebWorkloadResult(result, { request, envelope });
  assert.equal(result.report.verdict, "NON_GATE_FAIL");
  assert.equal(result.report.execution.completedActions, 160);
  assert.equal(result.report.execution.successfulActions, 160);
  assert.equal(result.report.execution.completedOrders, 64);
  assert.equal(result.report.execution.plannedOperationTypes, 35);
  assert.equal(result.report.execution.domScenarioTypes, 0);
  assert.equal(result.report.execution.actionsOriginatedFromDom, 0);
  assert.equal(result.report.execution.domExecutorBuiltIn, false);
  assert.equal(result.report.execution.maximumInFlightPerPalmare, 1);
  assert.ok(result.report.execution.maximumInFlightGlobal <= 8);
  assert.deepEqual(maximumInFlight, Array(8).fill(1));
  assert.equal(result.report.cadence.actionAverageGapMs, 3_000);
  assert.ok(result.report.cadence.commandAverageGapMs >= 7_000);
  assert.ok(result.report.cadence.commandAverageGapMs <= 8_000);
  assert.equal(result.report.cadence.actionCadenceOk, true);
  assert.equal(result.report.cadence.commandCadenceOk, true);
  assert.equal(ledgerChecks, 1);
  assert.equal(progress[0].percent, 0);
  assert.equal(progress.at(-1).percent, 100);
  assert.equal(progress.at(-1).completedActions, 160);
  assert.equal(progress.every((entry) => Number.isInteger(entry.percent)), true);
  assert.equal(progress.every((entry) => entry.percent >= 0 && entry.percent <= 100), true);
});

test("un errore DOM e un ledger non verificato producono sempre un result NON_GATE_FAIL", async () => {
  const pages = fakePages();
  const plan = buildB4WebWorkloadPlan();
  let virtualNow = 0;
  let injected = false;
  const { request, envelope } = requestAndEnvelope();
  const result = await runB4WebWorkload(pages, {
    request,
    envelope,
    now: () => virtualNow,
    wait: async (milliseconds) => {
      virtualNow += milliseconds;
      await Promise.resolve();
    },
    actionExecutor: async ({ page, ordinal }) => {
      if (!injected) {
        injected = true;
        throw new Error("private DOM failure details");
      }
      return {
        ok: true,
        scenario: plan[page.workloadIndex].actions[ordinal - 1].scenario,
      };
    },
    verifyLedgerUnchanged: async () => false,
  });

  assert.doesNotThrow(() => validateB4WebWorkloadResult(result, { request, envelope }));
  assert.equal(result.report.verdict, "NON_GATE_FAIL");
  assert.equal(result.report.execution.completedActions, 160);
  assert.equal(result.report.execution.failedActions, 1);
  assert.equal(result.report.ledgerObservation.stateByteIdentical, false);
  assert.equal(JSON.stringify(result.report).includes("private DOM failure details"), false);
});

test("pending request, popup e listener non ripuliti restano fail-closed", async () => {
  const pages = fakePages();
  const plan = buildB4WebWorkloadPlan();
  let virtualNow = 0;
  let pendingInjected = false;
  const { request, envelope } = requestAndEnvelope();
  const result = await runB4WebWorkload(pages, {
    request,
    envelope,
    now: () => virtualNow,
    wait: async (milliseconds) => {
      virtualNow += milliseconds;
      await Promise.resolve();
    },
    actionExecutor: async ({ page, ordinal }) => {
      if (!pendingInjected) {
        pendingInjected = true;
        page.emit("request", {
          method: () => "POST",
          url: () => "http://127.0.0.1/api/integration/orders/create",
        });
      }
      return {
        ok: true,
        scenario: plan[page.workloadIndex].actions[ordinal - 1].scenario,
      };
    },
    verifyLedgerUnchanged: async () => true,
  });
  assert.equal(result.report.verdict, "NON_GATE_FAIL");
  assert.equal(result.report.execution.pendingRequestsAtEnd, 1);
  assert.equal(result.report.execution.quiescenceAchieved, false);
  for (const page of pages) {
    for (const event of [
      "pageerror",
      "console",
      "response",
      "request",
      "requestfinished",
      "requestfailed",
    ]) {
      assert.equal(page.listeners(event).length, 0, event);
    }
  }

  const popupPages = fakePages();
  const popup = {};
  popupPages[0].context().pages = () => [popupPages[0], popup];
  const popupResult = await runB4WebWorkload(popupPages, {
    request,
    envelope,
    verifyLedgerUnchanged: async () => true,
  });
  assert.equal(popupResult.report.verdict, "NON_GATE_FAIL");
  assert.equal(popupResult.report.browserIsolation.pages, 9);
  assert.equal(popupResult.report.browserIsolation.contextOwnershipVerified, false);
});

test("gli screenshot privati usano file esclusivi 0600 e rifiutano symlink", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v6-workload-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { request, envelope } = requestAndEnvelope();
  const plan = buildB4WebWorkloadPlan();
  const runWithArtifacts = async (directory, { failFirst = false } = {}) => {
    let virtualNow = 0;
    let observationEmitted = false;
    let actionFailed = false;
    return runB4WebWorkload(fakePages(), {
      request,
      envelope,
      privateArtifactsDir: directory,
      now: () => virtualNow,
      wait: async (milliseconds) => {
        virtualNow += milliseconds;
        await Promise.resolve();
      },
      actionExecutor: async ({ page, ordinal }) => {
        if (!observationEmitted) {
          observationEmitted = true;
          page.emit("response", {
            request: () => ({
              method: () => "POST",
              url: () => "http://127.0.0.1/api/integration/orders/create?private=hidden",
            }),
            status: () => 201,
          });
        }
        if (failFirst && !actionFailed) {
          actionFailed = true;
          throw new Error(
            `Errore su https://private.invalid/order token_secret_12345678901234567890 ${root}`,
          );
        }
        return {
          ok: true,
          scenario: plan[page.workloadIndex].actions[ordinal - 1].scenario,
        };
      },
      verifyLedgerUnchanged: async () => true,
    });
  };

  const safeDirectory = path.join(root, "safe");
  const safeResult = await runWithArtifacts(safeDirectory);
  assert.equal(safeResult.report.execution.internalErrors, 0);
  const screenshots = (await fs.readdir(safeDirectory)).sort();
  assert.equal(screenshots.length, 17);
  assert.ok(screenshots.includes("workload-private-diagnostics.json"));
  for (const file of screenshots) {
    const stats = await fs.lstat(path.join(safeDirectory, file));
    assert.equal(stats.isFile(), true);
    assert.equal(stats.mode & 0o777, 0o600);
    assert.equal(stats.nlink, 1);
  }
  const safeDiagnostic = JSON.parse(
    await fs.readFile(path.join(safeDirectory, "workload-private-diagnostics.json"), "utf8"),
  );
  assert.deepEqual(safeDiagnostic.http[0], {
    method: "POST",
    path: "/api/integration/orders/create",
    status: 201,
  });
  assert.equal(JSON.stringify(safeDiagnostic).includes("private=hidden"), false);

  const errorDirectory = path.join(root, "action-error");
  await runWithArtifacts(errorDirectory, { failFirst: true });
  const errorDiagnostic = JSON.parse(
    await fs.readFile(path.join(errorDirectory, "workload-private-diagnostics.json"), "utf8"),
  );
  assert.equal(errorDiagnostic.actionErrors.length, 1);
  assert.equal(JSON.stringify(errorDiagnostic).includes("private.invalid"), false);
  assert.equal(JSON.stringify(errorDiagnostic).includes("token_secret"), false);
  assert.equal(JSON.stringify(errorDiagnostic).includes(root), false);

  const occupiedDirectory = path.join(root, "occupied");
  await fs.mkdir(occupiedDirectory, { mode: 0o700 });
  const occupiedFile = path.join(occupiedDirectory, "workload-start-01.png");
  await fs.writeFile(occupiedFile, "keep", { mode: 0o600 });
  const occupiedResult = await runWithArtifacts(occupiedDirectory);
  assert.equal(occupiedResult.report.verdict, "NON_GATE_FAIL");
  assert.ok(occupiedResult.report.execution.internalErrors > 0);
  assert.equal(await fs.readFile(occupiedFile, "utf8"), "keep");
  const privateDiagnostic = JSON.parse(
    await fs.readFile(path.join(occupiedDirectory, "workload-private-diagnostics.json"), "utf8"),
  );
  assert.equal(privateDiagnostic.mode, "B4_WEB_WORKLOAD_PRIVATE_DIAGNOSTICS");
  assert.ok(privateDiagnostic.internalErrors.length > 0);
  assert.equal(JSON.stringify(privateDiagnostic).includes(root), false);

  const targetDirectory = path.join(root, "target");
  const linkedDirectory = path.join(root, "linked");
  await fs.mkdir(targetDirectory, { mode: 0o700 });
  await fs.symlink(targetDirectory, linkedDirectory, "dir");
  const linkedResult = await runWithArtifacts(linkedDirectory);
  assert.equal(linkedResult.report.verdict, "NON_GATE_FAIL");
  assert.ok(linkedResult.report.execution.internalErrors > 0);
  assert.deepEqual(await fs.readdir(targetDirectory), []);
});

test("anche un banco Page invalido restituisce un wrapper FAIL, ma IPC invalido viene rifiutato", async () => {
  const { request, envelope } = requestAndEnvelope();
  const result = await runB4WebWorkload([], {
    request,
    envelope,
    verifyLedgerUnchanged: async () => true,
  });
  assert.equal(result.report.verdict, "NON_GATE_FAIL");
  assert.equal(result.report.execution.completedActions, 0);
  assert.doesNotThrow(() => validateB4WebWorkloadResult(result, { request, envelope }));

  const invalidRequest = { ...request, requestNonce: "short" };
  await assert.rejects(
    runB4WebWorkload([], { request: invalidRequest, envelope }),
    (error) => error instanceof B4WebWorkloadError && error.code === "WORKLOAD_REQUEST_INVALID",
  );
});
