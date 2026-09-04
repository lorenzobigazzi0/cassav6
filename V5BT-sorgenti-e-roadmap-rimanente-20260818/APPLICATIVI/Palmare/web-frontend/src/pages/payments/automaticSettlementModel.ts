export type AutomaticSettlementContext = {
  cashTotalCents: number;
  automaticCashFloatCents: number;
  cashFloatId: string | null;
  assignmentId?: string | null;
  combinationId?: string | null;
  businessEveningKey?: string | null;
  deviceUuid?: string | null;
};

const toCents = (value: number) => Math.max(0, Math.round(value));

export function automaticSettlementExpectedDepositTotalCents(context: AutomaticSettlementContext) {
  return toCents(context.cashTotalCents) + toCents(context.automaticCashFloatCents);
}

export function automaticSettlementDifferenceCents(
  expectedDepositTotalCents: number,
  depositedTotalCents: number
) {
  return Math.abs(toCents(expectedDepositTotalCents) - toCents(depositedTotalCents));
}
