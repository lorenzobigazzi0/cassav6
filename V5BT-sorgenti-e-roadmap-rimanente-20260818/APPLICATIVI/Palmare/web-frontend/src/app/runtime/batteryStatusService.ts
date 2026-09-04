import {
  readLocalPreference,
  writeLocalPreference,
} from "../../shared/storage/preferenceStorage";

export type BatteryDevice = {
  level?: number;
  charging?: boolean;
  online?: boolean;
  deviceName?: string;
};

export type BatteryState =
  | { kind: "unknown"; message: string }
  | {
      kind: "ready";
      device: Required<Pick<BatteryDevice, "level">> & BatteryDevice;
      stale: boolean;
    };

type NativeBatteryBridge = {
  getSnapshot?: () => string;
};

type BrowserBatteryManager = {
  level: number;
  charging: boolean;
  addEventListener: (type: "levelchange" | "chargingchange", listener: () => void) => void;
  removeEventListener: (type: "levelchange" | "chargingchange", listener: () => void) => void;
};

type BatteryNavigator = Navigator & {
  getBattery?: () => Promise<BrowserBatteryManager>;
};

type NativeBatteryPayload = {
  level?: unknown;
  charging?: unknown;
  isCharging?: unknown;
  deviceName?: unknown;
};

declare global {
  interface Window {
    AmaliaNativeBattery?: NativeBatteryBridge;
  }
}

export const NATIVE_BATTERY_EVENT = "amalia:native-battery";
const CACHED_BATTERY_STATE_KEY = "pos_mobile_battery_last_ready_state";

export function buildUnknownBatteryState(message = "Batteria non disponibile"): BatteryState {
  return { kind: "unknown", message };
}

export function buildBatteryStateSignature(state: BatteryState) {
  if (state.kind === "unknown") return `unknown:${state.message}`;
  const level = Math.max(0, Math.min(100, Math.round(state.device.level)));
  return [
    "ready",
    level,
    state.device.charging ? "charging" : "not-charging",
    state.device.deviceName || "",
    state.stale ? "stale" : "fresh",
  ].join("|");
}

function normalizeReadyBatteryState(value: unknown): BatteryState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { device?: BatteryDevice; stale?: boolean };
  if (!record.device || typeof record.device.level !== "number") return null;
  return {
    kind: "ready",
    device: { ...record.device, level: record.device.level },
    stale: Boolean(record.stale),
  };
}

export function normalizeLocalBatteryState(value: unknown): BatteryState | null {
  let payload = value;
  if (typeof payload === "string") {
    const normalized = payload.trim();
    if (!normalized) return null;
    try {
      payload = JSON.parse(normalized) as unknown;
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object") return null;

  const record = payload as NativeBatteryPayload;
  const numericLevel = Number(record.level);
  if (!Number.isFinite(numericLevel)) return null;

  return {
    kind: "ready",
    device: {
      level: Math.max(0, Math.min(100, Math.round(numericLevel))),
      charging: record.charging === true || record.isCharging === true,
      online: true,
      deviceName:
        typeof record.deviceName === "string" && record.deviceName.trim()
          ? record.deviceName.trim()
          : "Questo dispositivo",
    },
    stale: false,
  };
}

export function readCachedBatteryState(): BatteryState {
  try {
    const rawValue = readLocalPreference(CACHED_BATTERY_STATE_KEY);
    if (!rawValue) return buildUnknownBatteryState();
    const parsed = JSON.parse(rawValue) as unknown;
    const state = normalizeReadyBatteryState(parsed);
    return state ? markBatteryStateStale(state) : buildUnknownBatteryState();
  } catch {
    return buildUnknownBatteryState();
  }
}

export function persistCachedBatteryState(state: BatteryState) {
  if (state.kind !== "ready") return;
  try {
    writeLocalPreference(
      CACHED_BATTERY_STATE_KEY,
      JSON.stringify({
        device: state.device,
        stale: false,
        savedAt: Date.now(),
      })
    );
  } catch {
    // La batteria live continua a funzionare anche se lo storage non e disponibile.
  }
}

export function markBatteryStateStale(state: BatteryState): BatteryState {
  if (state.kind !== "ready") return state;
  return {
    ...state,
    stale: true,
  };
}

export function hasNativeBatterySource() {
  return typeof window !== "undefined" &&
    typeof window.AmaliaNativeBattery?.getSnapshot === "function";
}

export function readNativeBatteryState(): BatteryState | null {
  if (!hasNativeBatterySource()) return null;
  try {
    return normalizeLocalBatteryState(window.AmaliaNativeBattery?.getSnapshot?.());
  } catch {
    return null;
  }
}

export function subscribeNativeBatteryState(onState: (state: BatteryState) => void) {
  const handleBatteryEvent = (event: Event) => {
    const state = normalizeLocalBatteryState((event as CustomEvent<unknown>).detail);
    if (state) onState(state);
  };
  window.addEventListener(NATIVE_BATTERY_EVENT, handleBatteryEvent);
  return () => window.removeEventListener(NATIVE_BATTERY_EVENT, handleBatteryEvent);
}

export async function subscribeBrowserBatteryState(
  onState: (state: BatteryState) => void
): Promise<(() => void) | null> {
  const getBattery = (navigator as BatteryNavigator).getBattery;
  if (typeof getBattery !== "function") return null;

  try {
    const manager = await getBattery.call(navigator);
    const emit = () => {
      const state = normalizeLocalBatteryState({
        level: manager.level * 100,
        charging: manager.charging,
        deviceName: "Questo dispositivo",
      });
      if (state) onState(state);
    };
    manager.addEventListener("levelchange", emit);
    manager.addEventListener("chargingchange", emit);
    emit();
    return () => {
      manager.removeEventListener("levelchange", emit);
      manager.removeEventListener("chargingchange", emit);
    };
  } catch {
    return null;
  }
}

