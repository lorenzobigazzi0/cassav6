import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  canShowServiceRecoveryCorrection,
  canShowServiceRecoveryReplacement,
} from "../src/pages/home/tables/components/TableDetailPanel";
import { TablePaymentWizard } from "../src/pages/home/tables/components/TablePaymentWizard";
import { fetchActiveStationCount } from "../src/api/stations";
import {
  analyticsSplitModeLabel,
  buildAnalyticsMovementRecords,
  canPrintAnalyticsMovement,
  printAnalyticsPaymentMovement,
  resolveAnalyticsSessionContext,
  type AnalyticsMovementRecord,
} from "../src/api/analyticsPaymentMovements";
import { useAuthStore } from "../src/store/authStore";
import { usePaymentSettingsStore } from "../src/store/paymentSettingsStore";
import {
  PAYMENT_AUTO_CASH_FLOAT_ASSIGNMENT_ID_KEY,
  PAYMENT_AUTO_CASH_FLOAT_BUSINESS_EVENING_KEY,
  PAYMENT_AUTO_CASH_FLOAT_COMBINATION_ID_KEY,
  PAYMENT_AUTO_CASH_FLOAT_CREATED_AT_MS_KEY,
  PAYMENT_AUTO_CASH_FLOAT_ID_KEY,
  PAYMENT_AUTO_CASH_FLOAT_LOADED_KEY,
  PAYMENT_AUTO_CASH_FLOAT_QR_PAYLOAD_KEY,
  PAYMENT_CASH_FLOAT_KEY,
  PAYMENT_CASH_FLOAT_LOCKED_KEY,
  PAYMENT_CASH_MODE_KEY,
  PAYMENT_POS_ID_KEY,
  PAYMENT_SESSION_STARTED_AT_KEY,
  persistMobilePaymentRuntime,
  restoreMobilePaymentRuntime,
} from "../src/utils/paymentSessionRuntime";
import type { DiningTable, DiningTableOrder } from "../src/api/tables";

const order = (patch: Partial<DiningTableOrder>): DiningTableOrder => ({
  id: "00272",
  title: "Comanda #00272",
  createdAt: Date.parse("2026-05-16T12:00:00Z"),
  total: 30,
  state: "served",
  workflowStatus: "ready",
  paidArticleUnits: [],
  lines: [
    { lineId: "line_1", name: "Piatto 1", qty: 1, unitFinalPrice: 9 },
    { lineId: "line_2", name: "Piatto 2", qty: 1, unitFinalPrice: 9 },
    { lineId: "line_3", name: "Piatto 3", qty: 1, unitFinalPrice: 12 },
  ],
  ...patch,
});

const payableTable = (patch: Partial<DiningTable> = {}): DiningTable => ({
  id: "room_pedana_t01",
  number: 1,
  tableName: "Tavolo 1",
  customerPhone: "",
  covers: 3,
  occupancyState: "seated",
  reservationAt: null,
  seatedAt: Date.now(),
  ordersTaken: 1,
  ordersInProgress: 0,
  amountDue: 30,
  note: "",
  allergens: [],
  manualIntolerance: "",
  orderHistory: [order({})],
  ...patch,
});

const okResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  window.localStorage.clear();
  usePaymentSettingsStore.setState({
    posId: "pos-main",
    cashMode: "manual",
    cashFloat: 100,
    cashFloatLocked: true,
    autoCashFloatId: null,
    autoCashFloatLoaded: false,
    autoCashFloatQrPayload: null,
    autoCashFloatCreatedAtMs: null,
    autoCashFloatAssignmentId: null,
    autoCashFloatCombinationId: null,
    autoCashFloatBusinessEveningKey: null,
  });
  useAuthStore.setState({ allowedPaymentMethodIds: ["pay_cash", "pay_card"] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("funzionalita native migrate dai bridge mobile", () => {
  it("mostra Modifica per comande non pagate e Reso appena la comanda e nello storico", () => {
    expect(
      canShowServiceRecoveryCorrection(order({ state: "in_progress", workflowStatus: "waiting" }))
    ).toBe(true);
    expect(
      canShowServiceRecoveryReplacement(order({ state: "in_progress", workflowStatus: "waiting" }))
    ).toBe(true);

    expect(
      canShowServiceRecoveryCorrection(order({ state: "in_progress", workflowStatus: "ready" }))
    ).toBe(false);
    expect(
      canShowServiceRecoveryReplacement(order({ state: "in_progress", workflowStatus: "ready" }))
    ).toBe(true);

    expect(
      canShowServiceRecoveryCorrection(order({ state: "paid", workflowStatus: "delivered" }))
    ).toBe(false);
    expect(
      canShowServiceRecoveryReplacement(order({ state: "paid", workflowStatus: "delivered" }))
    ).toBe(true);

    expect(
      canShowServiceRecoveryCorrection(order({ state: "paid", workflowStatus: "cancelled" }))
    ).toBe(false);
    expect(
      canShowServiceRecoveryReplacement(order({ state: "paid", workflowStatus: "cancelled" }))
    ).toBe(false);

    expect(canShowServiceRecoveryCorrection(order({ id: "local_1", state: "served" }))).toBe(false);
    expect(canShowServiceRecoveryReplacement(order({ id: "local_1", state: "served" }))).toBe(
      false
    );
  });

  it("mantiene tavolo e sala nel titolo e sposta il ritorno del metodo nell'header", () => {
    render(
      <TablePaymentWizard
        open
        busy={false}
        table={payableTable()}
        roomName="Gazebo"
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    const intestazione = screen.getByRole("heading", {
      name: "Divisione conto - Tavolo 1 - Gazebo",
    });
    expect(intestazione).toBeInTheDocument();
    // Due righe: il passo sopra, tavolo e sala sotto.
    expect(intestazione.querySelector("strong")).toHaveTextContent("Divisione conto");
    expect(intestazione.querySelector("span")).toHaveTextContent("Tavolo 1 - Sala: Gazebo");
    fireEvent.click(screen.getByRole("button", { name: "Conto unico" }));
    fireEvent.click(screen.getByRole("button", { name: "Carta" }));

    const methodBack = screen.getByRole("button", {
      name: "Torna ai metodi di pagamento, Carta",
    });
    expect(methodBack).toHaveTextContent("Carta");
    expect(methodBack).not.toHaveTextContent("Tavolo 1");
    expect(methodBack.closest("header")).toHaveClass("table-payment-head", "has-method-back");
  });

  it("paga due quote alla romana e scala due quote nel payload nativo", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);

    render(
      <TablePaymentWizard
        open
        busy={false}
        table={payableTable()}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Alla romana/i }));
    fireEvent.click(screen.getByRole("button", { name: /Continua/i }));
    fireEvent.click(screen.getByRole("button", { name: /Carta/i }));
    fireEvent.click(screen.getByRole("button", { name: /Aumenta quote da pagare/i }));

    expect(screen.getByRole("textbox", { name: /^Quote da pagare$/i })).toHaveValue("2");
    expect(screen.getByText(/Quote da pagare ora:\s*2 di 3/i)).toBeInTheDocument();
    expect(screen.getByText(/Totale quota/i).parentElement).toHaveTextContent("20,00");

    fireEvent.change(screen.getByRole("slider"), { target: { value: "100" } });
    await screen.findByText(/Ricevuta/i);
    fireEvent.click(screen.getByRole("button", { name: /Conferma pagamento/i }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm.mock.calls[0][0]).toMatchObject({
      amount: 20,
      method: "card",
      splitMode: "roman",
      romanSharesPaid: 2,
      romanSharesTotal: 3,
    });
  });

  it("blocca il pagamento per articolo quando il backend o la sessione locale lo indicano", () => {
    const { unmount } = render(
      <TablePaymentWizard
        open
        busy={false}
        table={payableTable({ paymentArticleSplitLocked: true })}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /Per articolo/i })).toBeDisabled();
    expect(screen.getByText(/Pagamento per articolo non disponibile/i)).toBeInTheDocument();

    unmount();
    window.localStorage.setItem("mobile_payment_article_split_lock_v1:room_pedana_t01:table", "1");
    render(
      <TablePaymentWizard
        open
        busy={false}
        table={payableTable({ paymentArticleSplitLocked: false })}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /Per articolo/i })).toBeDisabled();
  });

  it("legge le postazioni attive dal backend nativo senza bridge DOM", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ ok: true, stations: [{ id: "bar" }, { id: "kitchen" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchActiveStationCount()).resolves.toBe(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/integration/stations/active");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET", cache: "no-store" });
  });

  it("ricostruisce i movimenti statistiche includendo pagamenti, storni e sostituzioni", () => {
    const records = buildAnalyticsMovementRecords({
      paymentsTracking: {
        containers: [
          {
            id: "pay_1",
            status: "COMPLETED",
            amount: 12,
            createdAt: "2026-05-16T10:00:00Z",
            collectedByDisplayName: "Giada Imperato",
            paymentMethod: "card",
            tableLabel: "1",
            roomId: "room_pedana",
            orderIds: ["00272"],
            splitMode: "roman",
            romanSharesPaid: 2,
            romanSharesTotal: 3,
          },
        ],
        parts: [],
        transactions: [],
      },
      serviceRecovery: {
        comps: [
          {
            id: "comp_1",
            orderId: "00272",
            paidAmount: 8,
            productName: "Spritz",
            createdAt: "2026-05-16T10:05:00Z",
            refundPlan: {
              allocations: [{ method: "card", refundAmount: 8, transactionIds: ["tx_1"] }],
            },
          },
        ],
        replacements: [
          {
            id: "rep_1",
            orderId: "00272",
            productName: "Spritz",
            createdAt: "2026-05-16T10:06:00Z",
          },
        ],
      },
      ordersTracking: { orders: [] },
    });

    expect(records.map((record) => record.type).sort()).toEqual([
      "payment",
      "replacement",
      "storno",
    ]);
    expect(records.find((record) => record.type === "storno")?.amount).toBe(-8);
    expect(analyticsSplitModeLabel(records.find((record) => record.type === "payment")!)).toBe(
      "Alla romana (2/3 quote)"
    );
    expect(canPrintAnalyticsMovement(records.find((record) => record.type === "payment"))).toBe(
      true
    );
    expect(canPrintAnalyticsMovement(records.find((record) => record.type === "storno"))).toBe(
      true
    );
    expect(canPrintAnalyticsMovement(records.find((record) => record.type === "replacement"))).toBe(
      false
    );
  });

  it("ristampa un pagamento/storno tramite endpoint di ristampa senza riemettere fiscale", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const record = {
      id: "payment:pay_1",
      type: "payment",
      paymentId: "pay_1",
    } as AnalyticsMovementRecord;

    await printAnalyticsPaymentMovement(
      {
        token: "token",
        userId: "u_1",
        username: "giada",
        fullName: "Giada Imperato",
        deviceUuid: "dev_1",
        sessionStartedAt: 1,
        settlementCutoffAt: 0,
      },
      record
    );

    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/reports/payment-movement/reprint");
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("/api/fiscal/receipt");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      type: "payment",
      movementId: "pay_1",
      clientApp: "mobile-frontend",
    });
  });

  it("mantiene il turno statistiche da runtime dopo logout/login finche non viene fatto scarico", () => {
    window.localStorage.setItem(
      "mobile_payment_runtime_v1:u_giada:device_1",
      JSON.stringify({ sessionStartedAt: Date.parse("2026-05-16T09:00:00Z") })
    );
    const auth = resolveAnalyticsSessionContext({
      token: "token-new",
      userId: "u_giada",
      username: "giada",
      fullName: "Giada Imperato",
      deviceUuid: "device_1",
      sessionStartedAt: Date.parse("2026-05-16T11:00:00Z"),
    });

    expect(auth.sessionStartedAt).toBe(Date.parse("2026-05-16T09:00:00Z"));
  });

  it("ripristina POS e fondo cassa dal profilo utente quando cambia device", () => {
    const startedAt = Date.parse("2026-05-16T09:00:00Z");
    window.localStorage.setItem("pos_token", "token-old");
    window.localStorage.setItem("pos_user_id", "u_giada");
    window.localStorage.setItem("pos_user", "giada");
    window.localStorage.setItem("pos_full_name", "Giada Imperato");
    window.localStorage.setItem("pos_device_uuid", "device_1");
    window.localStorage.setItem(PAYMENT_POS_ID_KEY, "pos_mobile");
    window.localStorage.setItem(PAYMENT_CASH_FLOAT_KEY, "150.00");
    window.localStorage.setItem(PAYMENT_CASH_FLOAT_LOCKED_KEY, "1");
    window.localStorage.setItem(PAYMENT_SESSION_STARTED_AT_KEY, String(startedAt));

    persistMobilePaymentRuntime("test-save");

    window.localStorage.setItem("pos_token", "token-new");
    window.localStorage.setItem("pos_device_uuid", "device_2");
    window.localStorage.removeItem(PAYMENT_POS_ID_KEY);
    window.localStorage.removeItem(PAYMENT_CASH_FLOAT_KEY);
    window.localStorage.removeItem(PAYMENT_CASH_FLOAT_LOCKED_KEY);
    window.localStorage.setItem(
      PAYMENT_SESSION_STARTED_AT_KEY,
      String(Date.parse("2026-05-16T11:00:00Z"))
    );

    expect(restoreMobilePaymentRuntime("test-restore")).toBe(true);
    expect(window.localStorage.getItem(PAYMENT_POS_ID_KEY)).toBe("pos_mobile");
    expect(window.localStorage.getItem(PAYMENT_CASH_FLOAT_KEY)).toBe("150.00");
    expect(window.localStorage.getItem(PAYMENT_CASH_FLOAT_LOCKED_KEY)).toBe("1");
    expect(window.localStorage.getItem(PAYMENT_SESSION_STARTED_AT_KEY)).toBe(String(startedAt));
    expect(window.localStorage.getItem("mobile_payment_user_runtime_v1:u_giada")).toContain(
      "pos_mobile"
    );
    expect(window.localStorage.getItem("mobile_payment_runtime_v2:u_giada")).toContain(
      "pos_mobile"
    );
  });

  it("migra e ripristina fondo cassa automatico sul profilo utente", () => {
    const startedAt = Date.parse("2026-05-16T09:00:00Z");
    window.localStorage.setItem("pos_token", "token-old");
    window.localStorage.setItem("pos_user_id", "u_giada");
    window.localStorage.setItem("pos_user", "giada");
    window.localStorage.setItem("pos_full_name", "Giada Imperato");
    window.localStorage.setItem("pos_device_uuid", "device_1");
    window.localStorage.setItem(PAYMENT_CASH_MODE_KEY, "auto");
    window.localStorage.setItem(PAYMENT_CASH_FLOAT_KEY, "142.50");
    window.localStorage.setItem(PAYMENT_CASH_FLOAT_LOCKED_KEY, "1");
    window.localStorage.setItem(PAYMENT_AUTO_CASH_FLOAT_ID_KEY, "FCA-001");
    window.localStorage.setItem(PAYMENT_AUTO_CASH_FLOAT_LOADED_KEY, "1");
    window.localStorage.setItem(PAYMENT_AUTO_CASH_FLOAT_QR_PAYLOAD_KEY, "qr:auto:001");
    window.localStorage.setItem(PAYMENT_AUTO_CASH_FLOAT_CREATED_AT_MS_KEY, String(startedAt));
    window.localStorage.setItem(PAYMENT_AUTO_CASH_FLOAT_ASSIGNMENT_ID_KEY, "assign-001");
    window.localStorage.setItem(PAYMENT_AUTO_CASH_FLOAT_COMBINATION_ID_KEY, "FC-001");
    window.localStorage.setItem(PAYMENT_AUTO_CASH_FLOAT_BUSINESS_EVENING_KEY, "2026-05-16");
    window.localStorage.setItem(PAYMENT_SESSION_STARTED_AT_KEY, String(startedAt));

    persistMobilePaymentRuntime("test-auto-save");

    window.localStorage.setItem("pos_token", "token-new");
    window.localStorage.setItem("pos_device_uuid", "device_2");
    window.localStorage.removeItem(PAYMENT_CASH_MODE_KEY);
    window.localStorage.removeItem(PAYMENT_CASH_FLOAT_KEY);
    window.localStorage.removeItem(PAYMENT_CASH_FLOAT_LOCKED_KEY);
    window.localStorage.removeItem(PAYMENT_AUTO_CASH_FLOAT_ID_KEY);
    window.localStorage.removeItem(PAYMENT_AUTO_CASH_FLOAT_LOADED_KEY);
    window.localStorage.removeItem(PAYMENT_AUTO_CASH_FLOAT_QR_PAYLOAD_KEY);
    window.localStorage.removeItem(PAYMENT_AUTO_CASH_FLOAT_CREATED_AT_MS_KEY);
    window.localStorage.removeItem(PAYMENT_AUTO_CASH_FLOAT_ASSIGNMENT_ID_KEY);
    window.localStorage.removeItem(PAYMENT_AUTO_CASH_FLOAT_COMBINATION_ID_KEY);
    window.localStorage.removeItem(PAYMENT_AUTO_CASH_FLOAT_BUSINESS_EVENING_KEY);

    expect(restoreMobilePaymentRuntime("test-auto-restore")).toBe(true);
    expect(window.localStorage.getItem(PAYMENT_CASH_MODE_KEY)).toBe("auto");
    expect(window.localStorage.getItem(PAYMENT_CASH_FLOAT_KEY)).toBe("142.50");
    expect(window.localStorage.getItem(PAYMENT_AUTO_CASH_FLOAT_ID_KEY)).toBe("FCA-001");
    expect(window.localStorage.getItem(PAYMENT_AUTO_CASH_FLOAT_QR_PAYLOAD_KEY)).toBe("qr:auto:001");
    expect(window.localStorage.getItem(PAYMENT_AUTO_CASH_FLOAT_ASSIGNMENT_ID_KEY)).toBe(
      "assign-001"
    );
    expect(window.localStorage.getItem(PAYMENT_AUTO_CASH_FLOAT_COMBINATION_ID_KEY)).toBe("FC-001");
    expect(window.localStorage.getItem(PAYMENT_AUTO_CASH_FLOAT_BUSINESS_EVENING_KEY)).toBe(
      "2026-05-16"
    );
    expect(window.localStorage.getItem("mobile_payment_runtime_v2:u_giada")).toContain(
      "autoCashFloatId"
    );
  });

  it("mantiene statistiche e cutoff scarico dal profilo utente su nuovo device", () => {
    const startedAt = Date.parse("2026-05-16T09:00:00Z");
    const cutoffAt = Date.parse("2026-05-16T10:30:00Z");
    window.localStorage.setItem(
      "mobile_payment_user_runtime_v1:u_giada",
      JSON.stringify({ sessionStartedAt: startedAt, hasActivePaymentConfig: false })
    );
    window.localStorage.setItem("payment_settlement_cutoff_v1:u_giada:user", String(cutoffAt));
    window.localStorage.setItem(
      "payment_settlement_cutoff_v1:u_giada:device_2",
      String(Date.parse("2026-05-16T10:00:00Z"))
    );

    const auth = resolveAnalyticsSessionContext({
      token: "token-new",
      userId: "u_giada",
      username: "giada",
      fullName: "Giada Imperato",
      deviceUuid: "device_2",
      sessionStartedAt: Date.parse("2026-05-16T11:00:00Z"),
    });

    expect(auth.sessionStartedAt).toBe(startedAt);
    expect(auth.settlementCutoffAt).toBe(cutoffAt);
  });
});
