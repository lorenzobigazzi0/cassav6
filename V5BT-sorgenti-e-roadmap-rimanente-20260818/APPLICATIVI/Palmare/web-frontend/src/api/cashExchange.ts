import { apiJson } from "./baseUrl";
import type { ApiFetchOptions } from "./baseUrl";
import { isAutomaticCashApiError, toAutomaticCashApiError } from "./automaticCash";
import { AUTH_STORAGE_KEYS, readAuthStorage } from "../shared/storage/authStorage";
import type {
  ActiveCashExchangeResponse,
  CancelCashExchangeResponse,
  CashExchangePieces,
  CashExchangeState,
  ConfirmCashExchangeDepositResponse,
  ConfirmCashExchangeRemovedResponse,
  ExecuteCashExchangeResponse,
  StartCashExchangeRequest,
  StartCashExchangeResponse,
} from "../types/cashExchange";

const BASE = "/api/automatic-cash/exchange";
const PHYSICAL_CASH_TIMEOUT_MS = 130_000;
const JSON_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
} as const;

function buildCashExchangeHeaders(includeJsonHeaders = true): Record<string, string> {
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

async function cashExchangeJson<T>(
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
  return cashExchangeJson<TResponse>(
    `${BASE}${path}`,
    {
      method: "POST",
      headers: buildCashExchangeHeaders(),
      body: JSON.stringify(body),
    },
    options
  );
}

export function isCashExchangeApiError(error: unknown) {
  return isAutomaticCashApiError(error);
}

export function startCashExchange(
  input: StartCashExchangeRequest,
  options?: ApiFetchOptions
): Promise<StartCashExchangeResponse> {
  return postJson<StartCashExchangeResponse, StartCashExchangeRequest>(
    "/start",
    input,
    withPhysicalCashTimeout(options)
  );
}

export function getCashExchangeState(
  exchangeId: string,
  options?: ApiFetchOptions
): Promise<CashExchangeState> {
  return cashExchangeJson<CashExchangeState>(
    `${BASE}/${encodeURIComponent(exchangeId)}/state`,
    {
      headers: buildCashExchangeHeaders(false),
    },
    options
  );
}

export function cancelCashExchange(
  exchangeId: string,
  reason = "operator_cancelled",
  options?: ApiFetchOptions
): Promise<CancelCashExchangeResponse> {
  return postJson<CancelCashExchangeResponse, { reason: string }>(
    `/${encodeURIComponent(exchangeId)}/cancel`,
    { reason },
    withPhysicalCashTimeout(options)
  );
}

export function confirmCashExchangeDeposit(
  exchangeId: string,
  options?: ApiFetchOptions
): Promise<ConfirmCashExchangeDepositResponse> {
  return postJson<ConfirmCashExchangeDepositResponse, Record<string, never>>(
    `/${encodeURIComponent(exchangeId)}/confirm-deposit`,
    {},
    withPhysicalCashTimeout(options)
  );
}

export function executeCashExchange(
  exchangeId: string,
  pieces: CashExchangePieces,
  options?: ApiFetchOptions
): Promise<ExecuteCashExchangeResponse> {
  return postJson<ExecuteCashExchangeResponse, { pieces: CashExchangePieces }>(
    `/${encodeURIComponent(exchangeId)}/execute`,
    { pieces },
    withPhysicalCashTimeout(options)
  );
}

export function confirmCashExchangeRemoved(
  exchangeId: string,
  options?: ApiFetchOptions
): Promise<ConfirmCashExchangeRemovedResponse> {
  return postJson<ConfirmCashExchangeRemovedResponse, Record<string, never>>(
    `/${encodeURIComponent(exchangeId)}/confirm-removed`,
    {},
    withPhysicalCashTimeout(options)
  );
}

export function getActiveCashExchange(
  options?: ApiFetchOptions & { signal?: AbortSignal }
): Promise<ActiveCashExchangeResponse> {
  const { signal, ...apiOptions } = options ?? {};
  return cashExchangeJson<ActiveCashExchangeResponse>(
    `${BASE}/active`,
    {
      headers: buildCashExchangeHeaders(false),
      signal,
    },
    apiOptions
  );
}
