import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_APPROVE_TABLE_ROOM_MOVE_ON_TIMEOUT,
  createTableRoomMoveHelpers,
} from "../modules/table-room-move/table-room-move.domain.js";

const fixedNow = 1_800_000;

function createHelpers() {
  return createTableRoomMoveHelpers({
    approvalTimeoutMs: 120_000,
    nowMs: () => fixedNow,
  });
}

function validRequest(overrides = {}) {
  return {
    requestId: "req_1",
    requesterUserId: "u_waiter",
    requesterUsername: "waiter",
    requesterDeviceUuid: "device_1",
    targetRoomId: "room_sala",
    targetRoomName: "Sala",
    fromTableId: "room_pedana_t01",
    targetTableIds: ["room_sala_t02"],
    createdAt: 1_000_000,
    ...overrides,
  };
}

test("table room move timeout policy is explicit and enabled", () => {
  assert.equal(AUTO_APPROVE_TABLE_ROOM_MOVE_ON_TIMEOUT, true);
});

test("sanitizePosTableRoomMoveRequestRecord preserves legacy request shape", () => {
  const { sanitizePosTableRoomMoveRequestRecord } = createHelpers();
  const rooms = new Map([["room_sala", { id: "room_sala", name: "Sala Autorizzata" }]]);
  const request = sanitizePosTableRoomMoveRequestRecord(
    validRequest({
      targetRoomName: "Nome payload",
      targetTableIds: [" room_sala_t02 ", "ROOM_SALA_T02", "room_sala_t03"],
      targetTableLabels: [" 2 ", "2", "3"],
      sourceLeafCount: 99,
      targetTableCount: "2",
      adjustCoversDelta: -99,
      status: "unknown",
    }),
    rooms
  );

  assert.equal(request.targetRoomName, "Sala Autorizzata");
  assert.deepEqual(request.targetTableIds, ["room_sala_t02", "room_sala_t03"]);
  assert.deepEqual(request.targetTableLabels, ["2", "3"]);
  assert.equal(request.sourceLeafCount, 24);
  assert.equal(request.targetTableCount, 2);
  assert.equal(request.adjustCoversDelta, -24);
  assert.equal(request.status, "pending");
  assert.equal(request.expiresAt, 1_120_000);
});

test("sanitizePosTableRoomMoveRequestRecord rejects incomplete records", () => {
  const { sanitizePosTableRoomMoveRequestRecord } = createHelpers();

  assert.equal(sanitizePosTableRoomMoveRequestRecord(null), null);
  assert.equal(sanitizePosTableRoomMoveRequestRecord(validRequest({ requestId: "" })), null);
  assert.equal(sanitizePosTableRoomMoveRequestRecord(validRequest({ fromTableId: "" })), null);
  assert.equal(sanitizePosTableRoomMoveRequestRecord(validRequest({ targetTableIds: [] })), null);
});

test("buildPosTableRoomMoveResponse exposes only operator response fields", () => {
  const { buildPosTableRoomMoveResponse } = createHelpers();
  const response = buildPosTableRoomMoveResponse(validRequest({ approverUsername: "manager" }));

  assert.equal(response.requestId, "req_1");
  assert.equal(response.status, "pending");
  assert.equal(response.targetRoomId, "room_sala");
  assert.equal(response.approverUsername, "manager");
  assert.equal(Object.hasOwn(response, "requesterDeviceUuid"), false);
});

test("resolvePendingPosTableRoomMoveRequest supports timeout_approved without approver", () => {
  const { resolvePendingPosTableRoomMoveRequest } = createHelpers();
  const db = { posTableRoomMoveRequests: [validRequest()] };

  const resolved = resolvePendingPosTableRoomMoveRequest(db, db.posTableRoomMoveRequests[0], "timeout_approved");

  assert.equal(resolved.changed, true);
  assert.equal(resolved.request.status, "timeout_approved");
  assert.equal(resolved.request.approvedAt, fixedNow);
  assert.equal(resolved.request.rejectedAt, null);
  assert.equal(db.posTableRoomMoveRequests[0].status, "timeout_approved");
});

test("resolvePendingPosTableRoomMoveRequest preserves rejected and approved branches", () => {
  const { resolvePendingPosTableRoomMoveRequest } = createHelpers();
  const rejectedDb = { posTableRoomMoveRequests: [validRequest({ requestId: "req_reject" })] };
  const approvedDb = { posTableRoomMoveRequests: [validRequest({ requestId: "req_approve" })] };

  const rejected = resolvePendingPosTableRoomMoveRequest(
    rejectedDb,
    rejectedDb.posTableRoomMoveRequests[0],
    "rejected",
    { id: "u_manager", username: "manager" }
  );
  const approved = resolvePendingPosTableRoomMoveRequest(
    approvedDb,
    approvedDb.posTableRoomMoveRequests[0],
    "approved",
    { id: "u_manager", username: "manager" }
  );

  assert.equal(rejected.request.status, "rejected");
  assert.equal(rejected.request.rejectedAt, fixedNow);
  assert.equal(rejected.request.approverUserId, "u_manager");
  assert.equal(approved.request.status, "approved");
  assert.equal(approved.request.approvedAt, fixedNow);
  assert.equal(approved.request.approverUsername, "manager");
});

test("buildPosTableRoomMoveNotificationPayload creates request notification", () => {
  const { buildPosTableRoomMoveNotificationPayload } = createHelpers();
  const notification = buildPosTableRoomMoveNotificationPayload(
    validRequest({
      requesterFullName: "Giada Bianchi",
      fromTableLabel: "Tavolo 1",
      targetTableLabels: ["2"],
      expiresAt: 1_120_000,
    }),
    "request"
  );

  assert.equal(notification.type, "general");
  assert.equal(notification.title, "Sala");
  assert.equal(notification.description, "Giada Bianchi chiede di spostare Tavolo 1 in questa sala.");
  assert.equal(notification.meta.eventType, "table_room_move_request");
  assert.equal(notification.meta.targetClientApp, "mobile-frontend");
  assert.deepEqual(notification.meta.targetTableLabels, ["2"]);
});

test("buildPosTableRoomMoveNotificationPayload creates timeout notification", () => {
  const { buildPosTableRoomMoveNotificationPayload } = createHelpers();
  const notification = buildPosTableRoomMoveNotificationPayload(
    validRequest({ fromTableLabel: "Tavolo 1" }),
    "timeout"
  );

  assert.equal(notification.title, "Cambio sala tavolo");
  assert.equal(notification.description, "Tavolo 1 spostato automaticamente in Sala.");
  assert.equal(notification.meta.eventType, "table_room_move_timeout");
  assert.equal(notification.meta.targetRoomId, "room_sala");
});

test("buildPosTableRoomMoveNotificationPayload creates resolved notifications", () => {
  const { buildPosTableRoomMoveNotificationPayload } = createHelpers();
  const approved = buildPosTableRoomMoveNotificationPayload(
    validRequest({ status: "approved", fromTableLabel: "Tavolo 1" }),
    "resolved"
  );
  const rejected = buildPosTableRoomMoveNotificationPayload(
    validRequest({ status: "rejected", fromTableLabel: "Tavolo 1" }),
    "resolved"
  );

  assert.equal(approved.description, "Spostamento Tavolo 1 approvato.");
  assert.equal(approved.meta.eventType, "table_room_move_approved");
  assert.equal(approved.meta.targetUserId, "u_waiter");
  assert.equal(rejected.description, "Spostamento Tavolo 1 rifiutato.");
  assert.equal(rejected.meta.eventType, "table_room_move_rejected");
});
