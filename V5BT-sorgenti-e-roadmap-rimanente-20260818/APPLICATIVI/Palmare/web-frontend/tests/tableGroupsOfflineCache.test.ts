import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../src/api/baseUrl";
import { fetchTableGroups, saveTableGroups, type TableGroup } from "../src/api/tableGroups";

vi.mock("../src/api/baseUrl", () => ({
  apiFetch: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const baseSession = {
  token: "session-token",
  userId: "user-1",
  username: "operatore",
  deviceUuid: "device-1",
  activityId: "activity-1",
  roomId: "room-1",
};

const group = (id: string, firstTableId: string, secondTableId: string): TableGroup => ({
  id,
  type: "complex",
  updatedAt: "2026-07-24T10:00:00.000Z",
  children: [
    { id: firstTableId, type: "simple" },
    { id: secondTableId, type: "simple" },
  ],
});

describe("table groups offline cache", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    window.localStorage.clear();
  });

  it("riusa l'ultima risposta valida su errore di rete o risposta server non valida", async () => {
    const cachedGroups = [group("group-1", "table-1", "table-2")];
    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ ok: true, groups: cachedGroups }));
    await expect(fetchTableGroups(baseSession)).resolves.toEqual(cachedGroups);

    mockedApiFetch.mockRejectedValueOnce(new TypeError("network down"));
    await expect(fetchTableGroups(baseSession)).resolves.toEqual(cachedGroups);

    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ ok: false }, 503));
    await expect(fetchTableGroups(baseSession)).resolves.toEqual(cachedGroups);
  });

  it.each([
    ["utente", { userId: "user-2" }],
    ["attivita", { activityId: "activity-2" }],
    ["sala", { roomId: "room-2" }],
  ])("non condivide i gruppi con un'altra %s", async (_label, sessionOverride) => {
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, groups: [group("group-1", "table-1", "table-2")] })
    );
    await fetchTableGroups(baseSession);

    mockedApiFetch.mockRejectedValueOnce(new TypeError("network down"));
    await expect(fetchTableGroups({ ...baseSession, ...sessionOverride })).resolves.toEqual([]);
  });

  it("ignora la cache API globale quando lo scope locale non corrisponde", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, groups: [group("foreign-group", "table-8", "table-9")] }, 200, {
        "X-Palmare-Offline-Cache": "1",
      })
    );

    await expect(fetchTableGroups(baseSession)).resolves.toEqual([]);
    expect(window.localStorage.length).toBe(0);
  });

  it("aggiorna la cache dopo un salvataggio riuscito e include lo scope attivita", async () => {
    const savedGroups = [group("group-new", "table-2", "table-3")];
    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(
      saveTableGroups(baseSession, savedGroups, { operation: "merge" })
    ).resolves.toEqual(savedGroups);
    expect(JSON.parse(String(mockedApiFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      activityId: "activity-1",
    });

    mockedApiFetch.mockRejectedValueOnce(new TypeError("network down"));
    await expect(fetchTableGroups(baseSession)).resolves.toEqual(savedGroups);
  });

  it("non crea cache senza lo scope completo", async () => {
    const cachedGroups = [group("group-1", "table-1", "table-2")];
    mockedApiFetch.mockResolvedValueOnce(jsonResponse({ ok: true, groups: cachedGroups }));
    await fetchTableGroups({ ...baseSession, activityId: undefined });

    mockedApiFetch.mockRejectedValueOnce(new TypeError("network down"));
    await expect(fetchTableGroups({ ...baseSession, activityId: undefined })).resolves.toEqual([]);
    expect(window.localStorage.length).toBe(0);
  });
});
