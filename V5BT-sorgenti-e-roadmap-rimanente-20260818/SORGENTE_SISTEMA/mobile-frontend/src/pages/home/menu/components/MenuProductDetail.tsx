import type { MenuProduct } from "../../../../api/menu";
import {
  formatNextPriceChangeLabel,
  getProductDisplayPricing,
  getTimedPricingBadgeLabel,
} from "../../../../shared/pricing/productPricing";
import { formatPrice } from "../utils";
import { MenuFeatureBadge } from "./MenuFeatureBadge";

type MenuProductDetailProps = {
  product: MenuProduct;
  categoryName: string;
  departmentName: string;
};

export function MenuProductDetail({
  product,
  categoryName,
  departmentName,
}: MenuProductDetailProps) {
  const unavailableStations = product.unavailableStations ?? [];
  const pricing = getProductDisplayPricing(product);
  const timedPricingLabel = getTimedPricingBadgeLabel(pricing);
  const nextPriceChangeLabel = formatNextPriceChangeLabel(pricing.nextPriceChangeAt);
  const variantsLabel =
    product.variants.length === 0
      ? "Nessuna"
      : product.variants
          .map((variant) =>
            variant.priceDelta === 0
              ? variant.name
              : `${variant.name} (${variant.priceDelta > 0 ? "+" : ""}${formatPrice(variant.priceDelta)})`
          )
          .join(", ");

  return (
    <div className="menu-product-detail">
      <div className="menu-photo-wrap">
        {product.imageUrl ? (
          <img src={product.imageUrl} alt={product.name} className="menu-product-photo" />
        ) : (
          <div className="menu-product-photo is-placeholder" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <rect x="3" y="4" width="18" height="16" rx="3" />
              <path d="M8 14l2.3-2.6a1 1 0 0 1 1.5 0L16 16" />
              <circle cx="9" cy="9" r="1.2" />
            </svg>
          </div>
        )}
      </div>

      <h3 className="menu-detail-name">{product.name}</h3>

      <div className="menu-detail-flags">
        {product.isFrozen && (
          <span className="menu-detail-flag">
            <MenuFeatureBadge type="frozen" />
            Prodotto congelato
          </span>
        )}
        {product.allergens.length > 0 && (
          <span className="menu-detail-flag">
            <MenuFeatureBadge type="allergens" />
            Allergeni presenti
          </span>
        )}
        {product.variants.length > 0 && (
          <span className="menu-detail-flag">
            <MenuFeatureBadge type="variants" />
            Varianti disponibili
          </span>
        )}
        {timedPricingLabel && (
          <span className="menu-detail-flag is-timed-price" title={nextPriceChangeLabel}>
            {timedPricingLabel}
          </span>
        )}
      </div>

      <div className="menu-detail-table">
        <div className="menu-detail-row">
          <span>Prezzo</span>
          <strong>{formatPrice(pricing.displayPrice)}</strong>
        </div>
        {nextPriceChangeLabel ? (
          <div className="menu-detail-row">
            <span>Listino</span>
            <strong>{nextPriceChangeLabel}</strong>
          </div>
        ) : null}
        <div className="menu-detail-row">
          <span>Disponibilita</span>
          <strong>{product.available ? "Disponibile" : "Non disponibile"}</strong>
        </div>
        {product.availabilityScope === "station" && unavailableStations.length > 0 ? (
          <div className="menu-detail-row">
            <span>Postazioni escluse</span>
            <strong>{unavailableStations.join(", ")}</strong>
          </div>
        ) : null}
        <div className="menu-detail-row">
          <span>Categoria</span>
          <strong>{categoryName}</strong>
        </div>
        <div className="menu-detail-row">
          <span>Reparto</span>
          <strong>{departmentName}</strong>
        </div>
        <div className="menu-detail-row">
          <span>Descrizione</span>
          <strong>{product.description}</strong>
        </div>
        <div className="menu-detail-row">
          <span>Ingredienti</span>
          <strong>
            {product.ingredients.length ? product.ingredients.join(", ") : "Non indicati"}
          </strong>
        </div>
        <div className="menu-detail-row">
          <span>Prodotto congelato</span>
          <strong>{product.isFrozen ? "Si" : "No"}</strong>
        </div>
        <div className="menu-detail-row">
          <span>Lista allergeni</span>
          <strong>{product.allergens.length ? product.allergens.join(", ") : "Nessuno"}</strong>
        </div>
        <div className="menu-detail-row">
          <span>Varianti</span>
          <strong>{variantsLabel}</strong>
        </div>
        <div className="menu-detail-row">
          <span>SKU prodotto</span>
          <strong>{product.sku}</strong>
        </div>
      </div>
    </div>
  );
}
