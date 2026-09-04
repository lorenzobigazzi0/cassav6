import assert from "node:assert/strict";
import test from "node:test";

import {
  createPosReservationAvailabilityHelpers,
  createPosReservationStateHelpers,
  normalizePosReservationTableIds,
  posReservationAssignedTableIds,
  posReservationIncludesTable,
} from "../modules/reservations/reservations.domain.js";

test("normalizePosReservationTableIds keeps stable unique table ids", () => {
  assert.deepEqual(
    normalizePosReservationTableIds([" T1 ", "t1", "T2", "", null], "T3"),
    ["T1", "T2", "T3"]
  );
});

test("normalizePosReservationTableIds accepts fallback assigned table id", () => {
  assert.deepEqual(normalizePosReservationTableIds(null, " gazebo-4 "), ["gazebo-4"]);
});

test("normalizePosReservationTableIds truncates long ids and caps table groups", () => {
  const longId = "x".repeat(80);
  const values = Array.from({ length: 30 }, (_, index) => `T${index + 1}`);
  const normalized = normalizePosReservationTableIds([longId, ...values]);

  assert.equal(normalized[0], "x".repeat(64));
  assert.equal(normalized.length, 24);
});

test("posReservationAssignedTableIds preserves legacy assignedTableId fallback", () => {
  assert.deepEqual(
    posReservationAssignedTableIds({ assignedTableIds: ["A1"], assignedTableId: "A2" }),
    ["A1", "A2"]
  );
});

test("posReservationIncludesTable matches normalized exact table ids", () => {
  const reservation = { assignedTableIds: ["Gazebo-7", "Bar-2"] };

  assert.equal(posReservationIncludesTable(reservation, "Gazebo-7"), true);
  assert.equal(posReservationIncludesTable(reservation, " gazebo-7 "), false);
  assert.equal(posReservationIncludesTable(reservation, ""), false);
});

test("reservation availability helper classifies configured distance boundaries", () => {
  const { classifyPosReservationDistance } = createPosReservationAvailabilityHelpers({
    minTableGapMinutes: 60,
    dangerGapMinutes: 90,
    warningGapMinutes: 120,
  });

  assert.equal(classifyPosReservationDistance(null), "free");
  assert.equal(classifyPosReservationDistance(59.99), "conflict");
  assert.equal(classifyPosReservationDistance(60), "danger");
  assert.equal(classifyPosReservationDistance(90), "warning");
  assert.equal(classifyPosReservationDistance(120), "safe");
});

test("reservation availability helper formats local clock labels", () => {
  const { posClockFromTimestamp } = createPosReservationAvailabilityHelpers();
  const timestamp = new Date(2026, 0, 2, 9, 5, 0, 0).getTime();

  assert.equal(posClockFromTimestamp(timestamp), "09:05");
});

test("reservation availability helper finds nearest reservation for a table", () => {
  const { findPosNearestReservation } = createPosReservationAvailabilityHelpers({
    minTableGapMinutes: 60,
    dangerGapMinutes: 90,
    warningGapMinutes: 120,
  });
  const base = new Date(2026, 0, 2, 20, 0, 0, 0).getTime();
  const reservations = [
    { id: "ignore", assignedTableIds: ["T1"], reservationAt: base - 10 * 60000 },
    { id: "other-table", assignedTableIds: ["T2"], reservationAt: base - 5 * 60000 },
    { id: "nearest", assignedTableIds: ["T1"], reservationAt: base + 75 * 60000 },
    { id: "far", assignedTableIds: ["T1"], reservationAt: base + 130 * 60000 },
  ];

  const result = findPosNearestReservation(reservations, "T1", base, "ignore");

  assert.equal(result.nearest.id, "nearest");
  assert.equal(result.nearestDistance, 75);
  assert.equal(result.status, "danger");
});

test("reservation availability helper builds operator labels", () => {
  const { buildPosAvailabilityLabel } = createPosReservationAvailabilityHelpers();
  const reservation = {
    customerName: "Rossi",
    reservationAt: new Date(2026, 0, 2, 21, 30, 0, 0).getTime(),
  };

  assert.equal(buildPosAvailabilityLabel("free", null, null), "Disponibile");
  assert.match(buildPosAvailabilityLabel("conflict", reservation, 45), /^Conflitto con Rossi alle 21:30$/);
  assert.match(buildPosAvailabilityLabel("danger", reservation, 75), /^Rischio alto \(75 min\) con Rossi alle 21:30$/);
  assert.match(buildPosAvailabilityLabel("warning", reservation, 105), /^Attenzione \(105 min\) con Rossi alle 21:30$/);
  assert.match(buildPosAvailabilityLabel("safe", reservation, 130), /^Sequenziale \(130 min\) con Rossi alle 21:30$/);
});

test("reservation state helper activates only inside the configured window", () => {
  const { shouldActivatePosReservation } = createPosReservationStateHelpers({
    blockWindowMs: 30 * 60_000,
    lateGraceMs: 30 * 60_000,
  });
  const now = new Date(2026, 0, 2, 20, 0, 0, 0).getTime();

  assert.equal(shouldActivatePosReservation(now + 30 * 60_000, now), true);
  assert.equal(shouldActivatePosReservation(now - 30 * 60_000, now), true);
  assert.equal(shouldActivatePosReservation(now + 30 * 60_000 + 1, now), false);
  assert.equal(shouldActivatePosReservation(now - 30 * 60_000 - 1, now), false);
  assert.equal(shouldActivatePosReservation("non valido", now), false);
});

test("reservation state helper detects terminal released reservations", () => {
  const { isPosReservationReleased } = createPosReservationStateHelpers();

  assert.equal(isPosReservationReleased({ status: " arrived " }), true);
  assert.equal(isPosReservationReleased({ status: "NO_SHOW" }), true);
  assert.equal(isPosReservationReleased({ status: "cancelled" }), true);
  assert.equal(isPosReservationReleased({ status: "released" }), true);
  assert.equal(isPosReservationReleased({ releasedAt: 1 }), true);
  assert.equal(isPosReservationReleased({ status: "active", releasedAt: 0 }), false);
  assert.equal(isPosReservationReleased(null), false);
});
