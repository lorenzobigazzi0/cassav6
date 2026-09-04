import { apiJson, ApiError } from "./baseUrl";
import type { ApiFetchOptions } from "./baseUrl";
import { AUTH_STORAGE_KEYS, readAuthStorage } from "../shared/storage/authStorage";
import type { AutomaticCashSettlementRecord } from "../utils/automaticCashSettlementArchive";
import type {
  AutomaticCashApiError,
  AutomaticCashApiErrorCode,
  AutomaticCashApiErrorPayload,
  AutomaticCashGatewayState,
  AutomaticCashGatewayCommandRequest,
  AutomaticCashGatewayCommandResponse,
  AutomaticCashPreflight,
  AutomaticCashSettings,
  AutomaticCashStatus,
  CancelAutomaticCashDepositRequest,
  CancelAutomaticCashDepositResponse,
  CloseAutomaticCashDepositRequest,
  CloseAutomaticCashDepositResponse,
  ConfirmAutomaticCashFloatRemovedRequest,
  ConfirmAutomaticCashFloatRemovedResponse,
  ConfirmAutomaticCashFloatTicketInPouchRequest,
  ConfirmAutomaticCashFloatTicketInPouchResponse,
  GenerateAutomaticCashFloatRequest,
  GenerateAutomaticCashFloatResponse,
  LoadAutomaticCashFloatFromQrRequest,
  LoadAutomaticCashFloatFromQrResponse,
  MarkAutomaticCashFloatTicketPrintedRequest,
  MarkAutomaticCashFloatTicketPrintedResponse,
  StartAutomaticCashDepositRequest,
  StartAutomaticCashDepositResponse,
  StartAutomaticCashPaymentRequest,
  StartAutomaticCashPaymentResponse,
  UpdateAutomaticCashSettingsRequest,
  UploadAutomaticCashConfigSetRequest,
  UploadAutomaticCashReserveConfigRequest,
  AutomaticCashPaymentStateResponse,
  ActiveCashMovementResponse,
  CancelAutomaticCashPaymentResponse,
  CashMovementListResponse,
  CashMovementResponse,
  CashMovementStateResponse,
  CashMovementWithdrawalAvailabilityResponse,
  CompleteAutomaticCashPaymentRequest,
  CompleteAutomaticCashPaymentResponse,
  StartCashMovementRequest,
  PrintCashMovementReportRequest,
  PrintCashMovementReportResponse,
} from "../types/automaticCash";

const BASE = "/api/automatic-cash";
const PHYSICAL_CASH_TIMEOUT_MS = 130_000;
const JSON_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
} as const;

function buildAutomaticCashHeaders(includeJsonHeaders = true): Record<string, string> {
  const token = String(readAuthStorage(AUTH_STORAGE_KEYS.token) ?? "").trim();
  const userId = String(readAuthStorage(AUTH_STORAGE_KEYS.userId) ?? "").trim();
  const deviceUuid = String(readAuthStorage(AUTH_STORAGE_KEYS.deviceUuid) ?? "").trim();
  return {
    ...(includeJsonHeaders ? JSON_HEADERS : { Accept: "application/json" }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(userId ? { "X-User-Id": userId } : {}),
    ...(deviceUuid ? { "X-Device-Uuid": deviceUuid } : {}),
  };
}

function withPhysicalCashTimeout(options?: ApiFetchOptions): ApiFetchOptions {
  return {
    ...options,
    timeoutMs: Math.max(options?.timeoutMs ?? 0, PHYSICAL_CASH_TIMEOUT_MS),
  };
}

const KNOWN_ERROR_CODES = new Set<AutomaticCashApiErrorCode>([
  "BAD_REQUEST",
  "AUTOMATIC_CASH_LOCKED",
  "FCA_ACTIVE_WORKFLOW",
  "FCA_INVENTORY_UNAVAILABLE",
  "FCA_NO_FEASIBLE_CONFIGURATION",
  "FCA_CONFIG_POOL_EXHAUSTED",
  "FCA_RESERVE_CONFIG_INVALID",
  "FCA_GATEWAY_UNREACHABLE",
  "FCA_WORKFLOW_STEP_CONFLICT",
  "AUTOMATIC_CASH_NOT_CONFIGURED",
  "AUTOMATIC_CASH_DISABLED",
  "AUTOMATIC_CASH_GATEWAY_UNREACHABLE",
  "AUTOMATIC_CASH_QR_INVALID",
  "AUTOMATIC_CASH_QR_USED",
  "AUTOMATIC_CASH_OPERATION_NOT_FOUND",
  "CASH_GATEWAY_LOCKED",
  "CASH_EXCHANGE_ACTIVE",
  "CASH_EXCHANGE_STEP_CONFLICT",
  "CASH_EXCHANGE_INVALID_PIECES",
  "CASH_EXCHANGE_TOTAL_MISMATCH",
  "CASH_EXCHANGE_AMOUNT_NOT_REPRESENTABLE",
  "CASH_EXCHANGE_INVENTORY_INSUFFICIENT",
  "CASH_MOVEMENT_ACTIVE",
  "CASH_MOVEMENT_STEP_CONFLICT",
  "CASH_MOVEMENT_INVALID_AMOUNT",
  "CASH_MOVEMENT_INVALID_PIECES",
  "CASH_MOVEMENT_INVENTORY_UNAVAILABLE",
  "CASH_MOVEMENT_INVENTORY_INSUFFICIENT",
  "CASH_MOVEMENT_AMOUNT_NOT_REPRESENTABLE",
  "CASH_MOVEMENT_JUSTIFICATION_REQUIRED",
  "CASH_MOVEMENT_PERMISSION_DENIED",
  "CASH_MOVEMENT_REPORT_PRINT_UNAVAILABLE",
  "CASH_GATEWAY_UNREACHABLE",
  "NETWORK_ERROR",
  "TIMEOUT",
  "UNKNOWN",
]);

const ERROR_STATUS_CODES: Record<number, AutomaticCashApiErrorCode> = {
  400: "BAD_REQUEST",
  409: "FCA_ACTIVE_WORKFLOW",
  423: "AUTOMATIC_CASH_LOCKED",
  503: "FCA_GATEWAY_UNREACHABLE",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeAutomaticCashErrorCode(error: ApiError): AutomaticCashApiErrorCode {
  const payload = isRecord(error.body) ? error.body : null;
  const candidate = payload?.error ?? payload?.code ?? error.code;
  const normalized = String(candidate || "")
    .trim()
    .toUpperCase();

  if (KNOWN_ERROR_CODES.has(normalized as AutomaticCashApiErrorCode)) {
    return normalized as AutomaticCashApiErrorCode;
  }
  if (normalized === "TIMEOUT") return "TIMEOUT";
  if (normalized === "NETWORK_ERROR") return "NETWORK_ERROR";
  const mappedStatusCode = ERROR_STATUS_CODES[error.status];
  if (mappedStatusCode) return mappedStatusCode;
  if (error.status === 0) return error.code === "timeout" ? "TIMEOUT" : "NETWORK_ERROR";
  return "UNKNOWN";
}

export function isAutomaticCashApiError(error: unknown): error is AutomaticCashApiError {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    KNOWN_ERROR_CODES.has((error as { code?: unknown }).code as AutomaticCashApiErrorCode)
  );
}

export function toAutomaticCashApiError(error: unknown): AutomaticCashApiError {
  if (error instanceof ApiError) {
    const normalized = error as AutomaticCashApiError;
    const payload = isRecord(error.body) ? error.body : null;
    const payloadMessage = payload?.message;
    if (typeof payloadMessage === "string" && payloadMessage.trim()) {
      normalized.message = payloadMessage.trim();
    }
    normalized.code = normalizeAutomaticCashErrorCode(error);
    normalized.status = error.status;
    normalized.payload = error.body as AutomaticCashApiErrorPayload | unknown;
    return normalized;
  }

  const fallback = error instanceof Error ? error : new Error("Automatic cash request failed");
  const normalized = fallback as AutomaticCashApiError;
  normalized.code = "UNKNOWN";
  normalized.payload = error;
  return normalized;
}

async function automaticCashJson<T>(
  input: string,
  init?: RequestInit,
  options?: ApiFetchOptions
): Promise<T> {
  try {
    return await apiJson<T>(input, init, options);
  } catch (error) {
    throw toAutomaticCashApiError(error);
  }
}

function postJson<TResponse, TBody extends object>(
  path: string,
  body: TBody,
  options?: ApiFetchOptions
): Promise<TResponse> {
  return automaticCashJson<TResponse>(
    `${BASE}${path}`,
    {
      method: "POST",
      headers: buildAutomaticCashHeaders(),
      body: JSON.stringify(body),
    },
    options
  );
}

function putJson<TResponse, TBody extends object>(
  path: string,
  body: TBody,
  options?: ApiFetchOptions
): Promise<TResponse> {
  return automaticCashJson<TResponse>(
    `${BASE}${path}`,
    {
      method: "PUT",
      headers: buildAutomaticCashHeaders(),
      body: JSON.stringify(body),
    },
    options
  );
}

export function getAutomaticCashSettings(
  options?: ApiFetchOptions
): Promise<AutomaticCashSettings> {
  return automaticCashJson<AutomaticCashSettings>(
    `${BASE}/settings`,
    {
      headers: buildAutomaticCashHeaders(false),
    },
    options
  );
}

export function updateAutomaticCashSettings(
  input: UpdateAutomaticCashSettingsRequest,
  options?: ApiFetchOptions
): Promise<AutomaticCashSettings> {
  return putJson<AutomaticCashSettings, UpdateAutomaticCashSettingsRequest>(
    "/settings",
    input,
    options
  );
}

export function uploadAutomaticCashConfigSet(
  input: UploadAutomaticCashConfigSetRequest,
  options?: ApiFetchOptions
): Promise<AutomaticCashSettings> {
  return postJson<AutomaticCashSettings, UploadAutomaticCashConfigSetRequest>(
    "/config-sets",
    input,
    options
  );
}

export function uploadAutomaticCashReserveConfig(
  input: UploadAutomaticCashReserveConfigRequest,
  options?: ApiFetchOptions
): Promise<AutomaticCashSettings> {
  return postJson<AutomaticCashSettings, UploadAutomaticCashReserveConfigRequest>(
    "/reserve-configs",
    input,
    options
  );
}

export function getAutomaticCashStatus(
  options?: ApiFetchOptions & { signal?: AbortSignal }
): Promise<AutomaticCashStatus> {
  const { signal, ...apiOptions } = options ?? {};
  return automaticCashJson<AutomaticCashStatus>(
    `${BASE}/status`,
    {
      headers: buildAutomaticCashHeaders(false),
      signal,
    },
    apiOptions
  );
}

export function getAutomaticCashGatewayState(
  options?: ApiFetchOptions & { signal?: AbortSignal }
): Promise<AutomaticCashGatewayState> {
  const { signal, ...apiOptions } = options ?? {};
  return automaticCashJson<AutomaticCashGatewayState>(
    `${BASE}/gateway/state`,
    {
      headers: buildAutomaticCashHeaders(false),
      signal,
    },
    apiOptions
  );
}

export function restartAutomaticCashGateway(
  input: AutomaticCashGatewayCommandRequest = {},
  options?: ApiFetchOptions
): Promise<AutomaticCashGatewayCommandResponse> {
  return postJson<AutomaticCashGatewayCommandResponse, AutomaticCashGatewayCommandRequest>(
    "/gateway/restart",
    input,
    withPhysicalCashTimeout(options)
  );
}

export function resetAutomaticCashGateway(
  input: AutomaticCashGatewayCommandRequest = {},
  options?: ApiFetchOptions
): Promise<AutomaticCashGatewayCommandResponse> {
  return postJson<AutomaticCashGatewayCommandResponse, AutomaticCashGatewayCommandRequest>(
    "/gateway/reset",
    input,
    withPhysicalCashTimeout(options)
  );
}

export function getAutomaticCashMovements(
  options?: ApiFetchOptions
): Promise<CashMovementListResponse> {
  return automaticCashJson<CashMovementListResponse>(
    `${BASE}/cash-movements`,
    {
      headers: buildAutomaticCashHeaders(false),
      cache: "no-store",
    },
    options
  );
}

export function getActiveAutomaticCashMovement(
  options?: ApiFetchOptions & { signal?: AbortSignal }
): Promise<ActiveCashMovementResponse> {
  const { signal, ...apiOptions } = options ?? {};
  return automaticCashJson<ActiveCashMovementResponse>(
    `${BASE}/cash-movements/active`,
    {
      headers: buildAutomaticCashHeaders(false),
      cache: "no-store",
      signal,
    },
    apiOptions
  );
}

export function getCashMovementWithdrawalAvailability(
  options?: ApiFetchOptions
): Promise<CashMovementWithdrawalAvailabilityResponse> {
  return automaticCashJson<CashMovementWithdrawalAvailabilityResponse>(
    `${BASE}/cash-movements/withdrawal-availability`,
    {
      headers: buildAutomaticCashHeaders(false),
      cache: "no-store",
    },
    options
  );
}

export function getAutomaticCashMovementState(
  movementId: string,
  options?: ApiFetchOptions
): Promise<CashMovementStateResponse> {
  return automaticCashJson<CashMovementStateResponse>(
    `${BASE}/cash-movements/${encodeURIComponent(movementId)}/state`,
    {
      headers: buildAutomaticCashHeaders(false),
      cache: "no-store",
    },
    options
  );
}

export function startAutomaticCashMovement(
  input: StartCashMovementRequest,
  options?: ApiFetchOptions
): Promise<CashMovementResponse> {
  return postJson<CashMovementResponse, StartCashMovementRequest>(
    "/cash-movements/start",
    input,
    withPhysicalCashTimeout(options)
  );
}

export function prepareAutomaticCashMovement(
  movementId: string,
  options?: ApiFetchOptions
): Promise<CashMovementResponse> {
  return postJson<CashMovementResponse, { movementId: string }>(
    `/cash-movements/${encodeURIComponent(movementId)}/prepare`,
    { movementId },
    withPhysicalCashTimeout(options)
  );
}

export function completeAutomaticCashMovement(
  movementId: string,
  input: { awaitingReport?: boolean } = {},
  options?: ApiFetchOptions
): Promise<CashMovementResponse> {
  return postJson<CashMovementResponse, { movementId: string; awaitingReport?: boolean }>(
    `/cash-movements/${encodeURIComponent(movementId)}/complete`,
    { movementId, ...input },
    withPhysicalCashTimeout(options)
  );
}

export function printAutomaticCashMovementReport(
  movementId: string,
  input: PrintCashMovementReportRequest,
  options?: ApiFetchOptions
): Promise<PrintCashMovementReportResponse> {
  return postJson<
    PrintCashMovementReportResponse,
    PrintCashMovementReportRequest & {
      movementId: string;
    }
  >(
    `/cash-movements/${encodeURIComponent(movementId)}/print`,
    { movementId, ...input },
    withPhysicalCashTimeout(options)
  );
}

export function cancelAutomaticCashMovement(
  movementId: string,
  options?: ApiFetchOptions
): Promise<CashMovementResponse> {
  return postJson<CashMovementResponse, { movementId: string }>(
    `/cash-movements/${encodeURIComponent(movementId)}/cancel`,
    { movementId },
    withPhysicalCashTimeout(options)
  );
}

export function getAutomaticCashPreflight(
  options?: ApiFetchOptions
): Promise<AutomaticCashPreflight> {
  return automaticCashJson<AutomaticCashPreflight>(
    `${BASE}/cash-float/preflight`,
    {
      headers: buildAutomaticCashHeaders(false),
    },
    options
  );
}

export function getActiveAutomaticCashWorkflow(
  options?: ApiFetchOptions
): Promise<{ ok: true; activeWorkflow: AutomaticCashPreflight["activeWorkflow"] }> {
  return automaticCashJson<{ ok: true; activeWorkflow: AutomaticCashPreflight["activeWorkflow"] }>(
    `${BASE}/cash-float/active`,
    {
      headers: buildAutomaticCashHeaders(false),
    },
    options
  );
}

export function generateAutomaticCashFloat(
  input: GenerateAutomaticCashFloatRequest,
  options?: ApiFetchOptions
): Promise<GenerateAutomaticCashFloatResponse> {
  return postJson<GenerateAutomaticCashFloatResponse, GenerateAutomaticCashFloatRequest>(
    "/cash-float/generate",
    {
      preferExistingAssignmentForEvening: true,
      ...input,
    },
    withPhysicalCashTimeout(options)
  );
}

export function confirmAutomaticCashFloatRemoved(
  input: ConfirmAutomaticCashFloatRemovedRequest,
  options?: ApiFetchOptions
): Promise<ConfirmAutomaticCashFloatRemovedResponse> {
  return postJson<
    ConfirmAutomaticCashFloatRemovedResponse,
    ConfirmAutomaticCashFloatRemovedRequest
  >("/cash-float/confirm-removed", input, withPhysicalCashTimeout(options));
}

export function markAutomaticCashFloatTicketPrinted(
  input: MarkAutomaticCashFloatTicketPrintedRequest,
  options?: ApiFetchOptions
): Promise<MarkAutomaticCashFloatTicketPrintedResponse> {
  return postJson<
    MarkAutomaticCashFloatTicketPrintedResponse,
    MarkAutomaticCashFloatTicketPrintedRequest
  >("/cash-float/ticket/printed", input, options);
}

export function confirmAutomaticCashFloatTicketInPouch(
  input: ConfirmAutomaticCashFloatTicketInPouchRequest,
  options?: ApiFetchOptions
): Promise<ConfirmAutomaticCashFloatTicketInPouchResponse> {
  return postJson<
    ConfirmAutomaticCashFloatTicketInPouchResponse,
    ConfirmAutomaticCashFloatTicketInPouchRequest
  >("/cash-float/confirm-ticket-in-pouch", input, options);
}

export function loadAutomaticCashFloatFromQr(
  input: LoadAutomaticCashFloatFromQrRequest,
  options?: ApiFetchOptions
): Promise<LoadAutomaticCashFloatFromQrResponse> {
  return postJson<LoadAutomaticCashFloatFromQrResponse, LoadAutomaticCashFloatFromQrRequest>(
    "/cash-float/load-from-qr",
    input,
    options
  );
}

export function startAutomaticCashDeposit(
  input: StartAutomaticCashDepositRequest,
  options?: ApiFetchOptions
): Promise<StartAutomaticCashDepositResponse> {
  return postJson<StartAutomaticCashDepositResponse, StartAutomaticCashDepositRequest>(
    "/deposit/start",
    input,
    withPhysicalCashTimeout(options)
  );
}

export function closeAutomaticCashDeposit(
  input: CloseAutomaticCashDepositRequest,
  options?: ApiFetchOptions
): Promise<CloseAutomaticCashDepositResponse> {
  return postJson<CloseAutomaticCashDepositResponse, CloseAutomaticCashDepositRequest>(
    "/deposit/close",
    input,
    withPhysicalCashTimeout(options)
  );
}

export function cancelAutomaticCashDeposit(
  input: CancelAutomaticCashDepositRequest,
  options?: ApiFetchOptions
): Promise<CancelAutomaticCashDepositResponse> {
  return postJson<CancelAutomaticCashDepositResponse, CancelAutomaticCashDepositRequest>(
    "/deposit/cancel",
    input,
    withPhysicalCashTimeout(options)
  );
}

export function startAutomaticCashPayment(
  input: StartAutomaticCashPaymentRequest,
  options?: ApiFetchOptions
): Promise<StartAutomaticCashPaymentResponse> {
  return postJson<StartAutomaticCashPaymentResponse, StartAutomaticCashPaymentRequest>(
    "/payment/start",
    input,
    withPhysicalCashTimeout(options)
  );
}

export function getAutomaticCashPaymentState(
  operationId: string,
  options?: ApiFetchOptions
): Promise<AutomaticCashPaymentStateResponse> {
  return automaticCashJson<AutomaticCashPaymentStateResponse>(
    `${BASE}/payment/${encodeURIComponent(operationId)}/state`,
    {
      headers: buildAutomaticCashHeaders(false),
      cache: "no-store",
    },
    withPhysicalCashTimeout(options)
  );
}

export function cancelAutomaticCashPayment(
  operationId: string,
  options?: ApiFetchOptions
): Promise<CancelAutomaticCashPaymentResponse> {
  return postJson<CancelAutomaticCashPaymentResponse, { operationId: string }>(
    `/payment/${encodeURIComponent(operationId)}/cancel`,
    { operationId },
    withPhysicalCashTimeout(options)
  );
}

export function completeAutomaticCashPayment(
  operationId: string,
  input: CompleteAutomaticCashPaymentRequest = {},
  options?: ApiFetchOptions
): Promise<CompleteAutomaticCashPaymentResponse> {
  return postJson<CompleteAutomaticCashPaymentResponse, CompleteAutomaticCashPaymentRequest>(
    `/payment/${encodeURIComponent(operationId)}/complete`,
    { ...input, operationId },
    withPhysicalCashTimeout(options)
  );
}

export function saveAutomaticCashSettlementRecordToDb(
  input: AutomaticCashSettlementRecord,
  options?: ApiFetchOptions
): Promise<{ ok: true; record: AutomaticCashSettlementRecord }> {
  return postJson<
    { ok: true; record: AutomaticCashSettlementRecord },
    AutomaticCashSettlementRecord
  >("/settlements", input, options);
}

export function getLatestAutomaticCashSettlementRecord(
  options?: ApiFetchOptions
): Promise<{ ok: true; record: AutomaticCashSettlementRecord | null }> {
  return automaticCashJson<{ ok: true; record: AutomaticCashSettlementRecord | null }>(
    `${BASE}/settlements/latest`,
    {
      headers: buildAutomaticCashHeaders(false),
    },
    options
  );
}

export function getAutomaticCashSettlementRecords(
  options?: ApiFetchOptions
): Promise<{ ok: true; records: AutomaticCashSettlementRecord[]; count: number }> {
  return automaticCashJson<{ ok: true; records: AutomaticCashSettlementRecord[]; count: number }>(
    `${BASE}/settlements`,
    {
      headers: buildAutomaticCashHeaders(false),
    },
    options
  );
}
