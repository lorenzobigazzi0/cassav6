import { isRuntimeFeatureEnabled } from "../../config/runtimeConfig";
import { MOBILE_SESSION_ENDING_EVENT } from "../../app/session/sessionLifecycle";
import { useAuthStore } from "../../store/authStore";
import { classifyOfflineRequest } from "./offlineRequestPolicy";
import {
  listOfflineRequests,
  removeOfflineRequest,
  updateOfflineRequest,
  type OfflineOutboxEntry,
} from "./offlineStore";
import {
  evaluateOfflineReplayOwnership,
  holdExpiredOfflineRequest,
  holdOfflineRequestAfterHttpFailure,
  OFFLINE_OUTBOX_LEGACY_MIGRATION_VERSION,
  planLegacyOfflineRequestMigration,
  withDerivedOfflineOutboxOwner,
} from "./offlineReplayState";

const BASE_RETRY_MS = 2_000;
const MAX_RETRY_MS = 5 * 60 * 1000;
const FALLBACK_FLUSH_MS = 15_000;
const REPLAY_TIMEOUT_MS = 15_000;
const FISCAL_RECONCILIATION_PATH = /\/api\/reports\/payment-movement\/fiscal\/(issue|void)$/;
export const OFFLINE_REPLAY_APPLIED_EVENT = "palmare:offline-replay-applied";

let installed = false;
let flushRunning = false;
let replayAppliedCount = 0;
const activeReplayControllers = new Set<AbortController>();

const retryDelayFor = (attempts: number) =>
  Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.min(Math.max(attempts, 0), 8));

const pathnameOf = (value: string) => {
  try {
    return new URL(value, window.location.origin).pathname;
  } catch {
    return value.split("?")[0] || value;
  }
};

const currentOriginUrl = (value: string) => {
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.pathname.startsWith("/api/")) {
      return new URL(`${parsed.pathname}${parsed.search}`, window.location.origin).toString();
    }
    return parsed.toString();
  } catch {
    return value;
  }
};

const bodyWithCurrentAuth = (entry: OfflineOutboxEntry) => {
  if (!entry.body) return null;
  const auth = useAuthStore.getState();
  try {
    const parsed = JSON.parse(entry.body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return entry.body;
    return JSON.stringify({
      ...(parsed as Record<string, unknown>),
      ...(auth.token ? { token: auth.token } : {}),
      ...(auth.userId ? { userId: auth.userId } : {}),
      ...(auth.deviceUuid ? { deviceUuid: auth.deviceUuid } : {}),
    });
  } catch {
    return entry.body;
  }
};

const headersWithCurrentAuth = (entry: OfflineOutboxEntry) => {
  const headers = new Headers(entry.headers);
  const auth = useAuthStore.getState();
  if (auth.token) headers.set("Authorization", `Bearer ${auth.token}`);
  if (auth.userId) headers.set("X-User-Id", auth.userId);
  if (auth.deviceUuid) headers.set("X-Device-Uuid", auth.deviceUuid);
  headers.set("X-Command-Request-Id", entry.requestId);
  headers.set("X-Idempotency-Key", entry.idempotencyKey || entry.requestId);
  headers.set("X-Palmare-Offline-Replay", "1");
  return headers;
};

const updateAfterFailure = async (entry: OfflineOutboxEntry, error: string) => {
  const attempts = entry.attempts + 1;
  await updateOfflineRequest({
    ...entry,
    attempts,
    status: "pending",
    replayMode: "automatic",
    updatedAt: Date.now(),
    nextAttemptAt: Date.now() + retryDelayFor(attempts),
    lastError: error,
  });
};

const describeReplayHttpFailure = async (response: Response) => {
  let detail = "";
  try {
    const body = (await response.clone().text()).trim();
    if (body) {
      try {
        const parsed = JSON.parse(body) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const source = parsed as Record<string, unknown>;
          detail = String(source.error ?? source.message ?? source.code ?? "").trim();
        } else if (typeof parsed === "string") {
          detail = parsed.trim();
        }
      } catch {
        detail = body;
      }
    }
  } catch {
    detail = "";
  }

  const statusLabel = response.statusText.trim()
    ? `${response.status} ${response.statusText.trim()}`
    : String(response.status);
  const safeDetail = detail.replace(/\s+/g, " ").slice(0, 280);
  return safeDetail
    ? `Operazione rifiutata dal backend (${statusLabel}): ${safeDetail}`
    : `Operazione rifiutata dal backend (${statusLabel}).`;
};

const replayEntry = async (entry: OfflineOutboxEntry) => {
  const now = Date.now();
  const auth = useAuthStore.getState();
  const ownedEntry = withDerivedOfflineOutboxOwner(entry);
  const ownership = evaluateOfflineReplayOwnership(ownedEntry, auth);
  if (ownership.state === "unknown-owner") {
    await updateOfflineRequest({
      ...ownedEntry,
      replayMode: "held",
      status: "held",
      updatedAt: now,
      nextAttemptAt: 0,
      lastError:
        "Proprietario dell'operazione offline non determinabile: replay sospeso per sicurezza.",
      legacyMigrationVersion: OFFLINE_OUTBOX_LEGACY_MIGRATION_VERSION,
    });
    return;
  }
  if (ownership.state === "different-owner") return;
  if (ownedEntry.expiresAt > 0 && ownedEntry.expiresAt <= now) {
    await updateOfflineRequest(holdExpiredOfflineRequest(ownedEntry, now));
    return;
  }
  const hadProtectedAuth = Boolean(
    ownedEntry.headers.Authorization ?? ownedEntry.headers.authorization
  );
  if (hadProtectedAuth && !auth.token) {
    await updateAfterFailure(ownedEntry, "Accesso necessario prima dell'invio automatico.");
    return;
  }

  await updateOfflineRequest({ ...ownedEntry, status: "sending", updatedAt: now });
  const controller = new AbortController();
  activeReplayControllers.add(controller);
  const timeout = window.setTimeout(() => controller.abort(), REPLAY_TIMEOUT_MS);
  try {
    const response = await fetch(currentOriginUrl(ownedEntry.url), {
      method: ownedEntry.method,
      headers: headersWithCurrentAuth(ownedEntry),
      body: bodyWithCurrentAuth(ownedEntry),
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (response.ok) {
      replayAppliedCount += 1;
      await removeOfflineRequest(ownedEntry.requestId);
      return;
    }
    if (response.status >= 400 && response.status < 500) {
      const lastError = await describeReplayHttpFailure(response);
      await updateOfflineRequest(
        holdOfflineRequestAfterHttpFailure(ownedEntry, response.status, lastError)
      );
      return;
    }
    await updateAfterFailure(ownedEntry, `Backend non disponibile (${response.status}).`);
  } catch (error) {
    await updateAfterFailure(
      ownedEntry,
      error instanceof Error ? error.message : "Errore di rete durante il replay."
    );
  } finally {
    window.clearTimeout(timeout);
    activeReplayControllers.delete(controller);
  }
};

export async function migrateLegacyOfflineRequests() {
  const entries = await listOfflineRequests();
  let fiscalRequeued = 0;
  let preserved = 0;
  let ownershipMigrated = 0;
  const now = Date.now();
  for (const storedEntry of entries) {
    const entry = withDerivedOfflineOutboxOwner(storedEntry);
    const ownerWasDerived =
      entry.ownerUserId !== storedEntry.ownerUserId ||
      entry.ownerActivityId !== storedEntry.ownerActivityId ||
      entry.ownerDeviceUuid !== storedEntry.ownerDeviceUuid;
    if (!entry.ownerUserId) {
      await updateOfflineRequest({
        ...entry,
        replayMode: "held",
        status: entry.status === "failed" || entry.status === "conflict" ? entry.status : "held",
        updatedAt: now,
        nextAttemptAt: 0,
        lastError:
          String(entry.lastError ?? "").trim() ||
          "Proprietario dell'operazione offline non determinabile: replay sospeso per sicurezza.",
        legacyMigrationVersion: OFFLINE_OUTBOX_LEGACY_MIGRATION_VERSION,
      });
      preserved += 1;
      continue;
    }
    const pathname = pathnameOf(entry.url);
    const policy = classifyOfflineRequest(pathname, entry.method);
    const isFiscalReconciliation =
      policy.mode === "automatic" && FISCAL_RECONCILIATION_PATH.test(pathname);
    const migration = planLegacyOfflineRequestMigration({
      entry,
      isFiscalReconciliation,
      now,
    });
    if (migration === "none") {
      if (ownerWasDerived) {
        await updateOfflineRequest(entry);
        ownershipMigrated += 1;
      }
      continue;
    }
    if (migration === "requeue-fiscal") {
      await updateOfflineRequest({
        ...entry,
        replayMode: "automatic",
        status: "pending",
        updatedAt: now,
        nextAttemptAt: now,
        lastError: "Riconciliazione fiscale automatica in attesa del backend.",
        legacyMigrationVersion: OFFLINE_OUTBOX_LEGACY_MIGRATION_VERSION,
      });
      fiscalRequeued += 1;
    } else {
      await updateOfflineRequest({
        ...entry,
        replayMode: "held",
        updatedAt: now,
        nextAttemptAt: 0,
        lastError:
          String(entry.lastError ?? "").trim() ||
          "Operazione offline sospesa: verifica richiesta prima del replay.",
        legacyMigrationVersion: OFFLINE_OUTBOX_LEGACY_MIGRATION_VERSION,
      });
      preserved += 1;
    }
  }
  return { fiscalRequeued, preserved, ownershipMigrated, removed: 0 };
}

export async function flushOfflineRequests() {
  if (!isRuntimeFeatureEnabled("offlineMode") || flushRunning) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  flushRunning = true;
  replayAppliedCount = 0;
  try {
    const now = Date.now();
    const entries = await listOfflineRequests();
    for (const entry of entries) {
      if (entry.replayMode !== "automatic") continue;
      if (entry.status !== "pending" && entry.status !== "sending") continue;
      if (entry.nextAttemptAt > now) continue;
      await replayEntry(entry);
    }
  } finally {
    const appliedCount = replayAppliedCount;
    replayAppliedCount = 0;
    flushRunning = false;
    if (appliedCount > 0 && typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(OFFLINE_REPLAY_APPLIED_EVENT, { detail: { appliedCount } })
      );
    }
  }
}

export function installOfflineRuntime() {
  if (installed || !isRuntimeFeatureEnabled("offlineMode") || typeof window === "undefined") {
    return;
  }
  installed = true;
  window.addEventListener(MOBILE_SESSION_ENDING_EVENT, () => {
    activeReplayControllers.forEach((controller) => controller.abort());
  });
  window.addEventListener("online", () => void flushOfflineRequests());
  window.addEventListener("pos:realtime-transport-status", (event) => {
    const connected = (event as CustomEvent<{ connected?: boolean }>).detail?.connected;
    if (connected === true) void flushOfflineRequests();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void flushOfflineRequests();
  });
  window.setInterval(() => void flushOfflineRequests(), FALLBACK_FLUSH_MS);
  void migrateLegacyOfflineRequests().then(() => flushOfflineRequests());
}
