export function buildPosRoomsRoutes() {
  return [
    {
      method: "POST",
      path: "/api/pos/rooms",
      handlerKey: "pos.rooms",
      mutation: false,
      readOnly: true,
      readOnlyReason: "Lista stanze mobile senza scrittura DB.",
      authRequired: true,
    },
  ];
}
