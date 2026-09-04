import { permissionRoute } from "../../core/route-builders.js";

export function buildFiscalRoutes() {
  return [
    permissionRoute(
      "POST",
      "/api/fiscal/command",
      "fiscal.command",
      "fiscal_operations",
    ),
  ];
}
