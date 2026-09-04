import { authRoute, permissionRoute, publicMutationRoute, publicRoute, serviceRoute } from "../../core/route-builders.js";

export function buildIntegrationRoutes() {
  return [
    publicRoute("GET", "/api/integration/menu", "integration.menu", { mutation: false }),
    publicRoute("GET", "/api/integration/menu/top-sold", "integration.menuTopSold", {
      mutation: false,
      readOnly: true,
      readOnlyReason: "Lettura classifica articoli piu venduti per nuova comanda.",
    }),
    permissionRoute("POST", "/api/integration/menu", "integration.menu", "manage_menu"),
    permissionRoute("POST", "/api/integration/drawer/open", "integration.drawerOpen", "open_drawer"),
    permissionRoute("POST", "/api/integration/print", "integration.print", "print_orders"),
    publicRoute("GET", "/api/integration/waiters", "integration.waiters", { mutation: false }),
    authRoute("POST", "/api/mobile/waiter-pause/status", "mobile.waiterPauseStatus", {
      mutation: false,
      readOnly: true,
      readOnlyReason: "Lettura stato pausa cameriere mobile.",
    }),
    authRoute("POST", "/api/mobile/waiter-pause/start", "mobile.waiterPauseStart"),
    authRoute("POST", "/api/mobile/waiter-pause/stop", "mobile.waiterPauseStop"),
    publicMutationRoute("POST", "/api/integration/waiter-pause/defer-call", "integration.waiterPauseDeferCall", {
      maxBodySize: 16_384,
      publicReason: "Postazione operativa legacy: registra una chiamata cameriere da consegnare al termine pausa.",
    }),
    publicRoute("GET", "/api/integration/layout", "integration.layout", { mutation: false }),
    authRoute("GET", "/api/integration/table-groups", "integration.tableGroups", { mutation: false }),
    permissionRoute("POST", "/api/integration/table-groups/save", "integration.tableGroupsSave", "manage_tables"),
    publicRoute("GET", "/api/integration/stations/active", "integration.stationsActive", { mutation: false }),
    publicRoute("GET", "/api/integration/stations/state", "integration.stationsState", { mutation: false }),
    publicMutationRoute("POST", "/api/integration/stations/state", "integration.stationsStateUpsert", {
      maxBodySize: 16_384,
      publicReason: "Heartbeat postazione: accetta solo sessioni valide e disattiva heartbeat non autenticati.",
    }),
    authRoute("POST", "/api/integration/layout/table/sync", "integration.tableSync"),
    permissionRoute("POST", "/api/integration/layout/table/move", "integration.tableMove", "manage_tables"),
    authRoute("POST", "/api/integration/layout/table/room-move/request", "integration.tableRoomMoveRequest"),
    authRoute("POST", "/api/integration/layout/table/room-move/status", "integration.tableRoomMoveStatus"),
    authRoute("POST", "/api/integration/layout/table/room-move/pending", "integration.tableRoomMovePending"),
    permissionRoute("POST", "/api/integration/layout/table/room-move/resolve", "integration.tableRoomMoveResolve", "approve_room_change"),
    authRoute("POST", "/api/integration/orders/create", "integration.orderCreate"),
    publicRoute("GET", "/api/integration/orders", "integration.orders", { mutation: false }),
    authRoute("POST", "/api/integration/orders/sync", "integration.orderSync"),
    authRoute("POST", "/api/integration/orders/line/split", "integration.orderLineSplit"),
    permissionRoute("POST", "/api/integration/orders/line/price-override", "integration.orderLinePriceOverride", "override_order_price"),
    authRoute("POST", "/api/integration/orders/correct", "integration.orderCorrect"),
    authRoute("POST", "/api/integration/orders/cancel", "integration.orderCancel"),
    authRoute("GET", "/api/integration/orders/correct/pending", "integration.orderCorrectPending", { mutation: false }),
    permissionRoute("POST", "/api/integration/orders/correct/resolve", "integration.orderCorrectResolve", "approve_room_change"),
    authRoute("POST", "/api/integration/orders/comp", "integration.orderComp"),
    authRoute("POST", "/api/integration/orders/storno", "integration.orderStorno"),
    serviceRoute("POST", "/api/internal/orders/async-appstate-flush", "integration.orderAsyncAppStateFlush", "integration", {
      maxBodySize: 65_536,
    }),
    serviceRoute("POST", "/api/internal/print-spool/legacy-mirror", "integration.printSpoolLegacyMirror", "integration", {
      maxBodySize: 65_536,
    }),
    serviceRoute("POST", "/api/internal/print-spool/auto-print", "integration.printSpoolAutoPrint", "integration", {
      maxBodySize: 262_144,
    }),
    permissionRoute("POST", "/api/orders/replacement/bar-charge", "integration.barChargeReplacement", "create_bar_replacement", {
      legacy: true,
      note: "Alias operativo legacy mantenuto per compatibilita.",
    }),
    permissionRoute("POST", "/api/integration/orders/replacement/bar-charge", "integration.barChargeReplacement", "create_bar_replacement"),
    authRoute("POST", "/api/integration/orders/transfer/request", "integration.orderTransferRequest"),
    permissionRoute("POST", "/api/integration/orders/transfer/resolve", "integration.orderTransferResolve", "approve_room_change"),
    permissionRoute("POST", "/api/integration/orders/transfer/force", "integration.orderTransferForce", "approve_room_change"),
    publicMutationRoute("POST", "/api/integration/notifications/publish", "integration.notificationPublish", {
      maxBodySize: 65_536,
      publicReason: "Canale operativo postazione/mobile per chiamate cameriere e campanella legacy.",
    }),
    publicRoute("GET", "/api/integration/notifications/pull", "integration.notificationsPull", { mutation: false }),
    publicRoute("GET", "/api/integration/notifications/stream", "integration.notificationsStream", { mutation: false }),
    publicMutationRoute("POST", "/api/integration/notifications/ack", "integration.notificationAck", {
      maxBodySize: 16_384,
      publicReason: "Ack operativo legacy per evitare perdita conferme su device senza header custom.",
    }),
    // Step 5 — replay durabile degli eventi realtime da Last-Event-ID (catch-up
    // dopo reconnect). Gli eventi sono gli stessi gia' diffusi sullo stream
    // notifiche pubblico; l'endpoint e' gated su REALTIME_REPLAY_ENABLED.
    publicRoute("GET", "/api/realtime/replay", "realtime.replay", { mutation: false }),
  ];
}
