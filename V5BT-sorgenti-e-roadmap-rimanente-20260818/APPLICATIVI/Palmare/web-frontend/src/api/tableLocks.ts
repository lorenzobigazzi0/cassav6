import { apiFetch } from "./baseUrl";
import type { TableSessionRequest } from "./tables";

export const ORDER_COMPOSER_LOCK_PURPOSE = "mobile:order_composer";
export const PAYMENT_SESSION_LOCK_PURPOSE = "mobile:payment_session";
export const ORDER_CREATE_LOCK_PURPOSE = "mobile:api_integration_orders_create";
export const PAYMENT_LOCK_PURPOSE = "mobile:api_payments_table";
export const TABLE_LAYOUT_SYNC_LOCK_PURPOSE = "mobile:api_integration_layout_table_sync";
export const TABLE_LAYOUT_MOVE_LOCK_PURPOSE = "mobile:api_integration_layout_table_move";

const CLIENT_APP = "mobile-frontend";
const HEARTBEAT_MS = 25_000;

export type TableLockPurpose = string;
export type TableLockSession = TableSessionRequest;

export type TableLockConflictDetail = {
  message: string;
  payload: unknown;
  tableId?: string;
  purpose?: string;
  lockedByUsername?: string;
  expiresAt?: string;
};

type ActiveLockRegistration = {
  tableIds: string[];
  purpose: TableLockPurpose;
  session: TableLockSession;
  release: () => Promise<unknown>;
};

type LockRequestOptions = {
  keepalive?: boolean;
};

type WithTableLocksOptions = {
  skipIfAlreadyHeld?: boolean;
  onConflict?: (detail: TableLockConflictDetail) => void;
  onLost?: (detail: TableLockConflictDetail, error: unknown) => void;
  required?: boolean;
  allowOfflineContinuation?: boolean;
};

const activeLockRegistrations = new Set<ActiveLockRegistration>();
let unloadReleaseInstalled = false;

export class TableLockError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "TableLockError";
    this.status = status;
    this.payload = payload;
  }
}

function normalize(value: unknown) {
  return String(value == null ? "" : value).trim();
}

function uniqueTableIds(tableIds: Iterable<string | null | undefined>) {
  return Array.from(
    new Set(
      Array.from(tableIds)
        .map((tableId) => normalize(tableId))
        .filter(Boolean)
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function headersFor(session: TableLockSession): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-User-Id": session.userId,
    "X-Device-Uuid": session.deviceUuid,
    "X-Client-App": CLIENT_APP,
  };
  if (session.token) {
    headers.Authorization = `Bearer ${session.token}`;
  }
  return headers;
}

function lockPayload(session: TableLockSession, tableId: string, purpose: TableLockPurpose) {
  return {
    token: session.token,
    userId: session.userId,
    username: session.username,
    fullName: session.fullName,
    deviceUuid: session.deviceUuid,
    roomId: session.roomId,
    tableId,
    purpose,
    clientApp: CLIENT_APP,
  };
}

function payloadMessage(payload: unknown) {
  if (!isRecord(payload)) return "";
  const direct = normalize(payload.error || payload.message || payload.code);
  if (direct) return direct;
  const details = isRecord(payload.details) ? payload.details : null;
  return details ? normalize(details.error || details.message || details.code) : "";
}

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: text };
  }
}

async function postLock(
  path: string,
  session: TableLockSession,
  tableId: string,
  purpose: TableLockPurpose,
  options: LockRequestOptions = {}
) {
  const response = await apiFetch(path, {
    method: "POST",
    headers: headersFor(session),
    body: JSON.stringify(lockPayload(session, tableId, purpose)),
    keepalive: options.keepalive,
  });
  const payload = await parseJsonResponse(response);
  const payloadOk = !isRecord(payload) || payload.ok !== false;
  if (!response.ok || !payloadOk) {
    throw new TableLockError(
      payloadMessage(payload) || "Lock tavolo non disponibile.",
      response.status,
      payload
    );
  }
  return payload;
}

function sameSession(left: TableLockSession, right: TableLockSession) {
  return (
    normalize(left.userId) === normalize(right.userId) &&
    normalize(left.deviceUuid) === normalize(right.deviceUuid)
  );
}

const isBrowserDefinitelyOffline = () =>
  typeof navigator !== "undefined" && navigator.onLine === false;

function hasActiveTableLockForSession(tableId: string, session: TableLockSession) {
  const normalizedTableId = normalize(tableId);
  for (const registration of activeLockRegistrations) {
    if (!sameSession(registration.session, session)) continue;
    if (registration.tableIds.includes(normalizedTableId)) return true;
  }
  return false;
}

export function isValidTableLockSession(session: TableLockSession) {
  return Boolean(
    normalize(session.token) &&
    normalize(session.userId) &&
    normalize(session.deviceUuid) &&
    normalize(session.roomId)
  );
}

function buildRequiredLockError(
  message: string,
  tableIds: string[],
  purpose: TableLockPurpose,
  code = "TABLE_LOCK_REQUIRED"
) {
  return new TableLockError(message, 428, {
    ok: false,
    code,
    message,
    details: {
      tableIds,
      tableId: tableIds[0] ?? null,
      purpose,
      clientApp: CLIENT_APP,
    },
  });
}

export function isTableLockError(error: unknown): error is TableLockError {
  return error instanceof TableLockError;
}

export function isTableLockConflictError(error: unknown) {
  if (!isTableLockError(error)) return false;
  if (error.status === 409) return true;
  const payload = isRecord(error.payload) ? error.payload : null;
  return normalize(payload?.code) === "TABLE_LOCKED";
}

const OFFLINE_CONTINUATION_STATUSES = new Set([0, 502, 503, 504]);
const OFFLINE_CONTINUATION_ERROR_CODES = new Set(["network_error", "timeout"]);

/**
 * A lock can be bypassed only when no authoritative answer was received. HTTP
 * authorization, conflict, and not-found responses must always remain fail-closed.
 */
export function isTableLockTransportUnavailable(error: unknown) {
  const source = isRecord(error) ? error : null;
  const statusValue = source?.status;
  const statusRaw = statusValue == null || statusValue === "" ? Number.NaN : Number(statusValue);
  if (Number.isFinite(statusRaw)) {
    return OFFLINE_CONTINUATION_STATUSES.has(Math.trunc(statusRaw));
  }

  const code = normalize(source?.code).toLowerCase();
  if (OFFLINE_CONTINUATION_ERROR_CODES.has(code)) return true;

  const name = normalize(source?.name);
  return error instanceof TypeError || name === "TypeError";
}

export function toTableLockConflictDetail(
  error: unknown,
  fallbackTableId?: string,
  fallbackPurpose?: string
): TableLockConflictDetail {
  const payload = isTableLockError(error) ? error.payload : null;
  const root = isRecord(payload) ? payload : {};
  const details = isRecord(root.details) ? root.details : root;
  const lockedByUsername = normalize(details.lockedByUsername || details.lockedBy);
  const purpose = normalize(details.purpose || details.lockPurpose || fallbackPurpose);
  const tableId = normalize(details.tableId || details.lockedTableId || fallbackTableId);
  const expiresAt = normalize(details.expiresAt);
  const lowerPurpose = purpose.toLowerCase();
  const activity =
    lowerPurpose.includes("payment") || lowerPurpose.includes("riscoss")
      ? "in riscossione"
      : "in modifica";
  const fallbackMessage = payloadMessage(payload);
  const genericMessage = `Tavolo ${activity} da un altro operatore.`;
  const until = expiresAt
    ? ` fino a ${new Intl.DateTimeFormat("it-IT", {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(expiresAt))}`
    : "";
  const message = lockedByUsername
    ? `Tavolo ${activity} da ${lockedByUsername}${until}.`
    : fallbackMessage && fallbackMessage !== "TABLE_LOCKED"
      ? fallbackMessage
      : genericMessage;

  return {
    message,
    payload,
    tableId: tableId || undefined,
    purpose: purpose || undefined,
    lockedByUsername: lockedByUsername || undefined,
    expiresAt: expiresAt || undefined,
  };
}

export function dispatchTableLockConflict(detail: TableLockConflictDetail) {
  window.dispatchEvent(new CustomEvent("mobile:table-lock-conflict", { detail }));
}

export async function acquireTableLock(
  session: TableLockSession,
  tableId: string,
  purpose: TableLockPurpose
) {
  return postLock("/api/tables/lock/acquire", session, tableId, purpose);
}

export async function heartbeatTableLock(
  session: TableLockSession,
  tableId: string,
  purpose: TableLockPurpose
) {
  return postLock("/api/tables/lock/heartbeat", session, tableId, purpose);
}

export async function releaseTableLock(
  session: TableLockSession,
  tableId: string,
  purpose: TableLockPurpose,
  options: LockRequestOptions = {}
) {
  return postLock("/api/tables/lock/release", session, tableId, purpose, options).catch(
    () => undefined
  );
}

export function startTableLockHeartbeat(
  session: TableLockSession,
  tableIds: string[],
  purpose: TableLockPurpose,
  options: Pick<WithTableLocksOptions, "onLost"> = {}
) {
  if (!tableIds.length || typeof window === "undefined") return null;
  let lost = false;
  const heartbeat = window.setInterval(() => {
    tableIds.forEach((tableId) => {
      void heartbeatTableLock(session, tableId, purpose).catch((error: unknown) => {
        if (lost) return;
        lost = true;
        window.clearInterval(heartbeat);
        const detail = toTableLockConflictDetail(error, tableId, purpose);
        options.onLost?.(detail, error);
      });
    });
  }, HEARTBEAT_MS);
  return heartbeat;
}

export function registerActiveTableLock(registration: ActiveLockRegistration) {
  activeLockRegistrations.add(registration);
  return () => {
    activeLockRegistrations.delete(registration);
  };
}

export async function releaseActiveTableLocks() {
  const registrations = Array.from(activeLockRegistrations);
  activeLockRegistrations.clear();
  await Promise.all(
    registrations.map((registration) =>
      Promise.resolve(registration.release()).catch(() => undefined)
    )
  );
}

export function installTableLockUnloadRelease() {
  if (unloadReleaseInstalled || typeof window === "undefined") return;
  unloadReleaseInstalled = true;
  const release = () => {
    void releaseActiveTableLocks();
  };
  window.addEventListener("pagehide", release);
  window.addEventListener("beforeunload", release);
}

async function runWithTableLocks<T>(
  session: TableLockSession,
  tableIds: Iterable<string | null | undefined>,
  purpose: TableLockPurpose,
  operation: () => Promise<T>,
  options: WithTableLocksOptions = {}
): Promise<T> {
  const requestedTableIds = uniqueTableIds(tableIds);
  const required = options.required === true;
  if (!requestedTableIds.length) {
    if (required) {
      throw buildRequiredLockError(
        "Lock tavolo obbligatorio: tavolo non identificato.",
        requestedTableIds,
        purpose,
        "TABLE_LOCK_TABLE_REQUIRED"
      );
    }
    return operation();
  }
  if (!isValidTableLockSession(session)) {
    if (required) {
      throw buildRequiredLockError(
        "Lock tavolo obbligatorio: sessione operatore non valida.",
        requestedTableIds,
        purpose,
        "TABLE_LOCK_SESSION_REQUIRED"
      );
    }
    return operation();
  }
  if (options.allowOfflineContinuation === true && isBrowserDefinitelyOffline()) {
    return operation();
  }

  const tableIdsToAcquire = options.skipIfAlreadyHeld
    ? requestedTableIds.filter((tableId) => !hasActiveTableLockForSession(tableId, session))
    : requestedTableIds;

  if (!tableIdsToAcquire.length) {
    return operation();
  }

  const acquired: string[] = [];
  let heartbeat: number | null = null;
  let unregister: (() => void) | null = null;
  let released = false;
  let operationStarted = false;

  const release = async () => {
    if (released) return;
    released = true;
    if (heartbeat !== null) {
      window.clearInterval(heartbeat);
      heartbeat = null;
    }
    await Promise.all(
      acquired.map((tableId) => releaseTableLock(session, tableId, purpose, { keepalive: true }))
    );
  };

  try {
    for (const tableId of tableIdsToAcquire) {
      await acquireTableLock(session, tableId, purpose);
      acquired.push(tableId);
    }
    heartbeat = startTableLockHeartbeat(session, acquired, purpose, {
      onLost: options.onLost,
    });
    unregister = registerActiveTableLock({
      tableIds: acquired,
      purpose,
      session,
      release,
    });
    operationStarted = true;
    return await operation();
  } catch (error) {
    if (
      !operationStarted &&
      options.allowOfflineContinuation === true &&
      isTableLockTransportUnavailable(error)
    ) {
      operationStarted = true;
      return await operation();
    }
    if (isTableLockConflictError(error)) {
      const detail = toTableLockConflictDetail(error, requestedTableIds[0], purpose);
      dispatchTableLockConflict(detail);
      options.onConflict?.(detail);
      throw new TableLockError(
        detail.message,
        isTableLockError(error) ? error.status : 409,
        isTableLockError(error) ? error.payload : detail.payload
      );
    }
    throw error;
  } finally {
    unregister?.();
    await release();
  }
}

export function withOptionalTableLocks<T>(
  session: TableLockSession,
  tableIds: Iterable<string | null | undefined>,
  purpose: TableLockPurpose,
  operation: () => Promise<T>,
  options: Omit<WithTableLocksOptions, "required"> = {}
) {
  return runWithTableLocks(session, tableIds, purpose, operation, {
    ...options,
    required: false,
  });
}

export function withRequiredTableLocks<T>(
  session: TableLockSession,
  tableIds: Iterable<string | null | undefined>,
  purpose: TableLockPurpose,
  operation: () => Promise<T>,
  options: Omit<WithTableLocksOptions, "required"> = {}
) {
  return runWithTableLocks(session, tableIds, purpose, operation, {
    ...options,
    required: true,
  });
}

export function withOfflineContinuationTableLocks<T>(
  session: TableLockSession,
  tableIds: Iterable<string | null | undefined>,
  purpose: TableLockPurpose,
  operation: () => Promise<T>,
  options: Omit<WithTableLocksOptions, "required" | "allowOfflineContinuation"> = {}
) {
  return runWithTableLocks(session, tableIds, purpose, operation, {
    ...options,
    required: true,
    allowOfflineContinuation: true,
  });
}

export const withTableLocks = withOptionalTableLocks;
