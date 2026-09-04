import assert from "node:assert/strict";
import test from "node:test";

import {
  isTransientMysqlRouteError,
  retryTransientMysqlNotificationAckRequest,
  retryTransientMysqlPaymentRequest,
  shouldRetryTransientMysqlNotificationAckRequest,
  shouldRetryTransientMysqlPaymentRequest,
} from "../modules/integration/station-state-transient-retry.js";

test("ER_CHECKREAD viene trattato come contesa MySQL transiente", () => {
  assert.equal(isTransientMysqlRouteError(Object.assign(new Error("Record has changed since last read"), {
    code: "ER_CHECKREAD",
    errno: 1020,
  })), true);
  assert.equal(isTransientMysqlRouteError(new Error("Record has changed since last read in table domains")), true);
  assert.equal(isTransientMysqlRouteError(new Error("Errore applicativo permanente")), false);
});

test("la lane pagamenti ritenta ER_CHECKREAD prima di esporre HTTP 500", async () => {
  const req = {
    method: "POST",
    __requestMetricsContext: {
      requestId: "req-payment-retry",
      mysqlRetryCount: 0,
      mysqlRetryScopes: [],
      mysqlRetryCodes: [],
      mysqlRetryStages: [],
      mysqlRetryLabels: [],
    },
  };
  const res = { headersSent: false, writableEnded: false };
  const error = Object.assign(new Error("Record has changed since last read"), {
    code: "ER_CHECKREAD",
    errno: 1020,
  });
  const isPaymentLaneRequest = (method, pathname) =>
    method === "POST" && pathname === "/api/payments/free-split";
  assert.equal(shouldRetryTransientMysqlPaymentRequest({
    req,
    res,
    pathname: "/api/payments/free-split",
    error,
    isPaymentLaneRequest,
  }), true);

  let retried = 0;
  const handled = await retryTransientMysqlPaymentRequest({
    req,
    res,
    pathname: "/api/payments/free-split",
    error,
    isPaymentLaneRequest,
    retry: async () => {
      retried += 1;
    },
  });
  assert.equal(handled, true);
  assert.equal(retried, 1);
  assert.equal(req.__transientMysqlPaymentRetryCount, 1);
  assert.equal(req.__requestMetricsContext.mysqlRetryCount, 1);
  assert.deepEqual(req.__requestMetricsContext.mysqlRetryScopes, ["payment"]);
  assert.deepEqual(req.__requestMetricsContext.mysqlRetryCodes, ["ER_CHECKREAD"]);
  assert.deepEqual(req.__requestMetricsContext.mysqlRetryLabels, [
    "/api/payments/free-split",
  ]);
});

test("notification ack ritenta soltanto la route idempotente su errore MySQL transiente", async () => {
  const req = {
    method: "POST",
    __requestMetricsContext: {
      requestId: "req-notification-ack-retry",
      mysqlRetryCount: 0,
      mysqlRetryScopes: [],
      mysqlRetryCodes: [],
      mysqlRetryStages: [],
      mysqlRetryLabels: [],
    },
  };
  const res = { headersSent: false, writableEnded: false };
  const error = Object.assign(new Error("Deadlock found when trying to get lock"), {
    code: "ER_LOCK_DEADLOCK",
    errno: 1213,
  });
  const pathname = "/api/integration/notifications/ack";

  assert.equal(shouldRetryTransientMysqlNotificationAckRequest({
    req,
    res,
    pathname,
    error,
  }), true);
  assert.equal(shouldRetryTransientMysqlNotificationAckRequest({
    req,
    res,
    pathname: "/api/integration/notifications/publish",
    error,
  }), false);

  let retried = 0;
  const handled = await retryTransientMysqlNotificationAckRequest({
    req,
    res,
    pathname,
    error,
    retry: async () => {
      retried += 1;
    },
  });

  assert.equal(handled, true);
  assert.equal(retried, 1);
  assert.equal(req.__transientMysqlNotificationAckRetryCount, 1);
  assert.deepEqual(req.__requestMetricsContext.mysqlRetryScopes, ["notification-ack"]);
  assert.deepEqual(req.__requestMetricsContext.mysqlRetryCodes, ["ER_LOCK_DEADLOCK"]);
});
