import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchIntegrationLayout,
  fetchIntegrationOrders,
  sendIntegrationLayoutMoveRequest,
  sendIntegrationLayoutSyncRequest,
  sendIntegrationOrderCreateRequest,
  shouldQueueForRetry,
} from "../src/api/tables/integrationClient";
import { apiFetch } from "../src/api/baseUrl";

vi.mock("../src/api/baseUrl", () => ({
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("tables integration client", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("fetches and normalizes integration layout", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({
        version: 7,
        rooms: [{ id: "room_bar", name: "Bar" }],
        tables: [
          {
            id: "room_bar_t01",
            number: 1,
            roomId: "room_bar",
            roomName: "Bar",
            occupancyState: "seated",
            amountDue: "4.505",
          },
        ],
      })
    );

    await expect(fetchIntegrationLayout()).resolves.toMatchObject({
      version: 7,
      rooms: [{ id: "room_bar", name: "Bar" }],
      tables: [{ id: "room_bar_t01", amountDue: 4.51 }],
    });
  });

  it("ignores the generic offline-cache response for the integration layout", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          version: 7,
          rooms: [{ id: "room_bar", name: "Bar" }],
          tables: [{ id: "room_bar_t01", number: 1, roomId: "room_bar" }],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Palmare-Offline-Cache": "1",
          },
        }
      )
    );

    await expect(fetchIntegrationLayout()).resolves.toBeNull();
  });

  it("accepts an authoritative empty layout so removed tables can be reconciled", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({
        version: 8,
        rooms: [],
        tables: [],
      })
    );

    await expect(fetchIntegrationLayout()).resolves.toEqual({
      version: 8,
      rooms: [],
      tables: [],
    });
  });

  it("does not interpret an invalid non-empty layout as a deletion", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({
        version: 9,
        rooms: [{ id: "", name: "" }],
        tables: [{ id: "", roomId: "" }],
      })
    );

    await expect(fetchIntegrationLayout()).resolves.toBeNull();
  });

  it("fetches integration orders filtered by room", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({
        orders: [
          { id: "1", roomId: "room_bar", tableNumber: 1, total: 4.5 },
          { id: "2", roomId: "room_pizza", tableNumber: 2, total: 10 },
          { id: "3", tableNumber: 3, total: 2 },
        ],
      })
    );

    const orders = await fetchIntegrationOrders({ roomId: "room_bar" });

    expect(orders?.map((order) => order.id)).toEqual(["1", "3"]);
  });

  it("reads order create warning for paused stations", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({
        order: { id: "12345" },
        pausedStationWarning: { code: "station_paused_only_target", station: "BAR-1" },
      })
    );

    await expect(sendIntegrationOrderCreateRequest({ id: "local_1" })).resolves.toMatchObject({
      ok: true,
      id: "12345",
      warningCode: "station_paused_only_target",
      warningMessage:
        "L'unica postazione BAR-1 e in pausa: la comanda restera in attesa fino alla ripresa.",
    });
  });

  it("sends layout sync directly with the authenticated session payload", async () => {
    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ ok: true }, 200));

    await expect(
      sendIntegrationLayoutSyncRequest({ tableId: "t1" }, { tableId: "t1", token: "session" })
    ).resolves.toMatchObject({ ok: true, status: 200, networkError: false });

    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/integration/layout/table/sync",
      expect.objectContaining({
        body: JSON.stringify({ tableId: "t1", token: "session" }),
      })
    );
  });

  it("sends the validated tombstone snapshot only for a removed move source", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, movedOrdersCount: 0, fromTable: {}, toTable: {} }, 200)
    );

    await sendIntegrationLayoutMoveRequest({
      token: "session",
      userId: "user_1",
      deviceUuid: "device_1",
      roomId: "room_bar",
      fromTableId: "removed_1",
      toTableId: "table_2",
      removedSourceSnapshot: {
        id: "removed_1",
        number: 1,
        roomId: "room_bar",
        tableName: "Mario",
        customerPhone: "",
        covers: 2,
        occupancyState: "seated",
        reservationAt: null,
        seatedAt: 1_800_000_000_000,
        ordersTaken: 1,
        ordersInProgress: 1,
        amountDue: 0,
        note: "",
        allergens: [],
        manualIntolerance: "",
        offlineLifecycle: {
          state: "removed_while_active",
          removedAt: 1_800_000_100_000,
          removedFromLayoutVersion: 2,
          usableUntil: "released",
          requiresDecision: false,
          decision: "keep",
        },
      },
    });

    const request = mockedApiFetch.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body));
    expect(body.removedSourceSnapshot).toMatchObject({
      id: "removed_1",
      roomId: "room_bar",
      occupancyState: "seated",
      offlineLifecycle: { state: "removed_while_active" },
    });
  });

  it("keeps retry policy deterministic", () => {
    expect(shouldQueueForRetry(0, false)).toBe(true);
    expect(shouldQueueForRetry(502, false)).toBe(true);
    expect(shouldQueueForRetry(401, false)).toBe(false);
    expect(shouldQueueForRetry(200, true)).toBe(true);
  });
});
