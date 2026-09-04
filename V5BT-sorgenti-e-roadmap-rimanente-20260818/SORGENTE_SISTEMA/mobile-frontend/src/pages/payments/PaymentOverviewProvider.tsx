import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  getActiveAutomaticCashMovement,
  getAutomaticCashGatewayState,
  getAutomaticCashStatus,
} from "../../api/automaticCash";
import { getActiveCashExchange } from "../../api/cashExchange";
import { getPaymentTerminals, type PaymentTerminal } from "../../api/paymentOverview";
import { subscribeMobileSessionEnding } from "../../app/session/sessionLifecycle";
import { useAuthStore } from "../../store/authStore";
import { usePaymentSettingsStore } from "../../store/paymentSettingsStore";
import type {
  AutomaticCashGatewayState,
  AutomaticCashStatus,
  CashMovementRecord,
} from "../../types/automaticCash";
import type { ActiveCashExchange } from "../../types/cashExchange";

const OPERATIONAL_POLL_MS = 10_000;
const TERMINALS_POLL_MS = 60_000;
const QUERY_GC_MS = 6 * 60 * 60 * 1_000;
const GATEWAY_OPERATIONAL_MAX_AGE_MS = OPERATIONAL_POLL_MS * 3;

type PaymentOverviewSource =
  | "terminals"
  | "automatic-cash-status"
  | "automatic-cash-gateway"
  | "active-cash-exchange"
  | "active-cash-movement";

type PaymentOverviewSession = {
  token: string;
  userId: string;
  deviceUuid: string;
  sessionStartedAt: number;
};

// Kept with the provider so every observer uses the exact same cache namespace.
// eslint-disable-next-line react-refresh/only-export-components
export const paymentOverviewQueryKeys = {
  root: ["payment-overview"] as const,
  session: (session: PaymentOverviewSession) =>
    [
      ...paymentOverviewQueryKeys.root,
      session.userId,
      session.deviceUuid,
      session.sessionStartedAt,
    ] as const,
  source: (session: PaymentOverviewSession, source: PaymentOverviewSource) =>
    [...paymentOverviewQueryKeys.session(session), source] as const,
  inactive: (source: PaymentOverviewSource) =>
    [...paymentOverviewQueryKeys.root, "inactive", source] as const,
};

function isCurrentSession(session: PaymentOverviewSession) {
  const current = useAuthStore.getState();
  return (
    current.token === session.token &&
    current.userId === session.userId &&
    current.deviceUuid === session.deviceUuid &&
    current.sessionStartedAt === session.sessionStartedAt &&
    current.permissions.includes("collect_payments")
  );
}

async function keepResultForCurrentSession<T>(
  session: PaymentOverviewSession,
  load: () => Promise<T>
): Promise<T> {
  const value = await load();
  if (!isCurrentSession(session)) {
    throw new DOMException("Payment overview session ended", "AbortError");
  }
  return value;
}

function reconcileAutomaticCashStatus(status: AutomaticCashStatus) {
  const paymentState = usePaymentSettingsStore.getState();
  const activeCashFloat = status.cashFloat;
  const totalCents = Number(activeCashFloat?.totalCents);

  if (
    status.settlementAllowed === true &&
    activeCashFloat?.status === "ACTIVE" &&
    activeCashFloat.cashFloatId &&
    Number.isFinite(totalCents)
  ) {
    const loadedAtMs = Number(activeCashFloat.loadedAtMs);
    if (
      paymentState.cashMode !== "auto" ||
      paymentState.autoCashFloatId !== activeCashFloat.cashFloatId ||
      paymentState.autoCashFloatLoaded !== true ||
      paymentState.cashFloatLocked !== true
    ) {
      paymentState.lockAutoCashFloat({
        id: activeCashFloat.cashFloatId,
        value: Math.max(0, totalCents) / 100,
        qrPayload: activeCashFloat.qrPayload ?? "",
        createdAtMs:
          Number.isFinite(loadedAtMs) && loadedAtMs > 0 ? Math.trunc(loadedAtMs) : Date.now(),
        assignmentId: activeCashFloat.assignmentId ?? null,
        combinationId: activeCashFloat.combinationId ?? null,
        businessEveningKey: activeCashFloat.businessEveningKey ?? null,
      });
    }
    return;
  }

  if (paymentState.cashMode === "auto" && paymentState.autoCashFloatLoaded) {
    paymentState.clearCashFloat();
  }
}

function reconcileSelectedPaymentTerminal(terminals: PaymentTerminal[]) {
  const paymentState = usePaymentSettingsStore.getState();
  const selectedId = String(paymentState.posId ?? "").trim();
  if (!selectedId) return;
  const selectedIsOperational = terminals.some(
    (terminal) => terminal.enabled && terminal.id === selectedId
  );
  if (!selectedIsOperational) paymentState.setPosId(null);
}

function usePaymentOverviewSession(): PaymentOverviewSession | null {
  const token = useAuthStore((state) => state.token);
  const userId = useAuthStore((state) => state.userId);
  const deviceUuid = useAuthStore((state) => state.deviceUuid);
  const sessionStartedAt = useAuthStore((state) => state.sessionStartedAt);
  const canCollectPayments = useAuthStore((state) =>
    state.permissions.includes("collect_payments")
  );

  return useMemo(() => {
    if (!token || !userId || !deviceUuid || !sessionStartedAt || !canCollectPayments) return null;
    return { token, userId, deviceUuid, sessionStartedAt };
  }, [canCollectPayments, deviceUuid, sessionStartedAt, token, userId]);
}

function usePaymentOverviewQueries(resident: boolean) {
  const session = usePaymentOverviewSession();
  const enabled = resident && session !== null;
  const sourceKey = (source: PaymentOverviewSource) =>
    session
      ? paymentOverviewQueryKeys.source(session, source)
      : paymentOverviewQueryKeys.inactive(source);

  const terminals = useQuery({
    queryKey: sourceKey("terminals"),
    enabled,
    queryFn: ({ signal }) =>
      keepResultForCurrentSession(session!, () => getPaymentTerminals(signal)),
    staleTime: TERMINALS_POLL_MS / 2,
    gcTime: QUERY_GC_MS,
    retry: false,
    refetchInterval: TERMINALS_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
  const automaticCashStatus = useQuery({
    queryKey: sourceKey("automatic-cash-status"),
    enabled,
    queryFn: ({ signal }) =>
      keepResultForCurrentSession(session!, () => getAutomaticCashStatus({ signal })),
    staleTime: OPERATIONAL_POLL_MS / 2,
    gcTime: QUERY_GC_MS,
    retry: false,
    refetchInterval: OPERATIONAL_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
  const automaticCashGateway = useQuery({
    queryKey: sourceKey("automatic-cash-gateway"),
    enabled,
    queryFn: ({ signal }) =>
      keepResultForCurrentSession(session!, () => getAutomaticCashGatewayState({ signal })),
    staleTime: OPERATIONAL_POLL_MS / 2,
    gcTime: QUERY_GC_MS,
    retry: false,
    refetchInterval: OPERATIONAL_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
  const activeCashExchange = useQuery({
    queryKey: sourceKey("active-cash-exchange"),
    enabled,
    queryFn: ({ signal }) =>
      keepResultForCurrentSession(session!, () => getActiveCashExchange({ signal })),
    staleTime: OPERATIONAL_POLL_MS / 2,
    gcTime: QUERY_GC_MS,
    retry: false,
    refetchInterval: OPERATIONAL_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
  const activeCashMovement = useQuery({
    queryKey: sourceKey("active-cash-movement"),
    enabled,
    queryFn: ({ signal }) =>
      keepResultForCurrentSession(session!, () => getActiveAutomaticCashMovement({ signal })),
    staleTime: OPERATIONAL_POLL_MS / 2,
    gcTime: QUERY_GC_MS,
    retry: false,
    refetchInterval: OPERATIONAL_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });

  return {
    session,
    terminals,
    automaticCashStatus,
    automaticCashGateway,
    activeCashExchange,
    activeCashMovement,
  };
}

function clearPaymentOverviewQueries(queryClient: QueryClient) {
  void queryClient.cancelQueries({ queryKey: paymentOverviewQueryKeys.root });
  queryClient.removeQueries({ queryKey: paymentOverviewQueryKeys.root });
}

function usePaymentOverviewBackgroundSync() {
  const queryClient = useQueryClient();
  const queries = usePaymentOverviewQueries(true);

  useEffect(() => {
    const status = queries.automaticCashStatus.data;
    if (!queries.session || !status || !isCurrentSession(queries.session)) return;
    reconcileAutomaticCashStatus(status);
  }, [queries.automaticCashStatus.data, queries.session]);

  useEffect(() => {
    const terminals = queries.terminals.data;
    if (!queries.session || !terminals || queries.terminals.isError) return;
    if (!isCurrentSession(queries.session)) return;
    reconcileSelectedPaymentTerminal(terminals);
  }, [queries.session, queries.terminals.data, queries.terminals.isError]);

  useEffect(
    () => subscribeMobileSessionEnding(() => clearPaymentOverviewQueries(queryClient)),
    [queryClient]
  );
}

export type PaymentOverviewSnapshot = {
  paymentTerminals: PaymentTerminal[];
  paymentTerminalsLoading: boolean;
  paymentTerminalsError: boolean;
  automaticCashStatus: AutomaticCashStatus | null;
  automaticCashGatewayState: AutomaticCashGatewayState | null;
  activeCashExchange: ActiveCashExchange | null;
  activeCashMovement: CashMovementRecord | null;
  runtimeLoading: boolean;
  runtimeGatewayError: boolean;
  gatewayOperational: boolean;
  usingCachedData: boolean;
  lastUpdatedAt: number;
  refreshRuntime: () => Promise<void>;
};

// The page hook intentionally shares the resident provider's query definitions.
// eslint-disable-next-line react-refresh/only-export-components
export function usePaymentOverviewSnapshot(): PaymentOverviewSnapshot {
  const queryClient = useQueryClient();
  const queries = usePaymentOverviewQueries(false);
  const runtimeQueries = [
    queries.automaticCashStatus,
    queries.automaticCashGateway,
    queries.activeCashExchange,
    queries.activeCashMovement,
  ];
  const runtimeLoading = runtimeQueries.some((query) => query.data === undefined && !query.isError);
  const usingCachedData = [queries.terminals, ...runtimeQueries].some(
    (query) => query.data !== undefined && query.isError
  );
  const lastUpdatedAt = Math.max(
    0,
    queries.terminals.dataUpdatedAt,
    ...runtimeQueries.map((query) => query.dataUpdatedAt)
  );
  const gatewayDataAgeMs =
    queries.automaticCashGateway.dataUpdatedAt > 0
      ? Math.max(0, Date.now() - queries.automaticCashGateway.dataUpdatedAt)
      : Number.POSITIVE_INFINITY;
  const gatewayRefreshFailed = queries.automaticCashGateway.isError;
  const gatewayDataTooOld =
    queries.automaticCashGateway.data !== undefined &&
    gatewayDataAgeMs > GATEWAY_OPERATIONAL_MAX_AGE_MS;
  const gatewayOffline =
    queries.automaticCashGateway.data !== undefined &&
    typeof navigator !== "undefined" &&
    navigator.onLine === false;
  const gatewayOperational = Boolean(
    queries.automaticCashGateway.data !== undefined &&
    !gatewayRefreshFailed &&
    !gatewayDataTooOld &&
    !gatewayOffline
  );

  const refreshRuntime = useCallback(async () => {
    if (!queries.session || !isCurrentSession(queries.session)) return;
    const sources: PaymentOverviewSource[] = [
      "automatic-cash-status",
      "automatic-cash-gateway",
      "active-cash-exchange",
      "active-cash-movement",
    ];
    await Promise.all(
      sources.map((source) =>
        queryClient.invalidateQueries({
          queryKey: paymentOverviewQueryKeys.source(queries.session!, source),
        })
      )
    );
  }, [queryClient, queries.session]);

  return {
    paymentTerminals: queries.terminals.data ?? [],
    paymentTerminalsLoading: queries.terminals.data === undefined && !queries.terminals.isError,
    paymentTerminalsError: queries.terminals.data === undefined && queries.terminals.isError,
    automaticCashStatus: queries.automaticCashStatus.data ?? null,
    automaticCashGatewayState: queries.automaticCashGateway.data ?? null,
    activeCashExchange: queries.activeCashExchange.data?.activeExchange ?? null,
    activeCashMovement: queries.activeCashMovement.data?.activeMovement ?? null,
    runtimeLoading,
    runtimeGatewayError: gatewayRefreshFailed || gatewayDataTooOld || gatewayOffline,
    gatewayOperational,
    usingCachedData,
    lastUpdatedAt,
    refreshRuntime,
  };
}

export function PaymentOverviewProvider({ children }: { children: ReactNode }) {
  usePaymentOverviewBackgroundSync();
  return <>{children}</>;
}
