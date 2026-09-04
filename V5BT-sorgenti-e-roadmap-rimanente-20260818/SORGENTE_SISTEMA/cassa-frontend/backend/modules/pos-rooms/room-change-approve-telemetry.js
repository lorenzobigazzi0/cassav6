import { createRoomChangeOperationTelemetry } from "./room-change-operation-telemetry.js";

export function createPosRoomChangeApproveTelemetry(options = {}) {
  return createRoomChangeOperationTelemetry({
    ...options,
    metricKind: "posRoomChangeApprove",
    allowedOutcomes: [
      "approved",
      "not_found",
      "invalid_credentials",
      "forbidden",
      "error",
    ],
  });
}
