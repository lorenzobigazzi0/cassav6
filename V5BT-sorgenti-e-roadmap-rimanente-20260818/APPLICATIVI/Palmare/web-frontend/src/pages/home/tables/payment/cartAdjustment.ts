import type {
  TablePaymentAdminAdjustment,
  TablePaymentAdminAdjustmentType,
} from "../../../../domain/tables/types";
import { distributePaymentAdjustment } from "./paymentAdjustmentDistribution";

/** Passo di arrotondamento delle rettifiche che arrivano dal carrello. */
export const CART_ADJUSTMENT_STEP_CENTS = 5;

/**
 * Rettifica di pagamento riportata sul carrello.
 *
 * Vive accanto al draft del compositore, non dentro `DraftItem`: quest'ultimo
 * viene fuso, normalizzato e persistito in sessione, e sporcarlo con dati di
 * pagamento renderebbe fragile tutta quella catena.
 *
 * `perItem` e' indicizzato per id di riga carrello e contiene i **totali di
 * riga** (non i prezzi unitari), perche' e' il totale di riga cio' che il
 * carrello mostra in `table-order-item-total`.
 */
export type CartAdjustmentLine = {
  originalTotal: number;
  adjustedTotal: number;
};

export type CartAdjustment = {
  type: TablePaymentAdminAdjustmentType;
  reason: string;
  /** `total` = importo/sconto/abbuono, `line` = rettifica per singolo articolo. */
  scope: "total" | "line";
  /** L'abbuono non tocca i prezzi degli articoli: si scala dal totale. */
  affectsItems: boolean;
  /** Riduzione complessiva, sempre positiva. */
  totalReduction: number;
  perItem: Record<string, CartAdjustmentLine>;
};

const round = (value: number) => Math.round(value * 100) / 100;

export const ADJUSTMENT_LABELS: Record<TablePaymentAdminAdjustmentType, string> = {
  manual_total: "Importo",
  discount: "Sconto",
  allowance: "Abbuono",
  line_price_override: "Articoli",
};

/** Riduzioni sempre in negativo: `-1,00 €`. */
export function formatReduction(amount: number, formatCurrency: (value: number) => string) {
  return `-${formatCurrency(Math.abs(round(amount)))}`;
}

export function isLineScopedAdjustment(type: TablePaymentAdminAdjustmentType) {
  return type === "line_price_override";
}

/** L'abbuono resta fuori dai singoli articoli: incide solo sul totale. */
export function adjustmentAffectsItems(type: TablePaymentAdminAdjustmentType) {
  return type !== "allowance";
}

/**
 * Traduce la ripartizione per unita'-articolo prodotta dal dialogo in totali di
 * riga carrello. `draftItemIds[lineIndex]` e' la traccia parallela restituita da
 * `buildOrderDraftSubmit`.
 */
export function buildCartAdjustment(
  adjustment: TablePaymentAdminAdjustment,
  draftItemIds: readonly string[]
): CartAdjustment | null {
  const totalReduction = round(
    Math.max(0, adjustment.originalAmount - adjustment.adjustedAmount)
  );
  if (totalReduction <= 0) return null;

  const affectsItems = adjustmentAffectsItems(adjustment.type);
  const perItem: Record<string, CartAdjustmentLine> = {};

  if (affectsItems) {
    for (const line of adjustment.lineAdjustments ?? []) {
      const draftItemId = draftItemIds[line.lineIndex];
      if (!draftItemId) continue;
      const current = perItem[draftItemId] ?? { originalTotal: 0, adjustedTotal: 0 };
      perItem[draftItemId] = {
        originalTotal: round(current.originalTotal + line.originalAmount),
        adjustedTotal: round(current.adjustedTotal + line.adjustedAmount),
      };
    }
    // Righe rimaste identiche: non sono rettifiche, non vanno evidenziate.
    for (const [itemId, line] of Object.entries(perItem)) {
      if (Math.abs(line.originalTotal - line.adjustedTotal) < 0.005) delete perItem[itemId];
    }
    if (Object.keys(perItem).length === 0) return null;
  }

  return {
    type: adjustment.type,
    reason: adjustment.reason,
    scope: isLineScopedAdjustment(adjustment.type) ? "line" : "total",
    affectsItems,
    totalReduction,
    perItem,
  };
}

/** Riduzione complessiva ricalcolata dalle sole righe ancora rettificate. */
export function cartAdjustmentReduction(adjustment: CartAdjustment): number {
  if (!adjustment.affectsItems) return round(adjustment.totalReduction);
  const fromItems = Object.values(adjustment.perItem).reduce(
    (sum, line) => sum + (line.originalTotal - line.adjustedTotal),
    0
  );
  return round(fromItems);
}

/**
 * Elimina la rettifica di una singola riga. Sul `total` la riduzione e' unica e
 * indivisibile, quindi eliminare significa annullare tutto.
 */
export function removeCartAdjustmentLine(
  adjustment: CartAdjustment,
  draftItemId: string
): CartAdjustment | null {
  if (adjustment.scope === "total") return null;
  const perItem = { ...adjustment.perItem };
  delete perItem[draftItemId];
  if (Object.keys(perItem).length === 0) return null;
  const next: CartAdjustment = { ...adjustment, perItem };
  return { ...next, totalReduction: cartAdjustmentReduction(next) };
}

/**
 * Spalma l'abbuono sui totali di riga al momento dell'invio.
 *
 * Serve perche' il livello fiscale non conosce lo sconto: lo scontrino nasce
 * gia' scontato e gli item vengono accettati solo se sommano all'incassato.
 * Nel carrello l'abbuono resta invece una riga a se', che non tocca i prezzi.
 *
 * Riusa la ripartizione delle rettifiche, cosi' arrotondamento e garanzia di
 * totale esatto sono gli stessi del resto del flusso.
 */
export function materializeAllowanceOnLineTotals(
  lineTotals: readonly number[],
  allowance: number
): number[] {
  const itemsTotal = round(lineTotals.reduce((sum, value) => sum + value, 0));
  const target = round(Math.max(0, itemsTotal - Math.max(0, allowance)));
  if (target >= itemsTotal || itemsTotal <= 0) return [...lineTotals];

  const distribution = distributePaymentAdjustment(
    lineTotals.map((amount, index) => ({
      id: `line_${index}`,
      orderId: "cart",
      lineId: `line_${index}`,
      lineIndex: index,
      unitIndex: 0,
      name: `Riga ${index + 1}`,
      amount,
      adjustable: amount > 0,
    })),
    target,
    { stepCents: CART_ADJUSTMENT_STEP_CENTS }
  );

  const byIndex = new Map(
    distribution.lineAdjustments.map((entry) => [entry.lineIndex, entry.adjustedAmount] as const)
  );
  return lineTotals.map((value, index) => byIndex.get(index) ?? value);
}

/** Totale di riga effettivo, rettifica inclusa. */
export function resolveAdjustedLineTotal(
  adjustment: CartAdjustment | null | undefined,
  draftItemId: string,
  fallbackTotal: number
): { total: number; adjusted: boolean } {
  const line = adjustment?.affectsItems ? adjustment.perItem[draftItemId] : undefined;
  if (!line) return { total: fallbackTotal, adjusted: false };
  return { total: line.adjustedTotal, adjusted: true };
}

/**
 * Riduzione applicata a una riga di comanda gia' inviata.
 *
 * La rettifica arriva come correzione comanda con prezzi unitari riscritti:
 * `priceChangeReason: "manual"` distingue quel caso da varianti e supplementi,
 * che pure alterano il prezzo ma non sono riduzioni.
 */
export function lineManualReduction(line: {
  qty?: number;
  unitBasePrice?: number;
  unitFinalPrice?: number;
  priceChangeReason?: string;
}): number {
  if (line.priceChangeReason !== "manual") return 0;
  const qty = Math.max(1, Math.trunc(Number(line.qty) || 1));
  const base = Number(line.unitBasePrice ?? 0);
  const final = Number(line.unitFinalPrice ?? base);
  if (!Number.isFinite(base) || !Number.isFinite(final) || final >= base) return 0;
  return round((base - final) * qty);
}

type SubmitLineLike = {
  qty: number;
  unitBasePrice?: number;
  unitFinalPrice?: number;
  priceDelta?: number;
  priceChanged?: boolean;
  priceChangeReason?: "variant" | "manual" | "supplement" | "unknown";
};

/**
 * Materializza la rettifica sui prezzi unitari delle righe da inviare.
 *
 * Succede solo all'invio: nel carrello ogni tipo mantiene la propria
 * semantica (l'abbuono non tocca i singoli articoli), ma lo scontrino deve
 * nascere gia' scontato, perche' il livello fiscale di sconti non sa nulla e
 * accetta gli item solo se sommano all'incassato.
 */
export function applyCartAdjustmentToSubmitLines<TLine extends SubmitLineLike>(
  lines: TLine[],
  draftItemIds: readonly string[],
  adjustment: CartAdjustment | null | undefined
): { lines: TLine[]; total: number } {
  const lineTotals = lines.map((line) => round((line.unitFinalPrice ?? 0) * line.qty));
  if (!adjustment) {
    return { lines, total: round(lineTotals.reduce((sum, value) => sum + value, 0)) };
  }

  const adjustedTotals = adjustment.affectsItems
    ? lineTotals.map((value, index) =>
        resolveAdjustedLineTotal(adjustment, draftItemIds[index] ?? "", value).total
      )
    : materializeAllowanceOnLineTotals(lineTotals, adjustment.totalReduction);

  const nextLines = lines.map((line, index) => {
    const nextTotal = adjustedTotals[index];
    if (nextTotal === undefined || Math.abs(nextTotal - lineTotals[index]) < 0.005) return line;
    const qty = Math.max(1, line.qty);
    const unitFinalPrice = round(nextTotal / qty);
    return {
      ...line,
      unitFinalPrice,
      priceDelta: round(unitFinalPrice - (line.unitBasePrice ?? unitFinalPrice)),
      priceChanged: true,
      priceChangeReason: "manual" as const,
    };
  });

  return {
    lines: nextLines,
    total: round(adjustedTotals.reduce((sum, value) => sum + value, 0)),
  };
}
