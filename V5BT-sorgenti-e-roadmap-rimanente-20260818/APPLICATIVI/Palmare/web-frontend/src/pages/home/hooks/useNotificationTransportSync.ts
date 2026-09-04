import { useEffect, useRef } from "react";
import {
  buildNotificationStreamUrl,
  extractNotificationsFromStreamDetail,
  fetchNotifications,
  type NotificationClientContext,
  type ServerNotification,
} from "../../../api/notifications";
import { publishRealtimeTransportStatus } from "../../../app/runtime/realtimeTransportStatus";
import { useSystemConnectionStatusActions } from "../../../app/runtime/SystemConnectionStatusContext";
import { isRuntimeFeatureEnabled } from "../../../config/runtimeConfig";
import {
  normalizeRealtimePayload,
  rememberRealtimeEventId,
  resolveRealtimeEventId,
  shouldApplyRealtimeEnvelope,
} from "../../../shared/realtime/realtimeEventEnvelope";
import {
  decideNotificationPullApplication,
  isNotificationTransportLifecycleCurrent,
} from "./notificationTransportPolicy";

const STREAM_RECONNECT_BASE_MS = 1_000;
const STREAM_RECONNECT_MAX_MS = 30_000;
const STREAM_READY_TIMEOUT_MS = 4_000;
const DISCONNECTED_FALLBACK_POLL_INITIAL_MS = 750;
const DISCONNECTED_FALLBACK_POLL_MAX_MS = 1_500;
const STREAM_RECONCILE_DELAY_MS = 900;

type NotificationTransportSyncParams = {
  enabled: boolean;
  notificationSessionKey: string;
  notificationClientContext: NotificationClientContext;
  onNotifications: (items: ServerNotification[], options?: { snapshot?: boolean }) => void;
};

export function useNotificationTransportSync({
  enabled,
  notificationSessionKey,
  notificationClientContext,
  onNotifications,
}: NotificationTransportSyncParams) {
  const onNotificationsRef = useRef(onNotifications);
  const recentPayloadKeysRef = useRef<string[]>([]);
  const recentEventIdsRef = useRef<number[]>([]);
  const lastEventIdRef = useRef(0);
  const aggregateVersionsRef = useRef<Map<string, number>>(new Map());
  const transportSessionKeyRef = useRef("");
  const transportLifecycleKey = `${enabled ? "enabled" : "disabled"}|${notificationSessionKey}`;
  if (transportSessionKeyRef.current !== transportLifecycleKey) {
    transportSessionKeyRef.current = transportLifecycleKey;
    recentPayloadKeysRef.current = [];
    recentEventIdsRef.current = [];
    lastEventIdRef.current = 0;
    aggregateVersionsRef.current.clear();
  }
  const pushFirstEnabled =
    isRuntimeFeatureEnabled("clientPushFirst") || isRuntimeFeatureEnabled("CLIENT_PUSH_FIRST");
  const { markTransportFailure, markTransportHealthy, probeBackendHealth } =
    useSystemConnectionStatusActions();

  useEffect(() => {
    onNotificationsRef.current = onNotifications;
  }, [onNotifications]);

  useEffect(() => {
    if (!enabled) return undefined;
    const EventSourceCtor = window.EventSource;
    if (typeof EventSourceCtor === "function") return undefined;
    publishRealtimeTransportStatus("unavailable", "notification-stream");

    let active = true;
    let nextPollSequence = 0;
    let lastAppliedPollSequence = 0;
    const effectLifecycleKey = transportLifecycleKey;
    const isCurrentLifecycle = () =>
      isNotificationTransportLifecycleCurrent(
        active,
        transportSessionKeyRef.current,
        effectLifecycleKey
      );
    const poll = async () => {
      if (!isCurrentLifecycle()) return;
      const requestSequence = ++nextPollSequence;
      try {
        const items = await fetchNotifications(notificationClientContext);
        const decision = decideNotificationPullApplication({
          lifecycleCurrent: isCurrentLifecycle(),
          requestSequence,
          lastAppliedSequence: lastAppliedPollSequence,
          streamRevisionAtStart: 0,
          currentStreamRevision: 0,
        });
        if (decision === "discard") return;
        lastAppliedPollSequence = requestSequence;
        onNotificationsRef.current(items, { snapshot: true });
      } catch {
        if (isCurrentLifecycle()) markTransportFailure();
      }
    };
    let pollTimer: number | null = null;
    let pollAttempt = 0;
    const pollAndSchedule = async () => {
      if (!isCurrentLifecycle()) return;
      await poll();
      if (!isCurrentLifecycle()) return;
      pollAttempt += 1;
      const nextDelay = Math.min(
        DISCONNECTED_FALLBACK_POLL_MAX_MS,
        DISCONNECTED_FALLBACK_POLL_INITIAL_MS * 2 ** Math.min(pollAttempt, 3)
      );
      pollTimer = window.setTimeout(() => {
        if (!isCurrentLifecycle()) return;
        pollTimer = null;
        void pollAndSchedule();
      }, nextDelay);
    };
    void pollAndSchedule();
    return () => {
      active = false;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [
    enabled,
    markTransportFailure,
    notificationClientContext,
    notificationSessionKey,
    transportLifecycleKey,
  ]);

  useEffect(() => {
    if (!enabled || typeof window.EventSource !== "function") return undefined;

    let active = true;
    let reconnectTimer: number | null = null;
    let reconcileTimer: number | null = null;
    let streamReadyTimer: number | null = null;
    let fallbackPollTimer: number | null = null;
    let fallbackPollAttempt = 0;
    let fallbackPollActive = false;
    let reconnectAttempt = 0;
    let source: EventSource | null = null;
    let nextPollSequence = 0;
    let lastAppliedPollSequence = 0;
    let streamRevision = 0;
    const effectLifecycleKey = transportLifecycleKey;
    const isCurrentLifecycle = () =>
      isNotificationTransportLifecycleCurrent(
        active,
        transportSessionKeyRef.current,
        effectLifecycleKey
      );

    const runPoll = async () => {
      if (!isCurrentLifecycle()) return;
      const requestSequence = ++nextPollSequence;
      const streamRevisionAtStart = streamRevision;
      try {
        const items = await fetchNotifications(notificationClientContext);
        const decision = decideNotificationPullApplication({
          lifecycleCurrent: isCurrentLifecycle(),
          requestSequence,
          lastAppliedSequence: lastAppliedPollSequence,
          streamRevisionAtStart,
          currentStreamRevision: streamRevision,
        });
        if (decision === "discard") return;
        lastAppliedPollSequence = requestSequence;
        onNotificationsRef.current(items, { snapshot: decision === "snapshot" });
      } catch {
        if (isCurrentLifecycle()) markTransportFailure();
      }
    };

    const cleanupSource = () => {
      if (!source) return;
      source.close();
      source = null;
    };

    const clearStreamReadyTimer = () => {
      if (streamReadyTimer === null) return;
      window.clearTimeout(streamReadyTimer);
      streamReadyTimer = null;
    };

    const stopFallbackPoll = () => {
      fallbackPollActive = false;
      if (fallbackPollTimer !== null) {
        window.clearTimeout(fallbackPollTimer);
        fallbackPollTimer = null;
      }
      fallbackPollAttempt = 0;
    };

    const scheduleFallbackPoll = (delayMs: number) => {
      if (!isCurrentLifecycle() || !fallbackPollActive || fallbackPollTimer !== null) return;
      fallbackPollTimer = window.setTimeout(
        async () => {
          fallbackPollTimer = null;
          if (!isCurrentLifecycle()) return;
          await runPoll();
          if (!isCurrentLifecycle() || !fallbackPollActive) return;
          fallbackPollAttempt += 1;
          const nextDelay = Math.min(
            DISCONNECTED_FALLBACK_POLL_MAX_MS,
            DISCONNECTED_FALLBACK_POLL_INITIAL_MS * 2 ** Math.min(fallbackPollAttempt, 3)
          );
          scheduleFallbackPoll(nextDelay);
        },
        Math.max(0, delayMs)
      );
    };

    const startFallbackPoll = () => {
      if (!isCurrentLifecycle() || fallbackPollActive) return;
      fallbackPollActive = true;
      fallbackPollAttempt = 0;
      scheduleFallbackPoll(0);
    };

    const markStreamHealthy = () => {
      if (!isCurrentLifecycle()) return;
      clearStreamReadyTimer();
      reconnectAttempt = 0;
      stopFallbackPoll();
      publishRealtimeTransportStatus("connected", "notification-stream");
      markTransportHealthy();
    };

    const markStreamDisconnected = () => {
      if (!isCurrentLifecycle()) return;
      clearStreamReadyTimer();
      publishRealtimeTransportStatus("disconnected", "notification-stream");
      markTransportFailure();
      probeBackendHealth();
      startFallbackPoll();
    };

    const scheduleReconcilePoll = (options: { force?: boolean } = {}) => {
      if (pushFirstEnabled && options.force !== true) return;
      if (!isCurrentLifecycle() || reconcileTimer !== null) return;
      reconcileTimer = window.setTimeout(() => {
        reconcileTimer = null;
        if (!isCurrentLifecycle()) return;
        void runPoll();
      }, STREAM_RECONCILE_DELAY_MS);
    };

    const rememberEventId = (event: MessageEvent, rawPayload: unknown) => {
      if (!isCurrentLifecycle()) return true;
      const eventId = resolveRealtimeEventId(event, rawPayload);
      if (eventId <= 0) return false;
      const remembered = rememberRealtimeEventId(recentEventIdsRef.current, eventId);
      recentEventIdsRef.current = remembered.next;
      lastEventIdRef.current = Math.max(lastEventIdRef.current, eventId);
      return remembered.duplicate;
    };

    const payloadKeyFrom = (detail: Record<string, unknown>) => {
      const reason = String(detail.reason ?? "refresh").trim() || "refresh";
      const atMs = Number(detail.atMs ?? 0) || 0;
      return `${reason}:${atMs}`;
    };

    const rememberPayloadKey = (detail: Record<string, unknown>) => {
      const key = payloadKeyFrom(detail);
      recentPayloadKeysRef.current = [
        key,
        ...recentPayloadKeysRef.current.filter((entry) => entry !== key),
      ].slice(0, 20);
      return key;
    };

    const hasRecentPayloadKey = (detail: Record<string, unknown>) =>
      recentPayloadKeysRef.current.includes(payloadKeyFrom(detail));

    const scheduleReconnect = () => {
      if (!isCurrentLifecycle() || reconnectTimer !== null) return;
      const delay = Math.min(
        STREAM_RECONNECT_MAX_MS,
        STREAM_RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempt, 5)
      );
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (!isCurrentLifecycle()) return;
        reconnectAttempt += 1;
        connect();
      }, delay);
    };

    const connect = () => {
      if (!isCurrentLifecycle()) return;
      cleanupSource();
      clearStreamReadyTimer();
      publishRealtimeTransportStatus("connecting", "notification-stream");

      // Keep the fast pull fallback active until the server emits the first
      // application frame (ready/payload/refresh). `EventSource.onopen` only
      // confirms that response headers arrived: Android WebView or an HTTPS
      // proxy can still buffer the first small SSE frame for several seconds.
      startFallbackPoll();
      try {
        source = new EventSource(
          buildNotificationStreamUrl(notificationClientContext, lastEventIdRef.current),
          {
            withCredentials: true,
          }
        );
      } catch {
        markStreamDisconnected();
        scheduleReconnect();
        return;
      }
      streamReadyTimer = window.setTimeout(() => {
        if (!isCurrentLifecycle() || source === null) return;
        markStreamDisconnected();
        cleanupSource();
        scheduleReconnect();
      }, STREAM_READY_TIMEOUT_MS);
      source.onopen = () => {
        if (!isCurrentLifecycle()) return;
        // Do not mark the stream healthy yet. The `ready` frame below is the
        // first proof that data is flowing end-to-end without buffering.
        publishRealtimeTransportStatus("connecting", "notification-stream");
      };
      source.addEventListener("ready", () => {
        if (!isCurrentLifecycle()) return;
        markStreamHealthy();
        scheduleReconcilePoll();
      });
      source.addEventListener("payload", (event) => {
        if (!isCurrentLifecycle()) return;
        streamRevision += 1;
        markStreamHealthy();
        try {
          const message = event as MessageEvent;
          const rawPayload = JSON.parse(String(message.data ?? "{}"));
          if (rememberEventId(message, rawPayload)) return;
          if (!shouldApplyRealtimeEnvelope(aggregateVersionsRef.current, rawPayload)) return;
          const detail = normalizeRealtimePayload(rawPayload);
          rememberPayloadKey(detail);
          const streamItems = extractNotificationsFromStreamDetail(
            detail,
            notificationClientContext
          );
          if (streamItems.length > 0) {
            onNotificationsRef.current(streamItems, { snapshot: false });
            scheduleReconcilePoll();
          }
          window.dispatchEvent(new CustomEvent("pos:server-payload", { detail }));
        } catch {
          // noop: il refresh legacy resta il fallback di compatibilita
        }
      });
      source.addEventListener("recovery", (event) => {
        if (!isCurrentLifecycle()) return;
        streamRevision += 1;
        markStreamHealthy();
        try {
          const detail = JSON.parse(String((event as MessageEvent).data ?? "{}")) as Record<
            string,
            unknown
          >;
          window.dispatchEvent(new CustomEvent("pos:server-recovery", { detail }));
        } catch {
          window.dispatchEvent(new CustomEvent("pos:server-recovery"));
        }
        void runPoll();
      });
      source.addEventListener("refresh", (event) => {
        if (!isCurrentLifecycle()) return;
        streamRevision += 1;
        markStreamHealthy();
        try {
          const message = event as MessageEvent;
          const rawPayload = JSON.parse(String(message.data ?? "{}"));
          if (rememberEventId(message, rawPayload)) return;
          const detail = normalizeRealtimePayload(rawPayload);
          const payloadAlreadyHandled = hasRecentPayloadKey(detail);
          const streamItems = extractNotificationsFromStreamDetail(
            detail,
            notificationClientContext
          );
          if (!payloadAlreadyHandled && streamItems.length > 0) {
            onNotificationsRef.current(streamItems, { snapshot: false });
          }
          window.dispatchEvent(new CustomEvent("pos:server-refresh", { detail }));
          if (payloadAlreadyHandled) {
            return;
          }
          if (pushFirstEnabled) return;
          if (streamItems.length > 0) {
            scheduleReconcilePoll();
            return;
          }
        } catch {
          window.dispatchEvent(new CustomEvent("pos:server-refresh"));
        }
        if (!pushFirstEnabled) void runPoll();
      });
      source.onmessage = () => {
        if (!isCurrentLifecycle()) return;
        streamRevision += 1;
        markStreamHealthy();
        if (!pushFirstEnabled) void runPoll();
      };
      source.onerror = () => {
        if (!isCurrentLifecycle()) return;
        markStreamDisconnected();
        cleanupSource();
        scheduleReconnect();
      };
    };

    connect();
    scheduleReconcilePoll();

    return () => {
      active = false;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      if (reconcileTimer !== null) {
        window.clearTimeout(reconcileTimer);
      }
      clearStreamReadyTimer();
      stopFallbackPoll();
      cleanupSource();
    };
  }, [
    enabled,
    markTransportFailure,
    markTransportHealthy,
    notificationClientContext,
    notificationSessionKey,
    probeBackendHealth,
    pushFirstEnabled,
    transportLifecycleKey,
  ]);
}
