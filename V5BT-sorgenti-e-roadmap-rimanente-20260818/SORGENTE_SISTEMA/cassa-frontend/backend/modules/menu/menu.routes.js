export function buildMenuRoutes() {
  return [
    {
      method: "POST",
      path: "/api/menu/catalog",
      handlerKey: "menu.catalog",
      mutation: false,
      readOnly: true,
      readOnlyReason: "Catalogo menu runtime senza scrittura DB.",
      authRequired: true,
    },
    {
      method: "POST",
      path: "/api/settings/menu",
      handlerKey: "settings.menu",
      mutation: true,
      authRequired: true,
      permission: "manage_menu",
    },
    {
      method: "POST",
      path: "/api/settings/menu/suggestions",
      handlerKey: "settings.menuSuggestions",
      mutation: false,
      readOnly: true,
      readOnlyReason: "Lettura suggerimenti articoli ricorrenti dagli ordini.",
      authRequired: true,
      permission: "manage_menu",
    },
  ];
}
