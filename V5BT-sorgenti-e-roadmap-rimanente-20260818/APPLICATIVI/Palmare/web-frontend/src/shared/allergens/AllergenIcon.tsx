import { normalizeAllergenLabel } from "../../domain/allergens";

export const ALLERGEN_ICON_SRC_BY_LABEL: Record<string, string> = {
  Glutine: "/mobile/assets/allergen-glutine.png",
  Crostacei: "/mobile/assets/allergen-crostacei.png",
  Uova: "/mobile/assets/allergen-uova.png",
  Pesce: "/mobile/assets/allergen-pesce.png",
  Arachidi: "/mobile/assets/allergen-arachidi.png",
  Soia: "/mobile/assets/allergen-soia.png",
  Latte: "/mobile/assets/allergen-latte.png",
  "Frutta a guscio": "/mobile/assets/allergen-frutta-a-guscio.png",
  Sedano: "/mobile/assets/allergen-sedano.png",
  Senape: "/mobile/assets/allergen-senape.png",
  "Semi di sesamo": "/mobile/assets/allergen-sesamo.png",
  Solfiti: "/mobile/assets/allergen-solfiti.png",
  Lupini: "/mobile/assets/allergen-lupini.png",
  Molluschi: "/mobile/assets/allergen-molluschi.png",
};

export function getAllergenIconSrc(allergen?: string | null) {
  const label = normalizeAllergenLabel(String(allergen ?? ""));
  return label ? (ALLERGEN_ICON_SRC_BY_LABEL[label] ?? null) : null;
}

type AllergenIconProps = {
  allergen?: string | null;
  className?: string;
};

export function AllergenIcon({
  allergen,
  className = "table-detail-allergen-icon",
}: AllergenIconProps) {
  const src = getAllergenIconSrc(allergen);
  if (src) {
    return <img className={className} src={src} alt="" aria-hidden="true" draggable={false} />;
  }

  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l7 4v6c0 4.6-3 7-7 8-4-1-7-3.4-7-8V7z" />
      <path d="M12 7v6" />
      <path d="M12 16h.01" />
    </svg>
  );
}
