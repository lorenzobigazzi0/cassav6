export const ORDER_BEST_SELLER_LIMIT = 7;

type BestSellerEntry = {
  productId: string;
};

export function buildBestSellerRankByProductId(entries: readonly BestSellerEntry[]) {
  const ranks = new Map<string, number>();
  for (const entry of entries) {
    const productId = String(entry.productId ?? "").trim();
    if (!productId || ranks.has(productId)) continue;
    ranks.set(productId, ranks.size + 1);
    if (ranks.size >= ORDER_BEST_SELLER_LIMIT) break;
  }
  return ranks;
}

export function sortProductsByBestSellerRank<T extends { id: string }>(
  products: readonly T[],
  ranks: ReadonlyMap<string, number>
) {
  if (ranks.size === 0) return [...products];
  return products
    .map((product, index) => ({ product, index, rank: ranks.get(product.id) }))
    .sort((left, right) => {
      if (left.rank !== undefined && right.rank !== undefined) return left.rank - right.rank;
      if (left.rank !== undefined) return -1;
      if (right.rank !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ product }) => product);
}
