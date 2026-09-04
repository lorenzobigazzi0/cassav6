import type { MenuProduct } from "./menu";

const identityText = (value: unknown) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "")
    .replace(/ck/g, "k")
    .toLowerCase();

const productScore = (product: MenuProduct) =>
  (product.available ? 4 : 0) +
  (product.variants.length > 0 ? 2 : 0) +
  (product.description ? 1 : 0) +
  (product.ingredients.length > 0 ? 1 : 0);

export function dedupeMenuCatalogProducts(products: MenuProduct[]) {
  const byIdentity = new Map<string, MenuProduct>();
  products.forEach((product) => {
    const identity = [
      identityText(product.name),
      product.departmentId,
      product.categoryId,
      identityText(product.section ?? ""),
    ].join("|");
    const existing = byIdentity.get(identity);
    if (!existing || productScore(product) > productScore(existing)) byIdentity.set(identity, product);
  });
  return [...byIdentity.values()];
}
