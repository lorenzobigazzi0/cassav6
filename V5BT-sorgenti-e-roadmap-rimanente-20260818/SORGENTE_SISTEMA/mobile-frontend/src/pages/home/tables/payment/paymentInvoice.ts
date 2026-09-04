export type InvoiceClient = {
  id: string;
  ragioneSociale: string;
  piva: string;
  indirizzo: string;
  cap: string;
  citta: string;
  provincia: string;
  pec: string;
  sdi: string;
};

export type InvoiceClientDraft = Omit<InvoiceClient, "id">;

const VAT_REGEX = /^\d{11}$/;
const PEC_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const SDI_REGEX = /^[A-Z0-9]{7}$/;
const CAP_REGEX = /^\d{5}$/;
const PROV_REGEX = /^[A-Z]{2}$/;

export const DEFAULT_INVOICE_CLIENTS: InvoiceClient[] = [
  {
    id: "cli_1",
    ragioneSociale: "Dolce Vita SRL",
    piva: "01234567890",
    indirizzo: "Via Roma 10",
    cap: "20100",
    citta: "Milano",
    provincia: "MI",
    pec: "amministrazione@dolcevita.pec.it",
    sdi: "ABC1234",
  },
  {
    id: "cli_2",
    ragioneSociale: "Lido Sunset SPA",
    piva: "09876543210",
    indirizzo: "Viale Mare 5",
    cap: "70121",
    citta: "Bari",
    provincia: "BA",
    pec: "info@lidosunset.pec.it",
    sdi: "SDF7H2K",
  },
];

export const normalizeInvoiceVat = (value: string) => value.replace(/\D/g, "").slice(0, 11);

export const isValidInvoiceVat = (value: string) => VAT_REGEX.test(normalizeInvoiceVat(value));

export const normalizeInvoiceDraft = (draft: InvoiceClientDraft): InvoiceClientDraft => ({
  ragioneSociale: draft.ragioneSociale.trim(),
  piva: normalizeInvoiceVat(draft.piva),
  indirizzo: draft.indirizzo.trim(),
  cap: draft.cap.replace(/\D/g, "").slice(0, 5),
  citta: draft.citta.trim(),
  provincia: draft.provincia
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 2),
  pec: draft.pec.trim(),
  sdi: draft.sdi
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 7),
});

export const validateInvoiceData = (data: InvoiceClientDraft) => {
  const errors: Record<string, string> = {};
  if (!data.ragioneSociale) errors.ragioneSociale = "Ragione sociale obbligatoria.";
  if (!VAT_REGEX.test(data.piva)) errors.piva = "Partita IVA non valida (11 numeri).";
  if (!data.indirizzo) errors.indirizzo = "Indirizzo obbligatorio.";
  if (!CAP_REGEX.test(data.cap)) errors.cap = "CAP non valido (5 cifre).";
  if (!data.citta) errors.citta = "Città obbligatoria.";
  if (!PROV_REGEX.test(data.provincia)) errors.provincia = "Provincia con 2 lettere maiuscole.";
  if (!PEC_REGEX.test(data.pec)) errors.pec = "PEC non valida.";
  if (!SDI_REGEX.test(data.sdi)) errors.sdi = "Codice SDI non valido (7 caratteri).";
  return errors;
};
