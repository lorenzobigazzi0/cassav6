import { authRoute, permissionRoute } from "../../core/route-builders.js";

export function buildCommercialBenefitsRoutes() {
  return [
    permissionRoute(
      "POST",
      "/api/commercial-benefits/campaigns/list",
      "commercialBenefits.listCampaigns",
      "manage_settings",
      {
        mutation: false,
        readOnly: true,
        readOnlyReason: "Lettura campagne sconti, promozioni, buoni e carte regalo per impostazioni.",
        maxBodySize: 16_384,
      },
    ),
    permissionRoute(
      "POST",
      "/api/commercial-benefits/campaigns",
      "commercialBenefits.createCampaign",
      "manage_settings",
      { maxBodySize: 131_072 },
    ),
    permissionRoute(
      "POST",
      "/api/commercial-benefits/campaigns/update",
      "commercialBenefits.updateCampaign",
      "manage_settings",
      { maxBodySize: 131_072 },
    ),
    permissionRoute(
      "POST",
      "/api/commercial-benefits/coupons/update",
      "commercialBenefits.updateCoupon",
      "manage_settings",
      { maxBodySize: 65_536 },
    ),
    permissionRoute(
      "POST",
      "/api/commercial-benefits/print",
      "commercialBenefits.printCoupon",
      "manage_settings",
      { maxBodySize: 65_536 },
    ),
    authRoute("POST", "/api/commercial-benefits/validate", "commercialBenefits.validate", {
      maxBodySize: 65_536,
    }),
    authRoute("POST", "/api/commercial-benefits/release", "commercialBenefits.release", {
      maxBodySize: 16_384,
    }),
  ];
}
