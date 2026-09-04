import type {
  ProductDisplayPricing,
  ProductPricingMeta,
  ProductTimedPriceRange,
} from "../shared/pricing/productPricing";

export type MenuDepartment = { id: string; name: string };

export type MenuCategory = { id: string; departmentId: string; name: string };

export type MenuProductVariant = {
  id: string;
  name: string;
  priceDelta: number;
};

export type MenuProduct = {
  id: string;
  sku: string;
  departmentId: string;
  categoryId: string;
  type?: string;
  section?: string;
  name: string;
  description: string;
  ingredients: string[];
  allergens: string[];
  isFrozen: boolean;
  variants: MenuProductVariant[];
  variantRequired?: boolean;
  requiresVariant?: boolean;
  requiresVariantSelection?: boolean;
  isPremiumAlcohol?: boolean;
  available: boolean;
  availabilityScope?: "global" | "station" | null;
  unavailableStations?: string[];
  unavailableForStation?: boolean;
  stations?: string[];
  price: number;
  basePrice?: number;
  priceSchedule?: ProductTimedPriceRange[];
  timedPrices?: ProductTimedPriceRange[];
  timePriceSchedule?: ProductTimedPriceRange[];
  listinoTemporizzato?: ProductTimedPriceRange[];
  activePrice?: number | string | null;
  currentPrice?: number | string | null;
  vatRate?: number | null;
  vatCode?: string | null;
  nextPriceChangeAt?: string | null;
  pricingLabel?: string | null;
  pricingSource?: string | null;
  pricingMeta?: ProductPricingMeta | null;
  displayPricing?: ProductDisplayPricing;
  imageUrl: string | null;
};

export type MenuCatalog = {
  departments: MenuDepartment[];
  categories: MenuCategory[];
  products: MenuProduct[];
};

export type MenuSessionRequest = {
  token: string;
  userId: string;
  deviceUuid: string;
  activityId?: string;
  roomId: string;
};

export type MenuCatalogSnapshot = {
  version: number;
  catalog: MenuCatalog;
};

export type MenuCatalogPatch =
  | { type: "replace_catalog"; catalog: MenuCatalog }
  | { type: "upsert_product"; product: MenuProduct }
  | { type: "remove_product"; productId: string }
  | { type: "set_availability"; productId: string; available: boolean };

export type MenuCatalogUpdates = {
  version: number;
  updates: MenuCatalogPatch[];
};
