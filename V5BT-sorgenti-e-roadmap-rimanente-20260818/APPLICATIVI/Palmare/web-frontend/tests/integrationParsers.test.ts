import { describe, expect, it } from "vitest";
import {
  parseIntegrationLayoutRoom,
  parseIntegrationLayoutTable,
  parseIntegrationOrder,
  parseIntegrationWorkflowStatus,
  toDiningTableFromLayout,
} from "../src/domain/tables/integrationParsers";

describe("integration table parsers", () => {
  it("parses valid layout rooms and rejects incomplete ones", () => {
    expect(parseIntegrationLayoutRoom({ id: "room_bar", name: "Bar" })).toEqual({
      id: "room_bar",
      name: "Bar",
    });
    expect(parseIntegrationLayoutRoom({ id: "room_bar" })).toBeNull();
    expect(parseIntegrationLayoutRoom(null)).toBeNull();
  });

  it("sanitizes layout table fields without creating mock data", () => {
    const table = parseIntegrationLayoutTable({
      id: "room_bar_t01",
      number: "1",
      roomId: "room_bar",
      roomName: "Bar",
      tableName: " Tavolo 1 ",
      occupancyState: "seated",
      reservationAt: "0",
      seatedAt: "1780000000000",
      covers: "4",
      amountDue: "12.345",
      allergens: [" latte ", "", "glutine"],
      paymentArticleSplitLocked: true,
    });

    expect(table).toMatchObject({
      id: "room_bar_t01",
      number: 1,
      roomId: "room_bar",
      roomName: "Bar",
      tableName: "Tavolo 1",
      occupancyState: "seated",
      reservationAt: null,
      seatedAt: 1780000000000,
      covers: 4,
      amountDue: 12.35,
      allergens: ["Latte", "Glutine"],
      paymentArticleSplitLocked: true,
    });
  });

  it("maps backend workflow aliases to mobile workflow states", () => {
    expect(parseIntegrationWorkflowStatus("pronta")).toBe("ready");
    expect(parseIntegrationWorkflowStatus("in_preparazione")).toBe("prep");
    expect(parseIntegrationWorkflowStatus("consegnato")).toBe("delivered");
    expect(parseIntegrationWorkflowStatus("cancelled")).toBe("cancelled");
    expect(parseIntegrationWorkflowStatus("annullata")).toBe("cancelled");
    expect(parseIntegrationWorkflowStatus("VOIDED")).toBe("cancelled");
    expect(parseIntegrationWorkflowStatus("sconosciuto")).toBe("waiting");
  });

  it("parses integration orders and normalizes money and item defaults", () => {
    const order = parseIntegrationOrder({
      id: "12345",
      currentRevision: "7",
      tableNumber: "7",
      workflowStatus: "pronto",
      paymentStatus: "partial",
      total: "9.505",
      dueAmount: "4.50",
      paidAmount: "5",
      paidArticleUnits: [" 12345_0_0 ", "", "12345_0_0", "12345_0_1"],
      createdAt: "2026-06-06T21:00:00.000Z",
      items: [
        {
          id: "item_1",
          lineId: "line_1",
          name: " Ichnusa ",
          unitPriceApplied: "4.5",
          listPriceAtTime: "5",
          variants: { formato: " bottiglia " },
        },
      ],
    });

    expect(order).not.toBeNull();
    expect(order).toMatchObject({
      id: "12345",
      currentRevision: 7,
      tableNumber: 7,
      workflowStatus: "ready",
      paymentStatus: "partial",
      total: 9.51,
      dueAmount: 4.5,
      paidAmount: 5,
      paidArticleUnits: ["12345_0_0", "12345_0_1"],
    });
    expect(order?.items[0]).toMatchObject({
      id: "item_1",
      lineId: "line_1",
      name: "Ichnusa",
      unitPriceApplied: 4.5,
      listPriceAtTime: 5,
      modifiers: { formato: "bottiglia" },
    });
  });

  it("converts layout tables to empty dining table state", () => {
    const layoutTable = parseIntegrationLayoutTable({
      id: "room_bar_t02",
      number: 2,
      roomId: "room_bar",
      roomName: "Bar",
      ordersTaken: 3,
    });

    expect(layoutTable).not.toBeNull();
    expect(toDiningTableFromLayout(layoutTable!)).toMatchObject({
      id: "room_bar_t02",
      number: 2,
      ordersTaken: 3,
      orderHistory: [],
    });
  });

  it("rehydrates the locally persisted order history from an offline layout", () => {
    const layoutTable = parseIntegrationLayoutTable({
      id: "room_bar_t03",
      number: 3,
      roomId: "room_bar",
      roomName: "Bar",
      occupancyState: "seated",
      ordersTaken: 1,
      ordersInProgress: 1,
    });

    const table = toDiningTableFromLayout({
      ...layoutTable!,
      orderHistory: [
        {
          id: "ord-local-1",
          title: "Comanda offline",
          createdAt: 100,
          total: 2,
          state: "in_progress",
          workflowStatus: "waiting",
          paidArticleUnits: [],
          lines: [{ name: "Caffe", qty: 1, unitFinalPrice: 2 }],
        },
      ],
    });

    expect(table.orderHistory).toEqual([
      expect.objectContaining({ id: "ord-local-1", title: "Comanda offline" }),
    ]);
  });
});
