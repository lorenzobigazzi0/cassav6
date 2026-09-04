import {
  type AnalyticsMovementRecord,
  analyticsSplitModeLabel,
  analyticsTableLabel,
} from "../../../api/analyticsPaymentMovements";
import { fiscalOutcomeLabelFor } from "../../../domain/payments/fiscalOutcome";
import { formatCurrency } from "../../../shared/format/currency";

export type AnalyticsPrintDetailLine = {
  label: string;
  value: string;
};

const normalize = (value: unknown) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const formatValue = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(formatValue).filter(Boolean).join(", ");
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return normalize(value);
};

const line = (label: string, value: unknown): AnalyticsPrintDetailLine | null => {
  const text = formatValue(value);
  return text ? { label, value: text } : null;
};

const money = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) && Math.abs(value) > 0.0001
    ? formatCurrency(value)
    : "";

export const fiscalOutcomeLabel = (record: AnalyticsMovementRecord) =>
  fiscalOutcomeLabelFor(record);

export const paymentProviderLabel = (record: AnalyticsMovementRecord) => {
  const providers = Array.from(
    new Set(record.transactions.map((tx) => normalize(tx.posProvider)).filter(Boolean))
  );
  return providers.join(", ") || normalize(record.raw?.provider || record.raw?.posProvider) || "-";
};

export const buildAnalyticsAdvancedPrintDetails = (
  record: AnalyticsMovementRecord,
  formattedDate: string
) => {
  const fiscalOutcome = fiscalOutcomeLabel(record);
  const originalFiscalDocument = [
    record.fiscalDocType,
    record.raw?.fiscalDocumentNumber || record.fiscalDocNo,
  ]
    .map(normalize)
    .filter(Boolean)
    .join(" ");
  const voidFiscalDocument =
    record.raw?.voidDocumentNumber ||
    record.raw?.voidProviderRef ||
    record.raw?.voidMovementId;

  return [
    line("Data", formattedDate),
    line("Tavolo", analyticsTableLabel(record)),
    line("Operatore", record.operatorName || record.operatorId),
    line("Metodo", record.methodLabel),
    line("Importo", formatCurrency(record.amount)),
    line("Provider", paymentProviderLabel(record)),
    line("ID pagamento/movimento", record.paymentId),
    line("Rif. comanda", record.orderReference || record.orderIds),
    line("Rif. articolo", record.articleReference),
    line("Prodotto", record.productName),
    line("Quantita", record.quantity),
    line("Nota/motivo", record.note),
    line("Tipo split", analyticsSplitModeLabel(record)),
    line(
      fiscalOutcome === "ANNULLATO" ? "Documento fiscale originale" : "Documento fiscale",
      originalFiscalDocument
    ),
    line("Documento di annullamento", voidFiscalDocument),
    line("Data annullamento", record.raw?.voidReceiptDate || record.raw?.voidedAt),
    line("Esito Fiscale", fiscalOutcome),
    line("Tipo rettifica", record.adjustmentKind),
    line("Pagamento originale", record.originalPaymentId || record.supersedesPaymentId),
    line("Sostituito da", record.supersededByPaymentId),
    line("Unita articolo", record.articleUnitIds),
    line("Storno POS", money(record.paymentVoidAmount)),
    line("Riaddebito", money(record.paymentRechargeAmount)),
    line("Pagamento vigente", record.rechargePaymentIds),
    line("TX vigente", record.rechargeTransactionIds),
    ...record.transactions.flatMap((tx, index) => {
      const suffix = record.transactions.length > 1 ? ` ${index + 1}` : "";
      return [
        line(`ID transazione${suffix}`, tx.id),
        line(`Metodo transazione${suffix}`, tx.method || record.methodLabel),
        line(`Importo transazione${suffix}`, formatCurrency(tx.amountPaid)),
        line(`POS ref${suffix}`, tx.posTxRef),
        line(`Provider${suffix}`, tx.posProvider),
        line(`Nota transazione${suffix}`, tx.note),
      ];
    }),
    ...(record.refundPlan?.allocations || []).flatMap((allocation, index) => {
      const suffix = (record.refundPlan?.allocations || []).length > 1 ? ` ${index + 1}` : "";
      return [
        line(`Rimborso pagamento${suffix}`, allocation.paymentId),
        line(`Rimborso metodo${suffix}`, allocation.method),
        line(`Rimborso azione${suffix}`, allocation.action),
        line(`Rimborso importo${suffix}`, formatCurrency(allocation.refundAmount)),
        line(`Annulla POS${suffix}`, formatCurrency(allocation.voidAmount)),
        line(`Riaddebita${suffix}`, formatCurrency(allocation.rechargeAmount)),
        line(`Rimborso TX${suffix}`, allocation.transactionIds),
        line(`Rimborso documento${suffix}`, allocation.fiscalDocNo),
      ];
    }),
  ].filter((entry): entry is AnalyticsPrintDetailLine => entry !== null);
};
