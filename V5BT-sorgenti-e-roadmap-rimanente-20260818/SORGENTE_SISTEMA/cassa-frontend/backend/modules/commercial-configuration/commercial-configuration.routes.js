export function buildCommercialConfigurationRoutes() {
  const adminRead = (path, handlerKey) => ({
    method: "POST",
    path,
    handlerKey,
    mutation: false,
    readOnly: true,
    readOnlyReason: "Lettura configurazione commerciale v2.",
    authRequired: true,
    permission: "manage_settings",
    maxBodySize: 5_000_000,
  });
  const adminMutation = (path, handlerKey) => ({
    method: "POST",
    path,
    handlerKey,
    mutation: true,
    authRequired: true,
    permission: "manage_settings",
    maxBodySize: 5_000_000,
  });
  return [
    adminRead("/api/settings/commercial/snapshot", "commercial.snapshot"),
    adminMutation("/api/settings/commercial/draft/create", "commercial.draftCreate"),
    adminMutation("/api/settings/commercial/draft/save", "commercial.draftSave"),
    adminRead("/api/settings/commercial/draft/validate", "commercial.draftValidate"),
    adminMutation("/api/settings/commercial/draft/publish", "commercial.draftPublish"),
    adminRead("/api/settings/commercial/versions/list", "commercial.versionsList"),
    adminRead("/api/settings/commercial/versions/diff", "commercial.versionsDiff"),
    adminMutation("/api/settings/commercial/versions/rollback", "commercial.versionsRollback"),
    adminRead("/api/settings/commercial/simulate", "commercial.simulate"),
    adminRead("/api/settings/commercial/export", "commercial.export"),
    adminMutation("/api/settings/commercial/import", "commercial.import"),
    adminMutation("/api/settings/commercial/bootstrap/legacy", "commercial.bootstrapLegacy"),
    {
      method: "POST",
      path: "/api/commercial/runtime/catalog",
      handlerKey: "commercial.runtimeCatalog",
      mutation: false,
      readOnly: true,
      readOnlyReason: "Catalogo commerciale risolto per il contesto autenticato.",
      authRequired: true,
    },
    {
      method: "POST",
      path: "/api/commercial/runtime/price",
      handlerKey: "commercial.runtimePrice",
      mutation: false,
      readOnly: true,
      readOnlyReason: "Prezzo autorevole risolto per il contesto autenticato.",
      authRequired: true,
    },
  ];
}
