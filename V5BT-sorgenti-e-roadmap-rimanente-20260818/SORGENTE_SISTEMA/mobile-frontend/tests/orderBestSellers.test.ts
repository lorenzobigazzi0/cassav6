import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildBestSellerRankByProductId,
  ORDER_BEST_SELLER_LIMIT,
  sortProductsByBestSellerRank,
} from "../src/utils/orderBestSellers";
import {
  getOrderBestSellersEnabled,
  setOrderBestSellersEnabled,
  subscribeOrderBestSellers,
} from "../src/utils/orderPreferences";

describe("order best sellers", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("limits the shared ranking to seven unique products", () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      productId: index === 2 ? "product_1" : `product_${index}`,
    }));

    const ranks = buildBestSellerRankByProductId(entries);

    expect(ranks.size).toBe(ORDER_BEST_SELLER_LIMIT);
    expect([...ranks.keys()]).toEqual([
      "product_0",
      "product_1",
      "product_3",
      "product_4",
      "product_5",
      "product_6",
      "product_7",
    ]);
  });

  it("moves ranked products first without changing the order of the others", () => {
    const products = [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }, { id: "delta" }];
    const ranks = buildBestSellerRankByProductId([{ productId: "gamma" }, { productId: "alpha" }]);

    expect(sortProductsByBestSellerRank(products, ranks).map((product) => product.id)).toEqual([
      "gamma",
      "alpha",
      "beta",
      "delta",
    ]);
    expect(products.map((product) => product.id)).toEqual(["alpha", "beta", "gamma", "delta"]);
  });

  it("promotes and marks only the first seven while preserving the normal remainder", () => {
    const products = [
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "zeta",
      "eta",
      "theta",
      "iota",
      "kappa",
    ].map((id) => ({ id }));
    const rankedIds = [
      "iota",
      "eta",
      "epsilon",
      "gamma",
      "alpha",
      "kappa",
      "theta",
      "zeta",
      "delta",
    ];
    const ranks = buildBestSellerRankByProductId(
      rankedIds.map((productId) => ({ productId }))
    );

    const orderedIds = sortProductsByBestSellerRank(products, ranks).map(({ id }) => id);
    const promotedIds = rankedIds.slice(0, ORDER_BEST_SELLER_LIMIT);
    const normalRemainder = products
      .map(({ id }) => id)
      .filter((id) => !promotedIds.includes(id));

    expect([...ranks.values()]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(orderedIds).toEqual([...promotedIds, ...normalRemainder]);
    expect(ranks.has("zeta")).toBe(false);
    expect(ranks.has("delta")).toBe(false);
  });

  it("persists and publishes the automatic activation preference", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOrderBestSellers(listener);

    expect(getOrderBestSellersEnabled()).toBe(false);
    setOrderBestSellersEnabled(true);
    expect(getOrderBestSellersEnabled()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});
