import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentSnapshot: null as Record<string, unknown> | null,
  fetchAvailableRooms: vi.fn(),
  fetchMenuCatalogForSession: vi.fn(),
  fetchReservationsForDay: vi.fn(),
  fetchIntegrationLayout: vi.fn(),
  readOfflineConfigurationSnapshot: vi.fn(),
  updateOfflineConfigurationSnapshot: vi.fn(),
}));

vi.mock("../src/api/locations", () => ({
  fetchAvailableRooms: mocks.fetchAvailableRooms,
}));

vi.mock("../src/api/menu", () => ({
  fetchMenuCatalogForSession: mocks.fetchMenuCatalogForSession,
}));

vi.mock("../src/api/reservations", () => ({
  fetchReservationsForDay: mocks.fetchReservationsForDay,
}));

vi.mock("../src/api/tables/integrationClient", () => ({
  fetchIntegrationLayout: mocks.fetchIntegrationLayout,
}));

vi.mock("../src/domain/offlineConfiguration/repository", () => ({
  readOfflineConfigurationSnapshot: mocks.readOfflineConfigurationSnapshot,
  stableOfflineConfigurationVersion: () => 1,
  updateOfflineConfigurationSnapshot: mocks.updateOfflineConfigurationSnapshot,
}));

import { refreshOfflineConfiguration } from "../src/app/runtime/offlineConfigurationRefresh";

const snapshot = (rooms: unknown[], roomsUpdatedAt: number) => ({
  schemaVersion: 1,
  userId: "user-1",
  activityId: "activity-1",
  lastRefreshAttemptAt: 0,
  lastSuccessfulSyncAt: 0,
  rooms: {
    serverVersion: 1,
    updatedAt: roomsUpdatedAt,
    value: rooms,
  },
  layout: null,
  menusByRoom: {},
  reservationsByRoomDate: {},
});

describe("offline configuration refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentSnapshot = snapshot([{ id: "room-old", name: "Sala vecchia" }], 100);
    mocks.readOfflineConfigurationSnapshot.mockImplementation(async () => mocks.currentSnapshot);
    mocks.updateOfflineConfigurationSnapshot.mockImplementation(async (_scope, update) => {
      mocks.currentSnapshot = update(mocks.currentSnapshot);
      return mocks.currentSnapshot;
    });
    mocks.fetchIntegrationLayout.mockResolvedValue(null);
    mocks.fetchMenuCatalogForSession.mockRejectedValue(new Error("unexpected menu refresh"));
    mocks.fetchReservationsForDay.mockRejectedValue(new Error("unexpected reservation refresh"));
  });

  it("propagates an authoritative empty room list recorded before the rooms API reports no rooms", async () => {
    mocks.fetchAvailableRooms.mockImplementation(async () => {
      mocks.currentSnapshot = snapshot([], 200);
      throw new Error("Nessuna sala disponibile.");
    });

    const result = await refreshOfflineConfiguration(
      {
        token: "token-1",
        userId: "user-1",
        deviceUuid: "device-1",
        activityId: "activity-1",
        role: "operator",
      },
      { now: 500, serviceDates: ["2026-07-24"] }
    );

    expect(result.refreshed.rooms).toBe(true);
    expect(result.snapshot?.rooms?.value).toEqual([]);
    expect(mocks.fetchMenuCatalogForSession).not.toHaveBeenCalled();
    expect(mocks.fetchReservationsForDay).not.toHaveBeenCalled();
  });

  it("uses the resident reservation slice before removing a table and its whole room", async () => {
    const reservationAt = Date.parse("2026-07-25T20:00:00+02:00");
    mocks.currentSnapshot = {
      ...snapshot([{ id: "room-old", name: "Sala vecchia" }], 100),
      layout: {
        serverVersion: 1,
        updatedAt: 100,
        value: {
          version: 1,
          rooms: [{ id: "room-old", name: "Sala vecchia" }],
          tables: [
            {
              id: "table-old",
              number: 1,
              roomId: "room-old",
              roomName: "Sala vecchia",
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
            },
          ],
        },
      },
      reservationsByRoomDate: {
        "room-old:2026-07-25": {
          serverVersion: 1,
          updatedAt: 100,
          value: {
            version: 1,
            reservations: [
              {
                id: "reservation-old",
                roomId: "room-old",
                serviceDate: "2026-07-25",
                status: "booked",
                reservationAt,
                customerName: "Cliente futuro",
                customerPhone: "3331234567",
                covers: 2,
                intolerances: "",
                note: "",
                assignedTableId: "table-old",
                assignedTableIds: ["table-old"],
                createdAt: 100,
                updatedAt: 100,
              },
            ],
          },
        },
      },
    };
    mocks.fetchAvailableRooms.mockResolvedValue([]);
    mocks.fetchIntegrationLayout.mockResolvedValue({ version: 2, rooms: [], tables: [] });

    const result = await refreshOfflineConfiguration(
      {
        token: "token-1",
        userId: "user-1",
        deviceUuid: "device-1",
        activityId: "activity-1",
        role: "operator",
      },
      { now: Date.parse("2026-07-24T12:00:00+02:00"), serviceDates: ["2026-07-25"] }
    );

    expect(result.snapshot?.layout?.value.tables[0]).toMatchObject({
      id: "table-old",
      reservationAt,
      offlineLifecycle: { requiresDecision: true, decision: "pending" },
    });
    expect(result.snapshot?.layout?.value.rooms).toEqual([
      expect.objectContaining({ id: "room-old", offlineLifecycle: expect.any(Object) }),
    ]);
  });
});
