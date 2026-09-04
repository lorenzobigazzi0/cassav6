import type { DiningReservation, TableAvailabilityInfo } from "../../../api/reservations";
import type { DiningTable } from "../../../api/tables";
import { AllergenIcon } from "../../../shared/allergens/AllergenIcon";
import { ReservationCustomIntoleranceModal } from "./components/ReservationCustomIntoleranceModal";
import { ReservationActionIcon, ReservationSaveIcon } from "./components/ReservationIcons";
import {
  HACCP_INTOLERANCE_OPTIONS,
  reservationLabel,
  statusClassByColor,
  statusLegendLabel,
  toClockTime,
  type ReservationEditorStatus,
  type ReservationFormState,
} from "./reservationEditorSupport";
import { MAX_TABLE_COVERS } from "../../../domain/tables/capacity";
import { GlassDropdown } from "../tables/components/GlassDropdown";
import type { ReservationStatusColor } from "../../../api/reservations";


type TableWindowHint = { tone: string; label: string; detail: string };

export type ReservationEditorScreenProps = {
  mode: "view" | "edit" | "create";
  isAssignTableScreen: boolean;
  isIntoleranceScreen: boolean;
  actionBusy: boolean;
  form: ReservationFormState;
  selectedReservation: DiningReservation | null;
  tableItems: { id: string; number: number }[];
  tableById: Map<string, DiningTable>;
  tableLegend: { status: ReservationStatusColor; label: string }[];
  tableWindowHints: Map<string, TableWindowHint>;
  availabilityByTableId: Map<string, TableAvailabilityInfo>;
  selectedTableLabel: string;
  intoleranceTokens: string[];
  customIntoleranceTokens: string[];
  customIntoleranceDraft: string;
  customIntoleranceModalOpen: boolean;
  reservationStatusDropdownOptions: { value: string; label: string }[];
  onSelectTable: (tableId: string) => void;
  togglePresetIntolerance: (entry: string) => void;
  addCustomIntolerance: () => void;
  removeCustomIntolerance: (entry: string) => void;
  cancelEditor: () => void;
  onSave: () => void;
  setAssignTableOpen: (open: boolean) => void;
  setIntoleranceEditorOpen: (open: boolean) => void;
  setCustomIntoleranceDraft: (value: string) => void;
  setCustomIntoleranceModalOpen: (open: boolean) => void;
  setForm: (updater: (prev: ReservationFormState) => ReservationFormState) => void;
  setDialog: (dialog: { type: "delete"; reservationLabel: string } | null) => void;
};

/**
 * Schermata di modifica della prenotazione: assegnazione tavoli, intolleranze e
 * form. Estratta dal workspace per poter essere aperta anche dal tavolo.
 */
export function ReservationEditorScreen({
  mode,
  isAssignTableScreen,
  isIntoleranceScreen,
  actionBusy,
  form,
  selectedReservation,
  tableItems,
  tableById,
  tableLegend,
  tableWindowHints,
  availabilityByTableId,
  selectedTableLabel,
  intoleranceTokens,
  customIntoleranceTokens,
  customIntoleranceDraft,
  customIntoleranceModalOpen,
  reservationStatusDropdownOptions,
  onSelectTable,
  togglePresetIntolerance,
  addCustomIntolerance,
  removeCustomIntolerance,
  cancelEditor,
  onSave,
  setAssignTableOpen,
  setIntoleranceEditorOpen,
  setCustomIntoleranceDraft,
  setCustomIntoleranceModalOpen,
  setForm,
  setDialog,
}: ReservationEditorScreenProps) {
  return isAssignTableScreen ? (
                    <>
                      <div className="reservations-detail-head">
                        <div className="reservations-detail-title">Assegna tavolo</div>
                        <div className="reservations-detail-actions">
                          <button
                            type="button"
                            className="smallbtn reservations-icon-btn is-close"
                            onClick={() => setAssignTableOpen(false)}
                            disabled={actionBusy}
                            aria-label="Chiudi assegnazione tavolo"
                            title="Chiudi"
                          >
                            X
                          </button>
                        </div>
                      </div>

                      <div className="reservations-table-box reservations-table-page">
                        <div className="reservations-table-box-head">
                          <strong>Tavoli assegnati: {selectedTableLabel}</strong>
                        </div>
                        <div className="reservations-table-legend">
                          {tableLegend.map((entry) => (
                            <div key={entry.status} className="reservations-table-legend-item">
                              <span
                                className={`reservations-dot ${statusClassByColor[entry.status]}`}
                              />
                              <span>{entry.label}</span>
                            </div>
                          ))}
                        </div>
                        <div className="reservations-window-rule">
                          Le prenotazioni future restano utilizzabili fino a 30 minuti prima; dentro
                          la finestra il tavolo libero passa prenotato, se occupato viene richiesto
                          l'avviso di rilascio entro 10 minuti.
                        </div>
                        <div className="reservations-table-grid">
                          {tableItems.map((table) => {
                            const availability = availabilityByTableId.get(table.id);
                            const status = availability?.status ?? "free";
                            const isSelected = form.assignedTableIds.includes(table.id);
                            const nearest = availability?.nearestReservation;
                            const operationalHint = tableWindowHints.get(table.id);
                            const tableState = tableById.get(table.id);
                            return (
                              <button
                                key={table.id}
                                type="button"
                                className={`reservations-table-tile ${statusClassByColor[status]} ${
                                  isSelected ? "is-selected" : ""
                                } ${operationalHint ? `has-window-${operationalHint.tone}` : ""}`}
                                onClick={() => onSelectTable(table.id)}
                              >
                                <div className="reservations-table-number">T{table.number}</div>
                                <div className="reservations-table-status">
                                  {statusLegendLabel[status]}
                                </div>
                                {tableState?.occupancyState === "seated" ? (
                                  <div className="reservations-table-note">Occupato ora</div>
                                ) : null}
                                {nearest &&
                                (status === "warning" ||
                                  status === "danger" ||
                                  status === "conflict") ? (
                                  <div className="reservations-table-note">
                                    {nearest.customerName} {toClockTime(nearest.reservationAt)}
                                  </div>
                                ) : null}
                                {operationalHint ? (
                                  <div
                                    className={`reservations-table-window-badge is-window-${operationalHint.tone}`}
                                    title={operationalHint.detail}
                                  >
                                    {operationalHint.label}
                                  </div>
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="reservations-assign-page-actions is-confirm-only">
                        <button
                          type="button"
                          className="smallbtn primary"
                          onClick={() => {
                            setAssignTableOpen(false);
                            setIntoleranceEditorOpen(false);
                          }}
                          disabled={actionBusy}
                        >
                          Conferma tavolo
                        </button>
                      </div>
                    </>
                  ) : isIntoleranceScreen ? (
                    <>
                      <div className="reservations-detail-head">
                        <div className="reservations-detail-title reservations-title-with-icon">
                          <AllergenIcon allergen={intoleranceTokens[0]} />
                          Intolleranze
                        </div>
                        <div className="reservations-detail-actions">
                          <button
                            type="button"
                            className="smallbtn reservations-icon-btn is-close"
                            onClick={() => {
                              setCustomIntoleranceModalOpen(false);
                              setIntoleranceEditorOpen(false);
                            }}
                            disabled={actionBusy}
                            aria-label="Chiudi intolleranze"
                            title="Chiudi"
                          >
                            X
                          </button>
                        </div>
                      </div>

                      <div className="reservations-intolerance-page">
                        <div className="reservations-intolerance-picker">
                          <span className="reservations-intolerance-title">
                            <AllergenIcon />
                            Intolleranze (HACCP)
                          </span>
                          <div className="reservations-intolerance-grid">
                            {HACCP_INTOLERANCE_OPTIONS.map((option) => {
                              const active = intoleranceTokens.some(
                                (token) => token.toLowerCase() === option.toLowerCase()
                              );
                              return (
                                <button
                                  key={option}
                                  type="button"
                                  className={`reservations-intolerance-chip ${active ? "is-active" : ""}`}
                                  onClick={() => togglePresetIntolerance(option)}
                                >
                                  <AllergenIcon allergen={option} />
                                  {option}
                                </button>
                              );
                            })}
                          </div>
                          <div className="reservations-intolerance-custom-head">
                            <span>
                              <AllergenIcon />
                              Allergie e intolleranze personalizzate
                            </span>
                            <button
                              type="button"
                              className="smallbtn reservations-intolerance-add-btn"
                              onClick={() => setCustomIntoleranceModalOpen(true)}
                              disabled={actionBusy}
                              aria-label="Aggiungi allergia o intolleranza personalizzata"
                            >
                              +
                            </button>
                          </div>
                          {customIntoleranceTokens.length > 0 && (
                            <div className="reservations-intolerance-custom-list">
                              {customIntoleranceTokens.map((token) => (
                                <button
                                  key={token}
                                  type="button"
                                  className="reservations-intolerance-custom-chip"
                                  onClick={() => removeCustomIntolerance(token)}
                                  title="Rimuovi intolleranza personalizzata"
                                >
                                  <AllergenIcon allergen={token} />
                                  {token}
                                  <span aria-hidden="true">x</span>
                                </button>
                              ))}
                            </div>
                          )}
                          {customIntoleranceModalOpen && (
                            <ReservationCustomIntoleranceModal
                              draft={customIntoleranceDraft}
                              onChangeDraft={setCustomIntoleranceDraft}
                              onClose={() => setCustomIntoleranceModalOpen(false)}
                              onSubmit={addCustomIntolerance}
                            />
                          )}
                        </div>
                      </div>

                      <div className="reservations-assign-page-actions is-confirm-only">
                        <button
                          type="button"
                          className="smallbtn primary"
                          onClick={() => {
                            setCustomIntoleranceModalOpen(false);
                            setIntoleranceEditorOpen(false);
                          }}
                          disabled={actionBusy}
                        >
                          Conferma intolleranze
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="reservations-detail-head">
                        <div className="reservations-detail-title">
                          {mode === "create" ? "Nuova prenotazione" : "Modifica prenotazione"}
                        </div>
                        <div className="reservations-detail-actions">
                          <button
                            type="button"
                            className="smallbtn reservations-icon-btn is-close"
                            onClick={cancelEditor}
                            disabled={actionBusy}
                            aria-label="Chiudi modifica prenotazione"
                            title="Chiudi"
                          >
                            X
                          </button>
                        </div>
                      </div>

                      <div className="reservations-form">
                        <label htmlFor="reservation-name" className="is-half">
                          Nome
                          <input
                            id="reservation-name"
                            name="reservation_name"
                            value={form.customerName}
                            onChange={(event) =>
                              setForm((prev) => ({ ...prev, customerName: event.target.value }))
                            }
                            placeholder="Nome cliente"
                          />
                        </label>
                        <label htmlFor="reservation-phone" className="is-half">
                          Telefono
                          <input
                            id="reservation-phone"
                            name="reservation_phone"
                            value={form.customerPhone}
                            onChange={(event) =>
                              setForm((prev) => ({ ...prev, customerPhone: event.target.value }))
                            }
                            placeholder="+39 ..."
                          />
                        </label>
                        <label htmlFor="reservation-time" className="is-time">
                          Orario
                          <input
                            id="reservation-time"
                            name="reservation_time"
                            type="time"
                            value={form.reservationTime}
                            onChange={(event) =>
                              setForm((prev) => ({ ...prev, reservationTime: event.target.value }))
                            }
                          />
                        </label>
                        <label htmlFor="reservation-covers" className="is-covers">
                          Persone
                          <input
                            id="reservation-covers"
                            name="reservation_covers"
                            type="number"
                            min={1}
                            max={MAX_TABLE_COVERS}
                            value={form.covers}
                            onChange={(event) =>
                              setForm((prev) => ({ ...prev, covers: event.target.value }))
                            }
                          />
                        </label>
                        {mode === "edit" ? (
                          <label className="reservations-status-field">
                            Stato
                            <GlassDropdown
                              value={form.status}
                              options={reservationStatusDropdownOptions}
                              onChange={(value) =>
                                setForm((prev) => ({
                                  ...prev,
                                  status: value as ReservationEditorStatus,
                                }))
                              }
                              disabled={actionBusy}
                              ariaLabel="Stato prenotazione"
                              className="reservations-status-dropdown"
                            />
                          </label>
                        ) : null}
                        <label htmlFor="reservation-note" className="is-wide">
                          Note
                          <textarea
                            id="reservation-note"
                            name="reservation_note"
                            value={form.note}
                            onChange={(event) =>
                              setForm((prev) => ({ ...prev, note: event.target.value }))
                            }
                            placeholder="Note operative"
                          />
                        </label>
                      </div>

                      <div className="reservations-config-sections">
                        <div className="reservations-assign-actions">
                          <div className="reservations-assign-current">
                            Tavoli assegnati: {selectedTableLabel}
                          </div>
                          <div className="reservations-assign-buttons">
                            <button
                              type="button"
                              className="smallbtn reservations-action-btn"
                              onClick={() => {
                                setCustomIntoleranceModalOpen(false);
                                setIntoleranceEditorOpen(false);
                                setAssignTableOpen(true);
                              }}
                              disabled={actionBusy}
                            >
                              {form.assignedTableIds.length > 0 ? (
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                  <path d="M4 7h16v4H4z" />
                                  <path d="M6 11v6" />
                                  <path d="M18 11v6" />
                                  <path d="M9 17h6" />
                                  <path d="M12 14h6" />
                                </svg>
                              ) : (
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                  <path d="M4 7h16v4H4z" />
                                  <path d="M6 11v6" />
                                  <path d="M18 11v6" />
                                  <path d="M12 14v6" />
                                  <path d="M9 17h6" />
                                </svg>
                              )}
                              {form.assignedTableIds.length > 0
                                ? "Gestisci tavoli"
                                : "Assegna tavoli"}
                            </button>
                          </div>
                        </div>

                        <div className="reservations-intolerance-actions">
                          <div className="reservations-intolerance-current">
                            <span className="reservations-intolerance-current-label">
                              <AllergenIcon allergen={intoleranceTokens[0]} />
                              Intolleranze:
                            </span>
                            <span>
                              {intoleranceTokens.length > 0
                                ? intoleranceTokens.join(", ")
                                : "Nessuna"}
                            </span>
                          </div>
                          <div className="reservations-intolerance-buttons">
                            <button
                              type="button"
                              className="smallbtn reservations-action-btn"
                              onClick={() => {
                                setCustomIntoleranceModalOpen(false);
                                setAssignTableOpen(false);
                                setIntoleranceEditorOpen(true);
                              }}
                              disabled={actionBusy}
                            >
                              <AllergenIcon allergen={intoleranceTokens[0]} />
                              {intoleranceTokens.length > 0
                                ? "Gestisci intolleranze"
                                : "Segnala intolleranze"}
                            </button>
                          </div>
                        </div>
                      </div>

                      <div
                        className={`reservations-editor-actions ${
                          mode === "edit" && selectedReservation ? "has-delete" : ""
                        }`}
                      >
                        <button
                          type="button"
                          className="smallbtn reservations-save-btn"
                          onClick={onSave}
                          disabled={actionBusy}
                        >
                          <ReservationSaveIcon />
                          <span>Salva</span>
                        </button>
                        {mode === "edit" && selectedReservation ? (
                          <button
                            type="button"
                            className="smallbtn reservations-delete-btn"
                            onClick={() =>
                              setDialog({
                                type: "delete",
                                reservationLabel: reservationLabel(selectedReservation),
                              })
                            }
                            disabled={actionBusy}
                          >
                            <ReservationActionIcon action="delete" />
                            <span>Elimina</span>
                          </button>
                        ) : null}
                      </div>
                    </>
  );
}
