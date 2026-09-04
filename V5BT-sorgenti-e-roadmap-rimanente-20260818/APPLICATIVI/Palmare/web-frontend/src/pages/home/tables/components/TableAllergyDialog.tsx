import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AllergenIcon } from "../../../../shared/allergens/AllergenIcon";
import { composeIntoleranceTokens, parseIntoleranceTokens } from "../../../../utils/intoleranceTokens";
import { TableAllergyRemovalDialog } from "./TableAllergyRemovalDialog";

type TableAllergyDialogProps = {
  open: boolean;
  allergenOptions: readonly string[];
  selectedAllergens: string[];
  manualIntolerance: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (allergens: string[], manualIntolerance: string) => void;
};

const DialogAllergenIcon = ({ allergen }: { allergen?: string }) => (
  <AllergenIcon allergen={allergen} className="table-detail-allergen-icon" />
);

/**
 * Scelta di allergie e intolleranze, in una modale.
 *
 * Le modifiche sono **provvisorie** finche non si conferma: la modale tiene una
 * propria copia della selezione e la restituisce solo su CONFERMA. Altrimenti
 * "annulla" non avrebbe nulla da annullare.
 *
 * La copia si riallinea a ogni apertura, cosi riaprire dopo un annullamento non
 * mostra lo scarto della volta prima.
 *
 * Dallo sfondo **non** si esce: si chiude solo con X o ANNULLA. Su una modale
 * che raccoglie scelte, un tocco fuori le farebbe perdere senza dirlo.
 */
export function TableAllergyDialog({
  open,
  allergenOptions,
  selectedAllergens,
  manualIntolerance,
  busy,
  onCancel,
  onConfirm,
}: TableAllergyDialogProps) {
  const [draftAllergens, setDraftAllergens] = useState<string[]>(selectedAllergens);
  const [draftManual, setDraftManual] = useState(manualIntolerance);
  const [manualInput, setManualInput] = useState("");
  // La conferma di rimozione resta: era stata chiesta e non e ridondante,
  // perche l'elenco puo essere lungo e la × sta accanto all'etichetta.
  const [daRimuovere, setDaRimuovere] = useState<{ index: number; label: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraftAllergens(selectedAllergens);
    setDraftManual(manualIntolerance);
    setManualInput("");
    setDaRimuovere(null);
  }, [manualIntolerance, open, selectedAllergens]);

  const manualList = useMemo(() => parseIntoleranceTokens(draftManual), [draftManual]);
  const normalizedManual = useMemo(() => composeIntoleranceTokens(manualList), [manualList]);
  const manualCandidate = useMemo(
    () => composeIntoleranceTokens([...manualList, manualInput]),
    [manualInput, manualList]
  );
  const canAddManual =
    Boolean(manualInput.trim()) &&
    manualCandidate !== normalizedManual &&
    manualCandidate.length <= 64;
  const remainingCharacters = Math.max(
    0,
    64 - normalizedManual.length - (normalizedManual ? 2 : 0)
  );

  if (!open || typeof document === "undefined") return null;

  const toggleAllergen = (allergen: string) => {
    setDraftAllergens((prev) =>
      prev.includes(allergen) ? prev.filter((entry) => entry !== allergen) : [...prev, allergen]
    );
  };

  const addManual = () => {
    if (!canAddManual) return;
    setDraftManual(manualCandidate);
    setManualInput("");
  };

  const removeManual = (indexToRemove: number) => {
    setDraftManual(
      composeIntoleranceTokens(manualList.filter((_, index) => index !== indexToRemove))
    );
  };

  return createPortal(
    <div
      className="tables-move-confirm-backdrop table-allergy-dialog-backdrop"
      role="presentation"
    >
      <section
        className="tables-move-confirm-card table-allergy-dialog-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="table-allergy-dialog-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onCancel();
        }}
      >
        <div className="table-allergy-dialog-head">
          <div id="table-allergy-dialog-title" className="tables-move-confirm-title">
            ALLERGIE / INTOLLERANZE
          </div>
          <button
            type="button"
            className="smallbtn table-allergy-dialog-close"
            onClick={onCancel}
            disabled={busy}
            aria-label="Chiudi allergie e intolleranze"
            title="Chiudi"
          >
            ×
          </button>
        </div>

        <div className="tables-move-confirm-body table-allergy-dialog-body">
          <div className="table-detail-allergen-grid">
            {allergenOptions.map((allergen) => (
              <button
                key={allergen}
                type="button"
                className={`table-allergen-chip ${
                  draftAllergens.includes(allergen) ? "is-active" : ""
                }`}
                onClick={() => toggleAllergen(allergen)}
                disabled={busy}
              >
                <DialogAllergenIcon allergen={allergen} />
                <span className="table-detail-allergen-label">{allergen}</span>
              </button>
            ))}
            {manualList.map((intolerance, index) => (
              <div
                key={`${intolerance}-${index}`}
                className="table-allergen-chip table-allergen-chip-manual"
              >
                <DialogAllergenIcon allergen={intolerance} />
                <span className="table-detail-allergen-label">{intolerance}</span>
                <button
                  type="button"
                  className="table-allergen-chip-remove"
                  onClick={() => setDaRimuovere({ index, label: intolerance })}
                  disabled={busy}
                  aria-label={`Rimuovi ${intolerance}`}
                  title={`Rimuovi ${intolerance}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <label className="table-detail-field">
            <span>
              <DialogAllergenIcon />
              <span className="table-detail-allergen-label">
                INTOLLERANZA MANUALE (ES. NICKEL)
              </span>
            </span>
            <span className="table-detail-manual-intolerance-entry">
              <input
                type="text"
                value={manualInput}
                maxLength={remainingCharacters}
                onChange={(event) => setManualInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addManual();
                }}
                disabled={busy || remainingCharacters === 0}
              />
              <button
                type="button"
                className="table-detail-manual-intolerance-add"
                onClick={addManual}
                disabled={busy || !canAddManual}
                aria-label="Aggiungi allergia o intolleranza manuale"
                title="Aggiungi"
              >
                +
              </button>
            </span>
          </label>
        </div>

        <div className="tables-move-confirm-actions">
          <button
            type="button"
            className="smallbtn tables-move-confirm-btn is-cancel"
            onClick={onCancel}
            disabled={busy}
          >
            ANNULLA
          </button>
          <button
            type="button"
            className="smallbtn tables-move-confirm-btn table-allergy-dialog-confirm"
            onClick={() => onConfirm(draftAllergens, normalizedManual)}
            disabled={busy}
          >
            CONFERMA
          </button>
        </div>

        <TableAllergyRemovalDialog
          intolerance={daRimuovere?.label ?? null}
          busy={busy}
          onCancel={() => setDaRimuovere(null)}
          onConfirm={() => {
            if (!daRimuovere) return;
            removeManual(daRimuovere.index);
            setDaRimuovere(null);
          }}
        />
      </section>
    </div>,
    document.body
  );
}
