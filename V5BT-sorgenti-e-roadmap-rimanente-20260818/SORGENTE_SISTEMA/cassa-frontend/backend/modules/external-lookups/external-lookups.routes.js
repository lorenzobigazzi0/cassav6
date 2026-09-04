export function buildExternalLookupRoutes() {
  return [
    {
      method: "POST",
      path: "/api/verifica",
      handlerKey: "vat.verify",
      authRequired: true,
      mutation: true,
    },
    {
      method: "GET",
      path: "/api/ip-coords",
      handlerKey: "ip.coords",
      authRequired: true,
      mutation: false,
    },
    {
      method: "GET",
      path: "/api/city-search",
      handlerKey: "city.search",
      authRequired: true,
      mutation: false,
    },
  ];
}
