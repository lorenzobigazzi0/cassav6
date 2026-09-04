# V5BT B4 - Otto Palmare Web Grafici Non-Gate

Data: 2026-08-10

## Risultato

Il banco grafico Chrome e stato avviato con successo sul frontend Palmare
Advanced reale e sul backend di laboratorio isolato:

- verdetto: `NON_GATE_PASS`;
- finestre Chrome grafiche visibili: `8/8`;
- contesti, pagine e sessioni autenticate distinte: `8/8/8`;
- slot web: `3..10`;
- copertura logica complessiva: `SIMULATED_10_OF_10`;
- richieste consentite: soltanto loopback;
- accessi ADB, SSH, Bluetooth, Raspberry e UPS: nessuno;
- screenshot privati: `8/8`, file regolari `0600`;
- test contrattuali del launcher: `10/10 PASS`;
- rendering ispezionato: non vuoto, login completato e Home Palmare visibile;
- controllo continuo del ledger: attivo ogni `5` secondi.

Il primo tentativo ha autenticato sette sessioni prima del timeout di avvio e
non ha pubblicato alcun PASS. Il supervisore e stato corretto per consentire le
otto verifiche PIN seriali senza generare picchi di CPU; il tentativo successivo
ha raggiunto `ACTIVE` con tutte le otto finestre.

## Isolamento E Integrita

Il ledger fisico e stato soltanto letto: schema `2`, due record, permessi
`0600`, un link. Fingerprint e contenuto sono risultati identici prima e dopo
l'avvio. Il launcher non legge le evidenze fisiche, non importa collector o
promotori, non esegue il gate Raspberry e non persiste dispositivi simulati nel
ledger.

Il report runtime pubblico e redatto: non contiene account, UUID browser,
token, identificatori fisici, hash, percorsi o PID. Database isolato, log,
screenshot e stato del supervisore restano nella directory privata esclusa
dagli archivi sorgente.

## Stato Gate

La copertura grafica B4 web e chiusa `10/10` come simulazione. Il ledger
autorevole resta `2/10`: gli otto Palmare web contano `0` verso il gate fisico,
B4 e B5 restano `PENDING`, B6 resta `BLOCKED` e nessuna campagna B5 e
autorizzata.

Avanzamento roadmap complessiva: **49%**
