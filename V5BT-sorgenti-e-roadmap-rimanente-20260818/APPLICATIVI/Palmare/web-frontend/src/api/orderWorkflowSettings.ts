import { apiFetch } from "./baseUrl";
import { publishSettingsVersion } from "../shared/settings/settingsVersionEvents";

export type OrderWorkflowSettings = {
  deliveryConfirmationEnabled: boolean;
  requireReadyForDelivery: boolean;
  requireDeliveredForPayment: boolean;
};

export type OrderWorkflowAuth = {
  token: string;
  userId: string;
  username?: string | null;
  deviceUuid: string;
  roomId?: string | null;
};

/**
 * Allineato al default del backend (`sanitizeOrderWorkflowSettings`, che legge ogni flag con
 * `!== false`): in assenza di dati tutto e attivo. E anche il fallback sicuro quando il fetch
 * fallisce — con `deliveryConfirmationEnabled: false` un errore di rete farebbe sparire il
 * pulsante "Segna consegnato" senza che la consegna automatica sia davvero configurata.
 */
export const DEFAULT_ORDER_WORKFLOW_SETTINGS: OrderWorkflowSettings = {
  deliveryConfirmationEnabled: true,
  requireReadyForDelivery: true,
  requireDeliveredForPayment: true,
};

const normalizeOrderWorkflowSettings = (value: unknown): OrderWorkflowSettings => {
  if (!value || typeof value !== "object") return DEFAULT_ORDER_WORKFLOW_SETTINGS;
  const source = value as Record<string, unknown>;
  const deliveryConfirmationEnabled = source.deliveryConfirmationEnabled !== false;
  return {
    deliveryConfirmationEnabled,
    requireReadyForDelivery:
      deliveryConfirmationEnabled && source.requireReadyForDelivery !== false,
    requireDeliveredForPayment:
      deliveryConfirmationEnabled && source.requireDeliveredForPayment !== false,
  };
};

const authPayload = (auth: OrderWorkflowAuth, extra: Record<string, unknown> = {}) => ({
  token: auth.token,
  userId: auth.userId,
  username: auth.username ?? "",
  deviceUuid: auth.deviceUuid,
  roomId: auth.roomId ?? "",
  clientApp: "mobile-frontend",
  ...extra,
});

export async function fetchOrderWorkflowSettings(
  auth: OrderWorkflowAuth
): Promise<OrderWorkflowSettings> {
  const response = await apiFetch("/api/settings/pos", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(authPayload(auth)),
  });
  const payload = (await response.json().catch(() => null)) as {
    ok?: unknown;
    orderWorkflow?: unknown;
  } | null;
  if (!response.ok || payload?.ok !== true) {
    throw new Error("Impossibile caricare le impostazioni comande.");
  }
  publishSettingsVersion(payload, "order-workflow-fetch");
  return normalizeOrderWorkflowSettings(payload.orderWorkflow);
}

export async function saveOrderWorkflowSettings(
  auth: OrderWorkflowAuth,
  settings: OrderWorkflowSettings
): Promise<OrderWorkflowSettings> {
  const response = await apiFetch("/api/settings/order-workflow", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(authPayload(auth, { orderWorkflow: settings })),
  });
  const payload = (await response.json().catch(() => null)) as {
    ok?: unknown;
    error?: unknown;
    message?: unknown;
    orderWorkflow?: unknown;
  } | null;
  if (!response.ok || payload?.ok === false) {
    const message = String(payload?.error ?? payload?.message ?? "").trim();
    throw new Error(message || "Impossibile salvare le impostazioni comande.");
  }
  publishSettingsVersion(payload, "order-workflow-save");
  return normalizeOrderWorkflowSettings(payload?.orderWorkflow ?? settings);
}
