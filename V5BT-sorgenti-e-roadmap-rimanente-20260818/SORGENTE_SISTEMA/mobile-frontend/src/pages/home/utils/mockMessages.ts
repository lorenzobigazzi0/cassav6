import type { NotificationType } from "../../../api/notifications";

const titles: Record<NotificationType, string[]> = {
  waiter: ["Chiamata cameriere", "Assistenza tavolo", "Richiesta urgente"],
  bell: ["Comanda pronta", "Ordine completato", "Ritiro al banco"],
  general: ["Nuova notifica", "Avviso sistema", "Messaggio operativo"],
};

const snippets = [
  "Il tavolo ha bisogno di assistenza.",
  "Richiesta prioritaria da gestire.",
  "Cliente in attesa da qualche minuto.",
  "Verifica la sala e aggiorna lo stato.",
  "Controlla la comanda e procedi.",
  "Richiesta conferma operatore.",
  "Aggiornamento operativo disponibile.",
  "Serve un intervento rapido.",
  "Priorita alta, agire subito.",
  "Dettaglio aggiuntivo nel riepilogo.",
  "Nota interna: controllare ingredienti.",
  "Messaggio dal banco comande.",
  "Assicurati che tutto sia pronto.",
  "Azione richiesta entro breve.",
  "Controlla la lista ordini aperti.",
];

const randomItem = (list: string[]) => list[Math.floor(Math.random() * list.length)];

const buildDescription = (max = 140) => {
  const target = Math.min(max, 40 + Math.floor(Math.random() * 100));
  let result = "";
  while (result.length < target) {
    const next = randomItem(snippets);
    if (result.length === 0) {
      result = next;
      continue;
    }
    if (result.length + next.length + 1 > max) break;
    result = `${result} ${next}`;
  }
  return result.slice(0, max);
};

export const buildMockNotification = (type: NotificationType) => ({
  title: randomItem(titles[type]),
  description: buildDescription(140),
});
