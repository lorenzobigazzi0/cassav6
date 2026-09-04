import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  acknowledgeNotification,
  deleteNotification,
  fetchNotifications,
  mockSendNotification,
  type NotificationClientContext,
  type NotificationType,
  type ServerNotification,
} from "../../../api/notifications";
import { fetchReservationsForDay } from "../../../api/reservations";
import {
  readLocalPreference,
  writeLocalPreference,
} from "../../../shared/storage/preferenceStorage";
import {
  isClientOptimisticActionsEnabled,
  runBackgroundOptimisticRequest,
} from "../../../shared/optimistic/clientOptimisticActions";
import { useAuthStore } from "../../../store/authStore";
import { getOrCreateDeviceUuid } from "../../../utils/device";
import {
  getReservationReminderPreferences,
  subscribeReservationReminderPreferences,
} from "../../../utils/reservationReminderPreferences";
import { toCallNotification } from "./callNotificationDisplay";
import { notificationDedupKey, rememberNotificationKey } from "./notificationDedup";
import {
  isNotificationFreshForSession,
  normalizeNotificationSessionStartedAt,
} from "./notificationSessionPolicy";
import { emitReservationReleaseWarnings } from "./reservationReleaseWarnings";
import { useNotificationTransportSync } from "./useNotificationTransportSync";
import { subscribeMobileSessionEnding } from "../../../app/session/sessionLifecycle";
import { useNotificationAudio } from "./useNotificationAudio";
import type { CallNotification, UiNotification } from "../types";

const AUTO_SHOW_WAITER_KEY = "settings_auto_show_waiter";
const AUTO_SHOW_BELL_KEY = "settings_auto_show_bell";

const toDateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const toClock = (timestamp: number) => {
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
};

const getTableLabel = (tableId: string | null) => {
  if (!tableId) return "";
  const match = tableId.match(/_t(\d+)$/i);
  if (!match) return "";
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return "";
  return `Tavolo ${number}`;
};

const isHandheldRingNotification = (item: ServerNotification) => {
  const meta = item.meta && typeof item.meta === "object" ? item.meta : {};
  return String(meta.eventType ?? "").trim() === "handheld_ring";
};

const textValue = (value: unknown) => String(value ?? "").trim();

const extractServerRefreshDetail = (value: unknown) => {
  const payload = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const detail =
    payload.detail && typeof payload.detail === "object"
      ? (payload.detail as Record<string, unknown>)
      : {};
  return {
    reason: textValue(payload.reason).toLowerCase(),
    id: textValue(detail.id),
    type: textValue(detail.type).toLowerCase(),
    eventType: textValue(detail.eventType).toLowerCase(),
    orderId: textValue(detail.orderId),
    sourceNotificationId: textValue(detail.sourceNotificationId),
  };
};

const isBellCallInvalidatedByRefresh = (
  item: CallNotification,
  refresh: ReturnType<typeof extractServerRefreshDetail>
) => {
  if (item.type !== "bell") return false;
  if (refresh.type && refresh.type !== "bell") return false;
  if (!["notification_ack", "notification_deleted"].includes(refresh.reason)) return false;
  if (refresh.id && item.id === refresh.id) return true;
  if (refresh.sourceNotificationId && item.id === refresh.sourceNotificationId) return true;
  if (refresh.orderId && item.orderId === refresh.orderId) return true;
  if (refresh.sourceNotificationId && item.sourceNotificationId === refresh.sourceNotificationId) {
    return true;
  }
  return false;
};

const bellSnapshotMatchesCall = (item: CallNotification, snapshot: ServerNotification[]) => {
  if (item.type !== "bell") return true;
  return snapshot.some((notification) => {
    if (notification.type !== "bell") return false;
    const meta =
      notification.meta && typeof notification.meta === "object" ? notification.meta : {};
    const orderId = textValue(meta.orderId);
    const sourceNotificationId = textValue(meta.sourceNotificationId);
    if (notification.id === item.id) return true;
    if (sourceNotificationId && sourceNotificationId === item.id) return true;
    if (item.sourceNotificationId && sourceNotificationId === item.sourceNotificationId)
      return true;
    if (item.orderId && orderId === item.orderId) return true;
    return false;
  });
};

export function useNotificationCenter() {
  const token = useAuthStore((state) => state.token);
  const userId = useAuthStore((state) => state.userId);
  const username = useAuthStore((state) => state.username);
  const fullName = useAuthStore((state) => state.fullName);
  const sessionStartedAt = useAuthStore((state) => state.sessionStartedAt);
  const deviceUuid = useAuthStore((state) => state.deviceUuid);
  const roomId = useAuthStore((state) => state.roomId);
  const roomName = useAuthStore((state) => state.roomName);

  const [callQueue, setCallQueue] = useState<CallNotification[]>([]);
  const [callHistory, setCallHistory] = useState<CallNotification[]>([]);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<UiNotification[]>([]);
  const [autoShowWaiter, setAutoShowWaiter] = useState<boolean>(() => {
    const saved = readLocalPreference(AUTO_SHOW_WAITER_KEY);
    return saved === null ? true : saved === "1";
  });
  const [autoShowBell, setAutoShowBell] = useState<boolean>(() => {
    const saved = readLocalPreference(AUTO_SHOW_BELL_KEY);
    return saved === null ? true : saved === "1";
  });
  const [reservationReminderPrefs, setReservationReminderPrefs] = useState(() =>
    getReservationReminderPreferences()
  );
  const optimisticActionsEnabled = useMemo(() => isClientOptimisticActionsEnabled(), []);

  const sessionActiveRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const notificationSessionKeyRef = useRef("");
  const callQueueRef = useRef<CallNotification[]>([]);
  const activeCallIdRef = useRef<string | null>(null);
  const autoShowWaiterRef = useRef<boolean>(autoShowWaiter);
  const autoShowBellRef = useRef<boolean>(autoShowBell);
  const reservationReminderPrefsRef = useRef(reservationReminderPrefs);
  const reminderSentRef = useRef<Set<string>>(new Set());
  const seenNotificationKeysRef = useRef<Set<string>>(new Set());

  const effectiveDeviceUuid = useMemo(
    () => (deviceUuid && deviceUuid.trim() ? deviceUuid : getOrCreateDeviceUuid()),
    [deviceUuid]
  );
  const effectiveUserId = useMemo(() => {
    if (userId && userId.trim()) return userId;
    if (username && username.trim()) {
      return `u_${username
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")}`;
    }
    return "";
  }, [userId, username]);
  const effectiveRoomId = roomId || "";
  const notificationClientContext = useMemo<NotificationClientContext>(
    () => ({
      userId: effectiveUserId,
      username: username ?? "",
      fullName: fullName ?? "",
      deviceUuid: effectiveDeviceUuid,
      roomId: effectiveRoomId,
      roomName: roomName ?? "",
    }),
    [effectiveDeviceUuid, effectiveRoomId, effectiveUserId, fullName, roomName, username]
  );
  const notificationSessionKey = useMemo(
    () =>
      [effectiveUserId, username ?? "", effectiveDeviceUuid, sessionStartedAt ?? "logged-out"].join(
        "|"
      ),
    [effectiveDeviceUuid, effectiveUserId, sessionStartedAt, username]
  );
  const normalizedSessionStartedAt = normalizeNotificationSessionStartedAt(sessionStartedAt);
  const hasActiveSession = Boolean(
    token && effectiveUserId && effectiveDeviceUuid && normalizedSessionStartedAt
  );
  if (notificationSessionKeyRef.current !== notificationSessionKey) {
    notificationSessionKeyRef.current = notificationSessionKey;
    sessionGenerationRef.current += 1;
  }
  const activeSessionGeneration = sessionGenerationRef.current;
  const isCurrentNotificationSession = () =>
    sessionActiveRef.current && sessionGenerationRef.current === activeSessionGeneration;
  sessionActiveRef.current = hasActiveSession;
  const waiterCount = useMemo(
    () => callQueue.filter((item) => item.type === "waiter").length,
    [callQueue]
  );
  const bellCount = useMemo(
    () => callQueue.filter((item) => item.type === "bell").length,
    [callQueue]
  );
  const { playWaiterTone, playBellTone, playGeneralTone, playHandheldRingTone } =
    useNotificationAudio({ enabled: hasActiveSession, waiterCount, bellCount });

  useEffect(() => {
    activeCallIdRef.current = activeCallId;
  }, [activeCallId]);

  useEffect(() => {
    callQueueRef.current = callQueue;
  }, [callQueue]);

  useEffect(() => {
    const handleServerRefresh = (event: Event) => {
      if (!sessionActiveRef.current) return;
      const refresh = extractServerRefreshDetail((event as CustomEvent).detail);
      if (!["notification_ack", "notification_deleted"].includes(refresh.reason)) return;
      if (refresh.type && refresh.type !== "bell") return;
      if (!refresh.id && !refresh.orderId && !refresh.sourceNotificationId) return;

      setCallQueue((items) =>
        items.filter((item) => !isBellCallInvalidatedByRefresh(item, refresh))
      );
      setCallHistory((items) =>
        items.filter((item) => !isBellCallInvalidatedByRefresh(item, refresh))
      );
      setActiveCallId((current) => {
        if (!current) return current;
        const currentCall = callQueueRef.current.find((item) => item.id === current);
        if (!currentCall) return current;
        return isBellCallInvalidatedByRefresh(currentCall, refresh) ? null : current;
      });
    };

    window.addEventListener("pos:server-refresh", handleServerRefresh);
    return () => {
      window.removeEventListener("pos:server-refresh", handleServerRefresh);
    };
  }, []);

  useEffect(() => {
    autoShowWaiterRef.current = autoShowWaiter;
    writeLocalPreference(AUTO_SHOW_WAITER_KEY, autoShowWaiter ? "1" : "0");
  }, [autoShowWaiter]);

  useEffect(() => {
    autoShowBellRef.current = autoShowBell;
    writeLocalPreference(AUTO_SHOW_BELL_KEY, autoShowBell ? "1" : "0");
  }, [autoShowBell]);

  useEffect(() => {
    reservationReminderPrefsRef.current = reservationReminderPrefs;
  }, [reservationReminderPrefs]);

  useEffect(() => {
    return subscribeReservationReminderPreferences(() => {
      setReservationReminderPrefs(getReservationReminderPreferences());
    });
  }, []);

  const stopNotificationRuntime = useCallback((clearUi: boolean) => {
    sessionActiveRef.current = false;
    sessionGenerationRef.current += 1;
    seenNotificationKeysRef.current.clear();
    reminderSentRef.current.clear();
    callQueueRef.current = [];
    activeCallIdRef.current = null;
    if (!clearUi) return;
    setCallQueue([]);
    setCallHistory([]);
    setActiveCallId(null);
    setNotifications([]);
  }, []);

  useEffect(() => {
    sessionActiveRef.current = hasActiveSession;
    seenNotificationKeysRef.current.clear();
    setCallQueue([]);
    setCallHistory([]);
    setActiveCallId(null);
    setNotifications([]);
  }, [hasActiveSession, notificationSessionKey]);

  useEffect(() => {
    const unsubscribe = subscribeMobileSessionEnding(() => stopNotificationRuntime(true));
    return () => {
      unsubscribe();
      stopNotificationRuntime(false);
    };
  }, [stopNotificationRuntime]);

  const reconcileBellCallsWithSnapshot = (items: ServerNotification[]) => {
    if (!isCurrentNotificationSession()) return;
    setCallQueue((current) => current.filter((item) => bellSnapshotMatchesCall(item, items)));
    setCallHistory((current) => current.filter((item) => bellSnapshotMatchesCall(item, items)));
    setActiveCallId((current) => {
      if (!current) return current;
      const currentCall = callQueueRef.current.find((item) => item.id === current);
      if (!currentCall || currentCall.type !== "bell") return current;
      return bellSnapshotMatchesCall(currentCall, items) ? current : null;
    });
  };

  const applyServerNotifications = (
    items: ServerNotification[],
    options: { snapshot?: boolean } = {}
  ) => {
    if (!isCurrentNotificationSession()) return;
    const freshItems = items.filter((item) =>
      isNotificationFreshForSession(item, normalizedSessionStartedAt)
    );
    if (options.snapshot) {
      reconcileBellCallsWithSnapshot(freshItems);
    }
    if (freshItems.length === 0) return;
    const dedupedItems = freshItems.filter((item) =>
      rememberNotificationKey(seenNotificationKeysRef.current, notificationDedupKey(item))
    );
    if (dedupedItems.length === 0) return;

    const waiterBatch = dedupedItems.filter((item) => item.type === "waiter");
    const bellBatch = dedupedItems.filter((item) => item.type === "bell");
    const generalBatch = dedupedItems.filter((item) => item.type === "general");
    const handheldRingBatch = generalBatch.filter(isHandheldRingNotification);
    const standardGeneralBatch = generalBatch.filter((item) => !isHandheldRingNotification(item));

    const callBatch = [...waiterBatch, ...bellBatch]
      .map(toCallNotification)
      .sort((a, b) => a.createdAt - b.createdAt);

    if (callBatch.length) {
      const autoOpenId =
        !activeCallIdRef.current && callQueueRef.current.length === 0
          ? (callBatch.find((item) =>
              item.type === "waiter" ? autoShowWaiterRef.current : autoShowBellRef.current
            )?.id ?? null)
          : null;
      setCallQueue((prev) => {
        const next = [...prev, ...callBatch].sort((a, b) => a.createdAt - b.createdAt);
        return next;
      });
      setCallHistory((prev) => {
        const next = [...callBatch, ...prev];
        next.sort((a, b) => b.createdAt - a.createdAt);
        return next;
      });
      if (autoOpenId) {
        activeCallIdRef.current = autoOpenId;
        setActiveCallId(autoOpenId);
      }
    }

    if (waiterBatch.length) playWaiterTone();
    if (bellBatch.length) playBellTone();
    if (handheldRingBatch.length) playHandheldRingTone();
    if (standardGeneralBatch.length) playGeneralTone();

    if (generalBatch.length) {
      setNotifications((itemsState) => {
        const next = [...itemsState];
        generalBatch
          .slice()
          .reverse()
          .forEach((item) => {
            next.unshift({
              id: item.id,
              type: item.type,
              title: item.title,
              description: item.description.slice(0, 140),
              createdAt: item.createdAt,
              read: false,
            });
          });
        return next;
      });
    }
  };

  const emitGeneralNotification = async (title: string, description: string) => {
    if (!isCurrentNotificationSession()) return;
    await mockSendNotification("general", {
      title: title.slice(0, 80),
      description: description.slice(0, 140),
      count: 1,
    });
    if (!isCurrentNotificationSession()) return;
    const items = await fetchNotifications(notificationClientContext);
    if (!isCurrentNotificationSession()) return;
    applyServerNotifications(items);
  };

  useEffect(() => {
    let active = true;
    const runReminderCheck = async () => {
      const prefs = reservationReminderPrefsRef.current;
      if (!prefs.enabled) return;
      if (!token || !effectiveUserId || !effectiveDeviceUuid || !effectiveRoomId) return;

      const now = Date.now();
      const serviceDate = toDateKey(new Date(now));
      reminderSentRef.current.forEach((key) => {
        if (!key.startsWith(`${serviceDate}|`)) {
          reminderSentRef.current.delete(key);
        }
      });

      try {
        const snapshot = await fetchReservationsForDay({
          token,
          userId: effectiveUserId,
          deviceUuid: effectiveDeviceUuid,
          roomId: effectiveRoomId,
          serviceDate,
        });
        if (!active) return;
        await emitReservationReleaseWarnings({
          token,
          effectiveUserId,
          effectiveDeviceUuid,
          effectiveRoomId,
          serviceDate,
          reminderSent: reminderSentRef.current,
          emitGeneralNotification,
        });

        const leads = Array.from(
          new Set(
            [prefs.firstLeadMinutes, prefs.secondLeadMinutes]
              .map((value) => Math.max(1, Math.round(value)))
              .sort((a, b) => b - a)
          )
        );

        snapshot.reservations.forEach((reservation) => {
          const minutesBefore = (reservation.reservationAt - now) / 60000;
          leads.forEach((lead) => {
            const reminderKey = `${serviceDate}|${reservation.id}|${lead}`;
            if (reminderSentRef.current.has(reminderKey)) return;
            if (minutesBefore > lead || minutesBefore <= lead - 1.2) return;

            reminderSentRef.current.add(reminderKey);
            const tableLabel = getTableLabel(reservation.assignedTableId);
            const prefix = tableLabel ? `${tableLabel} - ` : "";
            void emitGeneralNotification(
              "Prenotazione a breve",
              `${prefix}${reservation.customerName} alle ${toClock(reservation.reservationAt)}`
            );
          });
        });
      } catch {
        // keep silent on reminder fetch errors
      }
    };

    void runReminderCheck();
    const reminderTimer = window.setInterval(() => {
      void runReminderCheck();
    }, 30_000);

    return () => {
      active = false;
      window.clearInterval(reminderTimer);
    };
  }, [effectiveDeviceUuid, effectiveRoomId, effectiveUserId, notificationSessionKey, token]);

  useNotificationTransportSync({
    enabled: hasActiveSession,
    notificationSessionKey,
    notificationClientContext,
    onNotifications: applyServerNotifications,
  });

  const unreadCount = useMemo(() => notifications.filter((n) => !n.read).length, [notifications]);
  const readCount = useMemo(() => notifications.filter((n) => n.read).length, [notifications]);

  const dispatchMockNotification = (
    type: NotificationType,
    details: { title?: string; description?: string } = {}
  ) => {
    if (!isCurrentNotificationSession()) return;
    void (async () => {
      await mockSendNotification(type, { ...details, count: 1 });
      if (!isCurrentNotificationSession()) return;
      const items = await fetchNotifications(notificationClientContext);
      if (!isCurrentNotificationSession()) return;
      applyServerNotifications(items);
    })();
  };

  const activeCall = useMemo(
    () => callQueue.find((item) => item.id === activeCallId) ?? null,
    [callQueue, activeCallId]
  );

  const runNotificationAck = (request: () => Promise<boolean>, rollback: () => void) => {
    if (!optimisticActionsEnabled) {
      void request();
      return;
    }
    const rollbackIfSessionActive = () => {
      if (isCurrentNotificationSession()) rollback();
    };
    runBackgroundOptimisticRequest(request, {
      onSuccess: (accepted) => {
        if (accepted === false) rollbackIfSessionActive();
      },
      onError: rollbackIfSessionActive,
    });
  };

  const openOldestCall = (type: "waiter" | "bell") => {
    const oldest = callQueue
      .filter((item) => item.type === type)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) return;
    setActiveCallId(oldest.id);
  };

  const closeActiveCall = () => {
    setActiveCallId(null);
  };

  const confirmActiveCall = () => {
    if (!activeCall) return;
    const confirmedCall = activeCall;
    const id = confirmedCall.id;
    runNotificationAck(
      () => acknowledgeNotification(id, notificationClientContext),
      () => {
        setCallQueue((items) => {
          if (items.some((item) => item.id === confirmedCall.id)) return items;
          return [...items, confirmedCall].sort((a, b) => a.createdAt - b.createdAt);
        });
        setCallHistory((items) =>
          items.map((item) =>
            item.id === confirmedCall.id
              ? { ...item, confirmed: false, confirmedAt: undefined }
              : item
          )
        );
        setActiveCallId((current) => current ?? confirmedCall.id);
      }
    );
    setCallQueue((items) => items.filter((item) => item.id !== id));
    setCallHistory((items) =>
      items.map((item) =>
        item.id === id ? { ...item, confirmed: true, confirmedAt: Date.now() } : item
      )
    );
    setActiveCallId(null);
  };

  const deleteCallHistoryById = (id: string) => {
    void deleteNotification(id, notificationClientContext);
    setCallHistory((items) => items.filter((item) => item.id !== id));
    setCallQueue((items) => items.filter((item) => item.id !== id));
    setActiveCallId((current) => (current === id ? null : current));
  };

  const clearCallHistory = () => {
    setCallHistory((items) => {
      items.forEach((item) => void deleteNotification(item.id, notificationClientContext));
      return [];
    });
    setCallQueue((items) => {
      items.forEach((item) => void deleteNotification(item.id, notificationClientContext));
      return [];
    });
    setActiveCallId(null);
  };

  const confirmNotification = (id: string) => {
    runNotificationAck(
      () => acknowledgeNotification(id, notificationClientContext),
      () => {
        setNotifications((items) =>
          items.map((item) => (item.id === id ? { ...item, read: false } : item))
        );
      }
    );
    setNotifications((items) => items.map((x) => (x.id === id ? { ...x, read: true } : x)));
  };

  const deleteNotificationById = (id: string) => {
    void deleteNotification(id, notificationClientContext);
    setNotifications((items) => items.filter((n) => n.id !== id));
  };

  const clearReadNotifications = () => {
    const readIds = notifications.filter((item) => item.read).map((item) => item.id);
    const readIdSet = new Set(readIds);
    setNotifications((items) => items.filter((item) => !readIdSet.has(item.id)));
    readIds.forEach((id) => void deleteNotification(id, notificationClientContext));
  };

  const clearAllNotifications = () => {
    const notificationIds = notifications.map((item) => item.id);
    const notificationIdSet = new Set(notificationIds);
    setNotifications((items) => items.filter((item) => !notificationIdSet.has(item.id)));
    notificationIds.forEach((id) => void deleteNotification(id, notificationClientContext));
  };

  return {
    waiterCount,
    bellCount,
    pendingCallCount: callQueue.length,
    activeCall,
    callHistory,
    autoShowWaiter,
    autoShowBell,
    setAutoShowWaiter,
    setAutoShowBell,
    notifications,
    unreadCount,
    readCount,
    dispatchMockNotification,
    openOldestCall,
    closeActiveCall,
    confirmActiveCall,
    deleteCallHistoryById,
    clearCallHistory,
    confirmNotification,
    deleteNotificationById,
    clearReadNotifications,
    clearAllNotifications,
  };
}
