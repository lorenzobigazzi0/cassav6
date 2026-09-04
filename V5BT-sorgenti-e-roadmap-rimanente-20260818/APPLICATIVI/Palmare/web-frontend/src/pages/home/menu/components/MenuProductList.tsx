import type { MenuProduct } from "../../../../api/menu";
import {
  formatNextPriceChangeLabel,
  getProductDisplayPricing,
  getTimedPricingBadgeLabel,
} from "../../../../shared/pricing/productPricing";
import { buildMenuProductSectionEntries } from "../../../../shared/menu/productSections";
import {
  MENU_AVAILABILITY_LABEL,
  menuAvailabilityStationsLabel,
  resolveMenuAvailabilityState,
} from "../../../../shared/menu/productAvailability";
import { formatPrice } from "../utils";
import { MenuFeatureBadge } from "./MenuFeatureBadge";

type MenuProductListProps = {
  products: MenuProduct[];
  showSectionDividers?: boolean;
  onSelect: (productId: string, row: HTMLButtonElement) => void;
};

export function MenuProductList({
  products,
  showSectionDividers = false,
  onSelect,
}: MenuProductListProps) {
  if (products.length === 0) {
    return <div className="menu-empty-state">Nessun prodotto trovato con i filtri attivi.</div>;
  }

  const entries = buildMenuProductSectionEntries(products, showSectionDividers);

  return (
    <div className="menu-product-list">
      {entries.map((entry) => {
        if (entry.kind === "section") {
          return (
            <div
              key={entry.id}
              className="menu-product-section-divider"
              role="separator"
              aria-label={`Sezione ${entry.name}`}
            >
              <span>{entry.name}</span>
            </div>
          );
        }

        const product = entry.product;
        const hasAllergens = product.allergens.length > 0;
        const hasVariants = product.variants.length > 0;
        const availabilityState = resolveMenuAvailabilityState(product);
        const isGlobalTerminated = availabilityState === "out";
        const isStationLimited = availabilityState === "low";
        const stationNote = isStationLimited ? menuAvailabilityStationsLabel(product) : "";
        const pricing = getProductDisplayPricing(product);
        const timedPricingLabel = getTimedPricingBadgeLabel(pricing);
        const nextPriceChangeLabel = formatNextPriceChangeLabel(pricing.nextPriceChangeAt);
        // Il badge si mostra solo quando dice qualcosa: per i prodotti
        // disponibili basta la tinta verde della riga.
        const showAvailabilityBadge = availabilityState !== "available";
        const hasPreviewContent =
          showAvailabilityBadge ||
          Boolean(timedPricingLabel) ||
          product.isFrozen ||
          hasAllergens ||
          hasVariants;

        return (
          <button
            key={product.id}
            type="button"
            className={`menu-product-row availability-${availabilityState}${
              isGlobalTerminated ? " is-global-terminated" : ""
            }${isStationLimited ? " is-station-limited" : ""}`}
            onClick={(event) => {
              if (isGlobalTerminated) return;
              onSelect(product.id, event.currentTarget);
            }}
            disabled={isGlobalTerminated}
            aria-disabled={isGlobalTerminated}
            title={stationNote || product.name}
          >
            <div className="menu-product-main">
              <div className="menu-product-name">{product.name}</div>
              {hasPreviewContent ? (
                <div className="menu-product-preview">
                  {showAvailabilityBadge ? (
                    <span
                      className={`menu-availability availability-${availabilityState} ${
                        isGlobalTerminated ? "is-off" : "is-on"
                      }`}
                    >
                      {MENU_AVAILABILITY_LABEL[availabilityState]}
                    </span>
                  ) : null}
                  {timedPricingLabel ? (
                    <span
                      className="menu-timed-price-badge"
                      title={nextPriceChangeLabel ?? timedPricingLabel}
                      aria-label={nextPriceChangeLabel ?? timedPricingLabel}
                    >
                      {timedPricingLabel}
                    </span>
                  ) : null}
                  <span className="menu-feature-list">
                    {product.isFrozen && <MenuFeatureBadge type="frozen" />}
                    {hasAllergens && <MenuFeatureBadge type="allergens" />}
                    {hasVariants && <MenuFeatureBadge type="variants" />}
                  </span>
                </div>
              ) : null}
              {stationNote ? (
                <span className="mobile-menu-availability-note">{stationNote}</span>
              ) : null}
              {nextPriceChangeLabel ? (
                <span className="menu-price-change-note">{nextPriceChangeLabel}</span>
              ) : null}
            </div>
            <div className="menu-product-price">{formatPrice(pricing.displayPrice)}</div>
          </button>
        );
      })}
    </div>
  );
}
