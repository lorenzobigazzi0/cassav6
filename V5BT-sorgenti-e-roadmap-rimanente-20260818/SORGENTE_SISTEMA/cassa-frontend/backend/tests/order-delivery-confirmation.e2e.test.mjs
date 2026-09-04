import test from "node:test";
import assert from "node:assert/strict";

import {
  apiPost,
  authPayload,
  createSimpleOrder,
  loginJson,
  startBackend,
} from "./helpers/test-server.mjs";

const MANAGER_DEVICE = "manager-delivery-device";

async function saveOrderWorkflow(baseUrl, session, orderWorkflow) {
  const { response, body } = await apiPost(
    baseUrl,
    "/api/settings/order-workflow",
    authPayload(session, MANAGER_DEVICE, { orderWorkflow }),
  );
  assert.equal(response.status, 200);
  assert.equal(body?.ok, true);
  return body.orderWorkflow;
}

async function syncOrderWorkflowStatus(baseUrl, session, orderId, workflowStatus) {
  return apiPost(
    baseUrl,
    "/api/integration/orders/sync",
    authPayload(session, MANAGER_DEVICE, {
      id: orderId,
      order: { workflowStatus },
    }),
  );
}

async function readOrder(baseUrl, orderId) {
  // includeDone: le comande consegnate sono escluse dall'elenco operativo di default.
  const response = await fetch(`${baseUrl}/api/integration/orders?includeDone=1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  const orders = Array.isArray(body?.orders) ? body.orders : [];
  return orders.find((entry) => String(entry?.id ?? "") === String(orderId)) ?? null;
}

test("il Pronta della postazione consegna da solo quando la conferma e disattivata", async (t) => {
  const { baseUrl } = await startBackend(t);
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: MANAGER_DEVICE,
    clientApp: "mobile-frontend",
  });
  const workflow = await saveOrderWorkflow(baseUrl, manager, {
    deliveryConfirmationEnabled: false,
  });
  assert.equal(workflow.deliveryConfirmationEnabled, false);
  // A conferma disattivata il backend forza a false anche i due vincoli dipendenti.
  assert.equal(workflow.requireReadyForDelivery, false);
  assert.equal(workflow.requireDeliveredForPayment, false);

  const { body: created } = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: MANAGER_DEVICE,
  });
  const orderId = String(created?.order?.id ?? created?.id ?? "");
  assert.ok(orderId, "la comanda di prova deve avere un id");

  const { response } = await syncOrderWorkflowStatus(baseUrl, manager, orderId, "ready");
  assert.equal(response.status, 200);

  const stored = await readOrder(baseUrl, orderId);
  assert.equal(stored?.workflowStatus, "delivered");
});

test("con la conferma attiva il Pronta lascia la comanda in ready", async (t) => {
  const { baseUrl } = await startBackend(t);
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: MANAGER_DEVICE,
    clientApp: "mobile-frontend",
  });
  await saveOrderWorkflow(baseUrl, manager, {
    deliveryConfirmationEnabled: true,
    requireReadyForDelivery: true,
    requireDeliveredForPayment: true,
  });

  const { body: created } = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: MANAGER_DEVICE,
  });
  const orderId = String(created?.order?.id ?? created?.id ?? "");
  assert.ok(orderId, "la comanda di prova deve avere un id");

  const { response } = await syncOrderWorkflowStatus(baseUrl, manager, orderId, "ready");
  assert.equal(response.status, 200);

  const readyOrder = await readOrder(baseUrl, orderId);
  assert.equal(readyOrder?.workflowStatus, "ready");

  // Il Segna consegnato del palmare passa dalla stessa rotta di sync.
  const delivered = await syncOrderWorkflowStatus(baseUrl, manager, orderId, "delivered");
  assert.equal(delivered.response.status, 200);
  const deliveredOrder = await readOrder(baseUrl, orderId);
  assert.equal(deliveredOrder?.workflowStatus, "delivered");
});

test("spegnere la conferma consegna retroattivamente le comande gia pronte", async (t) => {
  const { baseUrl } = await startBackend(t);
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: MANAGER_DEVICE,
    clientApp: "mobile-frontend",
  });
  await saveOrderWorkflow(baseUrl, manager, {
    deliveryConfirmationEnabled: true,
    requireReadyForDelivery: true,
    requireDeliveredForPayment: true,
  });

  const { body: created } = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: MANAGER_DEVICE,
  });
  const orderId = String(created?.order?.id ?? created?.id ?? "");
  assert.ok(orderId, "la comanda di prova deve avere un id");
  await syncOrderWorkflowStatus(baseUrl, manager, orderId, "ready");
  assert.equal((await readOrder(baseUrl, orderId))?.workflowStatus, "ready");

  await saveOrderWorkflow(baseUrl, manager, { deliveryConfirmationEnabled: false });

  const stored = await readOrder(baseUrl, orderId);
  assert.equal(stored?.workflowStatus, "delivered");
});

test("il sync ordini senza credenziali di sessione viene respinto", async (t) => {
  const { baseUrl } = await startBackend(t);
  const manager = await loginJson(baseUrl, "manager", "4444", {
    deviceUuid: MANAGER_DEVICE,
    clientApp: "mobile-frontend",
  });
  const { body: created } = await createSimpleOrder(baseUrl, manager, {
    deviceUuid: MANAGER_DEVICE,
  });
  const orderId = String(created?.order?.id ?? created?.id ?? "");
  assert.ok(orderId, "la comanda di prova deve avere un id");

  // Regressione: era il payload che il mobile inviava per Segna consegnato.
  const { response } = await apiPost(baseUrl, "/api/integration/orders/sync", {
    id: orderId,
    order: { workflowStatus: "delivered" },
  });
  assert.equal(response.status, 401);
});
