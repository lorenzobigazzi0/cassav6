import test from "node:test";
import assert from "node:assert/strict";
import { createReservationsHandlers } from "../modules/reservations/reservations.handlers.js";

test("reservations.list inoltra il contesto auth del router al resolver sala", async () => {
  const authenticatedContext = {
    user: { id: "u_live", role: "operator" },
    session: { id: "shared-session", deviceUuid: "mobile-1" },
  };
  let observedContext = null;
  let response = null;
  const handlers = createReservationsHandlers({
    clonePosReservation: (entry) => entry,
    readDb: async () => ({ sessions: [], posReservationStates: [] }),
    readJsonBody: async () => ({
      token: "valid-shared-token",
      userId: "u_live",
      deviceUuid: "mobile-1",
      roomId: "room_pedana",
      serviceDate: "2026-07-16",
    }),
    relationalReservationsReadEnabled: false,
    resolvePosReservationServiceDate: (payload) => payload.serviceDate,
    resolvePosRoomSessionContext(_db, payload, context) {
      observedContext = context;
      return { ...authenticatedContext, roomId: payload.roomId };
    },
    sendJson(_res, status, body) {
      response = { status, body };
    },
  });

  await handlers["pos.reservationsList"]({ __authContext: authenticatedContext }, {});

  assert.equal(observedContext, authenticatedContext);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.reservations, []);
});
