import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IntegrationOrderSyncError,
  fetchTablesForSession,
  markDiningOrderServed,
} from "../src/api/tables";
import { canServeHistoryOrder } from "../src/pages/home/tables/components/TableDetailPanel";
import type { DiningTableOrder } from "../src/domain/tables/types";

const ROOM_ID = "room_pedana";
const TABLE_ID = "room_pedana_t05";
const ORDER_ID = "00042";

const session = {
  token: "token-abc",
  userId: "u_giada",
  username: "giada",
  deviceUuid: "device-giada",
  roomId: ROOM_ID,
};

const layoutResponse = {
  version: 1,
  rooms: [{ id: ROOM_ID, name: "Pedana" }],
  tables: [{ id: TABLE_ID, roomId: ROOM_ID, number: 5, status: "occupied" }],
};

const readyOrder = {
  id: ORDER_ID,
  roomId: ROOM_ID,
  tableId: TABLE_ID,
  tableNumber: 5,
  title: `Comanda ${ORDER_ID}`,
  total: 10,
  workflowStatus: "ready",
  paymentStatus: "unpaid",
  dueAmount: 10,
  paidAmount: 0,
  paidArticleUnits: [],
  orderNote: "",
  orderComment: "",
  createdAtMs: 100_000,
  updatedAtMs: 100_000,
  items: [
    {
      id: "item-1",
      lineId: "line-1",
      productId: "prod-1",
      name: "Spritz",
      variant: "",
      note: "",
      modifiers: {},
      qty: 1,
      unitPriceApplied: 10,
      listPriceAtTime: 10,
      lineType: "standard",
      voidedAt: "",
      done: true,
    },
  ],
};

type SyncCall = { url: string; body: Record<string, unknown> };

let syncCalls: SyncCall[];
let syncResponse: { status: number; body: unknown };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  syncCalls = [];
  syncResponse = { status: 200, body: { ok: true } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/integration/layout")) return jsonResponse(200, layoutResponse);
      if (url.includes("/api/integration/orders/sync")) {
        syncCalls.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return jsonResponse(syncResponse.status, syncResponse.body);
      }
      if (url.includes("/api/integration/orders")) {
        return jsonResponse(200, { orders: [readyOrder] });
      }
      if (url.includes("/api/integration/table-groups") || url.includes("groups")) {
        return jsonResponse(200, { ok: true, groups: [] });
      }
      return jsonResponse(200, { ok: true });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const makeOrder = (overrides: Partial<DiningTableOrder> = {}): DiningTableOrder =>
  ({
    id: ORDER_ID,
    title: `Comanda ${ORDER_ID}`,
    state: "in_progress",
    workflowStatus: "ready",
    total: 10,
    lines: [],
    ...overrides,
  }) as DiningTableOrder;

describe("markDiningOrderServed", () => {
  it("allega le credenziali di sessione al sync, altrimenti il backend risponde 401", async () => {
    await fetchTablesForSession(session);
    await markDiningOrderServed({ ...session, tableId: TABLE_ID, orderId: ORDER_ID });

    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].body).toMatchObject({
      id: ORDER_ID,
      token: session.token,
      userId: session.userId,
      deviceUuid: session.deviceUuid,
      order: { workflowStatus: "delivered" },
    });
  });

  it("propaga l'errore e annulla l'aggiornamento ottimistico quando il backend rifiuta", async () => {
    await fetchTablesForSession(session);
    syncResponse = {
      status: 409,
      body: { ok: false, code: "ORDER_NOT_READY_FOR_DELIVERY", error: "Comanda non pronta." },
    };

    await expect(
      markDiningOrderServed({ ...session, tableId: TABLE_ID, orderId: ORDER_ID })
    ).rejects.toBeInstanceOf(IntegrationOrderSyncError);

    // Lo stato locale torna indietro: la comanda non resta "Consegnato" a schermo.
    const snapshot = await fetchTablesForSession(session);
    const table = snapshot.tables.find((entry) => entry.id === TABLE_ID);
    const order = table?.orderHistory.find((entry) => entry.id === ORDER_ID);
    expect(order?.state).toBe("in_progress");
  });

  it("mappa il 401 su un messaggio di sessione scaduta", async () => {
    await fetchTablesForSession(session);
    syncResponse = { status: 401, body: { ok: false, error: "Sessione login richiesta." } };

    await expect(
      markDiningOrderServed({ ...session, tableId: TABLE_ID, orderId: ORDER_ID })
    ).rejects.toThrow(/Sessione scaduta/);
  });
});

describe("canServeHistoryOrder", () => {
  it("mostra il pulsante su una comanda pronta quando la conferma e attiva", () => {
    expect(canServeHistoryOrder(makeOrder(), true)).toBe(true);
  });

  it("nasconde il pulsante quando la conferma di consegna e disattivata", () => {
    expect(canServeHistoryOrder(makeOrder(), false)).toBe(false);
  });

  it("resta nascosto su comande non ancora pronte", () => {
    expect(canServeHistoryOrder(makeOrder({ workflowStatus: "prep" }), true)).toBe(false);
  });
});
