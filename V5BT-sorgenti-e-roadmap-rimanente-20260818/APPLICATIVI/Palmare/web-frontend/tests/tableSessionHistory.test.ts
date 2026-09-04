import { describe, expect, it } from "vitest";
import { applyIntegrationOrdersToTables, type DiningTable } from "../src/api/tables";

const makeTable = (overrides: Partial<DiningTable> = {}): DiningTable => ({
  id: "table-1",
  number: 1,
  tableName: "",
  customerPhone: "",
  covers: 0,
  occupancyState: "free",
  reservationAt: null,
  seatedAt: null,
  ordersTaken: 0,
  ordersInProgress: 0,
  amountDue: 0,
  note: "",
  allergens: [],
  manualIntolerance: "",
  orderHistory: [],
  ...overrides,
});

const makeIntegrationOrder = (
  overrides: Partial<Parameters<typeof applyIntegrationOrdersToTables>[1][number]> = {}
) =>
  ({
    id: "00077",
    roomId: "room-main",
    tableId: "table-1",
    tableNumber: 1,
    title: "Comanda 00077",
    total: 8,
    workflowStatus: "delivered",
    paymentStatus: "paid",
    dueAmount: 0,
    paidAmount: 8,
    paidArticleUnits: ["00077:line-1:1"],
    orderNote: "",
    orderComment: "",
    createdAtMs: 100_000,
    updatedAtMs: 100_000,
    items: [
      {
        id: "item-1",
        lineId: "line-1",
        productId: "prod-1",
        name: "Ichnusa",
        variant: "",
        note: "",
        modifiers: {},
        unitPriceApplied: 8,
        listPriceAtTime: 8,
        lineType: "product",
        voidedAt: "",
        done: true,
      },
    ],
    ...overrides,
  }) as Parameters<typeof applyIntegrationOrdersToTables>[1][number];

describe("table session history", () => {
  it("mostra lo storico corrente restituito dal backend anche quando il tavolo risulta libero", () => {
    const [table] = applyIntegrationOrdersToTables(
      [
        makeTable({
          occupancyState: "free",
          ordersTaken: 3,
          ordersInProgress: 2,
          amountDue: 15,
        }),
      ],
      [makeIntegrationOrder()]
    );

    expect(table.occupancyState).toBe("free");
    expect(table.orderHistory.map((order) => order.id)).toEqual(["00077"]);
    expect(table.ordersTaken).toBe(1);
    expect(table.ordersInProgress).toBe(0);
    expect(table.amountDue).toBe(0);
  });

  it("mantiene lo storico appena pagato quando il backend libera il tavolo dopo il pagamento", () => {
    const [table] = applyIntegrationOrdersToTables(
      [
        makeTable({
          occupancyState: "free",
          ordersTaken: 1,
          ordersInProgress: 0,
          amountDue: 0,
          orderHistory: [
            {
              id: "00077",
              title: "Comanda 00077",
              createdAt: 100_000,
              total: 8,
              state: "paid",
              workflowStatus: "delivered",
              paidArticleUnits: ["00077:line-1:1"],
              lines: [],
            },
          ],
        }),
      ],
      [makeIntegrationOrder()]
    );

    expect(table.occupancyState).toBe("free");
    expect(table.orderHistory.map((order) => order.id)).toEqual(["00077"]);
    expect(table.ordersTaken).toBe(1);
    expect(table.ordersInProgress).toBe(0);
    expect(table.amountDue).toBe(0);
  });

  it("mostra solo lo storico della nuova sessione quando lo stesso tavolo viene rioccupato", () => {
    const [table] = applyIntegrationOrdersToTables(
      [
        makeTable({
          occupancyState: "seated",
          seatedAt: 200_000,
          ordersTaken: 4,
          orderHistory: [
            {
              id: "local-old",
              title: "Vecchia comanda locale",
              createdAt: 100_000,
              total: 12,
              state: "served",
              paidArticleUnits: [],
              lines: [],
            },
          ],
        }),
      ],
      [
        makeIntegrationOrder(),
        makeIntegrationOrder({
          id: "00088",
          title: "Comanda 00088",
          total: 12,
          workflowStatus: "ready",
          paymentStatus: "unpaid",
          dueAmount: 12,
          paidAmount: 0,
          createdAtMs: 210_000,
          updatedAtMs: 210_000,
        }),
      ]
    );

    expect(table.orderHistory.map((order) => order.id)).toEqual(["00088"]);
    expect(table.ordersTaken).toBe(1);
    expect(table.ordersInProgress).toBe(1);
    expect(table.amountDue).toBe(0);
  });

  it("mantiene nello storico una comanda annullata senza bloccare il tavolo come ordine attivo", () => {
    const [table] = applyIntegrationOrdersToTables(
      [
        makeTable({
          occupancyState: "seated",
          seatedAt: 90_000,
          covers: 2,
          ordersTaken: 1,
          ordersInProgress: 1,
        }),
      ],
      [
        makeIntegrationOrder({
          id: "00328",
          title: "Comanda 00328",
          total: 0,
          workflowStatus: "cancelled",
          paymentStatus: "paid",
          dueAmount: 0,
          paidAmount: 0,
          orderComment: "Annullata: ANNULLAMENTO_TEST_ADB",
          items: [],
        }),
      ]
    );

    expect(table.occupancyState).toBe("seated");
    expect(table.ordersTaken).toBe(1);
    expect(table.ordersInProgress).toBe(0);
    expect(table.amountDue).toBe(0);
    expect(table.orderHistory[0]).toMatchObject({
      id: "00328",
      state: "paid",
      workflowStatus: "cancelled",
      orderComment: "Annullata: ANNULLAMENTO_TEST_ADB",
    });
  });
});
