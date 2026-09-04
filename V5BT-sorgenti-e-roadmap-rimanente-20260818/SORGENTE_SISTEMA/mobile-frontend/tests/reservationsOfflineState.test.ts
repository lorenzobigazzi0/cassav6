import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireReservationEditLock,
  createDiningReservation,
  debugResetReservationMockState,
  deleteDiningReservation,
  fetchReservationsForDay,
  updateDiningReservation,
  updateDiningReservationStatus,
  type DiningReservation,
  type ReservationSummary,
} from "../src/api/reservations";
import {
  applyReservationWindowToSessionTables,
  saveTableReservationPreview,
} from "../src/api/tableReservationWindow";
import type { DiningTable } from "../src/domain/tables/types";
import { apiFetch } from "../src/api/baseUrl";
import {
  readOfflineReservations,
  recordOfflineReservations,
} from "../src/domain/offlineConfiguration/repository";

vi.mock("../src/api/baseUrl", () => ({
  apiFetch: vi.fn(),
}));

vi.mock("../src/domain/offlineConfiguration/repository", () => ({
  readOfflineReservations: vi.fn(),
  recordOfflineReservations: vi.fn(),
}));

const mockedApiFetch = vi.mocked(apiFetch);
const mockedReadOfflineReservations = vi.mocked(readOfflineReservations);
const mockedRecordOfflineReservations = vi.mocked(recordOfflineReservations);

const session = {
  token: "token-1",
  userId: "user-1",
  deviceUuid: "device-1",
  activityId: "activity-1",
  roomId: "room-1",
  serviceDate: "2026-07-24",
};

const reservation = (overrides: Partial<DiningReservation> = {}): DiningReservation => ({
  id: "reservation-1",
  roomId: session.roomId,
  serviceDate: session.serviceDate,
  status: "booked",
  reservationAt: Date.parse("2026-07-24T20:00:00+02:00"),
  customerName: "Cliente iniziale",
  customerPhone: "",
  covers: 2,
  intolerances: "",
  note: "",
  assignedTableId: "table-1",
  assignedTableIds: ["table-1"],
  createdAt: 100,
  updatedAt: 100,
  ...overrides,
});

const summary = (): ReservationSummary => ({
  version: 7,
  reservations: [reservation()],
});

const jsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const queuedResponse = () =>
  new Response(JSON.stringify({ ok: true, queued: true, offline: true }), {
    status: 202,
    headers: {
      "Content-Type": "application/json",
      "X-Palmare-Offline-Queued": "1",
    },
  });

beforeEach(() => {
  mockedApiFetch.mockReset();
  mockedReadOfflineReservations.mockReset();
  mockedRecordOfflineReservations.mockReset();
  mockedRecordOfflineReservations.mockResolvedValue(null);
  debugResetReservationMockState();
});

afterEach(() => {
  debugResetReservationMockState();
});

describe("reservation offline state", () => {
  it("uses the scoped offline snapshot in the table reservation window", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Backend temporaneamente non disponibile." }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    );
    mockedReadOfflineReservations.mockResolvedValueOnce(summary());
    const now = Date.parse("2026-07-24T19:40:00+02:00");
    const table: DiningTable = {
      id: "table-1",
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
    };

    const [reservedTable] = await applyReservationWindowToSessionTables([table], session, now);

    expect(mockedReadOfflineReservations).toHaveBeenCalledWith(
      { userId: session.userId, activityId: session.activityId },
      session.roomId,
      session.serviceDate
    );
    expect(reservedTable).toMatchObject({
      id: "table-1",
      occupancyState: "reserved",
      reservationAt: reservation().reservationAt,
      tableName: "Cliente iniziale",
    });
  });

  it("queues table-page reservation creates with the canonical replay contract", async () => {
    mockedApiFetch.mockRejectedValueOnce(new TypeError("offline"));
    mockedReadOfflineReservations.mockResolvedValueOnce(summary());
    mockedApiFetch.mockResolvedValueOnce(queuedResponse());

    await saveTableReservationPreview({
      ...session,
      tableId: "table-2",
      reservationAt: Date.parse("2026-07-24T21:30:00+02:00"),
      tableName: "Cliente dal tavolo",
      covers: 3,
    });

    const createBody = JSON.parse(String(mockedApiFetch.mock.calls[1]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(createBody).toMatchObject({
      expectedVersion: 7,
      customerName: "Cliente dal tavolo",
      assignedTableId: "table-2",
      assignedTableIds: ["table-2"],
    });
    expect(createBody.clientReservationId).toMatch(/^res_[a-zA-Z0-9_-]{8,120}$/);
    expect(createBody.clientCreatedAt).toEqual(expect.any(Number));
    expect(mockedRecordOfflineReservations.mock.calls.at(-1)?.[3]).toMatchObject({ version: 8 });
  });

  it("uses the authoritative server version for the next online mutation", async () => {
    mockedApiFetch.mockResolvedValueOnce(jsonResponse(summary()));
    await fetchReservationsForDay(session);

    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({
        version: 12,
        reservation: reservation({
          id: "reservation-server-1",
          customerName: "Prima online",
          reservationAt: Date.parse("2026-07-24T21:00:00+02:00"),
        }),
      })
    );
    await createDiningReservation({
      ...session,
      reservationAt: Date.parse("2026-07-24T21:00:00+02:00"),
      customerName: "Prima online",
    });

    mockedApiFetch.mockResolvedValueOnce(
      jsonResponse({
        version: 13,
        reservation: reservation({
          id: "reservation-server-2",
          customerName: "Seconda online",
          reservationAt: Date.parse("2026-07-24T22:00:00+02:00"),
        }),
      })
    );
    await createDiningReservation({
      ...session,
      reservationAt: Date.parse("2026-07-24T22:00:00+02:00"),
      customerName: "Seconda online",
    });

    const firstMutationBody = JSON.parse(String(mockedApiFetch.mock.calls[1]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    const secondMutationBody = JSON.parse(
      String(mockedApiFetch.mock.calls[2]?.[1]?.body)
    ) as Record<string, unknown>;
    expect(firstMutationBody.expectedVersion).toBe(7);
    expect(secondMutationBody.expectedVersion).toBe(12);
    expect(mockedRecordOfflineReservations.mock.calls.at(-1)?.[3]?.version).toBe(13);
  });

  it("hydrates the day state from a backend snapshot before handling a queued create", async () => {
    mockedApiFetch.mockResolvedValueOnce(jsonResponse(summary()));

    await expect(fetchReservationsForDay(session)).resolves.toMatchObject({
      version: 7,
      reservations: [{ id: "reservation-1" }],
    });

    mockedApiFetch.mockResolvedValueOnce(queuedResponse());
    const created = await createDiningReservation({
      ...session,
      reservationAt: Date.parse("2026-07-24T21:30:00+02:00"),
      customerName: "Cliente offline",
      covers: 3,
    });

    expect(created.customerName).toBe("Cliente offline");
    expect(mockedRecordOfflineReservations).toHaveBeenCalledTimes(2);
    const persisted = mockedRecordOfflineReservations.mock.calls.at(-1)?.[3];
    expect(persisted).toMatchObject({ version: 8 });
    expect(persisted?.reservations.map((entry) => entry.customerName)).toEqual([
      "Cliente iniziale",
      "Cliente offline",
    ]);
  });

  it("hydrates a stored snapshot and persists every queued local mutation", async () => {
    mockedApiFetch.mockRejectedValueOnce(new TypeError("offline"));
    mockedReadOfflineReservations.mockResolvedValueOnce(summary());

    await expect(fetchReservationsForDay(session)).resolves.toMatchObject({
      version: 7,
      reservations: [{ id: "reservation-1" }],
    });

    mockedApiFetch.mockResolvedValueOnce(queuedResponse());
    const created = await createDiningReservation({
      ...session,
      reservationAt: Date.parse("2026-07-24T22:00:00+02:00"),
      customerName: "Nuovo offline",
      covers: 2,
    });

    mockedApiFetch.mockRejectedValueOnce(new TypeError("offline"));
    const updateLock = await acquireReservationEditLock({
      ...session,
      reservationId: "reservation-1",
    });
    mockedApiFetch.mockResolvedValueOnce(queuedResponse());
    const updated = await updateDiningReservation({
      ...session,
      reservationId: "reservation-1",
      lockId: updateLock.lockId,
      patch: { customerName: "Cliente modificato" },
    });

    mockedApiFetch.mockResolvedValueOnce(queuedResponse());
    const statusResult = await updateDiningReservationStatus({
      ...session,
      reservationId: "reservation-1",
      action: "arrived",
    });

    mockedApiFetch.mockRejectedValueOnce(new TypeError("offline"));
    const deleteLock = await acquireReservationEditLock({
      ...session,
      reservationId: created.id,
    });
    mockedApiFetch.mockResolvedValueOnce(queuedResponse());
    await deleteDiningReservation({
      ...session,
      reservationId: created.id,
      lockId: deleteLock.lockId,
    });

    expect(updated.customerName).toBe("Cliente modificato");
    expect(statusResult.reservation.status).toBe("arrived");
    expect(mockedRecordOfflineReservations).toHaveBeenCalledTimes(4);

    const persistedAfterCreate = mockedRecordOfflineReservations.mock.calls[0]?.[3];
    const persistedAfterUpdate = mockedRecordOfflineReservations.mock.calls[1]?.[3];
    const persistedAfterStatus = mockedRecordOfflineReservations.mock.calls[2]?.[3];
    const persistedAfterDelete = mockedRecordOfflineReservations.mock.calls[3]?.[3];

    expect(persistedAfterCreate?.reservations).toHaveLength(2);
    expect(
      persistedAfterUpdate?.reservations.find((entry) => entry.id === "reservation-1")?.customerName
    ).toBe("Cliente modificato");
    expect(
      persistedAfterStatus?.reservations.find((entry) => entry.id === "reservation-1")?.status
    ).toBe("arrived");
    expect(persistedAfterDelete?.reservations.map((entry) => entry.id)).toEqual(["reservation-1"]);
  });
});
