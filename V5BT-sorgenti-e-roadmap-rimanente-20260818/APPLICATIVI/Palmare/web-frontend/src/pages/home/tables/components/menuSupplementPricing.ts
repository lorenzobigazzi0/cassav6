export type SupplementType =
  | "none"
  | "menu_apericena"
  | "menu_apericena_prenotazione"
  | "menu_apericena_under4";

export type SupplementContext = { isBeverage: boolean };

export const MENU_SUPPLEMENT_LABEL = "Menu Apericena";
export const MENU_UNDER4_UI_LABEL = "Sotto 4 anni - solo drink";

const MENU_RESERVATION_SUPPLEMENT_LABEL = "Prenotazione";
const MENU_RESERVATION_SUBMIT_LABEL = "Apericena Prenotazione";
const MENU_UNDER4_SUPPLEMENT_LABEL = "Apericena sotto 4 anni";
const APERICENA_STANDARD_TARGET_PRICE = 12;
const APERICENA_RESERVATION_TARGET_PRICE = 14;
const APERICENA_PREMIUM_TARGET_PRICE = 17;
const APERICENA_BEVERAGE_TARGET_PRICE = 10;

const resolveMenuSupplementTarget = (
  basePrice: number,
  supplement: SupplementType,
  context: SupplementContext = { isBeverage: false }
) => {
  if (supplement === "menu_apericena_under4") return null;
  if (context.isBeverage) {
    return supplement === "menu_apericena" && basePrice < APERICENA_BEVERAGE_TARGET_PRICE
      ? APERICENA_BEVERAGE_TARGET_PRICE
      : null;
  }
  if (supplement === "menu_apericena_prenotazione") {
    return basePrice < APERICENA_STANDARD_TARGET_PRICE
      ? APERICENA_RESERVATION_TARGET_PRICE
      : null;
  }
  if (supplement !== "menu_apericena") return null;
  if (basePrice < APERICENA_STANDARD_TARGET_PRICE) return APERICENA_STANDARD_TARGET_PRICE;
  if (basePrice < APERICENA_PREMIUM_TARGET_PRICE) return APERICENA_PREMIUM_TARGET_PRICE;
  return null;
};

export const computeMenuSupplement = (
  basePrice: number,
  supplement: SupplementType,
  context: SupplementContext = { isBeverage: false }
) => {
  const target = resolveMenuSupplementTarget(basePrice, supplement, context);
  return target ? Math.max(0, target - basePrice) : 0;
};

export const computeMenuTarget = (
  basePrice: number,
  supplement: SupplementType,
  context: SupplementContext = { isBeverage: false }
) => resolveMenuSupplementTarget(basePrice, supplement, context);

export const shouldWriteMenuSupplementNote = (
  basePrice: number,
  supplement: SupplementType,
  context: SupplementContext = { isBeverage: false }
) =>
  supplement !== "none" &&
  (computeMenuSupplement(basePrice, supplement, context) > 0 ||
    (context.isBeverage && supplement === "menu_apericena_under4"));

export const getMenuSupplementUiLabel = (supplement: SupplementType) => {
  if (supplement === "menu_apericena_under4") return MENU_UNDER4_UI_LABEL;
  if (supplement === "menu_apericena_prenotazione") return MENU_RESERVATION_SUPPLEMENT_LABEL;
  if (supplement === "menu_apericena") return MENU_SUPPLEMENT_LABEL;
  return "Nessuno";
};

export const getMenuSupplementSubmitLabel = (supplement: string) => {
  if (supplement === "menu_apericena_under4") return MENU_UNDER4_SUPPLEMENT_LABEL;
  if (supplement === "menu_apericena_prenotazione") return MENU_RESERVATION_SUBMIT_LABEL;
  if (supplement === "menu_apericena") return MENU_SUPPLEMENT_LABEL;
  return MENU_SUPPLEMENT_LABEL;
};

export const normalizeSupplementType = (value: unknown): SupplementType =>
  value === "menu_apericena" ||
  value === "menu_apericena_prenotazione" ||
  value === "menu_apericena_under4"
    ? value
    : "none";
