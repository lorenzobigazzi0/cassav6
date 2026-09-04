import type { MenuProduct } from "../../../../api/menu";
import { getProductDisplayPricing } from "../../../../shared/pricing/productPricing";
import type { OrderCorrectionLineDraft } from "../../../../api/orderServiceRecovery";
import type { GlassDropdownOption } from "./GlassDropdown";
import { isApericenaBeverageProduct } from "./beverageApericenaCategory";

export type ServiceRecoverySupplement =
  | "none"
  | "menu_apericena"
  | "menu_apericena_prenotazione"
  | "menu_apericena_under4";

const MENU_SUPPLEMENT_LABEL = "Menu Apericena";
const MENU_RESERVATION_SUBMIT_LABEL = "Apericena Prenotazione";
const MENU_UNDER4_SUPPLEMENT_LABEL = "Apericena sotto 4 anni";
const MENU_UNDER4_UI_LABEL = "Sotto 4 anni - solo drink";
const APERICENA_STANDARD_TARGET_PRICE = 12;
const APERICENA_RESERVATION_TARGET_PRICE = 14;
const APERICENA_PREMIUM_TARGET_PRICE = 17;
const APERICENA_BEVERAGE_TARGET_PRICE = 10;

const normalize = (value: unknown) => String(value == null ? "" : value).trim();
const money = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100) / 100) : 0;
};

export const serviceRecoverySupplementLabel = (supplement: ServiceRecoverySupplement) => {
  if (supplement === "menu_apericena_under4") return MENU_UNDER4_SUPPLEMENT_LABEL;
  if (supplement === "menu_apericena_prenotazione") return MENU_RESERVATION_SUBMIT_LABEL;
  if (supplement === "menu_apericena") return MENU_SUPPLEMENT_LABEL;
  return "";
};

export const normalizeServiceRecoverySupplement = (
  value: unknown
): ServiceRecoverySupplement => {
  const text = normalize(value).toLowerCase();
  if (
    text === "menu_apericena_under4" ||
    text.includes("sotto 4") ||
    text.includes("sotto4") ||
    text.includes("under4") ||
    text.includes("under 4")
  ) {
    return "menu_apericena_under4";
  }
  if (text === "menu_apericena_prenotazione" || text.includes("prenotazione")) {
    return "menu_apericena_prenotazione";
  }
  if (text === "menu_apericena" || text.includes("apericena") || text.includes("menu")) {
    return "menu_apericena";
  }
  return "none";
};

const resolveSupplementTarget = (
  basePrice: number,
  supplement: ServiceRecoverySupplement,
  product: MenuProduct | null = null
) => {
  if (supplement === "menu_apericena_under4") return null;
  if (isApericenaBeverageProduct(product)) {
    return supplement === "menu_apericena" && basePrice < APERICENA_BEVERAGE_TARGET_PRICE
      ? APERICENA_BEVERAGE_TARGET_PRICE
      : null;
  }
  if (supplement === "menu_apericena_prenotazione") {
    return basePrice < APERICENA_STANDARD_TARGET_PRICE ? APERICENA_RESERVATION_TARGET_PRICE : null;
  }
  if (supplement !== "menu_apericena") return null;
  if (basePrice < APERICENA_STANDARD_TARGET_PRICE) return APERICENA_STANDARD_TARGET_PRICE;
  if (basePrice < APERICENA_PREMIUM_TARGET_PRICE) return APERICENA_PREMIUM_TARGET_PRICE;
  return null;
};

const computeSupplementAmount = (
  basePrice: number,
  supplement: ServiceRecoverySupplement,
  product: MenuProduct | null = null
) => {
  const target = resolveSupplementTarget(basePrice, supplement, product);
  return target ? Math.max(0, target - basePrice) : 0;
};

export const serviceRecoverySupplementValue = (line: OrderCorrectionLineDraft) => {
  const modifierValue = line.nextModifiers.Supplemento ?? line.nextModifiers.supplemento;
  const detected = normalizeServiceRecoverySupplement(modifierValue);
  if (detected !== "none") return detected;
  return normalizeServiceRecoverySupplement(line.nextNotes || line.originalNotes);
};

const variantDeltaFor = (product: MenuProduct | null, variantName: string) => {
  const safeVariant = normalize(variantName).toLowerCase();
  if (!product || !safeVariant) return 0;
  const variant = product.variants.find(
    (entry) => normalize(entry.name).toLowerCase() === safeVariant || entry.id === variantName
  );
  return money(variant?.priceDelta);
};

export const serviceRecoveryBaseUnitPrice = (
  line: OrderCorrectionLineDraft,
  product: MenuProduct | null,
  variantName = line.nextVariant
) => {
  if (!product) return money(line.unitPrice);
  return money(getProductDisplayPricing(product).displayPrice + variantDeltaFor(product, variantName));
};

export const resolveServiceRecoveryUnitPrice = (
  line: OrderCorrectionLineDraft,
  product: MenuProduct | null,
  variantName = line.nextVariant,
  supplement = serviceRecoverySupplementValue(line)
) => {
  const basePrice = serviceRecoveryBaseUnitPrice(line, product, variantName);
  return money(basePrice + computeSupplementAmount(basePrice, supplement, product));
};

export const serviceRecoveryNoteWithSupplement = (
  line: OrderCorrectionLineDraft,
  product: MenuProduct | null,
  variantName: string,
  supplement: ServiceRecoverySupplement
) => {
  const basePrice = serviceRecoveryBaseUnitPrice(line, product, variantName);
  const amount = computeSupplementAmount(basePrice, supplement, product);
  const parts = normalize(line.nextNotes)
    .split("|")
    .map(normalize)
    .filter((part) => part && !/apericena|prenotazione/i.test(part));
  if (
    supplement !== "none" &&
    (amount > 0 ||
      (isApericenaBeverageProduct(product) && supplement === "menu_apericena_under4"))
  ) {
    parts.push(
      amount > 0
        ? `${serviceRecoverySupplementLabel(supplement)} +${amount.toFixed(2)} EUR`
        : serviceRecoverySupplementLabel(supplement)
    );
  }
  return parts.join(" | ");
};

const formatSupplementOptionLabel = (
  basePrice: number,
  supplement: ServiceRecoverySupplement,
  product: MenuProduct | null
) => {
  if (isApericenaBeverageProduct(product) && supplement === "menu_apericena_under4") {
    return `${MENU_UNDER4_UI_LABEL} (prezzo drink ${basePrice.toFixed(2)} EUR)`;
  }
  const label = serviceRecoverySupplementLabel(supplement);
  const amount = computeSupplementAmount(basePrice, supplement, product);
  const target = resolveSupplementTarget(basePrice, supplement, product);
  return amount > 0 && target
    ? `${label} (+${amount.toFixed(2)} EUR -> ${target.toFixed(2)} EUR)`
    : `${label} (non disponibile)`;
};

export const serviceRecoverySupplementOptions = (
  line: OrderCorrectionLineDraft,
  product: MenuProduct | null
): GlassDropdownOption[] => {
  const basePrice = serviceRecoveryBaseUnitPrice(line, product);
  const current = serviceRecoverySupplementValue(line);
  const options: GlassDropdownOption[] = isApericenaBeverageProduct(product)
    ? [
        { value: "none", label: "Nessun supplemento" },
        {
          value: "menu_apericena",
          label: formatSupplementOptionLabel(basePrice, "menu_apericena", product),
          disabled: computeSupplementAmount(basePrice, "menu_apericena", product) <= 0,
        },
        {
          value: "menu_apericena_under4",
          label: formatSupplementOptionLabel(basePrice, "menu_apericena_under4", product),
        },
      ]
    : [
        { value: "none", label: "Nessun supplemento" },
        {
          value: "menu_apericena",
          label: formatSupplementOptionLabel(basePrice, "menu_apericena", product),
          disabled: computeSupplementAmount(basePrice, "menu_apericena", product) <= 0,
        },
        {
          value: "menu_apericena_prenotazione",
          label: formatSupplementOptionLabel(basePrice, "menu_apericena_prenotazione", product),
          disabled: computeSupplementAmount(basePrice, "menu_apericena_prenotazione", product) <= 0,
        },
      ];
  if (current !== "none" && !options.some((option) => option.value === current)) {
    options.unshift({ value: current, label: `Attuale: ${serviceRecoverySupplementLabel(current)}` });
  }
  return options;
};

export const withServiceRecoverySupplement = (
  modifiers: Record<string, string>,
  supplement: ServiceRecoverySupplement
) => {
  const next = { ...modifiers };
  delete next.supplemento;
  if (supplement === "none") delete next.Supplemento;
  else next.Supplemento = serviceRecoverySupplementLabel(supplement);
  return next;
};
