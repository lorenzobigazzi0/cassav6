export const COMMERCIAL_SCHEMA_VERSION = 2;
export const DEFAULT_COMMERCIAL_TIME_ZONE = "Europe/Rome";
export const DEFAULT_COMMERCIAL_CURRENCY = "EUR";

export const COMMERCIAL_SCOPE_TYPES = Object.freeze([
  "global",
  "channel",
  "activity",
  "room",
  "workstation",
  "role",
  "user_group",
  "user",
]);

export const COMMERCIAL_SCOPE_SPECIFICITY = Object.freeze({
  global: 10,
  channel: 20,
  activity: 30,
  room: 40,
  workstation: 50,
  role: 60,
  user_group: 70,
  user: 80,
});

export const COMMERCIAL_ASSIGNMENT_TARGET_TYPES = Object.freeze([
  "catalog",
  "price_list",
]);

export const COMMERCIAL_SELLABLE_TYPES = Object.freeze([
  "product",
  "offer",
  "variant",
  "offer_option",
]);

export const COMMERCIAL_WEEKDAYS = Object.freeze([
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
]);

export const COMMERCIAL_VERSION_STATUSES = Object.freeze([
  "draft",
  "published",
  "archived",
]);

export const COMMERCIAL_PRICING_STRATEGIES = Object.freeze([
  "fixed",
  "sum_components",
]);

export const COMMERCIAL_TAX_ALLOCATION_STRATEGIES = Object.freeze([
  "proportional",
  "dominant_rate",
  "component_exact",
]);

export const COMMERCIAL_DEFAULT_SETTINGS = Object.freeze({
  timeZone: DEFAULT_COMMERCIAL_TIME_ZONE,
  currency: DEFAULT_COMMERCIAL_CURRENCY,
  defaultCatalogId: "catalog_main",
  allowManualPriceOverride: false,
  requireExplicitActivityAndRoom: false,
  pricingPrecedence: [...COMMERCIAL_SCOPE_TYPES],
});
