export function buildPostazioneActionRoutes() {
  return [
    {
      method: "GET",
      path: "/api/flags",
      handlerKey: "postazione.flags",
      public: true,
      authRequired: false,
      mutation: false,
    },
    {
      method: "POST",
      path: "/api/actions",
      handlerKey: "postazione.actions",
      authRequired: true,
      permission: "manage_menu",
      mutation: true,
    },
  ];
}
