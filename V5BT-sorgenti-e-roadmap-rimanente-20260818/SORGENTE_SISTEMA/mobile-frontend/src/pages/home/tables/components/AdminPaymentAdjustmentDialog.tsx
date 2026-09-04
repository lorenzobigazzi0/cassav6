import { useEffect, useMemo, useState } from "react";
import type {
  DiningTable,
  TablePaymentAdminAdjustment,
  TablePaymentAdminAdjustmentType,
} from "../../../../api/tables";
import {
  expandOrderToArticleUnits,
  expandOrdersToAdjustmentUnits,
  getOrderPayableAmount,
  type PaymentArticleUnit,
} from "../payment/paymentArticleUnits";
import {
  buildExplicitPaymentAdjustment,
  distributePaymentAdjustment,
} from "../payment/paymentAdjustmentDistribution";
import { CART_ADJUSTMENT_STEP_CENTS } from "../payment/cartAdjustment";
import { formatCurrency } from "../utils";

type AdminPaymentAdjustmentDialogProps = {
  open: boolean;
  table: DiningTable | null;
  targetOrderId?: string;
  targetAmount?: number;
  busy?: boolean;
  onClose: () => void;
  onApply: (
    payload: {
      amount: number;
      articleUnitIds?: string[];
      splitMode?: "article";
      adminAdjustment: TablePaymentAdminAdjustment;
    },
    options?: { collectNow?: boolean }
  ) => Promise<void>;
};

const ADJUSTMENT_MODES: Array<{
  key: TablePaymentAdminAdjustmentType;
  label: string;
}> = [
  { key: "manual_total", label: "Importo" },
  { key: "discount", label: "Sconto" },
  { key: "allowance", label: "Abbuono" },
  { key: "line_price_override", label: "Articoli" },
];

const money = (value: number) => Math.max(0, Math.round(value * 100) / 100);
const signedMoney = (value: number) => Math.round(value * 100) / 100;

const parseMoney = (value: string) => {
  const parsed = Number(String(value ?? "").replace(",", "."));
  if (!Number.isFinite(parsed)) return 0;
  return money(parsed);
};

const isValidMoneyInput = (value: string) => {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!normalized) return false;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0;
};

const AdminPaymentSaveIcon = () => (
  <svg className="admin-payment-action-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 5h11l3 3v11H5z" />
    <path d="M8 5v6h8V5" />
    <path d="M8 19v-5h8v5" />
  </svg>
);

const AdminPaymentCollectIcon = () => (
  <svg className="admin-payment-action-icon" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="6" width="18" height="12" rx="2" />
    <circle cx="12" cy="12" r="3" />
    <path d="M7 9h.01M17 15h.01" />
  </svg>
);

const AdminPaymentEraserIcon = () => (
  <svg className="admin-payment-action-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 16 14.5 5.5a3 3 0 0 1 4.2 4.2L10.4 18H4z" />
    <path d="M10.5 9.5 15 14" />
    <path d="M12 18h8" />
  </svg>
);

type ArticleLineGroup = {
  id: string;
  name: string;
  note?: string;
  variantName?: string;
  quantity: number;
  originalUnitAmount: number;
  originalSubtotal: number;
  units: PaymentArticleUnit[];
};

const articleLineGroupKey = (unit: PaymentArticleUnit) =>
  [
    unit.orderId,
    unit.name,
    unit.variantName ?? "",
    unit.note ?? "",
    money(unit.amount).toFixed(2),
  ].join("::");

const groupArticleUnitsForAdjustment = (units: PaymentArticleUnit[]) => {
  const groups = new Map<string, ArticleLineGroup>();
  units.forEach((unit) => {
    const id = articleLineGroupKey(unit);
    const existing = groups.get(id);
    if (existing) {
      existing.units.push(unit);
      existing.quantity += 1;
      existing.originalSubtotal = money(existing.originalSubtotal + unit.amount);
      return;
    }
    groups.set(id, {
      id,
      name: unit.name,
      note: unit.note,
      variantName: unit.variantName,
      quantity: 1,
      originalUnitAmount: money(unit.amount),
      originalSubtotal: money(unit.amount),
      units: [unit],
    });
  });
  return [...groups.values()];
};

export function AdminPaymentAdjustmentDialog({
  open,
  table,
  targetOrderId,
  targetAmount,
  busy = false,
  onClose,
  onApply,
}: AdminPaymentAdjustmentDialogProps) {
  const [mode, setMode] = useState<TablePaymentAdminAdjustmentType>("manual_total");
  const [value, setValue] = useState("");
  const [percent, setPercent] = useState("");
  const [reason, setReason] = useState("");
  const [reasonDraft, setReasonDraft] = useState("");
  const [reasonEditorOpen, setReasonEditorOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [lineAmounts, setLineAmounts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<"apply" | "collect" | null>(null);
  const [submitError, setSubmitError] = useState("");
  const isBusy = busy || submitting !== null;

  const payableOrders = useMemo(() => {
    const source = table?.orderHistory ?? [];
    return source.filter((order) => {
      if (targetOrderId && order.id !== targetOrderId) return false;
      return getOrderPayableAmount(order) > 0.009;
    });
  }, [table?.orderHistory, targetOrderId]);

  const articleUnits = useMemo(() => expandOrderToArticleUnits(payableOrders), [payableOrders]);
  const adjustmentUnits = useMemo(
    () => expandOrdersToAdjustmentUnits(payableOrders),
    [payableOrders]
  );
  const articleLineGroups = useMemo(
    () => groupArticleUnitsForAdjustment(articleUnits),
    [articleUnits]
  );

  const originalAmount = useMemo(() => {
    const orderDue = payableOrders.reduce((sum, order) => sum + getOrderPayableAmount(order), 0);
    const fallback = targetOrderId || orderDue > 0.009 ? orderDue : (table?.amountDue ?? orderDue);
    return money(targetAmount && targetAmount > 0 ? targetAmount : fallback);
  }, [payableOrders, table?.amountDue, targetAmount, targetOrderId]);

  useEffect(() => {
    if (!open) return;
    setMode("manual_total");
    setValue(originalAmount > 0 ? originalAmount.toFixed(2) : "");
    setPercent("");
    setReason("");
    setReasonDraft("");
    setReasonEditorOpen(false);
    setModeMenuOpen(false);
    setSubmitting(null);
    setSubmitError("");
    setLineAmounts(
      Object.fromEntries(
        articleLineGroups.map((group) => [group.id, group.originalUnitAmount.toFixed(2)])
      )
    );
  }, [articleLineGroups, open, originalAmount]);

  const lineDrafts = useMemo(
    () =>
      articleLineGroups.map((group) => {
        const rawValue = lineAmounts[group.id] ?? group.originalUnitAmount.toFixed(2);
        const adjustedUnitAmount = parseMoney(rawValue);
        return {
          group,
          rawValue,
          adjustedUnitAmount,
          adjustedSubtotal: money(adjustedUnitAmount * group.quantity),
        };
      }),
    [articleLineGroups, lineAmounts]
  );

  const adjustedAmount = useMemo(() => {
    if (mode === "line_price_override") {
      return money(lineDrafts.reduce((sum, line) => sum + line.adjustedSubtotal, 0));
    }
    if (mode === "discount") {
      const pct = Math.max(0, Math.min(100, Number(String(percent).replace(",", ".")) || 0));
      return money(originalAmount - (originalAmount * pct) / 100);
    }
    if (mode === "allowance") {
      return money(originalAmount - parseMoney(value));
    }
    return money(parseMoney(value));
  }, [lineDrafts, mode, originalAmount, percent, value]);

  const differenceAmount = signedMoney(adjustedAmount - originalAmount);
  const discountAmount = money(Math.max(-differenceAmount, 0));
  const parsedPercent = Number(String(percent).trim().replace(",", "."));
  const inputsValid =
    mode === "discount"
      ? Number.isFinite(parsedPercent) && parsedPercent >= 0 && parsedPercent <= 100
      : mode === "line_price_override"
        ? lineDrafts.length > 0 && lineDrafts.every((line) => isValidMoneyInput(line.rawValue))
        : isValidMoneyInput(value) &&
          (mode !== "allowance" || parseMoney(value) <= originalAmount);
  const amountReady = inputsValid && adjustedAmount >= 0;
  const hasChange = Math.abs(differenceAmount) > 0.009;
  const canApply = amountReady && hasChange && !isBusy;
  const canApplyAndCollect = canApply && adjustedAmount > 0.009;
  const activeMode = ADJUSTMENT_MODES.find((entry) => entry.key === mode) ?? {
    key: "manual_total",
    label: "Importo",
  };

  if (!open || !table) return null;
  const tableDisplayLabel =
    table.tableLabel?.trim() || table.tableName?.trim() || `Tavolo ${table.number}`;

  const selectMode = (nextMode: TablePaymentAdminAdjustmentType) => {
    setMode(nextMode);
    if (nextMode === "manual_total") {
      setValue(originalAmount > 0 ? originalAmount.toFixed(2) : "");
    }
    if (nextMode === "allowance") {
      setValue("0");
    }
    setModeMenuOpen(false);
  };

  const openReasonEditor = () => {
    setReasonDraft(reason);
    setReasonEditorOpen(true);
    setModeMenuOpen(false);
  };

  const saveReason = () => {
    setReason(reasonDraft.trim().slice(0, 240));
    setReasonEditorOpen(false);
  };

  const apply = async (collectNow: boolean) => {
    if (collectNow ? !canApplyAndCollect : !canApply) return;
    setSubmitting(collectNow ? "collect" : "apply");
    setSubmitError("");
    const currentItemsTotal = adjustmentUnits.reduce((sum, unit) => sum + unit.amount, 0);
    const targetItemsTotal = money(currentItemsTotal + adjustedAmount - originalAmount);
    try {
      const distribution =
        mode === "line_price_override"
          ? buildExplicitPaymentAdjustment(
              adjustmentUnits,
              new Map(
                lineDrafts.flatMap(({ group, adjustedUnitAmount }) =>
                  group.units.map((unit) => [unit.id, adjustedUnitAmount] as const)
                )
              ),
              targetItemsTotal
            )
          : // Importo, sconto e abbuono si ripartiscono a passi di 5 centesimi;
            // il modo Articoli usa i prezzi digitati a mano, senza arrotondare.
            distributePaymentAdjustment(adjustmentUnits, targetItemsTotal, {
              stepCents: CART_ADJUSTMENT_STEP_CENTS,
            });
      const lineAdjustments = distribution.lineAdjustments;
      const selectedArticleUnitIds =
        mode === "line_price_override"
          ? lineDrafts.flatMap(({ group }) => group.units.map((unit) => unit.id))
          : undefined;

      await onApply(
        {
          amount: adjustedAmount,
          articleUnitIds: selectedArticleUnitIds,
          splitMode: selectedArticleUnitIds?.length ? "article" : undefined,
          adminAdjustment: {
            type: mode,
            reason: reason.trim().slice(0, 240) || "Rettifica admin",
            originalAmount,
            adjustedAmount,
            discountAmount,
            differenceAmount,
            percent:
              mode === "discount"
                ? Math.max(0, Math.min(100, Number(String(percent).replace(",", ".")) || 0))
                : undefined,
            lineAdjustments,
          },
        },
        { collectNow }
      );
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Rettifica non salvata.");
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div
      className="admin-payment-adjustment-backdrop"
      onClick={() => {
        if (!isBusy) onClose();
      }}
    >
      <section
        className="admin-payment-adjustment-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Rettifica pagamento admin"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="admin-payment-adjustment-head">
          <div>
            <strong>Rettifica pagamento</strong>
            <span>
              {tableDisplayLabel} · {formatCurrency(originalAmount)}
            </span>
          </div>
          <button
            type="button"
            className="smallbtn admin-payment-close"
            onClick={onClose}
            disabled={isBusy}
            aria-label="Chiudi"
            title="Chiudi"
          >
            <svg viewBox="0 0 24 24" className="table-detail-close-icon" aria-hidden="true">
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </header>

        <div className="admin-payment-adjustment-toolbar">
          <div className="admin-payment-mode-select">
            <button
              type="button"
              className="admin-payment-mode-trigger"
              onClick={() => setModeMenuOpen((current) => !current)}
              disabled={isBusy}
              aria-haspopup="listbox"
              aria-expanded={modeMenuOpen}
            >
              <span>{activeMode.label}</span>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {modeMenuOpen ? (
              <div className="admin-payment-mode-menu" role="listbox">
                {ADJUSTMENT_MODES.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    className={mode === entry.key ? "is-active" : ""}
                    onClick={() => selectMode(entry.key)}
                    disabled={isBusy}
                    role="option"
                    aria-selected={mode === entry.key}
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className={`smallbtn table-payment-note-btn admin-payment-reason-btn ${
              reason.trim() ? "is-filled" : ""
            }`}
            onClick={openReasonEditor}
            disabled={isBusy}
            aria-label="Motivazione rettifica"
            title="Motivazione rettifica"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 4h14v16H5z" />
              <path d="M8 8h8M8 12h8M8 16h5" />
            </svg>
          </button>
        </div>

        <div className="admin-payment-adjustment-body">
          {mode === "manual_total" ? (
            <label className="table-detail-field">
              <span>Totale da riscuotere</span>
              <input
                value={value}
                inputMode="decimal"
                onChange={(event) => setValue(event.target.value)}
                disabled={isBusy}
              />
            </label>
          ) : null}

          {mode === "discount" ? (
            <label className="table-detail-field">
              <span>Sconto percentuale</span>
              <input
                value={percent}
                inputMode="decimal"
                placeholder="10"
                onChange={(event) => setPercent(event.target.value)}
                disabled={isBusy}
              />
            </label>
          ) : null}

          {mode === "allowance" ? (
            <label className="table-detail-field">
              <span>Importo abbuono</span>
              <input
                value={value}
                inputMode="decimal"
                placeholder="0,00"
                onChange={(event) => setValue(event.target.value)}
                disabled={isBusy}
              />
            </label>
          ) : null}

          {mode === "line_price_override" ? (
            <div className="admin-payment-line-list">
              <div className="admin-payment-line-scroll">
                {lineDrafts.map(({ group, rawValue, adjustedSubtotal }) => (
                  <ArticleLineDraft
                    key={group.id}
                    group={group}
                    value={rawValue}
                    adjustedSubtotal={adjustedSubtotal}
                    disabled={isBusy}
                    onChange={(nextValue) =>
                      setLineAmounts((current) => ({ ...current, [group.id]: nextValue }))
                    }
                  />
                ))}
                {lineDrafts.length === 0 ? (
                  <div className="table-payment-empty">Nessun articolo pagabile.</div>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="admin-payment-adjustment-summary">
            <div>
              <span>Originale</span>
              <strong>{formatCurrency(originalAmount)}</strong>
            </div>
            <div>
              <span>Differenza</span>
              <strong>
                {differenceAmount > 0 ? "+" : ""}
                {formatCurrency(differenceAmount)}
              </strong>
            </div>
            <div className="is-final">
              <span>Finale</span>
              <strong>{formatCurrency(adjustedAmount)}</strong>
            </div>
          </div>
          {submitError ? (
            <div className="table-detail-error admin-payment-submit-error" role="alert">
              {submitError}
            </div>
          ) : null}
        </div>

        <footer className="admin-payment-adjustment-actions">
          <button
            type="button"
            className="smallbtn admin-payment-apply-only"
            onClick={() => void apply(false)}
            disabled={!canApply}
          >
            {submitting === "apply" ? (
              <span className="msr-submit-spinner" aria-hidden="true" />
            ) : (
              <AdminPaymentSaveIcon />
            )}
            {submitting === "apply" ? "SALVATAGGIO..." : "APPLICA"}
          </button>
          <button
            type="button"
            className="smallbtn admin-payment-apply-collect"
            onClick={() => void apply(true)}
            disabled={!canApplyAndCollect}
          >
            {submitting === "collect" ? (
              <span className="msr-submit-spinner" aria-hidden="true" />
            ) : (
              <AdminPaymentCollectIcon />
            )}
            {submitting === "collect" ? "SALVATAGGIO..." : "APPLICA E RISCUOTI"}
          </button>
        </footer>

        {reasonEditorOpen ? (
          <div
            className="admin-payment-reason-modal-backdrop"
            onClick={(event) => {
              event.stopPropagation();
              setReasonEditorOpen(false);
            }}
          >
            <section
              className="admin-payment-reason-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Motivazione rettifica"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="table-payment-note-head">
                <strong>Motivazione rettifica</strong>
                <button
                  type="button"
                  className="smallbtn table-payment-note-close"
                  onClick={() => setReasonEditorOpen(false)}
                  aria-label="Chiudi"
                >
                  <svg viewBox="0 0 24 24" className="table-detail-close-icon" aria-hidden="true">
                    <path d="M6 6l12 12M18 6l-12 12" />
                  </svg>
                </button>
              </div>
              <label className="table-detail-field admin-payment-reason-field">
                <span>Motivazione opzionale</span>
                <textarea
                  value={reasonDraft}
                  rows={4}
                  maxLength={240}
                  autoFocus
                  onChange={(event) => setReasonDraft(event.target.value)}
                  disabled={isBusy}
                  placeholder="Aggiungi una nota interna"
                />
              </label>
              <div className="admin-payment-reason-actions">
                <button
                  type="button"
                  className="smallbtn admin-payment-reason-clear"
                  onClick={() => {
                    setReason("");
                    setReasonDraft("");
                    setReasonEditorOpen(false);
                  }}
                  disabled={busy || !reason.trim()}
                >
                  <AdminPaymentEraserIcon />
                  Svuota
                </button>
                <button
                  type="button"
                  className="smallbtn table-payment-note-save"
                  onClick={saveReason}
                  disabled={isBusy}
                >
                  <AdminPaymentSaveIcon />
                  Conferma
                </button>
              </div>
            </section>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ArticleLineDraft({
  group,
  value,
  adjustedSubtotal,
  disabled,
  onChange,
}: {
  group: ArticleLineGroup;
  value: string;
  adjustedSubtotal: number;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="admin-payment-line-row">
      <div className="admin-payment-line-title">
        <strong>{group.quantity > 1 ? `${group.quantity}x ${group.name}` : group.name}</strong>
        <span>
          {[group.variantName, group.note].filter(Boolean).join(" · ") ||
            `Quantità ${group.quantity}`}
        </span>
      </div>
      <label className="admin-payment-line-unit-price">
        <span>Importo</span>
        <input
          value={value}
          inputMode="decimal"
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-label={`Importo ${group.name}`}
        />
      </label>
      <div className="admin-payment-line-subtotal">
        <span>Subtotale</span>
        <strong>{formatCurrency(adjustedSubtotal)}</strong>
      </div>
    </div>
  );
}
