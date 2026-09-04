import { useCallback, useEffect, useMemo, useState } from "react";
import type { MenuCatalog } from "../../../../api/menu";
import { collectCounterOrder } from "../../../../api/tables/counter";
import type {
  DiningTableOrder,
  TableCommercialBenefitApplication,
  TablePaymentAdminAdjustment,
  TablePaymentInvoiceRecipient,
  TablePaymentMethod,
  TablePaymentReceiptType,
  TablePaymentSplitMode,
  TableSessionRequest,
} from "../../../../api/tables";
import { GlassCard } from "../../../../components/GlassCard";
import { AdminPaymentAdjustmentDialog } from "../components/AdminPaymentAdjustmentDialog";
import { applyPaymentAdjustmentToDiningOrder } from "../payment/paymentAdjustmentDistribution";
import { buildCartAdjustment, type CartAdjustment } from "../payment/cartAdjustment";
import { TableOrderComposer, type TableOrderSubmitPayload } from "../components/TableOrderComposer";
import { TablePaymentWizard } from "../components/TablePaymentWizard";
import { attachCounterVatRates, findMissingCounterVatLine } from "./counterVat";
import {
  COUNTER_TABLE_ID,
  COUNTER_TABLE_LABEL,
  createCounterOrderFromSubmit,
  createCounterVirtualTable,
} from "./counterVirtualTable";
import { buildOperatorReceiptName } from "./operatorReceiptName";
import {
  getCounterCashDefaultSource,
  subscribeCounterCashDefaultSource,
  syncCounterCashDefaultSourceFromDb,
  type CounterCashDefaultSource,
} from "../../../../utils/automaticCashPaymentPreferences";

type CounterPaymentTargetState = {
  amount: number;
  orderId?: string;
  articleUnitIds?: string[];
  splitMode?: TablePaymentSplitMode;
  adminAdjustment?: TablePaymentAdminAdjustment;
};

type CounterWorkspaceProps = {
  baseSession: TableSessionRequest;
  roomName?: string;
  catalog: MenuCatalog | null;
  busy?: boolean;
};

export function CounterWorkspace({
  baseSession,
  roomName,
  catalog,
  busy = false,
}: CounterWorkspaceProps) {
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [counterOrder, setCounterOrder] = useState<DiningTableOrder | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [adjustmentOpen, setAdjustmentOpen] = useState(false);
  const [paymentTarget, setPaymentTarget] = useState<CounterPaymentTargetState | null>(null);
  const [cartAdjustment, setCartAdjustment] = useState<CartAdjustment | null>(null);
  // Traccia riga-inviata -> riga-carrello dell'ultimo payload passato alla
  // rettifica: le lineAdjustments tornano indicizzate per riga d'ordine.
  const [adjustmentDraftItemIds, setAdjustmentDraftItemIds] = useState<string[]>([]);
  const [composerResetNonce, setComposerResetNonce] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [counterCashDefaultSource, setCounterCashDefaultSourceState] =
    useState<CounterCashDefaultSource>(() => getCounterCashDefaultSource(baseSession.userId));
  const interactionBusy = busy || actionBusy;

  useEffect(() => {
    return subscribeCounterCashDefaultSource(() => {
      setCounterCashDefaultSourceState(getCounterCashDefaultSource(baseSession.userId));
    });
  }, [baseSession.userId]);

  useEffect(() => {
    setCounterCashDefaultSourceState(getCounterCashDefaultSource(baseSession.userId));
  }, [baseSession.userId]);

  useEffect(() => {
    if (!baseSession.token || !baseSession.userId || !baseSession.deviceUuid) return;
    let active = true;
    void syncCounterCashDefaultSourceFromDb({
      token: baseSession.token,
      userId: baseSession.userId,
      deviceUuid: baseSession.deviceUuid,
    })
      .then((value) => {
        if (active) setCounterCashDefaultSourceState(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [baseSession.deviceUuid, baseSession.token, baseSession.userId]);

  const productsById = useMemo(
    () => new Map((catalog?.products ?? []).map((product) => [product.id, product])),
    [catalog?.products]
  );
  const virtualTable = useMemo(
    () =>
      createCounterVirtualTable(
        counterOrder,
        paymentTarget?.amount ?? counterOrder?.dueAmount ?? counterOrder?.total
      ),
    [counterOrder, paymentTarget?.amount]
  );
  const operatorLabel = useMemo(
    () =>
      buildOperatorReceiptName({ fullName: baseSession.fullName, username: baseSession.username }),
    [baseSession.fullName, baseSession.username]
  );

  const buildCounterOrder = useCallback(
    (payload: TableOrderSubmitPayload) => {
      const lines = attachCounterVatRates(payload.lines, productsById);
      const missingVatLine = findMissingCounterVatLine(lines);
      if (missingVatLine) {
        throw new Error(
          `Aliquota IVA mancante per "${missingVatLine.name}". Completa l'IVA nel catalogo prima di stampare il Banco.`
        );
      }
      return createCounterOrderFromSubmit({ ...payload, lines });
    },
    [productsById]
  );

  const openPaymentFromOrder = useCallback((order: DiningTableOrder) => {
    setCounterOrder(order);
    setPaymentTarget({ amount: order.total, orderId: order.id, splitMode: "single" });
    setAdjustmentOpen(false);
    setPaymentOpen(true);
    setNotice(null);
    setActionError(null);
  }, []);

  const handleSubmit = useCallback(
    async (payload: TableOrderSubmitPayload) => {
      try {
        openPaymentFromOrder(buildCounterOrder(payload));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Ordine Banco non valido.";
        setActionError(message);
        setNotice(null);
        throw new Error(message);
      }
    },
    [buildCounterOrder, openPaymentFromOrder]
  );

  const handleSubmitLongPress = useCallback(
    (payload: TableOrderSubmitPayload, meta: { draftItemIds: string[] }) => {
      try {
        const order = buildCounterOrder(payload);
        setAdjustmentDraftItemIds(meta.draftItemIds);
        setCounterOrder(order);
        setPaymentTarget({ amount: order.total, orderId: order.id, splitMode: "single" });
        setPaymentOpen(false);
        setAdjustmentOpen(true);
        setNotice(null);
        setActionError(null);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "Ordine Banco non valido.");
        setNotice(null);
      }
    },
    [buildCounterOrder]
  );

  const handleAdjustmentApply = useCallback(
    async (payload: {
      amount: number;
      articleUnitIds?: string[];
      splitMode?: "article";
      adminAdjustment: TablePaymentAdminAdjustment;
    }, options?: { collectNow?: boolean }) => {
      if (!counterOrder) throw new Error("Nessun ordine Banco da rettificare.");
      const adjustedOrder = applyPaymentAdjustmentToDiningOrder(
        counterOrder,
        payload.adminAdjustment.lineAdjustments ?? []
      );
      if (Math.round(adjustedOrder.total * 100) !== Math.round(payload.amount * 100)) {
        throw new Error("Il totale rettificato del Banco non coincide con l'importo richiesto.");
      }
      setCounterOrder(adjustedOrder);
      setPaymentTarget({
        amount: payload.amount,
        orderId: adjustedOrder.id,
        splitMode: "single",
      });
      // Con il solo APPLICA il wizard non si apre: senza questo la rettifica
      // restava invisibile nel carrello, che e' proprio cio' che si incassa.
      setCartAdjustment(buildCartAdjustment(payload.adminAdjustment, adjustmentDraftItemIds));
      setAdjustmentOpen(false);
      setPaymentOpen(options?.collectNow === true);
      setNotice(null);
      setActionError(null);
    },
    [adjustmentDraftItemIds, counterOrder]
  );

  const closePayment = useCallback(() => {
    setPaymentOpen(false);
    setPaymentTarget(null);
    setAdjustmentOpen(false);
    setCounterOrder(null);
    setNotice(null);
    // La rettifica applicata al carrello sopravvive: chiudere il wizard non
    // deve buttarla via, l'operatore la vede e decide se tenerla.
  }, []);

  const handlePaymentConfirm = useCallback(
    async (payload: {
      amount: number;
      method: TablePaymentMethod;
      articleUnitIds?: string[];
      splitMode?: TablePaymentSplitMode;
      adminAdjustment?: TablePaymentAdminAdjustment;
      cashReceived?: number;
      cashSource?: "wallet" | "automatic";
      automaticCashPaymentOperationId?: string;
      receiptType?: TablePaymentReceiptType;
      invoiceRecipient?: TablePaymentInvoiceRecipient | null;
      clientPaymentId?: string;
      note?: string;
      romanSharesPaid?: number;
      romanSharesTotal?: number;
      commercialBenefitApplications?: TableCommercialBenefitApplication[];
    }) => {
      if (!counterOrder) throw new Error("Nessun ordine Banco pronto da incassare.");
      setActionError(null);
      setActionBusy(true);
      try {
        const result = await collectCounterOrder({
          ...baseSession,
          tableId: COUNTER_TABLE_ID,
          tableLabel: COUNTER_TABLE_LABEL,
          operatorLabel,
          order: counterOrder,
          payment: {
            amount: payload.amount,
            method: payload.method,
            articleUnitIds: payload.articleUnitIds ?? paymentTarget?.articleUnitIds,
            splitMode: payload.splitMode ?? paymentTarget?.splitMode,
            adminAdjustment: payload.adminAdjustment ?? paymentTarget?.adminAdjustment,
            cashReceived: payload.cashReceived,
            cashSource: payload.cashSource,
            automaticCashPaymentOperationId: payload.automaticCashPaymentOperationId,
            receiptType: payload.receiptType,
            invoiceRecipient: payload.invoiceRecipient,
            clientPaymentId: payload.clientPaymentId,
            note: payload.note,
            romanSharesPaid: payload.romanSharesPaid,
            romanSharesTotal: payload.romanSharesTotal,
            commercialBenefitApplications: payload.commercialBenefitApplications,
          },
        });
        setPaymentOpen(false);
        setPaymentTarget(null);
        setAdjustmentOpen(false);
        setCounterOrder(null);
        setCartAdjustment(null);
        setAdjustmentDraftItemIds([]);
        setComposerResetNonce((current) => current + 1);
        setNotice(
          result.printWarning
            ? `Pagamento Banco registrato. ${result.printWarning}`
            : "Pagamento Banco registrato."
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Pagamento Banco non riuscito.";
        setActionError(message);
        throw new Error(message);
      } finally {
        setActionBusy(false);
      }
    },
    [baseSession, counterOrder, operatorLabel, paymentTarget]
  );

  return (
    <GlassCard className="home-card workspace-card tables-workspace-card tables-counter-workspace-card">
      <div className="card-body tables-card-body tables-counter-card-body">
        <div className="tables-counter-shell">
          <div className="tables-counter-head">
            <div>
              <span>Modalita Banco</span>
              <strong>Banco</strong>
            </div>
            <em>{roomName || "Operativa"}</em>
          </div>
          {notice ? <div className="tables-counter-notice">{notice}</div> : null}
          {actionError ? <div className="tables-counter-error">{actionError}</div> : null}
        </div>

        <TableOrderComposer
          open
          busy={interactionBusy}
          catalog={catalog}
          persistKey={`counter_order_composer_${baseSession.userId}`}
          title="Ordine Banco"
          submitLabel="RISCUOTI"
          submittingLabel="Apertura incasso..."
          inlineStatus={
            actionError
              ? { tone: "error", message: actionError }
              : notice
                ? { tone: "notice", message: notice }
                : null
          }
          showCloseButton={false}
          resetNonce={composerResetNonce}
          adjustment={cartAdjustment}
          onAdjustmentChange={setCartAdjustment}
          onClose={() => undefined}
          onSubmit={handleSubmit}
          onSubmitLongPress={handleSubmitLongPress}
        />
        <AdminPaymentAdjustmentDialog
          open={adjustmentOpen}
          table={virtualTable}
          targetOrderId={counterOrder?.id}
          targetAmount={paymentTarget?.amount ?? counterOrder?.total}
          busy={interactionBusy}
          onClose={() => setAdjustmentOpen(false)}
          onApply={handleAdjustmentApply}
        />
        <TablePaymentWizard
          open={paymentOpen}
          busy={interactionBusy}
          table={virtualTable}
          roomName={roomName || "Operativa"}
          targetAmount={paymentTarget?.amount}
          targetOrderId={paymentTarget?.orderId}
          adminAdjustment={paymentTarget?.adminAdjustment}
          adminArticleUnitIds={paymentTarget?.articleUnitIds}
          adminSplitMode={paymentTarget?.splitMode}
          cashContext="counter"
          cashDefaultSource={counterCashDefaultSource}
          onClose={closePayment}
          onConfirm={handlePaymentConfirm}
        />
      </div>
    </GlassCard>
  );
}
