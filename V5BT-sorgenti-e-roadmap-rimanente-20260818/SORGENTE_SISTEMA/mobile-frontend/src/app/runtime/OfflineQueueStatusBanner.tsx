import { useEffect, useState, type CSSProperties } from "react";
import {
  getOfflineQueueSummary,
  OFFLINE_STATE_EVENT,
  type OfflineQueueSummary,
} from "../../shared/offline/offlineStore";
import { useAuthStore } from "../../store/authStore";

const EMPTY_SUMMARY: OfflineQueueSummary = {
  pending: 0,
  held: 0,
  failed: 0,
  conflict: 0,
};

const bannerStyle: CSSProperties = {
  position: "fixed",
  right: "16px",
  bottom: "70px",
  zIndex: 100000,
  maxWidth: "min(360px, calc(100vw - 32px))",
  minHeight: "42px",
  padding: "10px 14px",
  borderRadius: "8px",
  background: "rgba(29, 31, 35, 0.96)",
  color: "#fff8e7",
  border: "1px solid rgba(250, 185, 72, 0.72)",
  boxShadow: "0 12px 28px rgba(0, 0, 0, 0.3)",
  fontSize: "13px",
  fontWeight: 750,
  letterSpacing: 0,
  lineHeight: 1.35,
  pointerEvents: "none",
};

export function OfflineQueueStatusBanner() {
  const token = useAuthStore((state) => state.token);
  const userId = useAuthStore((state) => state.userId);
  const deviceUuid = useAuthStore((state) => state.deviceUuid);
  const activityId = useAuthStore((state) => state.activityId);
  const [summary, setSummary] = useState<OfflineQueueSummary>(EMPTY_SUMMARY);

  useEffect(() => {
    if (!token || !userId || !deviceUuid) {
      setSummary(EMPTY_SUMMARY);
      return;
    }

    let disposed = false;
    const refresh = () => {
      void getOfflineQueueSummary({
        ownerUserId: userId,
        ownerActivityId: activityId || undefined,
        ownerDeviceUuid: deviceUuid,
      }).then((next) => {
        if (!disposed) setSummary(next);
      });
    };

    refresh();
    window.addEventListener(OFFLINE_STATE_EVENT, refresh);
    return () => {
      disposed = true;
      window.removeEventListener(OFFLINE_STATE_EVENT, refresh);
    };
  }, [activityId, deviceUuid, token, userId]);

  if (!token) return null;
  const blocked = summary.held + summary.failed + summary.conflict;
  const pending = summary.pending;
  if (blocked <= 0 && pending <= 0) return null;

  const message =
    blocked > 0
      ? `${blocked} operazion${blocked === 1 ? "e richiede" : "i richiedono"} verifica prima della sincronizzazione.`
      : `${pending} operazion${pending === 1 ? "e in attesa" : "i in attesa"} di sincronizzazione.`;

  return (
    <div role="status" aria-live="polite" style={bannerStyle}>
      {message}
    </div>
  );
}
