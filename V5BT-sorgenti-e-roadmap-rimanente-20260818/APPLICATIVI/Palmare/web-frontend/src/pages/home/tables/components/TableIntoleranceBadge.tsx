import type { DiningTable } from "../../../../api/tables";
import { AllergenIcon } from "../../../../shared/allergens/AllergenIcon";
import { collectIntoleranceTokens } from "../../../../utils/intoleranceTokens";

type TableIntoleranceBadgeProps = {
  table: Pick<DiningTable, "allergens" | "manualIntolerance">;
};

export function TableIntoleranceBadge({ table }: TableIntoleranceBadgeProps) {
  const tokens = collectIntoleranceTokens(table.allergens, table.manualIntolerance);
  if (tokens.length === 0) return null;

  const extraCount = tokens.length - 1;
  const label =
    tokens.length === 1
      ? `Allergia o intolleranza: ${tokens[0]}`
      : `Allergie e intolleranze: ${tokens.join(", ")}`;

  return (
    <span
      className="table-meta-pill table-intolerance-badge"
      title={label}
      aria-label={label}
      role="img"
    >
      <AllergenIcon
        allergen={tokens[0]}
        className="table-intolerance-icon table-detail-allergen-icon"
      />
      {extraCount > 0 ? <span className="table-intolerance-badge-count">+{extraCount}</span> : null}
    </span>
  );
}
