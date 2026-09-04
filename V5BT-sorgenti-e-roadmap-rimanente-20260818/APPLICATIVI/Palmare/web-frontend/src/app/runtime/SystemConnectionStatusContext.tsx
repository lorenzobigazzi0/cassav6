import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fetchBackendHealth } from "../../api/systemStatus";
import { useRealtimeTransportStatus } from "./realtimeTransportStatus";
import type { SystemConnectionState } from "./systemConnectionStatus";

const HEALTH_PROBE_INTERVAL_MS = 60_000;
const HEALTH_PROBE_MIN_GAP_MS = 60_000;

type SystemConnectionStatusActions = {
  markTransportHealthy: () => void;
  markTransportFailure: () => void;
  probeBackendHealth: () => void;
};

type SystemConnectionStatusValue = SystemConnectionStatusActions & {
  state: SystemConnectionState;
};

const noop = () => {};

const SystemConnectionStatusContext = createContext<SystemConnectionStatusValue>({
  state: "reconnecting",
  markTransportHealthy: noop,
  markTransportFailure: noop,
  probeBackendHealth: noop,
});

export function SystemConnectionStatusProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SystemConnectionState>("reconnecting");
  const realtimeTransport = useRealtimeTransportStatus();
  const failureCountRef = useRef(0);
  const healthProbeInFlightRef = useRef(false);
  const lastHealthProbeAtRef = useRef(0);

  const probeBackendHealth = useCallback(() => {
    if (healthProbeInFlightRef.current) return;
    const now = Date.now();
    if (now - lastHealthProbeAtRef.current < HEALTH_PROBE_MIN_GAP_MS) return;
    lastHealthProbeAtRef.current = now;
    healthProbeInFlightRef.current = true;

    void fetchBackendHealth()
      .then((result) => {
        if (result.ok) {
          failureCountRef.current = 0;
          setState("online");
          return;
        }
        setState("offline");
      })
      .finally(() => {
        healthProbeInFlightRef.current = false;
      });
  }, []);

  const markTransportHealthy = useCallback(() => {
    failureCountRef.current = 0;
    probeBackendHealth();
  }, [probeBackendHealth]);

  const markTransportFailure = useCallback(() => {
    failureCountRef.current += 1;
    setState("reconnecting");
    if (failureCountRef.current >= 2) {
      lastHealthProbeAtRef.current = 0;
      probeBackendHealth();
    }
  }, [probeBackendHealth]);

  useEffect(() => {
    const handleOnline = () => {
      setState("reconnecting");
      lastHealthProbeAtRef.current = 0;
      probeBackendHealth();
    };
    const handleOffline = () => {
      failureCountRef.current += 1;
      setState("offline");
    };
    const runProbe = () => {
      if (!document.hidden) probeBackendHealth();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", runProbe);
    if (navigator.onLine === false) {
      setState("offline");
    } else {
      setState("reconnecting");
      lastHealthProbeAtRef.current = 0;
      probeBackendHealth();
    }
    const timer = window.setInterval(runProbe, HEALTH_PROBE_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", runProbe);
    };
  }, [probeBackendHealth, realtimeTransport.connected]);

  const value = useMemo<SystemConnectionStatusValue>(
    () => ({
      state,
      markTransportHealthy,
      markTransportFailure,
      probeBackendHealth,
    }),
    [markTransportFailure, markTransportHealthy, probeBackendHealth, state]
  );

  return (
    <SystemConnectionStatusContext.Provider value={value}>
      {children}
    </SystemConnectionStatusContext.Provider>
  );
}

export function useSystemConnectionStatus() {
  return useContext(SystemConnectionStatusContext).state;
}

export function useSystemConnectionStatusActions(): SystemConnectionStatusActions {
  const { markTransportHealthy, markTransportFailure, probeBackendHealth } = useContext(
    SystemConnectionStatusContext
  );
  return { markTransportHealthy, markTransportFailure, probeBackendHealth };
}
