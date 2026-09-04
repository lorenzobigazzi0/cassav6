import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationCenter } from "../src/pages/home/hooks/useNotificationCenter";
import { useAuthStore } from "../src/store/authStore";

const mocks = vi.hoisted(() => ({
  clockNow: 1_800_000_000_000,
  notification: {
    id: "ntf-persistent-ready",
    type: "bell" as const,
    title: "Comanda pronta",
    description: "Tavolo 1",
    createdAt: 1_799_999_995_000,
    meta: {
      orderId: "order-1",
      notificationPriority: "ritiro",
      targetUserId: "u_waiter",
      targetClientApp: "mobile-frontend",
    },
  },
  notificationSecond: {
    id: "ntf-persistent-ready-second",
    type: "bell" as const,
    title: "Comanda pronta",
    description: "Tavolo 2",
    createdAt: 1_799_999_996_000,
    meta: {
      orderId: "order-2",
      notificationPriority: "ritiro",
      targetUserId: "u_waiter",
      targetClientApp: "mobile-frontend",
    },
  },
  fetchNotifications: vi.fn(),
  acknowledgeNotification: vi.fn(async () => true),
  deleteNotification: vi.fn(async () => true),
}));
mocks.fetchNotifications.mockImplementation(async () => [mocks.notification]);

vi.mock("../src/api/notifications", () => ({
  acknowledgeNotification: mocks.acknowledgeNotification,
  buildNotificationStreamUrl: vi.fn(() => "/api/integration/notifications/stream"),
  deleteNotification: mocks.deleteNotification,
  extractNotificationsFromStreamDetail: vi.fn(() => []),
  fetchNotifications: mocks.fetchNotifications,
  mockSendNotification: vi.fn(async () => undefined),
}));

vi.mock("../src/api/reservations", () => ({
  fetchReservationsForDay: vi.fn(async () => ({ reservations: [] })),
}));

vi.mock("../src/pages/home/hooks/reservationReleaseWarnings", () => ({
  emitReservationReleaseWarnings: vi.fn(async () => undefined),
}));

describe("useNotificationCenter session lifecycle", () => {
  const flushHookWork = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(mocks.clockNow);
    mocks.fetchNotifications.mockReset();
    mocks.fetchNotifications.mockImplementation(async () => [mocks.notification]);
    mocks.acknowledgeNotification.mockClear();
    mocks.acknowledgeNotification.mockResolvedValue(true);
    mocks.deleteNotification.mockClear();
    mocks.deleteNotification.mockResolvedValue(true);
    useAuthStore.setState({
      token: "token-a",
      userId: "u_waiter",
      username: "waiter",
      fullName: "Waiter Test",
      sessionStartedAt: mocks.clockNow - 10_000,
      deviceUuid: "device-a",
      roomId: null,
      roomName: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("scarta la snapshot della sessione precedente dopo un nuovo login", async () => {
    const { result, unmount } = renderHook(() => useNotificationCenter());

    await flushHookWork();
    expect(result.current.bellCount).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(result.current.bellCount).toBe(1);

    act(() => {
      useAuthStore.setState({
        token: null,
        userId: null,
        username: null,
        fullName: null,
        sessionStartedAt: null,
      });
    });
    await flushHookWork();
    expect(result.current.bellCount).toBe(0);

    vi.setSystemTime(mocks.clockNow + 60_000);
    act(() => {
      useAuthStore.setState({
        token: "token-b",
        userId: "u_waiter",
        username: "waiter",
        fullName: "Waiter Test",
        sessionStartedAt: mocks.clockNow + 60_000,
        deviceUuid: "device-a",
      });
    });
    await flushHookWork();
    expect(result.current.bellCount).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    await flushHookWork();
    expect(result.current.bellCount).toBe(0);

    unmount();
  });

  it("scarta una notifica precedente al login corrente", async () => {
    mocks.fetchNotifications.mockResolvedValue([
      { ...mocks.notification, id: "ntf-stale", createdAt: mocks.clockNow - 10_001 },
    ]);
    const { result, unmount } = renderHook(() => useNotificationCenter());

    await flushHookWork();
    expect(result.current.bellCount).toBe(0);
    expect(result.current.activeCall).toBeNull();
    unmount();
  });

  it("accetta una notifica corrente una sola volta anche dopo il polling", async () => {
    const { result, unmount } = renderHook(() => useNotificationCenter());

    await flushHookWork();
    expect(result.current.bellCount).toBe(1);
    expect(result.current.callHistory).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    await flushHookWork();
    expect(result.current.bellCount).toBe(1);
    expect(result.current.callHistory).toHaveLength(1);
    unmount();
  });

  it("mantiene il fallback rapido finche lo stream SSE non consegna il frame ready", async () => {
    vi.stubEnv("VITE_CLIENT_PUSH_FIRST", "1");

    type EventHandler = (event: MessageEvent) => void;
    class MockEventSource {
      static instances: MockEventSource[] = [];

      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private readonly listeners = new Map<string, EventHandler[]>();

      constructor(
        readonly url: string,
        readonly options?: EventSourceInit
      ) {
        MockEventSource.instances.push(this);
      }

      addEventListener = vi.fn((name: string, listener: EventListener) => {
        const entries = this.listeners.get(name) ?? [];
        entries.push(listener as EventHandler);
        this.listeners.set(name, entries);
      });

      emit(name: string, data: Record<string, unknown> = {}) {
        const event = new MessageEvent(name, { data: JSON.stringify(data) });
        for (const listener of this.listeners.get(name) ?? []) listener(event);
      }

      close = vi.fn();
    }

    vi.stubGlobal("EventSource", MockEventSource);

    const { unmount } = renderHook(() => useNotificationCenter());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await flushHookWork();
    expect(mocks.fetchNotifications).toHaveBeenCalledTimes(1);

    const stream = MockEventSource.instances.at(-1);
    expect(stream).toBeDefined();
    act(() => stream?.onopen?.());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });
    await flushHookWork();
    expect(mocks.fetchNotifications).toHaveBeenCalledTimes(2);

    act(() => stream?.emit("ready", { ok: true }));
    mocks.fetchNotifications.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    await flushHookWork();
    expect(mocks.fetchNotifications).not.toHaveBeenCalled();

    unmount();
  });

  it("apre la modale della prima comanda pronta anche quando arrivano piu notifiche insieme", async () => {
    mocks.fetchNotifications.mockResolvedValueOnce([mocks.notification, mocks.notificationSecond]);

    const { result, unmount } = renderHook(() => useNotificationCenter());

    await flushHookWork();

    expect(result.current.bellCount).toBe(2);
    expect(result.current.activeCall?.id).toBe("ntf-persistent-ready");

    unmount();
  });

  it("cancella tutte le notifiche, comprese quelle non lette", async () => {
    mocks.fetchNotifications.mockResolvedValueOnce([
      {
        id: "ntf-general-1",
        type: "general",
        title: "Avviso uno",
        description: "Prima notifica",
        createdAt: mocks.clockNow - 4_000,
      },
      {
        id: "ntf-general-2",
        type: "general",
        title: "Avviso due",
        description: "Seconda notifica",
        createdAt: mocks.clockNow - 3_000,
      },
    ]);
    const { result, unmount } = renderHook(() => useNotificationCenter());

    await flushHookWork();
    expect(result.current.notifications).toHaveLength(2);

    act(() => result.current.clearAllNotifications());

    expect(result.current.notifications).toHaveLength(0);
    expect(mocks.deleteNotification).toHaveBeenCalledTimes(2);
    expect(mocks.deleteNotification).toHaveBeenCalledWith(
      "ntf-general-1",
      expect.objectContaining({ userId: "u_waiter", deviceUuid: "device-a" })
    );
    expect(mocks.deleteNotification).toHaveBeenCalledWith(
      "ntf-general-2",
      expect.objectContaining({ userId: "u_waiter", deviceUuid: "device-a" })
    );

    unmount();
  });

  it("rimuove subito la comanda pronta quando un altro palmare conferma il ritiro", async () => {
    const { result, unmount } = renderHook(() => useNotificationCenter());

    await flushHookWork();
    expect(result.current.bellCount).toBe(1);

    act(() => {
      window.dispatchEvent(
        new CustomEvent("pos:server-refresh", {
          detail: {
            reason: "notification_ack",
            detail: {
              id: "ntf-persistent-ready",
              type: "bell",
              orderId: "order-1",
            },
          },
        })
      );
    });

    expect(result.current.bellCount).toBe(0);
    expect(result.current.callHistory.some((item) => item.id === "ntf-persistent-ready")).toBe(
      false
    );

    unmount();
  });

  it("ripristina la comanda pronta se l'ack ottimistico viene rifiutato", async () => {
    vi.stubEnv("VITE_CLIENT_OPTIMISTIC_ACTIONS", "1");
    mocks.acknowledgeNotification.mockResolvedValueOnce(false);

    const { result, unmount } = renderHook(() => useNotificationCenter());

    await flushHookWork();
    expect(result.current.bellCount).toBe(1);
    expect(result.current.activeCall?.id).toBe("ntf-persistent-ready");

    act(() => {
      result.current.confirmActiveCall();
    });
    expect(result.current.bellCount).toBe(0);

    await flushHookWork();
    expect(result.current.bellCount).toBe(1);
    expect(result.current.activeCall?.id).toBe("ntf-persistent-ready");

    unmount();
  });

  it("riconcilia le comande pronte se il polling non le trova piu sul backend", async () => {
    mocks.fetchNotifications.mockResolvedValueOnce([mocks.notification]).mockResolvedValueOnce([]);

    const { result, unmount } = renderHook(() => useNotificationCenter());

    await flushHookWork();
    expect(result.current.bellCount).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100);
    });

    expect(result.current.bellCount).toBe(0);

    unmount();
  });

  it("ignora una risposta della sessione precedente dopo logout e login rapido", async () => {
    let resolvePoll: ((items: (typeof mocks.notification)[]) => void) | null = null;
    mocks.fetchNotifications.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePoll = resolve;
        })
    );
    const { result, unmount } = renderHook(() => useNotificationCenter());
    await flushHookWork();

    act(() => useAuthStore.getState().logout());
    expect(result.current.bellCount).toBe(0);

    vi.setSystemTime(mocks.clockNow + 60_000);
    act(() => {
      useAuthStore.setState({
        token: "token-b",
        userId: "u_waiter",
        username: "waiter",
        fullName: "Waiter Test",
        sessionStartedAt: mocks.clockNow + 60_000,
        deviceUuid: "device-a",
      });
    });

    await act(async () => {
      resolvePoll?.([mocks.notification]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.bellCount).toBe(0);
    expect(result.current.activeCall).toBeNull();
    unmount();
  });

  it("ignora una risposta in volo dopo il rollover epoca con la stessa identita", async () => {
    let resolveOldPoll: ((items: (typeof mocks.notification)[]) => void) | null = null;
    mocks.fetchNotifications.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldPoll = resolve;
        })
    );
    const { result, unmount } = renderHook(() => useNotificationCenter());
    await flushHookWork();

    act(() => {
      useAuthStore.setState({ sessionStartedAt: mocks.clockNow + 1 });
    });
    await flushHookWork();
    await act(async () => {
      resolveOldPoll?.([mocks.notification]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.bellCount).toBe(0);
    expect(result.current.activeCall).toBeNull();
    unmount();
  });

  it("non ripristina una comanda da un rollback ack arrivato dopo il logout", async () => {
    vi.stubEnv("VITE_CLIENT_OPTIMISTIC_ACTIONS", "1");
    let resolveAck: ((accepted: boolean) => void) | null = null;
    mocks.acknowledgeNotification.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAck = resolve;
        })
    );
    const { result, unmount } = renderHook(() => useNotificationCenter());
    await flushHookWork();
    expect(result.current.bellCount).toBe(1);

    act(() => result.current.confirmActiveCall());
    expect(result.current.bellCount).toBe(0);
    act(() => useAuthStore.getState().logout());

    await act(async () => {
      resolveAck?.(false);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.bellCount).toBe(0);
    expect(result.current.activeCall).toBeNull();
    unmount();
  });
});
