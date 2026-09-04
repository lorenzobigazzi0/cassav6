type MenuFeatureBadgeProps = {
  type: "frozen" | "allergens" | "variants";
};

const LABELS: Record<MenuFeatureBadgeProps["type"], string> = {
  frozen: "Congelato",
  allergens: "Allergeni",
  variants: "Varianti",
};

export function MenuFeatureBadge({ type }: MenuFeatureBadgeProps) {
  return (
    <span
      className={`menu-feature-badge is-${type}`}
      title={LABELS[type]}
      aria-label={LABELS[type]}
    >
      {type === "frozen" && (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3v18" />
          <path d="M4.5 7.5L19.5 16.5" />
          <path d="M4.5 16.5L19.5 7.5" />
          <path d="M12 3l2 2" />
          <path d="M12 3l-2 2" />
          <path d="M12 21l2-2" />
          <path d="M12 21l-2-2" />
        </svg>
      )}
      {type === "allergens" && (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3l9 16H3z" />
          <path d="M12 9v5" />
          <path d="M12 18h.01" />
        </svg>
      )}
      {type === "variants" && (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h12v12H4z" />
          <path d="M8 3h12v12H8z" />
        </svg>
      )}
    </span>
  );
}
