import { apiFetch } from "./baseUrl";

export type HistoryPrintKind = "order" | "preconto";

export type HistoryPrintAuth = {
  token: string | null;
  userId: string | null;
  username?: string | null;
  fullName?: string | null;
  deviceUuid: string | null;
};

export type HistoryPrintResult = {
  jobId?: string;
  printer?: string;
};

type HistoryPrintResponse = {
  ok?: unknown;
  error?: unknown;
  message?: unknown;
  jobId?: unknown;
  printer?: unknown;
};

const errorMessageFromPayload = (payload: HistoryPrintResponse | null, fallback: string) => {
  const message = String(payload?.error ?? payload?.message ?? "").trim();
  return message || fallback;
};

export async function printHistoryOrder(
  auth: HistoryPrintAuth,
  params: { activityId?: string | null; roomId?: string | null; orderId: string; kind: HistoryPrintKind }
): Promise<HistoryPrintResult> {
  const token = String(auth.token ?? "").trim();
  const userId = String(auth.userId ?? "").trim();
  const deviceUuid = String(auth.deviceUuid ?? "").trim();
  const orderId = String(params.orderId ?? "").trim();
  const kind = params.kind === "order" ? "order" : "preconto";
  const activityId = String(params.activityId ?? "").trim();
  const roomId = String(params.roomId ?? "").trim();

  if (!token || !userId || !deviceUuid) {
    throw new Error("Sessione login richiesta per stampare.");
  }
  if (!orderId) {
    throw new Error("Comanda non valida.");
  }

  const response = await apiFetch("/api/integration/print", {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Device-Uuid": deviceUuid,
      "X-User-Id": userId,
    },
    body: JSON.stringify({
      token,
      userId,
      username: auth.username ?? "",
      fullName: auth.fullName ?? "",
      deviceUuid,
      kind,
      orderId,
      ignoreWorkstationRouting: true,
      ...(activityId ? { activityId, operationalActivityId: activityId, operationalSchemaVersion: 2 } : {}),
      ...(roomId ? { roomId, operationalRoomId: roomId } : {}),
      clientApp: "mobile-history-print",
    }),
  });

  const payload = (await response.json().catch(() => null)) as HistoryPrintResponse | null;
  if (!response.ok || payload?.ok === false) {
    throw new Error(errorMessageFromPayload(payload, "Stampa non riuscita."));
  }

  return {
    jobId: String(payload?.jobId ?? "").trim() || undefined,
    printer: String(payload?.printer ?? "").trim() || undefined,
  };
}

export async function printTablePreconto(
  auth: HistoryPrintAuth,
  params: {
    activityId?: string | null;
    roomId?: string | null;
    tableId: string;
    tableNumber: number;
    tableLabel?: string;
    amountDue: number;
    orders: Array<{ id: string; title?: string; total: number; createdAt?: number }>;
    mode?: "complete" | "current";
  }
): Promise<HistoryPrintResult> {
  const token = String(auth.token ?? "").trim();
  const userId = String(auth.userId ?? "").trim();
  const deviceUuid = String(auth.deviceUuid ?? "").trim();
  const tableId = String(params.tableId ?? "").trim();
  const activityId = String(params.activityId ?? "").trim();
  const roomId = String(params.roomId ?? "").trim();

  if (!token || !userId || !deviceUuid) {
    throw new Error("Sessione login richiesta per stampare.");
  }
  if (!tableId) {
    throw new Error("Tavolo non valido.");
  }

  const label = String(params.tableLabel ?? "").trim() || `Tavolo ${params.tableNumber}`;
  const orders = Array.isArray(params.orders) ? params.orders : [];
  const mode = params.mode === "current" ? "current" : "complete";

  const response = await apiFetch("/api/integration/print", {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Device-Uuid": deviceUuid,
      "X-User-Id": userId,
    },
    body: JSON.stringify({
      token,
      userId,
      username: auth.username ?? "",
      fullName: auth.fullName ?? "",
      deviceUuid,
      kind: "preconto",
      ignoreWorkstationRouting: true,
      ...(activityId ? { activityId, operationalActivityId: activityId, operationalSchemaVersion: 2 } : {}),
      ...(roomId ? { roomId, operationalRoomId: roomId } : {}),
      tablePreconto: true,
      tablePrecontoMode: mode,
      tableId,
      tableNumber: params.tableNumber,
      tableLabel: label,
      amountDue: params.amountDue,
      orderIds: orders.map((order) => order.id).filter(Boolean),
      clientApp: "mobile-table-preconto",
    }),
  });

  const payload = (await response.json().catch(() => null)) as HistoryPrintResponse | null;
  if (!response.ok || payload?.ok === false) {
    throw new Error(errorMessageFromPayload(payload, "Stampa preconto totale non riuscita."));
  }

  return {
    jobId: String(payload?.jobId ?? "").trim() || undefined,
    printer: String(payload?.printer ?? "").trim() || undefined,
  };
}
