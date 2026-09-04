import { useEffect, useRef } from "react";
import type { ProductPricingInput } from "../../../../shared/pricing/productPricing";
import {
  getTimedPricingRefreshDelay,
  normalizeProductPricing,
} from "../../../../shared/pricing/productPricing";

const VISIBILITY_REFRESH_COOLDOWN_MS = 5_000;

export function useTimedPricingRefresh({
  enabled = true,
  products,
  onRefresh,
}: {
  enabled?: boolean;
  products: ProductPricingInput[];
  onRefresh: () => void | Promise<unknown>;
}) {
  const onRefreshRef = useRef(onRefresh);
  const lastVisibilityRefreshAtRef = useRef(0);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    const delay = getTimedPricingRefreshDelay(products);
    if (delay === null) return undefined;

    const timer = window.setTimeout(() => {
      void onRefreshRef.current();
    }, delay);

    return () => {
      window.clearTimeout(timer);
    };
  }, [enabled, products]);

  useEffect(() => {
    if (!enabled) return undefined;

    const refreshIfPriceChangePassed = () => {
      if (document.visibilityState === "hidden") return;
      const hasKnownPriceChange = products.some((product) =>
        Boolean(normalizeProductPricing(product).nextPriceChangeAt)
      );
      if (!hasKnownPriceChange) return;
      const delay = getTimedPricingRefreshDelay(products);
      if (delay !== null && delay > 0) return;
      const now = Date.now();
      if (now - lastVisibilityRefreshAtRef.current < VISIBILITY_REFRESH_COOLDOWN_MS) return;
      lastVisibilityRefreshAtRef.current = now;
      void onRefreshRef.current();
    };

    document.addEventListener("visibilitychange", refreshIfPriceChangePassed);
    window.addEventListener("focus", refreshIfPriceChangePassed);

    return () => {
      document.removeEventListener("visibilitychange", refreshIfPriceChangePassed);
      window.removeEventListener("focus", refreshIfPriceChangePassed);
    };
  }, [enabled, products]);
}
