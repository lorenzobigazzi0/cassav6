import type { MenuCatalog } from "../../../../api/menu";
import type { DiningTableOrderLine } from "../../../../api/tables";

type ProductLike = MenuCatalog["products"][number] & {
  iva?: number | string | null;
  taxRate?: number | string | null;
  vatCode?: string | null;
  ivaCode?: string | null;
  taxCode?: string | null;
};

type LineWithVat = DiningTableOrderLine & {
  vatRate?: number;
  vatCode?: string;
};

const normalizeVatRate = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return Math.round(parsed * 1000) / 1000;
};

export function resolveProductVatRate(product: ProductLike | null | undefined): number | null {
  if (!product) return null;
  return normalizeVatRate(product.vatRate ?? product.iva ?? product.taxRate);
}

export function resolveProductVatCode(product: ProductLike | null | undefined): string | undefined {
  const value = String(product?.vatCode ?? product?.ivaCode ?? product?.taxCode ?? "").trim();
  return value || undefined;
}

export function attachCounterVatRates(
  lines: DiningTableOrderLine[],
  productsById: ReadonlyMap<string, MenuCatalog["products"][number]>
): LineWithVat[] {
  return lines.map((line) => {
    const productId = String(line.productId ?? "").trim();
    const product = productId ? productsById.get(productId) : null;
    const vatRate = normalizeVatRate((line as LineWithVat).vatRate) ?? resolveProductVatRate(product);
    return {
      ...line,
      ...(vatRate !== null ? { vatRate } : {}),
      ...(resolveProductVatCode(product) ? { vatCode: resolveProductVatCode(product) } : {}),
    };
  });
}

export function findMissingCounterVatLine(lines: DiningTableOrderLine[]) {
  return (
    lines.find((line) => {
      const vatRate = normalizeVatRate((line as LineWithVat).vatRate);
      return vatRate === null;
    }) ?? null
  );
}
