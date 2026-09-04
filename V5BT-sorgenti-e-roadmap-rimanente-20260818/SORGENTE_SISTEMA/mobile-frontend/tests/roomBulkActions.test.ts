import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminCancelDiningTable,
  fetchTablesForSession,
  freeDiningTable,
  type DiningTable,
} from "../src/api/tables";
import { clearRoomTables, freeRoomTables } from "../src/pages/home/tables/roomBulkActions";

vi.mock("../src/api/tables", () => ({
  fetchTablesForSession: vi.fn(),
  freeDiningTable: vi.fn(),
  adminCancelDiningTable: vi.fn(),
}));

const session = {
  token: "t",
  userId: "u",
  deviceUuid: "d",
  activityId: "a",
  roomId: "sala-corrente",
} as never;
const room = { id: "sala-target", name: "Gazebo" };

const table = (id: string, extra: Partial<DiningTable> = {}) =>
  ({
    id,
    number: id,
    occupancyState: "seated",
    ordersInProgress: 0,
    amountDue: 0,
    orderHistory: [],
    ...extra,
  }) as DiningTable;

const snapshotOf = (tables: DiningTable[]) => ({ version: 1, tables, rawTables: tables });

beforeEach(() => {
  vi.mocked(fetchTablesForSession).mockReset();
  vi.mocked(freeDiningTable).mockReset();
  vi.mocked(adminCancelDiningTable).mockReset();
});

describe("azioni di massa sui tavoli di una sala", () => {
  it("libera solo i tavoli occupati senza ordini o conti aperti", async () => {
    vi.mocked(fetchTablesForSession).mockResolvedValue(
      snapshotOf([
        table("1"),
        table("2", { ordersInProgress: 2 }),
        table("3", { amountDue: 12.5 }),
        table("4", { occupancyState: "free" }),
      ]) as never
    );

    const outcome = await freeRoomTables(session, room);

    expect(outcome).toEqual({ total: 3, done: 1, skipped: 2 });
    expect(vi.mocked(freeDiningTable)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(freeDiningTable).mock.calls[0][0]).toMatchObject({
      roomId: "sala-target",
      tableId: "1",
    });
  });

  it("legge i tavoli della sala indicata, non di quella corrente", async () => {
    vi.mocked(fetchTablesForSession).mockResolvedValue(snapshotOf([]) as never);

    await freeRoomTables(session, room);

    expect(vi.mocked(fetchTablesForSession).mock.calls[0][0]).toMatchObject({
      roomId: "sala-target",
    });
  });

  it("svuota la sala annullando prima ordini e pagamenti aperti", async () => {
    const occupati = [table("1", { ordersInProgress: 1, amountDue: 8 }), table("2")];
    vi.mocked(fetchTablesForSession)
      .mockResolvedValueOnce(snapshotOf(occupati) as never)
      // dopo l'annullamento i tavoli non hanno piu' ordini ne' importi
      .mockResolvedValueOnce(snapshotOf([table("1"), table("2")]) as never);

    const outcome = await clearRoomTables(session, room, "motivo");

    expect(vi.mocked(adminCancelDiningTable)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(adminCancelDiningTable).mock.calls[0][0]).toMatchObject({
      reason: "motivo",
      roomName: "Gazebo",
    });
    expect(vi.mocked(freeDiningTable)).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ total: 2, done: 2, skipped: 0 });
  });

  it("non tocca una sala gia' vuota", async () => {
    vi.mocked(fetchTablesForSession).mockResolvedValue(
      snapshotOf([table("1", { occupancyState: "free" })]) as never
    );

    expect(await freeRoomTables(session, room)).toEqual({ total: 0, done: 0, skipped: 0 });
    expect(vi.mocked(freeDiningTable)).not.toHaveBeenCalled();
    expect(vi.mocked(adminCancelDiningTable)).not.toHaveBeenCalled();
  });
});
