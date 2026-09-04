import { useMemo, useState } from "react";
import { AllergenIcon } from "../../../../shared/allergens/AllergenIcon";
import { MAX_TABLE_COVERS } from "../../../../domain/tables/capacity";
import { parseIntoleranceTokens } from "../../../../utils/intoleranceTokens";
import { TableAllergyDialog } from "./TableAllergyDialog";

type TableDetailAnagraphicFieldsProps = {
  draftName: string;
  draftPhone: string;
  draftCovers: string;
  draftNote: string;
  hasAllergyAlert: boolean;
  selectedAllergens: string[];
  draftManualIntolerance: string;
  allergenOptions: readonly string[];
  showReservationFields: boolean;
  showPhoneField: boolean;
  reservationTime: string;
  busy: boolean;
  onChangeName: (value: string) => void;
  onChangePhone: (value: string) => void;
  onChangeCovers: (value: string) => void;
  onChangeNote: (value: string) => void;
  onCommitAllergies: (allergens: string[], manualIntolerance: string) => void;
  onChangeReservationTime: (value: string) => void;
};

const RequiredMark = () => (
  <em className="table-detail-required-mark" aria-hidden="true">
    *
  </em>
);

const TableAllergenIcon = ({ allergen }: { allergen?: string }) => (
  <AllergenIcon allergen={allergen} className="table-detail-allergen-icon" />
);

const TableAllergenLabel = ({ children }: { children: string }) => (
  <span className="table-detail-allergen-label">{children}</span>
);

export function TableDetailAnagraphicFields({
  draftName,
  draftPhone,
  draftCovers,
  draftNote,
  hasAllergyAlert,
  selectedAllergens,
  draftManualIntolerance,
  allergenOptions,
  showReservationFields,
  showPhoneField,
  reservationTime,
  busy,
  onChangeName,
  onChangePhone,
  onChangeCovers,
  onChangeNote,
  onCommitAllergies,
  onChangeReservationTime,
}: TableDetailAnagraphicFieldsProps) {
  const [allergyDialogOpen, setAllergyDialogOpen] = useState(false);
  const manualIntolerances = useMemo(
    () => parseIntoleranceTokens(draftManualIntolerance),
    [draftManualIntolerance]
  );
  const allergyPreviewItems = useMemo(() => {
    const items = selectedAllergens.map((entry) => entry.trim()).filter(Boolean);
    items.push(...manualIntolerances);
    return items.slice(0, 6);
  }, [manualIntolerances, selectedAllergens]);

  return (
    <>
      <div
        className={`table-detail-form-grid ${showReservationFields ? "has-reservation-time" : ""}`}
      >
        <label className="table-detail-field table-detail-field-span">
          <span>
            {showReservationFields ? "NOME" : "NOME TAVOLO"}
            {showReservationFields ? <RequiredMark /> : null}
          </span>
          <input
            type="text"
            value={draftName}
            maxLength={16}
            onChange={(event) => onChangeName(event.target.value)}
            placeholder={showReservationFields ? "Nome prenotazione" : "Opzionale"}
            disabled={busy}
          />
        </label>

        {showPhoneField && (
          <label className="table-detail-field table-detail-field-phone">
            <span>
              TELEFONO
              {showReservationFields ? <RequiredMark /> : null}
            </span>
            <input
              type="text"
              value={draftPhone}
              maxLength={24}
              onChange={(event) => onChangePhone(event.target.value)}
              placeholder={showReservationFields ? "+39..." : "Facoltativo"}
              disabled={busy}
            />
          </label>
        )}

        <label className="table-detail-field table-detail-field-covers">
          <span>
            COPERTI
            <RequiredMark />
          </span>
          <input
            type="number"
            min={1}
            max={MAX_TABLE_COVERS}
            value={draftCovers}
            onChange={(event) => onChangeCovers(event.target.value)}
            disabled={busy}
          />
        </label>

        {showReservationFields && (
          <label className="table-detail-field table-detail-field-time">
            <span>
              ORARIO ARRIVO
              <RequiredMark />
            </span>
            <input
              type="time"
              value={reservationTime}
              onChange={(event) => onChangeReservationTime(event.target.value)}
              disabled={busy}
            />
          </label>
        )}
      </div>

      <label className="table-detail-field">
        <span>NOTE</span>
        <textarea
          value={draftNote}
          rows={3}
          maxLength={240}
          onChange={(event) => onChangeNote(event.target.value)}
          disabled={busy}
        />
      </label>

      <div className={`table-detail-allergy ${hasAllergyAlert ? "has-intolerances" : ""}`}>
        <div className="table-detail-allergy-head">
          <span className="table-detail-check-label">
            <TableAllergenIcon />
            <TableAllergenLabel>ALLERGIE / INTOLLERANZE</TableAllergenLabel>
          </span>
          <button
            type="button"
            className="table-detail-allergy-toggle"
            onClick={() => setAllergyDialogOpen(true)}
            disabled={busy}
            aria-label="Modifica allergie e intolleranze"
            title="Modifica allergie e intolleranze"
          >
            <svg viewBox="0 0 24 24" className="table-detail-allergy-pencil" aria-hidden="true">
              <path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z" />
              <path d="M13.5 6.5l4 4" />
            </svg>
          </button>
        </div>

        {allergyPreviewItems.length > 0 && (
          <div className="table-detail-allergy-preview" aria-hidden="true">
            {allergyPreviewItems.map((item, index) => (
              <span key={`${item}-${index}`} className="table-detail-allergy-preview-item">
                <TableAllergenIcon allergen={item} />
                <TableAllergenLabel>{item}</TableAllergenLabel>
              </span>
            ))}
          </div>
        )}

      </div>
      <TableAllergyDialog
        open={allergyDialogOpen}
        allergenOptions={allergenOptions}
        selectedAllergens={selectedAllergens}
        manualIntolerance={draftManualIntolerance}
        busy={busy}
        onCancel={() => setAllergyDialogOpen(false)}
        onConfirm={(allergens, manuale) => {
          onCommitAllergies(allergens, manuale);
          setAllergyDialogOpen(false);
        }}
      />
    </>
  );
}
