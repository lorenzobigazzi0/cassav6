import { useEffect, useRef, useState } from "react";
import type { MenuAvailabilityState } from "../../../../shared/menu/productAvailability";

export type MenuFilterAllergenOption = {
  id: string;
  name: string;
  count: number;
};

export type MenuFilterAvailabilityOption = {
  id: MenuAvailabilityState;
  name: string;
  count: number;
};

type MenuFilterBarProps = {
  query: string;
  onQueryChange: (value: string) => void;
  filterOpen: boolean;
  onToggleFilter: () => void;
  onCloseFilter: () => void;
  allergens: MenuFilterAllergenOption[];
  excludedAllergens: string[];
  availability: MenuFilterAvailabilityOption[];
  hiddenAvailability: MenuAvailabilityState[];
  searchInIngredients: boolean;
  onApplyExcludedAllergens: (allergens: string[]) => void;
  onApplyHiddenAvailability: (states: MenuAvailabilityState[]) => void;
  onApplySearchInIngredients: (value: boolean) => void;
  onReset: () => void;
};

const toSortedArray = (items: Set<string>) => Array.from(items).sort((a, b) => a.localeCompare(b));

export function MenuFilterBar({
  query,
  onQueryChange,
  filterOpen,
  onToggleFilter,
  onCloseFilter,
  allergens,
  excludedAllergens,
  availability,
  hiddenAvailability,
  searchInIngredients,
  onApplyExcludedAllergens,
  onApplyHiddenAvailability,
  onApplySearchInIngredients,
  onReset,
}: MenuFilterBarProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [draftExcluded, setDraftExcluded] = useState<Set<string>>(new Set());
  const [draftHiddenAvailability, setDraftHiddenAvailability] = useState<
    Set<MenuAvailabilityState>
  >(new Set());
  const [draftSearchInIngredients, setDraftSearchInIngredients] = useState(false);
  const excludedAllergensKey = excludedAllergens.join("|");
  const hiddenAvailabilityKey = hiddenAvailability.join("|");

  const selectedAllergens = draftExcluded.size;
  const shownAvailability = availability.length - draftHiddenAvailability.size;
  const hasActiveFilters =
    selectedAllergens > 0 || draftSearchInIngredients || draftHiddenAvailability.size > 0;
  const totalActive = excludedAllergens.length + hiddenAvailability.length;

  useEffect(() => {
    if (!filterOpen) return;
    setDraftExcluded(new Set(excludedAllergens));
    setDraftHiddenAvailability(new Set(hiddenAvailability));
    setDraftSearchInIngredients(searchInIngredients);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterOpen, excludedAllergensKey, hiddenAvailabilityKey, searchInIngredients]);

  useEffect(() => {
    if (!filterOpen) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      onCloseFilter();
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onCloseFilter();
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [filterOpen, onCloseFilter]);

  const toggleDraftAllergen = (allergenId: string) => {
    setDraftExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(allergenId)) next.delete(allergenId);
      else next.add(allergenId);
      return next;
    });
  };

  const toggleDraftAvailability = (state: MenuAvailabilityState) => {
    setDraftHiddenAvailability((prev) => {
      const next = new Set(prev);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });
  };

  const applyAndClose = () => {
    onApplyExcludedAllergens(toSortedArray(draftExcluded));
    onApplyHiddenAvailability(Array.from(draftHiddenAvailability));
    onApplySearchInIngredients(draftSearchInIngredients);
    onCloseFilter();
  };

  const resetFilters = () => {
    setDraftExcluded(new Set());
    setDraftHiddenAvailability(new Set());
    setDraftSearchInIngredients(false);
    onReset();
  };

  return (
    <div className="menu-filter-wrap" ref={rootRef}>
      <div className="menu-toolbar">
        <label className="menu-search" aria-label="Ricerca prodotti">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Cerca prodotti..."
          />
        </label>

        <button
          className={`menu-filter-btn ${filterOpen ? "is-open" : ""}`}
          type="button"
          onClick={onToggleFilter}
          aria-expanded={filterOpen}
          aria-label="Apri filtri"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 6h16" />
            <path d="M7 12h10" />
            <path d="M10 18h4" />
          </svg>
          {totalActive > 0 && <span className="menu-filter-btn-count">{totalActive}</span>}
        </button>
      </div>

      {filterOpen && (
        <div className="menu-filter-dropdown">
          <div className="menu-filter-panel" role="dialog" aria-label="Filtri menu">
            <div className="menu-filter-panel-head">
              <div className="menu-filter-panel-title">Filtri</div>
              <div className="menu-filter-summary">
                <span className={`menu-summary-pill ${selectedAllergens > 0 ? "is-active" : ""}`}>
                  Allergeni esclusi: {selectedAllergens}
                </span>
                <span
                  className={`menu-summary-pill ${
                    draftHiddenAvailability.size > 0 ? "is-active" : ""
                  }`}
                >
                  Disponibilita: {shownAvailability}/{availability.length}
                </span>
                <span
                  className={`menu-summary-pill ${draftSearchInIngredients ? "is-active" : ""}`}
                >
                  Ricerca ingredienti: {draftSearchInIngredients ? "on" : "off"}
                </span>
              </div>
            </div>

            <div className="menu-filter-row">
              <div className="menu-filter-title">Disponibilita (mostra)</div>
              <div className="menu-filter-grid menu-filter-grid-availability">
                {availability.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`menu-filter-chip menu-availability-chip availability-${option.id} ${
                      draftHiddenAvailability.has(option.id) ? "is-off" : "is-shown"
                    }`}
                    onClick={() => toggleDraftAvailability(option.id)}
                    aria-pressed={!draftHiddenAvailability.has(option.id)}
                  >
                    <span className="menu-filter-chip-dot" aria-hidden="true" />
                    <span className="menu-filter-chip-label">{option.name}</span>
                    <span className="menu-filter-chip-count">{option.count}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="menu-filter-toggle-row">
              <span className="menu-filter-toggle-label">Cerca anche negli ingredienti</span>
              <button
                type="button"
                className={`menu-filter-toggle ${draftSearchInIngredients ? "is-on" : ""}`}
                onClick={() => setDraftSearchInIngredients((prev) => !prev)}
                aria-pressed={draftSearchInIngredients}
              >
                <span className="menu-filter-toggle-knob" />
              </button>
            </div>

            <div className="menu-filter-row">
              <div className="menu-filter-title">Allergeni (escludi)</div>
              <div className="menu-filter-grid">
                {allergens.map((allergen) => (
                  <button
                    key={allergen.id}
                    type="button"
                    className={`menu-filter-chip ${draftExcluded.has(allergen.id) ? "is-active" : ""}`}
                    onClick={() => toggleDraftAllergen(allergen.id)}
                  >
                    <span className="menu-filter-chip-label">{allergen.name}</span>
                    <span className="menu-filter-chip-count">{allergen.count}</span>
                  </button>
                ))}
              </div>
              {allergens.length === 0 && (
                <div className="menu-filter-empty">
                  Nessun allergene disponibile con i filtri correnti.
                </div>
              )}
            </div>

            {hasActiveFilters && (
              <div className="menu-filter-footer">
                <button className="menu-reset-btn is-danger" type="button" onClick={resetFilters}>
                  Reset
                </button>
                <button className="menu-apply-btn" type="button" onClick={applyAndClose}>
                  Applica
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
