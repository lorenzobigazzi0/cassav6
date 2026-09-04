import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAvailableRooms, requestRoomChange, type Room } from "../../../api/locations";
import { fetchMenuCatalogForSession } from "../../../api/menu";
import {
  DEFAULT_ORDER_WORKFLOW_SETTINGS,
  fetchOrderWorkflowSettings,
} from "../../../api/orderWorkflowSettings";
import {
  addDiningTableOrder,
  adminCancelDiningTable,
  type DiningTable,
  type DiningTableMoveResult,
  type DiningTableOrder,
  type TablesSnapshot,
  fetchTablesForSession,
  freeDiningTable,
  keepDiningTableAfterConfigurationRemoval,
  markDiningReservationArrived,
  markDiningOrderServed,
  moveDiningTable,
  occupyDiningTable,
  payDiningTable,
  reserveDiningTable,
  tablesQueryKey,
  updateDiningTableMeta,
} from "../../../api/tables";
import {
  fetchIntegrationLayout,
  fetchIntegrationTableRoomMoveStatus,
  sendIntegrationTableRoomMoveRequest,
} from "../../../api/tables/integrationClient";
import {
  buildMergedTableGroups,
  buildSplitTableGroups,
  flattenTableGroupNodeIds,
  saveTableGroups,
  tableGroupLogicalNodeForId,
  tableStatus,
  type TableGroup,
} from "../../../api/tableGroups";
import { printTablePreconto } from "../../../api/printing";
import {
  ORDER_COMPOSER_LOCK_PURPOSE,
  ORDER_CREATE_LOCK_PURPOSE,
  PAYMENT_LOCK_PURPOSE,
  PAYMENT_SESSION_LOCK_PURPOSE,
  TABLE_LAYOUT_MOVE_LOCK_PURPOSE,
  TABLE_LAYOUT_SYNC_LOCK_PURPOSE,
  withOfflineContinuationTableLocks,
  withRequiredTableLocks,
  type TableLockConflictDetail,
  type TableLockPurpose,
} from "../../../api/tableLocks";
import { GlassCard } from "../../../components/GlassCard";
import { normalizeTableCovers } from "../../../domain/tables/capacity";
import {
  readSessionPreference,
  writeSessionPreference,
} from "../../../shared/storage/preferenceStorage";
import {
  createRealtimeRefreshCoordinator,
  MOBILE_REALTIME_REFRESH_COOLDOWN_MS,
  realtimeRefreshKey,
} from "../../../shared/realtime/realtimeRefreshCoordinator";
import {
  isClientOptimisticActionsEnabled,
  runBackgroundOptimisticRequest,
} from "../../../shared/optimistic/clientOptimisticActions";
import { useRealtimeTransportStatus } from "../../../app/runtime/realtimeTransportStatus";
import { useAuthStore } from "../../../store/authStore";
import { getOrCreateDeviceUuid } from "../../../utils/device";
import { triggerLongPressHaptic } from "../../../utils/haptics";
import { isVirtualWaitingRoom } from "../../../utils/rooms";
import { shouldReserveTableForReservation } from "../../../api/tableReservationWindow";
import { fetchReservationsForDay, reservationsQueryKey } from "../../../api/reservations";
import { evaluateUnionReadiness, seatGuardFor } from "./reservationTableUnion";
import { tableGroupByRoot, tableGroupDirectNodeKey } from "../../../api/tableGroups";
import { clearRoomTables, freeRoomTables } from "./roomBulkActions";
import {
  TablesRoomActionsDialog,
  type RoomBulkAction,
} from "./components/TablesRoomActionsDialog";
import {
  getTableFilterMode,
  subscribeTableFilterMode,
  type TableFilterMode,
} from "../../../utils/tableFilterPreferences";
import { TableDetailPanel, type ServiceRecoveryAction } from "./components/TableDetailPanel";
import { persistTablePaymentAdjustment } from "../../../api/orderServiceRecovery";
import { TableGroupsDialog, type TableGroupsDialogState } from "./components/TableGroupsDialog";
import { CounterWorkspace } from "./counter/CounterWorkspace";
import {
  TableMergeConfirmDialog,
  type TableMergeConfirmRequest,
  TableMoveConfirmDialog,
  type TableMoveConfirmRequest,
} from "./components/TableMergeConfirmDialog";
import { TableReservationReleaseDialog } from "./components/TableReservationReleaseDialog";
import { TableServiceRecoveryDialog } from "./components/TableServiceRecoveryDialog";
import { TableTile } from "./components/TableTile";
import { TableConfigurationRemovalDialog } from "./components/TableConfigurationRemovalDialog";
import { tableNeedsConfigurationRemovalDecision } from "../../../domain/offlineConfiguration/reconciliation";
import { TABLE_ALLERGEN_OPTIONS, TABLE_ALLERGY_NOTE } from "./constants";
import { useReservationReleasePrompt } from "./hooks/useReservationReleasePrompt";
import { useTableLock } from "./hooks/useTableLock";
import {
  isNoActiveStationOrderWarning,
  NO_ACTIVE_STATIONS_MESSAGE,
  useStationAvailabilityRecovery,
} from "./hooks/useStationAvailabilityRecovery";
import { useTimedPricingRefresh } from "../menu/hooks/useTimedPricingRefresh";
import {
  formatMoveTableLabel,
  getDefaultReservationTimeValue,
  reservationTimeToTimestamp,
  shouldReseedTableForm,
} from "./utils";
import {
  applyOptimisticFreeTableToSnapshot,
  applyOptimisticMoveTablesBetweenSnapshots,
  applyOptimisticMoveTablesToSnapshot,
  applyOptimisticOccupyTableToSnapshot,
  applyOptimisticOrderPendingToSnapshot,
  applyResolvedTableMoveToSnapshot,
  applyRealtimeTablesPayloadToSnapshot,
  isDiningTableValue,
  isRemovedDiningTableResult,
  isTableMoveResult,
  removeSnapshotTable,
  resolveTableMoveLockIds,
  shouldRefreshTablesForServerEvent,
  sleep,
  upsertSnapshotTable,
} from "./workspaceRuntime";
import type { TableOrderSubmitPayload } from "./orderDraftPricing";
import { buildRoomMoveAvailability } from "./roomMoveAvailability";

type LegendFilterKey = "free" | "occupied" | "ordering" | "payment_due";
const LEGEND_FILTER_KEYS: LegendFilterKey[] = ["free", "occupied", "ordering", "payment_due"];
const DASHBOARD_QUICK_FILTER_EVENT = "mobile:dashboard:quick-filter";
const ROOMS_HOT_REFRESH_MS = 30_000;
const REALTIME_SAFETY_REFRESH_MS = 90_000;
const TABLES_MUTATION_REFRESH_DEBOUNCE_MS = 700;
const TABLE_ROOM_MOVE_APPROVAL_TIMEOUT_MS = 30_000;
const TABLE_ROOM_MOVE_STATUS_POLL_MS = 1_000;

type TablesWorkspaceUiSnapshot = {
  selectedTableId: string | null;
  setupMode: "occupy" | "reserve";
  draftName: string;
  draftPhone: string;
  draftCovers: string;
  draftNote: string;
  hasAllergyAlert: boolean;
  selectedAllergens: string[];
  draftManualIntolerance: string;
  reservationTime: string;
  searchQuery: string;
  disabledLegendFilters: LegendFilterKey[];
  activeLegendFilter: LegendFilterKey | null;
};

const buildTableFormSyncKey = (table: DiningTable | null) => {
  if (!table) return "";
  return JSON.stringify({
    id: table.id,
    occupancyState: table.occupancyState,
    tableName: table.tableName,
    customerPhone: table.customerPhone,
    covers: table.covers,
    note: table.note,
    allergens: table.allergens,
    manualIntolerance: table.manualIntolerance,
    reservationAt: table.reservationAt,
  });
};

export function TablesWorkspace({
  active = true,
  counterMode = false,
  dashboardQuickFilter = null,
  roomPickerRequest = null,
}: {
  active?: boolean;
  counterMode?: boolean;
  dashboardQuickFilter?: { filter: LegendFilterKey; nonce: number } | null;
  roomPickerRequest?: { nonce: number } | null;
}) {
  const queryClient = useQueryClient();
  const {
    token,
    userId,
    username,
    fullName,
    role,
    deviceUuid,
    roomId,
    roomName,
    activityId,
    activityName,
    permissions,
    setRoom,
  } = useAuthStore();
  const optimisticActionsEnabled = useMemo(() => isClientOptimisticActionsEnabled(), []);

  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [setupMode, setSetupMode] = useState<"occupy" | "reserve">("occupy");
  const [draftName, setDraftName] = useState("");
  const [draftPhone, setDraftPhone] = useState("");
  const [draftCovers, setDraftCovers] = useState("2");
  const [draftNote, setDraftNote] = useState("");
  // Non piu uno stato a se: e attivo se c'e almeno un'intolleranza.
  const [selectedAllergensState, setSelectedAllergens] = useState<string[]>([]);

  const [draftManualIntolerance, setDraftManualIntolerance] = useState("");
  const selectedAllergens = selectedAllergensState;
  const hasAllergyAlert =
    selectedAllergens.length > 0 || Boolean(draftManualIntolerance.trim());
  const [reservationTime, setReservationTime] = useState("");
  const [movePickerOpen, setMovePickerOpen] = useState(false);
  const [moveConfirm, setMoveConfirm] = useState<TableMoveConfirmRequest | null>(null);
  const [mergeConfirm, setMergeConfirm] = useState<TableMergeConfirmRequest | null>(null);
  const [orderComposerOpen, setOrderComposerOpen] = useState(false);
  const [paymentWizardOpen, setPaymentWizardOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [noActiveStationsWarning, setNoActiveStationsWarning] = useState(false);
  const [tableGroupsDialog, setTableGroupsDialog] = useState<TableGroupsDialogState | null>(null);
  const [tableGroupsError, setTableGroupsError] = useState<string | null>(null);
  const [tableRoomMoveSnapshot, setTableRoomMoveSnapshot] = useState<{
    roomId: string;
    roomName: string;
    tables: DiningTable[];
    groups: TableGroup[];
  } | null>(null);
  const [serviceRecoveryDialog, setServiceRecoveryDialog] = useState<{
    order: DiningTableOrder;
    action: ServiceRecoveryAction;
  } | null>(null);
  const [serviceRecoveryNotice, setServiceRecoveryNotice] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [disabledLegendFilters, setDisabledLegendFilters] = useState<LegendFilterKey[]>([]);
  const [activeLegendFilter, setActiveLegendFilter] = useState<LegendFilterKey | null>(null);
  const [legendFilterMode, setLegendFilterModeState] = useState<TableFilterMode>(() =>
    getTableFilterMode()
  );
  const [roomPickerOpen, setRoomPickerOpen] = useState(false);
  const [roomPickerBusy, setRoomPickerBusy] = useState(false);
  const [roomActionsTarget, setRoomActionsTarget] = useState<Room | null>(null);
  // Alla liberazione di un tavolo unito si chiede se dividerlo: mai in automatico.
  const [splitAfterFree, setSplitAfterFree] = useState<{ rootId: string; label: string } | null>(
    null
  );
  const [roomActionsBusy, setRoomActionsBusy] = useState(false);
  const [roomActionsError, setRoomActionsError] = useState<string | null>(null);
  const roomLongPressRef = useRef<number | null>(null);
  const roomLongPressFiredRef = useRef(false);
  const [roomPickerError, setRoomPickerError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const tablesScrollRef = useRef<HTMLDivElement | null>(null);
  const roomTitleLongPressTimerRef = useRef<number | null>(null);
  const roomTitleLongPressTriggeredRef = useRef(false);
  const scrollRestoreRef = useRef(false);
  const restoreWorkspaceStateRef = useRef(false);
  const restoredTableIdRef = useRef<string | null>(null);
  const prevSelectedTableIdRef = useRef<string | null>(null);
  const selectedTableMissingSinceRef = useRef<number | null>(null);
  const tablesMutationRefreshTimerRef = useRef<number | null>(null);
  const realtimeWasDisconnectedRef = useRef(true);
  const realtimeTransport = useRealtimeTransportStatus();
  const dashboardQuickFilterActiveRef = useRef(false);
  const dismissedDashboardQuickFilterNonceRef = useRef<number | null>(null);
  const dashboardQuickFilterPreviousModeRef = useRef<TableFilterMode | null>(null);
  const temporaryLegendFilterPreviousModeRef = useRef<TableFilterMode | null>(null);
  const temporaryLegendFilterPreviousDisabledRef = useRef<LegendFilterKey[] | null>(null);
  const [selectedTableSnapshot, setSelectedTableSnapshot] = useState<DiningTable | null>(null);
  const [uiRestored, setUiRestored] = useState(false);
  const [configurationRemovalTableId, setConfigurationRemovalTableId] = useState<string | null>(
    null
  );
  const [configurationRemovalBusy, setConfigurationRemovalBusy] = useState(false);

  const clearNoActiveStationsWarning = useCallback(() => {
    setNoActiveStationsWarning(false);
  }, []);
  useStationAvailabilityRecovery({
    enabled: noActiveStationsWarning,
    onRestored: clearNoActiveStationsWarning,
  });

  const closeTableChildFlows = useCallback(() => {
    setMovePickerOpen(false);
    setMoveConfirm(null);
    setMergeConfirm(null);
    setOrderComposerOpen(false);
    setPaymentWizardOpen(false);
    setTableGroupsDialog(null);
    setTableRoomMoveSnapshot(null);
    setServiceRecoveryDialog(null);
    setConfigurationRemovalTableId(null);
  }, []);

  const closeTableDetail = useCallback(() => {
    setSelectedTableId(null);
    setSelectedTableSnapshot(null);
    closeTableChildFlows();
  }, [closeTableChildFlows]);

  useEffect(() => {
    if (!counterMode) return;
    closeTableDetail();
    setRoomPickerOpen(false);
    setActionError(null);
  }, [closeTableDetail, counterMode]);

  const effectiveRoomId = roomId || "";
  const effectiveActivityId = activityId || "";
  const scrollKey = useMemo(() => `tables_scroll_${effectiveRoomId}`, [effectiveRoomId]);
  const workspaceUiKey = useMemo(() => `tables_workspace_${effectiveRoomId}`, [effectiveRoomId]);
  const effectiveDeviceUuid = useMemo(
    () => (deviceUuid && deviceUuid.trim() ? deviceUuid : getOrCreateDeviceUuid()),
    [deviceUuid]
  );
  const effectiveRole = role || "operator";
  const canAdminCancelTables = effectiveRole === "admin" || effectiveRole === "responsabile";
  const effectiveUserId = useMemo(() => {
    if (userId && userId.trim()) return userId;
    if (username && username.trim()) {
      return `u_${username
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")}`;
    }
    return "u_operatore";
  }, [userId, username]);
  const canLoad = Boolean(
    active &&
    token &&
    effectiveUserId &&
    effectiveDeviceUuid &&
    effectiveRoomId &&
    effectiveActivityId
  );
  const canLoadTables = canLoad && !counterMode;
  const canCollectPayments = permissions.includes("collect_payments");

  const roomsQuery = useQuery({
    queryKey: [
      "available-rooms",
      effectiveUserId,
      effectiveRole,
      effectiveDeviceUuid,
      effectiveRoomId,
      effectiveActivityId,
    ],
    enabled: active && Boolean(token && effectiveUserId && effectiveDeviceUuid),
    queryFn: () =>
      fetchAvailableRooms({
        token: token || "",
        userId: effectiveUserId,
        role: effectiveRole,
        deviceUuid: effectiveDeviceUuid,
        currentRoomId: effectiveRoomId,
        activityId: effectiveActivityId || undefined,
      }),
    staleTime: ROOMS_HOT_REFRESH_MS,
    refetchInterval: ROOMS_HOT_REFRESH_MS,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const roomMoveAvailabilityQuery = useQuery({
    queryKey: ["table-room-move-availability"],
    enabled: canLoadTables && tableGroupsDialog?.type === "roomMoveRoom",
    staleTime: 0,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    queryFn: async () => {
      const layout = await fetchIntegrationLayout();
      if (!layout) {
        throw new Error("Disponibilita sale non raggiungibile.");
      }
      return buildRoomMoveAvailability(layout.tables);
    },
  });

  const tablesQuery = useQuery({
    queryKey: tablesQueryKey(effectiveRoomId, effectiveActivityId),
    enabled: canLoadTables,
    staleTime: 30_000,
    refetchInterval: realtimeTransport.connected ? false : REALTIME_SAFETY_REFRESH_MS,
    refetchIntervalInBackground: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    queryFn: () =>
      fetchTablesForSession({
        token: token || "",
        userId: effectiveUserId,
        deviceUuid: effectiveDeviceUuid,
        activityId: effectiveActivityId,
        roomId: effectiveRoomId,
      }),
  });

  // La chiave "order-workflow-settings" e gia nella lista invalidata da useSettingsLiveSync,
  // quindi un cambio di configurazione si propaga senza polling dedicato.
  const orderWorkflowSettingsQuery = useQuery({
    queryKey: ["order-workflow-settings", effectiveUserId, effectiveDeviceUuid],
    enabled: canLoad,
    staleTime: 60_000,
    refetchInterval: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    queryFn: () =>
      fetchOrderWorkflowSettings({
        token: token || "",
        userId: effectiveUserId,
        deviceUuid: effectiveDeviceUuid,
        roomId: effectiveRoomId,
      }),
  });

  const deliveryConfirmationEnabled =
    orderWorkflowSettingsQuery.data?.deliveryConfirmationEnabled ??
    DEFAULT_ORDER_WORKFLOW_SETTINGS.deliveryConfirmationEnabled;

  const menuCatalogQuery = useQuery({
    queryKey: ["tables-order-menu", effectiveActivityId, effectiveRoomId],
    enabled: canLoad,
    staleTime: 60_000,
    refetchInterval: realtimeTransport.connected ? false : REALTIME_SAFETY_REFRESH_MS,
    refetchIntervalInBackground: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () =>
      (
        await fetchMenuCatalogForSession({
          token: token || "",
          userId: effectiveUserId,
          deviceUuid: effectiveDeviceUuid,
          activityId: effectiveActivityId,
          roomId: effectiveRoomId,
        })
      ).catalog,
  });
  const refetchMenuCatalog = menuCatalogQuery.refetch;
  const refetchRooms = roomsQuery.refetch;
  const refetchTables = tablesQuery.refetch;

  useEffect(() => {
    if (!canLoad) return undefined;
    const queryKey = tablesQueryKey(effectiveRoomId, effectiveActivityId);
    const applyPayloadToTablesCache = (detail: unknown) => {
      let applied = false;
      queryClient.setQueryData<TablesSnapshot>(queryKey, (current) => {
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
        if (update.source === "reconnect") {
          if (canLoadTables) await refetchTables();
          if (signal.aborted) return;
          await refetchRooms();
          if (signal.aborted) return;
          await refetchMenuCatalog();
          return;
        }
        const payloadApplied =
          update.source === "payload" && applyPayloadToTablesCache(update.detail);
        if (!payloadApplied || supersededCount > 0) {
          await refetchTables();
        }
        if (signal.aborted) return;
        if (
          String((update.detail as { reason?: unknown } | undefined)?.reason ?? "")
            .toLowerCase()
            .startsWith("monitor_")
        ) {
          await refetchRooms();
        }
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
      if (!canLoadTables) return;
      if (!shouldRefreshTablesForServerEvent(detail?.reason)) return;
      coordinator.enqueue(realtimeRefreshKey(detail), { detail, source: "payload" });
    };
    const handleServerRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: unknown; atMs?: unknown }>).detail;
      if (!canLoadTables) return;
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
    canLoad,
    canLoadTables,
    effectiveActivityId,
    effectiveRoomId,
    queryClient,
    realtimeTransport.connected,
    refetchMenuCatalog,
    refetchRooms,
    refetchTables,
  ]);

  useTimedPricingRefresh({
    enabled: canLoad && Boolean(menuCatalogQuery.data?.products.length),
    products: menuCatalogQuery.data?.products ?? [],
    onRefresh: () => menuCatalogQuery.refetch(),
  });

  const sortedTables = useMemo(
    () =>
      [...(tablesQuery.data?.tables ?? [])].sort((left, right) => {
        if (left.number !== right.number) return left.number - right.number;
        return left.id.localeCompare(right.id, "it");
      }),
    [tablesQuery.data?.tables]
  );
  const rawTables = useMemo(
    () => tablesQuery.data?.rawTables ?? sortedTables,
    [sortedTables, tablesQuery.data?.rawTables]
  );
  const tableGroups = useMemo(
    () => tablesQuery.data?.tableGroups ?? [],
    [tablesQuery.data?.tableGroups]
  );

  // Prenotazioni del giorno: servono per unire da sole i tavoli che una
  // prenotazione tiene insieme. Stessa chiave del gestore, quindi una query sola.
  const reservationServiceDate = useMemo(() => {
    const now = new Date();
    const mese = String(now.getMonth() + 1).padStart(2, "0");
    const giorno = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${mese}-${giorno}`;
  }, []);
  const dayReservationsQuery = useQuery({
    queryKey: reservationsQueryKey(effectiveRoomId, reservationServiceDate),
    enabled: Boolean(token && effectiveUserId && effectiveDeviceUuid && effectiveRoomId),
    staleTime: 10_000,
    queryFn: () =>
      fetchReservationsForDay({
        token: token || "",
        userId: effectiveUserId,
        deviceUuid: effectiveDeviceUuid,
        roomId: effectiveRoomId,
        serviceDate: reservationServiceDate,
      }),
  });

  const normalizedSearchQuery = searchQuery.trim().toLowerCase();

  const resolveLegendKey = (table: (typeof sortedTables)[number]): LegendFilterKey => {
    if (table.amountDue > 0) return "payment_due";
    if (table.ordersInProgress > 0) return "ordering";
    if (table.occupancyState === "free") return "free";
    return "occupied";
  };

  const searchMatchedTables = useMemo(() => {
    if (!normalizedSearchQuery) return sortedTables;
    return sortedTables.filter((table) => {
      const byNumber = table.number.toString().includes(normalizedSearchQuery);
      const byName = table.tableName.toLowerCase().includes(normalizedSearchQuery);
      const byPhone = table.customerPhone.toLowerCase().includes(normalizedSearchQuery);
      return byNumber || byName || byPhone;
    });
  }, [normalizedSearchQuery, sortedTables]);

  const filteredTables = useMemo(() => {
    if (legendFilterMode === "single") {
      if (!activeLegendFilter) return searchMatchedTables;
      return searchMatchedTables.filter((table) => resolveLegendKey(table) === activeLegendFilter);
    }
    if (disabledLegendFilters.length === 0) return searchMatchedTables;

    return searchMatchedTables.filter(
      (table) => !disabledLegendFilters.includes(resolveLegendKey(table))
    );
  }, [
    activeLegendFilter,
    disabledLegendFilters,
    legendFilterMode,
    resolveLegendKey,
    searchMatchedTables,
  ]);

  const selectedTable = useMemo(
    () => sortedTables.find((table) => table.id === selectedTableId) ?? null,
    [selectedTableId, sortedTables]
  );
  const detailTable = useMemo(() => {
    if (selectedTable) return selectedTable;
    if (!selectedTableId) return null;
    if (selectedTableSnapshot?.id !== selectedTableId) return null;
    return selectedTableSnapshot;
  }, [selectedTable, selectedTableId, selectedTableSnapshot]);
  const detailTableFormSyncKey = useMemo(() => buildTableFormSyncKey(detailTable), [detailTable]);
  const detailPanelOpen = Boolean(selectedTableId && detailTable);
  const configurationRemovalTable = useMemo(
    () =>
      configurationRemovalTableId
        ? (sortedTables.find((table) => table.id === configurationRemovalTableId) ?? null)
        : null,
    [configurationRemovalTableId, sortedTables]
  );
  const selectedActionTableId = detailTable?.mobileActiveTableId || selectedTableId;
  const selectedLogicalTableContext = useMemo(
    () => ({
      logicalTableId: detailTable?.logicalTableId,
      logicalTableLabel: detailTable?.logicalTableLabel,
      tableLabel: detailTable?.tableLabel,
    }),
    [detailTable?.logicalTableId, detailTable?.logicalTableLabel, detailTable?.tableLabel]
  );

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    return subscribeTableFilterMode(() => {
      setLegendFilterModeState(getTableFilterMode());
    });
  }, []);

  const applyDashboardQuickFilter = useCallback(
    (rawFilter?: unknown) => {
      const filter = typeof rawFilter === "string" ? rawFilter.trim() : "";
      if (!LEGEND_FILTER_KEYS.includes(filter as LegendFilterKey)) return false;

      const nextFilter = filter as LegendFilterKey;
      if (!dashboardQuickFilterActiveRef.current) {
        dashboardQuickFilterPreviousModeRef.current = legendFilterMode;
      }
      dashboardQuickFilterActiveRef.current = true;
      temporaryLegendFilterPreviousModeRef.current = null;
      temporaryLegendFilterPreviousDisabledRef.current = null;
      setLegendFilterModeState("single");
      setDisabledLegendFilters([]);
      setActiveLegendFilter(nextFilter);
      setSearchQuery("");
      setSelectedTableId(null);
      setSelectedTableSnapshot(null);
      closeTableChildFlows();
      setActionError(null);
      setRoomPickerOpen(false);
      if (tablesScrollRef.current) {
        tablesScrollRef.current.scrollTop = 0;
      }
      return true;
    },
    [closeTableChildFlows, legendFilterMode]
  );

  useEffect(() => {
    setUiRestored(false);
    restoreWorkspaceStateRef.current = false;
    restoredTableIdRef.current = null;
    prevSelectedTableIdRef.current = null;

    try {
      const raw = readSessionPreference(workspaceUiKey);
      dashboardQuickFilterActiveRef.current = false;
      dashboardQuickFilterPreviousModeRef.current = null;
      temporaryLegendFilterPreviousModeRef.current = null;
      temporaryLegendFilterPreviousDisabledRef.current = null;
      if (!raw) {
        setUiRestored(true);
        return;
      }

      const parsed = JSON.parse(raw) as Partial<TablesWorkspaceUiSnapshot>;
      const restoredSelectedTableId =
        typeof parsed.selectedTableId === "string" && parsed.selectedTableId.trim()
          ? parsed.selectedTableId
          : null;
      const restoredSetupMode = parsed.setupMode === "reserve" ? "reserve" : "occupy";
      const restoredDisabledLegend = Array.isArray(parsed.disabledLegendFilters)
        ? parsed.disabledLegendFilters.filter(
            (entry): entry is LegendFilterKey =>
              typeof entry === "string" && LEGEND_FILTER_KEYS.includes(entry as LegendFilterKey)
          )
        : [];
      const restoredActiveLegend =
        typeof parsed.activeLegendFilter === "string" &&
        LEGEND_FILTER_KEYS.includes(parsed.activeLegendFilter as LegendFilterKey)
          ? (parsed.activeLegendFilter as LegendFilterKey)
          : null;

      setSelectedTableId(restoredSelectedTableId);
      setSetupMode(restoredSetupMode);
      setDraftName(typeof parsed.draftName === "string" ? parsed.draftName : "");
      setDraftPhone(typeof parsed.draftPhone === "string" ? parsed.draftPhone : "");
      setDraftCovers(typeof parsed.draftCovers === "string" ? parsed.draftCovers : "2");
      setDraftNote(typeof parsed.draftNote === "string" ? parsed.draftNote : "");
      setSelectedAllergens(
        Array.isArray(parsed.selectedAllergens)
          ? parsed.selectedAllergens.filter((entry): entry is string => typeof entry === "string")
          : []
      );
      setDraftManualIntolerance(
        typeof parsed.draftManualIntolerance === "string" ? parsed.draftManualIntolerance : ""
      );
      setReservationTime(typeof parsed.reservationTime === "string" ? parsed.reservationTime : "");
      setSearchQuery(typeof parsed.searchQuery === "string" ? parsed.searchQuery : "");
      setDisabledLegendFilters(restoredDisabledLegend);
      setActiveLegendFilter(restoredActiveLegend);

      restoreWorkspaceStateRef.current = true;
      restoredTableIdRef.current = restoredSelectedTableId;
    } catch {
      // ignore malformed persisted state
    }

    setUiRestored(true);
  }, [workspaceUiKey]);

  useEffect(() => {
    const handleDashboardQuickFilter = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      applyDashboardQuickFilter(detail?.filter);
    };
    window.addEventListener(DASHBOARD_QUICK_FILTER_EVENT, handleDashboardQuickFilter);
    return () => {
      window.removeEventListener(DASHBOARD_QUICK_FILTER_EVENT, handleDashboardQuickFilter);
    };
  }, [applyDashboardQuickFilter]);

  useEffect(() => {
    if (!dashboardQuickFilter) {
      dismissedDashboardQuickFilterNonceRef.current = null;
      return;
    }
    // L'effetto rigira anche dopo il ripristino dello stato del workspace, che
    // altrimenti sovrascriverebbe il filtro arrivato dalla dashboard. Una volta
    // che l'utente tocca la legenda pero' la sua scelta deve restare: quel
    // nonce viene marcato come chiuso e non lo si riapplica piu'.
    if (dismissedDashboardQuickFilterNonceRef.current === dashboardQuickFilter.nonce) return;
    applyDashboardQuickFilter(dashboardQuickFilter.filter);
  }, [applyDashboardQuickFilter, dashboardQuickFilter?.filter, dashboardQuickFilter?.nonce]);

  useEffect(() => {
    if (!uiRestored) return;
    const payload: TablesWorkspaceUiSnapshot = {
      selectedTableId,
      setupMode,
      draftName,
      draftPhone,
      draftCovers,
      draftNote,
      hasAllergyAlert,
      selectedAllergens,
      draftManualIntolerance,
      reservationTime,
      searchQuery,
      disabledLegendFilters: dashboardQuickFilterActiveRef.current ? [] : disabledLegendFilters,
      activeLegendFilter: dashboardQuickFilterActiveRef.current ? null : activeLegendFilter,
    };
    try {
      writeSessionPreference(workspaceUiKey, JSON.stringify(payload));
    } catch {
      // ignore storage failures
    }
  }, [
    activeLegendFilter,
    disabledLegendFilters,
    draftCovers,
    draftManualIntolerance,
    draftName,
    draftNote,
    draftPhone,
    hasAllergyAlert,
    reservationTime,
    searchQuery,
    selectedAllergens,
    selectedTableId,
    setupMode,
    uiRestored,
    workspaceUiKey,
  ]);

  useEffect(() => {
    if (legendFilterMode === "single") {
      setDisabledLegendFilters([]);
      return;
    }
    setActiveLegendFilter(null);
  }, [legendFilterMode]);

  useEffect(() => {
    const rooms = roomsQuery.data ?? [];
    if (!token || !effectiveUserId || !effectiveDeviceUuid || rooms.length === 0) return;
    if (!effectiveRoomId) return;

    const currentRoom = rooms.find((room) => room.id === effectiveRoomId);
    if (currentRoom) {
      const nextActivityId = String(currentRoom.activityId ?? "").trim();
      const nextActivityName = String(currentRoom.activityName ?? "").trim();
      if (
        currentRoom.name !== roomName ||
        nextActivityId !== (activityId || "") ||
        nextActivityName !== (activityName || "")
      ) {
        setRoom({
          roomId: currentRoom.id,
          roomName: currentRoom.name,
          activityId: nextActivityId,
          activityName: nextActivityName,
        });
      }
      return;
    }
  }, [
    effectiveDeviceUuid,
    effectiveRoomId,
    effectiveUserId,
    activityId,
    activityName,
    roomName,
    roomsQuery.data,
    setRoom,
    token,
  ]);

  useEffect(() => {
    scrollRestoreRef.current = false;
  }, [scrollKey]);

  useEffect(() => {
    const node = tablesScrollRef.current;
    if (!node) return;
    const handleScroll = () => {
      writeSessionPreference(scrollKey, String(node.scrollTop));
    };
    node.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", handleScroll);
    };
  }, [scrollKey]);

  useEffect(() => {
    if (tablesQuery.isLoading) return;
    const node = tablesScrollRef.current;
    if (!node || scrollRestoreRef.current) return;
    const saved = readSessionPreference(scrollKey);
    if (saved) {
      const value = Number(saved);
      if (Number.isFinite(value)) {
        node.scrollTop = value;
      }
    }
    scrollRestoreRef.current = true;
  }, [scrollKey, sortedTables.length, tablesQuery.isLoading]);

  useEffect(() => {
    setNow(Date.now());
  }, [sortedTables.length]);

  useEffect(() => {
    if (!selectedTableId) {
      selectedTableMissingSinceRef.current = null;
      return;
    }
    if (selectedTable) {
      selectedTableMissingSinceRef.current = null;
      return;
    }
    if (tablesQuery.isFetching || tablesQuery.isLoading) return;

    const missingSince = selectedTableMissingSinceRef.current;
    if (missingSince === null) {
      selectedTableMissingSinceRef.current = Date.now();
      return;
    }
    if (Date.now() - missingSince < 4_000) return;

    closeTableDetail();
    selectedTableMissingSinceRef.current = null;
  }, [
    closeTableDetail,
    selectedTable,
    selectedTableId,
    tablesQuery.isFetching,
    tablesQuery.isLoading,
  ]);

  useEffect(() => {
    if (!selectedTableId) {
      setSelectedTableSnapshot(null);
      return;
    }
    if (selectedTable) {
      setSelectedTableSnapshot(selectedTable);
    }
  }, [selectedTable, selectedTableId]);

  useEffect(() => {
    if (!selectedTableId) {
      restoreWorkspaceStateRef.current = false;
      selectedTableMissingSinceRef.current = null;
      closeTableChildFlows();
    }
  }, [closeTableChildFlows, selectedTableId]);

  useEffect(
    () => () => {
      if (roomTitleLongPressTimerRef.current !== null) {
        window.clearTimeout(roomTitleLongPressTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (!detailTable) {
      prevSelectedTableIdRef.current = null;
      return;
    }

    const isRestoredSelection =
      restoreWorkspaceStateRef.current && restoredTableIdRef.current === detailTable.id;
    const isTableSwitch =
      prevSelectedTableIdRef.current !== null && prevSelectedTableIdRef.current !== detailTable.id;
    if (
      !shouldReseedTableForm({
        isRestoredSelection,
        isTableSwitch,
        hasUnsavedChanges: tableMetaHasChangesRef.current,
      })
    ) {
      if (isRestoredSelection) restoreWorkspaceStateRef.current = false;
      prevSelectedTableIdRef.current = detailTable.id;
      return;
    }

    const isFreeTable = detailTable.occupancyState === "free";
    // Fuori dalla finestra dei trenta minuti il tavolo prenotato si usa come
    // vuoto: niente campi precompilati, altrimenti si scriverebbe per sbaglio
    // sulla prenotazione gia' presa.
    const actsAsFree =
      isFreeTable ||
      (detailTable.occupancyState === "reserved" &&
        !shouldReserveTableForReservation(detailTable.reservationAt ?? 0));
    setSetupMode(
      actsAsFree ? "occupy" : detailTable.occupancyState === "reserved" ? "reserve" : "occupy"
    );
    setDraftName(actsAsFree ? "" : detailTable.tableName);
    setDraftPhone(actsAsFree ? "" : detailTable.customerPhone);
    setDraftCovers(actsAsFree ? "" : String(detailTable.covers));
    setDraftNote(actsAsFree ? "" : detailTable.note);
    setSelectedAllergens(actsAsFree ? [] : detailTable.allergens);
    setDraftManualIntolerance(actsAsFree ? "" : detailTable.manualIntolerance);
    setReservationTime(getDefaultReservationTimeValue(actsAsFree ? null : detailTable));
    if (isTableSwitch) {
      setMovePickerOpen(false);
      setOrderComposerOpen(false);
      setPaymentWizardOpen(false);
    }
    prevSelectedTableIdRef.current = detailTable.id;
  }, [detailTableFormSyncKey]);

  const baseSession = useMemo(
    () => ({
      token: token || "",
      userId: effectiveUserId,
      username: username || undefined,
      fullName: fullName || undefined,
      deviceUuid: effectiveDeviceUuid,
      activityId: effectiveActivityId,
      roomId: effectiveRoomId,
      roomName: roomName || undefined,
    }),
    [
      effectiveActivityId,
      effectiveDeviceUuid,
      effectiveRoomId,
      effectiveUserId,
      fullName,
      roomName,
      token,
      username,
    ]
  );

  const openTableWithConfigurationCheck = useCallback(
    (tableId: string) => {
      const table = sortedTables.find((candidate) => candidate.id === tableId);
      setSelectedTableId(tableId);
      if (table && tableNeedsConfigurationRemovalDecision(table)) {
        setConfigurationRemovalTableId(tableId);
      }
    },
    [sortedTables]
  );

  const keepTableAfterConfigurationRemoval = useCallback(async () => {
    if (!configurationRemovalTable) return;
    setConfigurationRemovalBusy(true);
    try {
      const updated = await keepDiningTableAfterConfigurationRemoval({
        ...baseSession,
        tableId: configurationRemovalTable.id,
      });
      const queryKey = tablesQueryKey(effectiveRoomId, effectiveActivityId);
      queryClient.setQueryData<TablesSnapshot>(queryKey, (current) =>
        upsertSnapshotTable(current, updated)
      );
      setSelectedTableSnapshot(updated);
      setConfigurationRemovalTableId(null);
    } finally {
      setConfigurationRemovalBusy(false);
    }
  }, [baseSession, configurationRemovalTable, effectiveActivityId, effectiveRoomId, queryClient]);

  const moveTableAfterConfigurationRemoval = useCallback(() => {
    if (!configurationRemovalTable) return;
    setSelectedTableId(configurationRemovalTable.id);
    setConfigurationRemovalTableId(null);
    setMovePickerOpen(true);
  }, [configurationRemovalTable]);

  const handleOperationLockConflict = useCallback((detail: TableLockConflictDetail) => {
    setActionError(detail.message);
  }, []);

  const handleOrderComposerLockConflict = useCallback((detail: TableLockConflictDetail) => {
    setActionError(detail.message);
    setOrderComposerOpen(false);
  }, []);

  const handlePaymentLockConflict = useCallback((detail: TableLockConflictDetail) => {
    setActionError(detail.message);
    setPaymentWizardOpen(false);
  }, []);

  const orderComposerLock = useTableLock({
    enabled: active && orderComposerOpen && Boolean(detailTable?.id),
    tableId: selectedActionTableId,
    session: baseSession,
    purpose: ORDER_COMPOSER_LOCK_PURPOSE,
    allowOfflineContinuation: true,
    onConflict: handleOrderComposerLockConflict,
    onError: setActionError,
  });

  const paymentWizardLock = useTableLock({
    enabled: active && paymentWizardOpen && Boolean(detailTable?.id),
    tableId: selectedActionTableId,
    session: baseSession,
    purpose: PAYMENT_SESSION_LOCK_PURPOSE,
    onConflict: handlePaymentLockConflict,
    onError: setActionError,
  });

  const tableLockBusy = orderComposerLock.pending || paymentWizardLock.pending;

  const canShowReservationReleasePrompt = Boolean(
    canLoad &&
    !orderComposerOpen &&
    !paymentWizardOpen &&
    !movePickerOpen &&
    !roomPickerOpen &&
    !tableGroupsDialog &&
    !serviceRecoveryDialog &&
    !moveConfirm &&
    !mergeConfirm &&
    !actionBusy &&
    !tableLockBusy
  );

  const { prompt: reservationReleasePrompt, snoozePrompt: snoozeReservationReleasePrompt } =
    useReservationReleasePrompt({
      enabled: canShowReservationReleasePrompt,
      now,
      roomId: effectiveRoomId,
      tables: sortedTables,
    });

  const runWithTableLocks = useCallback(
    <T,>(
      tableIds: Iterable<string | null | undefined>,
      purpose: TableLockPurpose,
      operation: () => Promise<T>
    ) =>
      withRequiredTableLocks(baseSession, tableIds, purpose, operation, {
        skipIfAlreadyHeld: true,
        onConflict: handleOperationLockConflict,
      }),
    [baseSession, handleOperationLockConflict]
  );

  const runWithOfflineTableLocks = useCallback(
    <T,>(
      tableIds: Iterable<string | null | undefined>,
      purpose: TableLockPurpose,
      operation: () => Promise<T>
    ) =>
      withOfflineContinuationTableLocks(baseSession, tableIds, purpose, operation, {
        skipIfAlreadyHeld: true,
        onConflict: handleOperationLockConflict,
      }),
    [baseSession, handleOperationLockConflict]
  );

  const scheduleCurrentTablesRefresh = useCallback(() => {
    if (tablesMutationRefreshTimerRef.current !== null) {
      window.clearTimeout(tablesMutationRefreshTimerRef.current);
    }
    tablesMutationRefreshTimerRef.current = window.setTimeout(() => {
      tablesMutationRefreshTimerRef.current = null;
      void queryClient.invalidateQueries({
        queryKey: tablesQueryKey(effectiveRoomId, effectiveActivityId),
      });
    }, TABLES_MUTATION_REFRESH_DEBOUNCE_MS);
  }, [effectiveActivityId, effectiveRoomId, queryClient]);

  useEffect(
    () => () => {
      if (tablesMutationRefreshTimerRef.current !== null) {
        window.clearTimeout(tablesMutationRefreshTimerRef.current);
        tablesMutationRefreshTimerRef.current = null;
      }
    },
    []
  );

  const withAction = async (
    fn: () => Promise<unknown>,
    options: { rethrow?: boolean; skipRefresh?: boolean } = {}
  ) => {
    setActionError(null);
    setActionBusy(true);
    try {
      const result = await fn();
      const queryKey = tablesQueryKey(effectiveRoomId, effectiveActivityId);
      if (isRemovedDiningTableResult(result)) {
        queryClient.setQueryData<TablesSnapshot>(queryKey, (current) =>
          removeSnapshotTable(current, result.removedTableId)
        );
      } else if (isDiningTableValue(result)) {
        queryClient.setQueryData<TablesSnapshot>(queryKey, (current) =>
          upsertSnapshotTable(current, result)
        );
      } else if (isTableMoveResult(result)) {
        queryClient.setQueryData<TablesSnapshot>(queryKey, (current) =>
          applyResolvedTableMoveToSnapshot(current, result)
        );
      }
      if (!options.skipRefresh) {
        scheduleCurrentTablesRefresh();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Operazione non riuscita.";
      setActionError(message);
      if (options.rethrow) {
        throw new Error(message);
      }
    } finally {
      setActionBusy(false);
    }
  };

  const runOnSelected = async (
    action: (
      tableId: string,
      logicalContext: typeof selectedLogicalTableContext
    ) => Promise<unknown>,
    options: {
      clearSelection?: boolean;
      lockPurpose?: TableLockPurpose;
      offlineContinuation?: boolean;
      rethrow?: boolean;
    } = {}
  ) => {
    if (!selectedTableId || !selectedActionTableId) {
      if (options.rethrow) {
        throw new Error("Nessun tavolo selezionato.");
      }
      return;
    }
    const tableId = selectedActionTableId;
    const logicalContext = selectedLogicalTableContext;
    await withAction(
      async () => {
        const execute = () => action(tableId, logicalContext);
        let result: unknown;
        if (options.lockPurpose) {
          result = await (options.offlineContinuation
            ? runWithOfflineTableLocks([tableId], options.lockPurpose, execute)
            : runWithTableLocks([tableId], options.lockPurpose, execute));
        } else {
          result = await execute();
        }
        if (options.clearSelection) {
          closeTableDetail();
        }
        return result;
      },
      { rethrow: options.rethrow }
    );
  };

  const runOnSelectedOptimisticTableAction = (
    action: (
      tableId: string,
      logicalContext: typeof selectedLogicalTableContext
    ) => Promise<unknown>,
    options: {
      clearSelection?: boolean;
      lockPurpose?: TableLockPurpose;
      offlineContinuation?: boolean;
      applyOptimistic: (
        snapshot: TablesSnapshot | undefined,
        tableId: string,
        logicalContext: typeof selectedLogicalTableContext
      ) => { snapshot: TablesSnapshot | undefined; table: DiningTable | null };
    }
  ) => {
    if (!optimisticActionsEnabled) {
      void runOnSelected(action, {
        clearSelection: options.clearSelection,
        lockPurpose: options.lockPurpose,
        offlineContinuation: options.offlineContinuation,
      });
      return;
    }
    if (!selectedTableId || !selectedActionTableId) return;

    const tableId = selectedActionTableId;
    const logicalContext = selectedLogicalTableContext;
    const queryKey = tablesQueryKey(effectiveRoomId, effectiveActivityId);
    const previousSelectedTableId = selectedTableId;
    const previousSelectedTableSnapshot = selectedTableSnapshot;
    let previousSnapshot: TablesSnapshot | undefined;
    let optimisticTable: DiningTable | null = null;

    setActionError(null);
    setActionBusy(true);
    queryClient.setQueryData<TablesSnapshot>(queryKey, (current) => {
      previousSnapshot = current;
      const next = options.applyOptimistic(current, tableId, logicalContext);
      optimisticTable = next.table;
      return next.snapshot;
    });

    if (options.clearSelection) {
      closeTableDetail();
    } else if (optimisticTable) {
      setSelectedTableSnapshot(optimisticTable);
    }

    runBackgroundOptimisticRequest(
      async () => {
        const execute = () => action(tableId, logicalContext);
        if (options.lockPurpose) {
          return options.offlineContinuation
            ? runWithOfflineTableLocks([tableId], options.lockPurpose, execute)
            : runWithTableLocks([tableId], options.lockPurpose, execute);
        }
        return execute();
      },
      {
        onSuccess: (result) => {
          if (isRemovedDiningTableResult(result)) {
            queryClient.setQueryData<TablesSnapshot>(queryKey, (current) =>
              removeSnapshotTable(current, result.removedTableId)
            );
            if (!options.clearSelection) setSelectedTableSnapshot(null);
          } else if (isDiningTableValue(result)) {
            queryClient.setQueryData<TablesSnapshot>(queryKey, (current) =>
              upsertSnapshotTable(current, result)
            );
            if (!options.clearSelection) setSelectedTableSnapshot(result);
          } else if (isTableMoveResult(result)) {
            queryClient.setQueryData<TablesSnapshot>(queryKey, (current) =>
              applyResolvedTableMoveToSnapshot(current, result)
            );
          }
          scheduleCurrentTablesRefresh();
        },
        onError: (error) => {
          const message = error instanceof Error ? error.message : "Operazione non riuscita.";
          if (previousSnapshot !== undefined) {
            queryClient.setQueryData(queryKey, previousSnapshot);
          }
          setSelectedTableId(previousSelectedTableId);
          setSelectedTableSnapshot(previousSelectedTableSnapshot);
          setActionError(message);
        },
        onSettled: () => {
          setActionBusy(false);
        },
      }
    );
  };

  const runOnSelectedOptimisticOrderAction = (
    payload: TableOrderSubmitPayload,
    action: (
      tableId: string,
      logicalContext: typeof selectedLogicalTableContext
    ) => Promise<unknown>
  ): Promise<void> => {
    if (!optimisticActionsEnabled) {
      return runOnSelected(action, {
        lockPurpose: ORDER_CREATE_LOCK_PURPOSE,
        offlineContinuation: true,
        rethrow: true,
      });
    }
    if (!selectedTableId || !selectedActionTableId) {
      return Promise.reject(new Error("Nessun tavolo selezionato."));
    }

    const tableId = selectedActionTableId;
    const logicalContext = selectedLogicalTableContext;
    const queryKey = tablesQueryKey(effectiveRoomId, effectiveActivityId);
    const previousSnapshot = queryClient.getQueryData<TablesSnapshot>(queryKey);
    const optimisticPatch = applyOptimisticOrderPendingToSnapshot(
      previousSnapshot,
      tableId,
      payload
    );
    if (!optimisticPatch.table) {
      return runOnSelected(action, {
        lockPurpose: ORDER_CREATE_LOCK_PURPOSE,
        offlineContinuation: true,
        rethrow: true,
      });
    }
    const previousSelectedTableId = selectedTableId;
    const previousSelectedTableSnapshot = selectedTableSnapshot;

    setActionError(null);
    setActionBusy(true);
    queryClient.setQueryData(queryKey, optimisticPatch.snapshot);
    setSelectedTableSnapshot(optimisticPatch.table);

    runBackgroundOptimisticRequest(
      async () =>
        runWithOfflineTableLocks([tableId], ORDER_CREATE_LOCK_PURPOSE, () =>
          action(tableId, logicalContext)
        ),
      {
        onSuccess: (result) => {
          if (isDiningTableValue(result)) {
            queryClient.setQueryData<TablesSnapshot>(queryKey, (current) =>
              upsertSnapshotTable(current, result)
            );
            setSelectedTableSnapshot(result);
          }
          scheduleCurrentTablesRefresh();
        },
        onError: (error) => {
          const message = error instanceof Error ? error.message : "Invio comanda non riuscito.";
          if (previousSnapshot !== undefined) {
            queryClient.setQueryData(queryKey, previousSnapshot);
          }
          setSelectedTableId(previousSelectedTableId);
          setSelectedTableSnapshot(previousSelectedTableSnapshot);
          setActionError(message);
        },
        onSettled: () => {
          setActionBusy(false);
        },
      }
    );

    return Promise.resolve();
  };

  const freeReservationReleasePromptTable = async () => {
    const prompt = reservationReleasePrompt;
    if (!prompt) return;
    snoozeReservationReleasePrompt();
    await withAction(async () => {
      const result = await runWithOfflineTableLocks(
        [prompt.actionTableId],
        TABLE_LAYOUT_SYNC_LOCK_PURPOSE,
        () =>
          freeDiningTable({
            ...baseSession,
            ...prompt.logicalContext,
            tableId: prompt.actionTableId,
          })
      );
      if (selectedTableId === prompt.tableId || selectedTableId === prompt.actionTableId) {
        closeTableDetail();
      }
      return result;
    });
    setNow(Date.now());
  };

  const buildSameRoomMovePlan = (request: TableMoveConfirmRequest) => {
    const sourceIds = resolveActionTableIds(request.fromTableId);
    const targetIds = [
      ...new Set(request.toTableIds.map((id) => String(id ?? "").trim()).filter(Boolean)),
    ];
    if (targetIds.length === 0) {
      throw new Error("Seleziona almeno un tavolo destinazione.");
    }
    if (targetIds.length > sourceIds.length) {
      throw new Error("Seleziona un numero di tavoli pari o inferiore al tavolo unito.");
    }
    const tablesById = new Map(rawTables.map((table) => [table.id, table]));
    const activeSourceIds = sourceIds.filter((id) => tableStatus(tablesById.get(id)) !== "libero");
    const moveSourceIds = activeSourceIds.length > 0 ? activeSourceIds : [request.fromTableId];
    if (moveSourceIds.length > targetIds.length) {
      throw new Error(
        `Seleziona almeno ${moveSourceIds.length} tavoli destinazione per spostare tutti i tavoli attivi.`
      );
    }
    const movePairs = moveSourceIds.map((sourceId, index) => ({
      sourceId,
      targetId: targetIds[index],
    }));
    return {
      sourceIds,
      targetIds,
      movePairs,
      nextGroups: buildRoomMoveTableGroups(sourceIds, targetIds),
    };
  };

  const confirmMoveTable = async () => {
    if (!moveConfirm) return;
    if (optimisticActionsEnabled) {
      let plan: ReturnType<typeof buildSameRoomMovePlan>;
      try {
        plan = buildSameRoomMovePlan(moveConfirm);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "Spostamento tavolo non riuscito.");
        return;
      }
      const queryKey = tablesQueryKey(effectiveRoomId, effectiveActivityId);
      const previousMoveConfirm = moveConfirm;
      const previousMovePickerOpen = movePickerOpen;
      const previousSelectedTableId = selectedTableId;
      const previousSelectedTableSnapshot = selectedTableSnapshot;
      let previousSnapshot: TablesSnapshot | undefined;
      setActionError(null);
      setActionBusy(true);
      queryClient.setQueryData<TablesSnapshot>(queryKey, (current) => {
        previousSnapshot = current;
        const moved = applyOptimisticMoveTablesToSnapshot(current, plan.movePairs);
        return moved.snapshot
          ? {
              ...moved.snapshot,
              tableGroups: plan.nextGroups,
            }
          : moved.snapshot;
      });
      setSelectedTableId(plan.targetIds[0] ?? null);
      setMovePickerOpen(false);
      setMoveConfirm(null);

      runBackgroundOptimisticRequest(
        async () => {
          const movedTables: DiningTableMoveResult[] = [];
          await runWithTableLocks(
            resolveTableMoveLockIds(rawTables, plan.sourceIds, plan.targetIds),
            TABLE_LAYOUT_MOVE_LOCK_PURPOSE,
            async () => {
              for (const pair of plan.movePairs) {
                const moved = await moveDiningTable({
                  ...baseSession,
                  fromTableId: pair.sourceId,
                  toTableId: pair.targetId,
                });
                movedTables.push(moved);
              }
            }
          );
          if (JSON.stringify(plan.nextGroups) !== JSON.stringify(tableGroups)) {
            await saveTableGroups(baseSession, plan.nextGroups, {
              operation: plan.targetIds.length > 1 ? "merge" : "move",
            });
          }
          return movedTables;
        },
        {
          onSuccess: (movedTables) => {
            movedTables.forEach((moved) => {
              queryClient.setQueryData<TablesSnapshot>(queryKey, (current) =>
                applyResolvedTableMoveToSnapshot(current, moved)
              );
            });
            queryClient.setQueryData<TablesSnapshot>(queryKey, (current) =>
              current ? { ...current, tableGroups: plan.nextGroups } : current
            );
            scheduleCurrentTablesRefresh();
          },
          onError: (error) => {
            if (previousSnapshot !== undefined) {
              queryClient.setQueryData(queryKey, previousSnapshot);
            }
            setSelectedTableId(previousSelectedTableId);
            setSelectedTableSnapshot(previousSelectedTableSnapshot);
            setMovePickerOpen(previousMovePickerOpen);
            setMoveConfirm(previousMoveConfirm);
            setActionError(
              error instanceof Error ? error.message : "Spostamento tavolo non riuscito."
            );
          },
          onSettled: () => setActionBusy(false),
        }
      );
      return;
    }

    await withAction(async () => {
      const { sourceIds, targetIds, movePairs, nextGroups } = buildSameRoomMovePlan(moveConfirm);
      const movedTables: DiningTableMoveResult[] = [];
      await runWithTableLocks(
        resolveTableMoveLockIds(rawTables, sourceIds, targetIds),
        TABLE_LAYOUT_MOVE_LOCK_PURPOSE,
        async () => {
          for (const pair of movePairs) {
            const moved = await moveDiningTable({
              ...baseSession,
              fromTableId: pair.sourceId,
              toTableId: pair.targetId,
            });
            movedTables.push(moved);
          }
        }
      );
      if (JSON.stringify(nextGroups) !== JSON.stringify(tableGroups)) {
        await saveTableGroups(baseSession, nextGroups, {
          operation: targetIds.length > 1 ? "merge" : "move",
        });
      }
      const queryKey = tablesQueryKey(effectiveRoomId, effectiveActivityId);
      movedTables.forEach((moved) => {
        queryClient.setQueryData<TablesSnapshot>(queryKey, (current) =>
          applyResolvedTableMoveToSnapshot(current, moved)
        );
      });
      setSelectedTableId(targetIds[0] ?? null);
      setMovePickerOpen(false);
      setMoveConfirm(null);
      return movedTables.at(-1)?.movedTo;
    });
  };

  const openTableGroupsContext = (tableId: string) => {
    setTableGroupsError(null);
    setTableRoomMoveSnapshot(null);
    setTableGroupsDialog({ type: "context", tableId });
  };

  const saveNextTableGroups = async (
    nextGroups: typeof tableGroups,
    options: { operation?: "merge" | "split" | "move" } = {}
  ) => {
    await saveTableGroups(baseSession, nextGroups, options);
    scheduleCurrentTablesRefresh();
  };

  const performTableGroupsMerge = async (
    rootId: string,
    selectedIds: string[],
    options: { allowMultipleActive?: boolean } = {}
  ) => {
    setTableGroupsError(null);
    setActionBusy(true);
    try {
      const nextGroups = buildMergedTableGroups(
        tableGroups,
        rootId,
        selectedIds,
        rawTables,
        options
      );
      await saveNextTableGroups(nextGroups, { operation: "merge" });
      setTableGroupsDialog(null);
      setMergeConfirm(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unione tavoli non riuscita.";
      setTableGroupsError(message);
    } finally {
      setActionBusy(false);
    }
  };

  // Quando una prenotazione multipla entra nella finestra e tutti i suoi tavoli
  // sono liberi, l'unione si forma da sola. Un riferimento evita di ritentare la
  // stessa unione; l'altro tiene la fusione aggiornata senza entrare fra le
  // dipendenze, che cambierebbero a ogni render.
  const autoUnionRef = useRef<string | null>(null);
  const mergeTablesRef = useRef(performTableGroupsMerge);
  useEffect(() => {
    mergeTablesRef.current = performTableGroupsMerge;
  });
  useEffect(() => {
    if (actionBusy) return;
    const now = Date.now();
    const candidato = (dayReservationsQuery.data?.reservations ?? [])
      .filter(
        (reservation) =>
          reservation.status === "booked" &&
          reservation.assignedTableIds.length > 1 &&
          shouldReserveTableForReservation(reservation.reservationAt, now)
      )
      .map((reservation) => ({
        reservation,
        readiness: evaluateUnionReadiness(rawTables, reservation.assignedTableIds, tableGroups),
      }))
      .find((entry) => entry.readiness.ready);
    if (!candidato) {
      autoUnionRef.current = null;
      return;
    }
    if (autoUnionRef.current === candidato.reservation.id) return;
    autoUnionRef.current = candidato.reservation.id;
    const [radice, ...altri] = candidato.reservation.assignedTableIds;
    void mergeTablesRef.current(radice, altri);
  }, [actionBusy, dayReservationsQuery.data, rawTables, tableGroups]);

  // Prima di accomodare: i tavoli della prenotazione devono essere tutti liberi.
  const reservationSeatGuard = useCallback(
    (reservation: { assignedTableIds: string[] }) =>
      seatGuardFor(evaluateUnionReadiness(rawTables, reservation.assignedTableIds, tableGroups)),
    [rawTables, tableGroups]
  );

  const freeTablesForReservation = useCallback(
    async (tableIds: string[]) => {
      for (const tableId of tableIds) {
        await freeDiningTable({ ...baseSession, tableId });
      }
      await queryClient.invalidateQueries({
        queryKey: tablesQueryKey(effectiveRoomId, effectiveActivityId),
      });
    },
    [baseSession, queryClient, effectiveRoomId, effectiveActivityId]
  );

  const confirmTableGroupsMerge = (
    rootId: string,
    selectedIds: string[],
    options: { requiresActiveConfirmation?: boolean } = {}
  ) => {
    if (options.requiresActiveConfirmation) {
      setMergeConfirm({
        rootId,
        selectedIds,
        sourceLabel: formatMoveTableLabel(rawTables, rootId, "Tavolo principale"),
        targetLabels: selectedIds.map((id) =>
          formatMoveTableLabel(rawTables, id, "Tavolo selezionato")
        ),
      });
      setTableGroupsDialog(null);
      return;
    }
    void performTableGroupsMerge(rootId, selectedIds);
  };

  const confirmTableGroupsSplit = async (rootId: string, selectedKeys: Set<string>) => {
    setTableGroupsError(null);
    setActionBusy(true);
    try {
      const nextGroups = buildSplitTableGroups(tableGroups, rootId, selectedKeys);
      await saveNextTableGroups(nextGroups, { operation: "split" });
      setTableGroupsDialog(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Divisione tavolo non riuscita.";
      setTableGroupsError(message);
    } finally {
      setActionBusy(false);
    }
  };

  const startContextMove = (fromTableId: string, toTableIds: string[]) => {
    setMoveConfirm({
      fromTableId,
      toTableIds,
      sourceLabel: formatMoveTableLabel(rawTables, fromTableId, "Tavolo sorgente"),
      targetLabels: toTableIds.map((toTableId) =>
        formatMoveTableLabel(rawTables, toTableId, "Tavolo destinazione")
      ),
    });
    setTableGroupsDialog(null);
  };

  const resolveActionTableIds = (tableId: string) => {
    const node = tableGroupLogicalNodeForId(tableGroups, tableId);
    const ids = node ? flattenTableGroupNodeIds(node) : [tableId];
    return [...new Set(ids.length > 0 ? ids : [tableId])];
  };

  const waitForTableRoomMoveApproval = async (requestId: string, targetRoomLabel: string) => {
    const deadline =
      Date.now() + TABLE_ROOM_MOVE_APPROVAL_TIMEOUT_MS + TABLE_ROOM_MOVE_STATUS_POLL_MS * 3;
    while (Date.now() <= deadline) {
      await sleep(TABLE_ROOM_MOVE_STATUS_POLL_MS);
      const status = await fetchIntegrationTableRoomMoveStatus({
        ...baseSession,
        requestId,
      });
      if (status.networkError) continue;
      if (!status.ok) {
        throw new Error(status.message || "Richiesta cambio sala non disponibile.");
      }
      if (status.approvalStatus === "rejected") {
        throw new Error(`Cambio sala rifiutato da ${targetRoomLabel}.`);
      }
      if (status.approvalStatus === "approved" || status.approvalStatus === "timeout_approved") {
        return;
      }
    }
    throw new Error("Richiesta cambio sala ancora in attesa.");
  };

  const buildRoomMoveTableGroups = (sourceIds: string[], targetIds: string[]) => {
    const affectedIds = new Set([...sourceIds, ...targetIds]);
    const nextGroups = tableGroups.filter((group) =>
      flattenTableGroupNodeIds(group).every((id) => !affectedIds.has(id))
    );
    if (targetIds.length > 1) {
      nextGroups.push({
        id: targetIds[0],
        type: "complex",
        children: targetIds.map((id) => ({ id, type: "simple" })),
        updatedAt: new Date().toISOString(),
      });
    }
    return nextGroups;
  };

  const chooseTableRoomMoveRoom = async (tableId: string, room: Room) => {
    const targetRoomId = String(room.id ?? "").trim();
    if (!targetRoomId || targetRoomId === effectiveRoomId) return;
    setTableGroupsError(null);
    setTableRoomMoveSnapshot({
      roomId: targetRoomId,
      roomName: room.name || targetRoomId,
      tables: [],
      groups: [],
    });
    setTableGroupsDialog({ type: "roomMoveTable", tableId, targetRoomId });
    setActionBusy(true);
    try {
      const snapshot = await fetchTablesForSession({
        ...baseSession,
        roomId: targetRoomId,
        activityId: room.activityId ?? effectiveActivityId,
      });
      setTableRoomMoveSnapshot({
        roomId: targetRoomId,
        roomName: room.name || targetRoomId,
        tables: snapshot.rawTables ?? snapshot.tables,
        groups: snapshot.tableGroups ?? [],
      });
    } catch (error) {
      setTableGroupsError(
        error instanceof Error ? error.message : "Impossibile caricare i tavoli della sala."
      );
    } finally {
      setActionBusy(false);
    }
  };

  const confirmTableRoomMove = async (
    fromTableId: string,
    targetRoomId: string,
    targetTableIds: string[]
  ) => {
    let optimisticRollback: {
      sourceQueryKey: ReturnType<typeof tablesQueryKey>;
      targetQueryKey: ReturnType<typeof tablesQueryKey>;
      previousSourceSnapshot: TablesSnapshot | undefined;
      previousTargetSnapshot: TablesSnapshot | undefined;
      previousSelectedTableId: string | null;
      previousSelectedTableSnapshot: DiningTable | null;
      previousDialog: TableGroupsDialogState | null;
      previousRoomMoveSnapshot: typeof tableRoomMoveSnapshot;
      hadTargetSnapshot: boolean;
    } | null = null;
    setTableGroupsError(null);
    setActionBusy(true);
    try {
      const sourceIds = resolveActionTableIds(fromTableId);
      const uniqueTargetTableIds = [
        ...new Set(targetTableIds.map((id) => String(id ?? "").trim()).filter(Boolean)),
      ];
      if (uniqueTargetTableIds.length === 0) {
        throw new Error("Seleziona almeno un tavolo destinazione.");
      }
      if (uniqueTargetTableIds.length > sourceIds.length) {
        throw new Error("Seleziona un numero di tavoli pari o inferiore al tavolo unito.");
      }
      const targetSnapshot =
        tableRoomMoveSnapshot?.roomId === targetRoomId ? tableRoomMoveSnapshot : null;
      const targetTables = targetSnapshot?.tables ?? [];
      const targetTablesById = new Map(targetTables.map((table) => [table.id, table]));
      const missingTarget = uniqueTargetTableIds.find((id) => !targetTablesById.has(id));
      if (missingTarget) {
        throw new Error("Tavolo destinazione non trovato.");
      }
      const sourceTablesById = new Map(rawTables.map((table) => [table.id, table]));
      const activeSourceIds = sourceIds.filter(
        (id) => tableStatus(sourceTablesById.get(id)) !== "libero"
      );
      const moveSourceIds = activeSourceIds.length > 0 ? activeSourceIds : [fromTableId];
      if (moveSourceIds.length > uniqueTargetTableIds.length) {
        throw new Error(
          `Seleziona almeno ${moveSourceIds.length} tavoli destinazione per spostare tutti i tavoli attivi.`
        );
      }
      const targetRoomLabel = targetSnapshot?.roomName || "la sala destinazione";
      const request = await sendIntegrationTableRoomMoveRequest({
        ...baseSession,
        fromRoomName: roomName || effectiveRoomId,
        targetRoomId,
        fromTableId,
        fromTableLabel: formatMoveTableLabel(rawTables, fromTableId, "Tavolo sorgente"),
        targetTableIds: uniqueTargetTableIds,
        targetTableLabels: uniqueTargetTableIds.map((id) =>
          formatMoveTableLabel(targetTables, id, "Tavolo destinazione")
        ),
        sourceLeafCount: sourceIds.length,
        targetTableCount: uniqueTargetTableIds.length,
      });
      if (!request.ok) {
        if (request.networkError) {
          throw new Error("Backend non raggiungibile: cambio sala non inviato.");
        }
        throw new Error(request.message || "Cambio sala tavolo non riuscito.");
      }
      if (request.approvalStatus === "pending") {
        setTableGroupsError(`Richiesta inviata per ${targetRoomLabel}. Attendi autorizzazione.`);
        if (!request.requestId) {
          throw new Error("Richiesta cambio sala senza identificativo.");
        }
        await waitForTableRoomMoveApproval(request.requestId, targetRoomLabel);
      }
      const movePairs = moveSourceIds.map((sourceId, index) => ({
        sourceId,
        targetId: uniqueTargetTableIds[index],
      }));
      const nextGroups = buildRoomMoveTableGroups(sourceIds, uniqueTargetTableIds);
      const targetActivityId =
        roomsQuery.data?.find((room) => room.id === targetRoomId)?.activityId ??
        effectiveActivityId;
      const sourceQueryKey = tablesQueryKey(effectiveRoomId, effectiveActivityId);
      const targetQueryKey = tablesQueryKey(targetRoomId, targetActivityId);
      if (optimisticActionsEnabled) {
        const previousSourceSnapshot = queryClient.getQueryData<TablesSnapshot>(sourceQueryKey);
        const previousTargetSnapshot = queryClient.getQueryData<TablesSnapshot>(targetQueryKey);
        const fallbackTargetSnapshot =
          previousTargetSnapshot ??
          (targetSnapshot
            ? {
                version: 0,
                tables: targetSnapshot.tables,
                rawTables: targetSnapshot.tables,
                tableGroups: targetSnapshot.groups,
              }
            : undefined);
        const optimisticMove = applyOptimisticMoveTablesBetweenSnapshots(
          previousSourceSnapshot ?? tablesQuery.data,
          fallbackTargetSnapshot,
          movePairs
        );
        if (optimisticMove.moves.length > 0) {
          optimisticRollback = {
            sourceQueryKey,
            targetQueryKey,
            previousSourceSnapshot,
            previousTargetSnapshot,
            previousSelectedTableId: selectedTableId,
            previousSelectedTableSnapshot: selectedTableSnapshot,
            previousDialog: tableGroupsDialog,
            previousRoomMoveSnapshot: tableRoomMoveSnapshot,
            hadTargetSnapshot: previousTargetSnapshot !== undefined,
          };
          queryClient.setQueryData<TablesSnapshot>(
            sourceQueryKey,
            optimisticMove.sourceSnapshot
              ? { ...optimisticMove.sourceSnapshot, tableGroups: nextGroups }
              : optimisticMove.sourceSnapshot
          );
          queryClient.setQueryData<TablesSnapshot>(targetQueryKey, optimisticMove.targetSnapshot);
          setSelectedTableId(null);
          setSelectedTableSnapshot(null);
          setTableGroupsDialog(null);
          setTableRoomMoveSnapshot(null);
        }
      }
      const movedTables: DiningTableMoveResult[] = [];
      await runWithTableLocks(
        resolveTableMoveLockIds(rawTables, sourceIds, uniqueTargetTableIds),
        TABLE_LAYOUT_MOVE_LOCK_PURPOSE,
        async () => {
          for (const pair of movePairs) {
            const moved = await moveDiningTable({
              ...baseSession,
              fromTableId: pair.sourceId,
              toTableId: pair.targetId,
              targetRoomId,
            });
            movedTables.push(moved);
          }
        }
      );
      if (JSON.stringify(nextGroups) !== JSON.stringify(tableGroups)) {
        await saveTableGroups(baseSession, nextGroups, {
          operation: uniqueTargetTableIds.length > 1 ? "merge" : "move",
        });
      }
      movedTables.forEach((moved) => {
        queryClient.setQueryData<TablesSnapshot>(sourceQueryKey, (current) =>
          moved.removedSourceTableId
            ? removeSnapshotTable(current, moved.removedSourceTableId)
            : upsertSnapshotTable(current, moved.movedFrom)
        );
        queryClient.setQueryData<TablesSnapshot>(targetQueryKey, (current) =>
          upsertSnapshotTable(current, moved.movedTo)
        );
      });
      setSelectedTableId(null);
      setSelectedTableSnapshot(null);
      setTableGroupsDialog(null);
      setTableRoomMoveSnapshot(null);
      void Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: sourceQueryKey }),
        queryClient.invalidateQueries({ queryKey: targetQueryKey }),
        queryClient.invalidateQueries({ queryKey: ["available-rooms"] }),
      ]);
    } catch (error) {
      if (optimisticRollback) {
        queryClient.setQueryData(
          optimisticRollback.sourceQueryKey,
          optimisticRollback.previousSourceSnapshot
        );
        if (optimisticRollback.hadTargetSnapshot) {
          queryClient.setQueryData(
            optimisticRollback.targetQueryKey,
            optimisticRollback.previousTargetSnapshot
          );
        } else {
          queryClient.removeQueries({
            queryKey: optimisticRollback.targetQueryKey,
            exact: true,
          });
        }
        setSelectedTableId(optimisticRollback.previousSelectedTableId);
        setSelectedTableSnapshot(optimisticRollback.previousSelectedTableSnapshot);
        setTableGroupsDialog(optimisticRollback.previousDialog);
        setTableRoomMoveSnapshot(optimisticRollback.previousRoomMoveSnapshot);
      }
      setTableGroupsError(
        error instanceof Error ? error.message : "Spostamento in altra sala non riuscito."
      );
    } finally {
      setActionBusy(false);
    }
  };

  const confirmAdminTableCancellation = async (tableId: string, reason: string) => {
    setTableGroupsError(null);
    setActionBusy(true);
    try {
      const targetTableIds = resolveActionTableIds(tableId);
      const targetTables = rawTables.filter((table) => targetTableIds.includes(table.id));
      const rootTable = rawTables.find((table) => table.id === tableId) ?? targetTables[0] ?? null;
      if (!rootTable) throw new Error("Tavolo non trovato.");
      const orderIds = [
        ...new Set(
          targetTables
            .flatMap((table) => table.orderHistory)
            .filter((order) => order.state !== "paid")
            .map((order) => order.id)
            .filter(Boolean)
        ),
      ];
      const result = await adminCancelDiningTable({
        ...baseSession,
        table: rootTable,
        reason,
        targetTableIds,
        orderIds,
        roomName: roomName || undefined,
      });
      void Promise.allSettled([
        queryClient.invalidateQueries({
          queryKey: tablesQueryKey(effectiveRoomId, effectiveActivityId),
        }),
        queryClient.invalidateQueries({ queryKey: ["available-rooms"] }),
      ]);
      if (selectedTableId && targetTableIds.includes(selectedTableId)) {
        closeTableDetail();
      }
      setTableGroupsDialog(null);
      if (result.printWarning) {
        setServiceRecoveryNotice(result.printWarning);
      } else {
        setServiceRecoveryNotice("Tavolo cancellato correttamente.");
      }
    } catch (error) {
      setTableGroupsError(
        error instanceof Error ? error.message : "Cancellazione tavolo non riuscita."
      );
    } finally {
      setActionBusy(false);
    }
  };

  const hasServiceRecoveryAvailableLines = (order: DiningTableOrder) =>
    order.lines.some((line) => {
      const available = line.serviceRecoveryAvailableQuantity;
      if (typeof available === "number" && Number.isFinite(available)) {
        return Math.trunc(available) > 0;
      }
      return Math.trunc(Number(line.qty) || 0) > 0;
    });

  const openServiceRecoveryDialog = (order: DiningTableOrder, action: ServiceRecoveryAction) => {
    if (!detailTable) return;
    if (action === "replacement" && !hasServiceRecoveryAvailableLines(order)) {
      setServiceRecoveryDialog(null);
      setServiceRecoveryNotice("Nessun articolo stornabile per questa comanda.");
      return;
    }
    setActionError(null);
    setServiceRecoveryNotice(null);
    setServiceRecoveryDialog({ order, action });
  };

  const openServiceRecoveryDialogByOrderId = useCallback(
    (
      orderId: string,
      action: ServiceRecoveryAction,
      sourceTables: DiningTable[] = sortedTables
    ) => {
      const normalizedOrderId = String(orderId ?? "")
        .replace(/^#/, "")
        .trim();
      if (!normalizedOrderId) return false;
      const candidates = sourceTables.flatMap((table) =>
        table.orderHistory.map((order) => ({ table, order }))
      );
      const found =
        candidates.find(({ order }) => String(order.id ?? "").trim() === normalizedOrderId) ??
        candidates.find(({ order }) => {
          const currentId = String(order.id ?? "").trim();
          return currentId.replace(/^0+/, "") === normalizedOrderId.replace(/^0+/, "");
        });
      if (!found) {
        if (action === "replacement") {
          setServiceRecoveryDialog(null);
          setServiceRecoveryNotice("Nessun articolo stornabile per questa comanda.");
          return true;
        }
        return false;
      }
      if (action === "replacement" && !hasServiceRecoveryAvailableLines(found.order)) {
        setServiceRecoveryDialog(null);
        setServiceRecoveryNotice("Nessun articolo stornabile per questa comanda.");
        return true;
      }
      setSelectedTableId(found.table.id);
      setSelectedTableSnapshot(found.table);
      setServiceRecoveryNotice(null);
      setServiceRecoveryDialog({ order: found.order, action });
      return true;
    },
    [sortedTables]
  );

  useEffect(() => {
    const target = window as typeof window & {
      __mobileOrderServiceRecoveryOpenResoBar?: (orderId: string) => Promise<boolean>;
    };
    target.__mobileOrderServiceRecoveryOpenResoBar = async (orderId: string) => {
      const refreshed = await tablesQuery.refetch();
      const nextTables = [...(refreshed.data?.tables ?? sortedTables)].sort((left, right) => {
        if (left.number !== right.number) return left.number - right.number;
        return left.id.localeCompare(right.id, "it");
      });
      return openServiceRecoveryDialogByOrderId(orderId, "replacement", nextTables);
    };
    return () => {
      if (target.__mobileOrderServiceRecoveryOpenResoBar) {
        delete target.__mobileOrderServiceRecoveryOpenResoBar;
      }
    };
  }, [openServiceRecoveryDialogByOrderId]);

  const handleServiceRecoveryDone = async (result?: {
    action?: ServiceRecoveryAction;
    sendReplacement?: boolean;
  }) => {
    const refreshed = await tablesQuery.refetch();
    const nextSelectedTable =
      selectedTableId && refreshed.data?.tables
        ? (refreshed.data.tables.find((table) => table.id === selectedTableId) ?? null)
        : null;
    if (nextSelectedTable) {
      setSelectedTableSnapshot(nextSelectedTable);
    }
    if (result?.action === "replacement" && result.sendReplacement === false && nextSelectedTable) {
      const printUpdatedPreconto = () =>
        printTablePreconto(
          {
            token,
            userId: effectiveUserId,
            username,
            fullName,
            deviceUuid: effectiveDeviceUuid,
          },
          {
            activityId: effectiveActivityId,
            roomId: effectiveRoomId,
            tableId: nextSelectedTable.mobileActiveTableId || nextSelectedTable.id,
            tableNumber: nextSelectedTable.number,
            tableLabel:
              nextSelectedTable.mobileComplexLabel ||
              nextSelectedTable.tableLabel ||
              `Tavolo ${nextSelectedTable.number}`,
            amountDue: nextSelectedTable.amountDue,
            orders: nextSelectedTable.orderHistory.map((order) => ({
              id: order.id,
              title: order.title,
              total: order.total,
              createdAt: order.createdAt,
            })),
            mode: "current",
          }
        );
      if (optimisticActionsEnabled) {
        runBackgroundOptimisticRequest(printUpdatedPreconto, {
          onError: (error) => {
            const message =
              error instanceof Error
                ? error.message
                : "Preconto aggiornato non stampato dopo il reso.";
            setServiceRecoveryNotice(`Reso registrato. ${message}`);
          },
        });
        return;
      }
      try {
        await printUpdatedPreconto();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Preconto aggiornato non stampato dopo il reso.";
        setServiceRecoveryNotice(`Reso registrato. ${message}`);
      }
    }
  };

  const composeNoteWithAllergy = (note: string) => {
    const trimmed = note.trim();
    if (!hasAllergyAlert) return trimmed;
    if (trimmed.includes(TABLE_ALLERGY_NOTE)) return trimmed;
    return trimmed ? `${TABLE_ALLERGY_NOTE}\n${trimmed}` : TABLE_ALLERGY_NOTE;
  };

  const getPayloadBase = () => ({
    tableName: draftName.trim().slice(0, 16),
    customerPhone: draftPhone.trim().slice(0, 24),
    covers: normalizeTableCovers(draftCovers, { fallback: detailTable?.covers ?? 2 }),
    note: composeNoteWithAllergy(draftNote),
    allergens: hasAllergyAlert ? selectedAllergens : [],
    manualIntolerance: hasAllergyAlert ? draftManualIntolerance : "",
  });

  const validateOccupy = () => {
    const covers = Number(draftCovers);
    if (!Number.isFinite(covers) || covers <= 0) {
      setActionError("Numero persone obbligatorio.");
      return false;
    }
    return true;
  };

  const validateReserve = () => {
    const name = draftName.trim();
    if (!name) {
      setActionError("Nome prenotazione obbligatorio.");
      return false;
    }
    if (!draftPhone.trim()) {
      setActionError("Telefono prenotazione obbligatorio.");
      return false;
    }
    const covers = Number(draftCovers);
    if (!Number.isFinite(covers) || covers <= 0) {
      setActionError("Numero persone obbligatorio.");
      return false;
    }
    if (!reservationTime.trim()) {
      setActionError("Orario prenotazione obbligatorio.");
      return false;
    }
    return true;
  };

  const summary = useMemo(() => {
    let free = 0;
    let occupied = 0;
    let ordering = 0;
    let paymentDue = 0;
    searchMatchedTables.forEach((table) => {
      if (table.amountDue > 0) {
        paymentDue += 1;
        return;
      }
      if (table.ordersInProgress > 0) {
        ordering += 1;
        return;
      }
      if (table.occupancyState === "free") {
        free += 1;
        return;
      }
      occupied += 1;
    });
    return { free, occupied, ordering, paymentDue };
  }, [searchMatchedTables]);

  const toggleLegendFilter = (key: LegendFilterKey) => {
    if (dashboardQuickFilterActiveRef.current && dashboardQuickFilter) {
      // Da qui in avanti comanda la legenda: il filtro della dashboard non
      // deve tornare da solo.
      dismissedDashboardQuickFilterNonceRef.current = dashboardQuickFilter.nonce;
    }
    if (legendFilterMode === "single") {
      const isClearingDashboardQuickFilter =
        dashboardQuickFilterActiveRef.current && activeLegendFilter === key;
      const isClearingTemporaryLegendFilter =
        temporaryLegendFilterPreviousModeRef.current !== null && activeLegendFilter === key;
      dashboardQuickFilterActiveRef.current = false;
      setActiveLegendFilter((prev) => (prev === key ? null : key));
      if (isClearingDashboardQuickFilter) {
        const previousMode = dashboardQuickFilterPreviousModeRef.current;
        dashboardQuickFilterPreviousModeRef.current = null;
        temporaryLegendFilterPreviousModeRef.current = null;
        temporaryLegendFilterPreviousDisabledRef.current = null;
        if (previousMode && previousMode !== "single") {
          setLegendFilterModeState(previousMode);
        }
      } else if (isClearingTemporaryLegendFilter) {
        const previousMode = temporaryLegendFilterPreviousModeRef.current;
        const previousDisabled = temporaryLegendFilterPreviousDisabledRef.current;
        temporaryLegendFilterPreviousModeRef.current = null;
        temporaryLegendFilterPreviousDisabledRef.current = null;
        dashboardQuickFilterPreviousModeRef.current = null;
        setDisabledLegendFilters(previousDisabled ?? []);
        if (previousMode && previousMode !== "single") {
          setLegendFilterModeState(previousMode);
        }
      } else {
        dashboardQuickFilterPreviousModeRef.current = null;
      }
      return;
    }
    dashboardQuickFilterActiveRef.current = false;
    dashboardQuickFilterPreviousModeRef.current = null;
    temporaryLegendFilterPreviousModeRef.current = legendFilterMode;
    temporaryLegendFilterPreviousDisabledRef.current = [...disabledLegendFilters];
    setLegendFilterModeState("single");
    setDisabledLegendFilters([]);
    setActiveLegendFilter(key);
  };

  const roomOptions = useMemo(() => {
    const rooms = roomsQuery.data ?? [];
    return [...rooms].sort((left, right) => {
      const leftIsVirtual = isVirtualWaitingRoom(left);
      const rightIsVirtual = isVirtualWaitingRoom(right);
      if (leftIsVirtual !== rightIsVirtual) return leftIsVirtual ? -1 : 1;
      return 0;
    });
  }, [roomsQuery.data]);

  const openRoomPicker = useCallback(() => {
    setRoomPickerError(null);
    setRoomPickerOpen(true);
    if (!roomsQuery.data && !roomsQuery.isFetching) {
      void roomsQuery.refetch();
    }
  }, [roomsQuery]);

  const closeRoomPicker = useCallback(() => {
    setRoomPickerOpen(false);
    setRoomPickerError(null);
  }, []);

  useEffect(() => {
    if (!active || !roomPickerRequest) return;
    openRoomPicker();
  }, [active, openRoomPicker, roomPickerRequest]);

  useEffect(() => {
    if (!roomPickerOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRoomPicker();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeRoomPicker, roomPickerOpen]);

  const clearRoomTitleLongPress = useCallback(() => {
    if (roomTitleLongPressTimerRef.current !== null) {
      window.clearTimeout(roomTitleLongPressTimerRef.current);
      roomTitleLongPressTimerRef.current = null;
    }
  }, []);

  const startRoomTitleLongPress = useCallback(() => {
    clearRoomTitleLongPress();
    roomTitleLongPressTriggeredRef.current = false;
    roomTitleLongPressTimerRef.current = window.setTimeout(() => {
      roomTitleLongPressTriggeredRef.current = true;
      roomTitleLongPressTimerRef.current = null;
      triggerLongPressHaptic();
      openRoomPicker();
    }, 520);
  }, [clearRoomTitleLongPress, openRoomPicker]);

  const handleRoomTitlePointerEnd = useCallback(() => {
    clearRoomTitleLongPress();
    window.setTimeout(() => {
      roomTitleLongPressTriggeredRef.current = false;
    }, 0);
  }, [clearRoomTitleLongPress]);

  const clearRoomLongPress = () => {
    if (roomLongPressRef.current === null) return;
    window.clearTimeout(roomLongPressRef.current);
    roomLongPressRef.current = null;
  };

  const startRoomLongPress = (room: Room) => {
    clearRoomLongPress();
    roomLongPressFiredRef.current = false;
    roomLongPressRef.current = window.setTimeout(() => {
      roomLongPressFiredRef.current = true;
      setRoomActionsError(null);
      setRoomActionsTarget(room);
    }, 600);
  };

  const runRoomBulkAction = async (action: RoomBulkAction) => {
    const room = roomActionsTarget;
    if (!room || roomActionsBusy) return;
    setRoomActionsBusy(true);
    setRoomActionsError(null);
    try {
      const outcome =
        action === "free"
          ? await freeRoomTables(baseSession, room)
          : await clearRoomTables(baseSession, room, "Svuotamento sala dal palmare");
      await Promise.allSettled([
        queryClient.invalidateQueries({
          queryKey: tablesQueryKey(effectiveRoomId, effectiveActivityId),
        }),
        queryClient.invalidateQueries({ queryKey: ["available-rooms"] }),
      ]);
      setRoomActionsTarget(null);
      setServiceRecoveryNotice(
        outcome.skipped > 0
          ? `${room.name}: ${outcome.done} tavoli svuotati, ${outcome.skipped} lasciati con ordini o conti aperti.`
          : `${room.name}: ${outcome.done} tavoli svuotati.`
      );
    } catch (error) {
      setRoomActionsError(
        error instanceof Error ? error.message : "Operazione sulla sala non riuscita."
      );
    } finally {
      setRoomActionsBusy(false);
    }
  };

  const changeRoomFromTables = async (room: Room) => {
    const targetRoomId = String(room.id ?? "").trim();
    if (!targetRoomId || targetRoomId === effectiveRoomId || roomPickerBusy) return;
    setRoomPickerBusy(true);
    setRoomPickerError(null);
    try {
      const currentQueryKey = tablesQueryKey(effectiveRoomId, effectiveActivityId);
      await queryClient.cancelQueries({ queryKey: currentQueryKey });
      const result = await requestRoomChange({
        token: token || "",
        userId: effectiveUserId,
        role: effectiveRole,
        deviceUuid: effectiveDeviceUuid,
        targetRoomId,
      });

      if (result.status === "approved") {
        setSelectedTableId(null);
        setSelectedTableSnapshot(null);
        closeTableChildFlows();
        setRoom({
          roomId: result.room.id,
          roomName: result.room.name,
          activityId: result.room.activityId,
          activityName: result.room.activityName,
        });
        closeRoomPicker();
        const nextQueryKey = tablesQueryKey(
          result.room.id,
          result.room.activityId ?? effectiveActivityId
        );
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: currentQueryKey }),
          queryClient.invalidateQueries({ queryKey: nextQueryKey }),
          queryClient.invalidateQueries({ queryKey: ["available-rooms"] }),
        ]);
        return;
      }

      setRoomPickerError(`Richiesta inviata per ${result.room.name}. Attendi autorizzazione.`);
    } catch (error) {
      setRoomPickerError(error instanceof Error ? error.message : "Impossibile cambiare sala.");
    } finally {
      setRoomPickerBusy(false);
    }
  };

  const moveTableMap = useMemo(
    () =>
      sortedTables.map((table) => ({
        id: table.id,
        number: table.number,
        isFree: table.occupancyState === "free",
        isCurrent: table.id === selectedTableId,
      })),
    [selectedTableId, sortedTables]
  );

  const toggleAllergen = (value: string) => {
    setSelectedAllergens((prev) =>
      prev.includes(value) ? prev.filter((entry) => entry !== value) : [...prev, value]
    );
  };

  const tableMetaHasChanges = useMemo(() => {
    if (!detailTable || detailTable.occupancyState === "free") return false;

    const normalizeText = (value: string, max: number) => value.trim().slice(0, max);
    const normalizeList = (list: string[]) =>
      Array.from(
        new Set(
          list
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, 12)
        )
      ).sort((a, b) => a.localeCompare(b, "it"));

    const currentName = normalizeText(detailTable.tableName, 16);
    const nextNameInput = normalizeText(draftName, 16);
    const nextName =
      detailTable.occupancyState === "reserved" ? nextNameInput : nextNameInput || currentName;
    const nextPhone = normalizeText(draftPhone, 24);
    const nextCovers = normalizeTableCovers(draftCovers, { fallback: detailTable.covers });
    const nextNote = normalizeText(composeNoteWithAllergy(draftNote), 240);
    const nextAllergens = hasAllergyAlert ? normalizeList(selectedAllergens) : [];
    const nextManualIntolerance = hasAllergyAlert ? normalizeText(draftManualIntolerance, 64) : "";
    const nextReservationTime =
      reservationTime.trim() || getDefaultReservationTimeValue(detailTable);

    const currentPhone = normalizeText(detailTable.customerPhone, 24);
    const currentCovers = detailTable.covers;
    const currentNote = normalizeText(detailTable.note, 240);
    const currentAllergens = normalizeList(detailTable.allergens);
    const currentManualIntolerance = normalizeText(detailTable.manualIntolerance, 64);
    const currentReservationTime = getDefaultReservationTimeValue(detailTable);

    if (nextName !== currentName) return true;
    if (nextPhone !== currentPhone) return true;
    if (nextCovers !== currentCovers) return true;
    if (nextNote !== currentNote) return true;
    if (nextManualIntolerance !== currentManualIntolerance) return true;
    if (
      detailTable.occupancyState === "reserved" &&
      nextReservationTime !== currentReservationTime
    ) {
      return true;
    }
    if (nextAllergens.length !== currentAllergens.length) return true;

    return nextAllergens.some((allergen, index) => allergen !== currentAllergens[index]);
  }, [
    draftCovers,
    draftManualIntolerance,
    draftName,
    draftNote,
    draftPhone,
    hasAllergyAlert,
    reservationTime,
    selectedAllergens,
    detailTable,
  ]);

  // L'effetto che risincronizza il modulo e' dichiarato prima di questo memo e
  // legge il valore del commit precedente: cioe' se le modifiche c'erano gia'
  // **prima** che arrivasse l'aggiornamento del server, che e' la domanda giusta.
  const tableMetaHasChangesRef = useRef(false);
  useEffect(() => {
    tableMetaHasChangesRef.current = tableMetaHasChanges;
  });

  if (!canLoad) {
    return (
      <GlassCard className="home-card workspace-card tables-workspace-card">
        <div className="card-body tables-card-body">
          <div className="tables-empty-state">
            Sessione non valida. Effettua nuovamente il login.
          </div>
        </div>
      </GlassCard>
    );
  }

  if (counterMode) {
    return (
      <CounterWorkspace
        baseSession={baseSession}
        roomName={roomName || "Operativa"}
        catalog={menuCatalogQuery.data ?? null}
        busy={actionBusy}
      />
    );
  }

  return (
    <>
      <GlassCard className="home-card workspace-card tables-workspace-card">
        <div className="card-body tables-card-body">
          <div className="tables-shell">
            <div className="tables-head">
              <div className="tables-title-wrap">
                <button
                  type="button"
                  className="tables-room-title-button"
                  aria-label="Tieni premuto per cambiare sala"
                  onPointerDown={(event) => {
                    if (event.pointerType === "mouse" && event.button !== 0) return;
                    startRoomTitleLongPress();
                  }}
                  onPointerUp={handleRoomTitlePointerEnd}
                  onPointerLeave={handleRoomTitlePointerEnd}
                  onPointerCancel={handleRoomTitlePointerEnd}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openRoomPicker();
                  }}
                >
                  <h2 className="tables-title">{roomName || "Operativa"}</h2>
                </button>
              </div>
              <div className="tables-legend">
                <button
                  type="button"
                  className={`tables-legend-item state-free ${
                    legendFilterMode === "exclude" && disabledLegendFilters.includes("free")
                      ? "is-disabled"
                      : legendFilterMode === "single" && activeLegendFilter === "free"
                        ? "is-active"
                        : ""
                  }`}
                  onClick={() => toggleLegendFilter("free")}
                  aria-pressed={
                    legendFilterMode === "exclude"
                      ? disabledLegendFilters.includes("free")
                      : activeLegendFilter === "free"
                  }
                >
                  Liberi {summary.free}
                </button>
                <button
                  type="button"
                  className={`tables-legend-item state-occupied ${
                    legendFilterMode === "exclude" && disabledLegendFilters.includes("occupied")
                      ? "is-disabled"
                      : legendFilterMode === "single" && activeLegendFilter === "occupied"
                        ? "is-active"
                        : ""
                  }`}
                  onClick={() => toggleLegendFilter("occupied")}
                  aria-pressed={
                    legendFilterMode === "exclude"
                      ? disabledLegendFilters.includes("occupied")
                      : activeLegendFilter === "occupied"
                  }
                >
                  Occupati/Prenotati {summary.occupied}
                </button>
                <button
                  type="button"
                  className={`tables-legend-item state-ordering ${
                    legendFilterMode === "exclude" && disabledLegendFilters.includes("ordering")
                      ? "is-disabled"
                      : legendFilterMode === "single" && activeLegendFilter === "ordering"
                        ? "is-active"
                        : ""
                  }`}
                  onClick={() => toggleLegendFilter("ordering")}
                  aria-pressed={
                    legendFilterMode === "exclude"
                      ? disabledLegendFilters.includes("ordering")
                      : activeLegendFilter === "ordering"
                  }
                >
                  Ordine {summary.ordering}
                </button>
                <button
                  type="button"
                  className={`tables-legend-item state-payment_due ${
                    legendFilterMode === "exclude" && disabledLegendFilters.includes("payment_due")
                      ? "is-disabled"
                      : legendFilterMode === "single" && activeLegendFilter === "payment_due"
                        ? "is-active"
                        : ""
                  }`}
                  onClick={() => toggleLegendFilter("payment_due")}
                  aria-pressed={
                    legendFilterMode === "exclude"
                      ? disabledLegendFilters.includes("payment_due")
                      : activeLegendFilter === "payment_due"
                  }
                >
                  Da pagare {summary.paymentDue}
                </button>
              </div>
            </div>

            <div className="tables-search-wrap">
              <div className="tables-search">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M20 20l-3.2-3.2" />
                </svg>
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Cerca tavolo per numero o nominativo"
                  aria-label="Ricerca tavoli"
                />
              </div>
            </div>

            {tablesQuery.isLoading && (
              <div className="tables-empty-state">Caricamento tavoli...</div>
            )}
            {tablesQuery.isError && (
              <div className="tables-empty-state">Errore durante il caricamento della sala.</div>
            )}

            {!tablesQuery.isLoading && !tablesQuery.isError && (
              <div className="tables-grid-scroll" ref={tablesScrollRef}>
                <div className="tables-grid">
                  {filteredTables.map((table) => (
                    <TableTile
                      key={table.id}
                      table={table}
                      now={now}
                      selected={selectedTableId === table.id}
                      onOpen={openTableWithConfigurationCheck}
                      onLongPress={openTableGroupsContext}
                    />
                  ))}
                  {filteredTables.length === 0 && (
                    <div className="tables-empty-state">
                      Nessun tavolo trovato con questa ricerca.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          {roomPickerOpen && (
            <div className="tables-room-change-backdrop" onClick={closeRoomPicker}>
              <div
                className="tables-room-change-modal"
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
                    onClick={closeRoomPicker}
                    aria-label="Chiudi cambio sala"
                  />
                </div>

                {roomPickerError ? (
                  <div className="tables-room-change-error">{roomPickerError}</div>
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
                        disabled={roomPickerBusy}
                        aria-current={isCurrent ? "true" : undefined}
                        onPointerDown={() => {
                          if (isCurrent && !isVirtualWaiting) return;
                          startRoomLongPress(room);
                        }}
                        onPointerUp={clearRoomLongPress}
                        onPointerLeave={clearRoomLongPress}
                        onPointerCancel={clearRoomLongPress}
                        onClick={() => {
                          clearRoomLongPress();
                          if (roomLongPressFiredRef.current) {
                            roomLongPressFiredRef.current = false;
                            return;
                          }
                          if (isCurrent) {
                            closeRoomPicker();
                            return;
                          }
                          void changeRoomFromTables(room);
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
          )}
          {splitAfterFree ? (
            <div
              className="tables-move-confirm-backdrop"
              onClick={() => setSplitAfterFree(null)}
            >
              <section
                className="tables-move-confirm-card"
                role="alertdialog"
                aria-modal="true"
                aria-label="Tavolo unito liberato"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="tables-move-confirm-title">TAVOLO UNITO</div>
                <div className="tables-move-confirm-body">
                  <p className="tables-move-confirm-warning">
                    {splitAfterFree.label} e' stato liberato. Dividere di nuovo i tavoli o
                    lasciarli uniti?
                  </p>
                </div>
                <div className="tables-move-confirm-actions">
                  <button
                    type="button"
                    className="smallbtn tables-move-confirm-btn is-cancel"
                    onClick={() => setSplitAfterFree(null)}
                    disabled={actionBusy}
                    autoFocus
                  >
                    LASCIA UNITO
                  </button>
                  <button
                    type="button"
                    className="smallbtn tables-move-confirm-btn"
                    onClick={() => {
                      const gruppo = tableGroupByRoot(tableGroups, splitAfterFree.rootId);
                      const chiavi = new Set(
                        (gruppo?.children ?? []).map((child, index) =>
                          tableGroupDirectNodeKey(child, index)
                        )
                      );
                      setSplitAfterFree(null);
                      void confirmTableGroupsSplit(splitAfterFree.rootId, chiavi);
                    }}
                    disabled={actionBusy}
                  >
                    DIVIDI
                  </button>
                </div>
              </section>
            </div>
          ) : null}
          <TablesRoomActionsDialog
            roomName={roomActionsTarget?.name ?? null}
            canClear={canAdminCancelTables}
            busy={roomActionsBusy}
            error={roomActionsError}
            onClose={() => {
              if (roomActionsBusy) return;
              setRoomActionsTarget(null);
              setRoomActionsError(null);
            }}
            onRun={(action) => void runRoomBulkAction(action)}
          />
          <TableDetailPanel
            open={detailPanelOpen}
            table={detailTable}
            roomName={roomName || "Operativa"}
            deliveryConfirmationEnabled={deliveryConfirmationEnabled}
            setupMode={setupMode}
            draftName={draftName}
            draftPhone={draftPhone}
            draftCovers={draftCovers}
            draftNote={draftNote}
            hasAllergyAlert={hasAllergyAlert}
            selectedAllergens={selectedAllergens}
            draftManualIntolerance={draftManualIntolerance}
            allergenOptions={TABLE_ALLERGEN_OPTIONS}
            reservationTime={reservationTime}
            movePickerOpen={movePickerOpen}
            moveTableMap={moveTableMap}
            orderComposerOpen={orderComposerOpen}
            paymentWizardOpen={paymentWizardOpen}
            menuCatalog={menuCatalogQuery.data ?? null}
            menuCatalogLoading={menuCatalogQuery.isLoading && !menuCatalogQuery.data}
            menuCatalogError={
              menuCatalogQuery.isError
                ? "Menu non disponibile per questa sala e attivita. Riprova tra qualche secondo."
                : null
            }
            busy={actionBusy || tableLockBusy}
            errorMessage={noActiveStationsWarning ? NO_ACTIVE_STATIONS_MESSAGE : null}
            actionError={actionError}
            onDismissActionError={() => setActionError(null)}
            canReserve={!isVirtualWaitingRoom({ id: effectiveRoomId, name: roomName })}
            reservationSeatGuard={reservationSeatGuard}
            onFreeTables={freeTablesForReservation}
            onClose={() => {
              closeTableDetail();
            }}
            onChangeSetupMode={setSetupMode}
            onChangeName={setDraftName}
            onChangePhone={setDraftPhone}
            onChangeCovers={setDraftCovers}
            onChangeNote={setDraftNote}
            onCommitAllergies={(allergens, manuale) => {
              setSelectedAllergens(allergens);
              setDraftManualIntolerance(manuale);
              const attivo = allergens.length > 0 || Boolean(manuale.trim());
              // Il marcatore nella nota segue lo stato: si aggiunge quando c'e
              // almeno un'intolleranza e si toglie quando non ce n'e piu.
              setDraftNote((prev) => {
                const senza = prev.replace(TABLE_ALLERGY_NOTE, "").trim();
                if (!attivo) return senza;
                return senza ? `${TABLE_ALLERGY_NOTE}\n${senza}` : TABLE_ALLERGY_NOTE;
              });
            }}
            onToggleAllergen={toggleAllergen}
            onChangeManualIntolerance={setDraftManualIntolerance}
            onChangeReservationTime={setReservationTime}
            onOpenMovePicker={() => setMovePickerOpen(true)}
            onCloseMovePicker={() => {
              setMovePickerOpen(false);
              setMoveConfirm(null);
            }}
            onMoveToTable={async (targetTableId) => {
              if (!selectedTableId) return;
              setMoveConfirm({
                fromTableId: selectedTableId,
                toTableIds: [targetTableId],
                sourceLabel: formatMoveTableLabel(sortedTables, selectedTableId, "Tavolo sorgente"),
                targetLabels: [
                  formatMoveTableLabel(sortedTables, targetTableId, "Tavolo destinazione"),
                ],
              });
            }}
            onToggleOrderComposer={setOrderComposerOpen}
            onTogglePaymentWizard={setPaymentWizardOpen}
            onSubmitOrder={(payload) =>
              runOnSelectedOptimisticOrderAction(payload, async (tableId, logicalContext) => {
                const result = await addDiningTableOrder({
                  ...baseSession,
                  ...logicalContext,
                  tableId,
                  title: payload.title,
                  total: payload.total,
                  orderNote: payload.orderNote,
                  orderComment: payload.orderComment,
                  lines: payload.lines,
                });
                if (isNoActiveStationOrderWarning(result.warningCode, result.warningMessage)) {
                  setActionError(null);
                  setNoActiveStationsWarning(true);
                } else if (result.warningMessage) {
                  setActionError(`Avviso: ${result.warningMessage}`);
                }
                return result.table;
              })
            }
            onApplyPaymentAdjustment={async (adjustment, targetOrderId) => {
              if (!detailTable) throw new Error("Nessun tavolo selezionato.");
              setActionError(null);
              setActionBusy(true);
              try {
                await persistTablePaymentAdjustment({
                  table: detailTable,
                  session: baseSession,
                  targetOrderId,
                  adjustment,
                });
                const refreshed = await tablesQuery.refetch();
                if (refreshed.error) throw refreshed.error;
                const nextTable = refreshed.data?.tables.find(
                  (candidate) => candidate.id === detailTable.id
                );
                if (!nextTable) {
                  throw new Error("Rettifica salvata, ma il tavolo aggiornato non e disponibile.");
                }
                setSelectedTableSnapshot(nextTable);
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : "Rettifica pagamento non riuscita.";
                setActionError(message);
                throw new Error(message);
              } finally {
                setActionBusy(false);
              }
            }}
            onSaveMeta={() =>
              runOnSelected(
                (tableId, logicalContext) => {
                  const payload = getPayloadBase();
                  return updateDiningTableMeta({
                    ...baseSession,
                    ...logicalContext,
                    tableId,
                    tableName: payload.tableName,
                    customerPhone: payload.customerPhone,
                    covers: payload.covers,
                    note: payload.note,
                    allergens: payload.allergens,
                    manualIntolerance: payload.manualIntolerance,
                  });
                },
                { lockPurpose: TABLE_LAYOUT_SYNC_LOCK_PURPOSE }
              )
            }
            onReserve={async () => {
              if (!validateReserve()) return;
              await runOnSelected(
                (tableId, logicalContext) => {
                  const payload = getPayloadBase();
                  return reserveDiningTable({
                    ...baseSession,
                    ...logicalContext,
                    tableId,
                    tableName: payload.tableName,
                    customerPhone: payload.customerPhone,
                    covers: payload.covers,
                    note: payload.note,
                    allergens: payload.allergens,
                    manualIntolerance: payload.manualIntolerance,
                    reservationAt: reservationTimeToTimestamp(reservationTime),
                  });
                },
                {
                  clearSelection: true,
                  lockPurpose: TABLE_LAYOUT_SYNC_LOCK_PURPOSE,
                  offlineContinuation: true,
                }
              );
            }}
            onOccupy={async () => {
              if (!validateOccupy()) return;
              const payload = getPayloadBase();
              runOnSelectedOptimisticTableAction(
                (tableId, logicalContext) => {
                  return occupyDiningTable({
                    ...baseSession,
                    ...logicalContext,
                    tableId,
                    tableName: payload.tableName,
                    customerPhone: payload.customerPhone,
                    covers: payload.covers,
                    note: payload.note,
                    allergens: payload.allergens,
                    manualIntolerance: payload.manualIntolerance,
                  });
                },
                {
                  lockPurpose: TABLE_LAYOUT_SYNC_LOCK_PURPOSE,
                  offlineContinuation: true,
                  applyOptimistic: (snapshot, tableId) =>
                    applyOptimisticOccupyTableToSnapshot(snapshot, tableId, payload),
                }
              );
            }}
            onMarkArrived={() =>
              runOnSelected(
                (tableId, logicalContext) =>
                  markDiningReservationArrived({
                    ...baseSession,
                    ...logicalContext,
                    tableId,
                  }),
                {
                  lockPurpose: TABLE_LAYOUT_SYNC_LOCK_PURPOSE,
                  offlineContinuation: true,
                }
              )
            }
            onFree={() => {
              const unito = detailTable?.mobileComplex ? detailTable : null;
              const esito = runOnSelectedOptimisticTableAction(
                (tableId, logicalContext) =>
                  freeDiningTable({ ...baseSession, ...logicalContext, tableId }),
                {
                  clearSelection: true,
                  lockPurpose: TABLE_LAYOUT_SYNC_LOCK_PURPOSE,
                  offlineContinuation: true,
                  applyOptimistic: (snapshot, tableId) =>
                    applyOptimisticFreeTableToSnapshot(snapshot, tableId),
                }
              );
              if (unito) {
                setSplitAfterFree({
                  rootId: unito.mobileActiveTableId || unito.id,
                  label: unito.mobileComplexLabel || `Tavolo ${unito.number}`,
                });
              }
              return esito;
            }}
            onServeOrder={(orderId) =>
              runOnSelected(
                (tableId, logicalContext) =>
                  markDiningOrderServed({ ...baseSession, ...logicalContext, tableId, orderId }),
                {
                  lockPurpose: TABLE_LAYOUT_SYNC_LOCK_PURPOSE,
                }
              )
            }
            onServiceRecovery={openServiceRecoveryDialog}
            onConfirmPayment={async ({
              amount,
              method,
              orderId,
              articleUnitIds,
              splitMode,
              adminAdjustment,
              cashReceived,
              cashSource,
              automaticCashPaymentOperationId,
              receiptType,
              invoiceRecipient,
              clientPaymentId,
              note,
              romanSharesPaid,
              romanSharesTotal,
              commercialBenefitApplications,
            }) => {
              if (!selectedActionTableId) return;
              await withAction(
                async () =>
                  runWithTableLocks([selectedActionTableId], PAYMENT_LOCK_PURPOSE, () =>
                    payDiningTable({
                      ...baseSession,
                      ...selectedLogicalTableContext,
                      tableId: selectedActionTableId,
                      amount,
                      paymentMethod: method,
                      orderId,
                      articleUnitIds,
                      splitMode,
                      adminAdjustment,
                      cashReceived,
                      cashSource,
                      automaticCashPaymentOperationId,
                      receiptType,
                      invoiceRecipient,
                      clientPaymentId,
                      note,
                      romanSharesPaid,
                      romanSharesTotal,
                      commercialBenefitApplications,
                    })
                  ),
                { rethrow: true, skipRefresh: true }
              );
            }}
            showAnagraphicUpdate={tableMetaHasChanges}
            canCollectPayments={canCollectPayments}
          />
        </div>
        <TableReservationReleaseDialog
          busy={actionBusy || tableLockBusy}
          prompt={reservationReleasePrompt}
          onFree={() => void freeReservationReleasePromptTable()}
          onSnooze={snoozeReservationReleasePrompt}
        />
        {serviceRecoveryDialog && detailTable && (
          <TableServiceRecoveryDialog
            action={serviceRecoveryDialog.action}
            order={serviceRecoveryDialog.order}
            table={detailTable}
            session={baseSession}
            menuCatalog={menuCatalogQuery.data ?? null}
            busy={actionBusy || tableLockBusy}
            onClose={() => setServiceRecoveryDialog(null)}
            onDone={handleServiceRecoveryDone}
            onLockConflict={handleOperationLockConflict}
          />
        )}
        {serviceRecoveryNotice && (
          <div
            id="mobile-service-recovery-notice-root"
            className="mobile-service-recovery-notice"
            role="alertdialog"
            aria-modal="true"
            aria-label="Avviso"
            onClick={() => setServiceRecoveryNotice(null)}
          >
            <div
              className="mobile-service-recovery-notice-card"
              onClick={(event) => event.stopPropagation()}
            >
              <strong>Avviso</strong>
              <p>{serviceRecoveryNotice}</p>
              <button
                type="button"
                className="smallbtn msr-primary"
                onClick={() => setServiceRecoveryNotice(null)}
              >
                OK
              </button>
            </div>
          </div>
        )}
        {mergeConfirm && (
          <TableMergeConfirmDialog
            request={mergeConfirm}
            busy={actionBusy || tableLockBusy}
            onCancel={() => setMergeConfirm(null)}
            onConfirm={() =>
              void performTableGroupsMerge(mergeConfirm.rootId, mergeConfirm.selectedIds, {
                allowMultipleActive: true,
              })
            }
          />
        )}
        {moveConfirm && (
          <TableMoveConfirmDialog
            request={moveConfirm}
            busy={actionBusy || tableLockBusy}
            onCancel={() => setMoveConfirm(null)}
            onConfirm={confirmMoveTable}
          />
        )}
      </GlassCard>
      {tableGroupsDialog && (
        <TableGroupsDialog
          state={tableGroupsDialog}
          tables={rawTables}
          groups={tableGroups}
          rooms={roomsQuery.data ?? []}
          currentRoomId={effectiveRoomId}
          roomMoveTables={tableRoomMoveSnapshot?.tables ?? []}
          roomMoveGroups={tableRoomMoveSnapshot?.groups ?? []}
          roomMoveAvailability={roomMoveAvailabilityQuery.data ?? new Map()}
          roomMoveAvailabilityLoading={
            roomMoveAvailabilityQuery.isLoading || roomMoveAvailabilityQuery.isFetching
          }
          roomMoveAvailabilityReady={roomMoveAvailabilityQuery.isSuccess}
          roomsLoading={roomsQuery.isLoading || roomsQuery.isFetching}
          roomMoveTablesLoading={actionBusy && tableGroupsDialog.type === "roomMoveTable"}
          busy={actionBusy}
          error={tableGroupsError}
          onClose={() => {
            if (actionBusy) return;
            setTableGroupsDialog(null);
            setTableGroupsError(null);
            setTableRoomMoveSnapshot(null);
          }}
          onChangeState={(nextState) => {
            setTableGroupsError(null);
            if (nextState.type !== "roomMoveTable") {
              setTableRoomMoveSnapshot(null);
            }
            setTableGroupsDialog(nextState);
          }}
          onMerge={confirmTableGroupsMerge}
          onSplit={confirmTableGroupsSplit}
          onMove={startContextMove}
          onChooseRoomMoveRoom={chooseTableRoomMoveRoom}
          onRoomMove={confirmTableRoomMove}
          canCancelTable={canAdminCancelTables}
          onCancelTable={confirmAdminTableCancellation}
        />
      )}
      {configurationRemovalTable &&
        tableNeedsConfigurationRemovalDecision(configurationRemovalTable) && (
          <TableConfigurationRemovalDialog
            table={configurationRemovalTable}
            busy={configurationRemovalBusy}
            onClose={() => setConfigurationRemovalTableId(null)}
            onKeep={() => void keepTableAfterConfigurationRemoval()}
            onMove={moveTableAfterConfigurationRemoval}
          />
        )}
    </>
  );
}
