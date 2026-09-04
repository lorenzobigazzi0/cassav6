import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAvailableRooms } from "../src/api/locations";
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

const baseParams = {
  token: "session-token",
  userId: "u_giada",
  role: "operator" as const,
  deviceUuid: "device-1",
};

describe("available rooms cache", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    window.localStorage.clear();
  });

  it("usa l'ultima lista reale dell'utente quando il backend sale e temporaneamente non disponibile", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({
        rooms: [{ roomId: "room_bar", roomName: "Bar" }],
        initialRoom: { roomId: "room_bar", roomName: "Bar" },
      })
    );

    await expect(fetchAvailableRooms(baseParams)).resolves.toMatchObject([
      { id: "room_bar", name: "Bar" },
    ]);

    mockedApiFetch.mockRejectedValueOnce(new TypeError("network down"));

    await expect(fetchAvailableRooms(baseParams)).resolves.toMatchObject([
      { id: "room_bar", name: "Bar" },
    ]);
  });

  it("non condivide la cache sale tra utenti diversi", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({
        rooms: [{ roomId: "room_bar", roomName: "Bar" }],
        initialRoom: { roomId: "room_bar", roomName: "Bar" },
      })
    );
    await fetchAvailableRooms(baseParams);

    mockedApiFetch.mockRejectedValueOnce(new TypeError("network down"));

    await expect(fetchAvailableRooms({ ...baseParams, userId: "u_lorenzo" })).rejects.toThrow(
      "Nessuna sala disponibile"
    );
  });

  it("separa e filtra la cache sale anche tra attivita dello stesso utente", async () => {
    const activityParams = {
      ...baseParams,
      userId: "u_multi_attivita",
      activityId: "activity-a",
    };
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({
        rooms: [
          { roomId: "room_a", roomName: "Sala A", activityId: "activity-a" },
          { roomId: "room_b", roomName: "Sala B", activityId: "activity-b" },
        ],
        initialRoom: { roomId: "room_a", roomName: "Sala A", activityId: "activity-a" },
      })
    );

    await expect(fetchAvailableRooms(activityParams)).resolves.toEqual([
      expect.objectContaining({ id: "room_a", activityId: "activity-a" }),
    ]);
    expect(JSON.parse(String(mockedApiFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      activityId: "activity-a",
    });

    mockedApiFetch.mockRejectedValueOnce(new TypeError("network down"));
    await expect(
      fetchAvailableRooms({ ...activityParams, activityId: "activity-b" })
    ).rejects.toThrow("Nessuna sala disponibile");

    mockedApiFetch.mockRejectedValueOnce(new TypeError("network down"));
    await expect(fetchAvailableRooms(activityParams)).resolves.toEqual([
      expect.objectContaining({ id: "room_a", activityId: "activity-a" }),
    ]);
  });

  it("usa lo snapshot offline anche quando il backend risponde 503", async () => {
    const params = { ...baseParams, userId: "u_backend_503" };
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({
        rooms: [{ roomId: "room_bar", roomName: "Bar" }],
        initialRoom: { roomId: "room_bar", roomName: "Bar" },
      })
    );
    await fetchAvailableRooms(params);

    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ error: "temporaneamente offline" }, 503));
    await expect(fetchAvailableRooms(params)).resolves.toEqual([
      expect.objectContaining({ id: "room_bar", name: "Bar" }),
    ]);
  });

  it("converge su zero sale autorevoli senza ripristinare la vecchia cache", async () => {
    const params = {
      ...baseParams,
      userId: "u_zero_rooms",
      activityId: "activity-zero-rooms",
    };
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({
        rooms: [
          {
            roomId: "room_obsoleta",
            roomName: "Sala obsoleta",
            activityId: params.activityId,
          },
        ],
        initialRoom: { roomId: "room_obsoleta", roomName: "Sala obsoleta" },
      })
    );
    await expect(fetchAvailableRooms(params)).resolves.toEqual([
      expect.objectContaining({ id: "room_obsoleta" }),
    ]);

    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ rooms: [] }));
    await expect(fetchAvailableRooms(params)).resolves.toEqual([]);

    mockedApiFetch.mockRejectedValueOnce(new TypeError("network down"));
    await expect(fetchAvailableRooms(params)).resolves.toEqual([]);
  });
});
