import {
  adminRoute,
  authRoute,
  debugRoute,
  permissionRoute,
  publicMutationRoute,
  publicRoute,
  serviceRoute,
} from "../core/route-builders.js";
import { buildAutomaticCashRoutes } from "../modules/automatic-cash/index.js";
import { buildAppStateRoutes } from "../modules/app-state/index.js";
import { buildCommercialBenefitsRoutes } from "../modules/commercial-benefits/index.js";
import { buildCounterRoutes } from "../modules/counter/index.js";
import { buildExternalLookupRoutes } from "../modules/external-lookups/index.js";
import { buildFiscalRoutes } from "../modules/fiscal-pos/index.js";
import { buildIntegrationRoutes } from "../modules/integration/index.js";
import { buildMenuRoutes } from "../modules/menu/index.js";
import { buildMobileBatteryRoutes } from "../modules/mobile-battery/index.js";
import { buildPaymentRoutes } from "../modules/payments/index.js";
import { buildPosRoomsRoutes } from "../modules/pos-rooms/index.js";
import { buildPostazioneActionRoutes } from "../modules/postazione-actions/index.js";
import { buildRadioRoutes } from "../modules/radio/index.js";
import { buildReservationsRoutes } from "../modules/reservations/index.js";
import { buildReportsRoutes } from "../modules/reports/index.js";
import { buildSalesSessionsRoutes } from "../modules/sales-sessions/index.js";
import { buildScopedReadsRoutes } from "../modules/scoped-reads/index.js";
import { buildSettingsRoutes } from "../modules/settings/index.js";
import { buildStatusRoutes } from "../modules/status/index.js";

export function buildRouteRegistry() {
  return [
    ...buildStatusRoutes(),
    publicMutationRoute("POST", "/api/auth/login", "auth.login", {
      maxBodySize: 8_192,
      publicReason: "Login pubblico necessario: valida PIN/utente e crea sessione/audit.",
    }),
    authRoute("POST", "/api/auth/logout", "auth.logout"),
    authRoute("POST", "/api/auth/session/status", "auth.sessionStatus"),
    authRoute("POST", "/api/auth/workstation/select", "auth.selectWorkstation", {
      maxBodySize: 8_192,
    }),
    authRoute("POST", "/api/auth/change-pin", "auth.changePin"),

    ...buildExternalLookupRoutes(),
    ...buildMobileBatteryRoutes(),
    ...buildMenuRoutes(),
    ...buildPostazioneActionRoutes(),

    permissionRoute("POST", "/api/settings/pos/users", "users.list", "manage_users"),
    permissionRoute("POST", "/api/settings/pos/users/save", "users.save", "manage_users"),
    ...buildAppStateRoutes(),

    ...buildIntegrationRoutes(),
    ...buildScopedReadsRoutes(),

    ...buildPosRoomsRoutes(),
    authRoute("POST", "/api/pos/room-change/request", "pos.roomChangeRequest"),
    permissionRoute("POST", "/api/pos/room-change/approve", "pos.roomChangeApprove", "approve_room_change"),
    permissionRoute("POST", "/api/pos/room-change/cancel", "pos.roomChangeCancel", "approve_room_change"),
    ...buildReservationsRoutes(),

    ...buildSettingsRoutes(),
    ...buildAutomaticCashRoutes(),
    ...buildCommercialBenefitsRoutes(),
    ...buildRadioRoutes(),
    authRoute("POST", "/api/settings/order-workflow", "settings.saveOrderWorkflow"),
    permissionRoute("POST", "/api/settings/pos/assign-bill", "settings.assignBill", "collect_payments"),

    authRoute("POST", "/api/tables/lock/acquire", "tables.lockAcquire"),
    authRoute("POST", "/api/tables/lock/heartbeat", "tables.lockHeartbeat"),
    authRoute("POST", "/api/tables/lock/release", "tables.lockRelease"),
    permissionRoute("POST", "/api/tables/lock/force-release", "tables.lockForceRelease", "approve_room_change"),

    ...buildPaymentRoutes(),
    permissionRoute("POST", "/api/payments/ticket", "payments.ticket", "collect_payments"),
    ...buildCounterRoutes(),
    ...buildFiscalRoutes(),

    authRoute("POST", "/api/smart/customers", "smart.customers"),
    permissionRoute("POST", "/api/smart/customers/upsert", "smart.customerUpsert", "manage_smart_customers"),
    permissionRoute("POST", "/api/smart/customers/delete", "smart.customerDelete", "manage_smart_customers"),
    authRoute("POST", "/api/smart/card/read", "smart.cardRead"),
    permissionRoute("POST", "/api/smart/cash/beach-entry", "smart.beachEntry", "manage_smart_customers"),
    serviceRoute("POST", "/api/smart/card/detected", "smart.cardDetected", "smart-card"),
    permissionRoute("POST", "/api/smart/customers/recharge", "smart.customerRecharge", "manage_smart_customers"),
    permissionRoute("POST", "/api/smart/non-fiscal", "smart.nonFiscal", "manage_smart_customers"),

    ...buildReportsRoutes(),
    ...buildSalesSessionsRoutes(),
  ];
}
