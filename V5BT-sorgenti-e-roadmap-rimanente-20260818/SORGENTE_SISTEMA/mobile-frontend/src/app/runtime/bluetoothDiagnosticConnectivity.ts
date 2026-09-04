export const BLUETOOTH_CONNECTIVITY_EVENT = "v5bt:bluetooth-connectivity";

const SNAPSHOT_SCHEMA_VERSION = 1;
const SNAPSHOT_SOURCE = "V5BT_ANDROID_CONNECTIVITY_AGENT";
const MAX_SNAPSHOT_JSON_LENGTH = 512;
const SNAPSHOT_KEYS = ["schemaVersion", "sequence", "source", "state"] as const;

const CONNECTIVITY_STATES = [
  "DISABLED",
  "PERMISSION_REQUIRED",
  "STARTING",
  "DISCOVERING",
  "DIRECT_SERVER",
  "PEER_CONNECTED",
  "DEGRADED",
  "BACKOFF",
  "STOPPED",
] as const;

export type BluetoothConnectivityState = (typeof CONNECTIVITY_STATES)[number];

export type BluetoothConnectivitySnapshot = {
  schemaVersion: 1;
  source: typeof SNAPSHOT_SOURCE;
  sequence: number;
  state: BluetoothConnectivityState;
};

type BluetoothStateBridge = {
  getState: () => unknown;
};

declare global {
  interface Window {
    V5BTBluetoothState?: BluetoothStateBridge;
  }
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactSnapshotKeys = (value: Record<string, unknown>) => {
  const keys = Object.keys(value).sort();
  return (
    keys.length === SNAPSHOT_KEYS.length && keys.every((key, index) => key === SNAPSHOT_KEYS[index])
  );
};

export function parseBluetoothConnectivitySnapshot(
  raw: unknown
): BluetoothConnectivitySnapshot | null {
  try {
    let candidate = raw;
    if (typeof raw === "string") {
      if (raw.length === 0 || raw.length > MAX_SNAPSHOT_JSON_LENGTH) return null;
      candidate = JSON.parse(raw) as unknown;
    }

    if (!isPlainRecord(candidate) || !hasExactSnapshotKeys(candidate)) return null;
    if (
      candidate.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
      candidate.source !== SNAPSHOT_SOURCE
    ) {
      return null;
    }
    if (!Number.isSafeInteger(candidate.sequence) || (candidate.sequence as number) < 0)
      return null;
    if (
      typeof candidate.state !== "string" ||
      !CONNECTIVITY_STATES.includes(candidate.state as BluetoothConnectivityState)
    ) {
      return null;
    }

    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      source: SNAPSHOT_SOURCE,
      sequence: candidate.sequence as number,
      state: candidate.state as BluetoothConnectivityState,
    };
  } catch {
    return null;
  }
}

function resolveBridge(target: Window): BluetoothStateBridge | null {
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
}

export function subscribeToBluetoothConnectivity(
  onSnapshot: (snapshot: BluetoothConnectivitySnapshot | null) => void,
  target: Window | undefined = typeof window === "undefined" ? undefined : window
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

  const publish = (raw: unknown) => {
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

  const handleStateEvent: EventListener = (event) => {
    try {
      publish((event as CustomEvent<unknown>).detail);
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
