import { offlineOutboxEntryMatchesOwner } from "./offlineReplayState";

const DATABASE_NAME = "palmare-offline-v1";
const DATABASE_VERSION = 1;
const CACHE_STORE = "api-cache";
const OUTBOX_STORE = "outbox";
const STATE_EVENT = "palmare:offline-state";
const MAX_CACHE_BODY_BYTES = 5 * 1024 * 1024;

export type CachedApiResponse = {
  key: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  storedAt: number;
};

export type OfflineOutboxStatus = "pending" | "sending" | "held" | "failed" | "conflict";

export type OfflineOutboxTerminalFailure = {
  kind: "http_conflict" | "http_rejected";
  httpStatus: number;
  recordedAt: number;
};

export type OfflineOutboxOwner = {
  ownerUserId?: string;
  ownerActivityId?: string;
  ownerDeviceUuid?: string;
};

export type OfflineOutboxEntry = {
  requestId: string;
  idempotencyKey: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  replayMode: "automatic" | "held";
  status: OfflineOutboxStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  expiresAt: number;
  lastError: string;
  terminalFailure?: OfflineOutboxTerminalFailure;
  legacyMigrationVersion?: number;
  ownerUserId?: string;
  ownerActivityId?: string;
  ownerDeviceUuid?: string;
};

export type OfflineQueueSummary = {
  pending: number;
  held: number;
  failed: number;
  conflict: number;
};

let databasePromise: Promise<IDBDatabase | null> | null = null;

const openDatabase = () => {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CACHE_STORE)) {
        database.createObjectStore(CACHE_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
        const store = database.createObjectStore(OUTBOX_STORE, { keyPath: "requestId" });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("nextAttemptAt", "nextAttemptAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      databasePromise = null;
      resolve(null);
    };
    request.onblocked = () => {
      databasePromise = null;
      resolve(null);
    };
  });
  return databasePromise;
};

const runStoreRequest = async <T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> => {
  const database = await openDatabase();
  if (!database) return null;
  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      let requestResult: T | null = null;
      let requestSucceeded = false;
      request.onsuccess = () => {
        requestResult = request.result;
        requestSucceeded = true;
      };
      request.onerror = () => resolve(null);
      transaction.oncomplete = () => resolve(requestSucceeded ? requestResult : null);
      transaction.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
};

const notifyStateChanged = () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(STATE_EVENT));
};

const normalizedCacheUrl = (url: string) => {
  try {
    const parsed = new URL(url, "https://appassets.androidplatform.net");
    parsed.searchParams.delete("_");
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return url;
  }
};

export const offlineCacheKey = (method: string, url: string, body: string | null) =>
  `${method.toUpperCase()}|${normalizedCacheUrl(url)}|${body ?? ""}`;

export async function storeCachedResponse(entry: CachedApiResponse) {
  if (entry.body.length > MAX_CACHE_BODY_BYTES) return false;
  const result = await runStoreRequest<IDBValidKey>(CACHE_STORE, "readwrite", (store) =>
    store.put(entry)
  );
  return result !== null;
}

export async function readCachedResponse(key: string, maxAgeMs: number) {
  const entry = await runStoreRequest<CachedApiResponse>(CACHE_STORE, "readonly", (store) =>
    store.get(key)
  );
  if (!entry) return null;
  if (maxAgeMs > 0 && Date.now() - entry.storedAt > maxAgeMs) return null;
  return entry;
}

export async function enqueueOfflineRequest(entry: OfflineOutboxEntry) {
  const result = await runStoreRequest<IDBValidKey>(OUTBOX_STORE, "readwrite", (store) =>
    store.put(entry)
  );
  if (result !== null) notifyStateChanged();
  return result !== null;
}

export async function listOfflineRequests() {
  return (
    (await runStoreRequest<OfflineOutboxEntry[]>(OUTBOX_STORE, "readonly", (store) =>
      store.getAll()
    )) ?? []
  ).sort((left, right) => left.createdAt - right.createdAt);
}

export async function updateOfflineRequest(entry: OfflineOutboxEntry) {
  const result = await runStoreRequest<IDBValidKey>(OUTBOX_STORE, "readwrite", (store) =>
    store.put(entry)
  );
  if (result !== null) notifyStateChanged();
  return result !== null;
}

export async function removeOfflineRequest(requestId: string) {
  const database = await openDatabase();
  if (!database) return false;
  const removed = await new Promise<boolean>((resolve) => {
    try {
      const transaction = database.transaction(OUTBOX_STORE, "readwrite");
      transaction.objectStore(OUTBOX_STORE).delete(requestId);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
  if (removed) notifyStateChanged();
  return removed;
}

export async function getOfflineQueueSummary(
  owner?: OfflineOutboxOwner
): Promise<OfflineQueueSummary> {
  const entries = (await listOfflineRequests()).filter(
    (entry) => !owner || offlineOutboxEntryMatchesOwner(entry, owner)
  );
  return entries.reduce<OfflineQueueSummary>(
    (summary, entry) => {
      if (entry.status === "pending" || entry.status === "sending") summary.pending += 1;
      else if (entry.status === "held") summary.held += 1;
      else if (entry.status === "failed") summary.failed += 1;
      else if (entry.status === "conflict") summary.conflict += 1;
      return summary;
    },
    { pending: 0, held: 0, failed: 0, conflict: 0 }
  );
}

export { STATE_EVENT as OFFLINE_STATE_EVENT };
