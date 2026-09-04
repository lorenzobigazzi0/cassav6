import { describe, expect, it } from "vitest";
import type { DiningTableOrder } from "../src/api/tables";
import {
  applyPaymentAdjustmentToDiningOrder,
  buildExplicitPaymentAdjustment,
  distributePaymentAdjustment,
  type PaymentAdjustmentUnit,
} from "../src/pages/home/tables/payment/paymentAdjustmentDistribution";

const unit = (
  id: string,
  amount: number,
  patch: Partial<PaymentAdjustmentUnit> = {}
): PaymentAdjustmentUnit => ({
  id,
  orderId: "order_1",
  lineId: `line_${id}`,
  lineIndex: Number(id.replace(/\D/g, "")) || 0,
  unitIndex: 0,
  name: `Articolo ${id}`,
  amount,
  adjustable: true,
  ...patch,
});

const adjustmentTotalCents = (result: ReturnType<typeof distributePaymentAdjustment>) =>
  result.lineAdjustments.reduce((sum, entry) => sum + Math.round(entry.adjustedAmount * 100), 0);

describe("distributePaymentAdjustment con passo da 5 centesimi", () => {
  const cents = (value: number) => Math.round(value * 100);

  it("lascia tutte le righe multiple di 5 quando il totale lo e'", () => {
    const units = [unit("u1", 12.3), unit("u2", 7.45), unit("u3", 20.25)];
    const result = distributePaymentAdjustment(units, 32, { stepCents: 5 });

    expect(adjustmentTotalCents(result)).toBe(3200);
    result.lineAdjustments.forEach((entry) => {
      expect(cents(entry.adjustedAmount) % 5).toBe(0);
    });
  });

  it("concentra su una sola riga il resto sotto i 5 centesimi", () => {
    const units = [unit("u1", 12.3), unit("u2", 7.45), unit("u3", 20.25)];
    const result = distributePaymentAdjustment(units, 31.33, { stepCents: 5 });

    expect(adjustmentTotalCents(result)).toBe(3133);
    const nonMultiple = result.lineAdjustments.filter((entry) => cents(entry.adjustedAmount) % 5 !== 0);
    expect(nonMultiple).toHaveLength(1);
  });

  it("non riduce mai una riga sotto zero ne' oltre il suo importo originale", () => {
    const units = [unit("u1", 3), unit("u2", 0.1), unit("u3", 45.9)];
    const result = distributePaymentAdjustment(units, 4, { stepCents: 5 });

    expect(adjustmentTotalCents(result)).toBe(400);
    result.lineAdjustments.forEach((entry) => {
      expect(entry.adjustedAmount).toBeGreaterThanOrEqual(0);
      expect(entry.adjustedAmount).toBeLessThanOrEqual(entry.originalAmount);
    });
  });

  it("mantiene il totale esatto su una raffica di importi casuali", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const units = [
        unit("u1", (seed * 7) % 40 || 1),
        unit("u2", (seed * 3) % 25 || 2),
        unit("u3", (seed * 11) % 17 || 3),
      ];
      const original = units.reduce((sum, entry) => sum + entry.amount, 0);
      const target = Math.max(0.05, Math.round((original * 0.73 + seed * 0.01) * 100) / 100);
      if (target > original) continue;
      const result = distributePaymentAdjustment(units, target, { stepCents: 5 });
      expect(adjustmentTotalCents(result)).toBe(cents(target));
    }
  });
});

describe("distributePaymentAdjustment", () => {
  it("distribuisce una diminuzione proporzionale con totale esatto al centesimo", () => {
    const result = distributePaymentAdjustment(
      [unit("u1", 3.33), unit("u2", 3.33), unit("u3", 3.34)],
      9.99
    );

    expect(result.differenceCents).toBe(-1);
    expect(adjustmentTotalCents(result)).toBe(999);
    expect(result.lineAdjustments.map((entry) => entry.adjustedAmount)).toEqual([3.33, 3.33, 3.33]);
  });

  it("distribuisce un aumento e assegna deterministicamente i centesimi residui", () => {
    const result = distributePaymentAdjustment(
      [unit("u1", 3.33), unit("u2", 3.33), unit("u3", 3.34)],
      10.01
    );

    expect(result.differenceCents).toBe(1);
    expect(adjustmentTotalCents(result)).toBe(1001);
    expect(result.lineAdjustments.map((entry) => entry.adjustedAmount)).toEqual([3.33, 3.33, 3.35]);
  });

  it("non modifica le unita pagate e ripartisce solo sulle righe idonee", () => {
    const result = distributePaymentAdjustment(
      [unit("paid", 2, { adjustable: false }), unit("u1", 3), unit("u2", 5)],
      8
    );

    expect(result.lineAdjustments[0]?.adjustedAmount).toBe(2);
    expect(result.lineAdjustments.slice(1).map((entry) => entry.adjustedAmount)).toEqual([
      2.25, 3.75,
    ]);
    expect(adjustmentTotalCents(result)).toBe(800);
  });

  it("blocca una riduzione inferiore al valore delle righe non rettificabili", () => {
    expect(() =>
      distributePaymentAdjustment([unit("paid", 4, { adjustable: false }), unit("u1", 6)], 3.99)
    ).toThrow(/inferiore agli articoli non rettificabili/i);
  });

  it("mantiene le righe non rettificabili anche nella rettifica esplicita", () => {
    const result = buildExplicitPaymentAdjustment(
      [unit("paid", 2, { adjustable: false }), unit("u1", 3)],
      new Map([
        ["paid", 0],
        ["u1", 4],
      ]),
      6
    );

    expect(result.lineAdjustments.map((entry) => entry.adjustedAmount)).toEqual([2, 4]);
    expect(result.targetTotalCents).toBe(600);
  });
});

describe("applyPaymentAdjustmentToDiningOrder", () => {
  it("gestisce quantita maggiori di uno e conserva IVA, reparto e identificativi unita", () => {
    const order: DiningTableOrder = {
      id: "order_1",
      title: "Comanda 1",
      createdAt: 1,
      total: 10,
      dueAmount: 8,
      paidAmount: 2,
      state: "served",
      workflowStatus: "delivered",
      paymentStatus: "partial",
      paidArticleUnits: ["order_1_0_0"],
      lines: [
        {
          lineId: "line_original",
          articleUnitIds: ["order_1_0_0", "order_1_0_1"],
          productId: "product_1",
          name: "Piatto",
          qty: 2,
          unitBasePrice: 5,
          unitFinalPrice: 5,
          vatRate: 10,
          vatCode: "IVA10",
          modifiers: { cottura: "media" },
        },
      ],
    };

    const adjusted = applyPaymentAdjustmentToDiningOrder(order, [
      {
        articleUnitId: "order_1_0_0",
        orderId: "order_1",
        lineId: "line_original",
        lineIndex: 0,
        unitIndex: 0,
        name: "Piatto",
        originalAmount: 5,
        adjustedAmount: 5,
      },
      {
        articleUnitId: "order_1_0_1",
        orderId: "order_1",
        lineId: "line_original",
        lineIndex: 0,
        unitIndex: 1,
        name: "Piatto",
        originalAmount: 5,
        adjustedAmount: 4.01,
      },
    ]);

    expect(adjusted.total).toBe(9.01);
    expect(adjusted.dueAmount).toBe(7.01);
    expect(adjusted.lines).toHaveLength(2);
    expect(adjusted.lines.map((line) => line.qty)).toEqual([1, 1]);
    expect(adjusted.lines.map((line) => line.articleUnitIds)).toEqual([
      ["order_1_0_0"],
      ["order_1_0_1"],
    ]);
    for (const line of adjusted.lines) {
      expect(line.productId).toBe("product_1");
      expect(line.vatRate).toBe(10);
      expect(line.vatCode).toBe("IVA10");
      expect(line.modifiers).toEqual({ cottura: "media" });
    }
  });

  it("usa gli identificativi stabili quando una riga e gia divisa per prezzo", () => {
    const order: DiningTableOrder = {
      id: "order_1",
      title: "Comanda 1",
      createdAt: 1,
      total: 9,
      dueAmount: 9,
      paidAmount: 0,
      state: "served",
      workflowStatus: "delivered",
      paymentStatus: "unpaid",
      lines: [
        {
          lineId: "line_original",
          articleUnitIds: ["order_1_0_0"],
          name: "Piatto",
          qty: 1,
          unitBasePrice: 5,
          unitFinalPrice: 5,
        },
        {
          lineId: "line_original",
          articleUnitIds: ["order_1_0_1"],
          name: "Piatto",
          qty: 1,
          unitBasePrice: 5,
          unitFinalPrice: 4,
        },
      ],
    };

    const adjusted = applyPaymentAdjustmentToDiningOrder(order, [
      {
        articleUnitId: "order_1_0_0",
        orderId: "order_1",
        lineId: "line_original",
        lineIndex: 0,
        unitIndex: 0,
        name: "Piatto",
        originalAmount: 5,
        adjustedAmount: 5,
      },
      {
        articleUnitId: "order_1_0_1",
        orderId: "order_1",
        lineId: "line_original",
        lineIndex: 0,
        unitIndex: 1,
        name: "Piatto",
        originalAmount: 4,
        adjustedAmount: 3.5,
      },
    ]);

    expect(adjusted.total).toBe(8.5);
    expect(adjusted.lines.map((line) => line.unitFinalPrice)).toEqual([5, 3.5]);
    expect(adjusted.lines.map((line) => line.articleUnitIds)).toEqual([
      ["order_1_0_0"],
      ["order_1_0_1"],
    ]);
  });
});
