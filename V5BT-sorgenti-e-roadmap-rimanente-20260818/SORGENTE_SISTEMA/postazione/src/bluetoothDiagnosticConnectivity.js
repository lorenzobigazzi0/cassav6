export const BLUETOOTH_CONNECTIVITY_EVENT = "v5bt:bluetooth-connectivity";

const SNAPSHOT_SCHEMA_VERSION = 1;
const SNAPSHOT_SOURCE = "V5BT_ANDROID_CONNECTIVITY_AGENT";
const MAX_SNAPSHOT_JSON_LENGTH = 512;
const SNAPSHOT_KEYS = ["schemaVersion", "sequence", "source", "state"];
const CONNECTIVITY_STATES = new Set([
  "DISABLED",
  "PERMISSION_REQUIRED",
  "STARTING",
  "DISCOVERING",
  "DIRECT_SERVER",
  "PEER_CONNECTED",
  "DEGRADED",
  "BACKOFF",
  "STOPPED",
]);

const isPlainRecord = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactSnapshotKeys = (value) => {
  const keys = Object.keys(value).sort();
  return (
    keys.length === SNAPSHOT_KEYS.length &&
    keys.every((key, index) => key === SNAPSHOT_KEYS[index])
  );
};

export function parseBluetoothConnectivitySnapshot(raw) {
  try {
    let candidate = raw;
    if (typeof raw === "string") {
      if (raw.length === 0 || raw.length > MAX_SNAPSHOT_JSON_LENGTH) return null;
      candidate = JSON.parse(raw);
    }

    if (!isPlainRecord(candidate) || !hasExactSnapshotKeys(candidate)) return null;
    if (
      candidate.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
      candidate.source !== SNAPSHOT_SOURCE ||
      !Number.isSafeInteger(candidate.sequence) ||
      candidate.sequence < 0 ||
      typeof candidate.state !== "string" ||
      !CONNECTIVITY_STATES.has(candidate.state)
    ) {
      return null;
    }

    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      source: SNAPSHOT_SOURCE,
      sequence: candidate.sequence,
      state: candidate.state,
    };
  } catch {
    return null;
  }
}

const resolveBridge = (target) => {
  try {
    const bridge = target.V5BTBluetoothState;
    if (
      !bridge ||
      (typeof bridge !== "object" && typeof bridge !== "function") ||
      typeof bridge.getState !== "function"
    ) {
      return null;
    }
    return bridge;
  } catch {
    return null;
  }
};

export function subscribeToBluetoothConnectivity(
  onSnapshot,
  target = typeof window === "undefined" ? undefined : window,
) {
  if (
    !target ||
    typeof target.addEventListener !== "function" ||
    typeof target.removeEventListener !== "function"
  ) {
    onSnapshot(null);
    return () => undefined;
  }

  const bridge = resolveBridge(target);
  if (!bridge) {
    onSnapshot(null);
    return () => undefined;
  }

  let closed = false;
  let latestSequence = -1;

  const publish = (raw) => {
    if (closed) return;
    const snapshot = parseBluetoothConnectivitySnapshot(raw);
    if (!snapshot) {
      onSnapshot(null);
      return;
    }
    if (snapshot.sequence < latestSequence) return;
    latestSequence = snapshot.sequence;
    onSnapshot(snapshot);
  };

  const handleStateEvent = (event) => {
    try {
      publish(event.detail);
    } catch {
      publish(null);
    }
  };

  try {
    target.addEventListener(BLUETOOTH_CONNECTIVITY_EVENT, handleStateEvent);
  } catch {
    onSnapshot(null);
    return () => undefined;
  }
  try {
    publish(bridge.getState());
  } catch {
    publish(null);
  }

  return () => {
    if (closed) return;
    closed = true;
    try {
      target.removeEventListener(BLUETOOTH_CONNECTIVITY_EVENT, handleStateEvent);
    } catch {
      // The component is already closed; a broken native event surface stays fail-closed.
    }
  };
}
