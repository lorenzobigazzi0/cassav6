import { useEffect, useState } from "react";

export type RealtimeTransportStatus = "connecting" | "connected" | "disconnected" | "unavailable";

export type RealtimeTransportStatusDetail = {
  status: RealtimeTransportStatus;
  connected: boolean;
  updatedAtMs: number;
  source: string;
};

export const REALTIME_TRANSPORT_STATUS_EVENT = "pos:realtime-transport-status";

let currentStatus: RealtimeTransportStatusDetail = {
  status: "connecting",
  connected: false,
  updatedAtMs: Date.now(),
  source: "bootstrap",
};

export function readRealtimeTransportStatus(): RealtimeTransportStatusDetail {
  return currentStatus;
}

export function publishRealtimeTransportStatus(
  status: RealtimeTransportStatus,
  source = "notification-stream"
) {
  const previous = currentStatus;
  const next = {
    status,
    connected: status === "connected",
    updatedAtMs: Date.now(),
    source,
  };
  const shouldNotify = previous.status !== next.status || previous.connected !== next.connected;
  currentStatus = shouldNotify ? next : previous;
  if (!shouldNotify) return;
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<RealtimeTransportStatusDetail>(REALTIME_TRANSPORT_STATUS_EVENT, {
      detail: currentStatus,
    })
  );
}

export function useRealtimeTransportStatus(): RealtimeTransportStatusDetail {
  const [status, setStatus] = useState(readRealtimeTransportStatus);

  useEffect(() => {
    const handleStatus = (event: Event) => {
      const detail = (event as CustomEvent<RealtimeTransportStatusDetail>).detail;
      if (!detail) return;
      setStatus(detail);
    };
    window.addEventListener(REALTIME_TRANSPORT_STATUS_EVENT, handleStatus);
    setStatus(readRealtimeTransportStatus());
    return () => {
      window.removeEventListener(REALTIME_TRANSPORT_STATUS_EVENT, handleStatus);
    };
  }, []);

  return status;
}
