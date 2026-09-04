import { describe, expect, it } from "vitest";
import type {
  IntegrationLayoutRoom,
  IntegrationLayoutTable,
} from "../src/domain/tables/integrationTypes";
import {
  applyOfflineTableOperationalState,
  isConfigurationTableActive,
  keepRemovedTableInCurrentService,
  reconcileOfflineLayout,
  tableNeedsConfigurationRemovalDecision,
} from "../src/domain/offlineConfiguration/reconciliation";
import {
  offlineConfigurationSnapshotKey,
  offlineReservationsKey,
} from "../src/domain/offlineConfiguration/keys";
import {
  buildOfflineReservationDateWindow,
  OFFLINE_RESERVATION_SYNC_WINDOW_DAYS,
  projectActiveReservationsOntoLayout,
} from "../src/app/runtime/offlineConfigurationRefresh";

const room = (id = "room-1"): IntegrationLayoutRoom => ({ id, name: `Sala ${id}` });

const table = (
  id: string,
  overrides: Partial<IntegrationLayoutTable> = {}
): IntegrationLayoutTable => ({
  id,
  number: Number(id.replace(/\D/g, "")) || 1,
  roomId: "room-1",
  roomName: "Sala 1",
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
  ...overrides,
});

describe("offline configuration namespace", () => {
  it("separates every user and activity and rejects incomplete scopes", () => {
    const first = offlineConfigurationSnapshotKey({ userId: "user-a", activityId: "activity-a" });
    const otherUser = offlineConfigurationSnapshotKey({
      userId: "user-b",
      activityId: "activity-a",
    });
    const otherActivity = offlineConfigurationSnapshotKey({
      userId: "user-a",
      activityId: "activity-b",
    });

    expect(first).not.toBe(otherUser);
    expect(first).not.toBe(otherActivity);
    expect(offlineConfigurationSnapshotKey({ userId: "user-a", activityId: "" })).toBeNull();
  });

  it("builds deterministic reservation slice keys and local date windows", () => {
    expect(offlineReservationsKey("room/1", "2026-07-24")).toBe("room%2F1:2026-07-24");
    expect(buildOfflineReservationDateWindow(Date.parse("2026-07-24T08:00:00+02:00"), 3)).toEqual([
      "2026-07-24",
      "2026-07-25",
      "2026-07-26",
    ]);
    const continuousWindow = buildOfflineReservationDateWindow(
      Date.parse("2026-07-24T08:00:00+02:00")
    );
    expect(OFFLINE_RESERVATION_SYNC_WINDOW_DAYS).toBe(8);
    expect(continuousWindow).toHaveLength(8);
    expect(continuousWindow.at(-1)).toBe("2026-07-31");
  });
});

describe("removed table reconciliation", () => {
  it("keeps only removed tables that are still active and retains their removed room", () => {
    const previous = {
      version: 10,
      rooms: [room("room-1"), room("room-removed")],
      tables: [
        table("table-free"),
        table("table-active", {
          roomId: "room-removed",
          roomName: "Sala rimossa",
          occupancyState: "seated",
          seatedAt: 100,
        }),
      ],
    };
    const incoming = { version: 11, rooms: [room("room-1")], tables: [] };

    const result = reconcileOfflineLayout(previous, incoming, 500);

    expect(result.tables.map((entry) => entry.id)).toEqual(["table-active"]);
    expect(result.tables[0].offlineLifecycle).toEqual({
      state: "removed_while_active",
      removedAt: 500,
      removedFromLayoutVersion: 11,
      usableUntil: "released",
      requiresDecision: false,
      decision: "keep",
    });
    expect(result.rooms.map((entry) => entry.id)).toEqual(["room-1", "room-removed"]);
    expect(result.rooms[1].offlineLifecycle?.state).toBe("removed_while_active");
  });

  it("drops a retained tombstone after it is released", () => {
    const retained = reconcileOfflineLayout(
      {
        version: 1,
        rooms: [room()],
        tables: [table("table-1", { occupancyState: "reserved", reservationAt: 100 })],
      },
      { version: 2, rooms: [room()], tables: [] },
      200
    );
    const released = {
      ...retained,
      tables: retained.tables.map((entry) =>
        entry.id === "table-1"
          ? { ...entry, occupancyState: "free" as const, reservationAt: null }
          : entry
      ),
    };

    expect(
      reconcileOfflineLayout(released, { version: 3, rooms: [room()], tables: [] }, 300).tables
    ).toHaveLength(0);
  });

  it("uses the server table again and removes the tombstone marker when restored", () => {
    const previous = {
      version: 2,
      rooms: [room()],
      tables: [
        {
          ...table("table-1", { occupancyState: "seated", seatedAt: 100 }),
          offlineLifecycle: {
            state: "removed_while_active" as const,
            removedAt: 200,
            removedFromLayoutVersion: 2,
            usableUntil: "released" as const,
            requiresDecision: false,
            decision: "keep" as const,
          },
        },
      ],
    };
    const restored = table("table-1", { occupancyState: "seated", seatedAt: 100 });
    const result = reconcileOfflineLayout(
      previous,
      { version: 3, rooms: [room()], tables: [restored] },
      300
    );

    expect(result.tables).toEqual([restored]);
    expect(result.tables[0].offlineLifecycle).toBeUndefined();
  });

  it("treats reserved, seated, ordered and unpaid tables as active", () => {
    expect(isConfigurationTableActive(table("reserved", { occupancyState: "reserved" }))).toBe(
      true
    );
    expect(isConfigurationTableActive(table("ordered", { ordersTaken: 1 }))).toBe(true);
    expect(isConfigurationTableActive(table("due", { amountDue: 1 }))).toBe(true);
    expect(isConfigurationTableActive(table("free"))).toBe(false);
  });

  it("asks only for removed reserved tables and preserves the keep decision", () => {
    const retained = reconcileOfflineLayout(
      {
        version: 1,
        rooms: [room()],
        tables: [table("table-1", { occupancyState: "reserved", reservationAt: 100 })],
      },
      { version: 2, rooms: [room()], tables: [] },
      200
    );

    expect(tableNeedsConfigurationRemovalDecision(retained.tables[0])).toBe(true);
    const kept = keepRemovedTableInCurrentService(retained, "table-1");
    expect(tableNeedsConfigurationRemovalDecision(kept.tables[0])).toBe(false);
    expect(kept.tables[0].offlineLifecycle?.decision).toBe("keep");
  });

  it("asks for a decision when a future assigned reservation is removed before its block window", () => {
    const retained = reconcileOfflineLayout(
      {
        version: 1,
        rooms: [room()],
        tables: [
          table("table-1", {
            occupancyState: "free",
            reservationAt: Date.parse("2026-07-31T20:00:00+02:00"),
            tableName: "Cliente futuro",
          }),
        ],
      },
      { version: 2, rooms: [room()], tables: [] },
      Date.parse("2026-07-24T12:00:00+02:00")
    );

    expect(retained.tables).toHaveLength(1);
    expect(retained.tables[0].occupancyState).toBe("free");
    expect(retained.tables[0].offlineLifecycle).toMatchObject({
      requiresDecision: true,
      decision: "pending",
    });
    expect(tableNeedsConfigurationRemovalDecision(retained.tables[0])).toBe(true);
  });

  it("projects a resident reservation slice before reconciling a background table removal", () => {
    const reservationAt = Date.parse("2026-07-31T20:00:00+02:00");
    const previous = projectActiveReservationsOntoLayout(
      { version: 1, rooms: [room()], tables: [table("table-1")] },
      [
        {
          id: "reservation-1",
          roomId: "room-1",
          serviceDate: "2026-07-31",
          status: "booked",
          reservationAt,
          customerName: "Cliente residente",
          customerPhone: "3331234567",
          covers: 4,
          intolerances: "",
          note: "Compleanno",
          assignedTableId: "table-1",
          assignedTableIds: ["table-1"],
          createdAt: 100,
          updatedAt: 100,
        },
      ]
    );

    const retained = reconcileOfflineLayout(
      previous,
      { version: 2, rooms: [room()], tables: [] },
      Date.parse("2026-07-24T12:00:00+02:00")
    );

    expect(retained.tables[0]).toMatchObject({
      id: "table-1",
      reservationAt,
      tableName: "Cliente residente",
      offlineLifecycle: { requiresDecision: true, decision: "pending" },
    });
  });

  it("preserves a just-seated table when its configuration is deleted immediately", () => {
    const cached = {
      version: 1,
      rooms: [room()],
      tables: [table("table-1")],
    };
    const withLocalSeat = applyOfflineTableOperationalState(
      cached,
      table("table-1", {
        tableName: "Mario",
        covers: 2,
        occupancyState: "seated",
        seatedAt: 150,
      })
    );

    const refreshed = reconcileOfflineLayout(
      withLocalSeat,
      { version: 2, rooms: [room()], tables: [] },
      200
    );

    expect(refreshed.tables).toHaveLength(1);
    expect(refreshed.tables[0]).toMatchObject({
      id: "table-1",
      tableName: "Mario",
      covers: 2,
      occupancyState: "seated",
      seatedAt: 150,
    });
    expect(refreshed.tables[0].offlineLifecycle).toMatchObject({
      state: "removed_while_active",
      decision: "keep",
      requiresDecision: false,
    });
  });

  it("persiste la cronologia locale e la mantiene durante il refresh del layout", () => {
    const cached = {
      version: 1,
      rooms: [room()],
      tables: [table("table-1", { occupancyState: "seated", seatedAt: 100 })],
    };
    const withLocalOrder = applyOfflineTableOperationalState(cached, {
      ...table("table-1", {
        occupancyState: "seated",
        seatedAt: 100,
        ordersTaken: 1,
        ordersInProgress: 1,
      }),
      orderHistory: [
        {
          id: "ord-local-1",
          title: "Comanda offline",
          createdAt: 150,
          total: 4,
          state: "in_progress",
          workflowStatus: "waiting",
          paidArticleUnits: [],
          lines: [{ productId: "coffee", name: "Caffe", qty: 1, unitFinalPrice: 4 }],
        },
      ],
    });

    const refreshed = reconcileOfflineLayout(
      withLocalOrder,
      {
        version: 2,
        rooms: [room()],
        tables: [
          table("table-1", {
            occupancyState: "seated",
            seatedAt: 100,
            ordersTaken: 1,
            ordersInProgress: 1,
          }),
        ],
      },
      200
    );

    expect(refreshed.tables[0].orderHistory).toEqual([
      expect.objectContaining({ id: "ord-local-1", title: "Comanda offline" }),
    ]);
    expect(refreshed.tables[0].orderHistory?.[0].lines).toEqual([
      expect.objectContaining({ productId: "coffee", name: "Caffe" }),
    ]);
  });

  it("keeps a removed reservation usable after arrival until explicit release", () => {
    const retained = reconcileOfflineLayout(
      {
        version: 1,
        rooms: [room()],
        tables: [table("table-1", { occupancyState: "reserved", reservationAt: 100 })],
      },
      { version: 2, rooms: [room()], tables: [] },
      200
    );
    const kept = keepRemovedTableInCurrentService(retained, "table-1");
    const afterArrival = {
      ...kept,
      tables: kept.tables.map((entry) =>
        entry.id === "table-1"
          ? {
              ...entry,
              occupancyState: "seated" as const,
              reservationAt: null,
              seatedAt: 250,
            }
          : entry
      ),
    };

    const refreshed = reconcileOfflineLayout(
      afterArrival,
      { version: 3, rooms: [room()], tables: [] },
      300
    );

    expect(refreshed.tables).toHaveLength(1);
    expect(refreshed.tables[0]).toMatchObject({
      id: "table-1",
      occupancyState: "seated",
      reservationAt: null,
      seatedAt: 250,
    });
    expect(tableNeedsConfigurationRemovalDecision(refreshed.tables[0])).toBe(false);
    expect(refreshed.tables[0].offlineLifecycle?.decision).toBe("keep");
  });
});
