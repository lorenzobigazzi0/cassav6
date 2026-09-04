export function buildMobileBatteryRoutes() {
  return [
    {
      method: "GET",
      path: "/api/mobile/battery",
      handlerKey: "mobile.battery",
      authRequired: true,
      mutation: false,
    },
    {
      method: "GET",
      path: "/api/mobile/battery/events",
      handlerKey: "mobile.batteryEvents",
      public: true,
      mutation: false,
    },
    {
      method: "POST",
      path: "/api/settings/mobile-devices/status",
      handlerKey: "mobile.batteryDevices",
      authRequired: true,
      mutation: false,
      readOnly: true,
      readOnlyReason: "Lettura stato batterie palmari per frontend impostazioni.",
    },
  ];
}
