import test from "node:test";
import assert from "node:assert/strict";
import { apiPost, authPayload, loginJson, readJson, startBackend } from "./helpers/test-server.mjs";

test("[BE][P0] stato sessione vendita chiusa", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const cashier = await loginJson(baseUrl, "cashier", "2222", {
    deviceUuid: "cashier-sales-status",
    clientApp: "cassa-frontend",
  });

  const status = await apiPost(
    baseUrl,
    "/api/sales/sessions/status",
    authPayload(cashier, "cashier-sales-status")
  );

  assert.equal(status.response.status, 200);
  assert.equal(status.body.ok, true);
  assert.equal(status.body.activeSaleSession, null);
  assert.equal(status.body.canManageSaleSessions, false);
  assert.ok(Array.isArray(status.body.templates));

  const persisted = await readJson(dbPath);
  assert.equal(persisted.saleSessions.length, 0);
});

test("[BE][P0] apertura sessione vendita crea una sola sessione attiva", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const admin = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "admin-sales-open",
    clientApp: "cassa-frontend",
  });

  const opened = await apiPost(
    baseUrl,
    "/api/sales/sessions/open",
    authPayload(admin, "admin-sales-open", { templateId: "shift_day" })
  );
  assert.equal(opened.response.status, 200);
  assert.equal(opened.body.ok, true);
  assert.equal(opened.body.activeSaleSession.templateId, "shift_day");
  assert.equal(opened.body.activeSaleSession.startedByUserId, "u_admin");
  assert.match(opened.body.activeSaleSession.businessDate, /^\d{4}-\d{2}-\d{2}$/);

  const duplicate = await apiPost(
    baseUrl,
    "/api/sales/sessions/open",
    authPayload(admin, "admin-sales-open", { templateId: "shift_day" })
  );
  assert.equal(duplicate.response.status, 409);

  const persisted = await readJson(dbPath);
  assert.equal(persisted.saleSessions.filter((entry) => !entry.endedAt).length, 1);
  assert.ok(persisted.auditEvents.some((entry) => entry.action === "shift.opened"));
});

test("[BE][P0] chiusura sessione vendita salva metadata e audit", async (t) => {
  const { baseUrl, dbPath } = await startBackend(t);
  const admin = await loginJson(baseUrl, "admin_test", "1111", {
    deviceUuid: "admin-sales-open-close",
    clientApp: "cassa-frontend",
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "manager-sales-close",
    clientApp: "cassa-frontend",
  });

  const opened = await apiPost(
    baseUrl,
    "/api/sales/sessions/open",
    authPayload(admin, "admin-sales-open-close", { templateId: "shift_day" })
  );
  assert.equal(opened.response.status, 200);

  const closed = await apiPost(
    baseUrl,
    "/api/sales/sessions/close",
    authPayload(manager, "manager-sales-close")
  );
  assert.equal(closed.response.status, 200);
  assert.equal(closed.body.activeSaleSession, null);
  assert.equal(closed.body.recentSaleSessions[0].endedByUserId, "u_manager");

  const persisted = await readJson(dbPath);
  assert.equal(persisted.saleSessions.length, 1);
  assert.equal(persisted.saleSessions[0].endedByUserId, "u_manager");
  assert.equal(persisted.saleSessions[0].endedByUsername, "manager");
  assert.ok(persisted.saleSessions[0].endedAt);
  assert.ok(persisted.auditEvents.some((entry) => entry.action === "shift.closed"));
});
