const DATABASE_NAME = "palmare-offline-configuration-v1";
const DATABASE_VERSION = 1;
const SNAPSHOT_STORE = "configuration-snapshots";

export type StoredConfigurationSnapshot<T> = {
  key: string;
  schemaVersion: number;
  revision: number;
  savedAt: number;
  payload: T;
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
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
        database.createObjectStore(SNAPSHOT_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        databasePromise = null;
      };
      resolve(request.result);
    };
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

const runRequest = async <T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> => {
  const database = await openDatabase();
  if (!database) return null;

  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(SNAPSHOT_STORE, mode);
      const request = operation(transaction.objectStore(SNAPSHOT_STORE));
      let result: T | null = null;
      let succeeded = false;
      request.onsuccess = () => {
        result = request.result;
        succeeded = true;
      };
      request.onerror = () => resolve(null);
      transaction.oncomplete = () => resolve(succeeded ? result : null);
      transaction.onerror = () => resolve(null);
      transaction.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
};

export async function readStoredConfigurationSnapshot<T>(key: string) {
  const normalizedKey = key.trim();
  if (!normalizedKey) return null;
  return runRequest<StoredConfigurationSnapshot<T>>("readonly", (store) =>
    store.get(normalizedKey)
  );
}

export async function writeStoredConfigurationSnapshot<T>(
  snapshot: StoredConfigurationSnapshot<T>
) {
  if (!snapshot.key.trim()) return false;
  const result = await runRequest<IDBValidKey>("readwrite", (store) => store.put(snapshot));
  return result !== null;
}

export async function deleteStoredConfigurationSnapshot(key: string) {
  const normalizedKey = key.trim();
  if (!normalizedKey) return false;
  const database = await openDatabase();
  if (!database) return false;

  return new Promise<boolean>((resolve) => {
    try {
      const transaction = database.transaction(SNAPSHOT_STORE, "readwrite");
      transaction.objectStore(SNAPSHOT_STORE).delete(normalizedKey);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
      transaction.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}
