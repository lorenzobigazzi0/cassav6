import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchWaiterPauseStatus,
  startWaiterPause,
  stopWaiterPause,
  type WaiterPausePayload,
  type WaiterPauseState,
} from "../../../api/waiterPause";
import { useRealtimeTransportStatus } from "../../../app/runtime/realtimeTransportStatus";
import { useAuthStore } from "../../../store/authStore";
import { triggerHapticPulse } from "../../../utils/haptics";

const WAITER_PAUSE_CONNECTED_REFRESH_MS = 90_000;
const WAITER_PAUSE_DISCONNECTED_REFRESH_MS = 30_000;

const formatRemaining = (ms: number) => {
  const safeSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const formatRenewalInterval = (minutes: number) => {
  const safeMinutes = Math.max(0, Math.round(Number(minutes) || 0));
  if (safeMinutes < 60) return `${safeMinutes} minuti`;
  const hours = Math.floor(safeMinutes / 60);
  const restMinutes = safeMinutes % 60;
  const hoursLabel = hours === 1 ? "1 ora" : `${hours} ore`;
  if (restMinutes === 0) return hoursLabel;
  const minutesLabel = restMinutes === 1 ? "1 minuto" : `${restMinutes} minuti`;
  return `${hoursLabel} e ${minutesLabel}`;
};

const nextTickRemaining = (pause: WaiterPauseState | null, nowMs: number) => {
  if (!pause) return 0;
  const serverRemaining = Math.max(0, Math.trunc(Number(pause.remainingMs) || 0));
  if (pause.active) {
    const clockRemaining = Math.max(0, pause.endsAtMs - nowMs);
    return serverRemaining > 0 ? Math.min(serverRemaining, clockRemaining) : clockRemaining;
  }
  if ((pause.available || pause.graceActive) && serverRemaining > 0) return serverRemaining;
  if (!pause.available && pause.nextAvailableAtMs > nowMs) {
    return Math.max(0, pause.nextAvailableAtMs - nowMs);
  }
  return 0;
};

const WaiterPauseActionIcon = ({ active }: { active: boolean }) => (
  <svg className="waiter-pause-action-icon" viewBox="0 0 24 24" aria-hidden="true">
    {active ? <path d="M7 6h10v12H7z" /> : <path d="M8 5v14l11-7z" />}
  </svg>
);

const waiterPauseStatusCache = new Map<string, WaiterPauseState>();

const pauseCacheKey = (payload: WaiterPausePayload) =>
  [payload.userId, payload.deviceUuid, payload.roomId || ""].join("|");

const pauseStateSignature = (pause: WaiterPauseState | null) =>
  pause
    ? [
        pause.enabled,
        pause.durationMinutes,
        pause.renewalMinutes,
        pause.active,
        pause.graceActive,
        pause.status,
        pause.startedAtMs,
        pause.endsAtMs,
        pause.remainingMs,
        pause.nextAvailableAtMs,
        pause.available,
        pause.reenableAtMs,
      ].join("|")
    : "";

export function WaiterPauseCard() {
  const { token, userId, username, fullName, deviceUuid, roomId, roomName } = useAuthStore();
  const realtimeTransport = useRealtimeTransportStatus();

  const payload = useMemo<WaiterPausePayload | null>(() => {
    if (!token || !userId || !deviceUuid) return null;
    return {
      token,
      userId,
      username,
      fullName,
      deviceUuid,
      roomId,
      roomName,
    };
  }, [deviceUuid, fullName, roomId, roomName, token, userId, username]);

  const cacheKey = useMemo(() => (payload ? pauseCacheKey(payload) : null), [payload]);
  const cachedPause = cacheKey ? waiterPauseStatusCache.get(cacheKey) ?? null : null;
  const [pause, setPause] = useState<WaiterPauseState | null>(() => cachedPause);
  const [remainingMs, setRemainingMs] = useState(() =>
    cachedPause ? nextTickRemaining(cachedPause, Date.now()) : 0,
  );
  const [busy, setBusy] = useState(false);
  const pauseSignatureRef = useRef(pauseStateSignature(cachedPause));
  const warningShownRef = useRef(false);

  const applyPause = useCallback(
    (nextPause: WaiterPauseState) => {
      if (cacheKey) waiterPauseStatusCache.set(cacheKey, nextPause);
      const nextSignature = pauseStateSignature(nextPause);
      if (pauseSignatureRef.current !== nextSignature) {
        pauseSignatureRef.current = nextSignature;
        setPause(nextPause);
      }
      setRemainingMs(nextTickRemaining(nextPause, Date.now()));
    },
    [cacheKey],
  );

  const refresh = async () => {
    if (!payload) return;
    try {
      const response = await fetchWaiterPauseStatus(payload);
      applyPause(response.pause);
    } catch {
      // The card keeps the last known state when the status endpoint is temporarily unreachable.
    }
  };

  useEffect(() => {
    if (!payload) {
      setPause(null);
      pauseSignatureRef.current = "";
      return undefined;
    }
    let active = true;
    if (cacheKey) {
      const cached = waiterPauseStatusCache.get(cacheKey);
      if (cached) applyPause(cached);
    }
    const run = async () => {
      try {
        const response = await fetchWaiterPauseStatus(payload);
        if (!active) return;
        applyPause(response.pause);
      } catch {
        // The safety refresh will retry the backend status.
      }
    };
    const handleServerEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: unknown }>).detail;
      const reason = String(detail?.reason ?? "").trim().toLowerCase();
      if (!reason.startsWith("waiter_pause")) return;
      void run();
    };
    void run();
    window.addEventListener("pos:server-payload", handleServerEvent);
    window.addEventListener("pos:server-refresh", handleServerEvent);
    const id = window.setInterval(
      run,
      realtimeTransport.connected
        ? WAITER_PAUSE_CONNECTED_REFRESH_MS
        : WAITER_PAUSE_DISCONNECTED_REFRESH_MS,
    );
    return () => {
      active = false;
      window.removeEventListener("pos:server-payload", handleServerEvent);
      window.removeEventListener("pos:server-refresh", handleServerEvent);
      window.clearInterval(id);
    };
  }, [applyPause, cacheKey, payload, realtimeTransport.connected]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setRemainingMs((current) => {
        const next = pause ? nextTickRemaining(pause, Date.now()) : current;
        if (pause?.active && next <= 60_000 && next > 0 && !warningShownRef.current) {
          warningShownRef.current = true;
          triggerHapticPulse([120, 80, 120]);
        }
        if (!pause?.active) warningShownRef.current = false;
        return next;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [pause]);

  if (!payload) return null;

  const togglePause = async () => {
    if (busy || !pause?.enabled) return;
    setBusy(true);
    try {
      const response = pause.active
        ? await stopWaiterPause(payload)
        : await startWaiterPause(payload);
      applyPause(response.pause);
      warningShownRef.current = false;
      window.setTimeout(() => void refresh(), 3500);
    } catch {
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const pauseEnabled = pause?.enabled === true;
  if (pause && !pauseEnabled) {
    return (
      <section className="waiter-pause-card is-disabled">
        <div className="waiter-pause-disabled-label">Pausa non abilitata</div>
      </section>
    );
  }

  const statusLabel = !pause
    ? "Pausa"
    : pause.active
      ? "Tempo pausa"
      : pause.available
        ? "Pausa disponibile"
        : "Prossima pausa";
  const timeLabel = !pause
    ? "--:--"
    : pause.active || !pause.available || pause.remainingMs > 0
      ? formatRemaining(remainingMs)
      : `${pause.durationMinutes} min`;
  const pauseActive = pause?.active === true;
  const buttonLabel = pauseActive ? "STOP" : "AVVIA";

  return (
    <section className={`waiter-pause-card ${pause?.active ? "is-paused" : ""}`}>
      <div className="waiter-pause-timer">
        <span>{statusLabel}</span>
        <strong>{timeLabel}</strong>
        <small>
          {pause
            ? `${pause.durationMinutes} min ogni ${formatRenewalInterval(pause.renewalMinutes)}`
            : "Caricamento stato"}
        </small>
      </div>
      <button
        type="button"
        className="waiter-pause-button"
        aria-label={busy ? "Pausa in aggiornamento" : buttonLabel}
        onClick={togglePause}
        disabled={busy || !pauseEnabled || Boolean(pause && !pause.active && !pause.available)}
      >
        <WaiterPauseActionIcon active={pauseActive} />
      </button>
    </section>
  );
}
