import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAvailableRooms, requestRoomChange, type Room } from "../../../api/locations";
import { fetchTablesForSession, tablesQueryKey, type TablesSnapshot } from "../../../api/tables";
import { GlassCard } from "../../../components/GlassCard";
import { formatCurrency } from "../../../shared/format/currency";
import {
  createRealtimeRefreshCoordinator,
  MOBILE_REALTIME_REFRESH_COOLDOWN_MS,
  realtimeRefreshKey,
} from "../../../shared/realtime/realtimeRefreshCoordinator";
import { useAuthStore } from "../../../store/authStore";
import { isVirtualWaitingRoom } from "../../../utils/rooms";
import { useRealtimeTransportStatus } from "../../../app/runtime/realtimeTransportStatus";
import { WaiterPauseCard } from "./WaiterPauseCard";
import {
  applyRealtimeTablesPayloadToSnapshot,
  shouldRefreshTablesForServerEvent,
} from "../tables/workspaceRuntime";

type DashboardTableFilter = "free" | "occupied" | "ordering" | "payment_due";

interface HomeCardProps {
  username: string;
  onSimulateWaiter: () => void;
  onSimulateBell: () => void;
  onSimulateGeneral: () => void;
  onOpenTablesFilter: (filter: DashboardTableFilter) => void;
}

const HOME_DASHBOARD_REFRESH_MS = 30_000;

// Le etichette delle tessere che contengono una barra vanno su due righe: la
// barra resta a fine prima riga. Senza barra l'etichetta resta su una riga.
const dashboardEyebrowLines = (label: string) =>
  label
    .split("/")
    .map((part, index, parts) => (index < parts.length - 1 ? `${part}/` : part))
    .map((line, index) => (
      <span className="mobile-dashboard-widget-eyebrow-line" key={`${line}-${index}`}>
        {line}
      </span>
    ));
const HOME_DASHBOARD_SAFETY_REFRESH_MS = 90_000;

const effectiveUserIdFrom = (userId: string | null, username: string | null) => {
  if (userId && userId.trim()) return userId.trim();
  if (username && username.trim()) {
    return `u_${username
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")}`;
  }
  return "u_operatore";
};

export function HomeCard({
  username,
  onSimulateWaiter,
  onSimulateBell,
  onSimulateGeneral,
  onOpenTablesFilter,
}: HomeCardProps) {
  const queryClient = useQueryClient();
  const {
    token,
    userId,
    username: authUsername,
    deviceUuid,
    role,
    roomId,
    roomName,
    activityId,
    permissions,
    setRoom,
  } = useAuthStore();
  const effectiveRoomId = roomId || "";
  const effectiveUserId = effectiveUserIdFrom(userId, authUsername);
  const effectiveRole = role || "operator";
  const canLoadDashboard = Boolean(token && effectiveUserId && deviceUuid && effectiveRoomId);
  const canLoadRooms = Boolean(token && effectiveUserId && deviceUuid);
  const canCollectPayments = permissions.includes("collect_payments");
  const [roomModalOpen, setRoomModalOpen] = useState(false);
  const [roomModalBusy, setRoomModalBusy] = useState(false);
  const [roomModalError, setRoomModalError] = useState<string | null>(null);
  const realtimeWasDisconnectedRef = useRef(true);
  const realtimeTransport = useRealtimeTransportStatus();
  const showSimulationPanel = import.meta.env.DEV;
  const dashboardQueryKey = useMemo(
    () => ["home-dashboard", effectiveRoomId, effectiveUserId, deviceUuid] as const,
    [deviceUuid, effectiveRoomId, effectiveUserId]
  );

  const dashboardQuery = useQuery({
    queryKey: dashboardQueryKey,
    enabled: canLoadDashboard,
    staleTime: 15_000,
    refetchInterval: realtimeTransport.connected ? false : HOME_DASHBOARD_SAFETY_REFRESH_MS,
    refetchIntervalInBackground: false,
    queryFn: () =>
      fetchTablesForSession({
        token: token || "",
        userId: effectiveUserId,
        deviceUuid: deviceUuid || "",
        roomId: effectiveRoomId,
      }),
  });
  const refetchDashboard = dashboardQuery.refetch;

  const dashboardMetrics = useMemo(() => {
    const tables = dashboardQuery.data?.tables ?? [];
    let freeCount = 0;
    let occupiedCount = 0;
    let orderingCount = 0;
    let paymentDueCount = 0;
    let paymentDueAmount = 0;
    tables.forEach((table) => {
      if (table.amountDue > 0) {
        paymentDueCount += 1;
        paymentDueAmount += table.amountDue;
        return;
      }
      if (table.ordersInProgress > 0) {
        orderingCount += 1;
        return;
      }
      if (table.occupancyState === "free") {
        freeCount += 1;
        return;
      }
      occupiedCount += 1;
    });
    return {
      roomName: roomName || "Sala",
      totalTables: tables.length,
      freeCount,
      occupiedCount,
      paymentDueCount,
      paymentDueAmount,
      orderingCount,
    };
  }, [dashboardQuery.data?.tables, roomName]);

  useEffect(() => {
    if (!canLoadDashboard) return undefined;
    const applyPayloadToDashboardCache = (detail: unknown) => {
      let applied = false;
      queryClient.setQueryData<TablesSnapshot>(dashboardQueryKey, (current) => {
        const next = applyRealtimeTablesPayloadToSnapshot(current, detail, effectiveRoomId);
        applied = next !== current;
        return next;
      });
      return applied;
    };
    const coordinator = createRealtimeRefreshCoordinator<{
      detail: unknown;
      source: "payload" | "refresh" | "reconnect";
    }>({
      minimumRunIntervalMs: MOBILE_REALTIME_REFRESH_COOLDOWN_MS,
      run: async (update, { signal, supersededCount }) => {
        if (signal.aborted) return;
        const payloadApplied =
          update.source === "payload" && applyPayloadToDashboardCache(update.detail);
        if (payloadApplied && supersededCount === 0) return;
        await refetchDashboard();
      },
    });
    if (!realtimeTransport.connected) {
      realtimeWasDisconnectedRef.current = true;
    } else if (realtimeWasDisconnectedRef.current) {
      realtimeWasDisconnectedRef.current = false;
      coordinator.enqueue("transport:reconnected", {
        detail: { reason: "transport_reconnected" },
        source: "reconnect",
      });
    }
    const handleServerPayload = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: unknown; atMs?: unknown }>).detail;
      if (!shouldRefreshTablesForServerEvent(detail?.reason)) return;
      coordinator.enqueue(realtimeRefreshKey(detail), { detail, source: "payload" });
    };
    const handleServerRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: unknown; atMs?: unknown }>).detail;
      if (!shouldRefreshTablesForServerEvent(detail?.reason)) return;
      coordinator.enqueue(realtimeRefreshKey(detail), { detail, source: "refresh" });
    };
    window.addEventListener("pos:server-payload", handleServerPayload);
    window.addEventListener("pos:server-refresh", handleServerRefresh);
    return () => {
      window.removeEventListener("pos:server-payload", handleServerPayload);
      window.removeEventListener("pos:server-refresh", handleServerRefresh);
      coordinator.dispose();
    };
  }, [
    canLoadDashboard,
    dashboardQueryKey,
    effectiveRoomId,
    queryClient,
    realtimeTransport.connected,
    refetchDashboard,
  ]);

  const roomsQuery = useQuery({
    queryKey: [
      "available-rooms",
      effectiveUserId,
      effectiveRole,
      deviceUuid,
      effectiveRoomId,
      activityId,
    ],
    enabled: roomModalOpen && canLoadRooms,
    queryFn: () =>
      fetchAvailableRooms({
        token: token || "",
        userId: effectiveUserId,
        role: effectiveRole,
        deviceUuid: deviceUuid || "",
        currentRoomId: effectiveRoomId,
        activityId: activityId || undefined,
      }),
    staleTime: HOME_DASHBOARD_REFRESH_MS,
  });

  const roomOptions = useMemo(() => {
    const rooms = roomsQuery.data ?? [];
    return [...rooms].sort((left, right) => {
      const leftVirtual = isVirtualWaitingRoom(left);
      const rightVirtual = isVirtualWaitingRoom(right);
      if (leftVirtual === rightVirtual) return 0;
      return leftVirtual ? -1 : 1;
    });
  }, [roomsQuery.data]);

  const closeRoomModal = useCallback(() => {
    setRoomModalOpen(false);
    setRoomModalError(null);
  }, []);

  const openRoomModal = useCallback(() => {
    setRoomModalError(null);
    setRoomModalOpen(true);
    if (!roomsQuery.data && !roomsQuery.isFetching) {
      void roomsQuery.refetch();
    }
  }, [roomsQuery]);

  useEffect(() => {
    if (!roomModalOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRoomModal();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeRoomModal, roomModalOpen]);

  const changeRoomFromHome = async (room: Room) => {
    const targetRoomId = String(room.id ?? "").trim();
    if (!targetRoomId || roomModalBusy) return;
    if (targetRoomId === effectiveRoomId) {
      closeRoomModal();
      return;
    }

    setRoomModalBusy(true);
    setRoomModalError(null);
    try {
      const currentQueryKey = tablesQueryKey(effectiveRoomId, activityId || "");
      await queryClient.cancelQueries({ queryKey: currentQueryKey });
      const result = await requestRoomChange({
        token: token || "",
        userId: effectiveUserId,
        role: effectiveRole,
        deviceUuid: deviceUuid || "",
        targetRoomId,
      });

      if (result.status === "approved") {
        setRoom({
          roomId: result.room.id,
          roomName: result.room.name,
          activityId: result.room.activityId,
          activityName: result.room.activityName,
        });
        closeRoomModal();
        const nextQueryKey = tablesQueryKey(result.room.id, result.room.activityId || "");
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["home-dashboard"] }),
          queryClient.invalidateQueries({ queryKey: ["available-rooms"] }),
          queryClient.invalidateQueries({ queryKey: currentQueryKey }),
          queryClient.invalidateQueries({ queryKey: nextQueryKey }),
        ]);
        return;
      }

      closeRoomModal();
    } catch (error) {
      setRoomModalError(error instanceof Error ? error.message : "Impossibile cambiare sala.");
    } finally {
      setRoomModalBusy(false);
    }
  };

  const openTablesFilter = (filter: DashboardTableFilter) => {
    onOpenTablesFilter(filter);
  };

  if (canLoadDashboard) {
    const isLoading = dashboardQuery.isLoading && !dashboardQuery.data;
    return (
      <GlassCard className="home-card workspace-card mobile-dashboard-card">
        <div className="card-body">
          <div
            className={`mobile-dashboard-shell ${isLoading ? "is-loading" : ""}`}
            aria-busy={isLoading}
          >
            <button
              type="button"
              className={`mobile-dashboard-room-card ${isLoading ? "is-loading" : ""}`}
              onClick={openRoomModal}
              aria-label="Cambia sala"
            >
              <span className="mobile-dashboard-room-eyebrow">Sala attuale</span>
              <span className="mobile-dashboard-room-line">
                <strong className="mobile-dashboard-room-name">{dashboardMetrics.roomName}</strong>
                <span
                  className="mobile-dashboard-room-meta"
                  aria-label={`${dashboardMetrics.totalTables} tavoli configurati`}
                >
                  {dashboardMetrics.totalTables}
                </span>
              </span>
            </button>

            <div className="mobile-dashboard-grid">
              <button
                type="button"
                className={`mobile-dashboard-widget is-free ${isLoading ? "is-loading" : ""}`}
                onClick={() => openTablesFilter("free")}
              >
                <span className="mobile-dashboard-widget-eyebrow">
                  {dashboardEyebrowLines("Tavoli liberi")}
                </span>
                <strong>{dashboardMetrics.freeCount}</strong>
                <span className="mobile-dashboard-widget-meta">
                  {dashboardMetrics.freeCount === 1
                    ? "1 tavolo libero"
                    : `${dashboardMetrics.freeCount} tavoli liberi`}
                </span>
              </button>

              <button
                type="button"
                className={`mobile-dashboard-widget is-occupied ${isLoading ? "is-loading" : ""}`}
                onClick={() => openTablesFilter("occupied")}
              >
                <span className="mobile-dashboard-widget-eyebrow">
                  {dashboardEyebrowLines("Occupati/Prenotati")}
                </span>
                <strong>{dashboardMetrics.occupiedCount}</strong>
                <span className="mobile-dashboard-widget-meta">
                  {dashboardMetrics.occupiedCount === 1
                    ? "1 tavolo occupato o prenotato"
                    : `${dashboardMetrics.occupiedCount} tavoli occupati o prenotati`}
                </span>
              </button>

              <button
                type="button"
                className={`mobile-dashboard-widget is-ordering ${isLoading ? "is-loading" : ""}`}
                onClick={() => openTablesFilter("ordering")}
              >
                <span className="mobile-dashboard-widget-eyebrow">
                  {dashboardEyebrowLines("Ordini in attesa")}
                </span>
                <strong>{dashboardMetrics.orderingCount}</strong>
                <span className="mobile-dashboard-widget-meta">
                  {dashboardMetrics.orderingCount === 1
                    ? "1 tavolo con ordine attivo"
                    : `${dashboardMetrics.orderingCount} tavoli con ordine attivo`}
                </span>
              </button>

              <button
                type="button"
                className={`mobile-dashboard-widget is-collect ${isLoading ? "is-loading" : ""}`}
                onClick={() => openTablesFilter("payment_due")}
              >
                <span className="mobile-dashboard-widget-eyebrow">
                  {dashboardEyebrowLines("Da riscuotere")}
                </span>
                <strong>{dashboardMetrics.paymentDueCount}</strong>
                <span className="mobile-dashboard-widget-meta">
                  {dashboardMetrics.paymentDueCount === 1
                    ? "1 tavolo"
                    : `${dashboardMetrics.paymentDueCount} tavoli`}{" "}
                  -{" "}
                  {canCollectPayments
                    ? formatCurrency(dashboardMetrics.paymentDueAmount)
                    : "visibili"}
                </span>
              </button>
            </div>

            <WaiterPauseCard />
          </div>
          {roomModalOpen ? (
            <div
              className="tables-room-change-backdrop tables-room-change-backdrop-home"
              onClick={closeRoomModal}
            >
              <div
                className="tables-room-change-modal tables-room-change-modal-home"
                role="dialog"
                aria-modal="true"
                aria-label="Cambio sala"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="tables-room-change-head">
                  <div className="tables-room-change-title">Cambio sala</div>
                  <button
                    type="button"
                    className="tables-room-change-close"
                    onClick={closeRoomModal}
                    aria-label="Chiudi cambio sala"
                  />
                </div>

                {roomModalError ? (
                  <div className="tables-room-change-error">{roomModalError}</div>
                ) : null}

                {!roomsQuery.isLoading && !roomsQuery.isFetching && roomOptions.length === 0 ? (
                  <div className="tables-room-change-empty">
                    Nessuna sala disponibile per questo utente.
                  </div>
                ) : null}

                <div className="tables-room-change-list">
                  {roomOptions.map((room) => {
                    const isCurrent = room.id === effectiveRoomId;
                    const isVirtualWaiting = isVirtualWaitingRoom(room);
                    return (
                      <button
                        key={room.id}
                        type="button"
                        className={`tables-room-change-option ${
                          isCurrent ? "is-current is-current-room" : "is-target-room"
                        } ${isVirtualWaiting ? "is-virtual-waiting-room" : ""}`}
                        disabled={roomModalBusy}
                        aria-current={isCurrent ? "true" : undefined}
                        onClick={() => {
                          if (isCurrent) {
                            closeRoomModal();
                            return;
                          }
                          void changeRoomFromHome(room);
                        }}
                      >
                        <span>{room.name}</span>
                        {isCurrent ? <strong>Attuale</strong> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </GlassCard>
    );
  }

  return (
    <GlassCard className="home-card">
      <div className="card-body">
        <h2 className="h1">Home</h2>
        <p className="p">
          Operatore: <strong>{username || "Operatore"}</strong> · Sessione attiva
        </p>

        <WaiterPauseCard />

        {showSimulationPanel && (
          <div className="sim-panel">
            <div className="p">Simula notifiche in arrivo.</div>
            <div className="sim-actions">
              <button className="smallbtn" type="button" onClick={onSimulateWaiter}>
                Cameriere +1
              </button>
              <button className="smallbtn" type="button" onClick={onSimulateBell}>
                Campanello +1
              </button>
              <button className="smallbtn" type="button" onClick={onSimulateGeneral}>
                Notifica +1
              </button>
            </div>
          </div>
        )}
      </div>
    </GlassCard>
  );
}
