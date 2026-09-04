import { describe, expect, it } from "vitest";
import type { IntegrationOrder } from "../src/domain/tables/integrationTypes";
import {
  buildIntegrationOrderFingerprint,
  groupIntegrationOrderLines,
  toDiningOrderFromIntegration,
} from "../src/domain/tables/integrationOrderTransforms";

const makeOrder = (partial: Partial<IntegrationOrder> = {}): IntegrationOrder => ({
  id: "12345",
  currentRevision: 3,
  roomId: "room_bar",
  tableId: "room_bar_t01",
  tableNumber: 1,
  title: "Ordine 12345",
  total: 9.5,
  workflowStatus: "ready",
  paymentStatus: "unpaid",
  dueAmount: 9.5,
  paidAmount: 0,
  paidArticleUnits: [],
  orderNote: "",
  orderComment: "",
  createdAtMs: 1780000000000,
  updatedAtMs: 1780000005000,
  items: [],
  ...partial,
});

describe("integration order transforms", () => {
  it("groups order items by line and preserves emitted prices", () => {
    const lines = groupIntegrationOrderLines([
      {
        id: "item_1",
        lineId: "line_1",
        productId: "prod_ichnusa",
        name: "Ichnusa",
        variant: "",
        note: "",
        modifiers: {},
        unitPriceApplied: 4.5,
        listPriceAtTime: 5,
        lineType: "",
        voidedAt: "",
        done: false,
      },
      {
        id: "item_2",
        lineId: "line_1",
        productId: "prod_ichnusa",
        name: "Ichnusa",
        variant: "",
        note: "",
        modifiers: {},
        unitPriceApplied: 4.5,
        listPriceAtTime: 5,
        lineType: "",
        voidedAt: "",
        done: false,
      },
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      lineId: "line_1",
      productId: "prod_ichnusa",
      name: "Ichnusa",
      qty: 2,
      unitFinalPrice: 4.5,
      unitBasePrice: 5,
      priceDelta: -0.5,
      priceChanged: true,
      priceChangeReason: "manual",
    });
  });

  it("excludes voided and bar charge replacement rows from visible dining lines", () => {
    const lines = groupIntegrationOrderLines([
      {
        id: "item_voided",
        lineId: "line_voided",
        productId: "",
        name: "Voided",
        variant: "",
        note: "",
        modifiers: {},
        unitPriceApplied: 1,
        listPriceAtTime: 1,
        lineType: "",
        voidedAt: "2026-06-06T21:00:00.000Z",
        done: false,
      },
      {
        id: "item_replacement",
        lineId: "line_replacement",
        productId: "",
        name: "Replacement",
        variant: "",
        note: "",
        modifiers: {},
        unitPriceApplied: 0,
        listPriceAtTime: 0,
        lineType: "BAR_CHARGE_REPLACEMENT",
        voidedAt: "",
        done: false,
      },
    ]);

    expect(lines).toEqual([]);
  });

  it("maps integration payment/workflow state to mobile dining order state", () => {
    expect(toDiningOrderFromIntegration(makeOrder({ paymentStatus: "paid" })).state).toBe("paid");
    expect(
      toDiningOrderFromIntegration(makeOrder({ workflowStatus: "delivered", paymentStatus: "unpaid" })).state
    ).toBe("served");
    expect(toDiningOrderFromIntegration(makeOrder({ workflowStatus: "prep" })).state).toBe(
      "in_progress"
    );
  });

  it("preserves backend payment residual fields for split payments", () => {
    expect(
      toDiningOrderFromIntegration(
        makeOrder({
          workflowStatus: "delivered",
          paymentStatus: "partial",
          paidAmount: 5,
          dueAmount: 4.5,
          paidArticleUnits: ["12345_0_0"],
        })
      )
    ).toMatchObject({
      state: "served",
      paymentStatus: "partial",
      paidAmount: 5,
      dueAmount: 4.5,
      paidArticleUnits: ["12345_0_0"],
    });
  });

  it("preserves the backend revision used by subsequent recovery operations", () => {
    expect(toDiningOrderFromIntegration(makeOrder({ currentRevision: 8 }))).toMatchObject({
      currentRevision: 8,
    });
    expect(buildIntegrationOrderFingerprint(makeOrder({ currentRevision: 8 }))).not.toEqual(
      buildIntegrationOrderFingerprint(makeOrder({ currentRevision: 9 }))
    );
  });

  it("fingerprint changes when emitted item prices change", () => {
    const base = makeOrder({
      items: [
        {
          id: "item_1",
          lineId: "line_1",
          productId: "prod",
          name: "Prodotto",
          variant: "",
          note: "",
          modifiers: {},
          unitPriceApplied: 4.5,
          listPriceAtTime: 4.5,
          lineType: "",
          voidedAt: "",
          done: false,
        },
      ],
    });
    const changed = makeOrder({
      items: [
        {
          ...base.items[0],
          unitPriceApplied: 5,
        },
      ],
    });

    expect(buildIntegrationOrderFingerprint(base)).not.toEqual(
      buildIntegrationOrderFingerprint(changed)
    );
  });
});
