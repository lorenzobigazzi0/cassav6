import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveAutomaticCashMovement,
  getAutomaticCashGatewayState,
  getAutomaticCashStatus,
} from "../src/api/automaticCash";
import { getActiveCashExchange } from "../src/api/cashExchange";
import { getPaymentTerminals } from "../src/api/paymentOverview";
import { dispatchMobileSessionEnding } from "../src/app/session/sessionLifecycle";
import {
  PaymentOverviewProvider,
  paymentOverviewQueryKeys,
  usePaymentOverviewSnapshot,
} from "../src/pages/payments/PaymentOverviewProvider";
import { useAuthStore } from "../src/store/authStore";
import { usePaymentSettingsStore } from "../src/store/paymentSettingsStore";

vi.mock("../src/api/automaticCash", () => ({
  getActiveAutomaticCashMovement: vi.fn(),
  getAutomaticCashGatewayState: vi.fn(),
  getAutomaticCashStatus: vi.fn(),
}));

vi.mock("../src/api/cashExchange", () => ({
  getActiveCashExchange: vi.fn(),
}));

vi.mock("../src/api/paymentOverview", () => ({
  getPaymentTerminals: vi.fn(),
}));

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
}

function SnapshotProbe() {
  const snapshot = usePaymentOverviewSnapshot();
  return (
    <output data-testid="payment-overview-snapshot">
      {[
        snapshot.paymentTerminals[0]?.label ?? "none",
        String(snapshot.automaticCashGatewayState?.reachable ?? false),
        String(snapshot.usingCachedData),
        String(snapshot.runtimeGatewayError),
        String(snapshot.gatewayOperational),
      ].join("|")}
    </output>
  );
}

function renderRuntime(queryClient: QueryClient, withSnapshot = false) {
  return render(
    <QueryClientProvider client={queryClient}>
      <PaymentOverviewProvider>
        {withSnapshot ? <SnapshotProbe /> : <div>Altra pagina</div>}
      </PaymentOverviewProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
  useAuthStore.setState({
    token: "token-payment",
    userId: "user-payment",
    deviceUuid: "device-payment",
    sessionStartedAt: 1_785_000_000_000,
    permissions: ["collect_payments"],
  });
  usePaymentSettingsStore.getState().setPosId(null);
  vi.mocked(getPaymentTerminals).mockResolvedValue([
    { id: "pos-1", label: "POS Banco", enabled: true },
  ]);
  vi.mocked(getAutomaticCashStatus).mockResolvedValue({
    enabled: true,
    gatewayConfigured: true,
    feedbackEnabled: true,
    cashFloatMode: "manual",
    cashFloat: null,
    settlementAllowed: false,
  });
  vi.mocked(getAutomaticCashGatewayState).mockResolvedValue({
    configured: true,
    reachable: true,
    busy: false,
  });
  vi.mocked(getActiveCashExchange).mockResolvedValue({ ok: true, activeExchange: null });
  vi.mocked(getActiveAutomaticCashMovement).mockResolvedValue({
    ok: true,
    activeMovement: null,
  });
});

afterEach(() => cleanup());

describe("payment overview resident runtime", () => {
  it("is invalidated by the central settings-version sync", () => {
    const settingsSync = readFileSync(
      resolve(process.cwd(), "src/app/runtime/useSettingsLiveSync.ts"),
      "utf8"
    );

    expect(settingsSync).toContain('queryKeyStartsWith(queryKey, "payment-overview")');
  });

  it("loads every source outside the payments route and exposes the shared cache", async () => {
    const queryClient = createQueryClient();
    const view = renderRuntime(queryClient);

    await waitFor(() => {
      expect(getPaymentTerminals).toHaveBeenCalledTimes(1);
      expect(getAutomaticCashStatus).toHaveBeenCalledTimes(1);
      expect(getAutomaticCashGatewayState).toHaveBeenCalledTimes(1);
      expect(getActiveCashExchange).toHaveBeenCalledTimes(1);
      expect(getActiveAutomaticCashMovement).toHaveBeenCalledTimes(1);
    });

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <PaymentOverviewProvider>
          <SnapshotProbe />
        </PaymentOverviewProvider>
      </QueryClientProvider>
    );

    expect(screen.getByTestId("payment-overview-snapshot")).toHaveTextContent(
      "POS Banco|true|false|false|true"
    );
    expect(getPaymentTerminals).toHaveBeenCalledTimes(1);
  });

  it("keeps the last valid gateway snapshot after a partial refresh failure", async () => {
    const queryClient = createQueryClient();
    renderRuntime(queryClient, true);

    await waitFor(() =>
      expect(screen.getByTestId("payment-overview-snapshot")).toHaveTextContent(
        "POS Banco|true|false|false|true"
      )
    );

    vi.mocked(getAutomaticCashGatewayState).mockRejectedValueOnce(
      new Error("gateway temporarily unavailable")
    );
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: paymentOverviewQueryKeys.root });
    });

    await waitFor(() =>
      expect(screen.getByTestId("payment-overview-snapshot")).toHaveTextContent(
        "POS Banco|true|true|true|false"
      )
    );
  });

  it("disables a selected POS when a successful background refresh removes it", async () => {
    const queryClient = createQueryClient();
    usePaymentSettingsStore.getState().setPosId("pos-1");
    renderRuntime(queryClient);

    await waitFor(() => expect(getPaymentTerminals).toHaveBeenCalledTimes(1));
    expect(usePaymentSettingsStore.getState().posId).toBe("pos-1");

    vi.mocked(getPaymentTerminals).mockResolvedValueOnce([]);
    const session = {
      token: "token-payment",
      userId: "user-payment",
      deviceUuid: "device-payment",
      sessionStartedAt: 1_785_000_000_000,
    };
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: paymentOverviewQueryKeys.source(session, "terminals"),
      });
    });

    await waitFor(() => expect(usePaymentSettingsStore.getState().posId).toBeNull());
  });

  it("keeps an old gateway snapshot visible but marks it non-operational", () => {
    const queryClient = createQueryClient();
    const session = {
      token: "token-payment",
      userId: "user-payment",
      deviceUuid: "device-payment",
      sessionStartedAt: 1_785_000_000_000,
    };
    queryClient.setQueryData(
      paymentOverviewQueryKeys.source(session, "automatic-cash-gateway"),
      { configured: true, reachable: true, busy: false },
      { updatedAt: Date.now() - 60_000 }
    );

    render(
      <QueryClientProvider client={queryClient}>
        <SnapshotProbe />
      </QueryClientProvider>
    );

    expect(screen.getByTestId("payment-overview-snapshot")).toHaveTextContent(
      "none|true|false|true|false"
    );
    const paymentsPage = readFileSync(resolve(process.cwd(), "src/pages/PaymentsPage.tsx"), "utf8");
    expect(paymentsPage).toContain(
      "!cashExchangeRuntimeLoading && gatewayOperational && automaticCashGatewayListening"
    );
    expect(paymentsPage).toContain("automaticGatewayOperational={gatewayOperational}");
    const settlementSection = readFileSync(
      resolve(process.cwd(), "src/pages/payments/PaymentSettlementSection.tsx"),
      "utf8"
    );
    expect(settlementSection).toContain("if (!automaticGatewayOperational)");
  });

  it("does not fetch without collect_payments and clears the cache on logout", async () => {
    const unauthorizedClient = createQueryClient();
    useAuthStore.setState({ permissions: [] });
    renderRuntime(unauthorizedClient);

    await act(async () => {
      await Promise.resolve();
    });
    expect(getAutomaticCashStatus).not.toHaveBeenCalled();
    expect(getPaymentTerminals).not.toHaveBeenCalled();

    useAuthStore.setState({ permissions: ["collect_payments"] });
    await waitFor(() => expect(getAutomaticCashStatus).toHaveBeenCalledTimes(1));
    expect(
      unauthorizedClient.getQueryCache().findAll({ queryKey: paymentOverviewQueryKeys.root })
    ).not.toHaveLength(0);

    act(() => dispatchMobileSessionEnding());
    await waitFor(() =>
      expect(
        unauthorizedClient.getQueryCache().findAll({ queryKey: paymentOverviewQueryKeys.root })
      ).toHaveLength(0)
    );
  });
});
