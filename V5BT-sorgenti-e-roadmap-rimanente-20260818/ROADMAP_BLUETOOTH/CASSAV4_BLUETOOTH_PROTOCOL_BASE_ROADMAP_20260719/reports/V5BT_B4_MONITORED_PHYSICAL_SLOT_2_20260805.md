# V5BT B4 Monitored Physical Slot 2

Data: 2026-08-05

## Scopo

Questo report pubblico redatto documenta il secondo slot della nuova raccolta
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

- `270` osservazioni accettate;
- `0` osservazioni rifiutate;
- `0` errori;
- cleanup completo al termine della cattura.

Due tentativi di orchestrazione precedenti sono stati respinti senza record:
nel primo mancava la finalizzazione del monitor Raspberry entro la finestra;
nel secondo la copertura Android terminava prima del cleanup Raspberry. Il
ledger e rimasto invariato fino alla cattura integralmente valida.

## Continuita Android

Il monitor Android ha coperto runner e cleanup:

- durata `180` secondi;
- `91` campioni validi;
- gap massimo `2003` ms;
- nessun evento bloccante;
- attestazione finale `PASS`.

## Continuita Raspberry

Il monitor Raspberry ha coperto avvio, esecuzione e arresto del runner:

- durata `146657` ms;
- `30` campioni validi;
- gap massimo `5004` ms;
- zero restart dei servizi sorvegliati;
- cleanup completo;
- attestazione finale `PASS`.

## Stato Gate

Il wrapper monitorato ha registrato l'hardware una sola volta:

- slot registrati: `2/10`;
- dispositivi rimanenti: `8`;
- B4: `PENDING` fino a dieci hardware distinti;
- B5: chiuso;
- B6: chiuso.

State ed evidenze sono file regolari `0600`, con un solo link fisico. Il
servizio principale e `bluetooth.service` sono rimasti attivi con zero
restart; dopo il cleanup BlueZ non era in discovery e non aveva advertiser
attivi.

Dopo la registrazione il Palmare e stato disconnesso dall'app. La schermata
di accesso e tornata visibile, le notifiche attive e i servizi nativi target
sono risultati assenti e il monitor canonico ha confermato
`SESSION_LOGGED_OUT` senza pubblicare una nuova attestazione.

Fuori dal perimetro B4 resta la regressione grafica non bloccante del banner
`Configurazione aggiornata.` visibile sulla schermata di accesso. La build
certificata non e stata modificata durante la raccolta.

La raccolta non promuove ancora alcun gate e l'avanzamento roadmap complessivo
resta **49%**.
