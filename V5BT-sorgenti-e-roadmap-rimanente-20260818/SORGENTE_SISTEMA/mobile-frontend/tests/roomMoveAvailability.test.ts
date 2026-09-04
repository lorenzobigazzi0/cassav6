import { describe, expect, it } from "vitest";
import type { IntegrationLayoutTable } from "../src/domain/tables/integrationTypes";
import {
  buildRoomMoveAvailability,
  formatRoomMoveAvailability,
} from "../src/pages/home/tables/roomMoveAvailability";

const makeLayoutTable = (
  id: string,
  roomId: string,
  state: Partial<IntegrationLayoutTable> = {}
): IntegrationLayoutTable => ({
  id,
  number: Number(id.replace(/\D/g, "")) || 1,
  roomId,
  roomName: roomId,
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
  paymentArticleSplitLocked: false,
  ...state,
});

describe("room move availability", () => {
  it("conta come liberi solo i tavoli realmente selezionabili", () => {
    const result = buildRoomMoveAvailability([
      makeLayoutTable("t1", "room_a"),
      makeLayoutTable("t2", "room_a", { occupancyState: "reserved" }),
      makeLayoutTable("t3", "room_a", { ordersInProgress: 1 }),
      makeLayoutTable("t4", "room_a", { amountDue: 12 }),
      makeLayoutTable("t5", "room_b"),
    ]);

    expect(result.get("room_a")).toEqual({ freeCount: 1, totalCount: 4 });
    expect(result.get("room_b")).toEqual({ freeCount: 1, totalCount: 1 });
  });

  it("formatta plurale, singolare e sala piena", () => {
    expect(formatRoomMoveAvailability({ freeCount: 2, totalCount: 17 })).toBe("Liberi 2/17");
    expect(formatRoomMoveAvailability({ freeCount: 1, totalCount: 17 })).toBe("Libero 1/17");
    expect(formatRoomMoveAvailability({ freeCount: 0, totalCount: 17 })).toBe("Piena");
  });
});
