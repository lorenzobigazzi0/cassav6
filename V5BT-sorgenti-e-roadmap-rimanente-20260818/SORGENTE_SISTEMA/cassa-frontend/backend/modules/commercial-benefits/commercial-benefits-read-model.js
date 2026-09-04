/**
 * Reader della sola route di lettura del dominio `commerce` (P2b, MIG-033).
 *
 * `validateSessionContext` resta qui dentro: su sessione scaduta rimuove la
 * sessione, registra l'audit e aggiorna `meta.lastWriteAt` in memoria prima di
 * sollevare 401, quindi non e una lettura pura.
 */
import { ensureCommercialBenefitCollections } from "./commercial-benefits.domain.js";
import { publicCampaignResource } from "./commercial-benefits.handlers.js";

export function createCommercialBenefitsReadModel({
  readDb,
  validateSessionContext,
}) {
  async function listCampaignsView(payload, authContext) {
    const db = await readDb();
    validateSessionContext(db, payload);
    ensureCommercialBenefitCollections(db);
    const campaigns = (Array.isArray(db.commercialBenefitCampaigns) ? db.commercialBenefitCampaigns : [])
      .map((campaign) => publicCampaignResource(db, campaign))
      .sort((left, right) => String(right.updatedAt ?? right.createdAt ?? "").localeCompare(String(left.updatedAt ?? left.createdAt ?? "")));
    return {
      ok: true,
      campaigns,
      couponsCount: db.commercialBenefitCoupons.length,
      redemptionsCount: db.commercialBenefitRedemptions.length,
      settingsVersion: db.meta?.settingsVersion ?? db.meta?.version ?? 0,
    };
  }

  return {
    listCampaignsView,
  };
}
