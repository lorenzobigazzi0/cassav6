const MINUTI_PER_ORA = 60;
const MINUTI_PER_GIORNO = 24 * MINUTI_PER_ORA;
const GIORNI_SENZA_MINUTI = 30;
const GIORNI_SENZA_ORE = 365;

const minutiTrascorsi = (timestamp: number, now: number) =>
  Math.floor(Math.max(0, now - timestamp) / 60000);

const scomponi = (minuti: number) => ({
  giorni: Math.floor(minuti / MINUTI_PER_GIORNO),
  ore: Math.floor((minuti % MINUTI_PER_GIORNO) / MINUTI_PER_ORA),
  minuti: minuti % MINUTI_PER_ORA,
});

/** I componenti a zero si tolgono: `2g 5h`, non `2g 5h 0min`. */
const unisci = (...pezzi: Array<string | null>) => pezzi.filter(Boolean).join(" ");

/**
 * Durata trascorsa in forma compatta: valore e unita' di misura, senza parole.
 *
 * Oltre le 24 ore si passa ai giorni: un tavolo aperto da una settimana
 * mostrerebbe altrimenti un numero di ore che non si legge. Da li in poi la
 * precisione cala con la distanza, perche' i minuti di un mese fa non
 * interessano piu' a nessuno: oltre i 30 giorni cadono i minuti, oltre l'anno
 * cadono anche le ore.
 *
 * E' la forma **estesa**, quella del dettaglio del tavolo, dove lo spazio c'e'.
 * Per le tessere della vista tavoli si usa `formatElapsedCoarse`.
 */
export function formatElapsedCompact(timestamp: number, now = Date.now()) {
  const totale = minutiTrascorsi(timestamp, now);
  if (totale < MINUTI_PER_ORA) return `${totale}min`;
  const { giorni, ore, minuti } = scomponi(totale);
  if (giorni === 0) return unisci(`${ore}h`, minuti ? `${minuti}min` : null);
  if (giorni < GIORNI_SENZA_MINUTI) {
    return unisci(`${giorni}g`, ore ? `${ore}h` : null, minuti ? `${minuti}min` : null);
  }
  if (giorni < GIORNI_SENZA_ORE) return unisci(`${giorni}g`, ore ? `${ore}h` : null);
  return `${giorni}g`;
}

/**
 * La stessa durata per le tessere della vista tavoli, dove lo spazio e' poco:
 * **al massimo due unita'**. Oltre i 30 giorni resta il solo numero di giorni.
 */
export function formatElapsedCoarse(timestamp: number, now = Date.now()) {
  const totale = minutiTrascorsi(timestamp, now);
  if (totale < MINUTI_PER_ORA) return `${totale}min`;
  const { giorni, ore, minuti } = scomponi(totale);
  if (giorni === 0) return unisci(`${ore}h`, minuti ? `${minuti}min` : null);
  if (giorni < GIORNI_SENZA_MINUTI) return unisci(`${giorni}g`, ore ? `${ore}h` : null);
  return `${giorni}g`;
}

export function formatRelativeTime(timestamp: number, now = Date.now()) {
  const diffMs = Math.max(0, now - timestamp);
  const minutes = Math.floor(diffMs / 60000);
  if (minutes <= 0) return "adesso";
  if (minutes < 60) return minutes === 1 ? "1 minuto" : `${minutes} minuti`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 ora" : `${hours} ore`;
}
