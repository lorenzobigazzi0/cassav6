import type { MenuProduct } from "../../api/menu";

export type MenuProductSectionEntry =
  | { kind: "section"; id: string; name: string }
  | { kind: "product"; product: MenuProduct };

export const getMenuProductSection = (product: MenuProduct) =>
  String(
    (
      product as MenuProduct & {
        section?: string | null;
        subcategory?: string | null;
      }
    ).section ??
      (
        product as MenuProduct & {
          section?: string | null;
          subcategory?: string | null;
        }
      ).subcategory ??
      ""
  ).trim();

const sectionKey = (section: string) => section.toLocaleLowerCase("it-IT");

export function sortMenuProductsBySection(
  products: readonly MenuProduct[],
  catalogOrder: readonly MenuProduct[]
) {
  const sectionRanks = new Map<string, number>();
  catalogOrder.forEach((product) => {
    const section = getMenuProductSection(product);
    if (!section) return;
    const key = sectionKey(section);
    if (!sectionRanks.has(key)) sectionRanks.set(key, sectionRanks.size);
  });

  return [...products].sort((left, right) => {
    const leftSection = getMenuProductSection(left);
    const rightSection = getMenuProductSection(right);
    const leftRank = leftSection
      ? (sectionRanks.get(sectionKey(leftSection)) ?? Number.MAX_SAFE_INTEGER - 1)
      : Number.MAX_SAFE_INTEGER;
    const rightRank = rightSection
      ? (sectionRanks.get(sectionKey(rightSection)) ?? Number.MAX_SAFE_INTEGER - 1)
      : Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (leftSection !== rightSection) return leftSection.localeCompare(rightSection, "it");
    return left.name.localeCompare(right.name, "it");
  });
}

export function buildMenuProductSectionEntries(
  products: readonly MenuProduct[],
  showDividers: boolean
): MenuProductSectionEntry[] {
  if (!showDividers) {
    return products.map((product) => ({ kind: "product", product }));
  }

  const entries: MenuProductSectionEntry[] = [];
  let previousSection = "";
  products.forEach((product) => {
    const section = getMenuProductSection(product);
    if (section && section !== previousSection) {
      entries.push({ kind: "section", id: `section:${sectionKey(section)}`, name: section });
    }
    entries.push({ kind: "product", product });
    previousSection = section;
  });
  return entries;
}
