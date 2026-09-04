import { adminRoute, permissionRoute } from "../../core/route-builders.js";

export function buildPaymentRoutes() {
  return [
    permissionRoute(
      "POST",
      "/api/payments/table",
      "payments.table",
      "collect_payments",
    ),
    permissionRoute(
      "POST",
      "/api/payments/free-split",
      "payments.freeSplit",
      "collect_payments",
    ),
    {
      method: "POST",
      path: "/api/reports/payment-movement/reprint",
      handlerKey: "reports.paymentMovementReprint",
      mutation: true,
      authRequired: true,
    },
    permissionRoute(
      "POST",
      "/api/reports/payment-movement/fiscal/verify",
      "reports.paymentMovementFiscalVerify",
      "fiscal_operations",
    ),
    permissionRoute(
      "POST",
      "/api/reports/payment-movement/fiscal/issue",
      "reports.paymentMovementFiscalIssue",
      "fiscal_operations",
    ),
    adminRoute(
      "POST",
      "/api/reports/payment-movement/fiscal/void",
      "reports.paymentMovementFiscalVoid",
    ),
  ];
}
