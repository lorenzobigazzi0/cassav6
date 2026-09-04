import { HACCP_ALLERGEN_OPTIONS, normalizeAllergenLabel } from "../allergens";
import { collectIntoleranceTokens, composeIntoleranceTokens } from "../../utils/intoleranceTokens";

/** Nota che il tavolo usa per segnalare l'allergia: derivata, mai digitata. */
export const TABLE_ALLERGY_NOTE = "Allergia segnalata: verificare note cliente.";

const PRESET_KEYS = new Set(HACCP_ALLERGEN_OPTIONS.map((label) => label.toLowerCase()));

const isPreset = (token: string) => PRESET_KEYS.has(normalizeAllergenLabel(token).toLowerCase());

/**
 * Prenotazione -> tavolo. La prenotazione tiene le intolleranze in una stringa
 * sola; il tavolo le divide fra allergeni riconosciuti e testo libero. I token
 * non identici a quelli dell'anagrafica restano separati da virgola.
 */
export function intolerancesToTableAllergens(intolerances: string | null | undefined) {
  const tokens = collectIntoleranceTokens(intolerances ?? "");
  return {
    allergens: tokens.filter(isPreset),
    manualIntolerance: composeIntoleranceTokens(tokens.filter((token) => !isPreset(token))),
  };
}

/** Tavolo -> prenotazione: allergeni e testo libero tornano una stringa sola. */
export function tableAllergensToIntolerances(
  allergens: readonly string[] | null | undefined,
  manualIntolerance: string | null | undefined
) {
  return composeIntoleranceTokens(
    collectIntoleranceTokens(allergens ?? [], manualIntolerance ?? "")
  );
}

/** Toglie il marcatore dalla nota: sul record viaggia solo il testo del cliente. */
export function stripAllergyNote(note: string | null | undefined) {
  return String(note ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== TABLE_ALLERGY_NOTE)
    .join("\n")
    .trim();
}

/** Rimette il marcatore in cima quando ci sono intolleranze, senza duplicarlo. */
export function withAllergyNote(note: string | null | undefined, hasIntolerances: boolean) {
  const clean = stripAllergyNote(note);
  if (!hasIntolerances) return clean;
  return clean ? `${TABLE_ALLERGY_NOTE}\n${clean}` : TABLE_ALLERGY_NOTE;
}

/**
 * Coperti della prenotazione ripartiti sui tavoli assegnati: il tavolo logico
 * somma le foglie, quindi scrivere il totale su ognuna li conterebbe piu' volte.
 * Il resto va sui primi, cosi' la somma torna sempre al totale.
 */
export function splitCoversAcrossTables(covers: number, tableCount: number): number[] {
  const total = Math.max(0, Math.trunc(covers));
  const count = Math.max(1, Math.trunc(tableCount));
  const base = Math.floor(total / count);
  const rest = total - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < rest ? 1 : 0));
}

/** Quota di coperti che spetta a un tavolo dentro la prenotazione. */
export function coversForAssignedTable(
  covers: number,
  assignedTableIds: readonly string[] | null | undefined,
  tableId: string
) {
  const ids = assignedTableIds ?? [];
  const index = ids.indexOf(tableId);
  // Prenotazione senza tavoli assegnati, o tavolo estraneo: nessuna ripartizione.
  if (index < 0) return Math.max(0, Math.trunc(covers));
  return splitCoversAcrossTables(covers, ids.length)[index] ?? 0;
}
