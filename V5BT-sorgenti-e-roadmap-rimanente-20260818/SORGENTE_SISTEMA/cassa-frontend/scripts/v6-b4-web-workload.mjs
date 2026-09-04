import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { V6_BATTERY_NOTIFICATION_INTERVAL_MS } from "./v6-operations-gates.mjs";
import {
  V6_DEVICE_ACTION_INTERVAL_MS,
  V6_MOBILE_OPERATION_TYPES,
  isV6CommandOrdinal,
  runV6OperationsSchedule,
  v6MobileActionType,
} from "./v6-operations-scheduler.mjs";

export const B4_WEB_WORKLOAD_VERSION = "1.0.0";
export const B4_WEB_WORKLOAD_MODE = "EIGHT_CHROME_GUI_DOM_WORKLOAD_NON_GATE";
export const B4_WEB_WORKLOAD_PAGE_COUNT = 8;
export const B4_WEB_WORKLOAD_ACTIONS_PER_DEVICE = 20;
export const B4_WEB_WORKLOAD_ORDERS_PER_DEVICE = 8;
export const B4_WEB_WORKLOAD_TOTAL_ACTIONS = 160;
export const B4_WEB_WORKLOAD_TOTAL_ORDERS = 64;
export const B4_WEB_WORKLOAD_PHASE_OFFSET_MS = 375;
export const B4_WEB_WORKLOAD_REQUEST_MODE = `${B4_WEB_WORKLOAD_MODE}_REQUEST`;
export const B4_WEB_WORKLOAD_ENVELOPE_MODE = `${B4_WEB_WORKLOAD_MODE}_ENVELOPE`;
export const B4_WEB_WORKLOAD_RESULT_MODE = "B4_EIGHT_WEB_GUI_DOM_WORKLOAD_RESULT";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{24,128}$/u;
const ORDER_PATH = "/api/integration/orders/create";
const MOVE_PATH = "/api/integration/layout/table/move";
const CORRECTION_PATH = "/api/integration/orders/correct";
const STORNO_PATH = "/api/integration/orders/storno";
const ACTION_TIMEOUT_MS = 20_000;
const MUTATION_RESPONSE_TIMEOUT_MS = 45_000;
const QUIESCENCE_TIMEOUT_MS = 10_000;
const QUIESCENCE_QUIET_MS = 250;
const QUIESCENCE_POLL_MS = 25;
const TABLES_MODE_LONG_PRESS_MS = 800;
const TABLES_MODE_RETRY_DELAY_MS = 500;
const DOM_EXECUTION_ATTESTATION = Symbol("v6-b4-built-in-dom-execution");
const DOM_SCENARIOS = Object.freeze([
  "ORDER_CREATE",
  "TABLE_SEARCH",
  "TABLE_MOVE",
  "TABLES_COUNTER_SWITCH",
  "LEGEND_FILTER",
  "ORDER_CORRECT",
  "BEST_SELLER",
  "MENU_SEARCH",
  "ORDER_RESO",
  "TABLE_OPEN_CLOSE",
]);

export class B4WebWorkloadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "B4WebWorkloadError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new B4WebWorkloadError(code, message);
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value, keys, code = "WORKLOAD_CONTRACT_INVALID") {
  if (!isPlainObject(value)) fail(code, "Invalid workload object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code, "Invalid workload keys");
  }
}

function exact(actual, expected, code = "WORKLOAD_CONTRACT_INVALID") {
  if (actual !== expected) fail(code, "Invalid workload value");
}

function safeInteger(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function finiteNumber(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function commitment(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalizedString(value) {
  return String(value ?? "").trim();
}

function requestPath(request) {
  try {
    return new URL(request.url()).pathname;
  } catch {
    return "";
  }
}

function requestJson(request) {
  try {
    const parsed = request.postDataJSON();
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    try {
      const parsed = JSON.parse(request.postData() || "null");
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function mutationPaths(kind) {
  if (kind === "ORDER_CREATE") return [ORDER_PATH];
  if (kind === "TABLE_MOVE") return [MOVE_PATH];
  if (kind === "ORDER_CORRECT") return [CORRECTION_PATH];
  if (kind === "ORDER_RESO") return [CORRECTION_PATH, STORNO_PATH];
  fail("DOM_MUTATION_KIND_INVALID", "Unsupported DOM mutation kind");
}

function mutationResponseMatches(response, { kind, expectedOrderId = "", expectedTableId = "" }) {
  const request = response.request();
  if (request.method() !== "POST" || !mutationPaths(kind).includes(requestPath(request))) {
    return false;
  }
  const payload = requestJson(request);
  if (!payload) return true;
  if (expectedOrderId && normalizedString(payload.orderId) !== expectedOrderId) return false;
  if (expectedTableId) {
    const payloadTableId = normalizedString(
      kind === "TABLE_MOVE" ? payload.fromTableId : payload.tableId,
    );
    if (payloadTableId && payloadTableId !== expectedTableId) return false;
  }
  return true;
}

export async function validateB4WebMutationResponse(
  response,
  { kind, expectedOrderId = "", expectedTableId = "" } = {},
) {
  const request = response?.request?.();
  if (!request || request.method() !== "POST") {
    fail("DOM_MUTATION_REQUEST_INVALID", "The DOM mutation did not use POST");
  }
  const pathname = requestPath(request);
  if (!mutationPaths(kind).includes(pathname)) {
    fail("DOM_MUTATION_REQUEST_INVALID", "Unexpected DOM mutation endpoint");
  }
  const payload = requestJson(request);
  if (!payload) fail("DOM_MUTATION_REQUEST_INVALID", "Missing DOM mutation JSON body");
  const status = Number(response.status());
  let body;
  try {
    body = await response.json();
  } catch {
    fail("DOM_MUTATION_RESPONSE_INVALID", "The DOM mutation response is not JSON");
  }
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    const responseMessage = isPlainObject(body)
      ? normalizedString(body.error || body.message || body.code)
      : "";
    fail(
      "DOM_MUTATION_RESPONSE_INVALID",
      responseMessage || "The DOM mutation response was not successful",
    );
  }
  if (!isPlainObject(body) || body.ok !== true) {
    fail("DOM_MUTATION_RESPONSE_INVALID", "The DOM mutation response did not confirm success");
  }

  const payloadTableId = normalizedString(payload.tableId);
  const payloadOrderId = normalizedString(payload.orderId);
  const responseOrder = isPlainObject(body.order) ? body.order : null;
  const responseOrderId = normalizedString(responseOrder?.id);
  const responseOrderTableId = normalizedString(responseOrder?.tableId);
  const responseOrderLines = [
    ...(Array.isArray(responseOrder?.items) ? responseOrder.items : []),
    ...(Array.isArray(responseOrder?.lines) ? responseOrder.lines : []),
  ];
  const responseLineIds = [
    ...new Set(
      responseOrderLines
        .map((line) => normalizedString(isPlainObject(line) ? line.lineId : ""))
        .filter(Boolean),
    ),
  ];
  if (kind === "ORDER_CREATE") {
    if (!payloadTableId || !Array.isArray(payload.lines) || payload.lines.length === 0) {
      fail("DOM_MUTATION_REQUEST_INVALID", "The order request is not tied to a table and lines");
    }
    if (
      !responseOrderId ||
      !responseOrderTableId ||
      responseLineIds.length === 0 ||
      responseOrderTableId !== payloadTableId ||
      (expectedTableId && payloadTableId !== expectedTableId)
    ) {
      fail("DOM_MUTATION_CORRELATION_INVALID", "The created order is not tied to its request");
    }
    return Object.freeze({
      kind,
      pathname,
      orderId: responseOrderId,
      tableId: payloadTableId,
      lineIds: Object.freeze(responseLineIds),
    });
  }

  if (kind === "TABLE_MOVE") {
    const fromTableId = normalizedString(payload.fromTableId);
    const toTableId = normalizedString(payload.toTableId);
    const responseFromTableId = normalizedString(
      isPlainObject(body.fromTable) ? body.fromTable.id : "",
    );
    const responseToTableId = normalizedString(
      isPlainObject(body.toTable) ? body.toTable.id : "",
    );
    if (
      !fromTableId ||
      !toTableId ||
      fromTableId === toTableId ||
      responseFromTableId !== fromTableId ||
      responseToTableId !== toTableId ||
      (expectedTableId && fromTableId !== expectedTableId)
    ) {
      fail("DOM_MUTATION_CORRELATION_INVALID", "The table move response is not tied to its request");
    }
    return Object.freeze({ kind, pathname, fromTableId, toTableId });
  }

  if (
    !payloadOrderId ||
    !payloadTableId ||
    !responseOrderId ||
    responseOrderId !== payloadOrderId ||
    (responseOrderTableId && responseOrderTableId !== payloadTableId) ||
    (expectedOrderId && payloadOrderId !== expectedOrderId) ||
    (expectedTableId && payloadTableId !== expectedTableId)
  ) {
    fail("DOM_MUTATION_CORRELATION_INVALID", "The recovery response is not tied to its order");
  }
  if (
    kind === "ORDER_CORRECT" &&
    (!Array.isArray(payload.changedItems) || payload.changedItems.length === 0)
  ) {
    fail("DOM_MUTATION_REQUEST_INVALID", "The correction request has no changed lines");
  }
  if (kind === "ORDER_RESO") {
    const validCorrectionReturn =
      pathname === CORRECTION_PATH &&
      payload.recoveryMode === "return_without_replacement" &&
      Array.isArray(payload.removedItems) &&
      payload.removedItems.length > 0;
    const validStorno =
      pathname === STORNO_PATH &&
      Boolean(normalizedString(payload.originalLineId)) &&
      Number(payload.quantity) > 0;
    if (!validCorrectionReturn && !validStorno) {
      fail("DOM_MUTATION_REQUEST_INVALID", "The return request has no correlated line mutation");
    }
  }
  return Object.freeze({
    kind,
    pathname,
    orderId: payloadOrderId,
    tableId: payloadTableId,
    lineIds: Object.freeze(responseLineIds),
  });
}

function randomNonce() {
  return crypto.randomBytes(24).toString("base64url");
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function rounded(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

function abortError() {
  return new B4WebWorkloadError("WORKLOAD_ABORTED", "The web workload was aborted");
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function waitWithSignal(milliseconds, signal) {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(0, milliseconds));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal) {
      setTimeout(() => signal.removeEventListener("abort", onAbort), Math.max(0, milliseconds) + 1).unref?.();
    }
  });
}

export function buildB4WebWorkloadRequest({
  requestNonce = randomNonce(),
  requestedAt = new Date().toISOString(),
} = {}) {
  return validateB4WebWorkloadRequest({
    schemaVersion: 1,
    mode: B4_WEB_WORKLOAD_REQUEST_MODE,
    requestedAt,
    requestNonce,
  });
}

export function validateB4WebWorkloadRequest(request) {
  exactKeys(request, ["schemaVersion", "mode", "requestedAt", "requestNonce"]);
  exact(request.schemaVersion, 1);
  exact(request.mode, B4_WEB_WORKLOAD_REQUEST_MODE);
  if (!validIso(request.requestedAt) || !NONCE_PATTERN.test(request.requestNonce)) {
    fail("WORKLOAD_REQUEST_INVALID", "Invalid workload request");
  }
  return Object.freeze({ ...request });
}

export function buildB4WebWorkloadEnvelope(
  request,
  {
    envelopeNonce = randomNonce(),
    createdAt = new Date().toISOString(),
  } = {},
) {
  const validatedRequest = validateB4WebWorkloadRequest(request);
  return validateB4WebWorkloadEnvelope(
    {
      schemaVersion: 1,
      mode: B4_WEB_WORKLOAD_ENVELOPE_MODE,
      createdAt,
      envelopeNonce,
      requestCommitmentSha256: commitment(validatedRequest),
    },
    validatedRequest,
  );
}

export function validateB4WebWorkloadEnvelope(envelope, request) {
  const validatedRequest = validateB4WebWorkloadRequest(request);
  exactKeys(envelope, [
    "schemaVersion",
    "mode",
    "createdAt",
    "envelopeNonce",
    "requestCommitmentSha256",
  ]);
  exact(envelope.schemaVersion, 1);
  exact(envelope.mode, B4_WEB_WORKLOAD_ENVELOPE_MODE);
  if (
    !validIso(envelope.createdAt) ||
    !NONCE_PATTERN.test(envelope.envelopeNonce) ||
    !SHA256_PATTERN.test(envelope.requestCommitmentSha256) ||
    envelope.requestCommitmentSha256 !== commitment(validatedRequest)
  ) {
    fail("WORKLOAD_ENVELOPE_INVALID", "Invalid workload envelope binding");
  }
  return Object.freeze({ ...envelope });
}

export function buildB4WebWorkloadPlan() {
  return Object.freeze(
    Array.from({ length: B4_WEB_WORKLOAD_PAGE_COUNT }, (_, index) =>
      Object.freeze({
        index,
        logicalSlot: index + 3,
        primaryTableNumber: index * 2 + 1,
        alternateTableNumber: index * 2 + 2,
        actions: Object.freeze(
          Array.from({ length: B4_WEB_WORKLOAD_ACTIONS_PER_DEVICE }, (_entry, actionIndex) => {
            const ordinal = actionIndex + 1;
            return Object.freeze({
              ordinal,
              operationType: resolveB4WebWorkloadActionType({ deviceIndex: index, ordinal }),
              scenario: resolveDomScenario(ordinal),
            });
          }),
        ),
      }),
    ),
  );
}

export function resolveB4WebWorkloadActionType({ deviceIndex = 0, ordinal }) {
  return v6MobileActionType(deviceIndex, ordinal);
}

function resolveDomScenario(ordinal) {
  if (isV6CommandOrdinal(ordinal)) return "ORDER_CREATE";
  return (
    {
      2: "TABLE_SEARCH",
      4: "BEST_SELLER",
      5: "TABLE_MOVE",
      7: "TABLES_COUNTER_SWITCH",
      9: "LEGEND_FILTER",
      10: "ORDER_CORRECT",
      12: "TABLE_OPEN_CLOSE",
      14: "MENU_SEARCH",
      15: "TABLE_MOVE",
      17: "ORDER_RESO",
      19: "TABLE_SEARCH",
      20: "TABLE_OPEN_CLOSE",
    }[ordinal] ?? "TABLE_OPEN_CLOSE"
  );
}

function reportPasses(report) {
  return (
    report.execution.completedActions === B4_WEB_WORKLOAD_TOTAL_ACTIONS &&
    report.execution.successfulActions === B4_WEB_WORKLOAD_TOTAL_ACTIONS &&
    report.execution.failedActions === 0 &&
    report.execution.completedOrders === B4_WEB_WORKLOAD_TOTAL_ORDERS &&
    report.execution.maximumInFlightPerPalmare === 1 &&
    report.execution.maximumInFlightGlobal >= 1 &&
    report.execution.maximumInFlightGlobal <= B4_WEB_WORKLOAD_PAGE_COUNT &&
    report.execution.plannedOperationTypes === V6_MOBILE_OPERATION_TYPES.length + 1 &&
    report.execution.domScenarioTypes === DOM_SCENARIOS.length &&
    report.execution.actionsOriginatedFromDom === B4_WEB_WORKLOAD_TOTAL_ACTIONS &&
    report.execution.domExecutorBuiltIn === true &&
    report.execution.internalErrors === 0 &&
    report.execution.pendingRequestsAtEnd === 0 &&
    report.execution.quiescenceAchieved === true &&
    report.execution.pageErrors === 0 &&
    report.execution.consoleErrors === 0 &&
    report.execution.httpFailures === 0 &&
    report.execution.requestFailures === 0 &&
    report.cadence.actionCadenceOk === true &&
    report.cadence.commandCadenceOk === true &&
    report.browserIsolation.contexts === 8 &&
    report.browserIsolation.pages === 8 &&
    report.browserIsolation.sessions === 8 &&
    report.browserIsolation.storageIsolated === true &&
    report.browserIsolation.contextOwnershipVerified === true &&
    report.browserIsolation.sessionPreserved === true &&
    report.browserIsolation.mobileViewportMatched === true &&
    report.browserIsolation.touchEnabled === true &&
    report.browserIsolation.resourcesAfterCleanup === 0 &&
    report.ledgerObservation.stateByteIdentical === true
  );
}

export function buildB4WebWorkloadReport(metrics = {}) {
  const execution = {
    plannedActions: B4_WEB_WORKLOAD_TOTAL_ACTIONS,
    completedActions: Number(metrics.completedActions) || 0,
    successfulActions: Number(metrics.successfulActions) || 0,
    failedActions: Number(metrics.failedActions) || 0,
    plannedOrders: B4_WEB_WORKLOAD_TOTAL_ORDERS,
    completedOrders: Number(metrics.completedOrders) || 0,
    maximumInFlightPerPalmare: Number(metrics.maximumInFlightPerPalmare) || 0,
    maximumInFlightGlobal: Number(metrics.maximumInFlightGlobal) || 0,
    plannedOperationTypes: Number(metrics.plannedOperationTypes) || 0,
    domScenarioTypes: Number(metrics.domScenarioTypes) || 0,
    businessSemanticCoverageClaimed: false,
    actionsOriginatedFromDom: Number(metrics.actionsOriginatedFromDom) || 0,
    domExecutorBuiltIn: metrics.domExecutorBuiltIn === true,
    directApiActions: 0,
    internalErrors: Number(metrics.internalErrors) || 0,
    pendingRequestsAtEnd: Number(metrics.pendingRequestsAtEnd) || 0,
    quiescenceAchieved: metrics.quiescenceAchieved === true,
    pageErrors: Number(metrics.pageErrors) || 0,
    consoleErrors: Number(metrics.consoleErrors) || 0,
    httpFailures: Number(metrics.httpFailures) || 0,
    requestFailures: Number(metrics.requestFailures) || 0,
  };
  const report = {
    schemaVersion: 1,
    harnessVersion: B4_WEB_WORKLOAD_VERSION,
    product: "V6",
    phase: "B4",
    mode: B4_WEB_WORKLOAD_MODE,
    evidenceClass: "NON_GATE_EVIDENCE",
    verdict: "NON_GATE_FAIL",
    gateImpact: "NONE",
    profile: {
      webPalmari: B4_WEB_WORKLOAD_PAGE_COUNT,
      actionsPerPalmare: B4_WEB_WORKLOAD_ACTIONS_PER_DEVICE,
      ordersPerPalmare: B4_WEB_WORKLOAD_ORDERS_PER_DEVICE,
      actionIntervalMs: V6_DEVICE_ACTION_INTERVAL_MS,
      commandAverageMinimumMs: 7_000,
      commandAverageMaximumMs: 8_000,
      phaseOffsetMs: B4_WEB_WORKLOAD_PHASE_OFFSET_MS,
      batteryIntervalConfiguredMs: V6_BATTERY_NOTIFICATION_INTERVAL_MS,
      batteryNotificationsObserved: 0,
      batteryObservationClaimed: false,
    },
    execution,
    cadence: {
      basis: "DISPATCH_PER_DEVICE",
      actionAverageGapMs: rounded(metrics.actionAverageGapMs),
      commandAverageGapMs: rounded(metrics.commandAverageGapMs),
      actionLatencyP95Ms: rounded(metrics.actionLatencyP95Ms),
      commandLatencyP95Ms: rounded(metrics.commandLatencyP95Ms),
      actionCadenceOk: metrics.actionCadenceOk === true,
      commandCadenceOk: metrics.commandCadenceOk === true,
    },
    browserIsolation: {
      graphical: true,
      browserEngine: "CHROMIUM",
      contexts: Number(metrics.contexts) || 0,
      pages: Number(metrics.pages) || 0,
      sessions: Number(metrics.sessions) || 0,
      slots: [3, 4, 5, 6, 7, 8, 9, 10],
      storageIsolated: metrics.storageIsolated === true,
      contextOwnershipVerified: metrics.contextOwnershipVerified === true,
      sessionPreserved: metrics.sessionPreserved === true,
      mobileViewportMatched: metrics.mobileViewportMatched === true,
      touchEnabled: metrics.touchEnabled === true,
      loopbackOnly: true,
      hardwareAccessed: false,
      resourcesAfterCleanup: Number(metrics.resourcesAfterCleanup) || 0,
    },
    ledgerObservation: {
      physicalRecordsReadOnly: 2,
      stateByteIdentical: metrics.ledgerUnchanged === true,
      physicalEvidenceFilesRead: false,
    },
    effects: {
      isolatedRuntimeStateWritten: execution.completedOrders > 0,
      physicalStateWritten: false,
      physicalLedgerWritten: false,
      officialCampaignStateWritten: false,
      authoritativeGateExecuted: false,
      gatePromoted: false,
    },
    gates: {
      requiredDistinctPhysicalDevices: 10,
      distinctPhysicalDevices: 2,
      simulatedDevicesCountedTowardGate: 0,
      remainingDistinctPhysicalDevices: 8,
      b4TenPhysicalDeviceGate: "PENDING",
      b5HundredSessionGate: "PENDING",
      b6AndroidPairGate: "BLOCKED",
      officialSessionsRecorded: 0,
    },
    authorization: {
      b5DiagnosticPilotAuthorized: false,
      b5OfficialCampaignAuthorized: false,
      reasonCode: "WEB_GUI_WORKLOAD_IS_NOT_PHYSICAL_EVIDENCE",
    },
    privacy: {
      browserIdentifiersIncluded: false,
      accountIdentifiersIncluded: false,
      sessionTokensIncluded: false,
      networkEndpointIncluded: false,
      physicalIdentifiersIncluded: false,
      filesystemLocationsIncluded: false,
      hashesIncluded: false,
      timestampsIncluded: false,
    },
  };
  report.verdict = reportPasses(report) ? "NON_GATE_PASS" : "NON_GATE_FAIL";
  return validateB4WebWorkloadReport(report);
}

function validateCounterObject(value, keys, extraKeys = []) {
  exactKeys(value, [...keys, ...extraKeys]);
  for (const key of keys) {
    if (!safeInteger(value[key])) fail("WORKLOAD_CONTRACT_INVALID", "Invalid workload counter");
  }
}

export function validateB4WebWorkloadReport(report) {
  exactKeys(report, [
    "schemaVersion",
    "harnessVersion",
    "product",
    "phase",
    "mode",
    "evidenceClass",
    "verdict",
    "gateImpact",
    "profile",
    "execution",
    "cadence",
    "browserIsolation",
    "ledgerObservation",
    "effects",
    "gates",
    "authorization",
    "privacy",
  ]);
  exact(report.schemaVersion, 1);
  exact(report.harnessVersion, B4_WEB_WORKLOAD_VERSION);
  exact(report.product, "V6");
  exact(report.phase, "B4");
  exact(report.mode, B4_WEB_WORKLOAD_MODE);
  exact(report.evidenceClass, "NON_GATE_EVIDENCE");
  if (!new Set(["NON_GATE_PASS", "NON_GATE_FAIL"]).has(report.verdict)) {
    fail("WORKLOAD_CONTRACT_INVALID", "Invalid workload verdict");
  }
  exact(report.gateImpact, "NONE");

  exactKeys(report.profile, [
    "webPalmari",
    "actionsPerPalmare",
    "ordersPerPalmare",
    "actionIntervalMs",
    "commandAverageMinimumMs",
    "commandAverageMaximumMs",
    "phaseOffsetMs",
    "batteryIntervalConfiguredMs",
    "batteryNotificationsObserved",
    "batteryObservationClaimed",
  ]);
  for (const [field, expected] of Object.entries({
    webPalmari: 8,
    actionsPerPalmare: 20,
    ordersPerPalmare: 8,
    actionIntervalMs: 3_000,
    commandAverageMinimumMs: 7_000,
    commandAverageMaximumMs: 8_000,
    phaseOffsetMs: 375,
    batteryIntervalConfiguredMs: 120_000,
    batteryNotificationsObserved: 0,
    batteryObservationClaimed: false,
  })) exact(report.profile[field], expected);

  validateCounterObject(report.execution, [
    "plannedActions",
    "completedActions",
    "successfulActions",
    "failedActions",
    "plannedOrders",
    "completedOrders",
    "maximumInFlightPerPalmare",
    "maximumInFlightGlobal",
    "plannedOperationTypes",
    "domScenarioTypes",
    "actionsOriginatedFromDom",
    "directApiActions",
    "internalErrors",
    "pendingRequestsAtEnd",
    "pageErrors",
    "consoleErrors",
    "httpFailures",
    "requestFailures",
  ], [
    "businessSemanticCoverageClaimed",
    "domExecutorBuiltIn",
    "quiescenceAchieved",
  ]);
  exact(report.execution.plannedActions, 160);
  exact(report.execution.plannedOrders, 64);
  exact(report.execution.directApiActions, 0);
  exact(report.execution.businessSemanticCoverageClaimed, false);
  for (const field of ["domExecutorBuiltIn", "quiescenceAchieved"]) {
    if (typeof report.execution[field] !== "boolean") {
      fail("WORKLOAD_CONTRACT_INVALID", "Invalid workload execution outcome");
    }
  }
  if (
    report.execution.completedActions > 160 ||
    report.execution.successfulActions > report.execution.completedActions ||
    report.execution.failedActions !==
      report.execution.completedActions - report.execution.successfulActions ||
    report.execution.completedOrders > 64 ||
    report.execution.maximumInFlightPerPalmare > 1 ||
    report.execution.maximumInFlightGlobal > 8 ||
    report.execution.plannedOperationTypes > V6_MOBILE_OPERATION_TYPES.length + 1 ||
    report.execution.domScenarioTypes > DOM_SCENARIOS.length ||
    report.execution.actionsOriginatedFromDom > report.execution.successfulActions ||
    (!report.execution.domExecutorBuiltIn && report.execution.actionsOriginatedFromDom !== 0)
  ) {
    fail("WORKLOAD_CONTRACT_INVALID", "Inconsistent workload counters");
  }

  exactKeys(report.cadence, [
    "basis",
    "actionAverageGapMs",
    "commandAverageGapMs",
    "actionLatencyP95Ms",
    "commandLatencyP95Ms",
    "actionCadenceOk",
    "commandCadenceOk",
  ]);
  exact(report.cadence.basis, "DISPATCH_PER_DEVICE");
  for (const field of [
    "actionAverageGapMs",
    "commandAverageGapMs",
    "actionLatencyP95Ms",
    "commandLatencyP95Ms",
  ]) {
    if (report.cadence[field] !== null && !finiteNumber(report.cadence[field])) {
      fail("WORKLOAD_CONTRACT_INVALID", "Invalid workload timing");
    }
  }
  for (const field of ["actionCadenceOk", "commandCadenceOk"]) {
    if (typeof report.cadence[field] !== "boolean") {
      fail("WORKLOAD_CONTRACT_INVALID", "Invalid workload cadence outcome");
    }
  }

  exactKeys(report.browserIsolation, [
    "graphical",
    "browserEngine",
    "contexts",
    "pages",
    "sessions",
    "slots",
    "storageIsolated",
    "contextOwnershipVerified",
    "sessionPreserved",
    "mobileViewportMatched",
    "touchEnabled",
    "loopbackOnly",
    "hardwareAccessed",
    "resourcesAfterCleanup",
  ]);
  exact(report.browserIsolation.graphical, true);
  exact(report.browserIsolation.browserEngine, "CHROMIUM");
  exact(report.browserIsolation.loopbackOnly, true);
  exact(report.browserIsolation.hardwareAccessed, false);
  if (
    !Array.isArray(report.browserIsolation.slots) ||
    report.browserIsolation.slots.length !== B4_WEB_WORKLOAD_PAGE_COUNT ||
    report.browserIsolation.slots.some((slot, index) => slot !== index + 3)
  ) {
    fail("WORKLOAD_CONTRACT_INVALID", "Invalid workload slots");
  }
  for (const field of ["contexts", "pages", "sessions", "resourcesAfterCleanup"]) {
    if (!safeInteger(report.browserIsolation[field])) {
      fail("WORKLOAD_CONTRACT_INVALID", "Invalid browser isolation count");
    }
  }
  for (const field of [
    "storageIsolated",
    "contextOwnershipVerified",
    "sessionPreserved",
    "mobileViewportMatched",
    "touchEnabled",
  ]) {
    if (typeof report.browserIsolation[field] !== "boolean") {
      fail("WORKLOAD_CONTRACT_INVALID", "Invalid browser isolation outcome");
    }
  }

  exactKeys(report.ledgerObservation, [
    "physicalRecordsReadOnly",
    "stateByteIdentical",
    "physicalEvidenceFilesRead",
  ]);
  exact(report.ledgerObservation.physicalRecordsReadOnly, 2);
  exact(report.ledgerObservation.physicalEvidenceFilesRead, false);
  if (typeof report.ledgerObservation.stateByteIdentical !== "boolean") {
    fail("WORKLOAD_CONTRACT_INVALID", "Invalid ledger outcome");
  }

  exactKeys(report.effects, [
    "isolatedRuntimeStateWritten",
    "physicalStateWritten",
    "physicalLedgerWritten",
    "officialCampaignStateWritten",
    "authoritativeGateExecuted",
    "gatePromoted",
  ]);
  if (typeof report.effects.isolatedRuntimeStateWritten !== "boolean") {
    fail("WORKLOAD_CONTRACT_INVALID", "Invalid isolated effect");
  }
  exact(
    report.effects.isolatedRuntimeStateWritten,
    report.execution.completedOrders > 0,
  );
  for (const field of [
    "physicalStateWritten",
    "physicalLedgerWritten",
    "officialCampaignStateWritten",
    "authoritativeGateExecuted",
    "gatePromoted",
  ]) exact(report.effects[field], false);

  exactKeys(report.gates, [
    "requiredDistinctPhysicalDevices",
    "distinctPhysicalDevices",
    "simulatedDevicesCountedTowardGate",
    "remainingDistinctPhysicalDevices",
    "b4TenPhysicalDeviceGate",
    "b5HundredSessionGate",
    "b6AndroidPairGate",
    "officialSessionsRecorded",
  ]);
  for (const [field, expected] of Object.entries({
    requiredDistinctPhysicalDevices: 10,
    distinctPhysicalDevices: 2,
    simulatedDevicesCountedTowardGate: 0,
    remainingDistinctPhysicalDevices: 8,
    b4TenPhysicalDeviceGate: "PENDING",
    b5HundredSessionGate: "PENDING",
    b6AndroidPairGate: "BLOCKED",
    officialSessionsRecorded: 0,
  })) exact(report.gates[field], expected);

  exactKeys(report.authorization, [
    "b5DiagnosticPilotAuthorized",
    "b5OfficialCampaignAuthorized",
    "reasonCode",
  ]);
  exact(report.authorization.b5DiagnosticPilotAuthorized, false);
  exact(report.authorization.b5OfficialCampaignAuthorized, false);
  exact(report.authorization.reasonCode, "WEB_GUI_WORKLOAD_IS_NOT_PHYSICAL_EVIDENCE");

  exactKeys(report.privacy, [
    "browserIdentifiersIncluded",
    "accountIdentifiersIncluded",
    "sessionTokensIncluded",
    "networkEndpointIncluded",
    "physicalIdentifiersIncluded",
    "filesystemLocationsIncluded",
    "hashesIncluded",
    "timestampsIncluded",
  ]);
  for (const value of Object.values(report.privacy)) exact(value, false);
  exact(report.verdict, reportPasses(report) ? "NON_GATE_PASS" : "NON_GATE_FAIL");
  return Object.freeze(report);
}

export function buildB4WebWorkloadResult({ request, envelope, report }) {
  const validatedRequest = validateB4WebWorkloadRequest(request);
  const validatedEnvelope = validateB4WebWorkloadEnvelope(envelope, validatedRequest);
  const validatedReport = validateB4WebWorkloadReport(report);
  return validateB4WebWorkloadResult(
    {
      schemaVersion: 1,
      mode: B4_WEB_WORKLOAD_RESULT_MODE,
      requestCommitmentSha256: commitment(validatedRequest),
      envelopeCommitmentSha256: commitment(validatedEnvelope),
      report: validatedReport,
    },
    { request: validatedRequest, envelope: validatedEnvelope },
  );
}

export function validateB4WebWorkloadResult(result, { request, envelope }) {
  const validatedRequest = validateB4WebWorkloadRequest(request);
  const validatedEnvelope = validateB4WebWorkloadEnvelope(envelope, validatedRequest);
  exactKeys(result, [
    "schemaVersion",
    "mode",
    "requestCommitmentSha256",
    "envelopeCommitmentSha256",
    "report",
  ]);
  exact(result.schemaVersion, 1);
  exact(result.mode, B4_WEB_WORKLOAD_RESULT_MODE);
  exact(result.requestCommitmentSha256, commitment(validatedRequest));
  exact(result.envelopeCommitmentSha256, commitment(validatedEnvelope));
  validateB4WebWorkloadReport(result.report);
  return Object.freeze({ ...result, report: Object.freeze(result.report) });
}

async function sessionIdentity(page) {
  return page.evaluate(() => ({
    token: window.localStorage.getItem("pos_token") || "",
    userId: window.localStorage.getItem("pos_user_id") || "",
    deviceUuid: window.localStorage.getItem("pos_device_uuid") || "",
  }));
}

function inspectPageContexts(pages) {
  const contexts = [];
  let ownershipVerified = true;
  let totalPages = 0;
  for (const page of pages) {
    let context = null;
    try {
      context = page.context();
      const ownedPages = context?.pages?.();
      totalPages += Array.isArray(ownedPages) ? ownedPages.length : 0;
      ownershipVerified =
        ownershipVerified &&
        Boolean(context && context.browser?.()) &&
        Array.isArray(ownedPages) &&
        ownedPages.length === 1 &&
        ownedPages[0] === page;
    } catch {
      ownershipVerified = false;
    }
    contexts.push(context);
  }
  return {
    contexts: new Set(contexts.filter(Boolean)).size,
    totalPages,
    ownershipVerified:
      ownershipVerified && contexts.length === pages.length && new Set(contexts).size === pages.length,
  };
}

async function visible(locator) {
  return locator.isVisible().catch(() => false);
}

function waitForMutationResponse(page, options) {
  return page.waitForResponse(
    (response) => mutationResponseMatches(response, options),
    { timeout: MUTATION_RESPONSE_TIMEOUT_MS },
  );
}

async function captureMutationResponse(page, options, trigger) {
  const responsePromise = waitForMutationResponse(page, options);
  try {
    await trigger();
  } catch (error) {
    void responsePromise.catch(() => undefined);
    throw error;
  }
  return responsePromise;
}

async function closeComposer(page) {
  const composer = page.locator(".table-order-composer").first();
  if (!(await visible(composer))) return;
  const close = composer.locator(".table-order-close-btn").first();
  if (await visible(close)) {
    await close.click({ timeout: ACTION_TIMEOUT_MS });
    await composer.waitFor({ state: "hidden", timeout: ACTION_TIMEOUT_MS });
    return;
  }
  const mode = normalizedString(
    await page.locator(".topbar-title").first().innerText().catch(() => ""),
  ).toUpperCase();
  if (mode !== "BANCO") {
    fail("DOM_CLOSE_FAILED", "The order composer cannot be closed");
  }
  await switchTablesWorkspaceMode(page, "TAVOLI");
  await composer.waitFor({ state: "hidden", timeout: ACTION_TIMEOUT_MS });
}

async function closeDetail(page) {
  const panel = page.locator(".table-detail-panel.is-open").first();
  if (!(await visible(panel))) return;
  const preview = panel.locator(".table-history-preview-card").first();
  if (await visible(preview)) {
    const previewClose = preview.locator(".table-history-preview-close").first();
    if (!(await visible(previewClose))) {
      fail("DOM_CLOSE_FAILED", "The order history preview cannot be closed");
    }
    await previewClose.click({ timeout: ACTION_TIMEOUT_MS });
    await preview.waitFor({ state: "hidden", timeout: ACTION_TIMEOUT_MS });
  }
  const close = panel.locator("button.table-detail-close").first();
  if (!(await visible(close))) fail("DOM_CLOSE_FAILED", "The table detail cannot be closed");
  await close.click({ timeout: ACTION_TIMEOUT_MS });
  await panel.waitFor({ state: "hidden", timeout: ACTION_TIMEOUT_MS });
}

async function dismissStationWarning(page) {
  const warning = page
    .getByRole("alertdialog")
    .filter({ hasText: "Nessuna postazione attiva" })
    .first();
  if (await visible(warning)) {
    await warning.getByRole("button", { name: "OK", exact: true }).click({ timeout: 5_000 });
    await warning.waitFor({ state: "hidden", timeout: 5_000 });
  }
}

async function recoverDomOverlays(page) {
  const alertDialogs = page.getByRole("alertdialog");
  const alertCount = await alertDialogs.count();
  for (let index = 0; index < alertCount; index += 1) {
    const alert = alertDialogs.nth(index);
    if (!(await visible(alert))) continue;
    const ok = alert.getByRole("button", { name: "OK", exact: true }).first();
    if (!(await visible(ok))) fail("DOM_RECOVERY_FAILED", "A visible alert cannot be dismissed");
    await ok.click({ timeout: 5_000 });
    await alert.waitFor({ state: "hidden", timeout: 5_000 });
  }

  const confirm = page.getByRole("dialog", {
    name: "Conferma spostamento tavolo",
    exact: true,
  });
  if (await visible(confirm)) {
    await confirm.getByRole("button", { name: "ANNULLA", exact: true }).click({ timeout: 5_000 });
    await confirm.waitFor({ state: "hidden", timeout: 5_000 });
  }
  const picker = page.getByRole("dialog", { name: "Sposta tavolo", exact: true });
  if (await visible(picker)) {
    await picker.getByRole("button", { name: "Chiudi", exact: true }).click({ timeout: 5_000 });
    await picker.waitFor({ state: "hidden", timeout: 5_000 });
  }
  const recovery = page.locator(".msr-composer-modal").first();
  if (await visible(recovery)) {
    await recovery.locator("button.msr-close").click({ timeout: ACTION_TIMEOUT_MS });
    await recovery.waitFor({ state: "hidden", timeout: ACTION_TIMEOUT_MS });
  }
  await closeComposer(page);
  await closeDetail(page);

  for (const locator of [
    page.getByRole("alertdialog"),
    page.getByRole("dialog", { name: "Sposta tavolo", exact: true }),
    page.getByRole("dialog", { name: "Conferma spostamento tavolo", exact: true }),
    page.locator(".msr-composer-modal"),
    page.locator(".table-order-composer"),
    page.locator(".table-detail-panel.is-open"),
  ]) {
    if (await visible(locator.first())) {
      fail("DOM_RECOVERY_FAILED", "A workload overlay remained visible after recovery");
    }
  }
}

async function longPressTitle(page) {
  const title = page.locator(".topbar-title.is-long-pressable").first();
  await title.waitFor({ state: "visible", timeout: 10_000 });
  const box = await title.boundingBox();
  if (!box) fail("DOM_ACTION_FAILED", "The Tavoli/Banco title is not measurable");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(TABLES_MODE_LONG_PRESS_MS);
  await page.mouse.up();
}

async function switchTablesWorkspaceMode(page, expectedMode) {
  const expected = normalizedString(expectedMode).toUpperCase();
  if (!new Set(["TAVOLI", "BANCO"]).has(expected)) {
    fail("DOM_TABLES_MODE_INVALID", "Invalid tables workspace mode");
  }
  const title = page.locator(".topbar-title").first();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = normalizedString(await title.innerText().catch(() => "")).toUpperCase();
    if (current === expected) return;
    if (!new Set(["TAVOLI", "BANCO"]).has(current)) {
      fail("DOM_TABLES_MODE_INVALID", "The tables workspace mode is unavailable");
    }
    await longPressTitle(page);
    const changed = await title
      .filter({ hasText: new RegExp(`^${expected}$`, "u") })
      .waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS / 2 })
      .then(() => true)
      .catch(() => false);
    if (changed) {
      await page.waitForTimeout(TABLES_MODE_RETRY_DELAY_MS);
      return;
    }
    await page.waitForTimeout(TABLES_MODE_RETRY_DELAY_MS);
  }
  fail("DOM_TABLES_MODE_SWITCH_FAILED", `The tables workspace did not enter ${expected}`);
}

async function ensureTablesWorkspace(page) {
  await dismissStationWarning(page);
  await closeComposer(page);
  const recovery = page.locator(".msr-composer-modal").first();
  if (await visible(recovery)) {
    await recovery.locator("button.msr-close").click({ timeout: ACTION_TIMEOUT_MS });
    await recovery.waitFor({ state: "hidden", timeout: ACTION_TIMEOUT_MS });
  }
  await closeDetail(page);
  const tablesButton = page.locator('.bottom-btn[aria-label="TAVOLI"]').first();
  await tablesButton.waitFor({ state: "visible", timeout: 10_000 });
  await tablesButton.click({ timeout: 10_000 });
  const title = page.locator(".topbar-title").first();
  if ((await title.innerText().catch(() => "")).trim().toUpperCase() === "BANCO") {
    await switchTablesWorkspaceMode(page, "TAVOLI");
  }
  await page
    .getByRole("searchbox", { name: "Ricerca tavoli" })
    .waitFor({ state: "visible", timeout: 10_000 });
}

async function openTable(page, tableNumber) {
  await ensureTablesWorkspace(page);
  const search = page.getByRole("searchbox", { name: "Ricerca tavoli" });
  await search.fill("");
  const tile = page
    .getByRole("button", {
      name: new RegExp(`Apri dettagli Tavolo ${tableNumber}$`, "u"),
    })
    .first();
  await tile.waitFor({ state: "visible", timeout: 10_000 });
  await tile.click({ timeout: 10_000 });
  const panel = page.locator(".table-detail-panel.is-open").first();
  await panel.waitFor({ state: "visible", timeout: 10_000 });
  return panel;
}

async function ensureOccupied(page, state) {
  const panel = await openTable(page, state.currentTableNumber);
  const occupy = panel.getByRole("button", { name: "Conferma occupazione", exact: true });
  if (await visible(occupy)) {
    const covers = panel.getByRole("spinbutton").first();
    if (await visible(covers)) await covers.fill("2");
    await occupy.click({ timeout: 10_000 });
  }
  await panel.getByRole("button", { name: "Ordina", exact: true }).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  return panel;
}

async function performOrder(page, state) {
  const panel = await ensureOccupied(page, state);
  await panel.getByRole("button", { name: "Ordina", exact: true }).click({ timeout: 10_000 });
  const composer = page.locator(".table-order-composer").first();
  await composer.waitFor({ state: "visible", timeout: 10_000 });
  await dismissStationWarning(page);
  const search = composer.getByPlaceholder("Cerca prodotto");
  await search.fill("Caffe");
  const product = composer.locator('.table-order-product-row[title="Caffe"]:not(:disabled)').first();
  await product.waitFor({ state: "visible", timeout: 10_000 });
  await product.click({ timeout: 10_000 });
  await product.click({ timeout: 10_000 });
  const submit = composer.locator("button.table-order-submit").first();
  const response = await captureMutationResponse(
    page,
    { kind: "ORDER_CREATE", expectedTableId: state.currentTableId || "" },
    () => submit.click({ timeout: 10_000 }),
  );
  const mutation = await validateB4WebMutationResponse(response, {
    kind: "ORDER_CREATE",
    expectedTableId: state.currentTableId || "",
  });
  state.currentTableId = mutation.tableId;
  state.lastOrderId = mutation.orderId;
  state.lastOrderLineIds = [...mutation.lineIds];
  await closeComposer(page);
  await closeDetail(page);
  return { ok: true, scenario: "ORDER_CREATE", orderCreated: true };
}

async function performTableSearch(page, state) {
  await ensureTablesWorkspace(page);
  const search = page.getByRole("searchbox", { name: "Ricerca tavoli" });
  await search.fill(String(state.currentTableNumber));
  await page
    .getByRole("button", {
      name: new RegExp(`Apri dettagli Tavolo ${state.currentTableNumber}$`, "u"),
    })
    .waitFor({ state: "visible", timeout: 10_000 });
  await search.fill("");
  return { ok: true, scenario: "TABLE_SEARCH" };
}

async function performBestSeller(page, state) {
  const panel = await ensureOccupied(page, state);
  await panel.getByRole("button", { name: "Ordina", exact: true }).click({ timeout: 10_000 });
  const composer = page.locator(".table-order-composer").first();
  await composer.waitFor({ state: "visible", timeout: 10_000 });
  await dismissStationWarning(page);
  const toggle = composer
    .getByRole("button", { name: /^(?:Attiva|Disattiva) best-seller$/u })
    .first();
  await toggle.click({ timeout: 10_000 });
  await closeComposer(page);
  await closeDetail(page);
  return { ok: true, scenario: "BEST_SELLER" };
}

async function performTableMove(page, state) {
  const panel = await ensureOccupied(page, state);
  const destination =
    state.currentTableNumber === state.primaryTableNumber
      ? state.alternateTableNumber
      : state.primaryTableNumber;
  await panel.getByRole("button", { name: "Sposta tavolo", exact: true }).click({ timeout: 10_000 });
  const picker = page.getByRole("dialog", { name: "Sposta tavolo", exact: true });
  await picker.waitFor({ state: "visible", timeout: 10_000 });
  const destinationRows = picker.locator("button.mobile-table-groups-row");
  let destinationRow = null;
  const destinationCount = await destinationRows.count();
  for (let index = 0; index < destinationCount; index += 1) {
    const candidate = destinationRows.nth(index);
    const text = normalizedString(await candidate.innerText()).replace(/\s+/gu, " ");
    if (
      new RegExp(`(?:^|\\s)Tavolo ${destination}(?:\\s|$)`, "u").test(text) &&
      text.includes("Destinazione libera")
    ) {
      destinationRow = candidate;
      break;
    }
  }
  if (!destinationRow) {
    fail("DOM_MOVE_TARGET_UNAVAILABLE", "The correlated move destination is not free");
  }
  await destinationRow.click({ timeout: 10_000 });
  const confirm = page.getByRole("dialog", {
    name: "Conferma spostamento tavolo",
    exact: true,
  });
  await confirm.waitFor({ state: "visible", timeout: 10_000 });
  const response = await captureMutationResponse(
    page,
    { kind: "TABLE_MOVE", expectedTableId: state.currentTableId || "" },
    async () => {
      await confirm
        .getByRole("button", { name: "CONFERMA", exact: true })
        .click({ timeout: 10_000 });
      await confirm.waitFor({ state: "hidden", timeout: 10_000 });
    },
  );
  const mutation = await validateB4WebMutationResponse(response, {
    kind: "TABLE_MOVE",
    expectedTableId: state.currentTableId || "",
  });
  const resolvedTitle = page
    .locator(".table-detail-panel.is-open .table-detail-title")
    .filter({ hasText: new RegExp(`^Tavolo ${destination}$`, "u") })
    .first();
  await resolvedTitle.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
  state.currentTableId = mutation.toTableId;
  state.currentTableNumber = destination;
  await closeDetail(page);
  return { ok: true, scenario: "TABLE_MOVE" };
}

async function performTablesCounterSwitch(page) {
  await ensureTablesWorkspace(page);
  await switchTablesWorkspaceMode(page, "BANCO");
  await dismissStationWarning(page);
  await switchTablesWorkspaceMode(page, "TAVOLI");
  await page
    .getByRole("searchbox", { name: "Ricerca tavoli" })
    .waitFor({ state: "visible", timeout: 10_000 });
  return { ok: true, scenario: "TABLES_COUNTER_SWITCH" };
}

async function performLegendFilter(page) {
  await ensureTablesWorkspace(page);
  const filter = page.getByRole("button", { name: /^Liberi \d+$/u }).first();
  await filter.waitFor({ state: "visible", timeout: 10_000 });
  await filter.click({ timeout: 10_000 });
  await filter.click({ timeout: 10_000 });
  return { ok: true, scenario: "LEGEND_FILTER" };
}

async function findHistoryOrderRow(panel, orderId) {
  const rows = panel.locator(".table-history-row");
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (normalizedString(await row.getAttribute("data-order-id")) === orderId) return row;
  }
  return null;
}

async function previewLineIds(preview) {
  const lines = preview.locator(".table-history-line[data-line-id]");
  const count = await lines.count();
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const lineId = normalizedString(await lines.nth(index).getAttribute("data-line-id"));
    if (lineId) ids.push(lineId);
  }
  return [...new Set(ids)];
}

async function selectLatestOrder(page, state, { allowReload = true } = {}) {
  const panel = await openTable(page, state.currentTableNumber);
  const expand = panel.getByRole("button", { name: "Espandi storico ordini", exact: true });
  if (await visible(expand)) await expand.click({ timeout: 10_000 });
  const row = state.lastOrderId
    ? await findHistoryOrderRow(panel, state.lastOrderId)
    : panel.locator(".table-history-row").first();
  if (!row) {
    if (allowReload) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT_MS });
      return selectLatestOrder(page, state, { allowReload: false });
    }
    fail("DOM_ORDER_SELECTION_INVALID", "The correlated order is absent after refresh");
  }
  await row.waitFor({ state: "visible", timeout: 10_000 });
  const rowActivator = row.locator(".table-history-copy").first();
  await rowActivator.waitFor({ state: "visible", timeout: 10_000 });
  await rowActivator.click({ timeout: 10_000 });
  const preview = panel.locator(".table-history-preview-card").first();
  await preview.waitFor({ state: "visible", timeout: 10_000 });
  const orderId = normalizedString(await preview.getAttribute("data-order-id"));
  const tableId = normalizedString(await preview.getAttribute("data-table-id"));
  const lineIds = await previewLineIds(preview);
  const expectedLineIds = Array.isArray(state.lastOrderLineIds) ? state.lastOrderLineIds : [];
  const canonicalLineMatched =
    expectedLineIds.length > 0 && expectedLineIds.some((lineId) => lineIds.includes(lineId));
  if (
    !orderId ||
    !tableId ||
    (state.currentTableId && tableId !== state.currentTableId) ||
    (state.lastOrderId && orderId !== state.lastOrderId) ||
    !canonicalLineMatched
  ) {
    if (allowReload) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT_MS });
      return selectLatestOrder(page, state, { allowReload: false });
    }
    fail("DOM_ORDER_SELECTION_INVALID", "The selected order is not the latest correlated order");
  }
  state.selectedOrderId = orderId;
  state.selectedOrderLineIds = lineIds;
  state.currentTableId = tableId;
  return panel;
}

async function performCorrection(page, state) {
  const panel = await selectLatestOrder(page, state);
  await panel.getByRole("button", { name: "Modifica comanda", exact: true }).click({ timeout: 10_000 });
  let dialog = page.getByRole("dialog", { name: "Gestisci comanda", exact: true });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog
    .locator("button.msr-choice-card")
    .filter({ hasText: "Modifica comanda" })
    .click({ timeout: 10_000 });
  dialog = page.getByRole("dialog", { name: "Modifica comanda", exact: true });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByRole("button", { name: "Aumenta quantita", exact: true }).first().click({ timeout: 10_000 });
  await dialog.getByPlaceholder("Motivo modifica").fill("Test workload GUI");
  const response = await captureMutationResponse(
    page,
    {
      kind: "ORDER_CORRECT",
      expectedOrderId: state.selectedOrderId,
      expectedTableId: state.currentTableId,
    },
    () =>
      dialog
        .getByRole("button", { name: "Invia modifica", exact: true })
        .click({ timeout: 10_000 }),
  );
  const mutation = await validateB4WebMutationResponse(response, {
    kind: "ORDER_CORRECT",
    expectedOrderId: state.selectedOrderId,
    expectedTableId: state.currentTableId,
  });
  if (mutation.lineIds.length > 0) state.lastOrderLineIds = [...mutation.lineIds];
  await dialog.waitFor({ state: "hidden", timeout: ACTION_TIMEOUT_MS });
  await closeDetail(page);
  return { ok: true, scenario: "ORDER_CORRECT" };
}

async function performReso(page, state) {
  const panel = await selectLatestOrder(page, state);
  await panel.getByRole("button", { name: "Reso", exact: true }).click({ timeout: 10_000 });
  const dialog = page.getByRole("dialog", { name: "Reso", exact: true });
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  await dialog.getByRole("button", { name: /^Seleziona /u }).first().click({ timeout: 10_000 });
  const partialQuantity = dialog.locator(".msr-replacement-qty-input").first();
  if (!(await visible(partialQuantity))) {
    fail("DOM_RESO_PARTIAL_UNAVAILABLE", "The correlated order cannot retain a residual item");
  }
  const maximumQuantity = Number(await partialQuantity.getAttribute("max"));
  if (!Number.isInteger(maximumQuantity) || maximumQuantity < 2) {
    fail("DOM_RESO_PARTIAL_UNAVAILABLE", "The correlated order cannot retain a residual item");
  }
  await partialQuantity.fill("1");
  await dialog.getByPlaceholder("Motivo operativo").fill("Test workload GUI");
  const response = await captureMutationResponse(
    page,
    {
      kind: "ORDER_RESO",
      expectedOrderId: state.selectedOrderId,
      expectedTableId: state.currentTableId,
    },
    () => dialog.getByRole("button", { name: "RESO", exact: true }).click({ timeout: 10_000 }),
  );
  const mutation = await validateB4WebMutationResponse(response, {
    kind: "ORDER_RESO",
    expectedOrderId: state.selectedOrderId,
    expectedTableId: state.currentTableId,
  });
  if (mutation.lineIds.length > 0) state.lastOrderLineIds = [...mutation.lineIds];
  await dialog.waitFor({ state: "hidden", timeout: ACTION_TIMEOUT_MS });
  await closeDetail(page);
  return { ok: true, scenario: "ORDER_RESO" };
}

async function performMenuSearch(page) {
  await ensureTablesWorkspace(page);
  const menu = page.locator('.bottom-btn[aria-label="MENU"]').first();
  await menu.click({ timeout: 10_000 });
  const search = page.getByPlaceholder("Cerca prodotti...");
  await search.waitFor({ state: "visible", timeout: 10_000 });
  await search.fill("Caffe");
  await search.fill("");
  await page.locator('.bottom-btn[aria-label="TAVOLI"]').first().click({ timeout: 10_000 });
  return { ok: true, scenario: "MENU_SEARCH" };
}

async function performTableOpenClose(page, state) {
  await openTable(page, state.currentTableNumber);
  await closeDetail(page);
  return { ok: true, scenario: "TABLE_OPEN_CLOSE" };
}

async function performDomAction({ page, state, ordinal, signal }) {
  assertNotAborted(signal);
  await recoverDomOverlays(page);
  try {
    const scenario = resolveDomScenario(ordinal);
    let result;
    if (scenario === "ORDER_CREATE") result = await performOrder(page, state);
    else if (scenario === "TABLE_SEARCH") result = await performTableSearch(page, state);
    else if (scenario === "BEST_SELLER") result = await performBestSeller(page, state);
    else if (scenario === "TABLE_MOVE") result = await performTableMove(page, state);
    else if (scenario === "TABLES_COUNTER_SWITCH") result = await performTablesCounterSwitch(page);
    else if (scenario === "LEGEND_FILTER") result = await performLegendFilter(page);
    else if (scenario === "ORDER_CORRECT") result = await performCorrection(page, state);
    else if (scenario === "ORDER_RESO") result = await performReso(page, state);
    else if (scenario === "MENU_SEARCH") result = await performMenuSearch(page);
    else result = await performTableOpenClose(page, state);
    assertNotAborted(signal);
    return { ...result, [DOM_EXECUTION_ATTESTATION]: true };
  } catch (error) {
    try {
      await recoverDomOverlays(page);
    } catch (recoveryError) {
      throw new B4WebWorkloadError(
        "DOM_RECOVERY_FAILED",
        `${error instanceof Error ? error.message : "DOM action failed"}; recovery: ${
          recoveryError instanceof Error ? recoveryError.message : "failed"
        }`,
      );
    }
    throw error;
  }
}

async function assertNoSymlinkComponents(targetPath) {
  const resolved = path.resolve(targetPath);
  const { root } = path.parse(resolved);
  let current = root;
  for (const component of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stats = await fs.lstat(current);
      if (stats.isSymbolicLink()) {
        fail("PRIVATE_ARTIFACT_PATH_UNSAFE", "Private artifact paths cannot contain symlinks");
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

async function ensurePrivateArtifactsDirectory(directory) {
  const resolved = path.resolve(directory);
  await assertNoSymlinkComponents(resolved);
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  await assertNoSymlinkComponents(resolved);
  const stats = await fs.lstat(resolved);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    fail("PRIVATE_ARTIFACT_PATH_UNSAFE", "Private artifact destination is not a directory");
  }
  await fs.chmod(resolved, 0o700);
  return resolved;
}

async function screenshotPages(pages, directory, label) {
  if (!directory) return;
  const safeDirectory = await ensurePrivateArtifactsDirectory(directory);
  for (let index = 0; index < pages.length; index += 1) {
    await assertNoSymlinkComponents(safeDirectory);
    const filePath = path.join(
      safeDirectory,
      `workload-${label}-${String(index + 1).padStart(2, "0")}.png`,
    );
    const screenshot = await pages[index].screenshot({ fullPage: false });
    await fs.writeFile(filePath, screenshot, { flag: "wx", mode: 0o600 });
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      fail("PRIVATE_ARTIFACT_PATH_UNSAFE", "Private screenshot is not a unique regular file");
    }
  }
}

function redactedDiagnosticError(error) {
  const code = normalizedString(error?.code).replace(/[^A-Z0-9_]/giu, "_").slice(0, 80) ||
    "DOM_ACTION_FAILED";
  const message = normalizedString(error instanceof Error ? error.message : error)
    .replace(/https?:\/\/\S+/giu, "[url]")
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/gu, "[path]")
    .replace(/\b(?:sess|token|device|user)_[A-Za-z0-9_-]+\b/giu, "[identifier]")
    .replace(/\b[0-9a-f]{24,}\b/giu, "[identifier]")
    .slice(0, 240);
  return { code, message: message || "DOM action failed" };
}

async function writePrivateDiagnostics(directory, diagnostics) {
  if (!directory) return;
  const safeDirectory = await ensurePrivateArtifactsDirectory(directory);
  const filePath = path.join(safeDirectory, "workload-private-diagnostics.json");
  const payload = `${JSON.stringify({
    schemaVersion: 1,
    mode: "B4_WEB_WORKLOAD_PRIVATE_DIAGNOSTICS",
    http: diagnostics.http,
    actionErrors: diagnostics.actionErrors,
    internalErrors: diagnostics.internalErrors,
  }, null, 2)}\n`;
  await fs.writeFile(filePath, payload, { flag: "wx", mode: 0o600 });
  const stats = await fs.lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    fail("PRIVATE_ARTIFACT_PATH_UNSAFE", "Private diagnostics is not a unique regular file");
  }
}

function attachDiagnostics(pages, privateDiagnostics) {
  const counters = {
    pageErrors: 0,
    consoleErrors: 0,
    httpFailures: 0,
    requestFailures: 0,
  };
  const pendingRequests = new Set();
  const registrations = [];
  const trackedRequest = (request) => {
    const method = normalizedString(request?.method?.()).toUpperCase();
    return !new Set(["", "GET", "HEAD", "OPTIONS"]).has(method) &&
      requestPath(request).startsWith("/api/");
  };
  for (const page of pages) {
    const onPageError = () => {
      counters.pageErrors += 1;
    };
    const onConsole = (message) => {
      if (message.type() === "error") counters.consoleErrors += 1;
    };
    const onResponse = (response) => {
      if (response.status() >= 400) counters.httpFailures += 1;
      const request = response.request?.();
      const pathname = request ? requestPath(request) : "";
      const method = normalizedString(request?.method?.()).toUpperCase();
      if (
        pathname.startsWith("/api/") &&
        (method === "POST" || Number(response.status()) >= 400) &&
        privateDiagnostics.http.length < 4_000
      ) {
        privateDiagnostics.http.push({
          method: method || "UNKNOWN",
          path: pathname,
          status: Number(response.status()) || 0,
        });
      }
    };
    const onRequestFailed = (request) => {
      pendingRequests.delete(request);
      const text = String(request.failure()?.errorText || "");
      if (!text.includes("ERR_ABORTED")) counters.requestFailures += 1;
    };
    const onRequest = (request) => {
      if (trackedRequest(request)) pendingRequests.add(request);
    };
    const onRequestFinished = (request) => pendingRequests.delete(request);
    for (const [event, listener] of [
      ["pageerror", onPageError],
      ["console", onConsole],
      ["response", onResponse],
      ["request", onRequest],
      ["requestfinished", onRequestFinished],
      ["requestfailed", onRequestFailed],
    ]) {
      page.on(event, listener);
      registrations.push({ page, event, listener });
    }
  }
  return {
    counters,
    pendingCount: () => pendingRequests.size,
    async waitForQuiescence({ wait, signal }) {
      let elapsedMs = 0;
      let quietMs = 0;
      while (elapsedMs <= QUIESCENCE_TIMEOUT_MS) {
        assertNotAborted(signal);
        if (pendingRequests.size === 0) {
          if (quietMs >= QUIESCENCE_QUIET_MS) return true;
          quietMs += QUIESCENCE_POLL_MS;
        } else {
          quietMs = 0;
        }
        await wait(QUIESCENCE_POLL_MS);
        elapsedMs += QUIESCENCE_POLL_MS;
      }
      return false;
    },
    cleanup() {
      let cleanupErrors = 0;
      for (const { page, event, listener } of registrations) {
        try {
          page.off(event, listener);
        } catch {
          cleanupErrors += 1;
        }
      }
      let remaining = cleanupErrors;
      for (const { page, event, listener } of registrations) {
        if (typeof page.listeners !== "function") {
          remaining += 1;
        } else if (page.listeners(event).includes(listener)) {
          remaining += 1;
        }
      }
      registrations.length = 0;
      pendingRequests.clear();
      return remaining;
    },
  };
}

function defaultMetrics() {
  return {
    completedActions: 0,
    successfulActions: 0,
    failedActions: 0,
    completedOrders: 0,
    maximumInFlightPerPalmare: 0,
    maximumInFlightGlobal: 0,
    plannedOperationTypes: 0,
    domScenarioTypes: 0,
    actionsOriginatedFromDom: 0,
    domExecutorBuiltIn: false,
    internalErrors: 0,
    pendingRequestsAtEnd: 0,
    quiescenceAchieved: false,
    pageErrors: 0,
    consoleErrors: 0,
    httpFailures: 0,
    requestFailures: 0,
    actionAverageGapMs: null,
    commandAverageGapMs: null,
    actionLatencyP95Ms: null,
    commandLatencyP95Ms: null,
    actionCadenceOk: false,
    commandCadenceOk: false,
    contexts: 0,
    pages: 0,
    sessions: 0,
    storageIsolated: false,
    contextOwnershipVerified: false,
    sessionPreserved: false,
    mobileViewportMatched: false,
    touchEnabled: false,
    resourcesAfterCleanup: 0,
    ledgerUnchanged: false,
  };
}

export async function runB4WebWorkload(
  pages,
  {
    request,
    envelope,
    actionExecutor = performDomAction,
    now = () => performance.now(),
    wait,
    signal,
    onProgress = () => undefined,
    verifyLedgerUnchanged = async () => false,
    privateArtifactsDir = null,
  } = {},
) {
  const validatedRequest = validateB4WebWorkloadRequest(request);
  const validatedEnvelope = validateB4WebWorkloadEnvelope(envelope, validatedRequest);
  const metrics = defaultMetrics();
  metrics.domExecutorBuiltIn = actionExecutor === performDomAction;
  const privateDiagnostics = { http: [], actionErrors: [], internalErrors: [] };
  const plan = buildB4WebWorkloadPlan();
  const pageStates = new Map(
    plan.map((entry, index) => [index, { ...entry, currentTableNumber: entry.primaryTableNumber }]),
  );
  let diagnostics = null;
  let initialIdentities = [];
  let scheduleResult = null;
  const emitProgress = () => {
    const completedActions = metrics.completedActions;
    try {
      onProgress({
        completedActions,
        completedOrders: metrics.completedOrders,
        totalActions: B4_WEB_WORKLOAD_TOTAL_ACTIONS,
        totalOrders: B4_WEB_WORKLOAD_TOTAL_ORDERS,
        percent: Math.min(
          100,
          Math.floor((completedActions / B4_WEB_WORKLOAD_TOTAL_ACTIONS) * 100),
        ),
      });
    } catch {
      // Reporting progress must not alter the evidence outcome.
    }
  };
  emitProgress();
  try {
    assertNotAborted(signal);
    if (!Array.isArray(pages) || pages.length !== B4_WEB_WORKLOAD_PAGE_COUNT) {
      fail("WORKLOAD_PAGE_COUNT_INVALID", "Exactly eight graphical pages are required");
    }
    if (pages.some((page) => page.isClosed())) {
      fail("WORKLOAD_PAGE_CLOSED", "A graphical Palmare page is closed");
    }
    initialIdentities = await Promise.all(pages.map(sessionIdentity));
    const tokens = new Set(initialIdentities.map((identity) => identity.token));
    const users = new Set(initialIdentities.map((identity) => identity.userId));
    const devices = new Set(initialIdentities.map((identity) => identity.deviceUuid));
    const contextInspection = inspectPageContexts(pages);
    metrics.contexts = contextInspection.contexts;
    metrics.contextOwnershipVerified = contextInspection.ownershipVerified;
    metrics.pages = contextInspection.totalPages;
    metrics.sessions = tokens.size;
    metrics.storageIsolated =
      initialIdentities.every(
        (identity) => identity.token && identity.userId && identity.deviceUuid,
      ) && tokens.size === 8 && users.size === 8 && devices.size === 8;
    metrics.mobileViewportMatched = pages.every((page) => {
      const viewport = page.viewportSize();
      return viewport?.width === 390 && viewport?.height === 844;
    });
    const touchChecks = await Promise.all(
      pages.map((page) => page.evaluate(() => navigator.maxTouchPoints > 0)),
    );
    metrics.touchEnabled = touchChecks.every(Boolean);
    if (
      metrics.contexts !== 8 ||
      !metrics.contextOwnershipVerified ||
      metrics.sessions !== 8 ||
      !metrics.storageIsolated ||
      !metrics.mobileViewportMatched ||
      !metrics.touchEnabled
    ) {
      fail("WORKLOAD_BROWSER_ISOLATION_INVALID", "The graphical Palmare bank is not isolated");
    }

    diagnostics = attachDiagnostics(pages, privateDiagnostics);
    await screenshotPages(pages, privateArtifactsDir, "start");
    const completedScenarios = new Set();
    scheduleResult = await runV6OperationsSchedule({
      devices: plan.map((entry) => ({
        id: `web-slot-${entry.logicalSlot}`,
        kind: "handheld",
        index: entry.index,
      })),
      actionsPerDevice: B4_WEB_WORKLOAD_ACTIONS_PER_DEVICE,
      actionIntervalMs: V6_DEVICE_ACTION_INTERVAL_MS,
      maxInFlightPerDevice: 1,
      maxInFlightGlobal: B4_WEB_WORKLOAD_PAGE_COUNT,
      now,
      wait: wait ?? ((milliseconds) => waitWithSignal(milliseconds, signal)),
      progressIntervalMs: 1_000,
      resolveActionType: ({ device, ordinal }) =>
        resolveB4WebWorkloadActionType({ deviceIndex: device.index, ordinal }),
      runAction: async ({ device, ordinal, actionType }) => {
        assertNotAborted(signal);
        const page = pages[device.index];
        const state = pageStates.get(device.index);
        const result = await actionExecutor({ page, state, ordinal, actionType, signal });
        const domAttested =
          metrics.domExecutorBuiltIn && result?.[DOM_EXECUTION_ATTESTATION] === true;
        if (result?.ok === true && domAttested) {
          completedScenarios.add(result.scenario);
          metrics.actionsOriginatedFromDom += 1;
        }
        return result;
      },
      isActionSuccessful: (result) => result?.ok === true,
      onActionCompleted: ({ device, ordinal, actionType, ok, error }) => {
        metrics.completedActions += 1;
        metrics.successfulActions += ok ? 1 : 0;
        metrics.failedActions += ok ? 0 : 1;
        if (ok && actionType === "order.create") metrics.completedOrders += 1;
        if (!ok) {
          privateDiagnostics.actionErrors.push({
            slot: Number(device.index) + 3,
            ordinal,
            actionType,
            ...redactedDiagnosticError(error),
          });
        }
        emitProgress();
      },
    });
    const finalIdentities = await Promise.all(pages.map(sessionIdentity));
    metrics.sessionPreserved = finalIdentities.every(
      (identity, index) => canonicalJson(identity) === canonicalJson(initialIdentities[index]),
    );
    metrics.completedActions = scheduleResult.totalCompleted;
    metrics.successfulActions = scheduleResult.totalSucceeded;
    metrics.failedActions = scheduleResult.totalFailed;
    metrics.completedOrders = scheduleResult.samples.filter(
      (sample) => sample.actionType === "order.create" && sample.ok === true,
    ).length;
    metrics.maximumInFlightPerPalmare = Math.max(
      ...scheduleResult.devices.map((device) => device.maximumInFlight),
    );
    metrics.maximumInFlightGlobal = scheduleResult.maximumInFlight;
    metrics.plannedOperationTypes = Object.keys(scheduleResult.plannedActionTypes).length;
    metrics.domScenarioTypes = completedScenarios.size;
    metrics.actionAverageGapMs = scheduleResult.cadence.mobileActionAverageGapMs;
    metrics.commandAverageGapMs = scheduleResult.cadence.commandAverageGapMs;
    metrics.actionCadenceOk = scheduleResult.cadence.mobileActionCadenceOk;
    metrics.commandCadenceOk = scheduleResult.cadence.commandCadenceOk;
    metrics.actionLatencyP95Ms = percentile(
      scheduleResult.samples.map((sample) => sample.durationMs).filter(Number.isFinite),
      0.95,
    );
    metrics.commandLatencyP95Ms = percentile(
      scheduleResult.samples
        .filter((sample) => sample.actionType === "order.create")
        .map((sample) => sample.durationMs)
        .filter(Number.isFinite),
      0.95,
    );
    await screenshotPages(pages, privateArtifactsDir, "end");
  } catch (error) {
    metrics.internalErrors += 1;
    privateDiagnostics.internalErrors.push(redactedDiagnosticError(error));
    if (privateArtifactsDir && Array.isArray(pages)) {
      const openPages = pages.filter((page) => {
        try {
          return !page.isClosed();
        } catch {
          return false;
        }
      });
      await screenshotPages(openPages, privateArtifactsDir, "failure").catch(() => undefined);
    }
  } finally {
    if (diagnostics) {
      const quiescenceWait = wait ?? ((milliseconds) => waitWithSignal(milliseconds, signal));
      try {
        metrics.quiescenceAchieved = await diagnostics.waitForQuiescence({
          wait: quiescenceWait,
          signal,
        });
      } catch {
        metrics.quiescenceAchieved = false;
        metrics.internalErrors += 1;
      }
      metrics.pendingRequestsAtEnd = diagnostics.pendingCount();
      Object.assign(metrics, diagnostics.counters);
      metrics.resourcesAfterCleanup = diagnostics.cleanup();
      if (metrics.resourcesAfterCleanup !== 0) metrics.internalErrors += 1;
    }
    try {
      metrics.ledgerUnchanged = (await verifyLedgerUnchanged()) === true;
    } catch {
      metrics.ledgerUnchanged = false;
      metrics.internalErrors += 1;
      privateDiagnostics.internalErrors.push({
        code: "LEDGER_VERIFICATION_FAILED",
        message: "Ledger verification callback failed",
      });
    }
    try {
      await writePrivateDiagnostics(privateArtifactsDir, privateDiagnostics);
    } catch (error) {
      metrics.internalErrors += 1;
      privateDiagnostics.internalErrors.push(redactedDiagnosticError(error));
    }
  }
  const report = buildB4WebWorkloadReport(metrics);
  return buildB4WebWorkloadResult({
    request: validatedRequest,
    envelope: validatedEnvelope,
    report,
  });
}
