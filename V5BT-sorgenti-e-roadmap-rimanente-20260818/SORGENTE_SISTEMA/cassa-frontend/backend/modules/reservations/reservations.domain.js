export function normalizePosReservationTableIds(value, fallbackAssignedTableId = null) {
  const out = [];
  const seen = new Set();
  const add = (entry) => {
    const tableId = String(entry ?? "").trim().slice(0, 64);
    if (!tableId) return;
    const key = tableId.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(tableId);
  };
  if (Array.isArray(value)) {
    value.forEach(add);
  }
  add(fallbackAssignedTableId);
  return out.slice(0, 24);
}

export function posReservationAssignedTableIds(reservation) {
  return normalizePosReservationTableIds(
    reservation?.assignedTableIds,
    reservation?.assignedTableId
  );
}

export function posReservationIncludesTable(reservation, tableIdRaw) {
  const tableId = String(tableIdRaw ?? "").trim();
  if (!tableId) return false;
  return posReservationAssignedTableIds(reservation).includes(tableId);
}

function padClockPart(value) {
  return String(value).padStart(2, "0");
}

export function createPosReservationAvailabilityHelpers(options = {}) {
  const minTableGapMinutes = Number(options.minTableGapMinutes);
  const dangerGapMinutes = Number(options.dangerGapMinutes);
  const warningGapMinutes = Number(options.warningGapMinutes);
  const conflictThreshold = Number.isFinite(minTableGapMinutes) ? minTableGapMinutes : 60;
  const dangerThreshold = Number.isFinite(dangerGapMinutes) ? dangerGapMinutes : 90;
  const warningThreshold = Number.isFinite(warningGapMinutes) ? warningGapMinutes : 120;

  function classifyPosReservationDistance(minutesDistance) {
    if (minutesDistance === null) return "free";
    if (minutesDistance < conflictThreshold) return "conflict";
    if (minutesDistance < dangerThreshold) return "danger";
    if (minutesDistance < warningThreshold) return "warning";
    return "safe";
  }

  function posClockFromTimestamp(timestamp) {
    const date = new Date(timestamp);
    return `${padClockPart(date.getHours())}:${padClockPart(date.getMinutes())}`;
  }

  function findPosNearestReservation(reservations, tableId, reservationAt, ignoreReservationId = "") {
    let nearest = null;
    let nearestDistance = null;

    reservations.forEach((reservation) => {
      if (!posReservationIncludesTable(reservation, tableId)) return;
      if (ignoreReservationId && reservation.id === ignoreReservationId) return;
      const distance = Math.abs(reservation.reservationAt - reservationAt) / 60000;
      if (nearestDistance === null || distance < nearestDistance) {
        nearest = reservation;
        nearestDistance = distance;
      }
    });

    return {
      nearest,
      nearestDistance,
      status: classifyPosReservationDistance(nearestDistance),
    };
  }

  function buildPosAvailabilityLabel(status, nearest, minutesDistance) {
    if (!nearest || minutesDistance === null) return "Disponibile";
    const rounded = Math.round(minutesDistance);
    const base = `${nearest.customerName} alle ${posClockFromTimestamp(nearest.reservationAt)}`;
    if (status === "conflict") return `Conflitto con ${base}`;
    if (status === "danger") return `Rischio alto (${rounded} min) con ${base}`;
    if (status === "warning") return `Attenzione (${rounded} min) con ${base}`;
    return `Sequenziale (${rounded} min) con ${base}`;
  }

  return {
    buildPosAvailabilityLabel,
    classifyPosReservationDistance,
    findPosNearestReservation,
    posClockFromTimestamp,
  };
}

export function createPosReservationStateHelpers(options = {}) {
  const blockWindowMs = Number(options.blockWindowMs);
  const lateGraceMs = Number(options.lateGraceMs);
  const activeBlockWindowMs = Number.isFinite(blockWindowMs) ? blockWindowMs : 30 * 60_000;
  const activeLateGraceMs = Number.isFinite(lateGraceMs) ? lateGraceMs : 30 * 60_000;
  const releasedStatuses = new Set(["arrived", "no_show", "cancelled", "released"]);

  function shouldActivatePosReservation(reservationAtRaw, nowMs = Date.now()) {
    const reservationAt = Number(reservationAtRaw);
    return (
      Number.isFinite(reservationAt) &&
      reservationAt - nowMs <= activeBlockWindowMs &&
      reservationAt >= nowMs - activeLateGraceMs
    );
  }

  function isPosReservationReleased(reservation) {
    const status = String(reservation?.status ?? "").trim().toLowerCase();
    if (releasedStatuses.has(status)) {
      return true;
    }
    const releasedAt = Number(reservation?.releasedAt);
    return Number.isFinite(releasedAt) && releasedAt > 0;
  }

  return {
    isPosReservationReleased,
    shouldActivatePosReservation,
  };
}
