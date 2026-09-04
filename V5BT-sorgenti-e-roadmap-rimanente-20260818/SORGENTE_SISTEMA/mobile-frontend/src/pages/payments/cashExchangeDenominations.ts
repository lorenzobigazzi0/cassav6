import type {
  CashExchangeAvailableDenomination,
  CashExchangePieces,
} from "../../types/cashExchange";

export type CashExchangeDenomination = {
  cents: number;
  label: string;
};

export const CASH_EXCHANGE_DENOMINATIONS: CashExchangeDenomination[] = [
  { cents: 2000, label: "20 EUR" },
  { cents: 1000, label: "10 EUR" },
  { cents: 500, label: "5 EUR" },
  { cents: 200, label: "2 EUR" },
  { cents: 100, label: "1 EUR" },
  { cents: 50, label: "0,50 EUR" },
  { cents: 20, label: "0,20 EUR" },
  { cents: 10, label: "0,10 EUR" },
  { cents: 5, label: "0,05 EUR" },
];

export function normalizeCashExchangePieces(pieces: CashExchangePieces): CashExchangePieces {
  return Object.fromEntries(
    Object.entries(pieces)
      .map(([cents, quantity]) => [
        String(Number(cents)),
        Math.max(0, Math.trunc(Number(quantity) || 0)),
      ])
      .filter(([cents, quantity]) => Number(cents) > 0 && Number(quantity) > 0)
  );
}

export function sumCashExchangePieces(pieces: CashExchangePieces): number {
  return Object.entries(normalizeCashExchangePieces(pieces)).reduce((sum, [cents, quantity]) => {
    return sum + Number(cents) * quantity;
  }, 0);
}

export function incrementCashExchangePiece(
  pieces: CashExchangePieces,
  denominationCents: number,
  depositedCents: number,
  maxPieces = Number.POSITIVE_INFINITY
): CashExchangePieces {
  const selectedTotal = sumCashExchangePieces(pieces);
  if (selectedTotal + denominationCents > depositedCents) return pieces;
  const key = String(denominationCents);
  if ((pieces[key] || 0) >= maxPieces) return pieces;
  return normalizeCashExchangePieces({ ...pieces, [key]: (pieces[key] || 0) + 1 });
}

export function decrementCashExchangePiece(
  pieces: CashExchangePieces,
  denominationCents: number
): CashExchangePieces {
  const key = String(denominationCents);
  const current = pieces[key] || 0;
  if (current <= 0) return pieces;
  return normalizeCashExchangePieces({ ...pieces, [key]: current - 1 });
}

export function canRepresentCashExchangeAmount(amountCents: number): boolean {
  return Number.isInteger(amountCents) && amountCents > 0 && amountCents % 5 === 0;
}

export function normalizeCashExchangeAvailableDenominations(
  input: CashExchangeAvailableDenomination[] | undefined
): CashExchangeAvailableDenomination[] {
  if (!Array.isArray(input)) return [];
  const byCents = new Map<number, CashExchangeAvailableDenomination>();
  for (const entry of input) {
    const cents = Math.trunc(Number(entry?.cents));
    const availablePieces = Math.max(0, Math.trunc(Number(entry?.availablePieces) || 0));
    if (!Number.isFinite(cents) || cents <= 0) continue;
    byCents.set(cents, {
      cents,
      label: typeof entry.label === "string" ? entry.label : undefined,
      availablePieces,
      reservedPieces: Math.max(0, Math.trunc(Number(entry.reservedPieces) || 0)),
    });
  }
  return [...byCents.values()].sort((left, right) => right.cents - left.cents);
}
