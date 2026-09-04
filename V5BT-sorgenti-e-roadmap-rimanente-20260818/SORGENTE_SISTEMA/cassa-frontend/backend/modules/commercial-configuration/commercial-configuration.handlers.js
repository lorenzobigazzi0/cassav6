function toHttpError(HttpError, error) {
  if (error instanceof HttpError) return error;
  const code = String(error?.code ?? "COMMERCIAL_CONFIGURATION_ERROR");
  const status = {
    COMMERCIAL_DRAFT_NOT_FOUND: 404,
    COMMERCIAL_VERSION_NOT_FOUND: 404,
    COMMERCIAL_CONFIGURATION_NOT_PUBLISHED: 404,
    COMMERCIAL_REVISION_CONFLICT: 409,
    COMMERCIAL_DRAFT_ALREADY_EXISTS: 409,
    COMMERCIAL_CONFIGURATION_INVALID: 422,
    COMMERCIAL_RELATIONAL_DB_UNAVAILABLE: 503,
  }[code] ?? 400;
  return new HttpError(status, error instanceof Error ? error.message : String(error), {
    code,
    ...(error?.details && typeof error.details === "object" ? error.details : {}),
    ...(error?.validation ? { validation: error.validation } : {}),
  });
}

export function createCommercialConfigurationHandlers(options) {
  const {
    HttpError,
    commercialConfigurationRuntime,
    readDb,
    readJsonBody,
    sendJson,
    validateSessionContext,
  } = options;

  async function context(req) {
    const payload = await readJsonBody(req);
    const db = await readDb();
    const auth = req.__authContext && typeof req.__authContext === "object"
      ? req.__authContext
      : validateSessionContext(db, payload);
    const actor = {
      userId: auth.user?.id,
      username: auth.user?.username,
      deviceUuid: auth.session?.deviceUuid,
      clientApp: auth.session?.clientApp,
    };
    const pricingContext = commercialConfigurationRuntime.buildContext({
      payload,
      user: auth.user,
      session: auth.session,
      req,
    });
    return { payload, db, auth, actor, pricingContext };
  }

  async function run(req, res, callback) {
    try {
      const current = await context(req);
      const service = await commercialConfigurationRuntime.getService();
      const result = await callback(service, current);
      sendJson(res, 200, result);
    } catch (error) {
      throw toHttpError(HttpError, error);
    }
  }

  return {
    "commercial.snapshot": (req, res) => run(req, res, (service) => service.getWorkspace()),
    "commercial.draftCreate": (req, res) => run(req, res, (service, current) => service.createDraft({
      ...current.payload,
      actor: current.actor,
    })),
    "commercial.draftSave": (req, res) => run(req, res, (service, current) => service.saveDraft({
      ...current.payload,
      actor: current.actor,
    })),
    "commercial.draftValidate": (req, res) => run(req, res, (service, current) => service.validateDraft({
      ...current.payload,
      validationOptions: current.payload.validationOptions,
    })),
    "commercial.draftPublish": (req, res) => run(req, res, (service, current) => service.publishDraft({
      ...current.payload,
      actor: current.actor,
    })),
    "commercial.versionsList": (req, res) => run(req, res, (service, current) => service.listVersions(current.payload)),
    "commercial.versionsDiff": (req, res) => run(req, res, (service, current) => service.diffVersions(current.payload)),
    "commercial.versionsRollback": (req, res) => run(req, res, (service, current) => service.rollback({
      ...current.payload,
      actor: current.actor,
    })),
    "commercial.simulate": (req, res) => run(req, res, (service, current) => service.simulate({
      ...current.payload,
      context: { ...current.pricingContext, ...(current.payload.context ?? {}) },
    })),
    "commercial.export": (req, res) => run(req, res, (service, current) => service.exportVersion(current.payload)),
    "commercial.import": (req, res) => run(req, res, async (service, current) => {
      const draft = current.payload.draftId
        ? { id: current.payload.draftId, revision: current.payload.expectedRevision }
        : await service.createDraft({ actor: current.actor, idempotencyKey: current.payload.idempotencyKey && `${current.payload.idempotencyKey}:create` });
      return service.saveDraft({
        draftId: draft.id ?? draft.version?.id,
        expectedRevision: draft.revision ?? draft.version?.revision ?? current.payload.expectedRevision ?? 0,
        snapshot: current.payload.snapshot,
        actor: current.actor,
        idempotencyKey: current.payload.idempotencyKey && `${current.payload.idempotencyKey}:save`,
      });
    }),
    "commercial.bootstrapLegacy": (req, res) => run(req, res, (service, current) => service.bootstrapFromLegacy({
      ...current.payload,
      db: current.db,
      actor: current.actor,
    })),
    "commercial.runtimeCatalog": (req, res) => run(req, res, async (service, current) => {
      const result = await service.buildLegacyMenuItems({ context: current.pricingContext });
      return { ok: true, commercialV2: true, ...result };
    }),
    "commercial.runtimePrice": (req, res) => run(req, res, (service, current) => service.resolveLine({
      context: current.pricingContext,
      line: current.payload.line ?? current.payload.sellable ?? current.payload,
    })),
  };
}
