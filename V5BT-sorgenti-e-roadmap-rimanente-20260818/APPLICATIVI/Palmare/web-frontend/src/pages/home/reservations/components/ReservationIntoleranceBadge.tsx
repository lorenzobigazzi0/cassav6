import { memo, useMemo } from "react";
import { parseIntoleranceTokens } from "../../../../utils/intoleranceTokens";
import { AllergenIcon } from "./ReservationIcons";

type ReservationIntoleranceBadgeProps = {
  value: string;
};

export const ReservationIntoleranceBadge = memo(function ReservationIntoleranceBadge({
  value,
}: ReservationIntoleranceBadgeProps) {
  const tokens = useMemo(() => parseIntoleranceTokens(value), [value]);
  if (tokens.length === 0) return null;

  const extraCount = tokens.length - 1;
  const label =
    tokens.length === 1
      ? `Allergia o intolleranza: ${tokens[0]}`
      : `Allergie e intolleranze: ${tokens.join(", ")}`;

  return (
    <span className="reservations-intolerance-badge" title={label} aria-label={label} role="img">
      <AllergenIcon allergen={tokens[0]} />
      {extraCount > 0 ? (
        <span className="reservations-intolerance-badge-count">+{extraCount}</span>
      ) : null}
    </span>
  );
});
