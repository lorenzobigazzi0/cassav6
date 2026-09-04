import { describe, expect, it } from "vitest";
import type { DiningTableOrder } from "../src/api/tables";
import {
  expandOrderToArticleUnits,
  groupPaymentArticleUnits,
} from "../src/pages/home/tables/payment/paymentArticleUnits";

const makeOrder = (partial: Partial<DiningTableOrder>): DiningTableOrder => ({
  id: "ord_1",
  title: "Comanda 1",
  createdAt: 1000,
  total: 0,
  state: "served",
  paidArticleUnits: [],
  lines: [],
  ...partial,
});

describe("payment article units", () => {
  it("uses emitted line final prices for article payment units", () => {
    const units = expandOrderToArticleUnits([
      makeOrder({
        id: "ord_1730",
        total: 15,
        lines: [
          { name: "Spritz", qty: 1, unitFinalPrice: 7 },
          { name: "Negroni", qty: 1, unitFinalPrice: 8 },
        ],
      }),
    ]);

    expect(units.map((unit) => unit.amount)).toEqual([7, 8]);
    expect(units.reduce((sum, unit) => sum + unit.amount, 0)).toBe(15);
  });

  it("filters already paid article units", () => {
    const units = expandOrderToArticleUnits([
      makeOrder({
        id: "ord_partial",
        total: 12,
        paidArticleUnits: ["ord_partial_0_0"],
        lines: [{ name: "Pinsa", qty: 2, unitFinalPrice: 6 }],
      }),
    ]);

    expect(units.map((unit) => unit.id)).toEqual(["ord_partial_0_1"]);
    expect(units[0].amount).toBe(6);
  });

  it("does not rebalance visible article prices on a later adjusted order total", () => {
    const units = expandOrderToArticleUnits([
      makeOrder({
        id: "ord_gazebo_7",
        total: 8,
        lines: [
          { name: "Ichnusa", qty: 1, unitFinalPrice: 4.5 },
          { name: "Birra", qty: 1, unitFinalPrice: 5 },
        ],
      }),
    ]);

    expect(units.map((unit) => unit.amount)).toEqual([4.5, 5]);
  });

  it("groups units by order from newest to oldest", () => {
    const groups = groupPaymentArticleUnits(
      expandOrderToArticleUnits([
        makeOrder({
          id: "old",
          title: "Vecchia",
          createdAt: 100,
          total: 5,
          lines: [{ name: "Acqua", qty: 1, unitFinalPrice: 5 }],
        }),
        makeOrder({
          id: "new",
          title: "Nuova",
          createdAt: 200,
          total: 7,
          lines: [{ name: "Cocktail", qty: 1, unitFinalPrice: 7 }],
        }),
      ])
    );

    expect(groups.map((group) => group.orderId)).toEqual(["new", "old"]);
  });
});
