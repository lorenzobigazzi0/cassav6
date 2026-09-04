import { createRoomChangeOperationTelemetry } from "./room-change-operation-telemetry.js";

export function createPosRoomChangeRequestTelemetry(options = {}) {
  return createRoomChangeOperationTelemetry({
    ...options,
    metricKind: "posRoomChangeRequest",
    allowedOutcomes: ["direct", "pending", "rejected", "error"],
  });
}
