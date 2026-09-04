import type { MenuProduct } from "../../../api/menu";
import { textPartsMatchProductSearch } from "../../../utils/productSearch";

const euroFormatter = new Intl.NumberFormat("it-IT", {
  style: "currency",
  currency: "EUR",
});

export const formatPrice = (value: number) => euroFormatter.format(value);

export function productMatchesSearch(
  product: MenuProduct,
  query: string,
  includeIngredients = false
) {
  const section = String(
    (product as MenuProduct & { section?: string | null; subcategory?: string | null }).section ??
      (product as MenuProduct & { section?: string | null; subcategory?: string | null })
        .subcategory ??
      ""
  );
  const haystackParts = [product.name, product.description, product.sku, section];
  if (includeIngredients) {
    haystackParts.push(product.ingredients.join(" "));
  }

  return textPartsMatchProductSearch(haystackParts, query);
}
