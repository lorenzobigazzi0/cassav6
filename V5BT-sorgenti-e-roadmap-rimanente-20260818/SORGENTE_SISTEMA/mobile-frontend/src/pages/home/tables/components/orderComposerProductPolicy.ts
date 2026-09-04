import type { MenuCatalog } from "../../../../api/menu";
import { getMenuProductSection } from "../../../../shared/menu/productSections";
import { textPartsMatchProductSearch } from "../../../../utils/productSearch";

type MenuProduct = MenuCatalog["products"][number];

export const getProductVariants = (product: MenuProduct) =>
  Array.isArray(product.variants) ? product.variants : [];

const getProductIngredients = (product: MenuProduct) =>
  Array.isArray(product.ingredients) ? product.ingredients : [];

export const isOrderableProduct = (product: MenuProduct) => {
  const type = String((product as MenuProduct & { type?: string | null }).type ?? "")
    .trim()
    .toLowerCase();
  return type !== "divider";
};

export const productMatchesOrderSearch = (
  product: MenuProduct,
  query: string,
  categoryName = "",
  departmentName = ""
) =>
  textPartsMatchProductSearch(
    [
      product.name,
      product.sku,
      product.description,
      getProductIngredients(product).join(" "),
      getMenuProductSection(product),
      categoryName,
      departmentName,
    ],
    query
  );

export const productRequiresVariantSelection = (
  product: MenuProduct,
  categoryName = ""
) => {
  if (getProductVariants(product).length === 0) return false;
  const flags = product as MenuProduct & {
    variantRequired?: boolean | null;
    requiresVariant?: boolean | null;
    requiresVariantSelection?: boolean | null;
    isPremiumAlcohol?: boolean | null;
  };
  const category = categoryName.trim().toLowerCase();
  return (
    flags.variantRequired === true ||
    flags.requiresVariant === true ||
    flags.requiresVariantSelection === true ||
    flags.isPremiumAlcohol === true ||
    category.includes("premium")
  );
};
