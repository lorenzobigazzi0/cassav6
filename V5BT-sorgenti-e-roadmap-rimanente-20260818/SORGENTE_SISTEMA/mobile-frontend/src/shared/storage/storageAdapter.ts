export type StorageAreaName = "local" | "session";

function browserStorage(area: StorageAreaName): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return area === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStorageString(area: StorageAreaName, key: string) {
  const storage = browserStorage(area);
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorageString(area: StorageAreaName, key: string, value: string) {
  const storage = browserStorage(area);
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // ignore unavailable or full storage
  }
}

export function removeStorageString(area: StorageAreaName, key: string) {
  const storage = browserStorage(area);
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // ignore unavailable storage
  }
}

export function readLocalStorageString(key: string) {
  return readStorageString("local", key);
}

export function writeLocalStorageString(key: string, value: string) {
  writeStorageString("local", key, value);
}

export function removeLocalStorageString(key: string) {
  removeStorageString("local", key);
}

export function readSessionStorageString(key: string) {
  return readStorageString("session", key);
}

export function writeSessionStorageString(key: string, value: string) {
  writeStorageString("session", key, value);
}

export function removeSessionStorageString(key: string) {
  removeStorageString("session", key);
}

export function readDualStorageString(key: string) {
  const localValue = readLocalStorageString(key);
  return localValue !== null ? localValue : readSessionStorageString(key);
}

export function writeDualStorageString(key: string, value: string) {
  writeLocalStorageString(key, value);
  writeSessionStorageString(key, value);
}

export function removeDualStorageString(key: string) {
  removeLocalStorageString(key);
  removeSessionStorageString(key);
}

export function readJsonFromStorage<T>(area: StorageAreaName, key: string, fallback: T): T {
  const raw = readStorageString(area, key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonToStorage(area: StorageAreaName, key: string, value: unknown) {
  writeStorageString(area, key, JSON.stringify(value));
}

export function forEachStorageArea(callback: (storage: Storage, area: StorageAreaName) => void) {
  (["local", "session"] as const).forEach((area) => {
    const storage = browserStorage(area);
    if (!storage) return;
    callback(storage, area);
  });
}

export function removeMatchingStorageKeys(prefixes: readonly string[], keys: readonly string[]) {
  const cleared: string[] = [];
  forEachStorageArea((storage) => {
    keys.forEach((key) => {
      try {
        storage.removeItem(key);
        cleared.push(key);
      } catch {
        // ignore unavailable storage
      }
    });

    try {
      for (let index = storage.length - 1; index >= 0; index -= 1) {
        const key = storage.key(index);
        if (!key || !prefixes.some((prefix) => key.startsWith(prefix))) continue;
        storage.removeItem(key);
        cleared.push(key);
      }
    } catch {
      // ignore unavailable storage
    }
  });

  return Array.from(new Set(cleared));
}
