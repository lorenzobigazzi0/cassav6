import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTablesForSession } from "../src/api/tables";

const requestedRoomId = "room_removed_alias_test";
const firstRoomId = "room_first_alias_test";

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("tables for a removed room", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/api/integration/layout")) {
          return jsonResponse({
            version: 21,
            rooms: [{ id: firstRoomId, name: "Prima sala" }],
            tables: [
              {
                id: `${firstRoomId}_t01`,
                number: 1,
                roomId: firstRoomId,
                roomName: "Prima sala",
              },
            ],
          });
        }
        if (url.includes("/api/integration/orders")) return jsonResponse({ orders: [] });
        if (url.includes("/api/integration/table-groups")) {
          return jsonResponse({ ok: true, groups: [] });
        }
        if (url.includes("/api/pos/reservations/list")) {
          return jsonResponse({ version: 1, reservations: [] });
        }
        return jsonResponse({ ok: true });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not alias the first authoritative room tables under the removed room id", async () => {
    const snapshot = await fetchTablesForSession({
      token: "token-room-test",
      userId: "user-room-test",
      deviceUuid: "device-room-test",
      roomId: requestedRoomId,
    });

    expect(snapshot.tables).toEqual([]);
    expect(snapshot.rawTables).toEqual([]);
    expect(snapshot.tables.some((table) => table.id.startsWith(firstRoomId))).toBe(false);
  });
});
