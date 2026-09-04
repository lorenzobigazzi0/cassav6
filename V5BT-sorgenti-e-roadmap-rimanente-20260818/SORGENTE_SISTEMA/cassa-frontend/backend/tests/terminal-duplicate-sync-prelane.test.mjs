import assert from "node:assert/strict";
import test from "node:test";

import { tryHandleTerminalDuplicateOrderSyncPreLane } from "../modules/orders/terminal-duplicate-sync-prelane.js";

function createResponseCapture() {
  const capture = { status: 0, body: null };
  return {
    capture,
    sendJson(_res, status, body) {
      capture.status = status;
      capture.body = body;
    },
  };
}

test("sync terminale duplicata usa il relazionale quando il write-primary e attivo", async () => {
  const req = {
    method: "POST",
    __jsonBodyPayload: {
      id: "00042",
      order: {
        id: "00042",
        workflowStatus: "ready",
      },
    },
  };
  const res = {};
  const counters = [];
  const operations = [];
  let appStateLookupCalled = false;
  let relationalLookupId = "";
  let readDbOptions = null;
  const { capture, sendJson } = createResponseCapture();

  const handled = await tryHandleTerminalDuplicateOrderSyncPreLane(
    req,
    res,
    "/api/integration/orders/sync",
    {
      applyCors() {},
      findIntegrationOrderIndexByLookup() {
        appStateLookupCalled = true;
        return -1;
      },
      isIntegrationOrderCancelled: () => false,
      mergeRequestAuthPayload: (_req, payload) => payload,
      normalizeIntegrationWorkflowStatus: (value) => String(value ?? "").trim(),
      orderLaneMetricLabeler: { rememberOrder() {} },
      readDb: async (options = {}) => {
        readDbOptions = options;
        return { sessions: [] };
      },
      readRelationalOrderById: async (orderId) => {
        relationalLookupId = orderId;
        return {
          id: orderId,
          workflowStatus: "ready",
          revision: 7,
          currentRevision: 7,
        };
      },
      relationalSyncWritePrimary: true,
      runtimeMetrics: {
        incrementCounter: (name) => counters.push(name),
        recordOperation: (_scope, label) => operations.push(label),
      },
      sanitizeIntegrationOrder: (order) => order,
      sendJson,
      validateSessionContext() {},
    },
  );

  assert.equal(handled, true);
  assert.equal(appStateLookupCalled, false);
  assert.equal(relationalLookupId, "00042");
  assert.deepEqual(readDbOptions, {
    refreshExternalizedSessions: true,
  });
  assert.equal(capture.status, 200);
  assert.equal(capture.body.idempotent, true);
  assert.equal(capture.body.noop, true);
  assert.equal(capture.body.preLane, true);
  assert.equal(capture.body.source, "relational");
  assert.equal(capture.body.order.revision, 7);
  assert.ok(counters.includes("orderTerminalDuplicateSyncNoops"));
  assert.ok(counters.includes("orderTerminalDuplicateSyncPreLaneNoops"));
  assert.ok(counters.includes("orderTerminalDuplicateSyncRelationalPreLaneNoops"));
  assert.deepEqual(operations, []);
});

test("sync terminale duplicata usa il refresh app-state puntuale quando MySQL split e attivo", async () => {
  const req = {
    method: "POST",
    __jsonBodyPayload: {
      id: "00043",
      order: {
        id: "00043",
        workflowStatus: "ready",
      },
    },
  };
  const { capture, sendJson } = createResponseCapture();
  let relationalLookupCalled = false;
  let readDbOptions = null;

  const handled = await tryHandleTerminalDuplicateOrderSyncPreLane(
    req,
    {},
    "/api/integration/orders/sync",
    {
      applyCors() {},
      appStateOrderTargetedRefresh: true,
      findIntegrationOrderIndexByLookup: () => 0,
      isIntegrationOrderCancelled: () => false,
      mergeRequestAuthPayload: (_req, payload) => payload,
      normalizeIntegrationWorkflowStatus: (value) => String(value ?? "").trim(),
      orderLaneMetricLabeler: { rememberOrder() {} },
      readDb: async (options = {}) => {
        readDbOptions = options;
        return {
          integration: {
            orders: [
              {
                id: "00043",
                workflowStatus: "ready",
                revision: 3,
                currentRevision: 3,
              },
            ],
          },
          sessions: [],
        };
      },
      readRelationalOrderById: async () => {
        relationalLookupCalled = true;
        return null;
      },
      relationalSyncWritePrimary: false,
      runtimeMetrics: {
        incrementCounter() {},
        recordOperation() {},
      },
      sanitizeIntegrationOrder: (order) => order,
      sendJson,
      validateSessionContext() {},
    },
  );

  assert.equal(handled, true);
  assert.equal(relationalLookupCalled, false);
  assert.deepEqual(readDbOptions, {
    refreshExternalizedSessions: true,
    refreshExternalizedIntegrationOrderId: "00043",
  });
  assert.equal(capture.status, 200);
  assert.equal(capture.body.source, "appState");
  assert.equal(capture.body.order.revision, 3);
});

test("sync terminale con payload completo salta il prelane senza leggere il DB", async () => {
  let readDbCalls = 0;
  const operations = [];
  const handled = await tryHandleTerminalDuplicateOrderSyncPreLane(
    {
      method: "POST",
      __jsonBodyPayload: {
        id: "00044",
        order: {
          id: "00044",
          workflowStatus: "ready",
          items: [{ id: "line_1", done: true }],
        },
      },
    },
    {},
    "/api/integration/orders/sync",
    {
      normalizeIntegrationWorkflowStatus: (value) => String(value ?? "").trim(),
      readDb: async () => {
        readDbCalls += 1;
        return {};
      },
      runtimeMetrics: {
        recordOperation: (_scope, label) => operations.push(label),
      },
    },
  );

  assert.equal(handled, false);
  assert.equal(readDbCalls, 0);
  assert.deepEqual(operations, ["terminalDuplicatePreLane.skip.fullPayload"]);
});
