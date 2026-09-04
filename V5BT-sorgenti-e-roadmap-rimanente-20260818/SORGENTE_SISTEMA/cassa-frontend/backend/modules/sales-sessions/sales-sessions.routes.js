export function buildSalesSessionsRoutes() {
  return [
    {
      method: "POST",
      path: "/api/sales/sessions/status",
      handlerKey: "sales.sessionStatus",
      mutation: true,
      authRequired: true,
    },
    {
      method: "POST",
      path: "/api/sales/sessions/open",
      handlerKey: "sales.sessionOpen",
      mutation: true,
      authRequired: true,
      permission: "manage_sale_sessions",
    },
    {
      method: "POST",
      path: "/api/sales/sessions/close",
      handlerKey: "sales.sessionClose",
      mutation: true,
      authRequired: true,
      permission: "manage_sale_sessions",
    },
  ];
}
