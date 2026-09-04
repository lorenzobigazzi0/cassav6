export function buildCounterRoutes() {
  return [
    {
      method: "POST",
      path: "/api/tables/counter/orders/collect",
      handlerKey: "payments.counterCollect",
      mutation: true,
      authRequired: true,
      permission: "collect_payments",
      maxBodySize: 98_304,
    },
  ];
}
