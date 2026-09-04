import { publicRoute } from "../../core/route-builders.js";

export function buildScopedReadsRoutes() {
  return [
    publicRoute("GET", "/api/tables/:tableId", "scopedReads.table", {
      mutation: false,
    }),
    publicRoute("GET", "/api/tables/:tableId/open-order", "scopedReads.tableOpenOrder", {
      mutation: false,
    }),
    publicRoute("GET", "/api/rooms/:roomId/tables", "scopedReads.roomTables", {
      mutation: false,
    }),
    publicRoute("GET", "/api/notifications", "scopedReads.notifications", {
      mutation: false,
    }),
    publicRoute("GET", "/api/print/jobs/:jobId", "scopedReads.printJob", {
      mutation: false,
    }),
  ];
}
