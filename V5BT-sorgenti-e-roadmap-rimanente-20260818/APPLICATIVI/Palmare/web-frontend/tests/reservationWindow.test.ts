import { describe, expect, it } from "vitest";
import type { DiningTable } from "../src/api/tables";
import {
  applyReservationWindowToTables,
  shouldWarnTableReleaseForReservation,
} from "../src/api/tableReservationWindow";

const baseTable = (partial: Partial<DiningTable> = {}): DiningTable => ({
  id: "room_pedana_t01",
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
  ...partial,
});

describe("table reservation window", () => {
  it("keeps a future assigned reservation active while the table remains usable", () => {
    const now = new Date("2026-05-31T18:00:00+02:00").getTime();
    const [table] = applyReservationWindowToTables(
      [baseTable()],
      [
        {
          id: "res_1",
          reservationAt: now + 45 * 60_000,
          customerName: "Mario Rossi",
          customerPhone: "123",
          covers: 4,
          note: "",
          assignedTableId: "room_pedana_t01",
        },
      ],
      now
    );

    expect(table.occupancyState).toBe("free");
    expect(table.reservationAt).toBe(now + 45 * 60_000);
    expect(table.tableName).toBe("Mario Rossi");
    expect(table.reservationPreview?.withinBlockWindow).toBe(false);
  });

  it("promotes a free table to reserved inside the 30 minute window", () => {
    const now = new Date("2026-05-31T18:00:00+02:00").getTime();
    const [table] = applyReservationWindowToTables(
      [baseTable()],
      [
        {
          id: "res_2",
          reservationAt: now + 25 * 60_000,
          customerName: "Giulia Bianchi",
          customerPhone: "555",
          covers: 2,
          note: "Compleanno",
          assignedTableId: "room_pedana_t01",
        },
      ],
      now
    );

    expect(table.occupancyState).toBe("reserved");
    expect(table.tableName).toBe("Giulia Bianchi");
    expect(table.reservationAt).toBe(now + 25 * 60_000);
  });

  it("warns an occupied table inside the 30 minute window unless it is the booked guest", () => {
    const now = new Date("2026-05-31T18:00:00+02:00").getTime();
    const reservation = {
      id: "res_3",
      reservationAt: now + 20 * 60_000,
      customerName: "Prenotato Cliente",
      customerPhone: "777",
      covers: 3,
      note: "",
      assignedTableId: "room_pedana_t01",
    };

    const [walkIn] = applyReservationWindowToTables(
      [baseTable({ occupancyState: "seated", tableName: "Walk In", covers: 2 })],
      [reservation],
      now
    );
    const [bookedGuest] = applyReservationWindowToTables(
      [baseTable({ occupancyState: "seated", tableName: "Prenotato Cliente", covers: 3 })],
      [reservation],
      now
    );

    expect(walkIn.occupancyState).toBe("seated");
    expect(walkIn.reservationPreview?.shouldWarnRelease).toBe(true);
    expect(bookedGuest.reservationPreview?.shouldWarnRelease).toBe(false);
  });

  it("uses the same 30 minute warning policy for reservations created from the reservation page", () => {
    const now = new Date("2026-05-31T18:00:00+02:00").getTime();
    const occupied = baseTable({
      occupancyState: "seated",
      tableName: "Walk In",
      customerPhone: "333",
      covers: 2,
    });

    expect(
      shouldWarnTableReleaseForReservation(
        occupied,
        now + 20 * 60_000,
        "Prenotazione Nuova",
        "777",
        now
      )
    ).toBe(true);
    expect(
      shouldWarnTableReleaseForReservation(
        occupied,
        now + 45 * 60_000,
        "Prenotazione Nuova",
        "777",
        now
      )
    ).toBe(false);
    expect(
      shouldWarnTableReleaseForReservation(occupied, now + 20 * 60_000, "Walk In", "", now)
    ).toBe(false);
  });
});
