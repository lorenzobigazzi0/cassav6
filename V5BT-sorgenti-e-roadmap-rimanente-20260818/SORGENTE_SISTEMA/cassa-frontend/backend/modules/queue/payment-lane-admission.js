export function enqueuePaymentLaneTaskWithAdmission(options = {}) {
  const coordinator = options.coordinator;
  const enqueue = options.enqueue;
  const action = options.action;
  if (typeof enqueue !== "function") {
    throw new TypeError("enqueue payment lane non disponibile.");
  }
  if (typeof action !== "function") {
    throw new TypeError("azione payment lane non disponibile.");
  }

  const label = String(options.label ?? "payment_lane_mutation").trim() ||
    "payment_lane_mutation";
  const runWithReservation = (reservation) =>
    typeof coordinator?.runInLocalReservation === "function"
      ? coordinator.runInLocalReservation(reservation, action)
      : action();

  const runInLane = async () => {
    if (
      coordinator?.enabled !== true ||
      options.deferNamedLockAdmission === true
    ) {
      return runWithReservation(null);
    }
    if (typeof coordinator.reserveLocal !== "function") {
      throw new TypeError("reservation named lock payment lane non disponibile.");
    }
    return coordinator.reserveLocal(
      `${label}.admission`,
      runWithReservation,
      { priority: options.namedLockPriority },
    );
  };

  return enqueue(runInLane);
}
