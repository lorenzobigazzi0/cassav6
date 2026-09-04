import { CommercialConfigurationRelationalRepository } from "../../db/relational/commercial-configuration.repo.js";
import { CommercialConfigurationService } from "./commercial-configuration.service.js";
import { normalizeCommercialPricingContext } from "./commercial-pricing.service.js";

const RUNTIME_MODES = new Set(["off", "shadow", "primary"]);

function normalizeRuntimeMode(env) {
  const explicit = String(env.COMMERCIAL_PRICING_RUNTIME_MODE ?? "")
    .trim()
    .toLowerCase();
  if (RUNTIME_MODES.has(explicit)) return explicit;
  const legacyEnabled = String(env.COMMERCIAL_CONFIGURATION_V2 ?? "0").trim() === "1";
  const legacyShadow = String(env.COMMERCIAL_CONFIGURATION_V2_SHADOW ?? "0").trim() === "1";
  if (legacyEnabled) return "primary";
  return legacyShadow ? "shadow" : "off";
}

export function createCommercialConfigurationRuntime(options = {}) {
  const relationalRuntime = options.relationalRuntime;
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const mode = normalizeRuntimeMode(env);
  const primaryEnabled = mode === "primary";
  const shadowEnabled = mode === "shadow";
  const runtimeEnabled = primaryEnabled;
  const strictEnabled = String(env.COMMERCIAL_PRICING_STRICT ?? "1").trim() !== "0";
  let repository = null;
  let service = null;
  let dbRef = null;

  async function ensure() {
    await relationalRuntime?.initialize?.();
    const db = relationalRuntime?.db;
    if (!db) {
      const error = new Error("DB relazionale non disponibile per la configurazione commerciale v2.");
      error.code = "COMMERCIAL_RELATIONAL_DB_UNAVAILABLE";
      throw error;
    }
    if (!repository || dbRef !== db) {
      dbRef = db;
      repository = new CommercialConfigurationRelationalRepository(db, { nowIso, logger });
      service = new CommercialConfigurationService(repository, { nowIso, logger });
    }
    return { repository, service };
  }

  function buildContext({ payload = {}, user = {}, session = {}, operationalSnapshot = null, req = null } = {}) {
    return normalizeCommercialPricingContext({
      dateTime: payload.dateTime ?? payload.requestedAt ?? Date.now(),
      channel: payload.channel ?? payload.clientApp ?? session.clientApp ?? req?.headers?.["x-client-app"],
      activityId: payload.activityId ?? operationalSnapshot?.activityId,
      roomId: payload.roomId ?? payload.areaId ?? operationalSnapshot?.roomId ?? session.roomId,
      workstationId:
        payload.workstationId ?? payload.stationId ?? payload.station ?? operationalSnapshot?.workstationId ?? session.stationName,
      role: user.role,
      userGroupIds: user.groupIds ?? user.userGroupIds ?? user.groups,
      userId: user.id ?? session.userId,
      orderMode: payload.orderMode,
      reservationContext: payload.reservationContext,
    });
  }

  async function withPublishedConfiguration(callback, input = {}) {
    const { service: currentService } = await ensure();
    try {
      return await callback(currentService);
    } catch (error) {
      if (error?.code === "COMMERCIAL_CONFIGURATION_NOT_PUBLISHED" && input.allowMissing !== false) {
        return null;
      }
      throw error;
    }
  }

  return {
    mode,
    primaryEnabled,
    shadowEnabled,
    runtimeEnabled,
    strictEnabled,
    buildContext,
    ensure,
    async getService() {
      return (await ensure()).service;
    },
    async buildLegacyMenuItems(input = {}) {
      const allowed = primaryEnabled || shadowEnabled || input.force === true;
      if (!allowed) return { active: false, reason: "feature_disabled", mode };
      const result = await withPublishedConfiguration(
        (currentService) => currentService.buildLegacyMenuItems(input),
        input,
      );
      return result ?? { active: false, reason: "not_published", mode };
    },
    async resolveLine(input = {}) {
      if (!primaryEnabled && input.force !== true) return null;
      return withPublishedConfiguration(
        (currentService) => currentService.resolveLine(input),
        input,
      );
    },
    async shadowResolveLine(input = {}) {
      if (!shadowEnabled && input.force !== true) return null;
      try {
        return await withPublishedConfiguration(
          (currentService) => currentService.resolveLine(input),
          input,
        );
      } catch (error) {
        logger.warn?.("[commercial-v2] shadow pricing failed", error);
        return null;
      }
    },
    comparePrices({ legacyUnitPrice, commercialResolution, metadata = {} } = {}) {
      if (!commercialResolution) return null;
      const legacyUnitPriceCents = Math.max(0, Math.round(Number(legacyUnitPrice ?? 0) * 100));
      const commercialUnitPriceCents = Math.max(0, Math.round(Number(commercialResolution.finalUnitPriceCents ?? 0)));
      const result = {
        equal: legacyUnitPriceCents === commercialUnitPriceCents,
        legacyUnitPriceCents,
        commercialUnitPriceCents,
        deltaCents: commercialUnitPriceCents - legacyUnitPriceCents,
        sellableType: commercialResolution.sellableType,
        sellableId: commercialResolution.sellableId,
        configurationVersionId: commercialResolution.configurationVersionId,
        priceFingerprint: commercialResolution.priceFingerprint,
        ...metadata,
      };
      if (!result.equal) logger.warn?.("[commercial-v2] shadow divergence", result);
      return result;
    },
  };
}
