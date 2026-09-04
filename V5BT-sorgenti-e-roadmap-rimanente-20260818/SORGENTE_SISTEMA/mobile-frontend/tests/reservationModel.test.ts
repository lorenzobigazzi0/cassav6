import { describe, expect, it } from "vitest";
import {
  normalizeAssignedTableIds,
  parseAvailabilityFromResponse,
  parseReservationStatusResponse,
  parseReservationSummaryResponse,
} from "../src/api/reservationModel";

const reservation = (overrides: Record<string, unknown> = {}) => ({
  id: "res-1",
  roomId: "room-1",
  serviceDate: "2026-08-18",
  status: "arrived",
  reservationAt: 2_000,
  customerName: "Cliente",
  customerPhone: "",
  covers: 4,
  intolerances: "",
  note: "",
  assignedTableIds: ["T2", "t2", "T1"],
  createdAt: 10,
  updatedAt: 11,
  ...overrides,
});

describe("reservation model", () => {
  it("normalizes bounded table ids without changing response ordering", () => {
    expect(normalizeAssignedTableIds([" T2 ", "t2", "T1"], "t3")).toEqual([
      "T2",
      "T1",
      "t3",
    ]);

    const summary = parseReservationSummaryResponse({
      version: 3,
      reservations: [reservation(), reservation({ id: "res-2", reservationAt: 1_000 })],
    });
    expect(summary?.reservations.map((item) => item.id)).toEqual(["res-2", "res-1"]);
    expect(summary?.reservations[1]?.assignedTableIds).toEqual(["T2", "T1"]);
  });

  it("keeps mutation metadata strict and drops malformed availability entries", () => {
    expect(
      parseReservationStatusResponse({
        version: 4,
        reservation: reservation(),
        tablesChanged: true,
        tableIds: ["T1", "t1", "T2"],
      })
    ).toMatchObject({ version: 4, tablesChanged: true, tableIds: ["T1", "T2"] });
    expect(parseReservationStatusResponse({ version: 0, reservation: reservation() })).toBeNull();

    expect(
      parseAvailabilityFromResponse({
        items: [
          { tableId: "T1", status: "danger", minutesDistance: 42, label: "Vicino" },
          { status: "safe" },
        ],
      })
    ).toEqual([
      {
        tableId: "T1",
        status: "danger",
        nearestReservation: null,
        minutesDistance: 42,
        label: "Vicino",
      },
    ]);
  });
});
