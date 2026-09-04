export function buildRadioRoutes() {
  return [
    {
      method: "POST",
      path: "/api/settings/radio",
      handlerKey: "settings.radio",
      mutation: false,
      readOnly: true,
      readOnlyReason: "Lettura canali radio globali senza scrittura DB.",
      authRequired: true,
    },
    {
      method: "POST",
      path: "/api/settings/radio/save",
      handlerKey: "settings.saveRadio",
      mutation: true,
      authRequired: true,
    },
    {
      method: "POST",
      path: "/api/mobile/radio/config",
      handlerKey: "mobile.radioConfig",
      mutation: false,
      readOnly: true,
      readOnlyReason: "Lettura configurazione radio mobile senza scrittura DB.",
      authRequired: true,
    },
    {
      method: "POST",
      path: "/api/mobile/radio/config/save",
      handlerKey: "mobile.saveRadioConfig",
      mutation: true,
      authRequired: true,
    },
  ];
}
