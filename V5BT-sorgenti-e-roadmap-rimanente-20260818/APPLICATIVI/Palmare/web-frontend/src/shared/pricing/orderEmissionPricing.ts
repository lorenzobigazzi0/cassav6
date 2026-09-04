export type OrderEmissionLineInput = {
  qty: number;
  unitBasePrice?: number;
  unitFinalPrice?: number;
};

export type OrderEmissionUnitAmount = {
  id: string;
  rowIndex: number;
  unitIndex: number;
  amount: number;
};

export type OrderEmissionPricingMode = "balance-to-total" | "preserve-line-prices";

const toCents = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.max(0, Math.round(parsed * 100));
};

const expandUnitBaseCents = (lines: OrderEmissionLineInput[]) => {
  const units: Array<{ rowIndex: number; unitIndex: number; cents: number }> = [];
  lines.forEach((line, rowIndex) => {
    const qty = Math.max(1, Math.round(Number(line.qty) || 1));
    const cents = toCents(line.unitFinalPrice ?? line.unitBasePrice);
    for (let unitIndex = 0; unitIndex < qty; unitIndex += 1) {
      units.push({ rowIndex, unitIndex, cents });
    }
  });
  return units;
};

const equalSplitCents = (totalCents: number, count: number) => {
  if (count <= 0) return [];
  const baseCents = Math.floor(totalCents / count);
  let remainder = totalCents - baseCents * count;
  return Array.from({ length: count }, () => {
    const cents = baseCents + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    return cents;
  });
};

const proportionalCents = (
  totalCents: number,
  units: Array<{ rowIndex: number; unitIndex: number; cents: number }>
) => {
  const sourceTotal = units.reduce((sum, unit) => sum + unit.cents, 0);
  if (sourceTotal <= 0) return equalSplitCents(totalCents, units.length);

  const scaled = units.map((unit, index) => {
    const raw = (unit.cents * totalCents) / sourceTotal;
    const cents = Math.floor(raw);
    return { index, cents, fraction: raw - cents };
  });
  let remainder = totalCents - scaled.reduce((sum, unit) => sum + unit.cents, 0);
  scaled
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index)
    .forEach((unit) => {
      if (remainder <= 0) return;
      unit.cents += 1;
      remainder -= 1;
    });
  return scaled.sort((left, right) => left.index - right.index).map((unit) => unit.cents);
};

export function expandOrderEmissionUnitAmounts({
  orderId,
  total,
  lines,
  pricingMode = "balance-to-total",
}: {
  orderId: string;
  total: number;
  lines: OrderEmissionLineInput[];
  pricingMode?: OrderEmissionPricingMode;
}): OrderEmissionUnitAmount[] {
  const units = expandUnitBaseCents(lines);
  if (units.length === 0) return [];

  const totalCents = toCents(total);
  const sourceTotalCents = units.reduce((sum, unit) => sum + unit.cents, 0);
  const centsByUnit =
    pricingMode === "preserve-line-prices" && sourceTotalCents > 0
      ? units.map((unit) => unit.cents)
      : sourceTotalCents > 0 && sourceTotalCents === totalCents
        ? units.map((unit) => unit.cents)
        : proportionalCents(totalCents, units);

  return units.map((unit, index) => ({
    id: `${orderId}_${unit.rowIndex}_${unit.unitIndex}`,
    rowIndex: unit.rowIndex,
    unitIndex: unit.unitIndex,
    amount: centsByUnit[index] / 100,
  }));
}
