import { describe, expect, it } from "vitest";
import type { CashExchangePieces } from "../src/types/cashExchange";
import {
  CASH_EXCHANGE_DENOMINATIONS,
  canRepresentCashExchangeAmount,
  decrementCashExchangePiece,
  incrementCashExchangePiece,
  normalizeCashExchangePieces,
  sumCashExchangePieces,
} from "../src/pages/payments/cashExchangeDenominations";

describe("cash exchange denominations", () => {
  it("uses the allowed gateway denominations from 20 EUR to 0,05 EUR", () => {
    expect(CASH_EXCHANGE_DENOMINATIONS.map((item) => item.cents)).toEqual([
      2000, 1000, 500, 200, 100, 50, 20, 10, 5,
    ]);
  });

  it("increments only while the selected pieces stay inside the deposited amount", () => {
    let pieces: CashExchangePieces = {};
    pieces = incrementCashExchangePiece(pieces, 2000, 2500);
    pieces = incrementCashExchangePiece(pieces, 1000, 2500);
    pieces = incrementCashExchangePiece(pieces, 500, 2500);

    expect(pieces).toEqual({ "2000": 1, "500": 1 });
    expect(sumCashExchangePieces(pieces)).toBe(2500);
  });

  it("normalizes invalid quantities and removes zero rows", () => {
    expect(normalizeCashExchangePieces({ "1000": 2.8, "500": 0, "-1": 5, abc: 1 })).toEqual({
      "1000": 2,
    });
    expect(decrementCashExchangePiece({ "500": 1 }, 500)).toEqual({});
  });

  it("accepts only positive amounts representable with 5-cent denominations", () => {
    expect(canRepresentCashExchangeAmount(5)).toBe(true);
    expect(canRepresentCashExchangeAmount(3550)).toBe(true);
    expect(canRepresentCashExchangeAmount(0)).toBe(false);
    expect(canRepresentCashExchangeAmount(3)).toBe(false);
  });
});
