import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  approveRoomChangeRequest,
  fetchAvailableRooms,
  requestRoomChange,
  type Room,
} from "../api/locations";
import { GlassCard } from "../components/GlassCard";
import { useAuthStore } from "../store/authStore";
import { getOrCreateDeviceUuid } from "../utils/device";
import { SystemRow } from "./home/components/SystemRow";
import { useNotificationCenterContext } from "./home/context/NotificationCenterContext";
import { useSystemTime } from "./home/hooks/useSystemTime";
import { useThemeMode } from "./home/hooks/useThemeMode";
import { useEdgeSwipeBack } from "./hooks/useEdgeSwipeBack";
import { HomeBackButton } from "./shared/HomeBackButton";
import { SwipeBackHomePreview } from "./shared/SwipeBackHomePreview";
import { NotificationSettingsSection } from "./settings/components/NotificationSettingsSection";
import { RoomAssignmentSection } from "./settings/components/RoomAssignmentSection";
import { RoomChangeApprovalModal } from "./settings/components/RoomChangeApprovalModal";
import { SettingSwitch } from "./settings/components/SettingSwitch";
import {
  getOrderBestSellersEnabled,
  getOrderFiltersEnabled,
  setOrderBestSellersEnabled,
  setOrderFiltersEnabled,
  subscribeOrderBestSellers,
  subscribeOrderFilters,
} from "../utils/orderPreferences";
import {
  getReservationReminderPreferences,
  setReservationReminderPreferences,
  subscribeReservationReminderPreferences,
} from "../utils/reservationReminderPreferences";
import {
  getTableFilterMode,
  setTableFilterMode,
  subscribeTableFilterMode,
  type TableFilterMode,
} from "../utils/tableFilterPreferences";
import {
  getMenuStationBadgeEnabled,
  setMenuStationBadgeEnabled,
  subscribeMenuStationBadge,
} from "../utils/menuStationBadgePreferences";

export function SettingsPage() {
  const navigate = useNavigate();
  const timeLabel = useSystemTime();
  const edgeSwipe = useEdgeSwipeBack(() => navigate("/"));
  const {
    mode,
    isDark,
    setTheme,
    setMode,
    customLightStart,
    customDarkStart,
    sunsetLightStart,
    sunsetDarkStart,
    sunsetStatus,
    setCustomLightStart,
    setCustomDarkStart,
  } = useThemeMode();
  const {
    token,
    userId,
    username,
    role,
    deviceUuid,
    roomId,
    roomName,
    activityId,
    activityName,
    setRoom,
  } = useAuthStore();

  const {
    waiterCount,
    bellCount,
    unreadCount,
    autoShowWaiter,
    autoShowBell,
    setAutoShowWaiter,
    setAutoShowBell,
  } = useNotificationCenterContext();

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<{ requestId: string; room: Room } | null>(
    null
  );

  const effectiveDeviceUuid = useMemo(() => deviceUuid || getOrCreateDeviceUuid(), [deviceUuid]);
  const effectiveRole = role || "operator";
  const effectiveUserId = useMemo(() => {
    if (userId) return userId;
    if (!username) return "";
    return `u_${username
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")}`;
  }, [userId, username]);

  const roomsQuery = useQuery({
    queryKey: [
      "available-rooms",
      effectiveUserId,
      effectiveRole,
      effectiveDeviceUuid,
      roomId,
      activityId,
    ],
    enabled: Boolean(token && effectiveUserId && effectiveDeviceUuid),
    queryFn: () =>
      fetchAvailableRooms({
        token: token || "",
        userId: effectiveUserId,
        role: effectiveRole,
        deviceUuid: effectiveDeviceUuid,
        currentRoomId: roomId || undefined,
        activityId: activityId || undefined,
      }),
    staleTime: 1000 * 30,
  });

  const roomOptions = roomsQuery.data ?? [];
  const roomLoadError = roomsQuery.isError
    ? roomsQuery.error instanceof Error
      ? roomsQuery.error.message
      : "Impossibile caricare le sale configurate."
    : null;
  useEffect(() => {
    if (!roomsQuery.isSuccess || !roomOptions || roomOptions.length === 0) return;
    const selected = roomId ? roomOptions.find((room) => room.id === roomId) : null;
    if (selected) {
      const selectedActivityId = String(selected.activityId ?? "").trim();
      const selectedActivityName = String(selected.activityName ?? "").trim();
      if (
        roomName !== selected.name ||
        selectedActivityId !== (activityId || "") ||
        selectedActivityName !== (activityName || "")
      ) {
        setRoom({
          roomId: selected.id,
          roomName: selected.name,
          activityId: selectedActivityId,
          activityName: selectedActivityName,
        });
      }
      return;
    }

    if (roomId) return;

    const initialRoom = roomOptions[0];
    setRoom({
      roomId: initialRoom.id,
      roomName: initialRoom.name,
      activityId: initialRoom.activityId,
      activityName: initialRoom.activityName,
    });
  }, [activityId, activityName, roomsQuery.isSuccess, roomOptions, roomId, roomName, setRoom]);

  const roomChangeMutation = useMutation({
    mutationFn: (targetRoomId: string) =>
      requestRoomChange({
        token: token || "",
        userId: effectiveUserId,
        role: effectiveRole,
        deviceUuid: effectiveDeviceUuid,
        targetRoomId,
      }),
    onSuccess: (res) => {
      if (res.status === "approved") {
        setPendingApproval(null);
        setApprovalOpen(false);
        setApprovalError(null);
        setRoom({
          roomId: res.room.id,
          roomName: res.room.name,
          activityId: res.room.activityId,
          activityName: res.room.activityName,
        });
        setStatusMessage(`Sala aggiornata a ${res.room.name}.`);
        return;
      }

      setPendingApproval({ requestId: res.requestId, room: res.room });
      setApprovalOpen(true);
      setApprovalError(null);
      setStatusMessage(
        `Richiesta inviata per ${res.room.name}. In attesa di autorizzazione da un responsabile.`
      );
    },
    onError: (err: Error) => {
      setStatusMessage(err.message || "Impossibile aggiornare la sala.");
    },
  });

  const approvalMutation = useMutation({
    mutationFn: (payload: { approverUsername: string; approverPin: string }) => {
      if (!pendingApproval) {
        throw new Error("Nessuna richiesta in attesa.");
      }
      return approveRoomChangeRequest({
        requestId: pendingApproval.requestId,
        approverUsername: payload.approverUsername,
        approverPin: payload.approverPin,
        deviceUuid: effectiveDeviceUuid,
      });
    },
    onSuccess: (res) => {
      if (!res.ok) {
        setApprovalError(res.error);
        return;
      }

      setRoom({
        roomId: res.room.id,
        roomName: res.room.name,
        activityId: res.room.activityId,
        activityName: res.room.activityName,
      });
      setStatusMessage(
        `Cambio sala approvato da ${res.approver.username}. Nuova sala: ${res.room.name}.`
      );
      setApprovalError(null);
      setApprovalOpen(false);
      setPendingApproval(null);
    },
    onError: (err: Error) => {
      setApprovalError(err.message || "Errore durante l'approvazione.");
    },
  });

  const automaticTheme = mode === "auto_sunset" || mode === "auto_custom";

  const [showOrderFilters, setShowOrderFilters] = useState<boolean>(() => getOrderFiltersEnabled());
  const [showOrderBestSellers, setShowOrderBestSellers] = useState<boolean>(() =>
    getOrderBestSellersEnabled()
  );
  const [menuStationBadgeEnabled, setMenuStationBadgeEnabledState] = useState(() =>
    getMenuStationBadgeEnabled()
  );
  const [reservationReminderPrefs, setReservationReminderPrefsState] = useState(() =>
    getReservationReminderPreferences()
  );
  const [tableFilterMode, setTableFilterModeState] = useState<TableFilterMode>(() =>
    getTableFilterMode()
  );

  useEffect(() => {
    return subscribeOrderFilters(() => {
      setShowOrderFilters(getOrderFiltersEnabled());
    });
  }, []);

  useEffect(() => {
    return subscribeOrderBestSellers(() => {
      setShowOrderBestSellers(getOrderBestSellersEnabled());
    });
  }, []);

  useEffect(() => {
    return subscribeMenuStationBadge(() => {
      setMenuStationBadgeEnabledState(getMenuStationBadgeEnabled());
    });
  }, []);

  useEffect(() => {
    return subscribeReservationReminderPreferences(() => {
      setReservationReminderPrefsState(getReservationReminderPreferences());
    });
  }, []);

  useEffect(() => {
    return subscribeTableFilterMode(() => {
      setTableFilterModeState(getTableFilterMode());
    });
  }, []);

  const updateReservationReminderPrefs = (
    patch: Partial<{
      enabled: boolean;
      firstLeadMinutes: number;
      secondLeadMinutes: number;
    }>
  ) => {
    const next = {
      ...reservationReminderPrefs,
      ...patch,
    };
    const first = Math.min(240, Math.max(1, Math.round(next.firstLeadMinutes || 15)));
    const secondRaw = Math.min(240, Math.max(1, Math.round(next.secondLeadMinutes || 5)));
    const second = Math.min(secondRaw, Math.max(1, first - 1));
    const normalized = {
      enabled: next.enabled,
      firstLeadMinutes: first,
      secondLeadMinutes: second,
    };
    setReservationReminderPrefsState(normalized);
    setReservationReminderPreferences(normalized);
  };

  const onSelectRoom = (nextRoomId: string) => {
    if (!nextRoomId || nextRoomId === roomId) return;
    setStatusMessage(null);
    setApprovalError(null);
    roomChangeMutation.mutate(nextRoomId);
  };

  return (
    <div className="page settings-page" {...edgeSwipe.bind}>
      <SwipeBackHomePreview timeLabel={timeLabel} revealProgress={edgeSwipe.revealProgress} />

      <div className="swipe-front-layer" style={edgeSwipe.style}>
        <div className="home-shell settings-shell">
          <SystemRow timeLabel={timeLabel} />

          <div className="home-topbar settings-topbar settings-ios-header">
            <HomeBackButton onClick={() => navigate("/")} />
            <div className="settings-topbar-title">Impostazioni</div>
            <div className="settings-header-spacer" aria-hidden="true" />
          </div>

          <GlassCard className="settings-card settings-card-ios">
            <div className="card-body settings-body">
              <div className="settings-scroll-area">
                <RoomAssignmentSection
                  currentRoomId={roomId}
                  currentRoomName={roomName}
                  rooms={roomOptions}
                  loadingRooms={roomsQuery.isLoading}
                  roomLoadError={roomLoadError}
                  pendingApprovalRoomName={pendingApproval?.room.name ?? null}
                  roomChangeBusy={roomChangeMutation.isPending || approvalMutation.isPending}
                  onSelectRoom={onSelectRoom}
                  onOpenApproval={() => setApprovalOpen(true)}
                />

                <div className="settings-group">
                  <div className="settings-group-title">Aspetto</div>
                  <div className="settings-ios-list">
                    <div className="settings-ios-row settings-ios-row-toggle">
                      <div className="settings-ios-key-wrap">
                        <div className="settings-ios-key">Tema Scuro Manuale</div>
                      </div>
                      <SettingSwitch
                        enabled={!automaticTheme && isDark}
                        onToggle={() => setTheme(isDark ? "light" : "dark")}
                        label="Tema scuro manuale"
                      />
                    </div>

                    <div className="settings-ios-row settings-ios-row-method">
                      <div className="settings-ios-key-wrap">
                        <div className="settings-ios-key">Metodo</div>
                      </div>
                      <div
                        className="settings-segment"
                        role="group"
                        aria-label="Metodo automatico tema"
                      >
                        <button
                          className={`settings-segment-btn ${mode === "auto_sunset" ? "is-active" : ""}`}
                          type="button"
                          onClick={() => setMode("auto_sunset")}
                        >
                          Solare
                        </button>
                        <button
                          className={`settings-segment-btn ${mode === "auto_custom" ? "is-active" : ""}`}
                          type="button"
                          onClick={() => setMode("auto_custom")}
                        >
                          Orario
                        </button>
                      </div>
                    </div>

                    {mode === "auto_sunset" && (
                      <>
                        <div className="settings-ios-row">
                          <div className="settings-ios-key">Alba</div>
                          <div className="settings-ios-value">
                            {sunsetStatus === "ready" ? sunsetLightStart : "--:--"}
                          </div>
                        </div>
                        <div className="settings-ios-row">
                          <div className="settings-ios-key">Tramonto</div>
                          <div className="settings-ios-value">
                            {sunsetStatus === "ready" ? sunsetDarkStart : "--:--"}
                          </div>
                        </div>
                      </>
                    )}

                    {mode === "auto_custom" && (
                      <div className="settings-ios-row settings-ios-row-times">
                        <div className="settings-ios-time-field">
                          <span className="settings-ios-time-label">Chiaro da</span>
                          <input
                            className="settings-time-input"
                            type="time"
                            value={customLightStart}
                            onChange={(e) => setCustomLightStart(e.target.value)}
                          />
                        </div>
                        <div className="settings-ios-time-field">
                          <span className="settings-ios-time-label">Scuro da</span>
                          <input
                            className="settings-time-input"
                            type="time"
                            value={customDarkStart}
                            onChange={(e) => setCustomDarkStart(e.target.value)}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="settings-group">
                  <div className="settings-group-title">Comande</div>
                  <div className="settings-ios-list">
                    <div className="settings-ios-row settings-ios-row-toggle">
                      <div className="settings-ios-key-wrap">
                        <div className="settings-ios-key">Mostra reparti e categorie</div>
                        <div className="settings-ios-value">
                          Attiva la vista completa dei filtri.
                        </div>
                      </div>
                      <SettingSwitch
                        enabled={showOrderFilters}
                        onToggle={() => {
                          const next = !showOrderFilters;
                          setShowOrderFilters(next);
                          setOrderFiltersEnabled(next);
                        }}
                        label="Mostra reparti e categorie"
                      />
                    </div>
                    <div className="settings-ios-row settings-ios-row-toggle">
                      <div className="settings-ios-key-wrap">
                        <div className="settings-ios-key">Mostra best-seller</div>
                        <div className="settings-ios-value">
                          Porta in alto fino a 7 articoli più usati, lasciando visibili gli altri.
                        </div>
                      </div>
                      <SettingSwitch
                        enabled={showOrderBestSellers}
                        onToggle={() => {
                          const next = !showOrderBestSellers;
                          setShowOrderBestSellers(next);
                          setOrderBestSellersEnabled(next);
                        }}
                        label="Mostra best-seller"
                      />
                    </div>
                  </div>
                  <div
                    id="mobile-menu-station-badge-setting"
                    className="settings-ios-list mobile-menu-station-badge-list"
                  >
                    <div className="settings-ios-row settings-ios-row-toggle mobile-menu-station-badge-row">
                      <div className="settings-ios-key-wrap">
                        <div className="settings-ios-key">Badge postazione sulle card</div>
                        <div className="settings-ios-value">
                          Mostra BAR, CAFFETTERIA o CUCINA in un badge in basso a destra.
                        </div>
                      </div>
                      <SettingSwitch
                        enabled={menuStationBadgeEnabled}
                        onToggle={() => {
                          const next = !menuStationBadgeEnabled;
                          setMenuStationBadgeEnabledState(next);
                          setMenuStationBadgeEnabled(next);
                        }}
                        label="Badge postazione sulle card"
                        className="mobile-menu-station-badge-toggle"
                      />
                    </div>
                  </div>
                </div>

                <div className="settings-group">
                  <div className="settings-group-title">Tavoli</div>
                  <div className="settings-ios-list">
                    <div className="settings-ios-row settings-ios-row-toggle">
                      <div className="settings-ios-key-wrap">
                        <div className="settings-ios-key">Filtro legenda</div>
                        <div className="settings-ios-value">
                          Escludi più stati oppure mostra solo uno stato per volta.
                        </div>
                      </div>
                      <div
                        className="settings-segment"
                        role="group"
                        aria-label="Modalità filtro tavoli"
                      >
                        <button
                          className={`settings-segment-btn ${tableFilterMode === "exclude" ? "is-active" : ""}`}
                          type="button"
                          onClick={() => {
                            setTableFilterModeState("exclude");
                            setTableFilterMode("exclude");
                          }}
                        >
                          Esclusione
                        </button>
                        <button
                          className={`settings-segment-btn ${tableFilterMode === "single" ? "is-active" : ""}`}
                          type="button"
                          onClick={() => {
                            setTableFilterModeState("single");
                            setTableFilterMode("single");
                          }}
                        >
                          Solo uno
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="settings-group">
                  <div className="settings-group-title">Notifiche</div>
                  <NotificationSettingsSection
                    autoShowWaiter={autoShowWaiter}
                    autoShowBell={autoShowBell}
                    onToggleAutoShowWaiter={() => setAutoShowWaiter(!autoShowWaiter)}
                    onToggleAutoShowBell={() => setAutoShowBell(!autoShowBell)}
                  />
                </div>

                <div className="settings-group">
                  <div className="settings-group-title">Reminder Prenotazioni</div>
                  <div className="settings-ios-list">
                    <div className="settings-ios-row settings-ios-row-toggle">
                      <div className="settings-ios-key-wrap">
                        <div className="settings-ios-key">Attiva promemoria tavolo</div>
                        <div className="settings-ios-value">
                          Invio notifica per prenotazioni imminenti.
                        </div>
                      </div>
                      <SettingSwitch
                        enabled={reservationReminderPrefs.enabled}
                        onToggle={() =>
                          updateReservationReminderPrefs({
                            enabled: !reservationReminderPrefs.enabled,
                          })
                        }
                        label="Attiva reminder prenotazioni"
                      />
                    </div>

                    <div className="settings-ios-row settings-ios-row-times">
                      <div className="settings-ios-time-field">
                        <label
                          className="settings-ios-time-label"
                          htmlFor="reservation-first-reminder"
                        >
                          Primo avviso (min)
                        </label>
                        <input
                          id="reservation-first-reminder"
                          name="reservation_first_reminder"
                          className="settings-time-input"
                          type="number"
                          min={2}
                          max={240}
                          value={reservationReminderPrefs.firstLeadMinutes}
                          onChange={(event) =>
                            updateReservationReminderPrefs({
                              firstLeadMinutes: Number(event.target.value) || 15,
                            })
                          }
                        />
                      </div>
                      <div className="settings-ios-time-field">
                        <label
                          className="settings-ios-time-label"
                          htmlFor="reservation-second-reminder"
                        >
                          Secondo avviso (min)
                        </label>
                        <input
                          id="reservation-second-reminder"
                          name="reservation_second_reminder"
                          className="settings-time-input"
                          type="number"
                          min={1}
                          max={239}
                          value={reservationReminderPrefs.secondLeadMinutes}
                          onChange={(event) =>
                            updateReservationReminderPrefs({
                              secondLeadMinutes: Number(event.target.value) || 5,
                            })
                          }
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="settings-group">
                  <div className="settings-group-title">Stato Live</div>
                  <div className="settings-ios-list">
                    <div className="settings-ios-row">
                      <div className="settings-ios-key">Chiamate cameriere in attesa</div>
                      <div className="settings-ios-badge waiter">{waiterCount}</div>
                    </div>
                    <div className="settings-ios-row">
                      <div className="settings-ios-key">Comande pronte in attesa</div>
                      <div className="settings-ios-badge bell">{bellCount}</div>
                    </div>
                    <div className="settings-ios-row">
                      <div className="settings-ios-key">Notifiche generali non lette</div>
                      <div className="settings-ios-badge general">{unreadCount}</div>
                    </div>
                  </div>
                </div>

                {statusMessage && <div className="settings-status-banner">{statusMessage}</div>}
              </div>
            </div>
          </GlassCard>
        </div>

        <RoomChangeApprovalModal
          open={approvalOpen && Boolean(pendingApproval)}
          targetRoomName={pendingApproval?.room.name || ""}
          busy={approvalMutation.isPending}
          error={approvalError}
          onConfirm={(payload) => approvalMutation.mutate(payload)}
          onCancel={() => {
            setApprovalOpen(false);
            setApprovalError(null);
          }}
        />
      </div>
    </div>
  );
}
