import type { MenuProduct } from "../../../api/menu";
import {
  createClientPriceSnapshot,
  getProductDisplayPricing,
  normalizeClientPriceSnapshot,
  type ProductClientPriceSnapshot,
} from "../../../shared/pricing/productPricing";

export type OrderDraftPricingItem = {
  /** Id della riga di carrello che ha generato questa voce, quando disponibile. */
  id?: string;
  productId: string;
  variantId: string;
  note: string;
  quantity: number;
  supplement: string;
  customName?: string;
  customPrice?: number;
  clientPriceSnapshot?: ProductClientPriceSnapshot;
};

export type OrderDraftSubmitLine = {
  lineId?: string;
  productId?: string;
  name: string;
  qty: number;
  note?: string;
  variantName?: string;
  unitBasePrice?: number;
  unitFinalPrice?: number;
  priceDelta?: number;
  priceChanged?: boolean;
  priceChangeReason?: "variant" | "manual" | "supplement" | "unknown";
  vatRate?: number;
  vatCode?: string;
  clientPriceSnapshot?: ProductClientPriceSnapshot;
};

export type TableOrderSubmitPayload = {
  title: string;
  total: number;
  orderNote?: string;
  orderComment?: string;
  lines: OrderDraftSubmitLine[];
};

type PricingConfig = {
  customProductId: string;
  customProductLabel: string;
  menuSupplementLabel: string;
  getSupplementLabel?: (supplement: string, context: OrderDraftSupplementContext) => string;
  computeSupplementAmount: (
    basePrice: number,
    supplement: string,
    context: OrderDraftSupplementContext
  ) => number;
  shouldIncludeSupplementNote?: (
    basePrice: number,
    supplement: string,
    context: OrderDraftSupplementContext,
    supplementAmount: number
  ) => boolean;
};

type OrderDraftSupplementContext = {
  product: MenuProduct | null;
  isCustom: boolean;
};

export const roundMoney = (value: number) => Math.round(value * 100) / 100;
const getProductVariants = (product: MenuProduct | null | undefined) =>
  Array.isArray(product?.variants) ? product.variants : [];

const normalizeVatRate = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return Math.round(parsed * 1000) / 1000;
};

const resolveProductVatRate = (product: MenuProduct | null | undefined): number | null => {
  const source = product as
    | (MenuProduct & { iva?: unknown; taxRate?: unknown; vatRate?: unknown })
    | null
    | undefined;
  return normalizeVatRate(source?.vatRate ?? source?.iva ?? source?.taxRate);
};

const resolveProductVatCode = (product: MenuProduct | null | undefined): string | undefined => {
  const source = product as
    | (MenuProduct & { vatCode?: unknown; ivaCode?: unknown; taxCode?: unknown })
    | null
    | undefined;
  const value = String(source?.vatCode ?? source?.ivaCode ?? source?.taxCode ?? "").trim();
  return value || undefined;
};

export function createProductClientPriceSnapshot(product: MenuProduct) {
  return createClientPriceSnapshot(product);
}

export function restoreProductClientPriceSnapshot(value: unknown) {
  return normalizeClientPriceSnapshot(value);
}

export function refreshDraftPricingSnapshots<T extends OrderDraftPricingItem>(
  items: T[],
  productsById: ReadonlyMap<string, MenuProduct>,
  customProductId: string
): { items: T[]; changed: boolean } {
  let changed = false;
  const next = items.map((item) => {
    if (item.productId === customProductId) return item;
    const product = productsById.get(item.productId);
    if (!product) return item;
    const snapshot = createProductClientPriceSnapshot(product);
    if (
      item.clientPriceSnapshot &&
      item.clientPriceSnapshot.displayPrice === snapshot.displayPrice &&
      item.clientPriceSnapshot.basePrice === snapshot.basePrice &&
      item.clientPriceSnapshot.nextPriceChangeAt === snapshot.nextPriceChangeAt &&
      item.clientPriceSnapshot.activeScheduleLabel === snapshot.activeScheduleLabel
    ) {
      return item;
    }
    changed = true;
    return { ...item, clientPriceSnapshot: snapshot };
  });
  return { items: next, changed };
}

export function getDraftUnitBasePrice(
  item: OrderDraftPricingItem,
  productsById: ReadonlyMap<string, MenuProduct>,
  customProductId: string
) {
  if (item.productId === customProductId) {
    return Math.max(0, item.customPrice ?? 0);
  }
  const product = productsById.get(item.productId);
  const variant = getProductVariants(product).find((entry) => entry.id === item.variantId) ?? null;
  const displayPrice = product
    ? getProductDisplayPricing(product).displayPrice
    : (item.clientPriceSnapshot?.displayPrice ?? 0);
  return Math.max(0, displayPrice + (variant?.priceDelta ?? 0));
}

export function buildOrderDraftSubmit(
  items: OrderDraftPricingItem[],
  productsById: ReadonlyMap<string, MenuProduct>,
  config: PricingConfig
): { lines: OrderDraftSubmitLine[]; total: number; draftItemIds: string[] } {
  // Traccia parallela riga-inviata -> riga-carrello: serve a riportare sul
  // carrello la ripartizione della rettifica, che torna indicizzata per riga.
  // Sta fuori da OrderDraftSubmitLine per non finire nel payload verso il backend.
  const draftItemIds: string[] = [];
  const lines = items.reduce<OrderDraftSubmitLine[]>((acc, item) => {
    const isCustom = item.productId === config.customProductId;
    const product = isCustom ? null : productsById.get(item.productId);
    if (!isCustom && !product) return acc;
    const variant = product
      ? (getProductVariants(product).find((entry) => entry.id === item.variantId) ?? null)
      : null;
    const quantity = Math.max(1, Math.min(99, Math.round(Number(item.quantity) || 1)));
    const baseNote = item.note.trim();
    const menuBasePrice = isCustom
      ? Math.max(0, item.customPrice ?? 0)
      : Math.max(
          0,
          product
            ? getProductDisplayPricing(product).displayPrice
            : (item.clientPriceSnapshot?.displayPrice ?? 0)
        );
    const variantDelta = isCustom ? 0 : (variant?.priceDelta ?? 0);
    const priceWithVariant = menuBasePrice + variantDelta;
    const supplementContext: OrderDraftSupplementContext = { product: product ?? null, isCustom };
    const supplementAmount = config.computeSupplementAmount(
      priceWithVariant,
      item.supplement,
      supplementContext
    );
    const supplementLabel =
      config.getSupplementLabel?.(item.supplement, supplementContext).trim() ||
      config.menuSupplementLabel;
    const includeSupplementNote =
      item.supplement !== "none" &&
      (supplementAmount > 0 ||
        config.shouldIncludeSupplementNote?.(
          priceWithVariant,
          item.supplement,
          supplementContext,
          supplementAmount
        ) === true);
    const supplementNote = includeSupplementNote
      ? supplementAmount > 0
        ? `${supplementLabel} +${supplementAmount.toFixed(2)} EUR`
        : supplementLabel
      : "";
    const note = [baseNote, supplementNote].filter(Boolean).join(" | ");
    const name = isCustom
      ? item.customName?.trim() || config.customProductLabel
      : (product?.name ?? "Articolo");
    const unitFinalPrice = priceWithVariant + supplementAmount;
    const totalPriceDelta = unitFinalPrice - menuBasePrice;
    const priceChangeReason = isCustom
      ? ("manual" as const)
      : supplementAmount !== 0
        ? ("supplement" as const)
        : variant?.priceDelta
          ? ("variant" as const)
          : undefined;
    const priceChanged = isCustom || Math.abs(totalPriceDelta) > 0.0001;

    const clientPriceSnapshot = isCustom
      ? undefined
      : product
        ? createProductClientPriceSnapshot(product)
        : item.clientPriceSnapshot;
    const vatRate = resolveProductVatRate(product);
    const vatCode = resolveProductVatCode(product);

    draftItemIds.push(item.id ?? "");
    acc.push({
      productId: isCustom ? undefined : product?.id,
      name,
      qty: quantity,
      variantName: variant?.name || undefined,
      note: note || undefined,
      unitBasePrice: roundMoney(menuBasePrice),
      unitFinalPrice: roundMoney(unitFinalPrice),
      priceDelta: roundMoney(totalPriceDelta),
      priceChanged,
      priceChangeReason,
      ...(vatRate !== null ? { vatRate } : {}),
      ...(vatCode ? { vatCode } : {}),
      clientPriceSnapshot,
    });
    return acc;
  }, []);

  return {
    lines,
    draftItemIds,
    total: roundMoney(
      lines.reduce((sum, line) => sum + Math.max(0, line.unitFinalPrice ?? 0) * line.qty, 0)
    ),
  };
}
