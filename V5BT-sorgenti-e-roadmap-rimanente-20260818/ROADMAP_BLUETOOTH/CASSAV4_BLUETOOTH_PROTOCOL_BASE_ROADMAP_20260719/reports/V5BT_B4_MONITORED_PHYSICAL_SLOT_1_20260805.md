# V5BT B4 Monitored Physical Slot 1

Data: 2026-08-05

## Scopo

Questo report pubblico redatto documenta il primo slot della nuova raccolta
fisica B4 monitorata. Non contiene seriali ADB, UUID di cattura, identita
utente o di enrollment, indirizzi di rete, hostname, percorsi privati,
timestamp precisi, chiavi o log grezzi.

## Target Certificato

- Palmare Advanced `1.0.39`, version code `40`;
- Android API `36`;
- modello `SM-A165F`;
- package, APK, firma, ruolo e stato applicativo coerenti con la matrice
  certificata.

## Cattura B4.3

Il runner fisico e rimasto attivo per `90` secondi e ha concluso `PASS`:

- `229` osservazioni accettate;
- `0` osservazioni rifiutate;
- `0` errori;
- cleanup completo al termine della cattura.

I tentativi precedenti che non soddisfacevano integralmente il contratto sono
stati respinti dal percorso fail-closed e non sono stati conteggiati.

## Continuita Android

Il monitor Android ha coperto l'intera finestra fisica:

- durata `120` secondi;
- `61` campioni validi;
- gap massimo `2003` ms;
- nessun evento bloccante;
- attestazione finale `PASS`.

## Continuita Raspberry

Il monitor Raspberry ha coperto avvio, esecuzione e arresto del runner:

- durata `106063` ms;
- `22` campioni validi;
- gap massimo `5004` ms;
- zero restart dei servizi sorvegliati;
- cleanup completo;
- attestazione finale `PASS`.

## Stato Gate

Il collector ha registrato una sola volta l'hardware nel nuovo ledger:

- slot registrati: `1/10`;
- dispositivi rimanenti: `9`;
- B4: `PENDING` fino a dieci hardware distinti;
- B5: chiuso;
- B6: chiuso.

Dopo la registrazione il Palmare e stato disconnesso dall'app. La schermata
di accesso e tornata visibile, le notifiche attive e i servizi Bluetooth del
package sono risultati assenti e il monitor canonico ha confermato
`SESSION_LOGGED_OUT` senza pubblicare una nuova attestazione.

Fuori dal perimetro B4 resta una regressione grafica non bloccante: il banner
`Configurazione aggiornata.` e rimasto visibile sulla schermata di accesso.
L'APK non e stato modificato durante la raccolta per non cambiare il target
certificato a cui il ledger e vincolato.

La raccolta non promuove ancora alcun gate e l'avanzamento roadmap complessivo
resta **49%**.
