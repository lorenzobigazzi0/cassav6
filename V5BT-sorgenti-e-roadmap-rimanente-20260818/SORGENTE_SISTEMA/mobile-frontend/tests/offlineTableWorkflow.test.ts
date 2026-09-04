import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOBILE_SESSION_ENDING_EVENT } from "../src/app/session/sessionLifecycle";
import { loadIntegrationQueueFromStorage } from "../src/domain/tables/integrationQueueStorage";

const integrationMocks = vi.hoisted(() => ({
  fetchIntegrationLayout: vi.fn(),
  fetchIntegrationOrders: vi.fn(),
  sendIntegrationLayoutSyncRequest: vi.fn(),
  sendIntegrationOrderCreateRequest: vi.fn(),
}));

vi.mock("../src/api/tables/integrationClient", () => ({
  buildRemovedSourceTableMoveSnapshot: vi.fn(() => undefined),
  fetchIntegrationLayout: integrationMocks.fetchIntegrationLayout,
  fetchIntegrationOrders: integrationMocks.fetchIntegrationOrders,
  sendIntegrationLayoutMoveRequest: vi.fn(),
  sendIntegrationLayoutSyncRequest: integrationMocks.sendIntegrationLayoutSyncRequest,
  sendIntegrationOrderCreateRequest: integrationMocks.sendIntegrationOrderCreateRequest,
  sendIntegrationOrderSyncRequest: vi.fn(async () => ({
    ok: false,
    status: 0,
    networkError: true,
    body: null,
  })),
  shouldQueueForRetry: (status: number, networkError: boolean) =>
    networkError || status === 0 || status >= 500,
}));

vi.mock("../src/api/tableGroups", () => ({
  applyTableGroupsToTables: (tables: unknown) => tables,
  fetchTableGroups: vi.fn(async () => []),
}));

vi.mock("../src/api/tableReservationWindow", () => ({
  applyReservationWindowToSessionTables: vi.fn(async (tables: unknown) => tables),
  saveTableReservationPreview: vi.fn(async () => null),
  shouldReserveTableForReservation: vi.fn(() => true),
}));

import {
  addDiningTableOrder,
  fetchTablesForSession,
  freeDiningTable,
  occupyDiningTable,
  reserveDiningTable,
  resetTablesSessionMemory,
  type TableSessionRequest,
} from "../src/api/tables";
import {
  ORDER_CREATE_LOCK_PURPOSE,
  TABLE_LAYOUT_SYNC_LOCK_PURPOSE,
  withOfflineContinuationTableLocks,
} from "../src/api/tableLocks";

const sessionFor = (userId: string): TableSessionRequest => ({
  token: `token-${userId}`,
  userId,
  username: userId,
  fullName: userId,
  deviceUuid: `device-${userId}`,
  activityId: "activity_1",
  roomId: "room_1",
});

const cleanLayout = () => ({
  version: 1,
  rooms: [{ id: "room_1", name: "Sala" }],
  tables: [1, 2, 3].map((number) => ({
    id: `table_${number}`,
    number,
    roomId: "room_1",
    roomName: "Sala",
    tableName: "",
    customerPhone: "",
    covers: 0,
    occupancyState: "free" as const,
    reservationAt: null,
    seatedAt: null,
    ordersTaken: 0,
    ordersInProgress: 0,
    amountDue: 0,
    note: "",
    allergens: [],
    manualIntolerance: "",
    paymentArticleSplitLocked: false,
  })),
});

beforeEach(() => {
  resetTablesSessionMemory();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.stubGlobal("navigator", { onLine: false });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    })
  );
  integrationMocks.fetchIntegrationLayout.mockReset().mockImplementation(async () => cleanLayout());
  integrationMocks.fetchIntegrationOrders.mockReset().mockResolvedValue([]);
  integrationMocks.sendIntegrationLayoutSyncRequest.mockReset().mockResolvedValue({
    ok: false,
    status: 0,
    networkError: true,
  });
  integrationMocks.sendIntegrationOrderCreateRequest.mockReset().mockResolvedValue({
    ok: false,
    status: 0,
    networkError: true,
    id: "",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("offline table workflow", () => {
  it("sostituisce subito la comanda ottimistica con righe canoniche del server", async () => {
    const session = sessionFor("user_online");
    vi.stubGlobal("navigator", { onLine: true });
    integrationMocks.sendIntegrationOrderCreateRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      networkError: false,
      id: "00001",
      order: {
        id: "00001",
        currentRevision: 1,
        roomId: "room_1",
        tableId: "table_2",
        tableNumber: 2,
        title: "Comanda canonica",
        total: 1.3,
        workflowStatus: "waiting",
        paymentStatus: "unpaid",
        dueAmount: 1.3,
        paidAmount: 0,
        orderNote: "",
        orderComment: "",
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        items: [
          {
            id: "oi_1",
            lineId: "line_0001",
            qty: 1,
            productId: "coffee",
            name: "Caffe",
            variant: "",
            note: "",
            modifiers: {},
            unitPriceApplied: 1.3,
            listPriceAtTime: 1.3,
            lineType: "",
            voidedAt: "",
            done: false,
          },
        ],
        paidArticleUnits: [],
      },
    });

    await fetchTablesForSession(session);
    await occupyDiningTable({
      ...session,
      tableId: "table_2",
      tableName: "Test",
      covers: 2,
    });
    const result = await addDiningTableOrder({
      ...session,
      tableId: "table_2",
      title: "Comanda locale",
      total: 1.3,
      lines: [{ productId: "coffee", name: "Caffe", qty: 1, unitFinalPrice: 1.3 }],
    });

    expect(result.table.orderHistory[0]).toMatchObject({
      id: "00001",
      currentRevision: 1,
      lines: [{ lineId: "line_0001", productId: "coffee", qty: 1 }],
    });
  });

  it("prenota, accomoda, libera e accoda la comanda senza un lock remoto", async () => {
    const session = sessionFor("user_a");
    await fetchTablesForSession(session);

    await expect(
      withOfflineContinuationTableLocks(session, ["table_1"], TABLE_LAYOUT_SYNC_LOCK_PURPOSE, () =>
        reserveDiningTable({
          ...session,
          tableId: "table_1",
          reservationAt: Date.now() + 60_000,
          tableName: "Prenotazione",
          customerPhone: "333",
          covers: 2,
        })
      )
    ).resolves.toMatchObject({ occupancyState: "reserved" });

    await expect(
      withOfflineContinuationTableLocks(session, ["table_2"], TABLE_LAYOUT_SYNC_LOCK_PURPOSE, () =>
        occupyDiningTable({
          ...session,
          tableId: "table_2",
          tableName: "Mario",
          covers: 2,
        })
      )
    ).resolves.toMatchObject({ occupancyState: "seated" });

    await expect(
      withOfflineContinuationTableLocks(session, ["table_2"], ORDER_CREATE_LOCK_PURPOSE, () =>
        addDiningTableOrder({
          ...session,
          tableId: "table_2",
          title: "2x Espresso",
          total: 2.4,
          lines: [{ productId: "espresso", name: "Espresso", qty: 2, unitFinalPrice: 1.2 }],
        })
      )
    ).resolves.toMatchObject({
      table: { occupancyState: "seated", ordersInProgress: 1 },
    });

    await withOfflineContinuationTableLocks(
      session,
      ["table_3"],
      TABLE_LAYOUT_SYNC_LOCK_PURPOSE,
      async () => {
        await occupyDiningTable({
          ...session,
          tableId: "table_3",
          tableName: "Lucia",
          covers: 1,
        });
        return freeDiningTable({ ...session, tableId: "table_3" });
      }
    );

    const local = await fetchTablesForSession(session);
    expect(local.tables.find((table) => table.id === "table_1")?.occupancyState).toBe("reserved");
    expect(local.tables.find((table) => table.id === "table_2")?.orderHistory).toHaveLength(1);
    expect(local.tables.find((table) => table.id === "table_3")?.occupancyState).toBe("free");

    const queued = loadIntegrationQueueFromStorage();
    expect(
      queued.some((entry) => entry.kind === "order_create" && entry.tableId === "table_2")
    ).toBe(true);
    expect(queued.filter((entry) => entry.kind === "layout_sync")).not.toHaveLength(0);
  });

  it("azzera lo stato in memoria al logout prima di aprire la stessa sala per un altro utente", async () => {
    const userA = sessionFor("user_a");
    await fetchTablesForSession(userA);
    await occupyDiningTable({
      ...userA,
      tableId: "table_2",
      tableName: "Servizio A",
      covers: 4,
    });
    await addDiningTableOrder({
      ...userA,
      tableId: "table_2",
      title: "Comanda A",
      total: 8,
      lines: [{ name: "Prodotto", qty: 1, unitFinalPrice: 8 }],
    });

    window.dispatchEvent(new CustomEvent(MOBILE_SESSION_ENDING_EVENT));

    const userB = await fetchTablesForSession(sessionFor("user_b"));
    expect(userB.tables.find((table) => table.id === "table_2")).toMatchObject({
      occupancyState: "free",
      tableName: "",
      ordersTaken: 0,
      ordersInProgress: 0,
      orderHistory: [],
    });
  });
});
