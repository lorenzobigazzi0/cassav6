import type {
  DiningTableOrder,
  DiningTableOrderLine,
  TablePaymentAdminLineAdjustment,
} from "../../../../domain/tables/types";

export type PaymentAdjustmentUnit = {
  id: string;
  orderId: string;
  lineId: string;
  lineIndex: number;
  unitIndex: number;
  name: string;
  amount: number;
  adjustable: boolean;
};

export type PaymentAdjustmentDistribution = {
  originalTotalCents: number;
  targetTotalCents: number;
  differenceCents: number;
  lineAdjustments: TablePaymentAdminLineAdjustment[];
};

const toCents = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.max(0, Math.round(parsed * 100));
};

const toMoney = (cents: number) => Math.max(0, Math.trunc(cents)) / 100;

const sumCents = (values: number[]) => values.reduce((sum, value) => sum + value, 0);

const normalizeStepCents = (value: unknown) => {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 1 ? parsed : 1;
};

export function distributePaymentAdjustment(
  units: PaymentAdjustmentUnit[],
  targetTotal: number,
  options: { stepCents?: number } = {}
): PaymentAdjustmentDistribution {
  const stepCents = normalizeStepCents(options.stepCents);
  const targetTotalCents = toCents(targetTotal);
  const normalized = units.map((unit, index) => ({
    unit,
    index,
    currentCents: toCents(unit.amount),
  }));
  const originalTotalCents = sumCents(normalized.map((entry) => entry.currentCents));
  const fixedTotalCents = sumCents(
    normalized.filter((entry) => !entry.unit.adjustable).map((entry) => entry.currentCents)
  );
  const adjustable = normalized.filter((entry) => entry.unit.adjustable && entry.currentCents > 0);

  if (targetTotalCents < fixedTotalCents) {
    throw new Error("Il nuovo totale e inferiore agli articoli non rettificabili.");
  }
  if (adjustable.length === 0) {
    if (targetTotalCents !== originalTotalCents) {
      throw new Error("Nessun articolo rettificabile disponibile.");
    }
    return {
      originalTotalCents,
      targetTotalCents,
      differenceCents: 0,
      lineAdjustments: normalized.map(({ unit, currentCents }) => ({
        articleUnitId: unit.id,
        orderId: unit.orderId,
        lineId: unit.lineId,
        lineIndex: unit.lineIndex,
        unitIndex: unit.unitIndex,
        name: unit.name,
        originalAmount: toMoney(currentCents),
        adjustedAmount: toMoney(currentCents),
      })),
    };
  }

  const adjustableTargetCents = targetTotalCents - fixedTotalCents;
  const adjustableSourceCents = sumCents(adjustable.map((entry) => entry.currentCents));
  // Quota proporzionale troncata al passo richiesto (1 centesimo di default,
  // 5 quando la rettifica arriva dal carrello). Il resto viene poi distribuito
  // a scalare, un passo per volta, cosi' le righe restano multiple del passo.
  const allocations = adjustable.map((entry) => {
    const exactCents = (adjustableTargetCents * entry.currentCents) / adjustableSourceCents;
    const steppedCents = Math.floor(exactCents / stepCents) * stepCents;
    return {
      ...entry,
      adjustedCents: Math.min(steppedCents, entry.currentCents),
      remainder: exactCents - steppedCents,
    };
  });
  let residualCents =
    adjustableTargetCents - sumCents(allocations.map((entry) => entry.adjustedCents));
  const byRemainder = [...allocations].sort(
    (left, right) => right.remainder - left.remainder || left.index - right.index
  );
  // Giri ripetuti: ogni riga puo' assorbire piu' di un passo quando il resto e'
  // grande, ma nessuna puo' superare il proprio importo originale.
  while (residualCents >= stepCents) {
    const before = residualCents;
    for (const entry of byRemainder) {
      if (residualCents < stepCents) break;
      if (entry.adjustedCents + stepCents > entry.currentCents) continue;
      entry.adjustedCents += stepCents;
      residualCents -= stepCents;
    }
    if (residualCents === before) break;
  }
  // Coda sotto il passo: capita quando il totale richiesto non e' multiplo del
  // passo. Finisce su una sola riga, l'unica che restera' non multipla.
  if (residualCents > 0) {
    const target =
      byRemainder.find((entry) => entry.adjustedCents + residualCents <= entry.currentCents) ??
      byRemainder[0];
    if (target) {
      target.adjustedCents += residualCents;
      residualCents = 0;
    }
  }

  const adjustedById = new Map(
    allocations.map((entry) => [entry.unit.id, entry.adjustedCents] as const)
  );
  const lineAdjustments = normalized.map(({ unit, currentCents }) => ({
    articleUnitId: unit.id,
    orderId: unit.orderId,
    lineId: unit.lineId,
    lineIndex: unit.lineIndex,
    unitIndex: unit.unitIndex,
    name: unit.name,
    originalAmount: toMoney(currentCents),
    adjustedAmount: toMoney(adjustedById.get(unit.id) ?? currentCents),
  }));
  const distributedTotalCents = sumCents(
    lineAdjustments.map((entry) => toCents(entry.adjustedAmount))
  );
  if (distributedTotalCents !== targetTotalCents) {
    throw new Error(
      `Ripartizione non coerente: attesi ${targetTotalCents} centesimi, ottenuti ${distributedTotalCents}.`
    );
  }

  return {
    originalTotalCents,
    targetTotalCents,
    differenceCents: targetTotalCents - originalTotalCents,
    lineAdjustments,
  };
}

export function buildExplicitPaymentAdjustment(
  units: PaymentAdjustmentUnit[],
  adjustedAmountsByUnitId: ReadonlyMap<string, number>,
  targetTotal: number
): PaymentAdjustmentDistribution {
  const originalTotalCents = sumCents(units.map((unit) => toCents(unit.amount)));
  const targetTotalCents = toCents(targetTotal);
  const lineAdjustments = units.map((unit) => {
    const originalCents = toCents(unit.amount);
    const requested = adjustedAmountsByUnitId.get(unit.id);
    const adjustedCents =
      unit.adjustable && requested !== undefined ? toCents(requested) : originalCents;
    return {
      articleUnitId: unit.id,
      orderId: unit.orderId,
      lineId: unit.lineId,
      lineIndex: unit.lineIndex,
      unitIndex: unit.unitIndex,
      name: unit.name,
      originalAmount: toMoney(originalCents),
      adjustedAmount: toMoney(adjustedCents),
    };
  });
  const distributedTotalCents = sumCents(
    lineAdjustments.map((entry) => toCents(entry.adjustedAmount))
  );
  if (distributedTotalCents !== targetTotalCents) {
    throw new Error(
      `Ripartizione non coerente: attesi ${targetTotalCents} centesimi, ottenuti ${distributedTotalCents}.`
    );
  }
  return {
    originalTotalCents,
    targetTotalCents,
    differenceCents: targetTotalCents - originalTotalCents,
    lineAdjustments,
  };
}

export function applyPaymentAdjustmentToDiningOrder(
  order: DiningTableOrder,
  adjustments: TablePaymentAdminLineAdjustment[]
): DiningTableOrder {
  const byArticleUnitId = new Map(
    adjustments
      .filter((entry) => entry.orderId === order.id && entry.articleUnitId)
      .map((entry) => [entry.articleUnitId, toCents(entry.adjustedAmount)] as const)
  );
  const byLineAndUnit = new Map(
    adjustments
      .filter((entry) => entry.orderId === order.id)
      .map(
        (entry) => [`${entry.lineIndex}:${entry.unitIndex}`, toCents(entry.adjustedAmount)] as const
      )
  );
  const nextLines: DiningTableOrderLine[] = [];
  order.lines.forEach((line, lineIndex) => {
    const quantity = Math.max(1, Math.trunc(Number(line.qty) || 1));
    const originalCents = toCents(line.unitFinalPrice ?? line.unitBasePrice);
    const unitCents = Array.from({ length: quantity }, (_, unitIndex) => {
      const articleUnitId = line.articleUnitIds?.[unitIndex];
      return (
        (articleUnitId ? byArticleUnitId.get(articleUnitId) : undefined) ??
        byLineAndUnit.get(`${lineIndex}:${unitIndex}`) ??
        originalCents
      );
    });
    const priceGroups = new Map<number, number[]>();
    unitCents.forEach((cents, unitIndex) => {
      const indexes = priceGroups.get(cents) ?? [];
      indexes.push(unitIndex);
      priceGroups.set(cents, indexes);
    });
    [...priceGroups.entries()].forEach(([cents, unitIndexes], groupIndex) => {
      nextLines.push({
        ...line,
        lineId:
          groupIndex === 0
            ? line.lineId
            : `${line.lineId || `line_${lineIndex + 1}`}_adj_${cents}_${groupIndex}`,
        articleUnitIds: line.articleUnitIds
          ? (unitIndexes
              .map((unitIndex) => line.articleUnitIds?.[unitIndex])
              .filter(Boolean) as string[])
          : undefined,
        qty: unitIndexes.length,
        unitFinalPrice: toMoney(cents),
        priceDelta: toMoney(cents) - (line.unitBasePrice ?? toMoney(originalCents)),
        priceChanged: cents !== toCents(line.unitBasePrice ?? line.unitFinalPrice),
        priceChangeReason: "manual",
      });
    });
  });
  const totalCents = nextLines.reduce(
    (sum, line) => sum + toCents(line.unitFinalPrice ?? line.unitBasePrice) * line.qty,
    0
  );
  const paidCents = toCents(order.paidAmount);
  return {
    ...order,
    lines: nextLines,
    total: toMoney(totalCents),
    paidAmount: toMoney(Math.min(paidCents, totalCents)),
    dueAmount: toMoney(Math.max(totalCents - paidCents, 0)),
  };
}
