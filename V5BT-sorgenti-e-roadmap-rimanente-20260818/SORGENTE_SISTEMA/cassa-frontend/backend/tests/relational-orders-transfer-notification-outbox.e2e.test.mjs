import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  apiPost,
  authPayload,
  createSimpleOrder,
  createTempRunDir,
  loginJson,
  startBackend,
} from "./helpers/test-server.mjs";

async function readOutboxPayloads(relationalPath) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(relationalPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT event_type, aggregate_id, payload_json FROM event_outbox ORDER BY id ASC")
      .all()
      .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
  } finally {
    db.close();
  }
}

test("[BE][MP-4be] transfer request/resolve scrivono notifiche realtime in event_outbox", async (t) => {
  const runDir = await createTempRunDir("rel-order-transfer-notification-outbox");
  const relationalPath = path.join(runDir, "backend-relational.sqlite");
  const { baseUrl } = await startBackend(t, {
    runDir,
    env: {
      BACKEND_RELATIONAL_ENABLED: "1",
      BACKEND_RELATIONAL_MODE: "shadow",
      BACKEND_RELATIONAL_DB_PATH: relationalPath,
      BACKEND_RELATIONAL_ORDERS_CREATE_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_TRANSFER_REQUEST_WRITE_PRIMARY: "1",
      BACKEND_RELATIONAL_ORDERS_TRANSFER_RESOLVE_WRITE_PRIMARY: "1",
      EVENT_OUTBOX_ENABLED: "1",
      PRINTING_ENABLED: "0",
      RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS: "orders",
    },
  });
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: "rel-order-transfer-notification-outbox-manager",
    clientApp: "mobile-frontend",
  });

  const created = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: "rel-order-transfer-notification-outbox-manager",
    extraPayload: { idempotencyKey: "mp4be-transfer-outbox-create" },
  });
  assert.equal(created.response.status, 200);

  const request = await apiPost(
    baseUrl,
    "/api/integration/orders/transfer/request",
    authPayload(manager, "rel-order-transfer-notification-outbox-manager", {
      orderId: created.body.order.id,
      mode: "transfer",
      requesterStation: "COCKTAIL",
      targetStation: "COCKTAIL",
      requesterOperator: "Manager Test",
      requesterRole: "Responsabile",
      expectedRevision: created.body.order.revision,
    }),
  );
  assert.equal(request.response.status, 200);

  const resolve = await apiPost(
    baseUrl,
    "/api/integration/orders/transfer/resolve",
    authPayload(manager, "rel-order-transfer-notification-outbox-manager", {
      orderId: request.body.order.id,
      approve: true,
      approverStation: request.body.order.pendingAuthRequest.fromStation,
      approverOperator: "Owner Test",
      expectedRevision: request.body.order.revision,
    }),
  );
  assert.equal(resolve.response.status, 200);

  const rows = await readOutboxPayloads(relationalPath);
  const transferRequest = rows.find((row) => row.payload?.reason === "transfer_request");
  const transferApproved = rows.find((row) => row.payload?.reason === "transfer_approved");
  assert.equal(transferRequest?.aggregate_id, created.body.order.id);
  assert.equal(transferRequest?.payload?.detail?.notification?.meta?.eventType, "transfer_request");
  assert.equal(transferRequest?.payload?.detail?.notificationId, transferRequest?.payload?.detail?.notification?.id);
  assert.equal(transferApproved?.aggregate_id, created.body.order.id);
  assert.equal(transferApproved?.payload?.detail?.approved, true);
  assert.equal(transferApproved?.payload?.detail?.notification?.meta?.eventType, "transfer_approved");
});
