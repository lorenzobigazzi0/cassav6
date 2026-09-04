import type { MenuProduct } from "../../../../api/menu";
import {
  lineKeyForOrderService,
  type OrderCorrectionLineDraft,
  type OrderCorrectionPayload,
  type OrderReplacementSelection,
} from "../../../../api/orderServiceRecovery";
import type { DiningTableOrder } from "../../../../api/tables";
import { formatCurrency } from "../utils";
import type { GlassDropdownOption } from "./GlassDropdown";

export type ReplacementSelectionState = Record<string, { selected: boolean; quantity: number }>;

export type ReplacementLineDetails = {
  variant: string;
  additions: string[];
  note: string;
};

export type ServiceRecoveryProductIndex = Readonly<{
  byId: ReadonlyMap<string, MenuProduct>;
  byName: ReadonlyMap<string, MenuProduct>;
}>;

export const clampQuantity = (value: unknown, min: number, max: number, fallback: number) => {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

export const normalize = (value: unknown) => String(value == null ? "" : value).trim();

const lineUnitPrice = (line: DiningTableOrder["lines"][number]) =>
  Math.max(Number(line.unitFinalPrice ?? line.unitBasePrice ?? 0) || 0, 0);

export const lineTotalLabel = (line: DiningTableOrder["lines"][number], quantity: number) => {
  const unitPrice = lineUnitPrice(line);
  if (unitPrice <= 0) return "";
  return formatCurrency(unitPrice * Math.max(1, quantity));
};

export const replacementLineDetails = (
  line: DiningTableOrder["lines"][number]
): ReplacementLineDetails => ({
  variant: normalize(line.variantName),
  additions: Array.from(
    new Set(
      Object.entries(line.modifiers ?? {})
        .filter(([key, value]) => {
          const safeKey = normalize(key).toLowerCase();
          return safeKey && normalize(value) && !["label", "variante", "variant"].includes(safeKey);
        })
        .map(([, value]) => normalize(value))
    )
  ),
  note: normalize(line.note),
});

export const hasCorrectionDetails = (line: OrderCorrectionLineDraft) =>
  Boolean(
    normalize(line.originalVariant) ||
    Object.entries(line.originalModifiers).some(([key, value]) => {
      const safeKey = normalize(key).toLowerCase();
      return safeKey && normalize(value) && !["label", "variante", "variant"].includes(safeKey);
    }) ||
    normalize(line.originalNotes)
  );

export const withModifier = (modifiers: Record<string, string>, key: string, value: string) => {
  const next = { ...modifiers };
  const safeValue = normalize(value);
  if (safeValue) next[key] = safeValue;
  else delete next[key];
  return next;
};

export const replacementAvailableQuantity = (line: DiningTableOrder["lines"][number]) => {
  const available = line.serviceRecoveryAvailableQuantity;
  if (typeof available === "number" && Number.isFinite(available)) {
    return Math.max(0, Math.min(line.qty, Math.trunc(available)));
  }
  return clampQuantity(line.qty, 0, 99, 0);
};

export function defaultReplacementSelections(order: DiningTableOrder): ReplacementSelectionState {
  return Object.fromEntries(
    order.lines
      .filter((line) => replacementAvailableQuantity(line) > 0)
      .map((line, index) => [
        lineKeyForOrderService(line, index),
        { selected: false, quantity: replacementAvailableQuantity(line) },
      ])
  );
}

export function buildServiceRecoveryProductIndex(
  products: readonly MenuProduct[]
): ServiceRecoveryProductIndex {
  return {
    byId: new Map(
      products
        .map((product) => [normalize(product.id), product] as const)
        .filter(([id]) => Boolean(id))
    ),
    byName: new Map(
      products
        .map((product) => [normalize(product.name).toLowerCase(), product] as const)
        .filter(([name]) => Boolean(name))
    ),
  };
}

export function productForLine(
  line: OrderCorrectionLineDraft,
  products: ServiceRecoveryProductIndex
): MenuProduct | null {
  const productId = normalize(line.productId);
  if (productId && products.byId.has(productId)) return products.byId.get(productId) ?? null;
  const productName = normalize(line.productName).toLowerCase();
  return productName ? (products.byName.get(productName) ?? null) : null;
}

export function variantOptionsForLine(
  line: OrderCorrectionLineDraft,
  product: MenuProduct | null
): GlassDropdownOption[] {
  const current = normalize(line.nextVariant);
  const options: GlassDropdownOption[] = [{ value: "", label: "Nessuna variante" }];
  product?.variants.forEach((variant) => {
    options.push({
      value: variant.name,
      label:
        variant.priceDelta > 0
          ? `${variant.name} (+${variant.priceDelta.toFixed(2)} EUR)`
          : variant.name,
    });
  });
  if (current && !options.some((option) => option.value === current)) {
    options.unshift({ value: current, label: `Attuale: ${current}` });
  }
  return options;
}

export function selectedReplacementEntriesForLines(
  lines: readonly DiningTableOrder["lines"][number][],
  selections: ReplacementSelectionState
): OrderReplacementSelection[] {
  return lines
    .map<OrderReplacementSelection | null>((line, index) => {
      const lineKey = lineKeyForOrderService(line, index);
      const selection = selections[lineKey];
      if (!selection?.selected) return null;
      return {
        lineKey,
        lineId: line.lineId,
        productId: line.productId,
        productName: line.name,
        quantity: clampQuantity(selection.quantity, 1, clampQuantity(line.qty, 1, 99, 1), 1),
      };
    })
    .filter((entry): entry is OrderReplacementSelection => entry !== null);
}

export function correctionPayloadForOrder(
  lineDrafts: OrderCorrectionLineDraft[],
  orderNote: string | undefined,
  orderComment: string | undefined,
  reason: string
): OrderCorrectionPayload {
  return {
    lineDrafts,
    addedItems: [],
    orderNote: orderNote ?? "",
    orderComment: orderComment ?? "",
    reason,
  };
}
