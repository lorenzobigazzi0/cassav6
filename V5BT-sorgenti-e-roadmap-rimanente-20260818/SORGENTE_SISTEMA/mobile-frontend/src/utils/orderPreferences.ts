import { readLocalPreference, writeLocalPreference } from "../shared/storage/preferenceStorage";

const ORDER_FILTERS_KEY = "settings_order_show_filters";
const ORDER_FILTERS_EVENT = "order_filters_changed";
const ORDER_BEST_SELLERS_KEY = "settings_order_show_best_sellers";
const ORDER_BEST_SELLERS_EVENT = "order_best_sellers_changed";

export const getOrderFiltersEnabled = () => {
  if (typeof window === "undefined") return false;
  const saved = readLocalPreference(ORDER_FILTERS_KEY);
  return saved === "1";
};

export const setOrderFiltersEnabled = (value: boolean) => {
  if (typeof window === "undefined") return;
  writeLocalPreference(ORDER_FILTERS_KEY, value ? "1" : "0");
  window.dispatchEvent(new Event(ORDER_FILTERS_EVENT));
};

export const subscribeOrderFilters = (handler: () => void) => {
  if (typeof window === "undefined") return () => {};
  const listener = () => handler();
  window.addEventListener(ORDER_FILTERS_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(ORDER_FILTERS_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
};

export const getOrderBestSellersEnabled = () => {
  if (typeof window === "undefined") return false;
  return readLocalPreference(ORDER_BEST_SELLERS_KEY) === "1";
};

export const setOrderBestSellersEnabled = (value: boolean) => {
  if (typeof window === "undefined") return;
  writeLocalPreference(ORDER_BEST_SELLERS_KEY, value ? "1" : "0");
  window.dispatchEvent(new Event(ORDER_BEST_SELLERS_EVENT));
};

export const subscribeOrderBestSellers = (handler: () => void) => {
  if (typeof window === "undefined") return () => {};
  const listener = () => handler();
  window.addEventListener(ORDER_BEST_SELLERS_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(ORDER_BEST_SELLERS_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
};
