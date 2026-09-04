import { splitMenuStationLabel } from "../utils/stationBadge";

export type MenuCategoryCount = {
  id: string;
  name: string;
  productCount: number;
};

type MenuCategoryListProps = {
  categories: MenuCategoryCount[];
  showStationBadges: boolean;
  onSelect: (categoryId: string) => void;
};

export function MenuCategoryList({
  categories,
  showStationBadges,
  onSelect,
}: MenuCategoryListProps) {
  return (
    <div className="menu-level-list">
      {categories.map((category) => {
        const stationBadge = showStationBadges ? splitMenuStationLabel(category.name) : null;
        return (
          <button
            key={category.id}
            type="button"
            className={`menu-level-card${stationBadge ? " has-mobile-menu-station-badge" : ""}`}
            data-mobile-menu-badge={stationBadge?.badgeLabel.toLowerCase()}
            onClick={() => onSelect(category.id)}
          >
            <span className="menu-level-name" title={stationBadge?.mainLabel}>
              {stationBadge?.mainLabel ?? category.name}
            </span>
            <span className="menu-level-count">{category.productCount} prodotti</span>
            {stationBadge ? (
              <span
                className="mobile-menu-level-station-badge"
                title={stationBadge.badgeLabel}
                aria-hidden="true"
                aria-label={stationBadge.badgeLabel}
              >
                {stationBadge.badgeLabel}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
