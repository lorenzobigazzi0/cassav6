import type { MenuProduct } from "../../../../api/menu";

const normalizeCategoryToken = (value: unknown) =>
  String(value == null ? "" : value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

const normalizeCategoryId = (value: unknown) =>
  normalizeCategoryToken(value).replace(/[\s-]+/g, "_");

export const isApericenaBeverageCategory = (
  categoryId: unknown,
  categoryName: unknown = ""
) => {
  const id = normalizeCategoryId(categoryId);
  const name = normalizeCategoryToken(categoryName).replace(/\s+/g, " ");
  return id === "cat_bevande" || id === "bevande" || name === "bevande";
};

export const isApericenaBeverageProduct = (
  product: MenuProduct | null | undefined,
  categoryName: unknown = ""
) => Boolean(product && isApericenaBeverageCategory(product.categoryId, categoryName));
