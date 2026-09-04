import { getRuntimeConfig, isRuntimeFeatureEnabled } from "../../config/runtimeConfig";
import {
  classifyOfflineRequest,
  shouldQueueMutationAfterHttpResponse,
  type OfflineRequestPolicy,
} from "../offline/offlineRequestPolicy";
import {
  enqueueOfflineRequest,
  offlineCacheKey,
  readCachedResponse,
  storeCachedResponse,
  type OfflineOutboxEntry,
} from "../offline/offlineStore";
import { completeOfflineOutboxOwner } from "../offline/offlineReplayState";
import { AUTH_STORAGE_KEYS, readAuthStorage } from "../storage/authStorage";

const API_PREFIX = "/api";
const DEFAULT_API_BASE_URL = API_PREFIX;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

const DEFAULT_TIMEOUT_MS = 15_000;
const BASE_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 4_000;

export type ApiFetchOptions = {
  /** Number of additional retry attempts for idempotent requests. */
  retryAttempts?: number;
  /** Per-attempt timeout in milliseconds. Defaults to ~15s. */
  timeoutMs?: number;
  /**
   * Delay between retry attempts. Defaults to exponential backoff with jitter.
   * A fixed number or a function of the (zero-based) failed attempt index can be
   * passed; mainly useful to keep tests fast and deterministic.
   */
  retryDelayMs?: number | ((attempt: number) => number);
};

export type ApiErrorInit = {
  message: string;
  status: number;
  code: string;
  url: string;
  body?: unknown;
};

/**
 * Normalized API error. Thrown by `apiJson` on non-2xx responses, timeouts, and
 * network failures so callers get a consistent `{ message, status, code, url, body }`
 * shape instead of ad hoc parsing.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly url: string;
  readonly body: unknown;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.url = init.url;
    this.body = init.body ?? null;
    // Preserve `instanceof ApiError` across down-leveled build targets.
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * Register a single centralized handler invoked when the backend answers 401.
 * Used to centralize session expiry (logout) instead of scattering it across
 * domain API modules. Pass `null` to clear.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null) {
  unauthorizedHandler = handler;
}

function notifyUnauthorized() {
  if (!unauthorizedHandler) return;
  try {
    unauthorizedHandler();
  } catch {
    // A failing handler must never break the originating request flow.
  }
}

const PUBLIC_UNAUTHORIZED_ENDPOINTS = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/session/status",
  "/api/auth/change-pin",
  "/api/health",
  "/api/ip-coords",
]);

function resolveUnauthorizedPathname(url: string) {
  try {
    return new URL(url, window.location.origin).pathname;
  } catch {
    return url.split("?")[0] || "";
  }
}

function shouldNotifyUnauthorized(url: string) {
  const pathname = resolveUnauthorizedPathname(url);
  if (!pathname.startsWith("/api/")) return false;
  return !PUBLIC_UNAUTHORIZED_ENDPOINTS.has(pathname);
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function normalizeApiBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim();
  return trimTrailingSlash(trimmed || DEFAULT_API_BASE_URL) || DEFAULT_API_BASE_URL;
}

function isAbsoluteUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function resolvePath(input: string | URL) {
  return input instanceof URL ? input.toString() : input;
}

export function getApiBaseUrl() {
  return normalizeApiBaseUrl(getRuntimeConfig().apiBaseUrl);
}

export function getSseBaseUrl() {
  return normalizeApiBaseUrl(getRuntimeConfig().sseBaseUrl);
}

function buildRuntimeUrl(input: string | URL, baseUrl: string) {
  const path = resolvePath(input);
  if (isAbsoluteUrl(path)) return path;

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (normalizedPath === API_PREFIX || normalizedPath.startsWith(`${API_PREFIX}/`)) {
    if (baseUrl === API_PREFIX || baseUrl.endsWith(API_PREFIX)) {
      return `${baseUrl}${normalizedPath.slice(API_PREFIX.length)}`;
    }
    return `${baseUrl}${normalizedPath}`;
  }

  return `${baseUrl}${normalizedPath}`;
}

export function buildApiUrl(input: string | URL) {
  return buildRuntimeUrl(input, getApiBaseUrl());
}

export function buildSseUrl(input: string | URL) {
  return buildRuntimeUrl(input, getSseBaseUrl());
}

function resolveMethod(init?: RequestInit) {
  return (
    String(init?.method || "GET")
      .trim()
      .toUpperCase() || "GET"
  );
}

const serializeOfflineBody = (body: BodyInit | null | undefined) => {
  if (body == null) return { persistable: true, value: null as string | null };
  if (typeof body === "string") return { persistable: true, value: body };
  if (body instanceof URLSearchParams) return { persistable: true, value: body.toString() };
  return { persistable: false, value: null as string | null };
};

const randomRequestId = () => {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  return `palmare-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
};

const readRequestIdentityFromBody = (body: string | null) => {
  if (!body) return { requestId: "", idempotencyKey: "" };
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const requestId = String(parsed.requestId ?? parsed.clientRequestId ?? "").trim();
    const idempotencyKey = String(
      parsed.idempotencyKey ??
        parsed.clientPaymentId ??
        parsed.clientOrderId ??
        parsed.localOrderId ??
        ""
    ).trim();
    return { requestId, idempotencyKey };
  } catch {
    return { requestId: "", idempotencyKey: "" };
  }
};

const headersToRecord = (headers: Headers) => {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
};

type OfflineRequestContext = {
  enabled: boolean;
  policy: OfflineRequestPolicy;
  method: string;
  body: string | null;
  cacheKey: string;
  requestId: string;
  idempotencyKey: string;
  bodyPersistable: boolean;
  init: RequestInit | undefined;
};

const prepareOfflineRequest = (
  url: string,
  init: RequestInit | undefined
): OfflineRequestContext => {
  const enabled = isRuntimeFeatureEnabled("offlineMode");
  const method = resolveMethod(init);
  const serializedBody = serializeOfflineBody(init?.body);
  const body = serializedBody.value;
  const policy = enabled
    ? classifyOfflineRequest(url, method)
    : { mode: "none" as const, maxAgeMs: 0, expiresInMs: 0 };
  const cacheKey = offlineCacheKey(method, url, body);
  if (!enabled || policy.mode !== "automatic" || !serializedBody.persistable) {
    return {
      enabled,
      policy,
      method,
      body,
      cacheKey,
      requestId: "",
      idempotencyKey: "",
      bodyPersistable: serializedBody.persistable,
      init,
    };
  }

  const headers = new Headers(init?.headers);
  const bodyIdentity = readRequestIdentityFromBody(body);
  const requestId =
    headers.get("X-Command-Request-Id")?.trim() || bodyIdentity.requestId || randomRequestId();
  const idempotencyKey =
    headers.get("X-Idempotency-Key")?.trim() || bodyIdentity.idempotencyKey || requestId;
  headers.set("X-Command-Request-Id", requestId);
  headers.set("X-Idempotency-Key", idempotencyKey);
  headers.set("X-Palmare-Device-Queue", "1");

  return {
    enabled,
    policy,
    method,
    body,
    cacheKey,
    requestId,
    idempotencyKey,
    bodyPersistable: true,
    init: { ...init, headers },
  };
};

const saveSuccessfulRead = async (context: OfflineRequestContext, response: Response) => {
  if (!context.enabled || context.policy.mode !== "read-cache" || !response.ok) return;
  if (typeof response.clone !== "function") return;
  try {
    const clone = response.clone();
    const body = await clone.text();
    const headers = new Headers(clone.headers);
    await storeCachedResponse({
      key: context.cacheKey,
      status: clone.status,
      statusText: clone.statusText,
      headers: headersToRecord(headers),
      body,
      storedAt: Date.now(),
    });
  } catch {
    // Cache persistence must never change the live request result.
  }
};

const restoreCachedRead = async (context: OfflineRequestContext) => {
  if (!context.enabled || context.policy.mode !== "read-cache") return null;
  const cached = await readCachedResponse(context.cacheKey, context.policy.maxAgeMs);
  if (!cached) return null;
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers: {
      ...cached.headers,
      "X-Palmare-Offline-Cache": "1",
    },
  });
};

const queueOfflineMutation = async (url: string, context: OfflineRequestContext) => {
  if (
    !context.enabled ||
    context.policy.mode !== "automatic" ||
    !context.bodyPersistable ||
    !context.requestId ||
    !context.idempotencyKey
  ) {
    return null;
  }
  const now = Date.now();
  const headers = new Headers(context.init?.headers);
  const persistedHeaders = headersToRecord(headers);
  const owner = completeOfflineOutboxOwner(
    { body: context.body, headers: persistedHeaders },
    {
      userId: readAuthStorage(AUTH_STORAGE_KEYS.userId),
      activityId: readAuthStorage(AUTH_STORAGE_KEYS.activityId),
      deviceUuid: readAuthStorage(AUTH_STORAGE_KEYS.deviceUuid),
    }
  );
  const entry: OfflineOutboxEntry = {
    requestId: context.requestId,
    idempotencyKey: context.idempotencyKey,
    url,
    method: context.method,
    headers: persistedHeaders,
    body: context.body,
    ...owner,
    replayMode: "automatic",
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
    expiresAt: context.policy.expiresInMs > 0 ? now + context.policy.expiresInMs : 0,
    lastError: "Backend non raggiungibile. Invio automatico in attesa.",
  };
  const stored = await enqueueOfflineRequest(entry);
  if (!stored) return null;

  const pathname = resolveUnauthorizedPathname(url);
  let requestPayload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(context.body ?? "") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      requestPayload = parsed as Record<string, unknown>;
    }
  } catch {
    requestPayload = {};
  }
  const optimisticPayload =
    pathname === "/api/integration/table-groups/save"
      ? { groups: requestPayload.groups }
      : pathname === "/api/settings/order-workflow"
        ? { orderWorkflow: requestPayload.orderWorkflow }
        : {};
  return new Response(
    JSON.stringify({
      ...optimisticPayload,
      ok: true,
      queued: true,
      offline: true,
      replayMode: context.policy.mode,
      requestId: context.requestId,
      idempotencyKey: context.idempotencyKey,
    }),
    {
      status: 202,
      headers: {
        "Content-Type": "application/json",
        "X-Palmare-Offline-Queued": "1",
      },
    }
  );
};

function isIdempotentMethod(init?: RequestInit) {
  const method = resolveMethod(init);
  return method === "GET" || method === "HEAD";
}

function defaultRetryAttempts(init?: RequestInit) {
  return isIdempotentMethod(init) ? 1 : 0;
}

function shouldRetry(response: Response | null, init?: RequestInit) {
  if (!isIdempotentMethod(init)) return false;
  return !response || RETRYABLE_STATUSES.has(response.status);
}

/** Exponential backoff with jitter, in milliseconds, for the failed attempt index. */
export function computeBackoffDelay(attempt: number) {
  const exponential = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt));
  const jitter = Math.random() * (exponential / 2);
  return Math.round(exponential + jitter);
}

function resolveDelay(delay: ApiFetchOptions["retryDelayMs"]) {
  if (typeof delay === "number") return () => Math.max(0, delay);
  if (typeof delay === "function") return delay;
  return computeBackoffDelay;
}

function sleep(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown) {
  // A caller-initiated abort surfaces as a DOMException, which is not an
  // `instanceof Error` in every runtime, so match on the name directly.
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/**
 * Single fetch attempt guarded by a timeout. The caller's signal (if any) is
 * honored too: the request aborts when either the caller aborts or the timeout
 * fires. A timeout surfaces as an `ApiError` with code `timeout`; a caller abort
 * propagates as the original abort error.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<Response> {
  const callerSignal = init?.signal ?? undefined;
  if (callerSignal?.aborted) {
    throw callerSignal.reason instanceof Error
      ? callerSignal.reason
      : new DOMException("Aborted", "AbortError");
  }

  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  if (callerSignal) callerSignal.addEventListener("abort", onCallerAbort);
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut && !callerSignal?.aborted) {
      throw new ApiError({
        message: `Request timed out after ${timeoutMs}ms`,
        status: 0,
        code: "timeout",
        url,
        body: null,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  }
}

export async function apiFetch(
  input: string | URL,
  init?: RequestInit,
  options: ApiFetchOptions = {}
) {
  const url = buildApiUrl(input);
  const offlineContext = prepareOfflineRequest(url, init);
  const requestInit = offlineContext.init;
  const attempts = Math.max(0, options.retryAttempts ?? defaultRetryAttempts(requestInit));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const delayFor = resolveDelay(options.retryDelayMs);
  let lastError: unknown = null;

  if (offlineContext.enabled && typeof navigator !== "undefined" && navigator.onLine === false) {
    const cached = await restoreCachedRead(offlineContext);
    if (cached) return cached;
    const queued = await queueOfflineMutation(url, offlineContext);
    if (queued) return queued;
  }

  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, requestInit, timeoutMs);
      if (response.status === 401 && shouldNotifyUnauthorized(url)) {
        notifyUnauthorized();
      }
      if (response.ok) void saveSuccessfulRead(offlineContext, response);
      if (
        attempt === attempts &&
        shouldQueueMutationAfterHttpResponse(offlineContext.policy, response.status)
      ) {
        const cached = await restoreCachedRead(offlineContext);
        if (cached) return cached;
        const queued = await queueOfflineMutation(url, offlineContext);
        if (queued) return queued;
      }
      if (!shouldRetry(response, requestInit) || attempt === attempts) {
        return response;
      }
      lastError = new ApiError({
        message: `Retryable response status ${response.status}`,
        status: response.status,
        code: "retryable",
        url,
        body: null,
      });
    } catch (error) {
      lastError = error;
      const callerAborted = Boolean(requestInit?.signal?.aborted);
      if (!callerAborted && attempt === attempts) {
        const cached = await restoreCachedRead(offlineContext);
        if (cached) return cached;
        const queued = await queueOfflineMutation(url, offlineContext);
        if (queued) return queued;
      }
      if (callerAborted || attempt === attempts || !shouldRetry(null, requestInit)) {
        throw error;
      }
    }
    await sleep(delayFor(attempt));
  }

  throw lastError ?? new Error("api-fetch-failed");
}

function extractErrorMessage(body: unknown, status: number) {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const candidate = record.error ?? record.message;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  if (typeof body === "string" && body.trim()) return body.trim();
  return status > 0 ? `Request failed (${status})` : "Network request failed";
}

function extractErrorCode(body: unknown, status: number) {
  if (body && typeof body === "object") {
    const code = (body as Record<string, unknown>).code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 500) return "server_error";
  if (status > 0) return "http_error";
  return "network_error";
}

/**
 * Runs `apiFetch`, parses the JSON body, and throws a normalized `ApiError` on
 * non-2xx responses or network/timeout failures. Empty bodies resolve to `null`.
 */
export async function apiJson<T>(
  input: string | URL,
  init?: RequestInit,
  options: ApiFetchOptions = {}
): Promise<T> {
  const url = buildApiUrl(input);

  let response: Response;
  try {
    response = await apiFetch(input, init, options);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (isAbortError(error)) {
      throw new ApiError({
        message: "Request aborted",
        status: 0,
        code: "aborted",
        url,
        body: null,
      });
    }
    throw new ApiError({
      message: error instanceof Error ? error.message : "Network request failed",
      status: 0,
      code: "network_error",
      url,
      body: null,
    });
  }

  const text = await response.text().catch(() => "");
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    throw new ApiError({
      message: extractErrorMessage(body, response.status),
      status: response.status,
      code: extractErrorCode(body, response.status),
      url: response.url || url,
      body,
    });
  }

  return body as T;
}
