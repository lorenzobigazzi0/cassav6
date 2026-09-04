import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  acquireReservationEditLock,
  createDiningReservation,
  deleteDiningReservation,
  fetchReservationTableAvailability,
  fetchReservationsForDay,
  releaseReservationEditLock,
  reservationsQueryKey,
  updateDiningReservation,
  updateDiningReservationStatus,
  type DiningReservation,
  type ReservationStatusAction,
  type ReservationStatusColor,
  type ReservationSummary,
  type TableAvailabilityInfo,
} from "../../../api/reservations";
import { ReservationEditorScreen } from "./ReservationEditorScreen";
import {
  createEmptyForm,
  reservationToForm,
  toTimestamp,
  HACCP_INTOLERANCE_OPTIONS,
  type ReservationEditorStatus,
  type ReservationFormState,
  reservationLabel,
  statusLegendLabel,
  toClockTime,
} from "./reservationEditorSupport";
import {
  shouldReserveTableForReservation,
  shouldWarnTableReleaseForReservation,
} from "../../../api/tableReservationWindow";
import { fetchAvailableRooms, type Room } from "../../../api/locations";
import { fetchTablesForSession, tablesQueryKey } from "../../../api/tables";
import { GlassCard } from "../../../components/GlassCard";
import { normalizeTableCovers } from "../../../domain/tables/capacity";
import { useAuthStore } from "../../../store/authStore";
import { getOrCreateDeviceUuid } from "../../../utils/device";
import { composeIntoleranceTokens, parseIntoleranceTokens } from "../../../utils/intoleranceTokens";
import { reservableRoomOptions } from "../../../utils/rooms";
import { GlassDropdown } from "../tables/components/GlassDropdown";
import { ReservationIntoleranceBadge } from "./components/ReservationIntoleranceBadge";
import {
  ReservationActionIcon,
  ReservationStatusIcon,
} from "./components/ReservationIcons";

type EditorMode = "view" | "edit" | "create";
type ConfirmDialogState =
  | { type: "arrived"; reservationLabel: string }
  | { type: "no_show"; reservationLabel: string }
  | { type: "delete"; reservationLabel: string }
  | { type: "assign-release-warning"; tableId: string; tableLabel: string; detail: string }
  | { type: "assign-warning"; tableId: string; tableLabel: string; detail: string }
  | { type: "assign-danger-step1"; tableId: string; tableLabel: string; detail: string }
  | { type: "assign-danger-step2"; tableId: string; tableLabel: string; detail: string }
  | null;

type ReservationLockState = {
  reservationId: string;
  lockId: string;
  expiresAt: number;
};

type ReservationTableWindowHint = {
  tone: "preview" | "reserved" | "warning";
  label: string;
  detail: string;
  requiresConfirmation: boolean;
};

const LOCK_REFRESH_MS = 60_000;
const toDateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const normalizeDateKey = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [yearRaw, monthRaw, dayRaw] = value.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  return toDateKey(date) === value ? value : null;
};

const dateKeyIsBefore = (left: string, right: string) => left.localeCompare(right) < 0;






const cloneReservationForCache = (reservation: DiningReservation): DiningReservation => ({
  ...reservation,
  assignedTableIds: [...reservation.assignedTableIds],
});

const sortReservationsByTime = (reservations: DiningReservation[]) =>
  [...reservations].sort((left, right) => left.reservationAt - right.reservationAt);

const upsertReservationSummary = (
  summary: ReservationSummary | undefined,
  reservation: DiningReservation
): ReservationSummary => {
  const nextReservation = cloneReservationForCache(reservation);
  const currentReservations = summary?.reservations ?? [];
  const nextReservations = currentReservations.some((entry) => entry.id === nextReservation.id)
    ? currentReservations.map((entry) =>
        entry.id === nextReservation.id ? nextReservation : cloneReservationForCache(entry)
      )
    : [...currentReservations.map(cloneReservationForCache), nextReservation];
  return {
    version: Math.max(1, summary?.version ?? 0) + 1,
    reservations: sortReservationsByTime(nextReservations),
  };
};

const removeReservationFromSummary = (
  summary: ReservationSummary | undefined,
  reservationId: string
): ReservationSummary | undefined => {
  if (!summary) return summary;
  const reservations = summary.reservations.filter(
    (reservation) => reservation.id !== reservationId
  );
  if (reservations.length === summary.reservations.length) return summary;
  return {
    version: Math.max(1, summary.version) + 1,
    reservations: reservations.map(cloneReservationForCache),
  };
};

const assignedTableIdsForReservation = (reservation: DiningReservation | null | undefined) =>
  reservation?.assignedTableIds.length
    ? reservation.assignedTableIds
    : reservation?.assignedTableId
      ? [reservation.assignedTableId]
      : [];

const reservationCanAffectCurrentTables = (
  reservation: DiningReservation | null | undefined,
  now: number
) =>
  assignedTableIdsForReservation(reservation).length > 0 &&
  Boolean(reservation && shouldReserveTableForReservation(reservation.reservationAt, now));

const reservationStatusLabel: Record<DiningReservation["status"], string> = {
  booked: "Prenotata",
  arrived: "Arrivati",
  no_show: "No show",
  released: "Chiusa",
  cancelled: "Eliminata",
};

const reservationStatusClass: Record<DiningReservation["status"], string> = {
  booked: "is-booked",
  arrived: "is-arrived",
  no_show: "is-no-show",
  released: "is-released",
  cancelled: "is-cancelled",
};

const reservationStatusOptions: Array<{ value: ReservationEditorStatus; label: string }> = [
  { value: "booked", label: "Prenotata" },
  { value: "arrived", label: "Arrivati" },
  { value: "no_show", label: "No show" },
  { value: "cancelled", label: "Elimina" },
];

export type ReservationsWorkspaceEmbed = {
  reservationId: string;
  roomId: string;
  serviceDate: string;
  onClose: () => void;
};

/**
 * Con `embed` la schermata si apre direttamente sulla modifica di una
 * prenotazione, senza elenco ne' intestazione: e' la stessa modale della
 * sezione, aperta dal tavolo. Le regole restano scritte una volta sola.
 */
export function ReservationsWorkspace({ embed }: { embed?: ReservationsWorkspaceEmbed } = {}) {
  const queryClient = useQueryClient();
  const { token, userId, username, role, deviceUuid, roomId, roomName, activityId } =
    useAuthStore();

  const [serviceDate, setServiceDate] = useState(() => toDateKey(new Date()));
  const [selectedRoomId, setSelectedRoomId] = useState(() => roomId || "");
  const [selectedReservationId, setSelectedReservationId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewOpen, setViewOpen] = useState(false);
  const [mode, setMode] = useState<EditorMode>("view");
  const [assignTableOpen, setAssignTableOpen] = useState(false);
  const [intoleranceEditorOpen, setIntoleranceEditorOpen] = useState(false);
  const [form, setForm] = useState<ReservationFormState>(() => createEmptyForm());
  const [dialog, setDialog] = useState<ConfirmDialogState>(null);
  const [lockState, setLockState] = useState<ReservationLockState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [customIntoleranceDraft, setCustomIntoleranceDraft] = useState("");
  const [customIntoleranceModalOpen, setCustomIntoleranceModalOpen] = useState(false);
  const [reservationWindowNow, setReservationWindowNow] = useState(() => Date.now());
  const lockStateRef = useRef<ReservationLockState | null>(null);
  const canChangeServiceDate = role === "admin";
  const todayServiceDate = useMemo(
    () => toDateKey(new Date(reservationWindowNow)),
    [reservationWindowNow]
  );

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const now = Date.now();
      const today = toDateKey(new Date(now));
      setServiceDate((prev) => {
        if (!canChangeServiceDate) return prev === today ? prev : today;
        return dateKeyIsBefore(prev, today) ? today : prev;
      });
      setReservationWindowNow(now);
    }, 60_000);
    return () => window.clearInterval(intervalId);
  }, [canChangeServiceDate]);

  useEffect(() => {
    setServiceDate((prev) => {
      if (!canChangeServiceDate) return prev === todayServiceDate ? prev : todayServiceDate;
      return dateKeyIsBefore(prev, todayServiceDate) ? todayServiceDate : prev;
    });
  }, [canChangeServiceDate, todayServiceDate]);

  const effectiveDeviceUuid = useMemo(
    () => (deviceUuid && deviceUuid.trim() ? deviceUuid : getOrCreateDeviceUuid()),
    [deviceUuid]
  );
  const effectiveUserId = useMemo(() => {
    if (userId && userId.trim()) return userId;
    if (username && username.trim())
      return `u_${username
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")}`;
    return "u_operatore";
  }, [userId, username]);
  const roomsQuery = useQuery({
    queryKey: [
      "reservations-available-rooms",
      effectiveUserId,
      role ?? "operator",
      effectiveDeviceUuid,
      roomId,
      activityId,
    ],
    enabled: Boolean(token && effectiveDeviceUuid && effectiveUserId),
    queryFn: () =>
      fetchAvailableRooms({
        token: token || "",
        userId: effectiveUserId,
        role: role ?? "operator",
        deviceUuid: effectiveDeviceUuid,
        currentRoomId: roomId || undefined,
        activityId: activityId || undefined,
      }),
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const roomOptions = useMemo<Room[]>(() => {
    const fallbackRoom = roomId ? { id: roomId, name: roomName || "Sala operativa" } : null;
    return reservableRoomOptions(roomsQuery.data ?? [], fallbackRoom);
  }, [roomId, roomName, roomsQuery.data]);
  const roomDropdownOptions = useMemo(
    () => roomOptions.map((room) => ({ value: room.id, label: room.name })),
    [roomOptions]
  );
  useEffect(() => {
    // Aperta dal tavolo la sala e' quella del tavolo, anche se non e' fra le
    // opzioni: l'attesa virtuale, per esempio, non compare nell'elenco sale.
    if (embed) return;
    if (roomOptions.length === 0 || roomOptions.some((room) => room.id === selectedRoomId)) return;
    const currentRoom =
      roomId && roomOptions.some((room) => room.id === roomId) ? roomId : roomOptions[0].id;
    setSelectedRoomId(currentRoom);
  }, [embed, roomId, roomOptions, selectedRoomId]);
  const effectiveRoomId = embed
    ? embed.roomId
    : roomOptions.some((room) => room.id === selectedRoomId)
      ? selectedRoomId
      : roomOptions[0]?.id || "";
  const effectiveRoomName = useMemo(() => {
    const selected = roomOptions.find((room) => room.id === effectiveRoomId);
    return selected?.name || roomName || "Sala operativa";
  }, [effectiveRoomId, roomName, roomOptions]);
  const canLoad = Boolean(token && effectiveDeviceUuid && effectiveUserId && effectiveRoomId);

  const sessionBase = useMemo(
    () => ({
      token: token || "",
      userId: effectiveUserId,
      deviceUuid: effectiveDeviceUuid,
      roomId: effectiveRoomId,
    }),
    [effectiveDeviceUuid, effectiveRoomId, effectiveUserId, token]
  );

  const reservationsQuery = useQuery({
    queryKey: reservationsQueryKey(effectiveRoomId, serviceDate),
    enabled: canLoad,
    queryFn: () =>
      fetchReservationsForDay({
        ...sessionBase,
        serviceDate,
      }),
    staleTime: 10_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const tablesQuery = useQuery({
    queryKey: tablesQueryKey(effectiveRoomId),
    enabled: canLoad,
    queryFn: () =>
      fetchTablesForSession({
        ...sessionBase,
      }),
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const reservationList = reservationsQuery.data?.reservations ?? [];
  const sortedReservations = useMemo(
    () => [...reservationList].sort((left, right) => left.reservationAt - right.reservationAt),
    [reservationList]
  );
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();

  const selectedReservation = useMemo(
    () =>
      sortedReservations.find((reservation) => reservation.id === selectedReservationId) ?? null,
    [selectedReservationId, sortedReservations]
  );
  const reservationStatusDropdownOptions = useMemo(() => {
    const options = reservationStatusOptions.map((option) => ({
      ...option,
      disabled:
        mode === "edit" &&
        option.value === "booked" &&
        selectedReservation !== null &&
        selectedReservation.status !== "booked",
    }));
    if (form.status === "released" || selectedReservation?.status === "released") {
      options.push({ value: "released", label: "Chiusa", disabled: true });
    }
    return options;
  }, [form.status, mode, selectedReservation]);

  const tableItems = useMemo(
    () =>
      [...(tablesQuery.data?.tables ?? [])]
        .sort((left, right) => left.number - right.number)
        .map((table) => ({
          id: table.id,
          number: table.number,
        })),
    [tablesQuery.data?.tables]
  );
  const tableById = useMemo(
    () => new Map((tablesQuery.data?.tables ?? []).map((table) => [table.id, table])),
    [tablesQuery.data?.tables]
  );
  const tableNumberById = useMemo(
    () => new Map(tableItems.map((table) => [table.id, table.number])),
    [tableItems]
  );
  const formatReservationTableLabel = useCallback(
    (reservation: Pick<DiningReservation, "assignedTableId" | "assignedTableIds">) => {
      const tableIds = reservation.assignedTableIds.length
        ? reservation.assignedTableIds
        : reservation.assignedTableId
          ? [reservation.assignedTableId]
          : [];
      const tableNumbers = tableIds
        .map((tableId) => tableNumberById.get(tableId))
        .filter((number): number is number => typeof number === "number");
      if (tableNumbers.length === 0) {
        if (tableIds.length === 0) return "Non assegnato";
        return tableIds.length === 1 ? "Tavolo assegnato" : "Tavoli assegnati";
      }
      return tableNumbers.length === 1
        ? `Tavolo ${tableNumbers[0]}`
        : `Tavoli ${tableNumbers.join(", ")}`;
    },
    [tableNumberById]
  );
  const selectedReservationAt = useMemo(
    () => toTimestamp(serviceDate, form.reservationTime),
    [form.reservationTime, serviceDate]
  );
  const tableWindowHints = useMemo(() => {
    const map = new Map<string, ReservationTableWindowHint>();
    const selectedWithinWindow = shouldReserveTableForReservation(
      selectedReservationAt,
      reservationWindowNow
    );

    (tablesQuery.data?.tables ?? []).forEach((table) => {
      const preview = table.reservationPreview ?? null;
      if (preview) {
        const time = toClockTime(preview.reservationAt);
        map.set(table.id, {
          tone: preview.shouldWarnRelease
            ? "warning"
            : preview.withinBlockWindow
              ? "reserved"
              : "preview",
          label: preview.shouldWarnRelease ? "Lascia 10'" : `Pren. ${time}`,
          detail: preview.shouldWarnRelease
            ? `Tavolo occupato con prenotazione alle ${time}: va lasciato entro 10 minuti.`
            : preview.withinBlockWindow
              ? `Prenotazione attiva alle ${time}.`
              : `Prenotazione futura alle ${time}: il tavolo resta utilizzabile fino a 30 minuti prima.`,
          requiresConfirmation: false,
        });
      }

      if (
        selectedWithinWindow &&
        shouldWarnTableReleaseForReservation(
          table,
          selectedReservationAt,
          form.customerName,
          form.customerPhone,
          reservationWindowNow
        )
      ) {
        const time = toClockTime(selectedReservationAt);
        map.set(table.id, {
          tone: "warning",
          label: "Lascia 10'",
          detail: `Il tavolo e' gia occupato: per assegnare questa prenotazione delle ${time} va lasciato entro 10 minuti.`,
          requiresConfirmation: true,
        });
        return;
      }

      if (
        selectedWithinWindow &&
        form.assignedTableIds.includes(table.id) &&
        table.occupancyState === "free"
      ) {
        const time = toClockTime(selectedReservationAt);
        map.set(table.id, {
          tone: "reserved",
          label: `Pren. ${time}`,
          detail: `Questa prenotazione e' nei 30 minuti: dopo il salvataggio il tavolo risulta prenotato.`,
          requiresConfirmation: false,
        });
      }
    });

    return map;
  }, [
    form.assignedTableIds,
    form.customerName,
    form.customerPhone,
    reservationWindowNow,
    selectedReservationAt,
    tablesQuery.data?.tables,
  ]);

  const filteredReservations = useMemo(() => {
    if (!normalizedSearchQuery) return sortedReservations;
    return sortedReservations.filter((reservation) => {
      const reservationTableIds = reservation.assignedTableIds.length
        ? reservation.assignedTableIds
        : reservation.assignedTableId
          ? [reservation.assignedTableId]
          : [];
      const tableNumbers = reservationTableIds
        .map((tableId) => tableNumberById.get(tableId))
        .filter((number): number is number => typeof number === "number");
      const byName = reservation.customerName.toLowerCase().includes(normalizedSearchQuery);
      const byPhone = reservation.customerPhone.toLowerCase().includes(normalizedSearchQuery);
      const byTime = toClockTime(reservation.reservationAt).includes(normalizedSearchQuery);
      const byTable = tableNumbers.some((number) => String(number).includes(normalizedSearchQuery));
      return byName || byPhone || byTime || byTable;
    });
  }, [normalizedSearchQuery, sortedReservations, tableNumberById]);

  useEffect(() => {
    if (sortedReservations.length === 0) {
      setSelectedReservationId(null);
      if (mode === "view") {
        setForm(createEmptyForm());
      }
      return;
    }
    if (!selectedReservationId) {
      setSelectedReservationId(sortedReservations[0].id);
      return;
    }
    const stillExists = sortedReservations.some(
      (reservation) => reservation.id === selectedReservationId
    );
    if (!stillExists) {
      setSelectedReservationId(sortedReservations[0].id);
    }
  }, [mode, selectedReservationId, sortedReservations]);

  useEffect(() => {
    if (mode !== "view" || !selectedReservation) return;
    setForm(reservationToForm(selectedReservation));
  }, [mode, selectedReservation]);

  const availabilityQuery = useQuery({
    queryKey: [
      "reservation-table-availability",
      effectiveRoomId,
      serviceDate,
      form.reservationTime,
      mode === "edit" ? selectedReservationId : "new",
      tableItems.map((item) => item.id).join(","),
    ],
    enabled: canLoad && (mode === "edit" || mode === "create") && tableItems.length > 0,
    queryFn: () =>
      fetchReservationTableAvailability({
        ...sessionBase,
        serviceDate,
        reservationAt: selectedReservationAt,
        reservationIdToIgnore: mode === "edit" ? (selectedReservationId ?? undefined) : undefined,
        tableIds: tableItems.map((item) => item.id),
      }),
    staleTime: 2_000,
    refetchOnWindowFocus: false,
  });

  const availabilityByTableId = useMemo(() => {
    const map = new Map<string, TableAvailabilityInfo>();
    (availabilityQuery.data ?? []).forEach((entry) => {
      map.set(entry.tableId, entry);
    });
    return map;
  }, [availabilityQuery.data]);

  useEffect(() => {
    lockStateRef.current = lockState;
  }, [lockState]);

  const releaseLock = useCallback(async () => {
    const currentLock = lockStateRef.current;
    if (!currentLock) return;
    try {
      await releaseReservationEditLock({
        ...sessionBase,
        reservationId: currentLock.reservationId,
        lockId: currentLock.lockId,
      });
    } catch {
      // ignore release errors
    } finally {
      lockStateRef.current = null;
      setLockState(null);
    }
  }, [sessionBase]);

  const selectReservationRoom = useCallback(
    (nextRoomId: string) => {
      const safeRoomId = nextRoomId.trim();
      if (!safeRoomId || safeRoomId === effectiveRoomId) return;
      void releaseLock();
      setSelectedRoomId(safeRoomId);
      setSelectedReservationId(null);
      setMode("view");
      setViewOpen(false);
      setAssignTableOpen(false);
      setIntoleranceEditorOpen(false);
      setDialog(null);
      setLockState(null);
      setActionError(null);
      setForm(createEmptyForm());
      setCustomIntoleranceDraft("");
    },
    [effectiveRoomId, releaseLock]
  );

  const selectServiceDate = useCallback(
    (nextValue: string) => {
      if (!canChangeServiceDate) return;
      const nextDate = normalizeDateKey(nextValue);
      if (!nextDate) return;
      if (dateKeyIsBefore(nextDate, todayServiceDate)) {
        setActionError("Non puoi selezionare una data passata.");
        return;
      }
      setActionError(null);
      setServiceDate((prev) => (prev === nextDate ? prev : nextDate));
    },
    [canChangeServiceDate, todayServiceDate]
  );

  useEffect(() => {
    void releaseLock();
    setMode("view");
    setViewOpen(false);
    setAssignTableOpen(false);
    setIntoleranceEditorOpen(false);
    setDialog(null);
    setLockState(null);
    setActionError(null);
    setForm(createEmptyForm());
    setCustomIntoleranceDraft("");
  }, [releaseLock, serviceDate]);

  useEffect(() => {
    return () => {
      void releaseLock();
    };
  }, [releaseLock]);

  useEffect(() => {
    if (mode !== "edit" || !selectedReservationId || !lockState) return;
    const intervalId = window.setInterval(async () => {
      try {
        const refreshed = await acquireReservationEditLock({
          ...sessionBase,
          serviceDate,
          reservationId: selectedReservationId,
        });
        setLockState({
          reservationId: refreshed.reservationId,
          lockId: refreshed.lockId,
          expiresAt: refreshed.expiresAt,
        });
      } catch {
        setActionError(
          "Blocco modifica scaduto. Salva di nuovo dopo aver riaperto la prenotazione."
        );
        setMode("view");
        setLockState(null);
      }
    }, LOCK_REFRESH_MS);
    return () => window.clearInterval(intervalId);
  }, [lockState, mode, selectedReservationId, serviceDate, sessionBase]);

  const upsertReservationCache = useCallback(
    (reservation: DiningReservation) => {
      queryClient.setQueryData<ReservationSummary | undefined>(
        reservationsQueryKey(effectiveRoomId, serviceDate),
        (current) => upsertReservationSummary(current, reservation)
      );
    },
    [effectiveRoomId, queryClient, serviceDate]
  );

  const removeReservationCache = useCallback(
    (reservationId: string) => {
      queryClient.setQueryData<ReservationSummary | undefined>(
        reservationsQueryKey(effectiveRoomId, serviceDate),
        (current) => removeReservationFromSummary(current, reservationId)
      );
    },
    [effectiveRoomId, queryClient, serviceDate]
  );

  const refreshTablesAfterReservationChange = useCallback(
    async (params: {
      before?: DiningReservation | null;
      after?: DiningReservation | null;
      force?: boolean;
    }) => {
      const shouldRefresh =
        params.force === true ||
        reservationCanAffectCurrentTables(params.before, reservationWindowNow) ||
        reservationCanAffectCurrentTables(params.after, reservationWindowNow);
      if (!shouldRefresh) return;
      await queryClient.invalidateQueries({
        queryKey: tablesQueryKey(effectiveRoomId),
      });
    },
    [effectiveRoomId, queryClient, reservationWindowNow]
  );

  const openEditMode = async () => {
    if (!selectedReservation) return;
    setActionError(null);
    setActionBusy(true);
    try {
      const lock = await acquireReservationEditLock({
        ...sessionBase,
        serviceDate,
        reservationId: selectedReservation.id,
      });
      setLockState({
        reservationId: lock.reservationId,
        lockId: lock.lockId,
        expiresAt: lock.expiresAt,
      });
      setForm(reservationToForm(selectedReservation));
      setCustomIntoleranceDraft("");
      setViewOpen(true);
      setAssignTableOpen(false);
      setIntoleranceEditorOpen(false);
      setMode("edit");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Impossibile entrare in modifica.";
      setActionError(message);
    } finally {
      setActionBusy(false);
    }
  };

  const openCreateMode = async () => {
    setActionError(null);
    await releaseLock();
    setViewOpen(true);
    setAssignTableOpen(false);
    setIntoleranceEditorOpen(false);
    setMode("create");
    setForm(createEmptyForm());
    setCustomIntoleranceDraft("");
  };

  const cancelEditor = async () => {
    setActionError(null);
    setDialog(null);
    // Aperta dal tavolo: chiudere l'editor significa chiudere la modale.
    if (embed) {
      await releaseLock();
      embed.onClose();
      return;
    }
    if (mode === "edit") {
      await releaseLock();
    }
    if (mode === "create") {
      setMode("view");
      setViewOpen(false);
      setAssignTableOpen(false);
      setIntoleranceEditorOpen(false);
      setForm(createEmptyForm());
      setCustomIntoleranceDraft("");
      return;
    }
    setMode("view");
    setViewOpen(true);
    setAssignTableOpen(false);
    setIntoleranceEditorOpen(false);
    setCustomIntoleranceDraft("");
    if (selectedReservation) setForm(reservationToForm(selectedReservation));
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        reservationAt: toTimestamp(serviceDate, form.reservationTime),
        customerName: form.customerName,
        customerPhone: form.customerPhone,
        covers: normalizeTableCovers(form.covers, { fallback: 2 }),
        intolerances: form.intolerances,
        note: form.note,
        assignedTableId: form.assignedTableId,
        assignedTableIds: form.assignedTableIds,
      };

      if (mode === "create") {
        return createDiningReservation({
          ...sessionBase,
          serviceDate,
          ...payload,
        });
      }

      if (mode === "edit" && selectedReservationId && lockState) {
        return updateDiningReservation({
          ...sessionBase,
          serviceDate,
          reservationId: selectedReservationId,
          lockId: lockState.lockId,
          patch: payload,
        });
      }
      throw new Error("Stato modifica non valido.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!selectedReservationId) {
        throw new Error("Prenotazione non selezionata.");
      }
      let deleteLock =
        lockState && lockState.reservationId === selectedReservationId ? lockState : null;
      let acquiredForDelete = false;
      if (!deleteLock) {
        const lock = await acquireReservationEditLock({
          ...sessionBase,
          serviceDate,
          reservationId: selectedReservationId,
        });
        deleteLock = {
          reservationId: lock.reservationId,
          lockId: lock.lockId,
          expiresAt: lock.expiresAt,
        };
        acquiredForDelete = true;
        lockStateRef.current = deleteLock;
        setLockState(deleteLock);
      }
      try {
        await deleteDiningReservation({
          ...sessionBase,
          serviceDate,
          reservationId: selectedReservationId,
          lockId: deleteLock.lockId,
        });
      } catch (error) {
        if (acquiredForDelete) {
          await releaseReservationEditLock({
            ...sessionBase,
            reservationId: deleteLock.reservationId,
            lockId: deleteLock.lockId,
          }).catch(() => undefined);
          lockStateRef.current = null;
          setLockState(null);
        }
        throw error;
      }
    },
  });

  const statusMutation = useMutation({
    mutationFn: async (action: ReservationStatusAction) => {
      if (!selectedReservationId) {
        throw new Error("Prenotazione non selezionata.");
      }
      return updateDiningReservationStatus({
        ...sessionBase,
        serviceDate,
        reservationId: selectedReservationId,
        action,
      });
    },
  });

  const onSave = async () => {
    setActionError(null);
    if (dateKeyIsBefore(serviceDate, todayServiceDate)) {
      setActionError("Non puoi salvare prenotazioni in date passate.");
      return;
    }
    setActionBusy(true);
    try {
      const previousReservation = mode === "edit" ? selectedReservation : null;
      let tablesChangedByStatus = false;
      let updated = await saveMutation.mutateAsync();
      if (
        mode === "edit" &&
        selectedReservation &&
        form.status !== selectedReservation.status &&
        form.status !== "booked"
      ) {
        const statusResult = await updateDiningReservationStatus({
          ...sessionBase,
          serviceDate,
          reservationId: updated.id,
          action: form.status,
        });
        updated = statusResult.reservation;
        tablesChangedByStatus = statusResult.tablesChanged;
      }
      upsertReservationCache(updated);
      await refreshTablesAfterReservationChange({
        before: previousReservation,
        after: updated,
        force: tablesChangedByStatus,
      });
      if (mode === "edit") {
        await releaseLock();
      }
      setMode("view");
      setSelectedReservationId(updated.id);
      setViewOpen(false);
      setAssignTableOpen(false);
      setIntoleranceEditorOpen(false);
      // Aperta dal tavolo: salvato, la modale si chiude.
      if (embed) embed.onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Salvataggio non riuscito.";
      setActionError(message);
    } finally {
      setActionBusy(false);
    }
  };

  const onDelete = async () => {
    setActionError(null);
    setActionBusy(true);
    try {
      const deletedReservation =
        selectedReservation ??
        sortedReservations.find((reservation) => reservation.id === selectedReservationId) ??
        null;
      const deletedReservationId = selectedReservationId;
      await deleteMutation.mutateAsync();
      if (deletedReservationId) {
        removeReservationCache(deletedReservationId);
      }
      await refreshTablesAfterReservationChange({
        before: deletedReservation,
      });
      lockStateRef.current = null;
      setLockState(null);
      setDialog(null);
      setMode("view");
      setViewOpen(false);
      setAssignTableOpen(false);
      setIntoleranceEditorOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Eliminazione non riuscita.";
      setActionError(message);
    } finally {
      setActionBusy(false);
    }
  };

  const onSetReservationStatus = async (action: ReservationStatusAction) => {
    setActionError(null);
    setActionBusy(true);
    try {
      const previousReservation = selectedReservation;
      const result = await statusMutation.mutateAsync(action);
      const updated = result.reservation;
      upsertReservationCache(updated);
      await refreshTablesAfterReservationChange({
        before: previousReservation,
        after: updated,
        force: result.tablesChanged,
      });
      setDialog(null);
      setSelectedReservationId(updated.id);
      setMode("view");
      setViewOpen(true);
      setAssignTableOpen(false);
      setIntoleranceEditorOpen(false);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Aggiornamento prenotazione non riuscito.";
      setActionError(message);
    } finally {
      setActionBusy(false);
    }
  };

  const closeReservationScreen = async () => {
    if (mode === "edit") {
      await releaseLock();
    }
    setMode("view");
    setViewOpen(false);
    setAssignTableOpen(false);
    setIntoleranceEditorOpen(false);
    setDialog(null);
    setCustomIntoleranceDraft("");
  };

  const dismissTimingWarningDialog = () => {
    setDialog(null);
    setViewOpen(true);
  };

  const applyTableSelection = (tableId: string) => {
    setForm((prev) => {
      const selected = new Set(prev.assignedTableIds);
      if (selected.has(tableId)) {
        selected.delete(tableId);
      } else {
        selected.add(tableId);
      }
      const assignedTableIds = [...selected];
      return {
        ...prev,
        assignedTableId: assignedTableIds[0] ?? null,
        assignedTableIds,
      };
    });
  };

  const onSelectTable = (tableId: string) => {
    const table = tableItems.find((entry) => entry.id === tableId);
    const label = table ? `Tavolo ${table.number}` : tableId;
    const availability = availabilityByTableId.get(tableId);
    const operationalHint = tableWindowHints.get(tableId);
    if (form.assignedTableIds.includes(tableId)) {
      applyTableSelection(tableId);
      return;
    }
    if (!availability || availability.status === "free" || availability.status === "safe") {
      if (operationalHint?.requiresConfirmation) {
        setDialog({
          type: "assign-release-warning",
          tableId,
          tableLabel: label,
          detail: operationalHint.detail,
        });
        return;
      }
      applyTableSelection(tableId);
      return;
    }
    if (availability.status === "conflict") {
      setActionError("");
      return;
    }
    if (operationalHint?.requiresConfirmation) {
      setDialog({
        type: "assign-release-warning",
        tableId,
        tableLabel: label,
        detail: `${operationalHint.detail}\n${availability.label}`,
      });
      return;
    }
    if (availability.status === "warning") {
      setDialog({
        type: "assign-warning",
        tableId,
        tableLabel: label,
        detail: availability.label,
      });
      return;
    }
    setDialog({
      type: "assign-danger-step1",
      tableId,
      tableLabel: label,
      detail: availability.label,
    });
  };

  const intoleranceTokens = useMemo(
    () => parseIntoleranceTokens(form.intolerances),
    [form.intolerances]
  );

  const presetTokenSet = useMemo(
    () => new Set(HACCP_INTOLERANCE_OPTIONS.map((entry) => entry.toLowerCase())),
    []
  );

  const customIntoleranceTokens = useMemo(
    () => intoleranceTokens.filter((entry) => !presetTokenSet.has(entry.toLowerCase())),
    [intoleranceTokens, presetTokenSet]
  );

  const togglePresetIntolerance = (entry: string) => {
    setForm((prev) => {
      const tokens = parseIntoleranceTokens(prev.intolerances);
      const hasToken = tokens.some((token) => token.toLowerCase() === entry.toLowerCase());
      const nextTokens = hasToken
        ? tokens.filter((token) => token.toLowerCase() !== entry.toLowerCase())
        : [...tokens, entry];
      return {
        ...prev,
        intolerances: composeIntoleranceTokens(nextTokens),
      };
    });
  };

  const addCustomIntolerance = () => {
    const token = customIntoleranceDraft.trim();
    if (!token) return;
    setForm((prev) => {
      const tokens = parseIntoleranceTokens(prev.intolerances);
      if (tokens.some((entry) => entry.toLowerCase() === token.toLowerCase())) {
        return prev;
      }
      return {
        ...prev,
        intolerances: composeIntoleranceTokens([...tokens, token]),
      };
    });
    setCustomIntoleranceDraft("");
    setCustomIntoleranceModalOpen(false);
  };

  const removeCustomIntolerance = (tokenToRemove: string) => {
    setForm((prev) => {
      const tokens = parseIntoleranceTokens(prev.intolerances).filter(
        (entry) => entry.toLowerCase() !== tokenToRemove.toLowerCase()
      );
      return {
        ...prev,
        intolerances: composeIntoleranceTokens(tokens),
      };
    });
  };

  const tableLegend = useMemo(
    () =>
      (["free", "safe", "warning", "danger", "conflict"] as ReservationStatusColor[]).map(
        (status) => ({
          status,
          label: statusLegendLabel[status],
        })
      ),
    []
  );

  const listLoading = reservationsQuery.isLoading;
  const canShowReservationList = canLoad && !reservationsQuery.isError;
  const noReservations = reservationList.length === 0;
  const noFilteredReservations = filteredReservations.length === 0;
  const isEditing = mode === "edit" || mode === "create";
  const showReservationScreen = isEditing || (viewOpen && Boolean(selectedReservation));

  // Apertura dal tavolo: seleziona la prenotazione e entra subito in modifica.
  const embedOpenedRef = useRef(false);
  useEffect(() => {
    if (!embed) return;
    setSelectedRoomId(embed.roomId);
    setServiceDate(embed.serviceDate);
    setSelectedReservationId(embed.reservationId);
    setViewOpen(true);
  }, [embed]);
  const openEditModeRef = useRef(openEditMode);
  useEffect(() => {
    openEditModeRef.current = openEditMode;
  });
  useEffect(() => {
    if (!embed || embedOpenedRef.current) return;
    if (!selectedReservation || selectedReservation.id !== embed.reservationId) return;
    embedOpenedRef.current = true;
    void openEditModeRef.current();
  }, [embed, selectedReservation]);
  const isAssignTableScreen = isEditing && assignTableOpen;
  const isIntoleranceScreen = isEditing && intoleranceEditorOpen;
  const serviceDateLabel = useMemo(() => {
    const [year, month, day] = serviceDate.split("-").map((entry) => Number(entry));
    return `${String(day || 1).padStart(2, "0")}/${String(month || 1).padStart(2, "0")}/${String(year || new Date().getFullYear())}`;
  }, [serviceDate]);
  const selectedTableNumbers = form.assignedTableIds
    .map((tableId) => tableNumberById.get(tableId))
    .filter((number): number is number => typeof number === "number");
  const selectedTableLabel =
    selectedTableNumbers.length > 0
      ? selectedTableNumbers.length === 1
        ? `Tavolo ${selectedTableNumbers[0]}`
        : `Tavoli ${selectedTableNumbers.join(", ")}`
      : "Nessun tavolo";

  return (
    <GlassCard className="home-card workspace-card reservations-card">
      <div className="card-body reservations-body">
        {!embed ? (
        <div className="reservations-head" data-mobile-reservations-header-ready="1">
          <div
            className={`reservations-date-picker reservations-date-display mobile-reservations-date-box ${
              canChangeServiceDate ? "is-editable" : ""
            }`}
          >
            {canChangeServiceDate ? (
              <input
                id="reservations-service-date"
                name="reservations_service_date"
                type="date"
                value={serviceDate}
                min={todayServiceDate}
                onChange={(event) => selectServiceDate(event.target.value)}
                disabled={actionBusy}
                aria-label="Data prenotazioni"
              />
            ) : (
              <strong>{serviceDateLabel}</strong>
            )}
          </div>
          <div className="reservations-room-action-row">
            <label className="reservations-room-picker mobile-reservations-room-picker">
              <GlassDropdown
                value={effectiveRoomId}
                options={roomDropdownOptions}
                onChange={selectReservationRoom}
                disabled={actionBusy || roomsQuery.isLoading || roomOptions.length <= 1}
                ariaLabel="Sala prenotazioni"
                placeholder="Nessuna sala"
                className="reservations-room-dropdown"
              />
            </label>
            {canShowReservationList ? (
              <button
                type="button"
                className="reservations-add-btn mobile-reservations-add-btn"
                onClick={openCreateMode}
                disabled={actionBusy || listLoading}
                aria-label="Nuova prenotazione"
                title="Nuova prenotazione"
              >
                +
              </button>
            ) : null}
          </div>
        </div>
        ) : null}

        {actionError ? <div className="reservations-banner is-error">{actionError}</div> : null}

        {!canLoad ? (
          <div className="reservations-empty">
            Sessione non valida. Effettua nuovamente il login.
          </div>
        ) : reservationsQuery.isError ? (
          <div className="reservations-empty">Errore caricamento prenotazioni.</div>
        ) : (
          <div className="reservations-layout">
            <aside className="reservations-list">
              <div className="reservations-search">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M20 20l-3.2-3.2" />
                </svg>
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Cerca per orario, nome, telefono, tavolo"
                  aria-label="Ricerca prenotazioni"
                />
              </div>
              {listLoading ? (
                <div className="reservations-empty-list">Caricamento prenotazioni...</div>
              ) : noReservations ? (
                <div className="reservations-empty-list">
                  Nessuna prenotazione nel giorno selezionato.
                </div>
              ) : noFilteredReservations ? (
                <div className="reservations-empty-list">Nessuna prenotazione trovata.</div>
              ) : (
                filteredReservations.map((reservation) => (
                  <button
                    key={reservation.id}
                    type="button"
                    className={`reservations-row ${selectedReservationId === reservation.id ? "is-selected" : ""}`}
                    disabled={isEditing}
                    onClick={() => {
                      if (isEditing) return;
                      setSelectedReservationId(reservation.id);
                      setViewOpen(true);
                      setActionError(null);
                    }}
                  >
                    <div className="reservations-row-time">
                      {toClockTime(reservation.reservationAt)}
                    </div>
                    <div className="reservations-row-main">
                      <div className="reservations-row-name">{reservation.customerName}</div>
                      <div className="reservations-row-meta">
                        <span className="reservations-row-meta-text">
                          {reservation.covers} pers.
                          {` - ${formatReservationTableLabel(reservation)}`}
                        </span>
                        <ReservationIntoleranceBadge value={reservation.intolerances} />
                      </div>
                    </div>
                    <span
                      className={`reservations-status-badge ${reservationStatusClass[reservation.status]}`}
                      title={reservationStatusLabel[reservation.status]}
                      aria-label={reservationStatusLabel[reservation.status]}
                    >
                      <ReservationStatusIcon status={reservation.status} />
                    </span>
                  </button>
                ))
              )}
            </aside>

            {showReservationScreen && (
              <div className="reservations-screen-backdrop">
                <section
                  className={`reservations-detail reservations-screen reservations-screen-card ${
                    isEditing ? "is-editing" : "is-viewing"
                  }`}
                >
                  {!isEditing && selectedReservation ? (
                    <>
                      <div className="reservations-detail-head">
                        <div className="reservations-detail-title">
                          {reservationLabel(selectedReservation)}
                        </div>
                        <div className="reservations-detail-actions">
                          <button
                            type="button"
                            className="smallbtn reservations-icon-btn"
                            onClick={openEditMode}
                            disabled={actionBusy}
                            aria-label="Modifica prenotazione"
                            title="Modifica"
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M3 17.25V21h3.75L18.8 8.95l-3.75-3.75L3 17.25z" />
                              <path d="M14.75 5.25l3.75 3.75" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className="smallbtn reservations-icon-btn is-close"
                            onClick={closeReservationScreen}
                            disabled={actionBusy}
                            aria-label="Chiudi dettaglio prenotazione"
                            title="Chiudi"
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M6 6l12 12" />
                              <path d="M18 6l-12 12" />
                            </svg>
                          </button>
                        </div>
                      </div>

                      <div className="reservations-detail-view-body">
                        <div className="reservations-fields">
                          <div className="reservations-field">
                            <span>Nome</span>
                            <strong>{selectedReservation.customerName || "-"}</strong>
                          </div>
                          <div className="reservations-field">
                            <span>Telefono</span>
                            <strong>{selectedReservation.customerPhone || "-"}</strong>
                          </div>
                          <div className="reservations-field is-time">
                            <span>Orario</span>
                            <strong>{toClockTime(selectedReservation.reservationAt)}</strong>
                          </div>
                          <div className="reservations-field is-covers">
                            <span>Persone</span>
                            <strong>{selectedReservation.covers}</strong>
                          </div>
                          <div className="reservations-field">
                            <span>Intolleranze</span>
                            <strong>{selectedReservation.intolerances || "-"}</strong>
                          </div>
                          <div className="reservations-field">
                            <span>Note</span>
                            <strong>{selectedReservation.note || "-"}</strong>
                          </div>
                          <div className="reservations-field">
                            <span>Tavoli assegnati</span>
                            <strong>{formatReservationTableLabel(selectedReservation)}</strong>
                          </div>
                          <div className="reservations-field is-status">
                            <span>Stato</span>
                            <strong
                              className={`reservations-status-inline ${reservationStatusClass[selectedReservation.status]}`}
                            >
                              <ReservationStatusIcon status={selectedReservation.status} />
                              {reservationStatusLabel[selectedReservation.status]}
                            </strong>
                          </div>
                        </div>
                      </div>
                      {selectedReservation.status === "booked" ? (
                        <div className="reservations-detail-terminal-actions">
                          <button
                            type="button"
                            className="smallbtn reservations-arrived-btn"
                            onClick={() =>
                              setDialog({
                                type: "arrived",
                                reservationLabel: reservationLabel(selectedReservation),
                              })
                            }
                            disabled={actionBusy}
                          >
                            <ReservationActionIcon action="arrived" />
                            <span>Arrivati</span>
                          </button>
                          <button
                            type="button"
                            className="smallbtn reservations-noshow-btn"
                            onClick={() =>
                              setDialog({
                                type: "no_show",
                                reservationLabel: reservationLabel(selectedReservation),
                              })
                            }
                            disabled={actionBusy}
                          >
                            <ReservationActionIcon action="no_show" />
                            <span>No show</span>
                          </button>
                          <button
                            type="button"
                            className="smallbtn reservations-delete-btn"
                            onClick={() => {
                              setDialog({
                                type: "delete",
                                reservationLabel: reservationLabel(selectedReservation),
                              });
                            }}
                            disabled={actionBusy}
                          >
                            <ReservationActionIcon action="delete" />
                            <span>Elimina</span>
                          </button>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <ReservationEditorScreen
                      mode={mode}
                      isAssignTableScreen={isAssignTableScreen}
                      isIntoleranceScreen={isIntoleranceScreen}
                      actionBusy={actionBusy}
                      form={form}
                      selectedReservation={selectedReservation}
                      tableItems={tableItems}
                      tableById={tableById}
                      tableLegend={tableLegend}
                      tableWindowHints={tableWindowHints}
                      availabilityByTableId={availabilityByTableId}
                      selectedTableLabel={selectedTableLabel}
                      intoleranceTokens={intoleranceTokens}
                      customIntoleranceTokens={customIntoleranceTokens}
                      customIntoleranceDraft={customIntoleranceDraft}
                      customIntoleranceModalOpen={customIntoleranceModalOpen}
                      reservationStatusDropdownOptions={reservationStatusDropdownOptions}
                      onSelectTable={onSelectTable}
                      togglePresetIntolerance={togglePresetIntolerance}
                      addCustomIntolerance={addCustomIntolerance}
                      removeCustomIntolerance={removeCustomIntolerance}
                      cancelEditor={cancelEditor}
                      onSave={onSave}
                      setAssignTableOpen={setAssignTableOpen}
                      setIntoleranceEditorOpen={setIntoleranceEditorOpen}
                      setCustomIntoleranceDraft={setCustomIntoleranceDraft}
                      setCustomIntoleranceModalOpen={setCustomIntoleranceModalOpen}
                      setForm={setForm}
                      setDialog={setDialog}
                    />
                  )}
                </section>
              </div>
            )}
          </div>
        )}
      </div>

      {dialog ? (
        <div className="reservations-dialog-backdrop" role="presentation">
          <div
            className={`reservations-dialog ${dialog.type === "delete" ? "is-delete-notice" : ""}`}
            role="dialog"
            aria-modal="true"
          >
            {dialog.type === "delete" ? (
              <>
                <div className="reservations-dialog-title">Conferma eliminazione</div>
                <div className="reservations-dialog-body">
                  Stai per eliminare/chiudere la prenotazione{" "}
                  <strong>{dialog.reservationLabel}</strong>. La prenotazione verra' rimossa subito
                  dalla lista.
                </div>
                <div className="reservations-dialog-actions">
                  <button type="button" className="smallbtn" onClick={dismissTimingWarningDialog}>
                    Annulla
                  </button>
                  <button
                    type="button"
                    className="smallbtn danger"
                    onClick={() => {
                      void onDelete();
                    }}
                    disabled={actionBusy}
                  >
                    Conferma elimina
                  </button>
                </div>
              </>
            ) : null}

            {dialog.type === "arrived" ? (
              <>
                <div className="reservations-dialog-title">Conferma arrivo</div>
                <div className="reservations-dialog-body">
                  Segno come arrivata la prenotazione <strong>{dialog.reservationLabel}</strong>.
                </div>
                <div className="reservations-dialog-actions">
                  <button type="button" className="smallbtn" onClick={dismissTimingWarningDialog}>
                    Annulla
                  </button>
                  <button
                    type="button"
                    className="smallbtn primary"
                    onClick={() => void onSetReservationStatus("arrived")}
                    disabled={actionBusy}
                  >
                    Conferma arrivati
                  </button>
                </div>
              </>
            ) : null}

            {dialog.type === "no_show" ? (
              <>
                <div className="reservations-dialog-title">Conferma no show</div>
                <div className="reservations-dialog-body">
                  Segno come no show la prenotazione <strong>{dialog.reservationLabel}</strong>.
                </div>
                <div className="reservations-dialog-actions">
                  <button type="button" className="smallbtn" onClick={dismissTimingWarningDialog}>
                    Annulla
                  </button>
                  <button
                    type="button"
                    className="smallbtn danger"
                    onClick={() => void onSetReservationStatus("no_show")}
                    disabled={actionBusy}
                  >
                    Conferma no show
                  </button>
                </div>
              </>
            ) : null}

            {dialog.type === "assign-warning" ? (
              <>
                <div className="reservations-dialog-title">{dialog.tableLabel}</div>
                <div className="reservations-dialog-body">
                  Distanza inferiore a 2 ore. Avvisa il cliente prima di confermare.
                  <br />
                  {dialog.detail}
                </div>
                <div className="reservations-dialog-actions">
                  <button type="button" className="smallbtn" onClick={dismissTimingWarningDialog}>
                    Annulla
                  </button>
                  <button
                    type="button"
                    className="smallbtn primary"
                    onClick={() => {
                      applyTableSelection(dialog.tableId);
                      setDialog(null);
                    }}
                  >
                    Conferma tavolo
                  </button>
                </div>
              </>
            ) : null}

            {dialog.type === "assign-release-warning" ? (
              <>
                <div className="reservations-dialog-title">{dialog.tableLabel}</div>
                <div className="reservations-dialog-body">
                  {dialog.detail}
                  <br />
                  Confermi comunque l'assegnazione?
                </div>
                <div className="reservations-dialog-actions">
                  <button type="button" className="smallbtn" onClick={dismissTimingWarningDialog}>
                    Annulla
                  </button>
                  <button
                    type="button"
                    className="smallbtn warning"
                    onClick={() => {
                      applyTableSelection(dialog.tableId);
                      setDialog(null);
                    }}
                  >
                    Conferma tavolo
                  </button>
                </div>
              </>
            ) : null}

            {dialog.type === "assign-danger-step1" ? (
              <>
                <div className="reservations-dialog-title">{dialog.tableLabel}</div>
                <div className="reservations-dialog-body">
                  Prenotazione a meno di 90 minuti da un'altra assegnazione.
                  <br />
                  {dialog.detail}
                </div>
                <div className="reservations-dialog-actions">
                  <button type="button" className="smallbtn" onClick={dismissTimingWarningDialog}>
                    Annulla
                  </button>
                  <button
                    type="button"
                    className="smallbtn warning"
                    onClick={() =>
                      setDialog({
                        type: "assign-danger-step2",
                        tableId: dialog.tableId,
                        tableLabel: dialog.tableLabel,
                        detail: dialog.detail,
                      })
                    }
                  >
                    Continua
                  </button>
                </div>
              </>
            ) : null}

            {dialog.type === "assign-danger-step2" ? (
              <>
                <div className="reservations-dialog-title">{dialog.tableLabel}</div>
                <div className="reservations-dialog-body">
                  Rischio elevato di sovrapposizione operativa. Confermare comunque il tavolo?
                </div>
                <div className="reservations-dialog-actions">
                  <button type="button" className="smallbtn" onClick={() => setDialog(null)}>
                    Annulla
                  </button>
                  <button
                    type="button"
                    className="smallbtn danger"
                    onClick={() => {
                      applyTableSelection(dialog.tableId);
                      setDialog(null);
                    }}
                  >
                    Conferma rischio
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </GlassCard>
  );
}
