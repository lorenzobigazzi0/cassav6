import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  buildBatteryStateSignature,
  hasNativeBatterySource,
  persistCachedBatteryState,
  readCachedBatteryState,
  readNativeBatteryState,
  subscribeBrowserBatteryState,
  subscribeNativeBatteryState,
  type BatteryState,
} from "./batteryStatusService";

let cachedBatteryState: BatteryState = readCachedBatteryState();
let cachedBatteryStateSignature = buildBatteryStateSignature(cachedBatteryState);

const BatteryStatusContext = createContext<BatteryState | null>(null);

export function BatteryStatusProvider({ children }: { children: ReactNode }) {
  const [batteryState, setBatteryState] = useState<BatteryState>(() => cachedBatteryState);
  const batteryStateSignatureRef = useRef(cachedBatteryStateSignature);

  useEffect(() => {
    let disposed = false;
    let disposeBrowserBattery: (() => void) | null = null;

    const commitBatteryState = (nextState: BatteryState) => {
      if (disposed) return;
      const nextSignature = buildBatteryStateSignature(nextState);
      if (batteryStateSignatureRef.current === nextSignature) return;
      batteryStateSignatureRef.current = nextSignature;
      cachedBatteryStateSignature = nextSignature;
      cachedBatteryState = nextState;
      if (nextState.kind === "ready" && !nextState.stale) {
        persistCachedBatteryState(nextState);
      }
      setBatteryState(nextState);
    };

    const refreshNativeBattery = () => {
      const nextState = readNativeBatteryState();
      if (nextState) commitBatteryState(nextState);
    };

    const disposeNativeBattery = subscribeNativeBatteryState(commitBatteryState);
    refreshNativeBattery();

    if (!hasNativeBatterySource()) {
      void subscribeBrowserBatteryState(commitBatteryState).then((dispose) => {
        if (disposed) {
          dispose?.();
          return;
        }
        disposeBrowserBattery = dispose;
      });
    }

    const onVisibilityChange = () => {
      if (!document.hidden) refreshNativeBattery();
    };
    const onPageShow = () => refreshNativeBattery();

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      disposed = true;
      disposeNativeBattery();
      disposeBrowserBattery?.();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  return (
    <BatteryStatusContext.Provider value={batteryState}>
      {children}
    </BatteryStatusContext.Provider>
  );
}

export function useMobileBatteryStatus() {
  return useContext(BatteryStatusContext) ?? cachedBatteryState;
}

