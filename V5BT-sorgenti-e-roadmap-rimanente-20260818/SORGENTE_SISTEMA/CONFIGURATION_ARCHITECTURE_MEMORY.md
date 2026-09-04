# Memoria architettura configurazione operativa

## Ciclo V3 - fix importo pagabile tavoli aperti

Data ciclo: 2026-06-21 20:08 Europe/Rome

Problema:

- sul mobile alcuni tavoli risultavano con conto aperto ma il pagamento mostrava `Nessun importo pagabile`;
- la causa era una divergenza tra i campi economici del tavolo:
  - alcune viste/percorsi avevano `totalDue` valorizzato;
  - altre parti del mobile leggevano solo `amountDue`;
  - il backend sincronizzava il residuo ma non persisteva sempre gli alias `amountDue` e `dueAmount`.

Correzione:

- in `cassa-frontend/backend/server.js`, `syncPosTableFinancialsFromIntegrationOrders()` ora mantiene coerenti:
  - `totalDue`;
  - `amountDue`;
  - `dueAmount`;
- in `mobile-frontend/src/domain/tables/integrationParsers.ts`, il parser mobile usa fallback:
  - `amountDue`;
  - `totalDue`;
  - `dueAmount`;
- ricompilato `mobile-frontend/dist`;
- riavviato solo backend V3, nuovo PID `3407788`;
- chiamato `GET /api/integration/layout` per forzare la risincronizzazione tavoli.

Verifica runtime:

- `room_pedana_t01`: `totalDue=29.3`, `amountDue=29.3`, `dueAmount=29.3`;
- `room_pedana_t02`: `totalDue=43.3`, `amountDue=43.3`, `dueAmount=43.3`;
- `room_pedana_t03`: `totalDue=1.3`, `amountDue=1.3`, `dueAmount=1.3`;
- controllo globale tavoli con `totalDue > 0` e alias incoerenti: `badCount=0`.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `node --test backend/tests/orders-payments-invariants.test.mjs`: OK, 15/15;
- `npm run test -- src/domain/tables/integrationParsers.test.ts`: OK, 2/2;
- `npm run build` in `mobile-frontend`: OK;
- `npm run check:backend`: OK.

SQLite staging:

- riallineato dopo il fix con `tools/sync-v3-json-to-sqlite.mjs`;
- ultimo SHA256 JSON/SQLite: `c6f52ccab251ea6562ad2c7f807a0be2fc63184e1a8e7848afe06e9e06da5627`;
- `meta.lastWriteAt`: `2026-06-21T18:08:57.197Z`;
- lo switchover SQLite resta NON eseguito.

## Ciclo V3 - staging SQLite da app-state JSON

Data ciclo: 2026-06-20 17:59 Europe/Rome

Ambito:

- V3 soltanto;
- nessuno switchover eseguito;
- backend V3 lasciato in modalita' runtime corrente;
- creato/allineato SQLite di staging da `cassa-frontend/backend/app-state.json`.

Stato rilevato:

- sorgente runtime attuale: `cassa-frontend/backend/app-state.json`;
- SQLite staging generato: `cassa-frontend/backend/backend.sqlite`;
- supporto backend gia' presente tramite `BACKEND_DB_MODE=sqlite`;
- il backend non e' stato ripuntato a SQLite in questo ciclo.

Allineamento eseguito:

- backup JSON pre-allineamento in `cassa-frontend/backend/backups/sqlite-cutover/`;
- creato script ripetibile:
  - `tools/sync-v3-json-to-sqlite.mjs`;
- lo script legge il JSON in modo stabile, crea un nuovo SQLite temporaneo, inserisce `app_state(id=1)`, sostituisce atomicamente `backend.sqlite` e verifica SHA256 JSON/SQLite;
- ultimo esito noto:
  - JSON bytes: `6429707`;
  - SHA256 JSON: `05f0a304768e9336033b3499edbc41b8dab3a701513e5ae1b2df56729cdd6b4a`;
  - SHA256 SQLite: `05f0a304768e9336033b3499edbc41b8dab3a701513e5ae1b2df56729cdd6b4a`;
  - `meta.lastWriteAt`: `2026-06-20T15:59:50.201Z`.

Regola per switchover lunedi' ore 10:00:

- finche' il runtime continua a scrivere su JSON, `backend.sqlite` resta una fotografia dell'ultimo sync;
- pochi minuti prima dello switchover va rilanciato:

```bash
/srv/applicazione/v3/tools/sync-v3-json-to-sqlite.mjs
```

- solo dopo esito `ok: true` e hash identici si puo' impostare la V3 a SQLite;
- rollback rapido: ripristinare `BACKEND_DB_MODE=json` e riavviare solo il backend V3.

Test eseguiti:

- `node --check /srv/applicazione/v3/tools/sync-v3-json-to-sqlite.mjs`: OK;
- `node --test backend/tests/app-state-persistence.test.mjs`: OK, 8/8.

Rischi residui:

- se il sistema resta operativo fino a lunedi', fare obbligatoriamente un sync finale appena prima dello switchover;
- non tenere attivi sincronizzatori automatici dopo lo switch, per evitare che un JSON vecchio sovrascriva il DB runtime.

## Working copy V3 - 2026-06-06

- Questa cartella e' `/srv/applicazione/v3`.
- E' stata creata come copia speculare di `/srv/applicazione/current`.
- `/srv/applicazione/current` resta la V2 attiva.
- Salvo richiesta esplicita diversa, le prossime modifiche devono essere applicate qui in V3.
- La copia include DB e configurazioni correnti al momento della creazione.
- I servizi non sono stati ripuntati verso V3 in fase di copia.
- Avvio parallelo V3 eseguito il 2026-06-06 15:20 Europe/Rome:
  - frontend V3 su `5280`;
  - backend V3 su `5281`;
  - V2 lasciata attiva su `5180/5181`;
  - DB V3 separato: `/srv/applicazione/v3/cassa-frontend/backend/app-state.json`;
  - stampa reale non abilitata esplicitamente su V3 per evitare stampe accidentali.
- Isolamento API V3 rafforzato nello stesso ciclo:
  - default frontend V3 `5280`;
  - default backend V3 `5281`;
  - proxy frontend V3 verso `http://127.0.0.1:5281`;
  - bridge/fallback postazione e mobile V3 riallineati a `5281`;
  - CORS backend V3 ristretto: origine V2 `5180` respinta, origine V3 `5280` accettata;
- tool Francesca preconto mirror riallineato a API/spool/DB V3.

## Ciclo V3 - riepilogo sessioni palmari monitor/stampa

Data ciclo: 2026-06-20 16:46 Europe/Rome

Ambito:

- V3 soltanto;
- report monitor per sessioni palmari;
- stampa riepilogo via spool reale sulla stampante preconti dell'attivita' Bar;
- policy palmari: POS fiscale abilitato di default anche per nuovi palmari, contante fiscale spento salvo abilitazione esplicita.

Modifiche applicate:

- creato `cassa-frontend/backend/modules/reports/handheld-session-report.js`;
- aggiunti endpoint autenticati:
  - `POST /api/reports/handheld-session`;
  - `POST /api/reports/handheld-session/print`;
- aggiunto report nell'overview monitor;
- aggiunta card monitor `Storico Sessioni Palmari` con calendario/date picker e pulsante stampa;
- aggiunto scheduler backend idempotente per stampa automatica alle 02:00;
- programmata stampa una-tantum del report sessione `2026-06-20` alle 17:10 tramite script API:
  - `/srv/applicazione/v3/tools/print-handheld-session-report-once-20260620-1710.sh`;
- aggiornata la regola `mobile-device-config.domain.js`:
  - `fiscalEnabled` default true;
  - POS/elettronico default true;
  - contante fiscale default false.

Invarianti:

- il report usa la finestra operativa 16:00 -> 02:00;
- i coperti sono contati una sola volta per sessione tavolo;
- se un tavolo viene liberato e rioccupato, apre una nuova sessione e riconta i coperti;
- la stampante del report viene risolta solo dal preconto dell'attivita' Bar o da `printerId` esplicito valido;
- non esiste fallback generico verso stampanti di altre attivita'.

Test eseguiti:

- `node --check backend/modules/reports/handheld-session-report.js`: OK;
- `node --check backend/modules/reports/reports.handlers.js`: OK;
- `node --check backend/modules/reports/reports.routes.js`: OK;
- `node --check backend/modules/status/status.handlers.js`: OK;
- `node --check backend/server.js`: OK;
- `node --check monitor-frontend/dist/app.js`: OK;
- `node --test backend/tests/handheld-session-report.test.mjs backend/tests/mobile-device-config-domain.test.mjs`: OK, 13/13.

Verifiche runtime:

- backend V3 riavviato con PID nuovo `2032243`;
- `GET http://127.0.0.1:5281/api/health`: OK;
- `GET /api/monitor/overview`: espone `handheldSessionReport`;
- `POST /api/reports/handheld-session` per `2026-06-20`: OK, sessione corrente vuota;
- `POST /api/reports/handheld-session` per `2026-06-19`: OK, 116 coperti, POS `839,70`, contanti `388,70`;
- monitor HTTP serve la nuova card `Storico Sessioni Palmari`;
- cron una-tantum per stampa `2026-06-20` alle 17:10 installato e auto-rimuovente.

Prossimo step consigliato:

- dopo riavvio backend/frontends, verificare `/monitor` e `POST /api/reports/handheld-session`;
- verificare log script 17:10 in `/srv/applicazione/v3/tools/print-handheld-session-report-once-20260620-1710.log`.

## Ciclo V3 - riduzione monolite normalizzazione varianti ordine

Data ciclo: 2026-06-07 05:22 Europe/Rome

Ambito:

- V3 soltanto;
- V2/current non modificata;
- nessun riavvio;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o servizi live.

Modifica applicata:

- estratta dal monolite la funzione pura `normalizeIntegrationVariantData`;
- la funzione vive ora in `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`;
- `cassa-frontend/backend/server.js` la importa dal dominio varianti;
- preservato il comportamento legacy:
  - oggetti e array `variants` vengono clonati via JSON;
  - input circolari/non serializzabili tornano `{}`;
  - se manca `variants` ma c'e' un nome variante, ritorna `{ label: nome }`;
  - se manca tutto, ritorna `{}`.

Metriche:

- `cassa-frontend/backend/server.js`: 28.184 -> 28.176 righe;
- riduzione netta ciclo: 8 righe;
- `order-line-variants.domain.js`: 135 -> 152 righe;
- `integration-order-line-variants-domain.test.mjs`: 178 -> 204 righe.

Test eseguiti:

- `node --check backend/modules/integration/order-line-variants.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs`: OK, 15/15;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/listino-time-pricing.e2e.test.mjs backend/tests/menu-domain.test.mjs backend/tests/menu-routing-domain.test.mjs`: OK, 54/54;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Rischi residui:

- i prossimi helper varianti (`resolveIntegrationLineMenuVariantDelta`, `resolveIntegrationSelectedMenuVariant`) dipendono da lookup/catalogo e vanno estratti solo con factory o modulo dedicato;
- non estrarre ancora validazioni HTTP delle varianti finche' non si separano errori dominio da `HttpError`.

Prossimo step consigliato:

- cercare un altro helper puro e reversibile fuori dai flussi pagamento/fiscalita';
- in alternativa introdurre un dominio `integration-order-menu-variants.domain.js` con dipendenze lookup iniettate, solo se il guadagno supera la complessita'.

## Ciclo V3 - riduzione monolite supplementi preconto

Data ciclo: 2026-06-07 05:31 Europe/Rome

Ambito:

- V3 soltanto;
- V2/current non modificata;
- nessun riavvio;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o servizi live.

Modifica applicata:

- creato `cassa-frontend/backend/printing/preconto-supplements.domain.js`;
- estratto dal monolite il dominio puro dei supplementi preconto:
  - normalizzazione label supplemento/variante;
  - riconoscimento e formattazione apericena;
  - parsing importi liberi italiani/internazionali;
  - rimozione suffissi prezzo;
  - segmentazione supplementi;
  - costruzione voci supplemento;
  - calcolo delta apericena;
  - deduplica supplementi;
  - ricavo supplemento residuo da `unitValue` e `listUnitValue`;
- il server usa ora `createPrecontoSupplementHelpers()` configurato con `APERICENA_STANDARD_TARGET_PRICE` e `roundMoney`;
- aggiunto test dedicato `cassa-frontend/backend/tests/preconto-supplements-domain.test.mjs`.

Nota di verifica:

- il primo rilancio continuity ha evidenziato due helper non collegati (`extractPrecontoEntryNameUnitHintValue`, `normalizePrecontoInlineSupplementLabel`);
- il collegamento e' stato corretto importandoli dalla factory;
- i test falliti sono poi passati integralmente.

Metriche:

- `cassa-frontend/backend/server.js`: 28.176 -> 27.925 righe;
- riduzione netta ciclo: 251 righe;
- nuovo modulo `preconto-supplements.domain.js`: 289 righe;
- nuovo test `preconto-supplements-domain.test.mjs`: 97 righe.

Test eseguiti:

- `node --check backend/printing/preconto-supplements.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/preconto-supplements-domain.test.mjs`: OK, 6/6;
- `node --test backend/tests/preconto-supplements-domain.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/listino-time-pricing.e2e.test.mjs`: OK, 27/27;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Rischi residui:

- il dominio preconto ora e' isolato, ma la composizione completa del testo preconto resta nel monolite;
- non estrarre ancora routing stampanti/spool insieme alla formattazione: sono side effect e vanno separati in una fase distinta;
- eventuali variazioni future dei prezzi target apericena devono passare dalla configurazione server/factory, non da costanti duplicate.

Prossimo step consigliato:

- proseguire su helper puri di stampa/preconto, ad esempio layout colonne o righe item, solo se isolabili senza routing;
- in alternativa cercare normalizzatori tavolo/lock con test domain gia' presenti;
- mantenere sempre continuity dopo slice che toccano preconti, modifiche ordine o spostamenti tavolo.

## Ciclo V3 - riduzione monolite etichette posizione stampa

Data ciclo: 2026-06-07 05:36 Europe/Rome

Ambito:

- V3 soltanto;
- V2/current non modificata;
- nessun riavvio;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o servizi live.

Modifica applicata:

- creato `cassa-frontend/backend/printing/print-location.domain.js`;
- estratto dal monolite il dominio puro delle etichette di stampa:
  - riferimento preconto/comanda;
  - label `TAV. ... SALA`;
  - risoluzione label sala da settings/fallback;
  - label tavolo da ordine;
  - label posizione ordine;
  - label posizione tavolo;
- il server usa ora `createPrintLocationHelpers()` con dipendenze esplicite:
  - `findPosRoomById`;
  - `formatIntegrationPrintDisplayName`;
  - `formatIntegrationPrintOrderId`;
  - `sanitizeIntegrationOrder`;
  - `sanitizeIntegrationTableLabel`;
  - `toPrintSafeUppercase`;
- aggiunto test dedicato `cassa-frontend/backend/tests/print-location-domain.test.mjs`.

Metriche:

- `cassa-frontend/backend/server.js`: 27.925 -> 27.871 righe;
- riduzione netta ciclo: 54 righe;
- nuovo modulo `print-location.domain.js`: 92 righe;
- nuovo test `print-location-domain.test.mjs`: 67 righe.

Test eseguiti:

- `node --check backend/printing/print-location.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/print-location-domain.test.mjs`: OK, 5/5;
- `node --test backend/tests/print-location-domain.test.mjs backend/tests/preconto-supplements-domain.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/listino-time-pricing.e2e.test.mjs`: OK, 32/32;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Rischi residui:

- la composizione completa del testo preconto/comanda resta nel monolite;
- il routing stampante/spool resta volutamente fuori da questa estrazione;
- continuare a evitare estrazioni che mischiano formattazione, DB e side effect.

Prossimo step consigliato:

- valutare estrazione di helper puri di layout preconto, ma solo se non trascinano `buildIntegrationPrecontoModel`;
- alternativa prudente: normalizzatori tavolo/lock o funzioni pure di pagamento-print gia' coperte da test.

## Ciclo V3 - riduzione monolite layout preconto

Data ciclo: 2026-06-07 05:42 Europe/Rome

Ambito:

- V3 soltanto;
- V2/current non modificata;
- nessun riavvio;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o servizi live.

Modifica applicata:

- creato `cassa-frontend/backend/printing/preconto-layout.domain.js`;
- estratto dal monolite il dominio puro del layout righe preconto:
  - calcolo totale display riga;
  - calcolo prezzo unitario base;
  - raccolta valori unitari per dimensionamento colonne;
  - layout colonne `QTA / ARTICOLO / P.U. / TOT.`;
  - costruzione righe articolo con supplementi e totale finale;
- il server usa ora `createPrecontoLayoutHelpers()` con dipendenze esplicite:
  - `extractPrecontoEntryNameUnitHintValue`;
  - `formatPrintMoneyCompact`;
  - `getPrecontoEntrySupplementEntries`;
  - `isPrecontoApericenaLabel`;
  - `padPrintRight`;
  - `roundMoney`;
  - `wrapPrintText`;
- aggiunto test dedicato `cassa-frontend/backend/tests/preconto-layout-domain.test.mjs`.

Metriche:

- `cassa-frontend/backend/server.js`: 27.871 -> 27.708 righe;
- riduzione netta ciclo: 163 righe;
- nuovo modulo `preconto-layout.domain.js`: 201 righe;
- nuovo test `preconto-layout-domain.test.mjs`: 127 righe.

Test eseguiti:

- `node --check backend/printing/preconto-layout.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/preconto-layout-domain.test.mjs`: OK, 5/5;
- `node --test backend/tests/preconto-layout-domain.test.mjs backend/tests/print-location-domain.test.mjs backend/tests/preconto-supplements-domain.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/listino-time-pricing.e2e.test.mjs`: OK, 37/37;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Rischi residui:

- la costruzione completa del testo preconto resta nel monolite perche' combina preferenze, branding, profilo cash e output finale;
- non spostare ancora funzioni che accodano stampa o risolvono target stampante;
- eventuali modifiche future al rendering devono passare dai test layout + continuity.

Prossimo step consigliato:

- valutare estrazione branding header/footer preconto se resta pura;
- in alternativa passare a normalizzatori tavolo/lock per non concentrare troppi cambi nello stesso sottodominio stampa.

## Ciclo V3 - riduzione monolite branding preconto

Data ciclo: 2026-06-07 05:47 Europe/Rome

Ambito:

- V3 soltanto;
- V2/current non modificata;
- nessun riavvio;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o servizi live.

Modifica applicata:

- creato `cassa-frontend/backend/printing/preconto-branding.domain.js`;
- estratto dal monolite il dominio puro del branding preconto:
  - header con nome locale, indirizzo e telefono;
  - footer con ragione sociale e partita IVA;
  - rispetto dei toggle `preconto.showVenueName`, `showAddress`, `showPhone`, `showCompanyName`, `showVatNumber`;
- il server usa ora `createPrecontoBrandingHelpers()` con dipendenze esplicite:
  - `centerPrintText`;
  - `DEFAULT_POS_SETTINGS.printPreferences`;
  - `sanitizePosPrintPreferences`;
  - `toPrintSafeUppercase`;
  - `wrapPrintText`;
- aggiunto test dedicato `cassa-frontend/backend/tests/preconto-branding-domain.test.mjs`.

Metriche:

- `cassa-frontend/backend/server.js`: 27.708 -> 27.684 righe;
- riduzione netta ciclo: 24 righe;
- nuovo modulo `preconto-branding.domain.js`: 49 righe;
- nuovo test `preconto-branding-domain.test.mjs`: 119 righe.

Test eseguiti:

- `node --check backend/printing/preconto-branding.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/preconto-branding-domain.test.mjs`: OK, 5/5;
- `node --test backend/tests/preconto-branding-domain.test.mjs backend/tests/preconto-layout-domain.test.mjs backend/tests/print-location-domain.test.mjs backend/tests/preconto-supplements-domain.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/listino-time-pricing.e2e.test.mjs`: OK, 42/42;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Rischi residui:

- la funzione completa di stampa preconto resta nel monolite perche' combina profilo cash/non cash, branding, layout, riepilogo pagamento e label fiscale;
- il sottodominio stampa/preconto ora ha molte estrazioni recenti, quindi il prossimo step dovrebbe preferibilmente cambiare area per ridurre rischio di accoppiamento locale.

Prossimo step consigliato:

- passare a normalizzatori tavolo/lock o altro dominio puro gia' coperto da test;
- evitare ulteriori estrazioni nel preconto completo finche' non si pianifica una service extraction piu' ampia.

Data ciclo: 2026-06-04 03:26 Europe/Rome

Backup prima del ciclo:

- File: `/home/amalia/Downloads/backup-config-sale-20260604-032629.zip`
- SHA256: `0e461129ce8c2b7c511da7b9e24b33b26645c80558d533bba56a0c0fbb03cc9a`
- Contenuto: copia di `/srv/applicazione/current`, con esclusione di dipendenze/log rigenerabili.

## Obiettivo funzionale

Ricostruire e stabilizzare la configurazione operativa del sistema:

- locale;
- attivita del locale, ad esempio bar, ristorante, spiaggia, Pizza in Riva;
- sale collegate a una o piu attivita, anche sovrapposte;
- tavoli per sala;
- menu e listini per sala/attivita, con parti condivise tra piu sale;
- stampanti non fiscali per sala, postazione, categoria o flusso;
- RT/dispositivi fiscali solo per attivita;
- postazioni per attivita/sala/categorie operative;
- personale assegnato a sale e priorita notifiche;
- prenotazioni multi-sala e multi-tavolo con finestre operative 30/15/5 minuti;
- azioni tavolo admin, inclusa cancellazione con motivo e ticket.

## Modello target

Gerarchia logica target:

```text
Locale
  -> Attivita
       -> RT / fiscalita
       -> menu/listini principali
       -> stampanti
       -> postazioni
       -> Sale
            -> Tavoli
            -> Personale assegnato
            -> Stampanti non fiscali specifiche
            -> Menu/Listini specifici o aggiuntivi
```

Regole:

- il locale e' il contenitore principale;
- ogni locale puo avere piu attivita;
- una sala puo appartenere a piu attivita;
- una attivita puo avere piu sale;
- le RT stanno solo sulle attivita, mai sulle sale;
- la sala eredita RT e fiscalita dall'attivita operativa corrente;
- configurazione effettiva = configurazione Attivita + eventuali specifiche Sala;
- una parte di menu puo essere disponibile su piu sale;
- una postazione puo essere legata a sale/categorie;
- il backend resta sorgente autorevole per RT, fiscalita, prezzi, routing stampa, listini, sale e permessi;
- mobile e postazione non devono reinventare sale/menu/listini;
- le comande devono salvare snapshot operativo sufficiente per non cambiare prezzo/listino a posteriori;
- le prenotazioni non devono buttare fuori un operatore che sta lavorando su un tavolo occupato.

Nota architetturale non negoziabile: RT solo su Attivita. Sala eredita RT dall'Attivita corrente. Backend risolve tutto.
Ogni riferimento storico a RT per sala, cash point fiscale di sala o fiscalPrinterId di sala e' legacy/migrazione: puo essere letto per compatibilita, ma non deve guidare il modello operativo nuovo.
Nota di modello: una RT non e' necessariamente una stampante fisica. Il modello operativo nuovo distingue `fiscalDevices[]` (RT/API fiscale) da `printers[]` (stampanti fisiche non fiscali). Una stampante di rete, anche se usata accanto al flusso fiscale, non deve essere marcata come RT.

## Stato attuale rilevato

Backend gia presente:

- `backend/modules/configuration/configuration-snapshot.js`
  - espone `locale`;
  - espone `activities`;
  - espone `rooms`;
  - espone `activityRoomBindings`;
  - espone `workstations`;
  - espone `printers`;
  - espone `fiscalDevices`;
  - espone `staffAssignments`;
  - espone `menuScopes`.
- Endpoint:
  - `POST /api/settings/configuration/snapshot`;
  - `POST /api/settings/pos`;
  - `POST /api/settings/pos/areas`;
  - `POST /api/settings/pos/areas/save`.
- `posSettings.areas` contiene gia:
  - `menuIds`;
  - `waiterUserIds`;
  - `printerIds`;
  - `cashPoints`;
  - `workstations`.
- `posSettings.areaMenus` contiene scope menu per area.
- `posSettings.printers` contiene stampanti fisiche generiche/produzione non fiscali.
- `posSettings.fiscalDevices` contiene RT e servizi fiscali, inclusi provider API fiscali senza host/porta stampante.
- Le priorita notifiche `ordine`, `consegna`, `ritiro` esistono nei moduli notifiche.
- Prenotazioni:
  - backend modulare in `backend/modules/reservations`;
  - mobile usa API reali con fallback locale;
  - supporta `arrived`, `no_show`, `released`, `cancelled`, `delete`;
  - supporta lock modifica;
  - supporta piu tavoli;
  - supporta gap minimo tra prenotazioni sullo stesso tavolo;
  - esiste logica di attivazione entro 30 minuti e gruppo tavoli.
- Pizza in Riva:
  - costanti dedicate;
  - sala `room_pizza_in_riva`;
  - tavolo unico;
  - utente Francesca;
  - stampante preconto aggiuntiva `192.168.1.36`.

## Problemi concreti rilevati

1. Persistenza incompleta della configurazione nuova.
   `sanitizePosSettings()` e i payload impostazioni non preservano ancora in modo completo:
   - `locale`;
   - `activities`;
   - `activityRoomBindings`.

2. Salvataggio aree incompleto.
   `POST /api/settings/pos/areas/save` salva:
   - `areas`;
   - `areaMenus`;
   - `printers`.
   Non salva ancora:
   - `locale`;
   - `activities`;
   - `activityRoomBindings`.

3. Frontend impostazioni incompleto.
   Il frontend `settings-frontend` attuale e' distribuito come `dist` e gestisce:
   - metodi pagamento;
   - utenti;
   - menu;
   - areaMenus;
   - printers;
   - areas.
   Non ha ancora una sezione strutturata per:
   - locale;
   - attivita;
   - binding attivita-sale.

4. Runtime non ancora unificato sullo snapshot.
   Mobile/postazione usano ancora API operative separate per sale/menu/postazioni e non consumano centralmente lo snapshot completo.

5. Prenotazioni multi-tavolo da verificare end-to-end.
   La logica esiste, ma va verificato che:
   - la prenotazione multi-tavolo unisca i tavoli al momento effettivo;
   - la liberazione ridivida i tavoli;
   - un tavolo occupato non venga forzato fuori dall'operatore;
   - dopo 30 minuti di ritardo chieda scelta operativa, non agisca in automatico distruttivo.

6. Routing stampanti/RT da rendere esplicito sul modello Attivita+Sala.
   I dati esistono (`printers`, `cashPoints`, `workstations`), ma serve una matrice chiara:
   - attivita -> RT/fiscalita/stampanti fiscali;
   - sala -> tavoli/personale/stampanti non fiscali/menu aggiuntivi;
   - activityId+roomId -> contesto operativo risolto;
   - postazione -> attivita/categorie -> stampante;
   - Francesca/Pizza in Riva -> preconto aggiuntivo.

7. Cancellazione tavolo admin parziale.
   Esistono riferimenti a `table_cancel_full`, `tableCancellationId`, ticket e statistiche, ma va verificata la disponibilita dalla modale admin e la stampa ticket con motivo.

## Invarianti da non rompere

- Tutti i flussi operativi devono essere deterministici: a parita di stato iniziale, input, utente, device, sala, postazione e configurazione, l'esito deve essere sempre lo stesso.
- Non sono accettabili comportamenti dipendenti da ordine casuale di array, race tra refresh, cache residue, fallback impliciti, stato fantasma, "prima risposta che capita" o combinazioni non modellate.
- Ogni flusso critico deve avere stati espliciti, transizioni ammesse, transizioni vietate e stato terminale chiaro.
- Ogni fallback deve essere dichiarato, tracciabile e limitato; dove non esiste una configurazione valida, il sistema deve mostrare errore operativo chiaro invece di scegliere una stampante, RT, sala, postazione o utente "a caso".
- Le code condivise, notifiche, stampa, fiscalita, pagamenti, prenotazioni, cambio tavolo/sala e assegnazione postazioni devono essere idempotenti o protette da chiavi/stati che impediscano doppi effetti.
- Ogni correzione futura deve ridurre ambiguita e non aggiungere branch puntuali non testati.
- Non cambiare prezzi lato frontend.
- Non duplicare fiscalita o scontrini.
- Non rompere stampa comanda/preconto.
- Non rimuovere `room_gazebo`, `room_pizza_in_riva` o permessi reali.
- Non reintrodurre fallback statici mobile.
- Non buttare fuori operatori da tavoli occupati per una prenotazione.
- Non perdere pagamenti o storico scarico utente.
- Non rendere pubbliche route mutative senza policy.
- Non riavviare servizi se non richiesto.
- Ogni ciclo deve aggiornare questa memoria prima della chiusura del turno.
- In caso di riavvio o cambio operatore, lo stato del lavoro deve essere riprendibile da questo file senza affidarsi alla chat.
- Se verra richiesta notifica WhatsApp reale, serve configurare un provider/API dedicato; al momento nel progetto non e' presente una integrazione WhatsApp.
- Mobile: modifiche a sale, tavoli o configurazione sala devono aggiornare a caldo la sezione tavoli senza riavvio dell'app.
- Mobile: il refresh sale/tavoli deve comportarsi come il refresh menu in background, aggiornando dati e grafica senza logout, reload completo o cambio sala visibile non richiesto.
- Mobile: se la sala corrente resta presente e autorizzata, deve rimanere selezionata durante il refresh; se non e' piu disponibile, solo allora si puo scegliere una fallback reale tra le sale abilitate.

## Regola aggiornamento e ripresa lavori

Ogni modifica su questa area deve aggiornare almeno:

- backup di riferimento se creato;
- fase corrente;
- file modificati;
- test eseguiti;
- test non eseguiti;
- rischio residuo;
- prossimo step operativo;
- percentuale indicativa di avanzamento;
- eventuale necessita di riavvio.

Stato ripresa corrente:

- Fase corrente: Fase 1 completata, Fase 2A mobile hot-refresh completata, Fase 2B snapshot postazioni completata, Fase 2C monitor configurazione completata, Fase 2D routing stampanti/RT completata, Fase 2E assegnazioni sala-menu-personale completata, Fase 2F editor guidato RT/postazioni completata, Fase 2G priorita notifiche personale completata.
- Ultimo intervento completato: dettaglio utente impostazioni aggiornato con gestione priorita notifiche Ordine/Consegna/Ritiro e snapshot reso compatibile con formato lista/oggetto.
- Ultimi test: tutti verdi nella sezione "Test eseguiti nel ciclo corrente".
- Riavvio effettuato: no.
- Prossima azione consigliata: costruire UI impostazioni guidata per attivita/sale/stampanti/RT/postazioni/personale e far consumare lo snapshot arricchito anche a postazione.
- Requisito mobile aggiunto: cambio sale/tavoli/configurazione deve propagarsi a caldo nella sezione tavoli come refresh menu in background.
- Punto sicuro rollback: `/home/amalia/Downloads/backup-config-sale-20260604-032629.zip`.

## Piano operativo

Fase 1, backend configurazione minima:

- far preservare a `sanitizePosSettings()`:
  - `locale`;
  - `activities`;
  - `activityRoomBindings`;
- includere questi campi in `buildPosSettingsPayload()`;
- farli accettare da `/api/settings/pos/areas/save`;
- aggiungere test backend.

Fase 2, frontend impostazioni:

- aggiungere a `settings-frontend` la gestione di:
  - locale;
  - attivita;
  - binding attivita-sale;
- salvare questi campi tramite `/api/settings/pos/areas/save`;
- mantenere compatibilita col dist attuale se manca sorgente.
- predisporre il refresh mobile a caldo per modifiche sale/tavoli/configurazione senza riavvio.

Fase 3, consumo runtime:

- mobile/prenotazioni devono usare sale abilitate e configurazione reale;
- postazione deve leggere postazioni reali, non mock;
- monitor deve mostrare attivita/sale/postazioni/stampanti/RT coerenti.
- mobile sezione tavoli: il refresh delle sale disponibili e' stato reso periodico e non invasivo; resta da estendere lo stesso principio a eventuali snapshot piu ampi di configurazione operativa.
- snapshot configurazione: le postazioni ora includono `roomIds`, `printerIds`, `cashPointIds`, `type` e `source`, cosi i consumatori possono distinguere postazioni operative e cash point senza euristiche fragili.
- monitor: legge `/api/settings/configuration/snapshot` quando e' disponibile una sessione admin e mostra un riepilogo configurazione reale senza bloccare la vista se lo snapshot non e' raggiungibile.
- routing stampanti/RT legacy: lo snapshot v1 includeva `printerAssignments` derivati da configurazione reale (`areas.printerIds`, `areas.cashPoints`, `areas.workstations`), senza creare postazioni o stampanti mock. Nel modello v2 le RT operative devono essere risolte solo dall'Attivita; i dati fiscali su sala/cash point restano solo legacy/migrazione.
- assegnazioni sala-menu/personale: lo snapshot ora include `roomMenuAssignments` e `roomStaffAssignments`, derivati da `areas.menuIds`, `areas.waiterUserIds`, `user.enabledRoomIds` e `user.authorizedRoomIds`, senza assegnazioni inventate.
- impostazioni legacy: la schermata aree mostrava una matrice operativa per sala con menu/listini, personale, stampanti, RT/cash point e postazioni. Nel modello v2 RT/fiscalita vanno spostate su Attivita; la sala gestisce solo tavoli/personale/stampanti non fiscali/menu o listini aggiuntivi.
- impostazioni: nella tabella `Aree operative`, i collegamenti `menuIds`, `waiterUserIds` e `printerIds` sono modificabili con checkbox reali invece che con CSV manuale.
- impostazioni legacy: nella tabella `Aree operative`, `cashPoints` e `workstations` erano modificabili con card guidate. I cash point fiscali di sala non sono piu modello operativo; possono restare solo come sezione Legacy/Migrazione.
- impostazioni: nel dettaglio utente si configurano le priorita notifiche `ordine`, `consegna`, `ritiro`; la tabella utenti ne mostra il riepilogo.
- snapshot configurazione: `notificationPriorities` del personale supporta sia formato lista runtime sia formato oggetto legacy.
- no mock runtime: rimossa dal mobile la dicitura utente `mock: lorenzo / 1234` nel flusso cambio sala; i riferimenti mock rimasti sono limitati a test, endpoint legacy debug o fallback esplicitamente dietro flag.

## Audit logica e impostazioni - 2026-06-05 03:30 Europe/Rome

File dettagliato creato:

- `/srv/applicazione/current/LOGIC_SETTINGS_AUDIT_MEMORY.md`

Esito sintetico:

- permessi Gazebo e riferimenti incrociati aree/utenti/stampanti/RT/postazioni: OK;
- operational context attivita/sala/postazione: OK sui casi Bar/Gazebo e Pizza in Riva;
- prenotazioni, notifiche, pausa, bridge mobile/postazione: test mirati OK;
- trovati bug/config gap da correggere:
  - nessun articolo/categoria menu ha routing verso postazioni (`stations/stationIds/workstationIds` vuoti);
  - duplicati attivi `Hendrick's` e `N°3`;
  - 41 articoli attivi sono presenti in `menuItems` ma non referenziati dal `menu_main`;
  - postazioni richieste `CHIRINGUITO-1`, `CHIRINGUITO-2`, `MOBILE` assenti dal DB;
  - policy Pizza in Riva/Francesca ancora in parte cablata nel monolite;
  - storico print spool punta alla vecchia stampante `printer_bar_principale_1921681127_9100`;
  - 3 pagamenti storici puntano ancora a `u_niccolo`/`niccolo` dopo rename a `bardo`;
  - policy impostazioni per mobile devices, pause, notifiche e assegnazioni non ancora persistite come modello esplicito;
  - snapshot legacy non allineato su `precontoPrinterIds`.

Priorita consigliata:

1. routing menu/postazioni;
2. deduplica e riallineamento menu strutturato;
3. rimozione hardcode Pizza in Riva/Francesca a favore DB;
4. aggiunta/collegamento postazioni mancanti;
5. retry fiscale e finestra 05:00;
6. alias/migrazione pagamenti `niccolo -> bardo`;
7. alias/migrazione stampante spool storica;
8. persistenza policy impostazioni.

Fase 4, prenotazioni:

- rendere robusto il flusso 30/15/5 minuti;
- se il tavolo e' occupato entro i 30 minuti non forzare liberazione;
- dopo 30 minuti di ritardo proporre `rimanda 10 minuti` o `libera`;
- multi-tavolo: unire quando diventa prenotato effettivo, ridividere alla liberazione.

Fase 5, routing stampa/RT:

- documentare e testare:
  - attivita -> RT/fiscalita/stampanti fiscali;
  - sala -> tavoli/personale/stampanti non fiscali/menu aggiuntivi;
  - activityId+roomId -> contesto operativo risolto;
  - postazione -> attivita/categorie;
  - Pizza in Riva/Francesca -> no fiscale + preconto aggiuntivo.

## Modifiche ciclo corrente

- Creato backup.
- Creato questo file memoria.
- Implementata Fase 1 backend configurazione minima:
  - `sanitizePosSettings()` preserva e normalizza `locale`;
  - `sanitizePosSettings()` preserva e normalizza `activities`;
  - `sanitizePosSettings()` preserva e normalizza `activityRoomBindings`;
  - se non esistono attivita viene creata `activity_default`;
  - se non esistono binding viene creato un binding default tra attivita attiva e sale esistenti;
  - `buildPosSettingsPayload()` espone `locale`, `activities`, `activityRoomBindings`;
  - `/api/settings/pos/areas/save` accetta e salva `locale`, `activities`, `activityRoomBindings`.
- Implementata UI minima in `settings-frontend/dist/assets/settings-app.js`:
  - sezione `Locale`;
  - sezione `Attività`;
  - sezione `Collegamenti attività-sale`;
  - salvataggio dei nuovi campi tramite `/api/settings/pos/areas/save`.
- Aggiunto test regressivo:
  - `backend/tests/configuration-save-contract.test.mjs`.
- Implementata Fase 2A mobile hot-refresh sale/tavoli:
  - `TablesWorkspace` ricarica le sale disponibili ogni 5 secondi in background;
  - se la sala corrente resta presente, non cambia selezione e aggiorna solo il nome se variato;
  - se la sala corrente sparisce o non e' piu autorizzata, passa una sola volta a una fallback reale tra le sale disponibili;
  - quando la fallback cambia, chiude selezione tavolo, sposta, ordine e pagamento per evitare stati UI appesi su sala non piu valida;
  - la griglia tavoli continua a usare il refresh operativo gia presente.
- Aggiunto test statico mobile:
  - `mobile-frontend/tests/static/tablesRoomsHotRefresh.test.ts`.
- Implementata Fase 2B snapshot postazioni/cash point:
  - `configuration-snapshot.js` aggrega postazioni da `settings.workstations`, `area.workstations` e `area.cashPoints`;
  - una postazione condivisa su piu sale viene esposta una sola volta con `roomIds` aggregati;
  - le stampanti collegate vengono esposte in `printerIds`;
  - i cash point restano compatibili con lo snapshot precedente ma sono marcati come `type: "cash_point"`.
- Aggiornato test snapshot:
  - copertura su postazioni per sala, cash point e postazione condivisa multi-sala.
- Implementata Fase 2C monitor configurazione:
  - `monitor-frontend/dist/app.js` carica lo snapshot configurazione con token admin se presente;
  - la sezione `API e Sistema` mostra locale, attivita, sale configurate, postazioni configurate, stampanti/RT e personale;
  - se manca login admin o lo snapshot non risponde, il monitor resta operativo e mostra lo stato degradato.
- Aggiunto test statico monitor:
  - `cassa-frontend/frontend-tests/monitor-configuration-static.test.mjs`.
- Implementata Fase 2D routing stampanti/RT legacy:
  - `configuration-snapshot.js` espone `printerAssignments`;
  - ogni assignment collega `roomId`, `printerId`, host/porta, `targetType` (`room`, `cash_point`, `workstation`), `targetId`, `purpose`, `fiscal` e `source`;
  - `rooms` includeva anche `fiscalPrinterIds` e `cashPointIds`, ora da considerare solo migrazione/diagnostica legacy;
  - `fiscalDevices` include RT/API fiscali e deve essere assegnato operativamente tramite Attivita; host/porta sono propri delle stampanti fisiche in `printers`;
  - monitor mostra il conteggio `Routing stampe`.
- Rimosso testo mock visibile dal mobile:
  - `SettingsPage.tsx` mostra richiesta autorizzazione responsabile senza credenziali finte;
  - `MenuWorkspace.tsx` descrive il fallback come catalogo generale reale, non mock;
  - `auth.ts` descrive il fallback come sviluppo locale, non mock runtime;
  - build mobile eseguito, quindi `mobile-frontend/dist` e' aggiornato.
- Aggiunto test statico mobile:
  - `mobile-frontend/tests/static/noRuntimeMockCopy.test.ts`.
- Implementata Fase 2E assegnazioni sala-menu-personale:
  - `configuration-snapshot.js` espone `roomMenuAssignments`;
  - `configuration-snapshot.js` espone `roomStaffAssignments`;
  - ogni assegnazione personale conserva `assignmentTypes`, `sources` e `notificationPriorities`;
  - ogni assegnazione menu conserva categorie e sorgente reale;
  - monitor espone conteggi `Menu per sala` e `Personale per sala`;
- impostazioni espone una `Matrice operativa sale` per controllare sala, menu/listini, personale, stampanti, RT/cash point e postazioni senza mock.
  - nota legacy: questa matrice deve essere riallineata al modello v2; RT/cash point non devono restare nella configurazione operativa della sala.
- Migliorata UI impostazioni aree:
  - `menuIds` su area usa checkbox dai menu reali configurati;
  - `waiterUserIds` su area usa checkbox dagli utenti reali;
  - `printerIds` su area usa checkbox dalle stampanti/RT reali;
  - il payload salvato resta invariato e compatibile con `/api/settings/pos/areas/save`.
- Implementata Fase 2F editor guidato RT/postazioni legacy:
  - `cashPoints` su area usa card guidate invece del JSON libero;
  - ogni cash point gestisce `name`, `code`, `fiscalPrinterId`, `printerIds`, `active`;
  - `workstations` su area usa card guidate invece del JSON libero;
  - ogni postazione gestisce `name`, `stationName`, `printerIds`, `active`;
  - aggiunta gestione aggiungi/rimuovi per cash point e postazioni;
  - il payload resta retrocompatibile con gli array gia letti dal backend, ma `fiscalPrinterId` su sala/cash point non guida il modello operativo v2.
- Implementata Fase 2G priorita notifiche personale:
  - aggiunte checkbox `Ordine`, `Consegna`, `Ritiro` nella modale utente;
  - aggiunto riepilogo `Priorità notifiche` nella tabella utenti;
  - `notificationPriorities` viene normalizzato come lista compatibile col routing notifiche runtime;
  - lo snapshot configurazione interpreta correttamente sia lista sia oggetto legacy;
  - test snapshot aggiornato per coprire il formato lista.

## Test da eseguire a ogni ciclo

- `node --test backend/tests/configuration-snapshot.test.mjs`
- `npm run check:backend`
- `npm run gate:architecture-security`
- test prenotazioni mirati se si tocca prenotazioni
- test mobile statici se si tocca mobile

## Test eseguiti nel ciclo corrente

- `node --check backend/server.js` OK;
- `node --check backend/modules/settings/settings.handlers.js` OK;
- `node --check settings-frontend/dist/assets/settings-app.js` OK;
- `node --test backend/tests/configuration-save-contract.test.mjs backend/tests/configuration-snapshot.test.mjs` OK, 6/6;
- `npm run check:backend` OK;
- `npm run gate:architecture-security` OK;
- `npm run audit:architecture-security` OK, finding bloccanti 0;
- `node --test backend/tests/route-policy-architecture.test.mjs` OK, 5/5.
- `cd mobile-frontend && npm run typecheck` OK;
- `cd mobile-frontend && npx vitest run tests/static/tablesRoomsHotRefresh.test.ts tests/static/tablesRoomLongPress.test.ts tests/static/tableHistorySync.test.ts` OK, 3 file e 10 test.
- `cd cassa-frontend && node --check backend/modules/configuration/configuration-snapshot.js` OK;
- `cd cassa-frontend && node --test backend/tests/configuration-snapshot.test.mjs backend/tests/configuration-save-contract.test.mjs` OK, 7/7;
- `cd cassa-frontend && npm run check:backend` OK;
- `cd cassa-frontend && npm run gate:architecture-security` OK.
- `node --check settings-frontend/dist/assets/settings-app.js` OK dopo editor guidato RT/postazioni;
- `cd cassa-frontend && node --test backend/tests/configuration-save-contract.test.mjs backend/tests/configuration-snapshot.test.mjs frontend-tests/monitor-configuration-static.test.mjs` OK, 10/10 dopo editor guidato RT/postazioni;
- `cd cassa-frontend && npm run check:backend` OK;
- `cd cassa-frontend && npm run gate:architecture-security` OK;
- `cd cassa-frontend && npm run audit:architecture-security` OK, finding bloccanti 0, warning monolite gia noti.
- `node --check settings-frontend/dist/assets/settings-app.js` OK dopo priorita notifiche;
- `node --check cassa-frontend/backend/modules/configuration/configuration-snapshot.js` OK dopo normalizzazione priorita;
- `cd cassa-frontend && node --test backend/tests/configuration-save-contract.test.mjs backend/tests/configuration-snapshot.test.mjs frontend-tests/monitor-configuration-static.test.mjs` OK, 10/10 dopo priorita notifiche;
- `cd cassa-frontend && npm run check:backend` OK;
- `cd cassa-frontend && npm run gate:architecture-security` OK;
- `cd cassa-frontend && npm run audit:architecture-security` OK, finding bloccanti 0, warning monolite gia noti.
- `node --check monitor-frontend/dist/app.js` OK;
- `cd cassa-frontend && node --test frontend-tests/monitor-configuration-static.test.mjs` OK, 2/2.
- `cd mobile-frontend && npx vitest run tests/static/noRuntimeMockCopy.test.ts tests/static/tablesRoomsHotRefresh.test.ts` OK, 2 file e 3 test;
- `cd mobile-frontend && npm run build` OK;
- `grep -R "mock: lorenzo\|lorenzo / 1234" mobile-frontend/dist mobile-frontend/src` nessun risultato;
- `cd mobile-frontend && npx vitest run tests/static/noRuntimeMockCopy.test.ts` OK, 2/2;
- `grep -R "Fallback mock\|mock: lorenzo\|lorenzo / 1234" mobile-frontend/src mobile-frontend/dist` nessun risultato;
- `cd cassa-frontend && node --test backend/tests/configuration-snapshot.test.mjs backend/tests/configuration-save-contract.test.mjs frontend-tests/monitor-configuration-static.test.mjs frontend-tests/mobile-frontendv2-static.test.mjs` OK, 16/16;
- `cd cassa-frontend && npm run check:backend` OK;
- `cd cassa-frontend && npm run gate:architecture-security` OK.
- `node --check settings-frontend/dist/assets/settings-app.js` OK;
- `cd cassa-frontend && node --test backend/tests/configuration-snapshot.test.mjs backend/tests/configuration-save-contract.test.mjs frontend-tests/monitor-configuration-static.test.mjs` OK, 10/10;
- `cd cassa-frontend && npm run check:backend` OK;
- `cd cassa-frontend && npm run gate:architecture-security` OK;
- `cd cassa-frontend && npm run audit:architecture-security` OK, finding bloccanti 0, warning monolite gia noti.
- `node --check settings-frontend/dist/assets/settings-app.js` OK dopo editor checkbox aree;
- `cd cassa-frontend && node --test backend/tests/configuration-save-contract.test.mjs backend/tests/configuration-snapshot.test.mjs frontend-tests/monitor-configuration-static.test.mjs` OK, 10/10 dopo editor checkbox aree;
- `cd cassa-frontend && npm run check:backend` OK;
- `cd cassa-frontend && npm run gate:architecture-security` OK.

## File modificati nel ciclo corrente

- `CONFIGURATION_ARCHITECTURE_MEMORY.md`;
- `cassa-frontend/backend/server.js`;
- `cassa-frontend/backend/modules/settings/settings.handlers.js`;
- `cassa-frontend/backend/tests/configuration-save-contract.test.mjs`;
- `settings-frontend/dist/assets/settings-app.js`;
- `settings-frontend/dist/assets/settings-app.css`;
- `mobile-frontend/src/pages/home/tables/TablesWorkspace.tsx`;
- `mobile-frontend/tests/static/tablesRoomsHotRefresh.test.ts`;
- `cassa-frontend/backend/modules/configuration/configuration-snapshot.js`;
- `cassa-frontend/backend/tests/configuration-snapshot.test.mjs`;
- `monitor-frontend/dist/app.js`;
- `cassa-frontend/frontend-tests/monitor-configuration-static.test.mjs`;
- `cassa-frontend/backend/tests/configuration-save-contract.test.mjs`;
- `mobile-frontend/src/pages/SettingsPage.tsx`;
- `mobile-frontend/src/pages/home/menu/MenuWorkspace.tsx`;
- `mobile-frontend/src/api/auth.ts`;
- `mobile-frontend/tests/static/noRuntimeMockCopy.test.ts`;
- `mobile-frontend/dist/index.html`;
- `mobile-frontend/dist/assets/*` rigenerati dal build mobile.

## Stato dopo Fase 1

La configurazione locale-attivita-sale non e' piu solo uno snapshot read-only:

- viene normalizzata nel modello `posSettings`;
- viene restituita dai payload impostazioni;
- puo essere salvata dalla UI impostazioni;
- resta compatibile con configurazioni legacy prive di attivita.

## Prossimo step consigliato

Fase 2:

- rendere la UI impostazioni meno tabellare e piu guidata per:
  - attivita;
  - sale;
  - binding attivita-sale;
  - RT/fiscalita per attivita;
  - stampanti non fiscali per sala;
  - postazioni per attivita/sala;
  - personale per sala e priorita notifiche;
- aggiungere refresh runtime mobile/postazione per modifiche sale/tavoli/configurazione senza riavvio;
- testare che il mobile aggiorni la griglia tavoli a caldo senza cambiare sala selezionata se ancora valida;
- aggiungere un endpoint o payload dedicato per snapshot configurazione operativa se il frontend impostazioni deve diventare il pannello principale;
- aggiungere test per salvataggio reale via endpoint, non solo contract statico.
- far consumare `roomMenuAssignments`, `roomStaffAssignments` e `printerAssignments` anche da postazione/mobile dove oggi servono euristiche locali;
- implementare editor guidati per assegnare RT/fiscalita/menu principali/stampanti/postazioni alle attivita e solo personale/menu aggiuntivi/stampanti non fiscali alle sale.

## Stato avanzamento

- Modello configurazione: parziale, circa 42%.
- Backend snapshot: presente, circa 70%.
- Backend persistenza completa: parziale, circa 58%.
- Frontend impostazioni nuovo modello: parziale, circa 35%.
- Frontend impostazioni nuovo modello: parziale, circa 66%.
- Mobile/postazione/monitor consumo configurazione unificata: parziale, circa 55%.
- Mobile hot-refresh sale/tavoli: implementato per sezione tavoli, circa 75%.
- Snapshot postazioni/cash point: implementato, circa 80%.
- Monitor configurazione operativa: implementato, circa 78%.
- Routing stampanti/RT v2 activity+room: da riallineare, circa 35%.
- Menu/personale per sala: parziale avanzato, circa 60%.
- Priorita notifiche personale: implementato lato impostazioni/snapshot, circa 75%.
- Prenotazioni multi-tavolo/finestre: parziale, circa 55%.
- No mock runtime visibile: parziale avanzato, circa 72%.

## Aggiornamento 2026-06-04 - Menu, listini e schedulazioni impostazioni

Modello dati e backend:

- aggiunto `backend/modules/menu/menu-configuration.js` per normalizzare menu, categorie, prodotti, listini e regole orarie;
- estratto `migrateDbSecurity` in `backend/modules/app-state/security-migration.js` per mantenere `server.js` sotto il budget architetturale senza cambiare comportamento;
- `posSettings` ora preserva `menus`, `priceLists`, `priceListSchedules`, `menuSchedules` e mantiene `areaMenus` solo come compatibilita legacy;
- i prodotti preservano campi operativi: `vatRate`/IVA, `vatCode`, `priceListPrices`, `workstationIds`, `stationIds`, `menuIds`, allergeni, tag, SKU, barcode, unita, reparto, varianti e schedulazioni legacy prodotto;
- lo snapshot v2 espone `menus`, `priceLists`, `priceListSchedules`, `menuSchedules` e risolve nei `resolvedContexts` menu/listini base + fasce attive di Attivita + fasce attive di Sala;
- il backend resta sorgente autorevole per prezzi/listini: il frontend impostazioni modifica configurazione, ma runtime/mobile/postazione non devono calcolare prezzi autoritativi.

Frontend impostazioni:

- `settings-frontend` dispone solo di `dist`; la modifica UI e' una patch temporanea sul bundle distribuito, da spostare in sorgenti/build appena disponibili;
- sezione Menu aggiornata con:
  - lista Menu con categorie e prodotti;
  - lista Listini con prezzi per prodotto;
  - fasce orarie globali di cambio listino;
  - dettaglio prodotto con IVA, codici, allergeni/tag, varianti, postazioni vendita e prezzi per listino;
- modali Attivita e Sala aggiornate:
  - Attivita: RT/API fiscale, menu principali, listini principali, stampanti non fiscali, postazioni, cambio menu/listino automatico;
  - Sala: personale, menu/listini aggiuntivi, stampanti non fiscali, cambio menu/listino automatico;
  - nessuna RT operativa proposta nella Sala.

Test/verifiche aggiunte:

- `node --check settings-frontend/dist/assets/settings-app.js` OK;
- `node --check backend/modules/menu/menu-configuration.js` OK;
- `node --check backend/modules/menu/menu.domain.js` OK;
- `node --check backend/modules/menu/menu.handlers.js` OK;
- `node --check backend/modules/configuration/operational-context.js` OK;
- `node --check backend/modules/configuration/configuration-snapshot.js` OK;
- `node --check backend/server.js` OK;
- `node --check backend/modules/app-state/security-migration.js` OK;
- `node --test --test-concurrency=1 backend/tests/configuration-snapshot.test.mjs` OK, 7/7;
- `node --test --test-concurrency=1 backend/tests/configuration-save-contract.test.mjs` OK, 4/4;
- `node --test --test-concurrency=1 backend/tests/settings-room-table-policy.e2e.test.mjs` OK, 4/4.
- `npm run check:backend` OK;
- `npm run gate:architecture-security` OK, `server.js` 27389 righe.

Rischio residuo:

- UI impostazioni patchata nel dist, quindi debito tecnico esplicito;
- postazione/mobile devono ancora consumare completamente menu/listini temporizzati dal backend nei flussi runtime;
- `areaMenus` resta solo per compatibilita di migrazione, non come modello target.

Aggiornamento autosave:

- `settings-frontend/dist/assets/settings-app.js` ora salva su DB direttamente da `Salva` modale;
- modifiche inline/checkbox e aggiunte/rimozioni nelle impostazioni schedulano autosave sul relativo endpoint backend;
- endpoint usati:
  - configurazione infrastruttura: `/api/settings/pos/areas/save`;
  - utenti/ACL: `/api/settings/pos/users/save`;
  - menu/listini/prodotti/fasce: `/api/settings/menu`;
- verifica HTTP sul bundle servito da `/impostazioni/`: funzioni `scheduleAutoSaveForPath` e `persistModalSave` presenti.

## Aggiornamento 2026-06-04 - Riallineamento da `sistemaversocassa.zip`

Origine:

- zip sorgente usato: `/home/amalia/Downloads/sistemaversocassa.zip`;
- backup pre-update creato: `/home/amalia/Downloads/backup-pre-update-sistemaversocassa-20260604-144716.zip`;
- SHA256 backup: `1fbd88bf9dd9724cfa0d5808da210d9d73155f28924b001bccfe22fe2ac67804`.

Configurazione applicata nello staging prima del deploy:

- sale reali e virtuali configurate in `posSettings.areas`:
  - `room_attesa_virtuale` - Attesa virtuale - 10 tavoli;
  - `room_bar` - Bar - 10 tavoli;
  - `room_gazebo` - Gazebo - 25 tavoli;
  - `room_pedana` - Pedana - 20 tavoli;
  - `room_pizza_in_riva` - Pizza in Riva - 1 tavolo;
  - `room_spiaggia` - Spiaggia - 26 tavoli;
  - `room_terrazza` - Terrazza - 25 tavoli.
- tavoli normalizzati e ricreati in `posSettings.tables`: 117 tavoli totali, tutti con `roomId` coerente;
- utenti riallineati: `admin`, `giada`, `chiara`, `gianluca`, `loredemu`, `lorenzo`, `anna`, `bardo`, `noemi`, `emma`, `aurora`, `brendon`, `francesca`;
- tutti gli utenti operativi, tranne Francesca, hanno permessi/abilitazioni equivalenti a Giada/Admin su sale, pagamenti e impostazioni;
- Francesca resta configurata con policy speciale:
  - `fiscalExcluded: true`;
  - `fiscalPolicy: no_fiscal_auto_paid`;
  - `autoPaidNoFiscal: true`;
  - nessun metodo pagamento abilitato;
  - postazione dedicata `workstation_pizza_in_riva`.

Gerarchia operativa confermata:

- Locale: `locale_amalia`;
- Attivita:
  - `activity_bar`;
  - `activity_ristorante`;
  - `activity_spiaggia`;
  - `activity_pizza_in_riva`.
- RT fiscale solo su Attivita:
  - `rt_bar_api` su `activity_bar`, `activity_ristorante`, `activity_spiaggia`;
  - nessuna RT su `activity_pizza_in_riva`.
- Sale:
  - ereditano RT dall'Attivita collegata;
  - possono avere personale e stampanti non fiscali;
  - non devono avere RT propria.
- Postazioni configurate:
  - `workstation_bar_1` (`BAR-1`);
  - `workstation_bar_2` (`BAR-2`);
  - `workstation_ristorante`;
  - `workstation_spiaggia`;
  - `workstation_pizza_in_riva`.
- Stampanti non fiscali configurate:
  - `printer_bar_1921681195_9100` -> `192.168.1.102:9100`;
  - `printer_pizza_in_riva_192168136_9100` -> `192.168.1.36:9100`.

Elementi cablati trovati nel codice e riportati nella configurazione:

- Pizza in Riva / Francesca:
  - sala `room_pizza_in_riva`;
  - tavolo `room_pizza_in_riva_t01`;
  - utente `francesca`;
  - stampante preconto `192.168.1.36:9100`;
  - esclusione fiscale e auto-pagato non fiscale.
- Fallback tecnici:
  - `room_attesa_virtuale` resta come sala virtuale di sicurezza;
  - fallback Pedana/Gazebo nel backend resta solo come rete di protezione, ma le sale reali sono ora nel DB.
- Endpoint/strutture nuove impostazioni:
  - `activities`;
  - `activityRoomBindings`;
  - `fiscalDevices`;
  - `workstations`;
  - `areaMenus`.

Test/verifiche eseguite sullo staging:

- validazione JSON `app-state.json`: OK;
- `node --check backend/server.js`: OK;
- `node --check backend/modules/configuration/configuration-snapshot.js`: OK;
- `node --check backend/modules/configuration/operational-context.js`: OK;
- `node --test backend/tests/configuration-snapshot.test.mjs backend/tests/configuration-save-contract.test.mjs backend/tests/settings-room-table-policy.e2e.test.mjs`: OK, 15/15.

Rischi residui:

- alcune costanti Pizza in Riva restano nel backend come rete di migrazione/sicurezza; il DB ora contiene gli stessi dati, ma il cleanup del cablato va fatto in una fase successiva e testata;
- `settings-frontend` e' ancora distribuito prevalentemente da bundle `dist`, quindi eventuali patch future vanno consolidate appena i sorgenti completi saranno disponibili;
- Terrazza e Spiaggia sono state ricostruite dai dati storici disponibili: Terrazza 25 tavoli, Spiaggia 26 tavoli.

## Aggiornamento ciclo 2026-06-04 - preconto totale completo/attuale

Richiesta:

- dal dettaglio tavolo mobile, pressione lunga su pagamento/preconto deve offrire due opzioni:
  - `Preconto completo`: stampa preconto classico con tutti gli articoli delle comande selezionate/visibili;
  - `Preconto attuale`: stessa stampa classica con tutti gli articoli, aggiungendo in fondo quota gia' pagata e rimanenza.

Modifiche applicate:

- `mobile-frontend/src/api/printing.ts`:
  - il mobile non costruisce piu' testo sintetico per il preconto totale;
  - invia a `/api/integration/print` `tablePreconto: true`, `tablePrecontoMode`, `tableId`, `tableLabel`, `orderIds` e `amountDue`.
- `mobile-frontend/src/pages/home/tables/components/TableDetailPanel.tsx`:
  - mini-modale preconto con due pulsanti: `Preconto completo` e `Preconto attuale`;
  - toast coerente con la scelta.
- `mobile-frontend/src/styles/tables.css`:
  - stile separato per il pulsante `Preconto attuale`.
- `cassa-frontend/backend/server.js`:
  - aggiunto builder read-only di preconto tavolo aggregato;
  - il backend aggrega le comande reali senza salvarne una nuova;
  - il preconto totale usa `buildIntegrationPrecontoPrintTextWithOptions()` come un preconto classico;
  - modalita' `current` aggiunge `GIA' PAGATO` e `RIMANENZA` in fondo.

Test eseguiti:

- `node --check /srv/applicazione/current/cassa-frontend/backend/server.js`: OK.
- `node --check /srv/applicazione/current/settings-frontend/dist/assets/settings-app.js`: OK.
- `node --check /srv/applicazione/current/cassa-frontend/backend/modules/configuration/configuration-snapshot.js`: OK.
- `node --check /srv/applicazione/current/cassa-frontend/backend/modules/configuration/operational-context.js`: OK.
- `npm run typecheck` in `mobile-frontend`: OK.
- `npm run build` in `mobile-frontend`: OK, dist aggiornato.
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 7/7.

Nota operativa:

- il dist mobile e' aggiornato;
- la logica backend del preconto aggregato richiede restart/ricarica del servizio backend per essere attiva nel processo in esecuzione;
- nessun servizio e' stato riavviato durante questo ciclo.

## Aggiornamento ciclo 2026-06-04 - routing preconto totale su attivita corretta

Problema rilevato:

- alcuni `Preconto completo` / `Preconto attuale` aggregati del tavolo potevano finire su una stampante non dell'attivita Bar;
- il ramo backend `tablePreconto` creava un ordine sintetico per la stampa, ma inizialmente non propagava in modo completo il contesto operativo `activityId + roomId` della comanda reale;
- senza contesto operativo il routing poteva cadere su fallback legacy o su vecchi target di stampa.

Configurazione letta dal DB:

- `activity_bar`:
  - `printerIds`: `printer_bar_1921681195_9100`;
  - `precontoPrinterIds`: vuoto, quindi eredita `printerIds`;
  - sale collegate: `room_attesa_virtuale`, `room_bar`, `room_gazebo`, `room_pedana`, `room_spiaggia`, `room_terrazza`.
- `activity_pizza_in_riva`:
  - `printerIds`: `printer_pizza_in_riva_192168136_9100`.

Fix applicato:

- `cassa-frontend/backend/server.js`:
  - `buildTablePrecontoPrintableOrder()` ora conserva/ricostruisce `operationalSnapshot` sul preconto sintetico;
  - se manca lo snapshot storico, il backend deriva `activityId` dal binding `activityRoomBindings` della sala;
  - nel ramo `/api/integration/print` con `tablePreconto: true`, il payload passa da `withOrderOperationalRoutingPayload()`;
  - il target legacy viene usato solo se non esiste routing operativo `activityId + roomId`;
  - non viene riusato il target di un preconto precedente, per evitare di replicare una stampa gia' indirizzata male.

Test eseguiti:

- `node --check /srv/applicazione/current/cassa-frontend/backend/server.js`: OK.
- `node --check /srv/applicazione/current/cassa-frontend/backend/modules/configuration/operational-context.js`: OK.
- `node --check /srv/applicazione/current/cassa-frontend/backend/modules/configuration/configuration-snapshot.js`: OK.
- `node --test backend/tests/print-utils-core.test.mjs`: OK, 4/4.
- verifica read-only su `app-state.json`: OK, Bar eredita correttamente la stampante `192.168.1.102`.

Nota operativa:

- la correzione backend richiede restart/ricarica del servizio backend per essere attiva nel processo in esecuzione;
- nessun servizio e' stato riavviato durante questo ciclo.

## Aggiornamento ciclo 2026-06-04 - audit discrepanze stampa Bar/Pizza

Problema ricercato:

- ordini o preconti dell'attivita Bar che potevano essere indirizzati o ristampati su una stampante non coerente, ad esempio Pizza in Riva;
- riuso di target spool storici con vecchi ID stampante;
- fallback globale ambiguo quando esistono piu' stampanti attive.

Esito audit read-only:

- configurazione attuale senza riferimenti mancanti:
  - `activity_bar` -> `printer_bar_1921681195_9100` (`192.168.1.102`);
  - `activity_pizza_in_riva` -> `printer_pizza_in_riva_192168136_9100` (`192.168.1.36`);
- rilevati 35 job storici nello spool con vecchio target `printer_bar_principale_1921681127_9100` / `BAR PRINCIPALE`;
- i job storici spiegano il rischio di ristampe/preconti che si trascinano dietro un target non piu' allineato alla nuova architettura.

Fix applicato:

- `cassa-frontend/backend/server.js`:
  - aggiunto `hasOperationalPrintRouting()`;
  - aggiunto `withOrderPrintOperationalRoutingPayload()` per completare `activityId`, `roomId` e `tableId` quando derivabili dalla comanda o dai binding sala-attivita;
  - le ristampe `kind: order` e `kind: preconto` ora usano il routing operativo se disponibile;
  - i target legacy dello spool vengono usati solo quando manca il routing operativo;
  - il fallback stampante globale non sceglie piu' arbitrariamente la prima stampante se ci sono piu' stampanti attive compatibili;
  - il fallback normalizza `purpose`, cosi' una stampante generica con valore mancante/non normalizzato non viene esclusa per errore.

Test eseguiti:

- `node --check /srv/applicazione/current/cassa-frontend/backend/server.js`: OK.
- `node --test backend/tests/print-utils-core.test.mjs`: OK, 4/4.
- audit read-only su `app-state.json`: configurazione corrente OK, discrepanze residue solo storiche nello spool.

Nota operativa:

- nessuno spool storico e' stato cancellato;
- la correzione backend richiede restart/ricarica del servizio backend per essere attiva nel processo in esecuzione;
- nessun servizio e' stato riavviato durante questo ciclo.

## Aggiornamento ciclo 2026-06-04 - no fallback stampanti e RT

Regola richiesta:

- non devono esistere fallback automatici su stampanti o RT;
- se il contesto indica una stampante/RT, si usa quella;
- se quella stampante/RT non e' configurata, non e' attiva o non e' raggiungibile come configurazione, il sistema deve fermarsi con errore;
- non si deve mai stampare sulla prima stampante attiva, su una stampante di sistema/default o su una RT globale non indicata dalla configurazione.

Fix applicato:

- `cassa-frontend/backend/server.js`:
  - `pickPrinterFromIds()` non degrada piu' da fiscale a generica o da non fiscale a fiscale;
  - `resolvePrinterFromSettings()` non usa piu':
    - fallback su area cash point;
    - fallback da postazione a cash point;
    - fallback station;
    - fallback prima stampante attiva;
    - host esplicito fuori configurazione;
  - se `printerId` e' indicato ma non e' attivo/configurato, la risoluzione fallisce;
  - se una postazione usa stampanti proprie e queste non sono disponibili, non ripiega sulla sala;
  - `supportsLocalDefaultPrintFallback()` restituisce sempre `false`;
  - `enqueuePrintSpoolJob()` blocca la creazione del job se non esiste una stampante risolta;
  - il worker spool non manda piu' file a stampanti di sistema/default quando manca `printerHost`;
  - il messaggio operativo diventa `Stampante non disponibile per la configurazione indicata.`;
  - la verifica RT fiscale usa solo `posSettings.fiscalDevices[]`, non piu' stampanti fiscali legacy;
  - ogni job/ricevuta fiscale POS salva `fiscalDeviceId`, `fiscalApiBaseUrl` ed endpoint della RT;
  - retry e ristampa fiscale POS usano la RT salvata nella ricevuta/job, non l'URL fiscale globale come fallback;
  - una RT senza `apiBaseUrl` non viene considerata disponibile.

Test eseguiti:

- `node --check /srv/applicazione/current/cassa-frontend/backend/server.js`: OK.
- `node --test backend/tests/print-utils-core.test.mjs`: OK, 4/4.
- audit read-only su `app-state.json`:
  - stampanti attive: Pizza in Riva `192.168.1.36`, Bar `192.168.1.102`;
  - RT attiva: `rt_bar_api` su `http://192.168.1.200:8765`;
  - job pendenti senza `printerHost`: 0.

Nota operativa:

- questa modifica e' volutamente piu' severa: vecchi job o payload legacy senza contesto/configurazione stampante non verranno stampati su default, ma falliranno con errore chiaro;
- la correzione backend richiede restart/ricarica del servizio backend per essere attiva nel processo in esecuzione;
- servizio backend riavviato alle 22:16 CEST;
- verifica systemd: `applicazione-backend.service` active/running;
- verifica API locale e LAN su porta `5181`: backend raggiungibile, risposta autenticata `Sessione login richiesta`.

## Aggiornamento ciclo 2026-06-04 - modalita demo fiscale

Regola richiesta:

- nella pagina `Quadro` delle impostazioni deve esistere un toggle per attivare/disattivare la modalita demo;
- in modalita demo i pagamenti e i movimenti gestionali restano registrati normalmente;
- in modalita demo non deve avvenire nessuna emissione fiscale verso RT/API fiscale/provider legacy;
- la disattivazione della demo deve ripristinare la fiscalita secondo la configurazione RT e metodi pagamento.

Fix applicato:

- `cassa-frontend/backend/lib/pos-defaults.js`:
  - aggiunto `demoMode: false` come default esplicito delle impostazioni POS.
- `cassa-frontend/backend/server.js`:
  - `sanitizePosSettings()` e payload impostazioni espongono `demoMode`;
  - aggiunto helper `isPosDemoModeEnabled()`;
  - `maybeIssuePosFiscalReceipt()` salta l'emissione POS fiscale e registra evento `demo_mode_skipped`;
  - la fiscalita legacy nei flussi pagamento non parte se `demoMode` e' attivo;
  - il comando manuale `/api/fiscal/command` risponde come saltato in demo senza chiamare il provider;
  - le ricariche smart con metodo fiscale vengono registrate senza emissione fiscale in demo.
- `cassa-frontend/backend/modules/settings/settings.handlers.js`:
  - salvataggio impostazioni mantiene e aggiorna `demoMode`.
- `cassa-frontend/backend/modules/configuration/configuration-snapshot.js`:
  - snapshot di configurazione espone `demoMode`.
- `settings-frontend/dist/assets/settings-app.js`:
  - aggiunto toggle nella pagina `Quadro`;
  - il salvataggio generale include `demoMode`;
  - il toggle salva tramite lo stesso flusso impostazioni esistente.

Nota operativa:

- la modalita demo non e' un fallback fiscale: e' un blocco intenzionale globale delle emissioni fiscali;
- la modifica backend richiede restart/ricarica per essere attiva nel processo in esecuzione;
- test eseguiti:
  - `node --check cassa-frontend/backend/server.js`: OK;
  - `node --check cassa-frontend/backend/modules/settings/settings.handlers.js`: OK;
  - `node --check cassa-frontend/backend/modules/configuration/configuration-snapshot.js`: OK;
  - `node --check cassa-frontend/backend/lib/pos-defaults.js`: OK;
  - `node --check settings-frontend/dist/assets/settings-app.js`: OK;
  - `node --test backend/tests/print-utils-core.test.mjs`: OK, 4/4;
- servizio backend riavviato alle 22:27 CEST;
- verifica systemd: `applicazione-backend.service` active/running;
- verifica API locale e LAN su porta `5181`: backend raggiungibile, risposta autenticata `Sessione login richiesta`.

## Aggiornamento ciclo 2026-06-04 - impostazioni palmari

Regola richiesta:

- nella sidebar del frontend impostazioni deve esistere la voce `Palmari`;
- la pagina deve mostrare lo stato batterie reale di ogni palmare rilevato dal servizio batteria;
- per ogni palmare deve essere possibile inviare una notifica di squillo per ritrovarlo;
- per ogni palmare deve essere possibile configurare:
  - abilitazione fiscale globale del device;
  - abilitazione fiscale per pagamento elettronico/POS;
  - abilitazione fiscale per pagamento contanti;
- i toggle devono essere persistenti, non mock;
- se un palmare configurato non e' abilitato alla fiscalita o al metodo di pagamento usato, non deve partire emissione fiscale da quel device;
- se un palmare non e' ancora configurato, il comportamento fiscale resta quello esistente per retrocompatibilita.

Fix applicato:

- `cassa-frontend/backend/modules/mobile-battery/*`:
  - aggiunto endpoint autenticato `POST /api/settings/mobile-devices/status`;
  - l'endpoint restituisce tutti i device batteria normalizzati, con conteggi online/offline/in carica.
- `cassa-frontend/backend/server.js`:
  - aggiunta sanitizzazione `mobileDevices`;
  - `mobileDevices` viene incluso in `sanitizePosSettings()` e nel payload impostazioni;
  - aggiunta verifica fiscale per palmare configurato;
  - i flussi POS/contanti non avviano fiscalita se il device configurato non e' abilitato.
- `cassa-frontend/backend/modules/settings/*`:
  - aggiunti endpoint autenticati:
    - `POST /api/settings/mobile-devices/save`;
    - `POST /api/settings/mobile-devices/ring`;
  - lo squillo accoda una notifica `handheld_ring` targettizzata su `targetDeviceUuid`.
- `settings-frontend/dist/assets/settings-app.js`:
  - aggiunta sezione `Palmari`;
  - aggiunte card con batteria, stato online/offline, IP, ultimo aggiornamento;
  - aggiunti pulsanti `Aggiorna batterie`, `Salva`, `Squillo`;
  - aggiunti toggle fiscali con auto-save.
- `settings-frontend/dist/assets/settings-app.css`:
  - aggiunti stili per card palmari e barra batteria.

Nota operativa:

- lo squillo usa il bus notifiche mobile gia' esistente con `eventType: handheld_ring`;
- se serve un suono dedicato diverso dagli avvisi mobile correnti, va agganciato nel frontend mobile leggendo `meta.eventType === "handheld_ring"`;
- test eseguiti:
  - `node --check cassa-frontend/backend/server.js`: OK;
  - `node --check cassa-frontend/backend/modules/settings/settings.handlers.js`: OK;
  - `node --check cassa-frontend/backend/modules/settings/settings.routes.js`: OK;
  - `node --check cassa-frontend/backend/modules/mobile-battery/mobile-battery.handlers.js`: OK;
  - `node --check cassa-frontend/backend/modules/mobile-battery/mobile-battery.routes.js`: OK;
  - `node --check settings-frontend/dist/assets/settings-app.js`: OK;
  - `node --test backend/tests/mobile-battery.test.mjs`: OK, 4/4;
  - `node --test backend/tests/route-policy-architecture.test.mjs`: OK, 5/5;
- servizio backend riavviato alle 22:45 CEST;
- verifica systemd: `applicazione-backend.service` active/running;
- verifica API locale e LAN su porta `5181`: backend raggiungibile, risposta autenticata `Sessione login richiesta`.

## Aggiornamento ciclo 2026-06-04 - formato test stampante

Regola richiesta:

- il test stampante dalle impostazioni deve produrre un tagliando piu' leggibile e diagnostico;
- il titolo deve essere `TEST STAMPA`;
- i dati della stampante devono stare in alto;
- il testo deve rispettare la larghezza configurata della stampa;
- il test deve includere campioni di maiuscole, minuscole, numeri e simboli.

Fix applicato:

- `settings-frontend/dist/assets/settings-app.js`:
  - aggiunto calcolo larghezza riga da configurazione stampante/preconto;
  - aggiunti helper per centratura, separatori, key/value e wrapping;
  - riformattato `buildPrinterTestText()` con:
    - titolo centrato;
    - dati stampante in alto;
    - larghezza dichiarata;
    - campioni `ABCDEFGHIJKLMNOPQRSTUVWXYZ`, `abcdefghijklmnopqrstuvwxyz`, `0123456789` e simboli ASCII;
    - chiusura `FINE TEST`.

Test eseguiti:

- `node --check settings-frontend/dist/assets/settings-app.js`: OK.

## Aggiornamento ciclo 2026-06-04 - pause camerieri e notifiche

Regola richiesta:

- ogni utente puo' avere pause operative abilitate da impostazioni;
- la pausa e' gestita a cicli configurabili, di default 15 minuti ogni 2 ore;
- prima della scadenza delle 2 ore ogni avvio/stop pausa resta valido;
- se l'utente ferma manualmente la pausa, le notifiche tornano attive dopo 3 secondi;
- se la pausa scade automaticamente, i 3 secondi decorrono dalla scadenza reale, non dal successivo refresh del backend;
- durante la pausa l'utente non riceve chiamate cameriere o comande pronte se esiste un altro cameriere disponibile sulla stessa sala;
- se e' l'unico cameriere disponibile sulla sala, continua a ricevere gli avvisi per non perdere il servizio;
- sulla postazione i camerieri in pausa devono essere riconoscibili e chiamabili solo tramite conferma;
- `Chiama dopo` deve consegnare la chiamata quando la pausa e' terminata;
- `Chiama ora` deve inviare una chiamata urgente anche se il cameriere e' in pausa.

Fix applicato:

- `cassa-frontend/backend/modules/notifications/waiter-pauses.js`:
  - aggiunta macchina di stato pausa cameriere;
  - aggiunta normalizzazione impostazioni utente;
  - aggiunto tracking pause attive, grace di riattivazione e chiamate differite.
- `cassa-frontend/backend/server.js`:
  - aggiunti endpoint runtime pausa mobile;
  - le notifiche mobile filtrano i camerieri in pausa solo quando esistono alternative disponibili;
  - le chiamate differite vengono rilasciate quando la pausa termina;
  - la finestra di presenza camerieri e' stata resa meno stringente.
- `cassa-frontend/backend/modules/integration/integration.routes.js`:
  - aggiunti endpoint:
    - `POST /api/mobile/waiter-pause/status`;
    - `POST /api/mobile/waiter-pause/start`;
    - `POST /api/mobile/waiter-pause/stop`;
    - `POST /api/integration/waiter-pause/defer-call`.
- `cassa-frontend/backend/users/users.service.js` e `cassa-frontend/backend/users/users.handlers.js`:
  - le impostazioni pausa utente vengono salvate e rilette senza perderle.
- `settings-frontend/dist/assets/settings-app.js`:
  - aggiunta sezione `Pausa operativa` nella modale utente con toggle e durata configurabile.
- `mobile-frontend/src/api/waiterPause.ts`:
  - aggiunte chiamate API pausa.
- `mobile-frontend/src/pages/home/components/WaiterPauseCard.tsx`:
  - aggiunta card home con timer pausa e pulsante start/stop.
- `mobile-frontend/src/pages/home/hooks/useNotificationCenter.ts` e `mobile-frontend/src/api/notifications.ts`:
  - aggiunto contesto sala nelle pull/ack notifiche.
- `postazione/dist/assets/postazione-waiter-panel-fix.js`:
  - i camerieri in pausa sono mostrati con badge;
  - chiamata urgente e chiamata differita usano modale dedicata.

Test eseguiti:

- `node --check backend/modules/notifications/waiter-pauses.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/waiter-pauses.test.mjs`: OK, 3/3;
- `npm run check:backend`: OK;
- `npm run typecheck` in `mobile-frontend`: OK;
- `npm run build` in `mobile-frontend`: OK.

Nota operativa:

- il frontend mobile aggiornato e' stato rigenerato in `mobile-frontend/dist`;
- servizio backend riavviato alle 23:14 CEST;
- verifica runtime: `applicazione-backend.service` active/running;
- verifica API: `GET http://127.0.0.1:5181/api/health` OK.

## Aggiornamento ciclo 2026-06-04 - home mobile, preconto Gazebo e spostamento tavolo

Problemi rilevati:

- nella home mobile la card pausa non era visibile quando l'utente non aveva ancora la pausa abilitata;
- i filtri rapidi home non coprivano i quattro stati reali della legenda tavoli, perche' la quarta card mostrava gli arrivi/prenotazioni invece del filtro `occupied`;
- il preconto completo/attuale del tavolo 4 Gazebo poteva fallire con `Postazione non collegata all'attivita operativa corrente`;
- lo spostamento tavolo dal dettaglio mobile veniva bloccato lato frontend se il tavolo aveva ordini o importi da pagare, quindi non arrivava mai alla routine backend che gestisce stampa cambio/comanda/preconto.

Cause:

- `WaiterPauseCard` ritornava `null` se `pause.enabled` era falso;
- `HomeCard` esponeva solo `free`, `ordering`, `payment_due` e una card informativa `arrivals`;
- `printTablePreconto()` non inviava `activityId`/`roomId` e il backend poteva validare una postazione/station ereditata dalla comanda invece di risolvere il preconto da attivita+sala;
- `moveDiningTable()` usava una simulazione locale con blocco su `ordersInProgress`/`amountDue`, invece dell'endpoint reale `POST /api/integration/layout/table/move`.

Fix applicato:

- `mobile-frontend/src/pages/home/components/WaiterPauseCard.tsx`:
  - la card resta visibile con sessione valida anche se la pausa non e' abilitata;
  - mostra `Pausa non abilitata` e pulsante disabilitato invece di sparire.
- `mobile-frontend/src/pages/home/components/HomeCard.tsx`:
  - aggiunta card `Occupati/Prenotati`;
  - le quattro card rapide ora mappano i filtri reali: `free`, `occupied`, `ordering`, `payment_due`.
- `mobile-frontend/src/pages/HomePage.tsx` e `HomeWorkspace.tsx`:
  - aggiornati i tipi per accettare il filtro `occupied`.
- `mobile-frontend/src/api/printing.ts` e `TableDetailPanel.tsx`:
  - il preconto tavolo invia `activityId` e `roomId` della sessione mobile.
- `cassa-frontend/backend/server.js`:
  - aggiunto flag interno `ignoreWorkstationRouting` per le stampe aggregate tavolo;
  - il table-preconto operativo usa attivita+sala e non forza station/workstation del palmare o della comanda.
- `mobile-frontend/src/api/tables.ts`:
  - `moveDiningTable()` chiama il backend reale `POST /api/integration/layout/table/move`;
  - rimosso il blocco frontend su tavolo con ordine/importo dovuto;
  - se il backend non e' raggiungibile lo spostamento viene bloccato per evitare stampe mancanti.

Verifica configurazione reale:

- `room_gazebo` e' collegata a `activity_bar`;
- `activity_bar` eredita la stampante preconto `printer_bar_1921681195_9100`;
- host stampante Bar: `192.168.1.102`;
- il problema non era nei dati, ma nel payload/routing.

Test eseguiti:

- `npm run typecheck` in `mobile-frontend`: OK;
- `npm run build` in `mobile-frontend`: OK;
- `npm run check:backend`: OK;
- `node --test backend/tests/print-utils-core.test.mjs backend/tests/waiter-pauses.test.mjs`: OK, 7/7;
- verifica runtime dopo riavvio: `applicazione-backend.service` active/running;
- verifica API: `GET http://127.0.0.1:5181/api/health` OK.

Nota operativa:

- backend riavviato alle 23:26 CEST per caricare il routing aggiornato;
- non e' stata lanciata una stampa preconto reale da Codex per evitare stampe non richieste mentre l'operatore stava provando il tavolo.

## Aggiornamento ciclo 2026-06-04 - filtri rapidi home e squillo palmari

Problemi rilevati:

- cliccando sulle card rapide della home mobile (`Tavoli liberi`, `Occupati/Prenotati`, `Ordini in corso`, `Da pagare`) veniva aperta la sezione Tavoli ma non sempre veniva applicato il filtro;
- il pulsante `Squillo` nella sezione Palmari delle impostazioni inviava la richiesta backend, ma il palmare poteva non suonare per mismatch fra `deviceId`, `deviceUuid` e IP del servizio batterie;
- sul mobile lo squillo era trattato come notifica generale, quindi non aveva un pattern sonoro/vibrazione adeguato per trovare fisicamente il device.

Cause:

- `TablesWorkspace` resta montato anche quando la tab Tavoli e' nascosta: il filtro rapido passava solo tramite `sessionStorage`/evento globale, quindi poteva essere applicato nel momento sbagliato o sovrascritto dal restore UI;
- `settings.ringMobileDevice` targettizzava principalmente `targetDeviceUuid=deviceId`, ma alcuni palmari sono identificati dal servizio batterie via IP o alias;
- il centro notifiche mobile non distingueva `meta.eventType=handheld_ring` dalle normali notifiche `general`.

Fix applicato:

- `mobile-frontend/src/pages/HomePage.tsx`:
  - aggiunto stato `tablesQuickFilter` con `filter` e `nonce`;
  - `openTablesWithDashboardFilter()` ora passa un comando filtro persistente a React prima di aprire Tavoli.
- `mobile-frontend/src/pages/home/components/HomeWorkspace.tsx`:
  - propaga `tablesQuickFilter` a `TablesWorkspace`.
- `mobile-frontend/src/pages/home/tables/TablesWorkspace.tsx`:
  - applica il filtro rapido via prop;
  - resetta ricerca e modali/dettagli aperti quando arriva un filtro dalla home;
  - mantiene storage/evento come compatibilita' legacy.
- `cassa-frontend/backend/modules/settings/settings.handlers.js`:
  - lo squillo palmare include `targetDeviceUuid` solo quando e' davvero un UUID/non-IP;
  - aggiunti `targetClientIp` e `targetDeviceIdAliases`.
- `cassa-frontend/backend/modules/notifications/notification-targeting.js`:
  - aggiunto matching mirato per `targetClientIp`;
  - aggiunti alias device;
  - test manuale ha verificato che lo squillo non venga consegnato a IP/device diversi.
- `cassa-frontend/backend/server.js`:
  - `handleIntegrationNotificationsPull()` passa l'IP reale del client al motore di targeting notifiche.
- `mobile-frontend/src/api/notifications.ts`:
  - il filtro client non scarta gli squilli `handheld_ring` gia' targettizzati dal backend per IP.
- `mobile-frontend/src/pages/home/hooks/useNotificationCenter.ts`:
  - aggiunto pattern sonoro e vibrazione dedicati allo squillo palmare.

Test eseguiti:

- test mirato `notificationMatchesTarget()` per squillo via IP/UUID/alias: OK;
- `npm run check:backend`: OK;
- `node --check backend/modules/notifications/notification-targeting.js`: OK;
- `node --check backend/modules/settings/settings.handlers.js`: OK;
- `npm run typecheck` in `mobile-frontend`: OK;
- `npm run build` in `mobile-frontend`: OK.

Nota operativa:

- `systemctl restart applicazione-backend.service` e `SIGTERM` non hanno fermato il vecchio processo;
- eseguito `SIGKILL` sul PID backend precedente e systemd ha riavviato correttamente il servizio;
- backend attivo con nuovo PID `1246489` dalle 23:37 CEST;
- verifica API: `GET http://127.0.0.1:5181/api/health` OK.

## Aggiornamento ciclo 2026-06-04 - posizione card pausa home mobile

Fix applicato:

- `mobile-frontend/src/pages/home/components/HomeCard.tsx`:
  - la card pausa e' stata spostata sotto le quattro card riepilogo tavoli.
- `mobile-frontend/src/pages/home/components/WaiterPauseCard.tsx`:
  - se la pausa non e' abilitata, la card mostra solo la dicitura `Pausa non abilitata`;
  - rimossi in quello stato timer, durata e pulsante disabilitato.
- `mobile-frontend/src/styles/glass.css`:
  - aggiunto stile dedicato per la card pausa disabilitata, compatibile con dark/light mode.

Test eseguiti:

- `npm run typecheck` in `mobile-frontend`: OK;
- `npm run build` in `mobile-frontend`: OK;
- bundle mobile rigenerato in `mobile-frontend/dist`.

## Aggiornamento ciclo 2026-06-04 - label rinnovo pausa

Fix applicato:

- `mobile-frontend/src/pages/home/components/WaiterPauseCard.tsx`:
  - aggiunto formatter del rinnovo pausa;
  - esempi:
    - `15 min ogni 120 min` diventa `15 min ogni 2 ore`;
    - `15 min ogni 90 min` diventa `15 min ogni 1 ora e 30 minuti`;
    - sotto i 60 minuti resta in minuti, es. `15 min ogni 45 minuti`.

Test eseguiti:

- `npm run typecheck` in `mobile-frontend`: OK;
- `npm run build` in `mobile-frontend`: OK;
- bundle mobile rigenerato in `mobile-frontend/dist`.

## Aggiornamento ciclo 2026-06-04 - cambio PIN da profilo mobile

Fix/feature applicata:

- `cassa-frontend/backend/auth/auth.handlers.js`:
  - aggiunto handler autenticato `handleChangePin`;
  - richiede PIN attuale di 4 cifre;
  - richiede nuovo PIN e conferma, entrambi di 4 cifre;
  - verifica il PIN attuale con `verifyPin`;
  - salva solo `pinHash` tramite `hashPin`, mai PIN in chiaro;
  - aggiunge audit event `auth.pin_changed` o `auth.pin_change_failed`.
- `cassa-frontend/backend/routes/index.js`:
  - aggiunta route autenticata `POST /api/auth/change-pin`.
- `cassa-frontend/backend/server.js`:
  - registrato handler `auth.changePin`;
  - passato `hashPin` agli handler auth.
- `mobile-frontend/src/api/auth.ts`:
  - aggiunta API `changePin()`.
- `mobile-frontend/src/pages/ProfilePage.tsx`:
  - aggiunto pulsante `Cambia PIN` in fondo alla card profilo;
  - aggiunta modale con PIN attuale, nuovo PIN, conferma nuovo PIN;
  - ogni campo ha toggle occhiolino per mostrare/nascondere;
  - input limitato a 4 cifre numeriche.
- `mobile-frontend/src/styles/glass.css`:
  - aggiunti stili modal cambio PIN compatibili con dark/light mode.

Test eseguiti:

- `npm run check:backend`: OK;
- `node --check backend/auth/auth.handlers.js`: OK;
- test mirato route registry `POST /api/auth/change-pin`: OK;
- `npm run typecheck` in `mobile-frontend`: OK;
- `npm run build` in `mobile-frontend`: OK;
- backend riavviato alle 23:49 CEST;
- `GET http://127.0.0.1:5181/api/health`: OK;
- `POST /api/auth/change-pin` senza sessione: `401 Sessione login richiesta`, quindi route non pubblica.

## Aggiornamento ciclo 2026-06-04 - fix stampa `session is not defined`

Problema rilevato:

- tentando di stampare, alcune code di stampa potevano fallire con `session is not defined`;
- la causa era nei payload `requestedBy` della coda stampa: `enqueuePrintSpoolJob()` e `appendPrintSpoolJobToDb()` leggevano `session.deviceUuid` in uno scope dove `session` non esiste;
- `handleIntegrationPrint()` non arricchiva in modo uniforme il payload di stampa con i dati della sessione autenticata prima del routing operativo.

Fix applicato:

- `cassa-frontend/backend/server.js`:
  - in `enqueuePrintSpoolJob()` il device richiedente ora usa `payload.deviceUuid`;
  - in `appendPrintSpoolJobToDb()` il device richiedente ora usa `payload.deviceUuid`;
  - in `handleIntegrationPrint()` il payload viene arricchito con `userId`, `username`, `deviceUuid`, `clientApp` e `sessionId` dalla sessione autenticata quando disponibile.

Test/verifiche eseguiti:

- `npm run check:backend`: OK;
- controllo sorgente sui blocchi `requestedBy`: OK, non resta il riferimento fuori scope nelle funzioni di spool;
- backend riavviato alle 23:54 CEST, nuovo PID `1364242`;
- `GET http://127.0.0.1:5181/api/health`: OK;
- `POST /api/integration/print` senza sessione: `401 Sessione login richiesta`, quindi fallimento pulito e non crash runtime;
- log backend dopo il riavvio: nessun nuovo `session is not defined`.

Nota operativa:

- il primo `systemctl restart applicazione-backend.service` e' andato in timeout durante lo stop, come gia' osservato in cicli precedenti;
- il vecchio processo backend e' stato terminato e systemd ha riavviato correttamente il servizio;
- non e' stata modificata la logica di routing stampanti/RT in questo fix.

## Aggiornamento ciclo 2026-06-05 - filtro rapido home verso tavoli mobile

Problema rilevato:

- cliccando le card della home mobile (`Tavoli liberi`, `Occupati/Prenotati`, `Ordini in attesa`, `Da riscuotere`) la UI apriva la sezione tavoli ma il filtro non veniva applicato in modo affidabile;
- la richiesta filtro dipendeva troppo dal timing tra evento custom, cambio tab, mount lazy di `TablesWorkspace` e ripristino dello stato tavoli salvato.

Fix applicato:

- `mobile-frontend/src/pages/HomePage.tsx`:
  - il filtro rapido ora viene scritto anche dal livello pagina, non solo dalla card;
  - viene rimosso il flag `mobile:dashboard:quick-filter-applied` prima di aprire i tavoli;
  - viene rilanciato l'evento `mobile:dashboard:quick-filter` dopo il cambio tab.
- `mobile-frontend/src/pages/home/tables/TablesWorkspace.tsx`:
  - introdotta funzione unica `applyDashboardQuickFilter()`;
  - il filtro dalla home forza la modalita' singola;
  - pulisce ricerca, selezione tavolo, modali aperte e scroll;
  - non riapplica piu' filtri vecchi gia' consumati.
- `mobile-frontend/tests/static/dashboardQuickFilter.test.ts`:
  - aggiunto test statico sul contratto home -> tavoli.

Test/verifiche eseguiti:

- `npm run typecheck` in `mobile-frontend`: OK;
- `npx vitest run tests/static/dashboardQuickFilter.test.ts`: OK;
- `npm run build` in `mobile-frontend`: OK;
- bundle mobile rigenerato in `mobile-frontend/dist`.

Nota:

- `npm run test:static -- dashboardQuickFilter.test.ts` avvia anche tutta la suite statica e continua a fallire su due gate architetturali generali preesistenti:
  - budget LOC di file grandi;
  - conteggio stringhe raw `/api/` nei componenti;
- il test mirato del filtro rapido passa.

## Aggiornamento ciclo 2026-06-05 - progetto memoria riduzione monolite

Obiettivo:

- creare una memoria stabile, accurata e riprendibile per ridurre progressivamente il monolite backend senza regressioni su pagamenti, fiscalita', comande, stampa, sale, postazioni, mobile, monitor, sessioni e impostazioni;
- evitare refactor estetici o tagli massivi non controllati;
- collegare la riduzione del monolite ai bug reali ancora aperti, soprattutto routing menu/postazioni, fiscalita', stampanti/RT e stati operativi.

File creato:

- `MONOLITH_REDUCTION_PROJECT_MEMORY.md`

Metriche iniziali rilevate:

- monolite principale: `cassa-frontend/backend/server.js`;
- righe attuali: 29.169;
- funzioni dichiarate: 799;
- funzioni sopra 100 righe: 51;
- funzioni sopra 300 righe: 7;
- funzioni sopra 500 righe: 3;
- route registry totale: 118 route;
- handler HTTP ancora dichiarati nel monolite e collegati tramite `routeHandlers`.

Funzioni prioritarie per rischio e dimensione:

- `handlePaymentFreeSplit`: 799 righe;
- `handlePayTable`: 714 righe;
- `handleIntegrationOrderComp`: 564 righe;
- `handleIntegrationOrderSync`: 467 righe;
- `handleIntegrationOrderCreate`: 433 righe;
- `sanitizeIntegrationOrder`: 413 righe;
- `handlePayTicket`: 376 righe;
- `issueQueuedPosFiscalReceipt`: 286 righe;
- `handleIntegrationLayoutTableMove`: 288 righe.

Strategia salvata nella memoria:

- Fase 0: baseline, guardrail e snapshot contratti;
- Fase 1: configurazione operativa e routing menu/postazioni;
- Fase 2: print spool e fiscal POS domain;
- Fase 3: order state/domain;
- Fase 4: payments provider e payments service;
- Fase 5: tavoli, lock e cambio sala;
- Fase 6: notifiche, camerieri e postazioni;
- Fase 7: smart/customer-card;
- Fase 8: estrazione handler HTTP e pulizia route registry.

Regole operative fissate:

- nessun cambio di contratto endpoint senza test;
- nessun fallback implicito su stampanti/RT;
- nessuna duplicazione fiscale o pagamento;
- estrarre prima funzioni pure e domain helper, poi service, poi handler;
- ogni slice deve avere test mirati e rollback semplice;
- ogni estrazione deve ridurre rischio reale o complessita' misurabile.

Primo step consigliato:

- avviare la Fase 1A con un modulo puro `backend/modules/menu/menu-routing.domain.js`;
- spostare li' la logica di routing menu/categorie/articoli verso postazioni operative;
- correggere i casi in cui `stationId` risulta vuoto o non valido;
- testare routing per `Drink Premium`, `BAR-1`, categorie esplicite, articoli espliciti e assenza di fallback;
- solo dopo procedere a print spool/fiscale.

Nota:

- in questo ciclo non e' stata modificata logica runtime;
- e' stata creata solo memoria di progetto per guidare i prossimi interventi in modo controllato.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite Fase 1A routing menu/postazioni

Obiettivo:

- iniziare la riduzione concreta del monolite seguendo `MONOLITH_REDUCTION_PROJECT_MEMORY.md`;
- estrarre dal blocco menu/catalog/pricing la logica pura che decide a quali postazioni operative appartengono categorie, articoli e righe ordine;
- evitare fallback statici e stationId vuoti quando la configurazione reale contiene postazioni.

File modificati:

- `cassa-frontend/backend/modules/menu/menu-routing.domain.js`: nuovo domain puro per routing menu/postazioni;
- `cassa-frontend/backend/modules/menu/index.js`: esporta il nuovo domain;
- `cassa-frontend/backend/server.js`: usa il domain per catalogo integrazione e scelta postazione delle righe ordine;
- `cassa-frontend/backend/tests/menu-routing-domain.test.mjs`: nuovi test domain;
- `cassa-frontend/backend/tests/helpers/test-server.mjs`: fixture e2e riallineata con postazione reale `BAR-1`;
- `cassa-frontend/backend/tests/security.test.mjs`: fixture locale riallineata con postazione reale `BAR-1`.

Comportamento ottenuto:

- `Drink Premium` e righe premium con variante vengono indirizzati alla prima postazione bar configurata, ad esempio `BAR-1`;
- `workstationIds` espliciti sugli articoli vengono mappati alla `stationName` della postazione configurata;
- allow-list di postazione su prodotti/categorie/menu viene gestita nel domain;
- senza postazioni configurate il domain non inventa piu' una postazione vuota;
- catalogo e creazione ordine usano la stessa logica di routing, riducendo disallineamenti tra frontend e postazione.

Metriche:

- `cassa-frontend/backend/server.js` prima: 29.169 righe;
- `cassa-frontend/backend/server.js` dopo: 29.106 righe;
- riduzione monolite: 63 righe nette;
- nuovo domain testabile: 307 righe.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `node --test backend/tests/menu-routing-domain.test.mjs backend/tests/menu-domain.test.mjs`: OK, 10/10;
- `node --test backend/tests/orders-flow.e2e.test.mjs`: OK, 5/5;
- `node --test backend/tests/security.test.mjs`: 26/27, rimane il failure gia noto su cambio tavolo profondo `400 !== 200`;
- `npm run check:backend`: OK.

Rischi residui:

- routing multi-postazione completo (`BAR-2`, `CHIRINGUITO-1`, `CHIRINGUITO-2`, `MOBILE`) ancora da verificare end-to-end su configurazione reale;
- cambio tavolo profondo resta aperto e va trattato in slice separata;
- print spool/fiscale non sono stati modificati in questa fase.

Prossimo step:

- Fase 1B: completare test e wiring del routing postazioni su configurazione reale completa, poi collegare la stessa decisione a stampa/preconto prima di passare alla Fase 2 print spool/fiscale.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite Fase 1B parziale eligibility postazioni

Obiettivo:

- continuare la riduzione del monolite nella stessa area menu/postazioni;
- spostare fuori da `server.js` la logica pura che decide se una postazione e' eleggibile per una riga ordine;
- mantenere invariato il comportamento degli endpoint e del load-balancer.

File modificati:

- `cassa-frontend/backend/modules/menu/menu-routing.domain.js`: aggiunte funzioni pure per lookup postazione e allow/exclude list;
- `cassa-frontend/backend/modules/menu/index.js`: esporta le nuove funzioni;
- `cassa-frontend/backend/server.js`: rimosse funzioni locali di eligibility e usato il domain;
- `cassa-frontend/backend/tests/menu-routing-domain.test.mjs`: aggiunti test su postazione configurata, allow-list ed esclusioni.

Funzioni rimosse dal monolite:

- `normalizeWorkstationRoutingToken`;
- `buildWorkstationRoutingSet`;
- `setIntersects`;
- `findConfiguredWorkstationForStation`;
- `resolveIntegrationLineRoutingTokens`;
- `workstationAllowsIntegrationLine`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 29.106 righe;
- `cassa-frontend/backend/server.js` dopo fase: 29.015 righe;
- riduzione netta fase: 91 righe;
- riduzione totale da baseline memoria: 154 righe.

Test eseguiti:

- `node --check backend/server.js && node --check backend/modules/menu/menu-routing.domain.js && node --check backend/modules/menu/index.js`: OK;
- `node --test backend/tests/menu-routing-domain.test.mjs backend/tests/menu-domain.test.mjs`: OK, 13/13;
- `node --test backend/tests/orders-flow.e2e.test.mjs`: OK, 5/5;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 2/2;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, rimane il failure gia noto su cambio tavolo profondo `400 !== 200`.

Rischi residui:

- il routing stampa/preconto non e' stato ancora riallineato a questo domain;
- il cambio tavolo profondo resta aperto;
- non e' ancora stata fatta una verifica end-to-end su tutte le postazioni reali configurate (`BAR-2`, `CHIRINGUITO-1`, `CHIRINGUITO-2`, `MOBILE`).

## Aggiornamento ciclo 2026-06-05 - riduzione monolite Fase 1B availability articoli

Obiettivo:

- proseguire la riduzione nella stessa area menu/postazioni;
- spostare fuori da `server.js` la logica pura degli articoli esauriti/disabilitati globalmente o per postazione;
- mantenere compatibilita' con `postazione-actions` tramite alias importati.

File modificati:

- `cassa-frontend/backend/modules/menu/menu-routing.domain.js`: aggiunte funzioni pure availability;
- `cassa-frontend/backend/modules/menu/index.js`: esporta le nuove funzioni;
- `cassa-frontend/backend/server.js`: rimosse implementazioni locali e usati alias importati;
- `cassa-frontend/backend/tests/menu-routing-domain.test.mjs`: aggiunti test availability.

Funzioni rimosse dal monolite:

- `sanitizeIntegrationItemAvailabilityMap`;
- `resolveIntegrationItemAvailabilityInfo`;
- `resolveIntegrationItemAvailability`;
- `buildIntegrationItemAvailabilityList`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 29.015 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.874 righe;
- riduzione netta fase: 141 righe;
- riduzione totale da baseline memoria: 295 righe.

Test eseguiti:

- `node --check backend/server.js && node --check backend/modules/menu/menu-routing.domain.js && node --check backend/modules/menu/index.js`: OK;
- `node --test backend/tests/menu-routing-domain.test.mjs backend/tests/menu-domain.test.mjs`: OK, 16/16;
- `node --test backend/tests/orders-flow.e2e.test.mjs`: OK, 5/5;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 2/2;
- `npm run check:backend`: OK;
- `node --test backend/tests/continuity.e2e.test.mjs`: availability/routing OK, suite complessiva ferma a 66/68 per bug gia noto su pausa postazione `undefined !== false`.

Rischi residui:

- pausa postazione resta bug aperto;
- cambio tavolo profondo resta bug aperto;
- routing stampa/preconto ancora non collegato al domain menu/postazioni.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite table groups domain

Contesto:

- si e' continuato a ridurre `cassa-frontend/backend/server.js` seguendo `MONOLITH_REDUCTION_PROJECT_MEMORY.md`;
- la slice scelta e' la logica pura dei gruppi tavolo perche' non introduce side effect e copre merge/split/spostamenti;
- nessun endpoint e' stato rinominato o modificato nel contratto.

Modifiche applicate:

- creato `cassa-frontend/backend/modules/integration/table-groups.domain.js`;
- aggiunti test `cassa-frontend/backend/tests/table-groups-domain.test.mjs`;
- `cassa-frontend/backend/server.js` ora importa dal domain:
  - `areIntegrationTablesLinkedByGroup`;
  - `collectIntegrationTableGroupLeafIds`;
  - `resolveIntegrationLinkedTableIds`;
  - `resolveIntegrationLogicalTableLabel`;
  - `sanitizeIntegrationTableGroups`;
  - `sanitizeIntegrationTableLabel`.

Funzioni rimosse da `server.js`:

- `sanitizeIntegrationTableGroupNode`;
- `collectIntegrationTableGroupLeafIds`;
- `sanitizeIntegrationTableGroups`;
- `sanitizeIntegrationTableLabel`;
- `formatIntegrationTableNumberGroupLabel`;
- `resolveIntegrationLogicalTableLabel`;
- `findIntegrationTableGroupContaining`;
- `areIntegrationTablesLinkedByGroup`;
- `resolveIntegrationLinkedTableIds`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.874 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.717 righe;
- riduzione netta fase: 157 righe;
- riduzione totale rispetto alla baseline `MONOLITH_REDUCTION_PROJECT_MEMORY.md`: 452 righe.

Test eseguiti:

- `node --check backend/server.js && node --check backend/modules/integration/table-groups.domain.js`: OK;
- `node --test backend/tests/table-groups-domain.test.mjs`: OK, 4/4;
- `node --test backend/tests/orders-flow.e2e.test.mjs`: OK, 5/5;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 2/2;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure preesistente su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure preesistente su pausa postazione `undefined !== false` piu wrapper suite.

Stato:

- slice completata;
- nessuna modifica a pagamenti, fiscalita', print spool, impostazioni o mobile;
- restano aperti i bug gia noti: cambio tavolo digitale nel security test e pausa postazione nel continuity test.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite integration stations domain

Contesto:

- dopo l'estrazione dei gruppi tavolo e' stata completata una seconda micro-slice pura;
- obiettivo: togliere da `server.js` la normalizzazione delle postazioni senza reintrodurre postazioni mock o fallback statici;
- le postazioni restano lette da `posSettings.workstations`.

Modifiche applicate:

- creato `cassa-frontend/backend/modules/integration/stations.domain.js`;
- aggiunto `cassa-frontend/backend/tests/integration-stations-domain.test.mjs`;
- `cassa-frontend/backend/server.js` importa ora dal domain:
  - `dedupeConfiguredIntegrationStations`;
  - `normalizeConfiguredIntegrationStationName`;
  - `normalizeIntegrationStationName`;
  - `normalizeOptionalIntegrationStationName`;
  - `resolveConfiguredIntegrationStations`;
  - `resolveConfiguredIntegrationStationsFromSettings`;
  - `resolvePrimaryIntegrationStation`.

Funzioni rimosse da `server.js`:

- `normalizeIntegrationStationName`;
- `normalizeOptionalIntegrationStationName`;
- `isInvalidIntegrationStationName`;
- `normalizeConfiguredIntegrationStationName`;
- `dedupeConfiguredIntegrationStations`;
- `resolveConfiguredIntegrationStationsFromSettings`;
- `resolveConfiguredIntegrationStations`;
- `resolvePrimaryIntegrationStation`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.717 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.670 righe;
- riduzione netta fase: 47 righe;
- riduzione totale rispetto alla baseline `MONOLITH_REDUCTION_PROJECT_MEMORY.md`: 499 righe.

Test eseguiti:

- `node --check backend/server.js && node --check backend/modules/integration/stations.domain.js`: OK;
- `node --test backend/tests/integration-stations-domain.test.mjs`: OK, 3/3;
- `node --test backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/menu-domain.test.mjs`: OK, 23/23;
- `node --test backend/tests/orders-flow.e2e.test.mjs`: OK, 5/5;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 2/2;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure preesistente su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure preesistente su pausa postazione `undefined !== false` piu wrapper suite.

Stato:

- slice completata;
- nessun cambiamento a contratti API, pagamenti, fiscalita', stampa o frontend;
- prossima riduzione consigliata solo dopo aver valutato i due failure noti oppure scegliendo un altro helper puro a rischio basso.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite integration station states domain

Contesto:

- e' stata completata una nuova micro-slice nell'area postazioni;
- obiettivo: togliere da `server.js` normalizzazione stati postazione, stale detection e heartbeat persistence;
- la logica e' stata isolata come factory pura per non leggere direttamente `.env` o costanti globali dal modulo.

Modifiche applicate:

- creato `cassa-frontend/backend/modules/integration/station-states.domain.js`;
- aggiunto `cassa-frontend/backend/tests/integration-station-states-domain.test.mjs`;
- `cassa-frontend/backend/server.js` usa ora `createIntegrationStationStateHelpers()`.

Funzioni rimosse da `server.js`:

- `isIntegrationDemoStationEntry`;
- `isIntegrationStationStale`;
- `integrationStationStateKey`;
- `integrationStationStateStableFingerprint`;
- `shouldPersistIntegrationStationHeartbeat`;
- `sanitizeIntegrationStationStateEntry`;
- `buildIntegrationStationStates`.

Configurazione passata dal server al domain:

- `normalizeUsername`;
- `normalizeClientApp`;
- `normalizeIntegrationStationName`;
- `dedupeConfiguredIntegrationStations`;
- `INTEGRATION_STATIONS`;
- `PRIMARY_INTEGRATION_STATION`;
- `INTEGRATION_STATION_STALE_MS`;
- `INTEGRATION_STATION_HEARTBEAT_WRITE_MIN_INTERVAL_MS`;
- `SHOW_DEMO_STATIONS`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.670 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.530 righe;
- riduzione netta fase: 140 righe;
- riduzione totale rispetto alla baseline `MONOLITH_REDUCTION_PROJECT_MEMORY.md`: 639 righe.

Test eseguiti:

- `node --check backend/server.js && node --check backend/modules/integration/station-states.domain.js`: OK;
- `node --test backend/tests/integration-station-states-domain.test.mjs`: OK, 5/5;
- `node --test backend/tests/integration-station-states-domain.test.mjs backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/menu-domain.test.mjs`: OK, 28/28;
- `node --test backend/tests/orders-flow.e2e.test.mjs`: OK, 5/5;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 2/2;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure preesistente su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: primo tentativo fallito per bad port random harness; secondo tentativo 66/68 con failure preesistente su pausa postazione `undefined !== false` piu wrapper suite.

Stato:

- slice completata;
- nessuna modifica a pagamenti, fiscalita', stampa, mobile o contratti API;
- resta aperto il bug pausa postazione;
- resta aperto il bug table move digitale;
- rilevato anche rischio harness: `continuity.e2e` puo' scegliere porte vietate da `fetch`.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite integration rooms domain

Contesto:

- e' stata completata una micro-slice sugli helper di sale/layout/prenotazioni;
- obiettivo: rimuovere da `server.js` normalizzazione roomId, risoluzione sala da tavolo e parsing orario prenotazione;
- non sono stati modificati handler, pagamenti, fiscalita', stampa o frontend.

Modifiche applicate:

- creato `cassa-frontend/backend/modules/integration/rooms.domain.js`;
- aggiunto `cassa-frontend/backend/tests/integration-rooms-domain.test.mjs`;
- `cassa-frontend/backend/server.js` usa ora `createIntegrationRoomHelpers()`.

Funzioni rimosse da `server.js`:

- `toIntegrationRoomSlug`;
- `resolveIntegrationRoomFromType`;
- `normalizePosRoomId`;
- `resolveIntegrationRoomFromTable`;
- `parseIntegrationReservationAt`.

Configurazione passata dal server al domain:

- `normalizeConfigId`;
- `toTitle`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.530 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.477 righe;
- riduzione netta fase: 53 righe;
- riduzione totale rispetto alla baseline `MONOLITH_REDUCTION_PROJECT_MEMORY.md`: 692 righe.

Test eseguiti:

- `node --check backend/server.js && node --check backend/modules/integration/rooms.domain.js`: OK;
- `node --test backend/tests/integration-rooms-domain.test.mjs`: OK, 4/4;
- `node --test backend/tests/integration-rooms-domain.test.mjs backend/tests/integration-station-states-domain.test.mjs backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/menu-domain.test.mjs`: OK, 32/32;
- `node --test backend/tests/orders-flow.e2e.test.mjs`: OK, 5/5;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure preesistente su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure preesistente su pausa postazione `undefined !== false` piu wrapper suite.

Stato:

- slice completata;
- bug pausa postazione ancora aperto;
- bug table move digitale ancora aperto;
- nessuna regressione osservata su sale, prenotazioni, merge/split, ordini o pagamenti nei test eseguiti.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite integration order lookup domain

Contesto:

- e' stata completata una micro-slice su lookup e titoli comanda;
- obiettivo: isolare la logica che riconosce id comanda in formati diversi senza cambiare handler o DB;
- la slice preserva il comportamento storico su titoli/fallback.

Modifiche applicate:

- creato `cassa-frontend/backend/modules/integration/order-lookup.domain.js`;
- aggiunto `cassa-frontend/backend/tests/integration-order-lookup-domain.test.mjs`;
- `cassa-frontend/backend/server.js` importa ora:
  - `buildIntegrationOrderLookupCandidates`;
  - `buildIntegrationOrderTitleFromItems`;
  - `findIntegrationOrderIndexByLookup`;
  - `resolveIntegrationOrderDisplayTitle`.

Funzioni rimosse da `server.js`:

- `buildIntegrationOrderLookupCandidates`;
- `findIntegrationOrderIndexByLookup`;
- `buildIntegrationOrderTitleFromItems`;
- `resolveIntegrationOrderDisplayTitle`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.477 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.430 righe;
- riduzione netta fase: 47 righe;
- riduzione totale rispetto alla baseline `MONOLITH_REDUCTION_PROJECT_MEMORY.md`: 739 righe.

Test eseguiti:

- `node --check backend/server.js && node --check backend/modules/integration/order-lookup.domain.js`: OK;
- `node --test backend/tests/integration-order-lookup-domain.test.mjs`: OK, 4/4;
- `node --test backend/tests/integration-order-lookup-domain.test.mjs backend/tests/integration-rooms-domain.test.mjs backend/tests/integration-station-states-domain.test.mjs backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/menu-domain.test.mjs`: OK, 36/36;
- `node --test backend/tests/orders-flow.e2e.test.mjs`: OK, 5/5;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure preesistente su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure preesistente su pausa postazione `undefined !== false` piu wrapper suite.

Stato:

- slice completata;
- nessuna modifica a pagamenti, fiscalita', stampa, frontend o contratti API;
- bug pausa postazione e table move digitale restano i gate principali aperti.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite payment order refs domain

Contesto:

- e' stata completata una micro-slice pura in area pagamenti;
- obiettivo: isolare il collegamento tra bill, line selections, tableId e orderId senza modificare incasso/provider/fiscale;
- questa slice non cambia contratti API ne' flussi POS/fiscalita'.

Modifiche applicate:

- creato `cassa-frontend/backend/modules/payments/payment-order-refs.domain.js`;
- aggiunto `cassa-frontend/backend/tests/payment-order-refs-domain.test.mjs`;
- `cassa-frontend/backend/server.js` importa ora:
  - `collectOrderIdsFromBills`;
  - `collectOrderIdsFromLineSelections`;
  - `collectOrderIdsFromSelectedBills`;
  - `collectPosBillOrderIds`;
  - `normalizePaymentOrderIdList`;
  - `resolvePaymentOrderRefs`.

Funzioni rimosse da `server.js`:

- `collectPosBillOrderIds`;
- `collectOrderIdsFromBills`;
- `collectOrderIdsFromSelectedBills`;
- `collectOrderIdsFromLineSelections`;
- `normalizePaymentOrderIdList`;
- `resolvePaymentOrderRefs`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.430 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.344 righe;
- riduzione netta fase: 86 righe;
- riduzione totale rispetto alla baseline `MONOLITH_REDUCTION_PROJECT_MEMORY.md`: 825 righe.

Test eseguiti:

- `node --check backend/server.js && node --check backend/modules/payments/payment-order-refs.domain.js`: OK;
- `node --test backend/tests/payment-order-refs-domain.test.mjs`: OK, 5/5;
- `node --test backend/tests/payment-order-refs-domain.test.mjs backend/tests/integration-order-lookup-domain.test.mjs backend/tests/integration-rooms-domain.test.mjs backend/tests/integration-station-states-domain.test.mjs backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/menu-domain.test.mjs`: OK, 41/41;
- `node --test backend/tests/orders-flow.e2e.test.mjs`: OK, 5/5;
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs backend/tests/payments-fiscal.e2e.test.mjs`: OK, 19/19;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure preesistente su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure preesistente su pausa postazione `undefined !== false` piu wrapper suite.

Stato:

- slice completata;
- nessuna modifica a provider POS, fiscalita', idempotency, print spool o writeDb;
- bug pausa postazione e table move digitale restano aperti.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite payment money domain

Contesto:

- e' stata completata una micro-slice pura in area pagamenti;
- obiettivo: isolare conversioni importi, normalizzazione billIds e ricerca linea pagamento;
- nessuna modifica a provider POS, fiscal API, writeDb, idempotency o spool.

Modifiche applicate:

- creato `cassa-frontend/backend/modules/payments/payment-money.domain.js`;
- aggiunto `cassa-frontend/backend/tests/payment-money-domain.test.mjs`;
- `cassa-frontend/backend/server.js` usa ora `createPaymentMoneyHelpers()`.

Funzioni rimosse da `server.js`:

- `moneyToCents`;
- `centsToMoney`;
- `normalizePaymentBillIds`;
- `findPaymentBillLine`.

Configurazione passata dal server al domain:

- `normalizeUsername`;
- `roundMoney`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.344 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.317 righe;
- riduzione netta fase: 27 righe;
- riduzione totale rispetto alla baseline `MONOLITH_REDUCTION_PROJECT_MEMORY.md`: 852 righe.

Test eseguiti:

- `node --check backend/server.js && node --check backend/modules/payments/payment-money.domain.js`: OK;
- `node --test backend/tests/payment-money-domain.test.mjs`: OK, 4/4;
- `node --test backend/tests/payment-money-domain.test.mjs backend/tests/payment-order-refs-domain.test.mjs backend/tests/integration-order-lookup-domain.test.mjs backend/tests/integration-rooms-domain.test.mjs backend/tests/integration-station-states-domain.test.mjs backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/menu-domain.test.mjs`: OK, 45/45;
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs backend/tests/payments-fiscal.e2e.test.mjs`: OK, 19/19;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure preesistente su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure preesistente su pausa postazione `undefined !== false` piu wrapper suite.

Stato:

- slice completata;
- bug pausa postazione e table move digitale restano i gate aperti;
- nessuna regressione osservata sui test pagamento/fiscale mirati.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite payment print format domain

Contesto:

- e' stata completata una micro-slice pura in area pagamenti/stampa;
- obiettivo: togliere da `server.js` helper di formattazione ricevute, riferimenti comanda e riferimenti storno;
- nessuna modifica a configurazione gerarchica locale/attivita/sale/postazioni/stampanti/RT;
- nessuna modifica a spool reale, API fiscale, provider POS, idempotency o writeDb.

Modifiche applicate:

- creato `cassa-frontend/backend/modules/payments/payment-print-format.domain.js`;
- aggiunto `cassa-frontend/backend/tests/payment-print-format-domain.test.mjs`;
- `cassa-frontend/backend/server.js` usa ora `createPaymentPrintFormatHelpers()`.

Funzioni rimosse da `server.js`:

- `formatIntegrationPrintDateTime`;
- `formatIntegrationPrintOrderId`;
- `formatIntegrationPrintDisplayName`;
- `isElectronicPaymentReceiptMethod`;
- `buildMobilePaymentOrderReferenceLabel`;
- `normalizePaymentPrintNote`;
- `formatPaymentMethodPrintLabel`;
- `formatRefundActionPrintLabel`;
- `normalizeStornoPaymentReferences`.

Configurazione passata dal server al domain:

- `normalizePaymentMethodType`;
- `normalizeStringList`;
- `roundMoney`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.317 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.166 righe;
- riduzione netta fase: 151 righe;
- riduzione totale rispetto alla baseline `MONOLITH_REDUCTION_PROJECT_MEMORY.md`: 1.003 righe.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `node --check backend/modules/payments/payment-print-format.domain.js && node --test backend/tests/payment-print-format-domain.test.mjs`: OK, 8/8;
- `node --test backend/tests/menu-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/integration-station-states-domain.test.mjs backend/tests/integration-rooms-domain.test.mjs backend/tests/integration-order-lookup-domain.test.mjs backend/tests/payment-order-refs-domain.test.mjs backend/tests/payment-money-domain.test.mjs backend/tests/payment-print-format-domain.test.mjs`: OK, 53/53;
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs backend/tests/payments-fiscal.e2e.test.mjs`: OK, 19/19;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure preesistente su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure preesistente su pausa postazione `undefined !== false` piu wrapper suite.

Stato:

- slice completata;
- i percorsi pagamento/fiscale mirati restano verdi;
- i due gate rossi noti restano aperti e non sono stati toccati in questa slice.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite fiscal receipts domain

Contesto:

- seconda micro-slice pura del ciclo di riduzione monolite;
- obiettivo: togliere da `server.js` la normalizzazione/sanitizzazione dei receipt fiscali gia' emessi;
- nessuna modifica a RT configurate, stampanti, fiscal provider, retry, ristampa o pagamenti.

Modifiche applicate:

- creato `cassa-frontend/backend/modules/payments/fiscal-receipts.domain.js`;
- aggiunto `cassa-frontend/backend/tests/fiscal-receipts-domain.test.mjs`;
- `cassa-frontend/backend/server.js` usa ora `createFiscalReceiptHelpers()`.

Funzioni rimosse da `server.js`:

- `normalizeFiscalApiScalar`;
- `firstFiscalApiScalar`;
- `sanitizeFiscalReceipt`.

Configurazione passata dal server al domain:

- `normalizeConfigId`;
- `normalizePosFiscalApiPath`;
- `nowIso`.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.166 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.124 righe;
- riduzione netta fase: 42 righe;
- riduzione totale rispetto alla baseline `MONOLITH_REDUCTION_PROJECT_MEMORY.md`: 1.045 righe.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `node --check backend/modules/payments/fiscal-receipts.domain.js && node --test backend/tests/fiscal-receipts-domain.test.mjs`: OK, 4/4;
- `node --test backend/tests/menu-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/integration-station-states-domain.test.mjs backend/tests/integration-rooms-domain.test.mjs backend/tests/integration-order-lookup-domain.test.mjs backend/tests/payment-order-refs-domain.test.mjs backend/tests/payment-money-domain.test.mjs backend/tests/payment-print-format-domain.test.mjs backend/tests/fiscal-receipts-domain.test.mjs`: OK, 57/57;
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs backend/tests/payments-fiscal.e2e.test.mjs`: OK, 19/19;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure preesistente su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure preesistente su pausa postazione `undefined !== false` piu wrapper suite.

Stato:

- slice completata;
- nessuna regressione osservata sui test pagamento/fiscale mirati;
- gate rossi noti invariati e da trattare in ciclo bugfix separato.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite ESC-POS style helpers

Contesto:

- micro-slice pura in area stampa;
- obiettivo: spostare fuori dal monolite solo la composizione dei comandi ESC/POS di stile;
- nessun cambiamento a stampanti, routing, RT, spool, pagamenti o configurazione architetturale locale/attivita/sale.

Modifiche applicate:

- creato `cassa-frontend/backend/printing/escpos-style.js`;
- aggiunto `cassa-frontend/backend/tests/escpos-style.test.mjs`;
- `cassa-frontend/backend/server.js` usa ora `createEscPosStyleHelpers()`;
- corretto `cassa-frontend/backend/tests/pos-fiscal-retry.e2e.test.mjs` per attendere lo stato persistito `ISSUED`;
- rafforzato `buildRecoveredPosFiscalJob()` per recuperare receipt POS legacy senza `fiscalDeviceId`.

Funzioni rimosse da `server.js`:

- `escPos`;
- `escPosAlign`;
- `escPosBold`;
- `escPosUnderline`;
- `escPosItalic`;
- `escPosCharSpacing`;
- `escPosSize`;
- `escPosInlineReset`;
- `styleEscPosPrintLine`;
- `styleEscPosPrintLines`.

Nota recovery fiscale:

- il fallback legacy e' limitato ai receipt fiscali gia' presenti in DB con provider `pos-fiscal-api`;
- ordine di risoluzione device:
  1. device salvato sul receipt;
  2. device configurato in `posSettings`;
  3. `POS_FISCAL_API_BASE_URL` per recupero legacy;
- non cambia il routing ordinario delle stampanti o delle RT configurate.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.124 righe;
- `cassa-frontend/backend/server.js` dopo fase e fix recovery: 28.099 righe;
- riduzione netta fase: 25 righe;
- riduzione totale rispetto alla baseline `MONOLITH_REDUCTION_PROJECT_MEMORY.md`: 1.070 righe.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `node --check backend/printing/escpos-style.js && node --test backend/tests/escpos-style.test.mjs backend/tests/print-utils-core.test.mjs`: OK, 8/8;
- `node --test backend/tests/pos-fiscal-retry.e2e.test.mjs`: OK, 4/4;
- `node --test backend/tests/menu-domain.test.mjs backend/tests/menu-routing-domain.test.mjs backend/tests/table-groups-domain.test.mjs backend/tests/integration-stations-domain.test.mjs backend/tests/integration-station-states-domain.test.mjs backend/tests/integration-rooms-domain.test.mjs backend/tests/integration-order-lookup-domain.test.mjs backend/tests/payment-order-refs-domain.test.mjs backend/tests/payment-money-domain.test.mjs backend/tests/payment-print-format-domain.test.mjs backend/tests/fiscal-receipts-domain.test.mjs backend/tests/escpos-style.test.mjs`: OK, 61/61;
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs backend/tests/payments-fiscal.e2e.test.mjs backend/tests/pos-fiscal-retry.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 38/38;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure preesistente su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure preesistente su pausa postazione `undefined !== false` piu wrapper suite.

Stato:

- slice completata;
- retry fiscale POS ora coperto e verde;
- gate rossi storici invariati e da affrontare separatamente.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite printer config domain

Contesto:

- micro-slice pura in area configurazione stampanti e RT;
- obiettivo: spostare fuori dal monolite normalizzazione e sanitizzazione di stampanti, RT e target espliciti;
- nessun cambiamento a routing stampanti, fallback RT, spool, socket, pagamenti, fiscalita' o impostazioni utente.

Modifiche applicate:

- creato `cassa-frontend/backend/printing/printer-config.domain.js`;
- aggiunto `cassa-frontend/backend/tests/printer-config-domain.test.mjs`;
- `cassa-frontend/backend/server.js` usa ora `createPrinterConfigHelpers()`;
- aggiornato `cassa-frontend/backend/tests/configuration-snapshot.test.mjs` per il campo architetturale `precontoPrinterIds`;
- aggiornato `cassa-frontend/backend/tests/pos-fiscal-retry.e2e.test.mjs` per non dipendere da una data ormai fuori finestra retry.

Funzioni rimosse da `server.js`:

- `normalizePrinterPurpose`;
- `normalizePrinterModelId`;
- `normalizePrinterPort`;
- `normalizePrinterHost`;
- `resolveExplicitPrinterTarget`;
- `sanitizePosPrinter`;
- `sanitizePosFiscalDevice`.

Regola architetturale confermata:

- stampanti e RT restano lette dalla configurazione reale;
- il nuovo modulo non introduce fallback operativi;
- nessuna emissione fiscale, ristampa o stampa reale viene avviata dal modulo.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.099 righe;
- `cassa-frontend/backend/server.js` dopo fase: 28.001 righe;
- riduzione netta fase: 98 righe;
- riduzione totale da baseline memoria monolite: 1.168 righe.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `node --check backend/printing/printer-config.domain.js && node --test backend/tests/printer-config-domain.test.mjs`: OK, 5/5;
- configurazione/settings: OK, 21/21;
- stampa/pagamenti/fiscale simulati: OK, 31/31;
- domini fino a printer config: OK, 66/66;
- invarianti ordini/pagamenti: OK, 15/15;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: 26/27, failure preesistente su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure preesistente su pausa postazione `undefined !== false` piu wrapper suite.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite activity config domain

Contesto:

- micro-slice pura sulla gerarchia locale -> attivita -> sale;
- obiettivo: rendere testabile fuori dal monolite la normalizzazione delle attivita operative e dei binding attivita-sale;
- non sono stati cambiati endpoint impostazioni, snapshot runtime, routing menu/listini, stampanti, RT o pagamenti.

Modifiche applicate:

- creato `cassa-frontend/backend/modules/configuration/activity-config.domain.js`;
- aggiunto `cassa-frontend/backend/tests/activity-config-domain.test.mjs`;
- `cassa-frontend/backend/server.js` usa ora `createPosActivityConfigHelpers()`;
- la logica di schedule menu/listini resta nel modulo menu e viene passata alla factory, evitando un refactor doppio nello stesso ciclo.

Funzioni rimosse da `server.js`:

- `sanitizePosActivityFiscalPolicy`;
- `sanitizePosActivity`;
- `sanitizePosActivityRoomBinding`;
- `buildDefaultPosActivityRoomBindings`.

Regola architetturale confermata:

- l'attivita puo' avere menu, listini, stampanti preconto, stampanti operative, RT e postazioni;
- la sala viene collegata all'attivita tramite binding esplicito;
- se i binding non sono configurati, il fallback rimane solo quello legacy gia' esistente verso la prima attivita attiva;
- il modulo non accede a DB e non decide routing operativo.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 28.001 righe;
- `cassa-frontend/backend/server.js` dopo fase: 27.921 righe;
- riduzione netta fase: 80 righe;
- riduzione totale da baseline memoria monolite: 1.248 righe;
- nuovo modulo: 115 righe;
- nuovo test: 136 righe.

Test eseguiti:

- `node --check backend/modules/configuration/activity-config.domain.js && node --check backend/server.js && node --test backend/tests/activity-config-domain.test.mjs`: OK, 5/5;
- configurazione/settings con activity config: OK, 26/26;
- suite domini completa: OK, 71/71;
- `npm run check:backend`: OK;
- stampa/pagamenti/fiscale simulati con invarianti ordini/pagamenti: OK, 46/46;
- `node --test backend/tests/security.test.mjs`: 26/27, failure preesistente su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure preesistente su pausa postazione `undefined !== false` piu wrapper suite.

Rischi residui:

- table move digitale resta rosso nel gate security;
- pausa postazione resta rossa nel gate continuity;
- finche' questi due punti non sono verdi, le prossime riduzioni devono restare su helper puri senza side effect.

Prossimo step consigliato:

1. correggere o isolare il bug table move digitale;
2. correggere o isolare il bug pausa postazione;
3. poi riprendere la decomposizione di snapshot/report/settings domain.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite locale e palmari config domain

Contesto:

- micro-slice pura in area configurazione locale e palmari;
- obiettivo: spostare fuori dal monolite normalizzazione locale/locali e configurazioni mobile devices;
- nessun cambiamento a batteria runtime, fiscalita', pagamenti, stampanti, RT, routing sale o sessioni.

Modifiche applicate:

- creato `cassa-frontend/backend/modules/configuration/locale-config.domain.js`;
- creato `cassa-frontend/backend/modules/configuration/mobile-device-config.domain.js`;
- aggiunto `cassa-frontend/backend/tests/locale-config-domain.test.mjs`;
- aggiunto `cassa-frontend/backend/tests/mobile-device-config-domain.test.mjs`;
- `cassa-frontend/backend/server.js` usa ora `createPosLocaleConfigHelpers()` e `createMobileDeviceConfigHelpers()`.

Funzioni rimosse da `server.js`:

- `sanitizePosLocale`;
- `sanitizePosLocales`;
- `sanitizeMobileDeviceSetting`;
- `sanitizeMobileDeviceSettings`.

Regole architetturali confermate:

- il locale resta il nodo radice operativo con fallback legacy `locale_default`;
- `locales` viene deduplicato per id e ordinato per alias;
- i palmari vengono deduplicati per `deviceId`;
- pagamento elettronico/contante su palmare resta abilitabile solo se `fiscalEnabled === true`;
- il modulo non effettua chiamate a batteria, RT, stampa o API fiscale.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 27.921 righe;
- `cassa-frontend/backend/server.js` dopo fase: 27.861 righe;
- riduzione netta fase: 60 righe;
- riduzione totale da baseline memoria monolite: 1.308 righe;
- modulo locale: 40 righe;
- modulo palmari: 56 righe.

Test eseguiti:

- isolati locale/palmari: OK, 7/7;
- configurazione/settings con locale, attivita, stampanti e palmari: OK, 33/33;
- suite domini completa: OK, 78/78;
- `npm run check:backend`: OK;
- stampa/pagamenti/fiscale simulati con invarianti ordini/pagamenti: OK, 46/46;
- `node --test backend/tests/security.test.mjs`: 26/27, failure preesistente su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure preesistente su pausa postazione `undefined !== false` piu wrapper suite.

Rischi residui:

- table move digitale resta rosso nel gate security;
- pausa postazione resta rossa nel gate continuity;
- evitare estrazioni di service con side effect finche' questi gate non sono verdi.

Prossimo step consigliato:

1. bugfix table move digitale;
2. bugfix pausa postazione;
3. se si procede ancora con monolite, scegliere soltanto helper puri di area/workstation/cash point o snapshot/report.

## Aggiornamento ciclo 2026-06-05 - riduzione monolite area config domain

Contesto:

- micro-slice pura in area configurazione sale;
- obiettivo: spostare fuori dal monolite sanitizzazione di sale, cash point e postazioni di sala;
- nessun cambiamento a routing runtime, stampa reale, RT, fiscale, pagamenti, DB o endpoint impostazioni.

Modifiche applicate:

- creato `cassa-frontend/backend/modules/configuration/area-config.domain.js`;
- aggiunto `cassa-frontend/backend/tests/area-config-domain.test.mjs`;
- `cassa-frontend/backend/server.js` usa ora `createPosAreaConfigHelpers()`.

Funzioni rimosse da `server.js`:

- `resolveConfiguredAreaMinimumTables`;
- `sanitizePosAreaCashPoint`;
- `sanitizePosAreaWorkstation`;
- `sanitizePosArea`.

Regole architetturali confermate:

- la sala puo' avere menu, listini, camerieri, stampanti operative, stampanti preconto, cash point e postazioni;
- il cash point mantiene `fiscalPrinterId` solo se presente tra le stampanti configurate;
- la postazione mantiene scope di menu, categorie, articoli ed esclusioni;
- le schedule menu/listino restano responsabilita' del modulo menu e vengono passate alla factory;
- nessun fallback di stampante o RT viene introdotto.

Metriche:

- `cassa-frontend/backend/server.js` prima fase: 27.861 righe;
- `cassa-frontend/backend/server.js` dopo fase: 27.756 righe;
- riduzione netta fase: 105 righe;
- riduzione totale da baseline memoria monolite: 1.413 righe;
- modulo area: 136 righe;
- test area: 183 righe.

Test eseguiti:

- isolato area config: OK, 5/5;
- configurazione/settings con sale, locale, attivita, stampanti e palmari: OK, 38/38;
- suite domini completa: OK, 83/83;
- `npm run check:backend`: OK;
- stampa/pagamenti/fiscale simulati con invarianti ordini/pagamenti: OK, 46/46;
- `node --test backend/tests/security.test.mjs`: 26/27, failure preesistente su table move digitale `400 !== 200`;
- `node --test backend/tests/continuity.e2e.test.mjs`: 66/68, failure preesistente su pausa postazione `undefined !== false` piu wrapper suite.

Rischi residui:

- table move digitale resta rosso nel gate security;
- pausa postazione resta rossa nel gate continuity;
- non procedere con estrazioni di service side-effect prima di avere questi gate sotto controllo.

Prossimo step consigliato:

1. bugfix table move digitale;
2. bugfix pausa postazione;
3. poi valutare estrazione print preferences o snapshot/report come altri helper puri.

## Aggiornamento ciclo 2026-06-05 - trasferimento solo verso postazioni attive

Contesto:

- richiesta operativa: cliccando `Trasferisci` devono comparire solo postazioni realmente attive;
- non devono apparire postazioni in pausa, offline, stale, demo o semplicemente configurate ma non operative;
- la regola deve valere sia per trasferimento coda durante pausa postazione sia per modale manuale `Trasferisci comanda`.

Modifiche applicate:

- `cassa-frontend/backend/modules/integration/station-pause-transfer.js` ora espone `isStationPauseTransferDestination()`;
- `filterStationPauseTransferDestinations()` richiede destinazione reale, attiva, non stale, non demo, non configurata, non in pausa e con identita' operatore/device valida;
- `postazione/dist/assets/postazione-station-operator-bridge.js` applica lo stesso filtro alla modale di trasferimento coda durante pausa, incluso fallback locale;
- `postazione/dist/assets/postazione-active-stations-bridge.js` non considera piu' demo fallback come postazioni reali attive e, nella modale `Trasferisci comanda`, nasconde/disabilita le tile non trasferibili.
- `postazione/dist/index.html` aggiorna il cache-buster degli asset postazione coinvolti, cosi' il fix viene caricato al refresh del frontend.

Invariante:

- una comanda o coda non puo' essere trasferita verso una postazione che non e' una sessione reale online/non stale/non in pausa;
- l'operatore non deve vedere scelte non utilizzabili nella modale di trasferimento;
- eventuali postazioni configurate senza sessione restano disponibili nella configurazione, ma non sono destinazioni operative.

Test eseguiti:

- `node --test cassa-frontend/frontend-tests/postazione-bridges.test.mjs`: OK, 27/27;
- `node --test cassa-frontend/backend/tests/station-pause-transfer.e2e.test.mjs`: OK, 4/4;
- `node --check postazione/dist/assets/postazione-active-stations-bridge.js`: OK;
- `node --check postazione/dist/assets/postazione-station-operator-bridge.js`: OK;
- `npm run check:backend`: OK.

Nota operativa:

- modifiche frontend statiche caricate al prossimo refresh dei browser;
- modifiche backend richiedono riavvio backend per essere attive nel servizio runtime.

## Aggiornamento ciclo 2026-06-05 - pausa postazione e selezione postazione esclusiva

Contesto:

- richiesta operativa: una postazione puo' entrare in pausa liberamente se non ha comande in coda;
- se ha comande trasferibili, deve chiedere se mantenerle sospese o trasferirle;
- quando ci sono piu' postazioni attive, l'operatore deve poter scegliere la destinazione da menu a tendina personalizzato;
- regola architetturale aggiornata: `1 postazione = 1 utente operativo`; una postazione gia' occupata da altro utente non e' selezionabile e viene rifiutata anche dal backend.

Modifiche applicate:

- `postazione/dist/assets/postazione-station-operator-bridge.js`:
  - prima della pausa controlla se esistono comande trasferibili su `/api/integration/orders`;
  - se non esistono comande trasferibili invia subito `pauseTransferMode=suspend` senza aprire modali;
  - se esistono comande e ci sono destinazioni attive, apre una modale con dropdown custom;
  - `Trasferisci coda` invia `pauseTransferMode=transfer`, `transferOrders=true` e `pauseTransferTargetStation`;
  - `Mantieni in coda` invia `pauseTransferMode=suspend`;
  - le destinazioni sono solo postazioni reali, attive, non stale, non demo, non configurate-placeholder e non in pausa.
- `postazione/dist/assets/postazione-station-modal-options-fix.js`:
  - il dropdown postazione resta personalizzato;
  - la scelta e' provvisoria finche' non si preme `Conferma`;
  - le postazioni occupate da altri utenti sono disabilitate e indicate come occupate;
  - la conferma valida la scelta e applica il cambio solo al click finale.
- `cassa-frontend/backend/server.js`:
  - `POST /api/integration/stations/state` rifiuta con `409 STATION_ALREADY_OCCUPIED` una postazione attiva gia' occupata da un altro operatore;
  - durante la pausa accetta `pauseTransferTargetStation` e trasferisce la coda verso quella destinazione solo se e' tra le postazioni trasferibili;
  - se la destinazione richiesta non e' disponibile, non trasferisce in silenzio verso un'altra postazione.
- `postazione/dist/index.html`:
  - cache-buster aggiornati per i bridge coinvolti.

Invarianti:

- una postazione non puo' essere occupata contemporaneamente da due utenti diversi;
- una selezione nel menu postazione non cambia stato finche' non viene confermata;
- il trasferimento coda da pausa non puo' andare verso postazioni offline, in pausa, demo o solo configurate;
- se non ci sono comande trasferibili, la pausa non deve mostrare modali inutili.

Test eseguiti:

- `node --test cassa-frontend/frontend-tests/postazione-bridges.test.mjs`: OK, 30/30;
- `node --test cassa-frontend/backend/tests/station-pause-transfer.e2e.test.mjs`: OK, 6/6;
- `node --test cassa-frontend/backend/tests/integration-stations-domain.test.mjs cassa-frontend/backend/tests/integration-station-states-domain.test.mjs`: OK, 8/8;
- `npm run check:backend`: OK;
- `node --check postazione/dist/assets/postazione-station-operator-bridge.js`: OK;
- `node --check postazione/dist/assets/postazione-station-modal-options-fix.js`: OK.

Nota operativa:

- modifiche frontend statiche caricate al prossimo refresh dei browser;
- modifiche backend richiedono riavvio backend per essere attive nel servizio runtime.

## Aggiornamento ciclo 2026-06-05 - squillo palmari da impostazioni

Contesto:

- dalla sezione `Impostazioni > Palmari` il pulsante `Squillo` poteva non far arrivare la chiamata al palmare;
- la causa principale era il targeting fragile: il frontend impostazioni inviava solo `deviceId`, che non sempre coincide con il `deviceUuid` reale usato dal mobile;
- la notifica `handheld_ring` deve poter essere consegnata in modo deterministico per UUID, alias o IP del device.

Modifiche applicate:

- `settings-frontend/dist/assets/settings-app.js` conserva `deviceUuid` nei device configurati/rilevati;
- il bottone `Squillo` invia ora a `/api/settings/mobile-devices/ring` anche `deviceUuid` e `clientIp` quando disponibili;
- `cassa-frontend/backend/modules/configuration/mobile-device-config.domain.js` conserva `deviceUuid` distinto da `deviceId`, evitando di perdere il riferimento reale del palmare durante salvataggio/configurazione;
- `cassa-frontend/backend/modules/settings/settings.handlers.js` pubblica il refresh SSE dello squillo con target effettivo (`targetDeviceUuid` e/o `targetClientIp`);
- `mobile-frontend/src/api/notifications.ts` normalizza gli alias device, rispetta `targetClientApp` e accetta correttamente gli squilli gia' filtrati dal backend per IP;
- `settings-frontend/dist/index.html` aggiorna il cache-buster dello script impostazioni.

Invariante:

- lo squillo palmare da impostazioni deve essere consegnato solo al device target;
- il matching deve funzionare anche se `deviceId`, `deviceUuid` e IP non coincidono perfettamente;
- un client diverso da `mobile-frontend` non deve ricevere notifiche mirate al mobile.

Test eseguiti:

- `node --test cassa-frontend/backend/tests/notification-records.test.mjs`: OK, 3/3;
- `node --test cassa-frontend/backend/tests/mobile-device-config-domain.test.mjs`: OK, 5/5;
- `npm run test -- notificationsTargeting.test.ts` in `mobile-frontend`: OK, 1/1;
- `node --check settings-frontend/dist/assets/settings-app.js`: OK;
- `node --check cassa-frontend/backend/modules/settings/settings.handlers.js`: OK;
- `npm run check:backend`: OK;
- `npm run typecheck` in `mobile-frontend`: OK.
- `npm run build` in `mobile-frontend`: OK, asset runtime aggiornati in `mobile-frontend/dist`.

Nota operativa:

- il frontend impostazioni prende il fix al refresh della pagina;
- la parte backend richiede riavvio backend per essere attiva nel servizio runtime.

## Aggiornamento ciclo 2026-06-05 16:34 CEST - riavvio completo e verifiche GUI/runtime

Contesto:

- richiesto riavvio dei servizi e verifica ulteriore del funzionamento tramite test automatici, API live e simulazione GUI reale;
- i servizi applicativi sono stati riavviati mantenendo gli stessi parametri runtime osservati prima del restart;
- non sono stati toccati servizi esterni non appartenenti al runtime POS.

Servizi riavviati:

- backend cassa su `0.0.0.0:5181`, con `BACKEND_DB_MODE=sqlite` e `BACKEND_DB_PATH=/srv/applicazione/data/backend.sqlite`;
- frontend statici su `0.0.0.0:5180`, con proxy API verso `http://127.0.0.1:5181`;
- servizio batterie su `0.0.0.0:8765`.

Verifiche live:

- `GET /api/health`: OK;
- `GET /battery`: OK, 2 palmari online (`Amalia-1`, `Amalia-2`);
- `GET /api/integration/stations/active`: OK, postazioni reali attive `BAR-1` e `BAR-2`;
- `GET /api/integration/stations/state`: OK, configurate `BAR-1`, `BAR-2`, `CHIRINGUITO-1`, `CHIRINGUITO-2`, `MOBILE`, `PIZZA IN RIVA`;
- pagine GUI caricate senza errori console critici:
  - `http://127.0.0.1:5180/mobile/`;
  - `http://127.0.0.1:5180/postazione/`;
  - `http://127.0.0.1:5180/monitor/`;
  - `http://127.0.0.1:5180/impostazioni/`;
  - `http://127.0.0.1:5180/prenotazioni/`.

Correzione applicata durante le verifiche:

- nello smoke GUI reale della modale `Seleziona postazione` e' emerso che il bridge riallineava il `select` nativo emettendo troppi eventi `change` durante il rendering;
- `postazione/dist/assets/postazione-station-modal-options-fix.js` ora distingue il riallineamento silenzioso dal cambio confermato:
  - rendering/popolamento opzioni: non emette `input/change` e non salva in storage;
  - click su opzione custom: rimane provvisorio;
  - click su `Conferma`: emette il cambio una sola volta e salva la postazione scelta;
- `postazione/dist/index.html` aggiorna il cache-buster dello script;
- `cassa-frontend/frontend-tests/postazione-bridges.test.mjs` aggiornato per verificare la nuova regola: la postazione non viene salvata prima della conferma.

Smoke GUI reale postazione:

- picker personalizzato creato correttamente sulla modale `.modal-station`;
- `BAR-1` risulta occupata da `Chiara Giordano` e disabilitata;
- `BAR-2` risulta occupata da `Roberto Pratesi` e disabilitata;
- il testo legacy `Suggerimento: usa questa voce per cambiare postazione` viene rimosso;
- clic su `CHIRINGUITO-2` prima della conferma:
  - label custom aggiornata;
  - `select.value` ancora `BAR-1`;
  - storage non aggiornato;
  - nessun evento `change`;
- click su `Conferma`:
  - `select.value` diventa `CHIRINGUITO-2`;
  - storage aggiornato a `CHIRINGUITO-2`;
  - nessun valore `undefined`;
  - un solo evento `change` osservato.

Test eseguiti:

- `node --check postazione/dist/assets/postazione-station-modal-options-fix.js`: OK;
- `node --test cassa-frontend/frontend-tests/postazione-bridges.test.mjs`: OK, 30/30;
- `node --test cassa-frontend/backend/tests/station-pause-transfer.e2e.test.mjs`: OK, 6/6;
- `npm run test:frontend` in `cassa-frontend`: OK, 70/70;
- `npm run check:backend` in `cassa-frontend`: OK;
- `npm run test:backend:release` in `cassa-frontend`: OK, release gate completato;
- smoke Playwright GUI postazione/mobile/monitor/impostazioni/prenotazioni: OK, nessun errore console o page error critico.

Note operative:

- il path corretto del frontend impostazioni e' `/impostazioni/`, non `/settings/`;
- il frontend statico carica la correzione del picker al refresh grazie al cache-buster aggiornato;
- non sono stati effettuati pagamenti o stampe reali in questo ciclo di verifica.

## Aggiornamento ciclo 2026-06-05 16:42 CEST - rimozione palmari non online dopo 5 minuti

Contesto:

- richiesto di togliere i device non online dopo 5 minuti;
- le postazioni configurate non vengono rimosse, perche' servono come configurazione selezionabile e non rappresentano presenza live;
- la rimozione e' stata applicata al servizio batterie/palmari, che espone la lista live dei device.

Modifiche applicate:

- `battery-dashboard/server/index.js`:
  - default `REMOVE_AFTER_SECONDS` portato da `360` a `300`;
  - i device senza heartbeat vengono cancellati dallo snapshot dopo 5 minuti.
- `/etc/systemd/system/battery-dashboard.service`:
  - `Environment=REMOVE_AFTER_SECONDS=300`;
  - eseguiti `systemctl daemon-reload` e restart del solo servizio `battery-dashboard.service`.

Verifiche:

- servizio `battery-dashboard.service`: attivo;
- ambiente runtime verificato:
  - `PORT=8765`;
  - `OFFLINE_AFTER_SECONDS=180`;
  - `REMOVE_AFTER_SECONDS=300`;
- `GET http://127.0.0.1:8765/battery`: OK, `remove_after_seconds=300`;
- test isolato su porta temporanea con `REMOVE_AFTER_SECONDS=1`:
  - device visibile appena inviato;
  - device rimosso dopo superamento soglia;
  - evento di rimozione generato;
- `node --check battery-dashboard/server/index.js`: OK;
- ricerca residui `REMOVE_AFTER_SECONDS=360`: nessun riferimento attivo trovato.

Nota operativa:

- il servizio batterie mantiene i device in memoria; dopo restart la lista si ripopola al prossimo heartbeat reale dei palmari;
- il backend e i frontend non sono stati riavviati in questo ciclo.

## Aggiornamento ciclo 2026-06-05 16:51 CEST - load balancing postazioni BAR-1/BAR-2

Contesto:

- osservato che quasi tutte le comande venivano assegnate a Roberto su `BAR-2`, con solo una su `BAR-1`;
- `GET /api/integration/stations/active` mostrava correttamente `BAR-1` e `BAR-2` attive;
- gli ordini aperti recenti risultavano assegnati a `BAR-2` con `assignmentReasonDetail=least_estimated_workload`.

Causa individuata:

- la finestra di stale delle postazioni usata dal backend era impostata a 60 secondi (`INTEGRATION_STATION_STALE_MS`);
- in caso di heartbeat leggermente ritardato, una postazione reale poteva uscire dal pool eleggibile troppo presto;
- quando `BAR-1` usciva temporaneamente dal pool, il load balancer assegnava tutto a `BAR-2`, pur non essendoci hardcode verso Roberto.

Modifiche applicate:

- `cassa-frontend/backend/server.js`:
  - default `INTEGRATION_STATION_STALE_MS` portato da 60 secondi a 5 minuti;
  - la soglia e' ora coerente con la finestra operativa gia' usata dal load balancer e con la presenza reale delle postazioni.
- `cassa-frontend/backend/tests/integration-station-states-domain.test.mjs`:
  - aggiunto test che garantisce che una postazione con heartbeat vecchio di 2 minuti resti eleggibile con finestra di 5 minuti.

Verifiche:

- `node --test cassa-frontend/backend/tests/integration-station-states-domain.test.mjs cassa-frontend/backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 10/10;
- `npm run check:backend`: OK;
- riavviato solo `applicazione-backend.service`;
- `GET http://127.0.0.1:5181/api/health`: OK;
- `GET http://127.0.0.1:5181/api/integration/stations/active`: OK, `BAR-1` e `BAR-2` attive e non stale;
- simulazione con snapshot live:
  - `BAR-1`: workload 0;
  - `BAR-2`: 3 ordini aperti, 8 articoli, workload stimato circa 4976 secondi;
  - prossimo ordine simulato: assegnato a `BAR-1` con `least_estimated_workload`.

Nota operativa:

- gli ordini gia' assegnati a `BAR-2` non sono stati spostati automaticamente per evitare effetti collaterali su comande gia' in preparazione;
- le nuove comande includono `BAR-1` nel pool finche' la postazione resta entro la finestra di 5 minuti.

## Aggiornamento ciclo 2026-06-05 16:57 CEST - bilanciamento equo con storico velocita'

Contesto:

- dopo il primo fix `BAR-1` restava online, ma alcune comande continuavano ad arrivare a `BAR-2`;
- analisi degli ordini `00162`-`00165`:
  - `00162` assegnata a `BAR-1`;
  - `00163`, `00164`, `00165` assegnate a `BAR-2`;
  - le postazioni erano entrambe attive e configurate in modo simmetrico;
  - lo storico operativo stimava `BAR-2` molto piu' veloce e poteva farle assorbire piu' comande anche quando la coda era gia' superiore.

Causa individuata:

- il load balancer ordinava i candidati prima per workload stimato in secondi;
- il workload stimato incorporava lo storico di velocita' operatore/postazione;
- una postazione storicamente piu' veloce poteva quindi continuare a ricevere comande anche con piu' coda aperta.

Modifica applicata:

- `cassa-frontend/backend/integration/load-balancer.service.js`:
  - priorita' di scelta aggiornata:
    1. numero comande aperte;
    2. numero articoli aperti;
    3. workload stimato in secondi;
    4. rotazione deterministica;
    5. stima ordine/storico e tie-breaker finali;
  - lo storico rimane utile, ma non puo' piu' diventare una corsia preferenziale infinita.
- `cassa-frontend/backend/tests/load-balancer-station-eligibility.test.mjs`:
  - aggiunto test che verifica che una postazione storicamente piu' veloce non venga preferita se ha gia' piu' coda.

Verifiche:

- `node --test cassa-frontend/backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 5/5;
- `node --test cassa-frontend/backend/tests/integration-station-states-domain.test.mjs cassa-frontend/backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 11/11;
- `npm run check:backend`: OK;
- riavviato solo `applicazione-backend.service`;
- `GET http://127.0.0.1:5181/api/health`: OK;
- `GET http://127.0.0.1:5181/api/integration/stations/active`: OK, `BAR-1` e `BAR-2` attive;
- simulazione sequenza rapida stile `00162`-`00169`:
  - prima coda simile: alternanza;
  - se `BAR-2` accumula piu' ordini/articoli, il prossimo ordine torna a `BAR-1`.

Nota operativa:

- la modifica non sposta comande gia' assegnate;
- effetto atteso sulle nuove comande: distribuzione piu' equa tra `BAR-1` e `BAR-2`, evitando concentrazione su Roberto solo per storico di velocita'.

## Aggiornamento ciclo 2026-06-05 16:59 CEST - disattivazione temporanea peso tempo nel load balancing

Contesto:

- richiesto di togliere per il momento la parte legata al tempo/storico dal bilanciamento;
- obiettivo operativo: evitare che la stima secondi per operatore/postazione condizioni la scelta tra `BAR-1` e `BAR-2`.

Modifica applicata:

- `cassa-frontend/backend/integration/load-balancer.service.js`:
  - il sort del load balancer ora usa:
    1. numero comande aperte;
    2. numero articoli aperti;
    3. rotazione deterministica;
    4. tie-breaker tecnici stabili;
  - `stationWorkloadSeconds` e `orderSeconds` restano nei candidati solo come diagnostica, ma non decidono piu' la postazione.
- `cassa-frontend/backend/tests/load-balancer-station-eligibility.test.mjs`:
  - aggiornato fixture helper `activeStation()` per supportare override espliciti;
  - corretto fixture storico sbilanciato;
  - aggiunta/assertita copertura che dimostra che una postazione piu' lenta puo' essere scelta dalla rotazione quando il carico e' pari.

Verifiche:

- `node --test cassa-frontend/backend/tests/load-balancer-station-eligibility.test.mjs cassa-frontend/backend/tests/integration-station-states-domain.test.mjs`: OK, 11/11;
- `npm run check:backend`: OK;
- riavviato solo `applicazione-backend.service`;
- `GET http://127.0.0.1:5181/api/health`: OK;
- `GET http://127.0.0.1:5181/api/integration/stations/active`: OK, `BAR-1` e `BAR-2` attive;
- simulazione prossimi ID con carico pari:
  - `00166` -> `BAR-1`;
  - `00167` -> `BAR-2`;
  - `00168` -> `BAR-1`;
  - `00169` -> `BAR-2`;
  - alternanza regolare.

Nota operativa:

- il tempo/storico potra' essere riattivato piu' avanti solo se pesato in modo controllato e testato;
- per ora il comportamento e' volutamente piu' semplice e deterministico.

## Aggiornamento ciclo 2026-06-05 17:56 CEST - reset operativo completo e monitor

Contesto:

- richiesto reset totale di tavoli, ordini, pagamenti, comande e conteggi monitor;
- il reset monitor esistente liberava i tavoli ma preservava pagamenti, transazioni, scontrini fiscali, statistiche e storico finanziario.

Modifiche applicate:

- `cassa-frontend/backend/modules/status/status.handlers.js`:
  - `reset_all_tables` ora esegue reset operativo completo:
    - libera tutti i tavoli;
    - cancella ordini/comande;
    - cancella notifiche operative;
    - cancella pagamenti, contenitori pagamento, parti e transazioni;
    - cancella transazioni provider;
    - cancella riferimenti fiscali locali ed eventi fiscali;
    - cancella spool stampa;
    - cancella lock tavoli, cambi sala/tavolo e stati prenotazione runtime;
    - cancella sessioni cassa operative;
    - azzera storico operativo e conteggi monitor;
  - mantiene configurazioni, utenti, sale, menu, stampanti, RT, postazioni e stato live postazioni;
  - il monitor usa ora la stessa ricostruzione delle postazioni live usata dagli endpoint postazione, evitando falsi stale dopo reset/riavvio.
- `monitor-frontend/dist/app.js`:
  - testo del pulsante reset aggiornato a `Reset operativo completo`;
  - la modale spiega che vengono cancellati ordini, pagamenti, transazioni, notifiche, spool e conteggi monitor.

Reset eseguito:

- fermato solo `applicazione-backend.service`;
- creato backup prima del reset:
  - `/srv/applicazione/current/cassa-frontend/backend/backups/app-state-before-full-operational-reset-2026-06-05T15-55-16-712Z.json`;
  - `/srv/applicazione/current/cassa-frontend/backend/backups/app-state-file-before-full-operational-reset-2026-06-05T15-55-16-712Z.json`;
- aggiornato DB SQLite `/srv/applicazione/data/backend.sqlite`;
- aggiornato mirror `/srv/applicazione/current/cassa-frontend/backend/app-state.json`;
- riavviato solo `applicazione-backend.service`.

Conteggi prima:

- ordini: 17;
- notifiche: 68;
- pagamenti locali duplicati tra contenitori/record: 6;
- parti pagamento: 3;
- transazioni pagamento: 3;
- ricevute fiscali locali: 3;
- eventi fiscali: 9;
- spool stampa: 39;
- sessioni cassa: 4;
- audit events: 1489;
- storico fulfillment: 96;
- pause cameriere runtime: 2.

Verifiche dopo reset:

- backend health OK;
- monitor overview:
  - ordini total: 0;
  - tavoli occupati: 0;
  - tavoli liberi: 117;
  - pagamenti total: 0;
  - totale pagato: 0;
  - totale da pagare: 0;
  - coperti correnti: 0;
  - apericena segnati: 0;
  - scontrini fiscali locali: 0;
  - movimenti pagamento: 0;
  - transazioni: 0;
  - modifiche/storni/sostituzioni: 0;
  - spool stampa: 0;
  - audit monitor: 0;
- DB:
  - ordini: 0;
  - notifiche: 0;
  - pagamenti: 0;
  - transazioni: 0;
  - fiscali locali: 0;
  - spool: 0;
  - sessioni cassa: 0.

Test:

- `npm run check:backend`: OK;
- `node --test cassa-frontend/backend/tests/load-balancer-station-eligibility.test.mjs cassa-frontend/backend/tests/integration-station-states-domain.test.mjs`: OK, 11/11.

Nota operativa:

- dopo il riavvio risulta live solo `BAR-2` con Roberto tramite endpoint `/api/integration/stations/active`;
- `BAR-1` non e' stata forzata artificialmente: rientrera' live al prossimo heartbeat reale della postazione.

## Ciclo 2026-06-05 - Ripristino lista comande nel dettaglio tavolo mobile

Richiesta:

- nel dettaglio tavoli la lista delle comande era scomparsa e doveva essere ripristinata.

Causa individuata:

- `mobile-frontend/src/pages/home/tables/components/TableDetailPanel.tsx` montava la sezione storico ordini solo se `table.orderHistory.length > 0`;
- dopo reset/liberazione tavoli lo storico era vuoto, quindi l'intera card veniva rimossa dalla UI invece di restare visibile con stato vuoto;
- un effetto richiudeva inoltre lo storico quando non c'erano ordini, rendendo il comportamento poco chiaro.

Modifica applicata:

- rimossa la dipendenza da `hasAnyOrder`;
- la card `Storico ordini (n)` viene mostrata sempre nel dettaglio tavolo;
- se non ci sono comande, a sezione aperta mostra `Nessuna comanda per questo tavolo.`;
- quando arrivano nuove comande la lista torna a popolarsi automaticamente senza dover ricreare la card.

File modificati:

- `mobile-frontend/src/pages/home/tables/components/TableDetailPanel.tsx`;
- bundle rigenerato in `mobile-frontend/dist`.

Verifiche:

- `npm run build` in `mobile-frontend`: OK;
- la build include `npm run typecheck`: OK;
- verificato che il testo dello stato vuoto sia presente sia nel sorgente sia nel bundle `dist`.

Nota operativa:

- non e' stato necessario riavviare il backend;
- se il frontend e' servito da asset statici gia' aggiornati, basta refresh del client/mobile per vedere la card ripristinata.

## Ciclo 2026-06-05 - Ripristino stampa preconti dopo cambio device postazione

Richiesta:

- dopo spegnimento postazione, cambio device e nuovo login, la stampante preconti non funzionava piu'.

Causa individuata:

- la postazione live `BAR-1` risultava attiva con Roberto, ma con:
  - `autoPrintOrders: false`;
  - `autoPrintPreconto: false`;
- la configurazione stabile della postazione invece aveva:
  - `printOrderEnabled: true`;
  - `printPrecontoEnabled: true`;
  - `precontoPrinterIds: ["printer_bar_1921681195_9100"]`;
- quando il device nuovo faceva heartbeat/upsert senza inviare esplicitamente i flag `autoPrintOrders` e `autoPrintPreconto`, il backend inizializzava la nuova entry runtime a `false`;
- anche la recovery da sessione postazione ricostruiva la station state senza leggere i default configurati, quindi dopo cambio device poteva perdere la stampa automatica;
- la stampante fisica non risultava guasta: gli ultimi job spool registrati erano `printed` verso `Stampante preconti e comande Bar 192.168.1.102`.

Modifica applicata:

- aggiunto `resolveStationConfiguredPrintDefaults(db, station)` in `cassa-frontend/backend/server.js`;
- heartbeat postazione e session recovery ora impostano `autoPrintOrders` e `autoPrintPreconto` dai campi configurati della postazione:
  - `printOrderEnabled`;
  - `printPrecontoEnabled`;
- endpoint `POST /api/integration/stations/state` ora usa i default configurati quando il frontend non manda esplicitamente i flag;
- se il frontend manda esplicitamente `autoPrintOrders` o `autoPrintPreconto`, il valore esplicito viene ancora rispettato.

Intervento operativo:

- creato backup prima della correzione runtime:
  - `/srv/applicazione/current/cassa-frontend/backend/backups/app-state-before-station-print-flags-2026-06-05T20-37-53-290Z.json`;
- aggiornato lo stato runtime della postazione attiva nel DB per riallineare subito `BAR-1`;
- `systemctl restart` e' andato in timeout senza fermare il processo;
- verificato che il backend fosse ancora sano;
- riavviato controllatamente solo il processo Node del backend con `Restart=always` systemd;
- nuovo PID backend: `3633424`;
- health OK dopo riavvio.

Verifiche dopo fix:

- `GET /api/integration/stations/active` mostra:
  - `BAR-1`;
  - `active: true`;
  - `autoPrintOrders: true`;
  - `autoPrintPreconto: true`;
  - operatore Roberto;
- `npm run check:backend`: OK;
- test mirati:
  - `backend/tests/integration-station-states-domain.test.mjs`: OK;
  - `backend/tests/printer-config-domain.test.mjs`: OK;
  - `backend/tests/area-config-domain.test.mjs`: OK;
  - `backend/tests/station-availability-alerts.e2e.test.mjs`: OK.

Test riallineato:

- `backend/tests/station-availability-alerts.e2e.test.mjs` usava ancora la vecchia postazione `BAR PRINCIPALE`;
- aggiornato a `BAR-1`, coerente con la configurazione attuale.

Nota operativa:

- non e' stata inviata una stampa fisica di test non richiesta;
- se il preconto continua a non uscire, la prossima verifica deve essere sul singolo job spool creato durante il tentativo reale e sulla raggiungibilita' TCP di `192.168.1.102:9100`.

## Ciclo 2026-06-06 - Audit duplicati runtime e robustezza modali mobile

Richiesta:

- assicurare che non ci siano duplicati in memoria/DB su tavoli, transazioni, ordini e strutture operative;
- correggere il crash mobile nella modale di cancellazione tavolo quando si clicca sulla modale/backdrop;
- cercare situazioni simili nelle modali operative.

Audit DB reale:

- sorgente controllata: `/srv/applicazione/data/backend.sqlite`, tabella `app_state`;
- snapshot `updated_at`: `2026-06-05T23:46:57.809Z`;
- nessun duplicato trovato nei seguenti insiemi:
  - `posSettings.tables:id`: 117 record;
  - `integration.orders:id`: 9 record;
  - `paymentTransactions:id`: 12 record;
  - `paymentProviderTransactions:id`: 0 record;
  - `payments:id`: 11 record;
  - `paymentParts:id`: 12 record;
  - `paymentContainers:id`: 12 record;
  - `fiscalReceipts:id`: 12 record;
  - `printSpoolJobs:id`: 64 record;
  - `sessions:id`: 5 record;
  - `users:id`: 14 record;
  - `notifications:id`: 3 record;
  - `stationStates:key`: 0 record.

Causa probabile crash/instabilita modale:

- alcune modali mobile chiudevano direttamente sul click del backdrop;
- durante operazioni asincrone (`busy`) un tap accidentale sul bordo poteva smontare la modale mentre cancellazione, spostamento, ordine o pagamento erano ancora in corso;
- su touch mobile il problema poteva sembrare un crash o una UI rimasta in stato incoerente.

Modifica applicata:

- in `TableGroupsDialog` il backdrop ora chiude solo se:
  - il click e' realmente sul backdrop;
  - `busy` e' `false`;
- la card interna ferma esplicitamente click e pointer event;
- i pulsanti di chiusura delle modali gruppi tavolo sono disabilitati durante `busy`;
- il parent `TablesWorkspace` ignora `onClose` mentre `actionBusy` e' attivo;
- stessa protezione anti-smontaggio durante `busy` applicata a:
  - nuova comanda;
  - wizard pagamento;
  - dettaglio tavolo;
  - modale spostamento tavolo dal dettaglio.

File modificati:

- `mobile-frontend/src/pages/home/tables/components/TableGroupsDialog.tsx`;
- `mobile-frontend/src/pages/home/tables/TablesWorkspace.tsx`;
- `mobile-frontend/src/pages/home/tables/components/TableOrderComposer.tsx`;
- `mobile-frontend/src/pages/home/tables/components/TablePaymentWizard.tsx`;
- `mobile-frontend/src/pages/home/tables/components/TableDetailPanel.tsx`;
- bundle rigenerato in `mobile-frontend/dist`.

Verifiche:

- scansione grep su modali tavolo: nessun pattern residuo `backdrop` con `onClick={onClose}` nelle componenti tavolo critiche;
- `npm run build` in `mobile-frontend`: OK;
- la build include `npm run typecheck`: OK.

Rischi residui:

- l'audit conferma assenza di duplicati nello stato corrente, ma non introduce ancora una deduplica forzata in scrittura;
- scelta intenzionale: non deduplicare automaticamente record operativi in produzione senza conoscere la causa, per evitare cancellazioni silenziose;
- prossimo step consigliato: aggiungere un test/utility periodica di audit duplicati e poi proteggere a monte le sorgenti che possono creare record doppi.

## Ciclo 2026-06-06 - Riallineamento sala/attivita mobile e routing Bar/Pizza/preconti/RT

Richiesta:

- continuare a cercare bug simili o dimenticanze;
- garantire che un utente mobile su sala Bar o utente solo Bar usi il contesto operativo Bar:
  - stampante non fiscale Bar;
  - stampante preconti Bar;
  - RT Bar quando la fiscalita e' prevista;
- evitare dirottamenti verso Pizza in Riva o altre attivita.

Causa individuata:

- `mobile-frontend/src/pages/home/tables/TablesWorkspace.tsx` riallineava la sala nello store solo quando cambiava il nome sala;
- se `roomId` era corretto ma `activityId`/`activityName` erano stale, mancanti o ereditati da una sessione precedente, il mobile poteva continuare a usare un contesto operativo errato;
- la stessa dimenticanza esisteva in `mobile-frontend/src/pages/SettingsPage.tsx`;
- nel dominio backend `effectivePrecontoPrinterIds` restava vuoto quando l'attivita aveva solo `printerIds`, anche se la stampa preconto poi cadeva correttamente sulle stampanti non fiscali effettive. Questo rendeva lo snapshot meno esplicito.

Modifiche applicate:

- `TablesWorkspace` ora riallinea lo store sala se cambia anche solo:
  - `activityId`;
  - `activityName`;
  - non solo `roomName`;
- `SettingsPage` applica la stessa regola;
- `resolveOperationalContext()` ora risolve `effectivePrecontoPrinterIds` cosi':
  - preconti sala, se configurati;
  - altrimenti preconti attivita, se configurati;
  - altrimenti stampanti non fiscali effettive della stessa attivita/sala;
- la regola non usa stampanti di altre attivita e filtra le stampanti fiscali;
- aggiunto test statico mobile per impedire regressione del riallineamento `activityId/activityName`;
- aggiunto test backend per garantire che i preconti ereditino solo stampanti non fiscali del proprio contesto.

Verifica configurazione live:

- `activity_bar + room_gazebo`:
  - `effectivePrinterIds`: `printer_bar_1921681195_9100`;
  - `effectivePrecontoPrinterIds`: `printer_bar_1921681195_9100`;
  - `fiscalDeviceIds`: `rt_bar_api`;
- `activity_bar + room_bar`:
  - `effectivePrinterIds`: `printer_bar_1921681195_9100`;
  - `effectivePrecontoPrinterIds`: `printer_bar_1921681195_9100`;
  - `fiscalDeviceIds`: `rt_bar_api`;
- `activity_pizza_in_riva + room_pizza_in_riva`:
  - `effectivePrinterIds`: `printer_pizza_in_riva_192168136_9100`;
  - `effectivePrecontoPrinterIds`: `printer_pizza_in_riva_192168136_9100`;
  - `fiscalDeviceIds`: vuoto.

File modificati:

- `mobile-frontend/src/pages/home/tables/TablesWorkspace.tsx`;
- `mobile-frontend/src/pages/SettingsPage.tsx`;
- `cassa-frontend/backend/modules/configuration/operational-context.js`;
- `cassa-frontend/backend/tests/operational-context-alias.test.mjs`;
- `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs`;
- bundle rigenerato in `mobile-frontend/dist`.

Test eseguiti:

- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 8/8;
- `npm run build` in `mobile-frontend`: OK, include typecheck;
- `node --test backend/tests/operational-context-alias.test.mjs`: OK, 2/2;
- `node --test backend/tests/configuration-snapshot.test.mjs backend/tests/printer-config-domain.test.mjs backend/tests/area-config-domain.test.mjs`: OK, 17/17;
- `npm run check:backend`: OK.

Nota operativa:

- non e' stato necessario modificare manualmente il DB;
- al prossimo refresh del mobile, lo store sala/attivita viene riallineato automaticamente dai dati reali `/api/pos/rooms`;
- se un device mantiene cache molto vecchia, basta rientrare nella pagina tavoli o impostazioni per riallineare `activityId`.

## Ciclo 2026-06-06 - Audit sequenze pagamento POS/provider e split

Richiesta:

- cercare altri errori nel pagamento o in sequenze operative simili;
- non inventare bug se non confermati dal codice o dai test.

Problemi confermati:

- nei pagamenti tavolo e ticket POS (`handlePayTable`, `handlePayTicket`) lo stato provider `settlement_pending` veniva aggiornato in memoria ma non scritto su DB prima della chiamata esterna `authorizeCardPayment()`;
- in caso di crash tra autorizzazione POS e write finale, il pagamento esterno poteva risultare approvato senza uno stato locale gia' durabile e facilmente riconciliabile;
- nel pagamento `free-split` con transazioni POS (`handlePaymentFreeSplit`) la carta veniva autorizzata senza creare una `paymentProviderTransactions` dedicata alla singola transazione split;
- sempre nel `free-split`, la validazione autoritativa finale su importo pagabile/overpayment/readiness arrivava dopo la costruzione delle transazioni: un POS in overpayment poteva quindi essere autorizzato e poi rifiutato;
- `PaymentTransactionRepository.updateInDb()` normalizzava gli stati ma non bloccava regressioni come `settled -> settlement_pending`.

Modifiche applicate:

- creato modulo puro `cassa-frontend/backend/modules/payments-provider/payment-provider-state-machine.js`;
- aggiunti stati, terminal states e transition graph esplicito per provider transaction;
- `PaymentTransactionRepository.updateInDb()` ora valida le transizioni e blocca regressioni da stati terminali, salvo override esplicito con reason;
- aggiunto helper backend `persistPaymentProviderTransaction()` per forzare `writeDb()` prima e dopo la chiamata POS;
- `handlePayTable()` e `handlePayTicket()` ora persistono `settlement_pending` prima di `authorizeCardPayment()` e persistono anche la risposta di autorizzazione prima di proseguire;
- `handlePaymentFreeSplit()` ora crea una provider transaction per ogni transazione POS della quota con idempotency key deterministica:
  - `<payment-idempotency>:part-N:tx-N:pos`;
  - in caso di POS OK viene marcata `settled` e collegata al `paymentTransaction.id`;
  - in caso di POS non configurato/fallito viene marcata `failed`;
  - se una retry trova gia' una autorizzazione persistita la riusa invece di richiamare alla cieca il provider.
- `handlePaymentFreeSplit()` ora anticipa la validazione autoritativa di:
  - comande non ancora pagabili;
  - totale superiore al pagabile;
  - importo articolo non coerente;
  prima di creare transazioni provider POS o inviare autorizzazioni.

File modificati:

- `cassa-frontend/backend/modules/payments-provider/payment-provider-state-machine.js`;
- `cassa-frontend/backend/modules/payments-provider/payment-provider-transactions.repository.js`;
- `cassa-frontend/backend/modules/payments-provider/index.js`;
- `cassa-frontend/backend/server.js`;
- `cassa-frontend/backend/tests/payment-provider-transactions.test.mjs`;
- `cassa-frontend/backend/tests/payment-weird-cases.e2e.test.mjs`.

Test eseguiti:

- `node --test backend/tests/payment-provider-transactions.test.mjs`: OK, 6/6;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs`: OK, 15/15;
- `node --test backend/tests/payments-fiscal.e2e.test.mjs`: OK, 5/5;
- `node --test backend/tests/orders-payments-invariants.test.mjs`: OK, 15/15;
- `node --test backend/tests/payment-splits.test.mjs backend/tests/payment-money-domain.test.mjs backend/tests/payment-order-refs-domain.test.mjs backend/tests/payment-print-format-domain.test.mjs`: OK, 22/22;
- `node --test backend/tests/relational-payments.test.mjs`: OK, 12/12;
- `npm run check:backend`: OK.

Rischi residui:

- non e' stato introdotto un servizio completo di riconciliazione automatica provider: le transazioni rimaste `settlement_pending`, `settlement_failed` o `manual_reconciliation_required` vanno ancora gestite da audit/report o futuro worker;
- i retry dopo crash sono ora piu' sicuri perche' trovano uno stato durabile, ma la decisione finale di riconciliazione operativa resta da completare con uno step dedicato;
- non e' stato riavviato alcun servizio in questo ciclo.

## Ciclo 2026-06-06 - Audit comande, camerieri, pause e cambio sala

Richiesta:

- verificare bug in circostanze diverse dai pagamenti:
  - comande;
  - comande modificate;
  - flussi fra camerieri;
  - warning stile v1 quando si prova a spostare un tavolo in una sala gia' presidiata;
  - comportamento se il cameriere nell'altra sala non c'e' o e' in pausa.

Comportamento verificato:

- il warning/ciclo di conferma cambio sala esiste lato backend come risposta `pending` da `/api/integration/layout/table/room-move/request`;
- se nella sala destinazione c'e' un altro cameriere mobile disponibile, lo spostamento resta `pending` e viene inviata notifica `table_room_move_request`;
- se non ci sono altri camerieri disponibili nella sala destinazione, lo spostamento viene approvato direttamente con `status=approved` e `direct=true`;
- le comande modificate risultano gia' coperte dalla suite continuity per:
  - modifica in attesa/preparazione/pronta;
  - varianti/supplementi;
  - alias ordine numerico;
  - ordine pagato che rifiuta correzione;
  - stampa modifica e preconto aggiornato.

Bug confermato:

- la definizione di "cameriere attivo in sala" non filtrava i camerieri in pausa;
- di conseguenza una sala con solo cameriere in pausa poteva bloccare il cambio sala in `pending`, anche se quel cameriere non era disponibile per gestire la richiesta.

Modifiche applicate:

- `hasActiveWaiterInRoom()` ora usa `collectActiveWaitersInRoom(..., availableForNotifications: true)`;
- `handleIntegrationLayoutTableRoomMoveRequest()` considera "altro cameriere in sala" solo se disponibile per notifiche, quindi non in pausa/grace;
- aggiunti test e2e:
  - sala destinazione con cameriere disponibile => `pending`;
  - sala destinazione senza camerieri attivi => `approved direct`;
  - sala destinazione con cameriere in pausa => `approved direct`.

File modificati:

- `cassa-frontend/backend/server.js`;
- `cassa-frontend/backend/tests/waiters-routing.e2e.test.mjs`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `node --test backend/tests/waiters-routing.e2e.test.mjs`: OK, 6/6;
- `node --test backend/tests/waiter-pauses.test.mjs`: OK, 1/1;
- `node --test backend/tests/notifications-persistence.e2e.test.mjs backend/tests/notifications-priority.e2e.test.mjs backend/tests/notification-records.test.mjs`: OK, 10/10;
- `node --test backend/tests/orders-flow.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 20/20;
- `node --test backend/tests/tables-locks.e2e.test.mjs backend/tests/settings-room-table-policy.e2e.test.mjs`: OK, 8/8;
- `npm run check:backend`: OK.

Nota operativa:

- non e' stato riavviato alcun servizio in questo ciclo;
- la modifica sara' attiva dopo riavvio/reload backend.

## Ciclo 2026-06-06 - Verifiche comande modificate, cambio sala, unione/distacco tavoli

Richiesta:

- verificare le sequenze su:
  - comande modificate;
  - aggiornamenti dopo cambio sala;
  - unione tavoli;
  - distacco tavoli.

Comportamento verificato:

- una comanda spostata da una sala a un'altra resta agganciata al nuovo `tableId` e alla nuova `roomId`;
- la modifica della comanda dopo spostamento mantiene `orderId`, aggiorna revisione, totale e residuo della comanda;
- con `deliveryConfirmationEnabled=false`, una comanda ancora `waiting` non viene considerata pagabile nel `totalDue` del tavolo: entra nel dovuto solo quando passa a `ready`/stato pagabile;
- dopo passaggio a `ready`, il tavolo destinazione mostra il `totalDue` aggiornato e il tavolo sorgente resta a zero;
- l'unione tavoli con comande attive ristampa:
  - aggiornamento tavolo;
  - comanda;
  - preconto;
  usando la label logica unita, ad esempio `5/6`;
- il distacco tavoli ristampa:
  - aggiornamento tavolo;
  - comanda;
  - preconto;
  tornando alla label del tavolo singolo, ad esempio `5`.

Bug/gap confermato:

- il salvataggio gruppi tavolo produceva ristampe automatiche solo per `operation=merge`;
- il distacco (`operation=split`) non generava la routine completa di aggiornamento/stampa;
- il filtro usato per scegliere le comande da ristampare nel cambio gruppo era troppo stretto per scenari di sessione tavolo riallineata;
- mancava un test mirato che provasse insieme cambio sala -> modifica comanda -> aggiornamento dovuto al momento in cui la comanda diventa pagabile.

Modifiche applicate:

- `appendTableGroupMergePrintJobsToDb()` ora gestisce sia `merge` sia `split`;
- per `split` viene generato il titolo `DISTACCO TAVOLI`, per `merge` resta `UNIONE TAVOLI`;
- la ristampa automatica di unione/distacco usa la label logica corrente (`5/6` dopo unione, `5` dopo distacco);
- la risposta di `/api/integration/table-groups/save` resta retrocompatibile: un record per comanda con dentro gli ID dei tre job (`updatePrintJobId`, `orderPrintJobId`, `precontoPrintJobId`);
- aggiunto il test mirato `backend/tests/table-structure-updates.e2e.test.mjs`;
- aggiornato il test continuity esistente per passare esplicitamente `operation=merge/split`.

File modificati:

- `cassa-frontend/backend/server.js`;
- `cassa-frontend/backend/tests/continuity.e2e.test.mjs`;
- `cassa-frontend/backend/tests/table-structure-updates.e2e.test.mjs`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `node --test backend/tests/table-structure-updates.e2e.test.mjs`: OK, 2/2;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/table-groups-domain.test.mjs`: OK, 4/4;
- `node --test backend/tests/orders-payments-invariants.test.mjs`: OK, 15/15;
- `node --test backend/tests/tables-locks.e2e.test.mjs`: OK, 4/4;
- `node --test backend/tests/waiters-routing.e2e.test.mjs`: OK, 6/6;
- `node --test backend/tests/waiter-pauses.test.mjs`: OK, 1/1.

Test non eseguiti / note:

- la suite continuity completa non e' stata usata come gate finale in questo micro-ciclo perche' nel giro precedente risultavano ancora test storici non allineati alla regola attuale `1 postazione = 1 utente`; i flussi richiesti sono stati coperti dal nuovo test mirato e dai test invarianti/lock/gruppi;
- non e' stato riavviato alcun servizio in questo ciclo.

Rischi residui:

- se un client invia il salvataggio gruppi senza `operation`, il backend mantiene il comportamento retrocompatibile e non forza ristampe automatiche;
- per rendere obbligatoria la ristampa su ogni modifica gruppo anche senza `operation` serve una decisione funzionale separata, per non stampare in caso di semplici refresh/cache save.

## Ciclo 2026-06-06 - Pagamento deterministico tavoli uniti e reset operativo

Richiesta:

- procedere con il rinforzo del pagamento su tavoli uniti;
- riavviare i servizi;
- rimuovere tavoli attivi;
- resettare fondo cassa utenti, ordini in corso, pagamenti, transazioni e dati operativi collegati.

Modifiche applicate:

- il pagamento tavolo ora risolve lo scope reale del gruppo con `resolveIntegrationLinkedTableIds()`;
- `handlePayTable()` sincronizza e calcola il conto usando tutti i tavoli collegati dal gruppo, non solo il `tableId` premuto;
- il conto unico di un tavolo unito include tutte le comande pagabili ancora con residuo;
- le comande gia' pagate restano escluse dal residuo e non vengono ripagate;
- `resolveIntegrationPaymentOrderCandidates()` e `summarizeIntegrationPaymentReadiness()` considerano anche i tavoli collegati, mantenendo il filtro di sessione corrente;
- aggiunti helper per combinare live stats di piu' tavoli collegati senza duplicare pending bills e storico ordini;
- aggiunti test e2e su:
  - pagamento conto unico su due tavoli uniti con due comande aperte;
  - pagamento conto unico su due tavoli uniti dove una comanda era gia' stata saldata prima dell'unione.

File modificati:

- `cassa-frontend/backend/server.js`;
- `cassa-frontend/backend/tests/table-structure-updates.e2e.test.mjs`;
- `cassa-frontend/backend/tests/continuity.e2e.test.mjs`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `node --test backend/tests/table-structure-updates.e2e.test.mjs`: OK, 4/4;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/orders-payments-invariants.test.mjs`: OK, 15/15;
- `node --test backend/tests/table-groups-domain.test.mjs`: OK, 4/4;
- `node --test backend/tests/tables-locks.e2e.test.mjs`: OK, 4/4;
- `npm run check:backend`: OK.

Reset operativo eseguito:

- backup creato prima del reset:
  - `/srv/applicazione/current/cassa-frontend/backend/backups/app-state-before-user-operational-reset-2026-06-06T02-20-05-152Z.json`;
- dati presenti prima del reset:
  - tavoli attivi: 3;
  - ordini: 11;
  - pagamenti: 12;
  - payment containers: 12;
  - payment parts: 12;
  - payment transactions: 12;
  - fiscal receipts: 12;
  - fiscal events: 44;
  - print spool jobs: 55;
  - fondi cassa/sessioni vendita: 0;
- azzerati:
  - tavoli attivi e pending bills;
  - ordini/comande;
  - gruppi tavolo;
  - notifiche operative;
  - pagamenti, parti, transazioni, denominazioni contanti;
  - provider transactions;
  - fiscal receipts/events;
  - smart non fiscal;
  - print spool;
  - locks tavoli;
  - richieste cambio sala/tavolo;
  - fondi cassa/sessioni vendita.

Servizi riavviati:

- backend:
  - PID nuovo `2183812`;
  - health `http://127.0.0.1:5181/api/health`: OK;
- frontend statico:
  - PID nuovo `2183813`;
  - `http://127.0.0.1:5180/mobile/`: 200;
  - `http://127.0.0.1:5180/postazione/`: 200;
  - `http://127.0.0.1:5180/monitor/`: 200;
  - `http://127.0.0.1:5180/impostazioni/`: 200;
- battery dashboard lasciato attivo:
  - PID `786749`.

Verifica post-reset:

- tavoli attivi: 0;
- ordini: 0;
- gruppi tavolo: 0;
- notifiche: 0;
- pagamenti: 0;
- payment containers/parts/transactions: 0;
- cash tx denoms: 0;
- provider transactions: 0;
- fiscal receipts/events: 0;
- print spool jobs: 0;
- fondi cassa/sessioni vendita: 0;
- table locks: 0.

Rischi residui:

- il pagamento conto unico del gruppo e' ora deterministico lato backend, ma eventuali UI che mostrano contemporaneamente tavolo principale e tavoli figli devono continuare a usare la label logica del gruppo per evitare percezione di duplicazione visiva;
- la suite continuity completa resta da riallineare in un ciclo separato per le vecchie aspettative sulle postazioni, ma i test mirati su tavoli uniti/pagamenti e le invarianti pagamento sono verdi.

## Ciclo V3 - audit markdown scaricato e correzioni stampa/spool/fiscale

Data ciclo: 2026-06-06.

Ambiente di lavoro:

- V3 attiva separata da V2:
  - frontend V3: `http://127.0.0.1:5280`;
  - backend V3: `http://127.0.0.1:5281`;
  - DB V3: `/srv/applicazione/v3/cassa-frontend/backend/app-state.json`;
  - backend PID dopo riavvio: `3501006`.
- V2 operativa non modificata:
  - frontend V2: `http://127.0.0.1:5180`;
  - backend V2: `http://127.0.0.1:5181`.
- Markdown audit sorgente:
  - `/home/amalia/Downloads/codex_audit_problemi_frontend_backend(1).md`.

Correzioni applicate in questo ciclo:

- isolamento V3 gia' verificato:
  - V3 accetta CORS da `5280`;
  - V3 rifiuta CORS da `5180`;
  - V2 e V3 espongono `settingsVersion` differenti.
- preconti fail-closed:
  - il contesto operativo non eredita piu' stampanti generiche come preconto;
  - un preconto richiede `precontoPrinterIds` esplicito su sala o attivita';
  - se manca una stampante preconto dedicata, il backend deve mostrare errore chiaro invece di ripiegare su stampanti di produzione o di altra attivita'.
- configurazione V3 riallineata:
  - attivita' `activity_bar` preconto su `printer_bar_1921681195_9100`;
  - sale Bar/Attesa virtuale/Gazebo/Pedana/Spiaggia/Terrazza preconto su `printer_bar_1921681195_9100`;
  - attivita' e sala `Pizza in Riva` preconto su `printer_pizza_in_riva_192168136_9100`;
  - postazione `workstation_pizza_in_riva` preconto su `printer_pizza_in_riva_192168136_9100`;
  - `meta.settingsLastWriteAt` aggiornato per forzare refresh configurazione frontend.
- spool stampa:
  - nuovi stati espliciti: `failed_configuration`, `unknown_after_crash`;
  - i job senza stampante/host valido non entrano piu' in coda reale quando la stampa e' attiva;
  - i job rimasti `processing` al riavvio non vengono ristampati automaticamente, ma marcati `unknown_after_crash` per revisione manuale;
  - la potatura dello spool conserva job attivi/incerti e rimuove solo terminali;
  - `fileName` default dello spool basato su id job per evitare collisioni.
- monitor:
  - metriche spool allineate agli stati reali: `queued`, `processing`, `failed_configuration`, `unknown_after_crash`, `printed`, `disabled`;
  - `pending` ora equivale a `queued + processing`, non a uno stato inesistente.
- ristampa fiscale:
  - `normalizeFiscalDocumentNumber()` conserva gli zeri iniziali del numero documento.
- mirror preconti Francesca:
  - corretto riferimento a `STARTED_AT_MS`;
  - supporto robusto a DB JSON V3;
  - deduplica basata sul job di stampa sorgente, non solo su `orderId`.

File modificati:

- `cassa-frontend/backend/server.js`;
- `cassa-frontend/backend/modules/configuration/operational-context.js`;
- `cassa-frontend/backend/modules/status/status.handlers.js`;
- `cassa-frontend/backend/tests/operational-context-alias.test.mjs`;
- `cassa-frontend/backend/app-state.json`;
- `tools/francesca-preconto-mirror.mjs`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test e verifiche eseguite:

- `node --check cassa-frontend/backend/server.js`: OK;
- `node --check cassa-frontend/backend/modules/status/status.handlers.js`: OK;
- `node --check cassa-frontend/backend/modules/configuration/operational-context.js`: OK;
- `node --check tools/francesca-preconto-mirror.mjs`: OK;
- `npm run check:backend`: OK;
- `node --test backend/tests/operational-context-alias.test.mjs backend/tests/printer-config-domain.test.mjs backend/tests/print-utils-core.test.mjs backend/tests/configuration-snapshot.test.mjs backend/tests/fiscal-receipts-domain.test.mjs backend/tests/pos-fiscal-retry.e2e.test.mjs`: OK, 26/26;
- `node --test frontend-tests/monitor-configuration-static.test.mjs`: OK, 2/2;
- health V3 `http://127.0.0.1:5281/api/health`: OK, `settingsVersion=1780752846130`;
- health V3 via frontend `http://127.0.0.1:5280/api/health`: OK;
- health V2 `http://127.0.0.1:5180/api/health`: OK e versione differente;
- CORS V3 da origine V2 `5180`: 403 atteso;
- CORS V3 da origine V3 `5280`: 200 atteso;
- risoluzione operativa reale:
  - Bar/Gazebo + BAR-1 -> preconto `printer_bar_1921681195_9100`, RT `rt_bar_api`;
  - Bar/Pedana + BAR-2 -> preconto `printer_bar_1921681195_9100`, RT `rt_bar_api`;
  - Pizza in Riva -> preconto `printer_pizza_in_riva_192168136_9100`, nessun RT.

Rischi residui dal markdown audit ancora da affrontare nei prossimi cicli:

- validazione fiscale fail-closed per metodi pagamento non riconosciuti;
- revisione completa degli endpoint che accettano `printerId` esplicito per evitare bypass di contesto operativo;
- test e2e GUI su stampa/preconto con V3 e stampante fisica solo quando richiesto;
- riallineamento completo dei vecchi snapshot annidati se risultano usati da tool legacy;
- ulteriore auditing dei flussi POS/fiscale/retry non coperti dal blocco mirato di questo ciclo.

## Ciclo V3 - audit markdown, tranche RT/fiscalita POS

Data ciclo: 2026-06-06.

Obiettivo:

- proseguire dal markdown `/home/amalia/Downloads/codex_audit_problemi_frontend_backend(1).md`;
- chiudere una tranche RT/fiscalita POS senza modificare V2;
- rendere fail-closed le configurazioni incomplete e preservare snapshot/idempotenza fiscale.

Correzioni applicate:

- RT/fiscal device fail-closed:
  - `sanitizePosFiscalDevice()` non abilita piu' `pay_cash/pay_card` di default se i metodi non sono dichiarati;
  - `supportsCash`, `supportsElectronic`, `supportsReprint` ora sono true solo se configurati esplicitamente true;
  - lo snapshot configurazione espone le stesse capability, evitando che UI/monitor mostrino capability inventate.
- Palmari e fiscalita:
  - un palmare con `deviceUuid` non censito non e' piu' fiscalmente abilitato di default;
  - metodo fiscale sconosciuto ritorna false, non true;
  - la migration di startup preserva `posSettings.mobileDevices` invece di cancellarla quando normalizza `posSettings`;
  - V3 reale aggiornata con i device UUID gia' presenti nelle sessioni:
    - `dev_1780309110686_ojgwswx72sg`;
    - `dev_1778865853378_2cjmc5cgyke`;
    - `u_1778319633697_252626525`;
  - tutti e tre sono configurati in V3 con `fiscalEnabled`, `electronicPaymentEnabled`, `cashPaymentEnabled` espliciti true.
- Metodo fiscale:
  - `normalizePosFiscalApiPaymentMethod()` non normalizza piu' metodi sconosciuti a `pos`;
  - se arriva un metodo esplicito non riconosciuto, viene sollevato `FISCAL_PAYMENT_METHOD_UNKNOWN`.
- RT ambigua:
  - `selectConfiguredPosFiscalApiDevice()` ora produce `FISCAL_DEVICE_AMBIGUOUS` se piu' RT matchano lo stesso metodo/capability, invece di tornare null e saltare fiscalita.
- Config RT per job:
  - `normalizePosFiscalDeviceJobConfig()` non usa piu' `POS_FISCAL_API_BASE_URL` globale per completare device configurati senza `apiBaseUrl`;
  - recovery/ristampa devono usare device salvato o device configurato esplicitamente.
- Receipt fiscale:
  - `sanitizeFiscalReceipt()` non trasforma piu' record vuoti in `ISSUED/RT_OK`;
  - record incompleti diventano `UNKNOWN`;
  - nuovi campi persistiti: `fiscalRequestId`, `idempotencyKey`, `payloadSnapshot`, `payloadHash`, `attemptCount`, `lastAttemptAt`, `nextRetryAt`, `retryCutoffAt`.
- Payload/idempotenza:
  - i nuovi record POS fiscal salvano snapshot payload e hash;
  - recovery preferisce `receipt.payloadSnapshot` rispetto a ricostruzione da stato corrente;
  - chiamate a fiscal API inviano `Idempotency-Key` e `X-Fiscal-Device-Id` quando disponibili;
  - anche la ristampa RT usa header idempotenza/device id.
- Fallimenti fiscali recuperabili/configurazione:
  - `items_empty` crea una receipt `FAILED` retryable invece di solo evento;
  - RT mancante crea una receipt `FAILED_CONFIGURATION` non retryable;
  - status error/not-ready salvano `nextRetryAt`;
  - il container pagamento conserva `fiscalDocType=RECEIPT` e riferimento receipt anche quando l'emissione e' pending/retry; lo stato reale resta sulla receipt.
- Fixture/test:
  - fixture backend aggiornata con RT test esplicita e palmari test espliciti;
  - test retry POS aggiornati per usare RT configurata verso fake server, non fallback globale.

File modificati:

- `cassa-frontend/backend/server.js`;
- `cassa-frontend/backend/printing/printer-config.domain.js`;
- `cassa-frontend/backend/modules/configuration/configuration-snapshot.js`;
- `cassa-frontend/backend/modules/payments/fiscal-receipts.domain.js`;
- `cassa-frontend/backend/modules/app-state/security-migration.js`;
- `cassa-frontend/backend/tests/printer-config-domain.test.mjs`;
- `cassa-frontend/backend/tests/fiscal-receipts-domain.test.mjs`;
- `cassa-frontend/backend/tests/helpers/test-server.mjs`;
- `cassa-frontend/backend/tests/pos-fiscal-retry.e2e.test.mjs`;
- `cassa-frontend/backend/app-state.json`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `node --check backend/printing/printer-config.domain.js`: OK;
- `node --check backend/modules/configuration/configuration-snapshot.js`: OK;
- `node --check backend/modules/payments/fiscal-receipts.domain.js`: OK;
- `node --check backend/modules/app-state/security-migration.js backend/tests/helpers/test-server.mjs backend/tests/pos-fiscal-retry.e2e.test.mjs`: OK;
- `npm run check:backend`: OK;
- `node --test backend/tests/mobile-device-config-domain.test.mjs backend/tests/printer-config-domain.test.mjs backend/tests/fiscal-receipts-domain.test.mjs backend/tests/pos-fiscal-retry.e2e.test.mjs backend/tests/payments-fiscal.e2e.test.mjs`: OK, 23/23.

Servizi:

- riavviato solo backend V3:
  - PID `89564`;
  - `http://127.0.0.1:5281/api/health`: OK;
  - `settingsVersion=1780757796128`.
- isolamento confermato:
  - `http://127.0.0.1:5280/api/health`: OK V3;
  - `http://127.0.0.1:5180/api/health`: OK V2, versione differente;
  - CORS V3 da origine `5180`: 403 atteso;
  - CORS V3 da origine `5280`: 200 atteso.

Finding markdown chiusi o mitigati in questa tranche:

- B-RT-02: mitigato, palmari con UUID non censiti non sono fiscalmente abilitati;
- B-RT-14: mitigato, metodo sconosciuto non diventa POS;
- B-RT-16: mitigato, niente fallback globale per device configurati senza URL;
- B-RT-17: gia' chiuso nella tranche precedente, zeri iniziali conservati;
- B-RT-20: mitigato, nuove receipt salvano snapshot/idempotenza/hash;
- B-RT-23: mitigato, receipt vuote diventano `UNKNOWN`;
- B-RT-24: mitigato, RT parziali non abilitano cash/card/reprint;
- B-RT-03: mitigato per `items_empty` e RT mancante con receipt persistita.

Rischi residui della sezione RT:

- B-RT-01 richiede ulteriori test e gestione UI per configurazione RT ambigua, anche se il backend ora solleva errore;
- B-RT-04/B-RT-13 richiedono status lookup/idempotenza supportata lato servizio fiscale reale, oltre agli header inviati;
- B-RT-09 richiede una outbox persistente per ristampe RT, non solo job in memoria;
- B-RT-12/B-RT-26 richiedono decisione business su blocco/liberazione tavolo con fiscalita pending;
- B-RT-21 richiede policy più stretta sui riferimenti minimi necessari per marcare `ISSUED`;
- B-RT-25 richiede separazione permessi ristampa fiscale/non fiscale.

## Ciclo V3 - audit markdown, tranche POS provider e consistenza incassi

Data ciclo: 2026-06-06.

Obiettivo:

- proseguire dai finding `B-POS-01`, `B-POS-02`, `B-POS-03` del markdown scaricato;
- evitare stati parziali nel pagamento free-split POS;
- rendere riconciliabile il caso in cui il POS autorizza ma il backend non riesce a persistere il risultato locale;
- non modificare V2 e non cambiare contratto degli endpoint.

Correzioni applicate:

- Audit provider POS:
  - aggiunto helper `appendPaymentProviderAuditEvent()`;
  - i flussi POS ora registrano eventi:
    - `payment.provider_settlement_pending`;
    - `payment.provider_authorized`;
    - `payment.provider_settled`;
    - `payment.provider_failed`;
    - `payment.provider_manual_reconciliation_required`.
- Persistenza provider:
  - `persistPaymentProviderTransaction()` accetta metadati audit opzionali e li persiste insieme allo stato provider;
  - aggiunto `persistPaymentProviderFailure()` per distinguere errore certo da errore incerto.
- Caso POS autorizzato ma persist locale fallito:
  - se esiste gia' una `cardAuthorization`, lo stato provider diventa `manual_reconciliation_required`;
  - non viene piu' marcato come `failed` un incasso che potrebbe essere gia' avvenuto sul terminale/provider;
  - viene salvata la risposta di autorizzazione disponibile in `settlementResponse.authorization`.
- Free-split:
  - rimosso il `writeDb()` intermedio dopo push di `paymentContainer`, parti, transazioni e provider link;
  - lo stato provider `settled`, i record pagamento, audit, fiscalita, sync ordini e sync tavoli vengono salvati nel persist finale della mutation;
  - resta invariato il pre-commit durabile prima della chiamata esterna POS.
- Test:
  - esteso `payment-weird-cases.e2e.test.mjs` per verificare che un POS manuale free-split lasci:
    - provider transaction `settled`;
    - ordine `paid`;
    - `dueAmount=0`;
    - audit provider in ordine deterministico;
  - fixture `payment-weird-cases` allineata alla nuova regola fail-closed:
    - RT con `apiBaseUrl` esplicito;
    - palmare `giada-weird-mobile` censito e abilitato a fiscalita cash/elettronico.

File modificati:

- `cassa-frontend/backend/server.js`;
- `cassa-frontend/backend/tests/payment-weird-cases.e2e.test.mjs`;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `node --test backend/tests/payment-provider-transactions.test.mjs`: OK, 6/6;
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs`: OK, 15/15;
- `node --test backend/tests/payments-fiscal.e2e.test.mjs backend/tests/pos-fiscal-retry.e2e.test.mjs`: OK, 9/9;
- `node --test backend/tests/mobile-device-config-domain.test.mjs backend/tests/printer-config-domain.test.mjs backend/tests/fiscal-receipts-domain.test.mjs`: OK, 14/14;
- `npm run check:backend`: OK.
- regressione mirata:
  - `node --test backend/tests/orders-payments-invariants.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/payment-provider-transactions.test.mjs backend/tests/payment-weird-cases.e2e.test.mjs`: OK, 41/41;
  - `node --test backend/tests/payments-fiscal.e2e.test.mjs backend/tests/pos-fiscal-retry.e2e.test.mjs backend/tests/sales-sessions.e2e.test.mjs backend/tests/tables-locks.e2e.test.mjs`: OK, 16/16.

Servizi dopo il ciclo:

- riavviato solo backend V3:
  - PID `170978`;
  - `http://127.0.0.1:5281/api/health`: OK;
  - `settingsVersion=1780757796128`;
  - stampa reale ancora disabilitata (`PRINTING_ENABLED` non impostato).
- frontend/proxy V3:
  - PID `3445139`;
  - `http://127.0.0.1:5280/api/health`: OK.
- isolamento confermato:
  - `http://127.0.0.1:5180/api/health`: OK V2 con `settingsVersion=1780698163617`;
  - CORS V3 da origine `http://127.0.0.1:5180`: 403 atteso;
  - CORS V3 da origine `http://127.0.0.1:5280`: 200 atteso.

Finding markdown chiusi o mitigati in questa tranche:

- B-POS-02: mitigato, rimosso il write intermedio che poteva persistere un pagamento free-split senza sync coerente di ordini/tavoli;
- B-POS-03: mitigato, il caso autorizzazione POS acquisita ma persist locale incerto passa a `manual_reconciliation_required`;
- B-POS-01: mitigato parzialmente con audit provider obbligatorio sui flussi POS toccati, ma resta da introdurre una policy esplicita di abilitazione/permesso per POS manuale esterno.

Rischi residui della sezione POS provider:

- modalita POS manuale/esterna ancora accettata se il client passa provider/ref secondo comportamento legacy; serve decisione business prima di renderla disabilitabile o soggetta a permesso dedicato;
- manca status lookup reale verso provider POS esterno in caso di `manual_reconciliation_required`;
- non esiste ancora una outbox transazionale dedicata ai provider POS, si usa il JSON DB con pre-commit e persist finale;
- serve test mirato con simulazione failure del secondo persist dopo autorizzazione, preferibilmente con harness controllato del repository/writeDb.

## Ciclo V3 - audit markdown, tranche mobile M-ARCH-02 invio comanda transazionale

Data ciclo: 2026-06-06.

Obiettivo:

- proseguire dal blocco mobile del markdown scaricato;
- chiudere `M-ARCH-02`, cioe' evitare che la UI mobile cancelli la bozza comanda o chiuda la modale prima del successo backend;
- non modificare V2;
- aggiornare il `dist` V3 per rendere effettivo il fix sul frontend servito.

Problema verificato:

- `TableOrderComposer` chiamava `onSubmit()` e subito dopo svuotava draft/note/commenti;
- `TableDetailPanel` chiudeva il composer subito dopo aver chiamato `onSubmitOrder(payload)`, senza `await`;
- `TablesWorkspace.runOnSelected()` usava `withAction()` senza `rethrow`, quindi un errore backend poteva risultare come Promise risolta al composer.

Correzioni applicate:

- `TableOrderComposer`:
  - contratto `onSubmit` reso `Promise<void>`;
  - `submitOrder` reso async;
  - aggiunto stato locale `submitting`;
  - bozza, note e commenti vengono svuotati solo dopo `await onSubmit(...)` completato con successo;
  - in caso di errore il draft resta intatto per il retry operatore;
  - durante invio chiusura e controlli principali restano disabilitati;
  - pulsante mostra `Invio...` durante il submit.
- `TableDetailPanel`:
  - `onSubmitOrder` tipizzato come `Promise<void>`;
  - la modale composer viene chiusa solo dopo `await onSubmitOrder(payload)`.
- `TablesWorkspace`:
  - `runOnSelected()` ora supporta `rethrow`;
  - il submit ordine usa `{ lockPurpose: ORDER_CREATE_LOCK_PURPOSE, rethrow: true }`;
  - se manca tavolo selezionato nel submit, la Promise fallisce invece di risolversi silenziosamente.
- Test statico:
  - aggiunto controllo `FE FRONTENDV2 P0` per garantire che `await onSubmit` preceda `setDraft([])` e che il submit ordine usi `rethrow: true`.

File modificati:

- `mobile-frontend/src/pages/home/tables/components/TableOrderComposer.tsx`;
- `mobile-frontend/src/pages/home/tables/components/TableDetailPanel.tsx`;
- `mobile-frontend/src/pages/home/tables/TablesWorkspace.tsx`;
- `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs`;
- `mobile-frontend/dist/**` rigenerato da build;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `npm run typecheck` in `mobile-frontend`: OK;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 9/9;
- `npm run build` in `mobile-frontend`: OK;
- `npm run check:backend` in `cassa-frontend`: OK.

Test eseguiti con failure non chiusa in questa tranche:

- `npm run test -- --run` in `mobile-frontend`: FAIL su 2 test statici preesistenti/baseline:
  - `tests/static/architectureRules.test.ts`: budget LOC gia' superato da 8 file monolitici (`tables.ts`, `TablePaymentWizard`, `TableOrderComposer`, `ReservationsWorkspace`, `TableDetailPanel`, `TablesWorkspace`, `PaymentSettlementSection`, `useNotificationCenter`);
  - `tests/static/tableHistorySync.test.ts`: aspettativa statica `{hasAnyOrder && (` non allineata al sorgente corrente di `TableDetailPanel`.

Finding markdown chiusi o mitigati:

- M-ARCH-02: mitigato, invio comanda mobile ora conserva la bozza e chiude solo dopo successo backend.

Rischi residui mobile:

- M-ARCH-01 resta aperto: i workflow sono ancora distribuiti su `useState/useEffect` e componenti monolitici;
- M-ARCH-03 resta aperto: lock tavolo fail-open e gestione heartbeat/lost lock da verificare e correggere nel prossimo ciclo;
- test statico LOC conferma che il monolite mobile deve essere ridotto in cicli successivi;
- serve test GUI reale/simulato per confermare visivamente spinner, errore e retry draft su mobile.

## Ciclo V3 - audit markdown, tranche mobile M-ARCH-03 lock tavolo fail-closed

Data ciclo: 2026-06-06.

Obiettivo:

- proseguire dal markdown scaricato sul blocco mobile;
- mitigare `M-ARCH-03`: evitare che operazioni sensibili partano senza lock tavolo valido;
- gestire perdita heartbeat del lock mentre una modale transazionale e' aperta;
- mantenere compatibilita' per eventuali usi opzionali/non transazionali del lock.

Problema verificato:

- `withTableLocks()` eseguiva l'operazione anche con:
  - lista tavoli vuota;
  - sessione lock incompleta/non valida;
- heartbeat periodico chiamava `heartbeatTableLock()` ignorando errori e perdita lock;
- correzione/resi/cancellazione comanda e mutation tavoli usavano lo stesso wrapper fail-open.

Correzioni applicate:

- `mobile-frontend/src/api/tableLocks.ts`:
  - introdotto `withOptionalTableLocks()` per mantenere il comportamento compatibile legacy;
  - introdotto `withRequiredTableLocks()` per le mutation sensibili;
  - `withTableLocks` resta alias di `withOptionalTableLocks` per non rompere import legacy;
  - se `withRequiredTableLocks()` riceve sessione non valida solleva `TableLockError` 428 con codice `TABLE_LOCK_SESSION_REQUIRED`;
  - se manca il tavolo solleva `TableLockError` 428 con codice `TABLE_LOCK_TABLE_REQUIRED`;
  - heartbeat ora accetta `onLost` e segnala perdita lock invece di ignorarla.
- `useTableLock`:
  - aggiunto stato `lost`;
  - heartbeat fallito rilascia/sgancia il lock locale, dispatcha evento conflitto e chiama gli handler esistenti;
  - per composer/pagamenti questo chiude il flow tramite handler gia' presenti (`handleOrderComposerLockConflict`, `handlePaymentLockConflict`).
- `TablesWorkspace`:
  - `runWithTableLocks` interno ora usa `withRequiredTableLocks`;
  - comande, pagamenti, spostamenti/liberazioni/sync operano fail-closed.
- `orderServiceRecovery`:
  - correzione, cancellazione, reso/storno usano `withRequiredTableLocks`.
- Test:
  - aggiunto `mobile-frontend/tests/tableLocks.test.ts` con copertura per:
    - wrapper opzionale compatibile;
    - wrapper obbligatorio fail-closed su sessione assente;
    - wrapper obbligatorio fail-closed su tavolo assente;
    - acquisizione/rilascio intorno alla mutation;
    - heartbeat fallito che segnala `onLost`.

File modificati:

- `mobile-frontend/src/api/tableLocks.ts`;
- `mobile-frontend/src/pages/home/tables/hooks/useTableLock.ts`;
- `mobile-frontend/src/pages/home/tables/TablesWorkspace.tsx`;
- `mobile-frontend/src/api/orderServiceRecovery.ts`;
- `mobile-frontend/tests/tableLocks.test.ts`;
- `mobile-frontend/dist/**` rigenerato da build;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `npm run typecheck` in `mobile-frontend`: OK;
- `npm run test -- tests/tableLocks.test.ts tests/orderServiceRecovery.test.ts --run`: OK, 8/8;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 9/9;
- `npm run build` in `mobile-frontend`: OK;
- `npm run check:backend` in `cassa-frontend`: OK;
- health V3:
  - `http://127.0.0.1:5280/api/health`: OK;
  - `http://127.0.0.1:5281/api/health`: OK.

Finding markdown chiusi o mitigati:

- M-ARCH-03: mitigato per le mutation sensibili; non partono piu' senza table id/sessione lock valida e la perdita heartbeat viene segnalata.

Rischi residui:

- servono test GUI reali/simulati per confermare che la chiusura automatica del composer/payment in caso di heartbeat lost sia visivamente chiara all'operatore;
- la perdita heartbeat durante una mutation brevissima non puo' interrompere fisicamente una Promise gia' in esecuzione, ma impedisce ulteriori conferme e segnala il problema;
- alcuni usi legacy di `withTableLocks` restano opzionali per compatibilita', da inventariare in futuri cicli;
- M-ARCH-04 resta il prossimo blocco naturale: gestione 401 centralizzata/coerente.

## Ciclo V3 - audit markdown, tranche mobile M-ARCH-04 gestione 401 centralizzata

Data ciclo: 2026-06-06.

Obiettivo:

- proseguire dal markdown scaricato sul blocco mobile;
- mitigare `M-ARCH-04`: rendere coerente la gestione `401 Unauthorized` nel client API mobile;
- evitare sessioni mobile apparentemente attive dopo che un endpoint protetto ha gia' segnalato token/sessione non valida;
- non generare logout rumorosi da endpoint pubblici o ausiliari.

Problema verificato:

- `mobile-frontend/src/shared/api/apiClient.ts` dichiarava un handler centralizzato per i `401`;
- in pratica `notifyUnauthorized()` veniva invocato solo per `/api/auth/session/status`;
- un qualunque altro endpoint protetto poteva tornare `401` senza forzare logout immediato, lasciando la UI in uno stato potenzialmente incoerente fino al polling successivo.

Correzioni applicate:

- `apiClient.ts`:
  - introdotto set esplicito `PUBLIC_UNAUTHORIZED_ENDPOINTS`;
  - il logout centralizzato scatta ora per i `401` su endpoint `/api/*` protetti;
  - restano esclusi endpoint pubblici/ausiliari:
    - `/api/auth/login`;
    - `/api/health`;
    - `/api/ip-coords`;
  - la risoluzione del pathname gestisce sia URL assoluti sia path relativi o malformati.
- `apiClient.test.ts`:
  - aggiornato test session-status;
  - aggiunto/rafforzato test su endpoint protetto generico (`/api/tables`);
  - confermata esclusione degli endpoint pubblici/ausiliari;
  - confermato che errori nell'handler non rompono il flusso della richiesta.

File modificati:

- `mobile-frontend/src/shared/api/apiClient.ts`;
- `mobile-frontend/tests/apiClient.test.ts`;
- `mobile-frontend/dist/**` rigenerato da build;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `npm run test -- tests/apiClient.test.ts --run` in `mobile-frontend`: OK, 16/16;
- `npm run typecheck` in `mobile-frontend`: OK;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs` in `cassa-frontend`: OK, 9/9;
- `npm run build` in `mobile-frontend`: OK;
- `npm run check:backend` in `cassa-frontend`: OK;
- health V3:
  - `http://127.0.0.1:5280/api/health`: OK;
  - `http://127.0.0.1:5281/api/health`: OK.

Finding markdown chiusi o mitigati:

- M-ARCH-04: mitigato; i `401` da API protette ora fanno scattare in modo deterministico il logout centralizzato.

Rischi residui:

- se in futuro vengono aggiunti endpoint pubblici che possono rispondere `401` senza significare sessione scaduta, vanno inseriti esplicitamente in `PUBLIC_UNAUTHORIZED_ENDPOINTS`;
- serve test GUI reale/simulato per confermare che il logout centralizzato mostri il rientro al login senza flicker o modali sovrapposte;
- M-ARCH-01 resta aperto: i workflow mobile sono ancora distribuiti e vanno progressivamente ricondotti a reducer/state machine.

## Ciclo V3 - audit markdown, tranche mobile M-ARCH-05 restore UI transazionale

Data ciclo: 2026-06-06.

Obiettivo:

- proseguire dal markdown scaricato sul blocco mobile;
- mitigare `M-ARCH-05`: evitare che il restore UI tavoli riapra modali transazionali;
- conservare solo stato UI sicuro tra refresh/reload;
- impedire riaperture automatiche di composer/pagamento/spostamento prima di avere lock tavolo e snapshot aggiornato.

Problema verificato:

- `TablesWorkspace.tsx` persisteva e ripristinava direttamente:
  - `movePickerOpen`;
  - `orderComposerOpen`;
  - `paymentWizardOpen`;
- dopo reload o cambio sessione, queste modali potevano riaprire in automatico su uno stato non ancora riconciliato.

Correzioni applicate:

- `TablesWorkspaceUiSnapshot` ora contiene solo stato sicuro:
  - tavolo selezionato;
  - modalita occupa/prenota;
  - draft anagrafico/prenotazione;
  - filtri, ricerca e allergeni;
- il restore ignora eventuali vecchie chiavi persistite `movePickerOpen`, `orderComposerOpen`, `paymentWizardOpen`;
- il payload scritto in session storage non salva piu' gli stati delle modali transazionali;
- aggiunto test statico dedicato per impedire la regressione.

File modificati:

- `mobile-frontend/src/pages/home/tables/TablesWorkspace.tsx`;
- `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs`;
- `mobile-frontend/dist/**` rigenerato da build;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `npm run typecheck` in `mobile-frontend`: OK;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs` in `cassa-frontend`: OK, 10/10;
- `npm run build` in `mobile-frontend`: OK;
- `npm run check:backend` in `cassa-frontend`: OK;
- health V3:
  - `http://127.0.0.1:5280/api/health`: OK;
  - `http://127.0.0.1:5281/api/health`: OK.

Finding markdown chiusi o mitigati:

- M-ARCH-05: mitigato; il restore tavoli non riapre piu' modali transazionali.

Rischi residui:

- il draft sicuro resta ripristinabile; se in futuro si vuole riprendere una bozza ordine vera, serve una UX esplicita "bozza trovata, riprendi?" dopo lock acquisito;
- serve test GUI reale/simulato per verificare reload durante composer/pagamento e confermare che non appaiano modali inattese;
- M-ARCH-06 resta il prossimo blocco naturale: chiudere esplicitamente i flow figli quando si chiude il dettaglio tavolo.

## Ciclo V3 - audit markdown, tranche mobile M-ARCH-06 chiusura flow figli dettaglio tavolo

Data ciclo: 2026-06-06.

Obiettivo:

- proseguire dal markdown scaricato sul blocco mobile;
- mitigare `M-ARCH-06`: chiudere esplicitamente i flow figli quando si chiude il dettaglio tavolo;
- impedire che composer, pagamento, sposta/unisci o recovery restino appesi e riappaiano sul tavolo successivo.

Problema verificato:

- `TableDetailPanel.onClose` azzerava solo `selectedTableId` e `moveConfirm`;
- il cleanup quando `selectedTableId` diventava `null` chiudeva solo alcuni dialoghi secondari;
- `movePickerOpen`, `orderComposerOpen`, `paymentWizardOpen` potevano restare veri in memoria.

Correzioni applicate:

- introdotta funzione centralizzata `closeTableChildFlows()` in `TablesWorkspace.tsx`;
- introdotta funzione `closeTableDetail()` che:
  - azzera tavolo selezionato;
  - azzera snapshot tavolo selezionato;
  - chiude tutti i flow figli;
- `closeTableChildFlows()` chiude:
  - spostamento tavolo;
  - conferma spostamento;
  - conferma unione;
  - composer ordine;
  - wizard pagamento;
  - dialog gruppi tavoli;
  - dialog recovery/resi/modifiche;
- collegati a cleanup centralizzato:
  - chiusura manuale dettaglio tavolo;
  - selezione tavolo persa/mancante;
  - quick filter home;
  - cambio sala automatico/manuale;
  - clearSelection dopo operazioni;
  - liberazione prompt prenotazione;
  - cancellazione admin tavolo.

File modificati:

- `mobile-frontend/src/pages/home/tables/TablesWorkspace.tsx`;
- `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs`;
- `mobile-frontend/dist/**` rigenerato da build;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `npm run typecheck` in `mobile-frontend`: OK;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs` in `cassa-frontend`: OK, 11/11;
- `npm run build` in `mobile-frontend`: OK;
- `npm run check:backend` in `cassa-frontend`: OK;
- health V3:
  - `http://127.0.0.1:5280/api/health`: OK;
  - `http://127.0.0.1:5281/api/health`: OK.

Finding markdown chiusi o mitigati:

- M-ARCH-06: mitigato; chiudendo il dettaglio tavolo vengono chiusi anche i flow figli transazionali.

Rischi residui:

- serve test GUI reale/simulato per verificare visivamente la sequenza: apri tavolo 1, apri composer/pagamento/sposta, chiudi dettaglio, apri tavolo 2;
- `TablesWorkspace.tsx` resta grande e con molti workflow locali: M-ARCH-01 resta aperto e richiede estrazione progressiva;
- M-ARCH-07 resta il prossimo blocco naturale: dipendenze React troppo strette sul riallineamento dei dati dello stesso tavolo.

## Ciclo V3 - audit markdown, tranche mobile M-ARCH-07 riallineamento form tavolo

Data ciclo: 2026-06-06.

Obiettivo:

- proseguire dal markdown scaricato sul blocco mobile;
- mitigare `M-ARCH-07`: evitare che il form del dettaglio tavolo resti disallineato quando cambia lo stesso tavolo senza cambio id;
- aggiornare i campi locali solo quando cambiano i dati del tavolo effettivamente usati dal form.

Problema verificato:

- l'effetto di riallineamento form in `TablesWorkspace.tsx` dipendeva solo da `detailTable?.id`;
- cambiamenti backend sullo stesso tavolo potevano non aggiornare:
  - stato occupazione/prenotazione;
  - nome cliente;
  - telefono;
  - coperti;
  - note;
  - allergeni;
  - intolleranza manuale;
  - orario prenotazione.

Correzioni applicate:

- introdotta funzione pura `buildTableFormSyncKey(table)`;
- la chiave serializza solo i campi necessari al form locale:
  - `id`;
  - `occupancyState`;
  - `tableName`;
  - `customerPhone`;
  - `covers`;
  - `note`;
  - `allergens`;
  - `manualIntolerance`;
  - `reservationAt`;
- introdotto `detailTableFormSyncKey` via `useMemo`;
- l'effetto form ora dipende da `detailTableFormSyncKey` invece che dal solo `detailTable?.id`;
- aggiunto test statico per impedire il ritorno alla dipendenza solo-id.

File modificati:

- `mobile-frontend/src/pages/home/tables/TablesWorkspace.tsx`;
- `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs`;
- `mobile-frontend/dist/**` rigenerato da build;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `npm run typecheck` in `mobile-frontend`: OK;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs` in `cassa-frontend`: OK, 12/12;
- `npm run build` in `mobile-frontend`: OK;
- `npm run check:backend` in `cassa-frontend`: OK;
- health V3:
  - `http://127.0.0.1:5280/api/health`: OK;
  - `http://127.0.0.1:5281/api/health`: OK.

Finding markdown chiusi o mitigati:

- M-ARCH-07: mitigato; il form dettaglio tavolo si riallinea sui dati rilevanti dello stesso tavolo.

Rischi residui:

- serve test GUI reale/simulato per verificare refresh backend dello stesso tavolo mentre il dettaglio e' aperto;
- l'effetto resta locale a `TablesWorkspace.tsx`; M-ARCH-01 resta aperto e richiede una futura state machine/riduzione del monolite mobile;
- M-ARCH-08 resta il prossimo blocco naturale: rimuovere o confinare il fallback statico catalogo menu in produzione.

## Ciclo V3 - audit markdown, tranche mobile M-ARCH-08 catalogo comanda tavolo

Data ciclo: 2026-06-06.

Obiettivo:

- proseguire dal markdown scaricato sul blocco mobile;
- mitigare `M-ARCH-08`: impedire che la creazione comanda tavolo usi un catalogo generico/non filtrato quando il catalogo sessione sala/attivita non e' disponibile;
- bloccare l'apertura del composer ordine quando il menu operativo corretto non e' pronto.

Problema verificato:

- `TablesWorkspace.tsx` caricava il catalogo ordine tavolo con `fetchMenuCatalogForSession()`;
- in caso di errore faceva fallback a `fetchMenuCatalog()`;
- anche se `fetchMenuCatalog()` in produzione non usa piu' un catalogo statico puro, puo' comunque restituire un catalogo generale non coerente con sala, attivita, listino e permessi della sessione.

Correzioni applicate:

- rimosso da `TablesWorkspace.tsx` l'import del catalogo generico `fetchMenuCatalog`;
- la query `menuCatalogQuery` del dettaglio tavolo ora usa solo `fetchMenuCatalogForSession`;
- nessun `catch` locale converte piu' l'errore in catalogo generale;
- `TableDetailPanel` riceve:
  - `menuCatalogLoading`;
  - `menuCatalogError`;
- il pulsante `Ordina` e' disabilitato se:
  - il catalogo sessione e' in caricamento;
  - il catalogo sessione non esiste;
  - il catalogo sessione non contiene prodotti;
- quando il menu non e' disponibile viene mostrato errore chiaro:
  - `Menu non disponibile per questa sala e attivita.`

File modificati:

- `mobile-frontend/src/pages/home/tables/TablesWorkspace.tsx`;
- `mobile-frontend/src/pages/home/tables/components/TableDetailPanel.tsx`;
- `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs`;
- `mobile-frontend/dist/**` rigenerato da build;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `npm run typecheck` in `mobile-frontend`: OK;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs` in `cassa-frontend`: OK, 13/13;
- `npm run build` in `mobile-frontend`: OK;
- `npm run check:backend` in `cassa-frontend`: OK;
- health V3:
  - `http://127.0.0.1:5280/api/health`: OK;
  - `http://127.0.0.1:5281/api/health`: OK.

Finding markdown chiusi o mitigati:

- M-ARCH-08: mitigato per il flusso transazionale di creazione comanda tavolo.

Rischi residui:

- `MenuWorkspace` e `useMenuSessionSync` mantengono ancora fallback verso catalogo generale in percorsi non transazionali; va valutato in una tranche separata se estendere la policy anche alla sola consultazione menu;
- serve test GUI reale/simulato per confermare UX: backend menu sessione non disponibile => pulsante `Ordina` disabilitato e messaggio leggibile;
- M-ARCH-09 resta il prossimo blocco naturale: ridurre responsabilita e stato globale in `mobile-frontend/src/api/tables.ts`.

## Ciclo V3 - audit markdown, tranche mobile M-ARCH-09 estrazione dominio tavoli

Data ciclo: 2026-06-06.

Obiettivo:

- avviare la mitigazione di `M-ARCH-09` senza refactor massivo;
- separare tipi e derivazioni pure dal client monolitico `mobile-frontend/src/api/tables.ts`;
- mantenere retrocompatibilita' degli import esistenti tramite re-export da `api/tables.ts`.

Problema verificato:

- `api/tables.ts` contiene ancora tipi, derivazioni, cache locale, queue integrazione, layout, comande, pagamenti, analytics e chiamate backend;
- il file misurava 2742 righe prima della tranche;
- i tipi pubblici e derivazioni pure erano mischiati con stato globale e side effect.

Correzioni applicate:

- creato `mobile-frontend/src/domain/tables/types.ts` con tipi dominio pubblici:
  - `DiningTable`;
  - `DiningTableOrder`;
  - `DiningTableOrderLine`;
  - `TableSessionRequest`;
  - tipi pagamento;
  - tipi stato ordine/tavolo;
  - `TableReservationPreview`;
- creato `mobile-frontend/src/domain/tables/derivations.ts` con derivazioni pure:
  - `derivePosStatusFromDiningTable`;
  - `deriveTableVisualState`;
- `api/tables.ts` ora importa e re-esporta i tipi/derivazioni dal dominio;
- `api/tableReservationWindow.ts` non importa piu' tipi da `./tables`, ma dal dominio;
- mantenuti gli import legacy dei componenti da `api/tables.ts` per non cambiare contratti nella stessa tranche;
- aggiunto test statico per assicurare che:
  - i tipi dominio siano nel nuovo modulo;
  - le derivazioni siano nel nuovo modulo;
  - `api/tables.ts` re-esporti invece di ridefinire;
  - `tableReservationWindow.ts` non dipenda piu' da `./tables` per i tipi.

Metriche:

- `mobile-frontend/src/api/tables.ts` prima: 2742 righe;
- `mobile-frontend/src/api/tables.ts` dopo: 2676 righe;
- nuovo `domain/tables/types.ts`: 112 righe;
- nuovo `domain/tables/derivations.ts`: 16 righe.

File modificati:

- `mobile-frontend/src/api/tables.ts`;
- `mobile-frontend/src/api/tableReservationWindow.ts`;
- `mobile-frontend/src/domain/tables/types.ts`;
- `mobile-frontend/src/domain/tables/derivations.ts`;
- `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs`;
- `mobile-frontend/dist/**` rigenerato da build;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `npm run typecheck` in `mobile-frontend`: OK;
- `npm run test -- tests/tableSessionHistory.test.ts tests/frontendAuditFixes.test.ts tests/reservationWindow.test.ts tests/paymentArticleUnits.test.ts tests/paymentBackendPayload.test.ts --run` in `mobile-frontend`: OK, 16/16;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs` in `cassa-frontend`: OK, 14/14;
- `npm run build` in `mobile-frontend`: OK;
- `npm run check:backend` in `cassa-frontend`: OK;
- health V3:
  - `http://127.0.0.1:5280/api/health`: OK;
  - `http://127.0.0.1:5281/api/health`: OK.

Finding markdown chiusi o mitigati:

- M-ARCH-09: mitigazione avviata; dominio puro estratto, ma il finding non e' ancora chiuso.

Rischi residui:

- `api/tables.ts` resta grande e mantiene ancora stato globale (`roomStates`, fingerprint layout/ordini, queue integrazione);
- prossime tranche consigliate:
  - estrarre `tablesQueryKey` e query helpers;
  - estrarre normalizzatori layout/ordini;
  - isolare integration queue in modulo dedicato;
  - separare client pagamenti/tavoli/ordini;
- M-ARCH-10 resta il prossimo finding markdown, ma si puo' scegliere di continuare M-ARCH-09 con un'altra slice se l'obiettivo prioritario e' ridurre il monolite mobile.

## Checkpoint sospensione V3 - 2026-06-06 23:14 CEST

- Lavoro V3 sospeso temporaneamente su richiesta utente per tornare sulla V2/current operativa senza riavvii.
- Ultimo step completato in V3: `M-ARCH-09` prima tranche, estrazione dominio tavoli.
- Stato test ultimo step V3: typecheck OK, test mirati 16/16, statico 14/14, build OK, check backend OK, health 5280/5281 OK.
- Prossimo step V3 suggerito alla ripresa:
  - continuare `M-ARCH-09` con estrazione query helpers/normalizzatori/queue;
  - oppure passare a `M-ARCH-10` se prioritario.
- Durante la sospensione non modificare V3 salvo richiesta esplicita; gli interventi correnti sono su `/srv/applicazione/current`.

## Hotfix allineato V2/V3 - pagamenti contanti dopo importo libero carta e preconto dopo reso

Data ciclo: 2026-06-06 23:18 CEST.

Motivo:

- durante un pagamento parziale con importo libero, dopo una quota carta il successivo pagamento contanti non mostrava lo slide se l'operatore inseriva solo la quota da pagare e non il contante ricevuto;
- il reso senza sostituzione aggiornava i dati ma non ristampava automaticamente il preconto aggiornato.

Correzioni applicate anche su V3 dopo verifica:

- `TablePaymentWizard.tsx`:
  - aggiunto parser `parsePaymentInputAmount()` con supporto virgola decimale;
  - l'importo libero usa il parser normalizzato;
  - l'importo digitale usa lo stesso parser;
  - quando il metodo e' contanti e la quota e' valida, se `cashReceived` e' ancora zero viene precompilato alla quota;
  - aggiunto campo manuale `Contanti ricevuti`;
  - lo slide compare quindi anche nel flusso carta parziale -> contanti libero, salvo reale insufficienza ricevuto.
- `TableServiceRecoveryDialog.tsx`:
  - `onDone()` riceve il contesto `{ action, sendReplacement }`;
  - RESO e SOSTITUZIONE passano correttamente il flag `sendReplacement`.
- `TablesWorkspace.tsx`:
  - dopo RESO senza sostituzione (`action=replacement`, `sendReplacement=false`) esegue refetch tavoli;
  - stampa preconto aggiornato in modalita `current` con i dati del tavolo aggiornato;
  - se la stampa fallisce, il reso resta registrato e viene mostrato avviso operativo.

Test V3 eseguiti:

- `npm run typecheck` in `mobile-frontend`: OK;
- `npm run test -- tests/paymentArticleUnits.test.ts tests/paymentBackendPayload.test.ts tests/orderServiceRecovery.test.ts --run`: OK, 9/9;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `npm run build` in `mobile-frontend`: OK;
- `npm run check:backend` in `cassa-frontend`: OK;
- health V3 5280/5281: OK.

Nota:

- La V2/current ha ricevuto lo stesso hotfix e build mobile senza riavvio servizi.

## Hotfix V3 - divisione per articolo preserva prezzi riga emessi

Data ciclo: 2026-06-06 23:37 CEST.

Motivo:

- dopo la correzione su V2/current, e' stato verificato che V3 aveva ancora lo stesso rischio nella divisione pagamento per articolo;
- se `order.total` era stato modificato da residui, correzioni, parziali o altre rettifiche, la lista articoli poteva redistribuire proporzionalmente il totale e mostrare importi articolo non corrispondenti ai prezzi riga emessi.

Correzione applicata:

- `mobile-frontend/src/shared/pricing/orderEmissionPricing.ts`:
  - introdotta modalita esplicita `preserve-line-prices`;
  - il default resta `balance-to-total`, cosi' i flussi esistenti non cambiano comportamento;
  - se i prezzi riga sono presenti, la modalita preserva i `unitFinalPrice/unitBasePrice` senza redistribuire `order.total`;
  - se non ci sono prezzi riga validi, il fallback legacy continua a bilanciare sul totale.
- `mobile-frontend/src/pages/home/tables/payment/paymentArticleUnits.ts`:
  - la divisione per articolo usa `pricingMode: "preserve-line-prices"`;
  - gli importi visibili nella selezione articolo restano quindi quelli emessi sulla comanda.
- Test aggiunti/aggiornati:
  - `mobile-frontend/tests/orderEmissionPricing.test.ts`;
  - `mobile-frontend/tests/paymentArticleUnits.test.ts`.

Test eseguiti:

- `npm run test -- tests/orderEmissionPricing.test.ts tests/paymentArticleUnits.test.ts --run` in `mobile-frontend`: OK, 9/9.

Stato:

- V3 riallineata alla V2/current sul bug prezzi articolo.

## Ciclo V3 - audit markdown, tranche mobile M-ARCH-09 query helpers

Data ciclo: 2026-06-06 23:37 CEST.

Obiettivo:

- continuare la riduzione conservativa del monolite `mobile-frontend/src/api/tables.ts`;
- estrarre una responsabilita infrastrutturale piccola e pura senza cambiare contratti pubblici;
- mantenere import legacy da `api/tables.ts` tramite re-export.

Correzioni applicate:

- creato `mobile-frontend/src/domain/tables/queryKeys.ts` con:
  - `TABLE_SESSION_HISTORY_GRACE_MS`;
  - `tablesQueryKey(roomId, activityId)`;
- `mobile-frontend/src/api/tables.ts` ora importa la costante dal dominio e re-esporta `tablesQueryKey`;
- i componenti possono continuare a importare `tablesQueryKey` da `api/tables.ts`;
- esteso `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs` per verificare che:
  - query key e grace constant siano nel modulo dominio;
  - `api/tables.ts` le re-esporti/importi invece di ridefinirle.

Metriche:

- `mobile-frontend/src/api/tables.ts` dopo tranche precedente: 2676 righe;
- `mobile-frontend/src/api/tables.ts` dopo questa tranche: 2675 righe;
- nuovo `mobile-frontend/src/domain/tables/queryKeys.ts`: 4 righe.

File modificati:

- `mobile-frontend/src/shared/pricing/orderEmissionPricing.ts`;
- `mobile-frontend/src/pages/home/tables/payment/paymentArticleUnits.ts`;
- `mobile-frontend/tests/orderEmissionPricing.test.ts`;
- `mobile-frontend/tests/paymentArticleUnits.test.ts`;
- `mobile-frontend/src/api/tables.ts`;
- `mobile-frontend/src/domain/tables/queryKeys.ts`;
- `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs`;
- `mobile-frontend/dist/**` rigenerato da build;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `npm run test -- tests/orderEmissionPricing.test.ts tests/paymentArticleUnits.test.ts tests/tableSessionHistory.test.ts tests/reservationWindow.test.ts --run` in `mobile-frontend`: OK, 15/15;
- `npm run typecheck` in `mobile-frontend`: OK;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs` in `cassa-frontend`: OK, 14/14;
- `npm run check:backend` in `cassa-frontend`: OK;
- `npm run build` in `mobile-frontend`: OK;
- controllo statico post-build `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- health V3:
  - `http://127.0.0.1:5280/api/health`: OK;
  - `http://127.0.0.1:5281/api/health`: OK.

Finding markdown:

- `M-ARCH-09`: mitigazione proseguita, non chiusa.

Rischi residui:

- `api/tables.ts` resta ancora grande e contiene stato globale, fingerprint e queue integrazione;
- prossima tranche consigliata:
  - estrarre normalizzatori layout/ordini puri;
  - poi isolare integration queue in modulo dedicato;
  - solo dopo valutare client separati layout/orders/payments.

## Ciclo V3 - audit markdown, tranche mobile M-ARCH-09 tipi integrazione

Data ciclo: 2026-06-06 23:40 CEST.

Obiettivo:

- proseguire `M-ARCH-09` con un taglio type-only piu' sostanzioso;
- spostare tipi integrazione/layout/queue fuori da `mobile-frontend/src/api/tables.ts`;
- non cambiare logica runtime, payload, endpoint o side effect.

Correzioni applicate:

- creato `mobile-frontend/src/domain/tables/integrationTypes.ts` con:
  - `IntegrationOrderCreateResult`;
  - `PendingIntegrationAction` e relative varianti;
  - `IntegrationOrderItem`;
  - `IntegrationOrder`;
  - `IntegrationLayoutRoom`;
  - `IntegrationLayoutTable`;
- `mobile-frontend/src/api/tables.ts` ora importa questi tipi dal dominio invece di ridefinirli inline;
- esteso `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs` per verificare che i tipi integrazione non tornino nel monolite.

Metriche:

- `mobile-frontend/src/api/tables.ts` prima tranche query helpers: 2675 righe;
- `mobile-frontend/src/api/tables.ts` dopo tranche tipi integrazione: 2585 righe;
- nuovo `mobile-frontend/src/domain/tables/integrationTypes.ts`: 100 righe.

File modificati:

- `mobile-frontend/src/api/tables.ts`;
- `mobile-frontend/src/domain/tables/integrationTypes.ts`;
- `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs`;
- `mobile-frontend/dist/**` rigenerato da build;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `npm run typecheck` in `mobile-frontend`: OK;
- `npm run test -- tests/orderEmissionPricing.test.ts tests/paymentArticleUnits.test.ts tests/tableSessionHistory.test.ts tests/reservationWindow.test.ts --run` in `mobile-frontend`: OK, 15/15;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs` in `cassa-frontend`: OK, 14/14;
- `npm run build` in `mobile-frontend`: OK;
- `npm run check:backend` in `cassa-frontend`: OK;
- controllo statico post-build `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Finding markdown:

- `M-ARCH-09`: mitigazione proseguita, non chiusa.

Prossimo step V3 consigliato:

- estrarre normalizzatori puri layout/ordine:
  - `parseIntegrationLayoutRoom`;
  - `parseIntegrationLayoutTable`;
  - `parseIntegrationOrder`;
  - `parseIntegrationWorkflowStatus`;
- questa tranche richiede piu' attenzione perche' include funzioni pure ma usate nella fetch backend.

## Ciclo V3 - audit markdown, tranche mobile M-ARCH-09 parser integrazione

Data ciclo: 2026-06-07 00:12 CEST.

Obiettivo:

- completare il prossimo step indicato nella memoria;
- spostare normalizzatori puri layout/ordini fuori dal monolite `mobile-frontend/src/api/tables.ts`;
- mantenere invariati fetch backend, cache, queue, payload, pagamenti e stampa.

Correzioni applicate:

- creato `mobile-frontend/src/domain/tables/integrationParsers.ts` con:
  - `parseIntegrationLayoutRoom`;
  - `parseIntegrationLayoutTable`;
  - `toDiningTableFromLayout`;
  - `parseIntegrationWorkflowStatus`;
  - `parseIntegrationOrder`;
- `mobile-frontend/src/api/tables.ts` ora importa questi parser invece di definirli localmente;
- rimossi helper/type import locali non piu' usati dal monolite;
- creato `mobile-frontend/tests/integrationParsers.test.ts` per coprire:
  - parsing sale layout valide/invalide;
  - sanificazione tavoli layout;
  - alias workflow `pronta`, `in_preparazione`, `consegnato`;
  - normalizzazione denaro e item ordine;
  - conversione layout table -> dining table vuoto;
- esteso `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs` per evitare regressione dei parser dentro `api/tables.ts`.

Metriche:

- `mobile-frontend/src/api/tables.ts` prima tranche parser: 2585 righe;
- `mobile-frontend/src/api/tables.ts` dopo tranche parser: 2436 righe;
- nuovo `mobile-frontend/src/domain/tables/integrationParsers.ts`: 173 righe.

File modificati:

- `mobile-frontend/src/api/tables.ts`;
- `mobile-frontend/src/domain/tables/integrationParsers.ts`;
- `mobile-frontend/tests/integrationParsers.test.ts`;
- `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs`;
- `mobile-frontend/dist/**` rigenerato da build;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `npm run typecheck` in `mobile-frontend`: OK;
- `npm run test -- tests/integrationParsers.test.ts tests/orderEmissionPricing.test.ts tests/paymentArticleUnits.test.ts tests/tableSessionHistory.test.ts tests/reservationWindow.test.ts --run` in `mobile-frontend`: OK, 20/20;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs` in `cassa-frontend`: OK, 14/14;
- `npm run build` in `mobile-frontend`: OK;
- `npm run check:backend` in `cassa-frontend`: OK;
- controllo statico post-build `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- health V3:
  - `http://127.0.0.1:5280/api/health`: OK;
  - `http://127.0.0.1:5281/api/health`: OK.

Finding markdown:

- `M-ARCH-09`: mitigazione proseguita in modo sostanzioso, non ancora chiusa.

Prossimo step V3 consigliato:

- estrarre `buildIntegrationOrderFingerprint`, `groupIntegrationOrderLines`, `deriveOrderStateFromIntegration` e `toDiningOrderFromIntegration` in un modulo dominio/normalizzazione ordini;
- successivamente valutare isolamento della integration queue in modulo dedicato.

## Ciclo V3 - audit markdown, tranche mobile M-ARCH-09 trasformazioni ordini

Data ciclo: 2026-06-07 00:16 CEST.

Obiettivo:

- completare il prossimo step indicato nella memoria;
- spostare trasformazioni pure `IntegrationOrder -> DiningTableOrder` fuori da `mobile-frontend/src/api/tables.ts`;
- mantenere retrocompatibilita' con import esistenti di `buildIntegrationOrderFingerprint` da `api/tables.ts`.

Correzioni applicate:

- creato `mobile-frontend/src/domain/tables/integrationOrderTransforms.ts` con:
  - `buildIntegrationOrderFingerprint`;
  - `groupIntegrationOrderLines`;
  - `deriveOrderStateFromIntegration`;
  - `toDiningOrderFromIntegration`;
- `mobile-frontend/src/api/tables.ts` importa le trasformazioni dal dominio;
- `mobile-frontend/src/api/tables.ts` re-esporta `buildIntegrationOrderFingerprint` per compatibilita' con test/client esistenti;
- creato `mobile-frontend/tests/integrationOrderTransforms.test.ts` per coprire:
  - raggruppamento item per lineId;
  - preservazione prezzi emessi;
  - esclusione righe voided e `BAR_CHARGE_REPLACEMENT`;
  - mapping workflow/payment status nello stato comanda mobile;
  - fingerprint che cambia al cambio prezzo item;
- esteso `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs` per evitare regressione delle trasformazioni dentro `api/tables.ts`.

Metriche:

- `mobile-frontend/src/api/tables.ts` prima tranche trasformazioni: 2436 righe;
- `mobile-frontend/src/api/tables.ts` dopo tranche trasformazioni: 2332 righe;
- nuovo `mobile-frontend/src/domain/tables/integrationOrderTransforms.ts`: 111 righe.

File modificati:

- `mobile-frontend/src/api/tables.ts`;
- `mobile-frontend/src/domain/tables/integrationOrderTransforms.ts`;
- `mobile-frontend/tests/integrationOrderTransforms.test.ts`;
- `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs`;
- `mobile-frontend/dist/**` rigenerato da build;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `npm run typecheck` in `mobile-frontend`: OK;
- `npm run test -- tests/integrationParsers.test.ts tests/integrationOrderTransforms.test.ts tests/frontendAuditFixes.test.ts tests/orderEmissionPricing.test.ts tests/paymentArticleUnits.test.ts tests/tableSessionHistory.test.ts tests/reservationWindow.test.ts --run` in `mobile-frontend`: OK, 28/28;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs` in `cassa-frontend`: OK, 14/14;
- `npm run build` in `mobile-frontend`: OK;
- `npm run check:backend` in `cassa-frontend`: OK;
- controllo statico post-build `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- health V3:
  - `http://127.0.0.1:5280/api/health`: OK;
  - `http://127.0.0.1:5281/api/health`: OK.

Finding markdown:

- `M-ARCH-09`: mitigazione proseguita, ancora non chiusa perche' rimangono queue, stato globale e client side-effect nello stesso file.

Prossimo step V3 consigliato:

- isolare integration queue (`readIntegrationQueueFromStorage`, `persistIntegrationQueue`, `processQueuedIntegrationAction`, `flushIntegrationQueue`, `enqueueIntegrationAction`) con attenzione perche' contiene side effect e richiami a funzioni backend;
- prima possibile estrarre solo storage/serializzazione queue, poi la logica di flush.

## Ciclo V3 - audit markdown, tranche mobile M-ARCH-09 storage queue integrazione

Data ciclo: 2026-06-07 00:20 CEST.

Obiettivo:

- iniziare l'isolamento della integration queue senza spostare ancora il flush operativo;
- estrarre solo storage, parsing e serializzazione della coda;
- lasciare invariati side effect, retry, chiamate backend e ordine di flush.

Correzioni applicate:

- creato `mobile-frontend/src/domain/tables/integrationQueueStorage.ts` con:
  - `INTEGRATION_QUEUE_STORAGE_KEY`;
  - `loadIntegrationQueueFromStorage`;
  - `saveIntegrationQueueToStorage`;
- `mobile-frontend/src/api/tables.ts` usa il nuovo modulo per caricare/salvare la queue;
- la logica di flush resta nel monolite per evitare refactor side-effect troppo ampio in questa tranche;
- creato `mobile-frontend/tests/integrationQueueStorage.test.ts` per coprire:
  - caricamento di azioni valide;
  - scarto di record invalidi;
  - gestione JSON non valido;
  - salvataggio su chiave stabile;
- esteso `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs` per evitare che parsing/storage queue tornino nel monolite.

Metriche:

- `mobile-frontend/src/api/tables.ts` prima tranche queue storage: 2332 righe;
- `mobile-frontend/src/api/tables.ts` dopo tranche queue storage: 2257 righe;
- nuovo `mobile-frontend/src/domain/tables/integrationQueueStorage.ts`: 85 righe.

File modificati:

- `mobile-frontend/src/api/tables.ts`;
- `mobile-frontend/src/domain/tables/integrationQueueStorage.ts`;
- `mobile-frontend/tests/integrationQueueStorage.test.ts`;
- `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs`;
- `mobile-frontend/dist/**` rigenerato da build;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `npm run typecheck` in `mobile-frontend`: OK;
- `npm run test -- tests/integrationQueueStorage.test.ts tests/integrationParsers.test.ts tests/integrationOrderTransforms.test.ts tests/frontendAuditFixes.test.ts tests/orderEmissionPricing.test.ts tests/paymentArticleUnits.test.ts tests/tableSessionHistory.test.ts tests/reservationWindow.test.ts --run` in `mobile-frontend`: OK, 31/31;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs` in `cassa-frontend`: OK, 14/14;
- `npm run build` in `mobile-frontend`: OK;
- `npm run check:backend` in `cassa-frontend`: OK;
- controllo statico post-build `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- health V3:
  - `http://127.0.0.1:5280/api/health`: OK;
  - `http://127.0.0.1:5281/api/health`: OK.

Finding markdown:

- `M-ARCH-09`: mitigazione proseguita, ancora non chiusa.

Prossimo step V3 consigliato:

- valutare estrazione controllata della logica queue di flush in un service con dipendenze iniettate;
- in alternativa, prima estrarre client layout/orders/payments a basso rischio.

## Ciclo V3 - audit markdown, tranche mobile M-ARCH-09 client HTTP integrazione

Data ciclo: 2026-06-07 00:35 CEST.

Obiettivo:

- proseguire la riduzione del monolite `mobile-frontend/src/api/tables.ts`;
- estrarre le chiamate HTTP di integrazione layout/ordini in un client dedicato;
- non spostare ancora lo stato globale, il flush queue o l'orchestrazione dei tavoli.

Correzioni applicate:

- creato `mobile-frontend/src/api/tables/integrationClient.ts` con:
  - `fetchIntegrationLayout`;
  - `fetchIntegrationOrders`;
  - `sendIntegrationOrderCreateRequest`;
  - `sendIntegrationOrderSyncRequest`;
  - `sendIntegrationLayoutSyncRequest`;
  - `sendIntegrationLayoutMoveRequest`;
  - `shouldQueueForRetry`;
  - `postIntegrationJson`;
- `mobile-frontend/src/api/tables.ts` ora importa il client e mantiene solo orchestrazione, cache, queue runtime e mapping verso UI;
- mantenuta invariata la semantica:
  - stessi endpoint;
  - stessi payload;
  - stesso fallback `layout/table/sync` con sessione dopo 400/401/403;
  - stessa policy retry;
  - stesso warning per postazione in pausa.
- creato `mobile-frontend/tests/integrationClient.test.ts` con mock di `apiFetch` per coprire:
  - normalizzazione layout;
  - filtro ordini per sala;
  - warning postazione in pausa;
  - fallback layout sync con session payload;
  - retry policy deterministica;
- esteso `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs` per evitare che client HTTP torni nel monolite.

Metriche:

- `mobile-frontend/src/api/tables.ts` prima tranche client HTTP: 2257 righe;
- `mobile-frontend/src/api/tables.ts` dopo tranche client HTTP: 2054 righe;
- nuovo `mobile-frontend/src/api/tables/integrationClient.ts`: 222 righe.

File modificati:

- `mobile-frontend/src/api/tables.ts`;
- `mobile-frontend/src/api/tables/integrationClient.ts`;
- `mobile-frontend/tests/integrationClient.test.ts`;
- `cassa-frontend/frontend-tests/mobile-frontendv2-static.test.mjs`;
- `mobile-frontend/dist/**` rigenerato da build;
- `CONFIGURATION_ARCHITECTURE_MEMORY.md`.

Test eseguiti:

- `npm run typecheck` in `mobile-frontend`: OK;
- `npm run test -- tests/integrationClient.test.ts tests/integrationQueueStorage.test.ts tests/integrationParsers.test.ts tests/integrationOrderTransforms.test.ts tests/frontendAuditFixes.test.ts tests/orderEmissionPricing.test.ts tests/paymentArticleUnits.test.ts tests/tableSessionHistory.test.ts tests/reservationWindow.test.ts --run` in `mobile-frontend`: OK, 36/36;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs` in `cassa-frontend`: OK, 14/14;
- `npm run build` in `mobile-frontend`: OK;
- `npm run check:backend` in `cassa-frontend`: OK;
- controllo statico post-build `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- health V3:
  - `http://127.0.0.1:5280/api/health`: OK;
  - `http://127.0.0.1:5281/api/health`: OK.

Finding markdown:

- `M-ARCH-09`: mitigazione proseguita, non ancora chiusa.

Prossimo step V3 consigliato:

- estrarre client specifici per pagamenti/preconti/stampa oppure isolare gradualmente il runtime della integration queue con dipendenze iniettate.

## Hotfix V2/V3 - long press sposta tavolo e reso sempre disponibile

Data ciclo: 2026-06-07 00:46 CEST.

Motivo:

- su V2/current, nel long press di un tavolo l'opzione `Sposta` non era sempre visibile;
- la causa era il vincolo grafico/logico `!rootGroup`, che nascondeva lo spostamento quando il tavolo era gia' dentro una unione/gruppo;
- il reso comanda era visibile solo per comande pronte, consegnate, servite o pagate;
- requisito aggiornato: il reso deve essere disponibile appena la comanda compare nello storico comande, quindi gia' dal momento dell'ordine.

Correzioni applicate:

- `mobile-frontend/src/pages/home/tables/components/TableGroupsDialog.tsx`:
  - il pulsante `Sposta` nel menu long press e' sempre visibile;
  - la modale `state.type === "move"` puo' aprirsi anche per tavoli raggruppati/uniti;
  - `Dividi` resta visibile quando il tavolo e' un gruppo.
- `mobile-frontend/src/pages/home/tables/components/TableDetailPanel.tsx`:
  - `canShowServiceRecoveryReplacement()` ora mostra `Reso` per ogni comanda integration con righe positive;
  - non aspetta piu' `ready`, `delivered`, `served` o `paid`.
- Test aggiornati:
  - `mobile-frontend/tests/nativeBridgeFunctionality.test.tsx`;
  - `mobile-frontend/tests/static/tableMoveModalVisualParity.test.ts`.

Note operative:

- V2/current e' stata corretta e buildata senza riavviare i servizi;
- stessa correzione applicata anche su V3;
- la disponibilita' righe del reso continua a usare `serviceRecoveryAvailableQuantity` quando presente e il fallback sulla quantita' riga quando assente.

Test V3 eseguiti:

- `npm run test -- tests/nativeBridgeFunctionality.test.tsx tests/static/tableMoveModalVisualParity.test.ts --run`: OK, 13/13;
- `npm run typecheck`: OK;
- `npm run build`: OK;
- `npm run check:backend`: OK;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- health V3:
  - `http://127.0.0.1:5280/api/health`: OK;
  - `http://127.0.0.1:5281/api/health`: OK.

## Ciclo V3 - gate load balancing e coda preparazione postazioni

Data ciclo: 2026-06-07 01:35 CEST.

Obiettivo:

- proseguire il V3 chiudendo il gate rosso storico rimasto in `continuity.e2e`;
- rendere piu' deterministico il load balancing tra postazioni reali;
- riallineare i test alla regola V3 `1 postazione = 1 utente`;
- non toccare V2/current e non riavviare servizi live.

Problema riscontrato:

- il test legacy provava due operatori sulla stessa postazione, comportamento ora vietato correttamente;
- durante il bilanciamento, il carico veniva contato in modo troppo legato all'identita' operatore;
- in caso di cambio device/relogin o dati operatore mancanti su una comanda gia' assegnata, la postazione poteva sembrare scarica;
- i test di coda preparazione erano contaminati da carico aperto prodotto dai casi precedenti della continuity suite.

Correzioni applicate:

- `cassa-frontend/backend/integration/load-balancer.service.js`:
  - `estimateStationWorkload()` ora conta il carico aperto della postazione fisica anche se l'identita' operatore della comanda non combacia perfettamente;
  - la scelta resta basata su postazioni attive, carico aperto, item count, storico tempi e rotazione deterministica.
- `cassa-frontend/backend/tests/load-balancer-station-eligibility.test.mjs`:
  - aggiunto test per carico aperto su postazione con identita' operatore mancante/cambiata.
- `cassa-frontend/backend/tests/continuity.e2e.test.mjs`:
  - il caso 34 usa due postazioni distinte e verifica visibilita' esclusiva per operatore;
  - i casi 35/35b isolano la lane di preparazione mettendo temporaneamente offline la postazione principale e usando `BAR SECONDARIA`;
  - `readyOrder()` accetta ora il nome postazione per evitare di riscrivere comande assegnate a postazioni diverse.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `node --check backend/tests/continuity.e2e.test.mjs`: OK;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 6/6;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- gate security verde;
- gate continuity verde;
- nessun dump diagnostico lasciato nel codice;
- V2 non toccata in questo ciclo;
- V3 piu' pronto per il prossimo step di riduzione monolite.

Prossimo step consigliato:

- continuare la riduzione V3 estraendo una slice pura collegata a postazioni/load balancing oppure coda preparazione;
- evitare ancora lo spostamento di handler con side effect finche' non si aggiorna una suite release piu' ampia.

## Hotfix V3 - storico comande post-pagamento e movimenti cancellazione tavolo

Data ciclo: 2026-06-07 02:02 CEST.

Motivo:

- riallineare V3 alla correzione V2 richiesta per lo storico comande che poteva sparire dopo pagamento completo;
- mantenere V3 coerente con la nuova visualizzazione importi/metodi nei movimenti collegati alla cancellazione tavolo.

Correzioni applicate:

- `mobile-frontend/src/api/tables.ts`:
  - `applyIntegrationOrdersToTables()` preserva lo storico appena pagato quando il backend restituisce il tavolo gia' libero ma il client ha ancora la sessione corrente;
  - non vengono riagganciati archivi vecchi se il client non ha storico locale;
  - la cancellazione tavolo prepara riepiloghi movimenti con importo e metodo, non solo con id tecnici.
- `mobile-frontend/tests/tableSessionHistory.test.ts`:
  - aggiunto test mirato sul pagamento completo con layout backend gia' libero.

Test V3 eseguiti:

- `npm run test -- tests/tableSessionHistory.test.ts --run`: OK, 3/3;
- `npm run typecheck`: OK;
- `npm run build`: OK.

Stato:

- correzione applicata senza riavviare servizi;
- dist mobile V3 rigenerato;
- compatibile con la decomposizione gia' presente in V3.

## Ciclo V3 - riduzione monolite coda preparazione

Data ciclo: 2026-06-07 02:20 CEST.

Obiettivo:

- proseguire dopo la chiusura dei gate continuity/security;
- estrarre una regola pura della coda preparazione senza spostare handler con side effect;
- proteggere il vincolo massimo comande in preparazione per lane/postazione.

Correzioni applicate:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`:
  - aggiunta `countPreparingIntegrationOrdersInLane()`;
  - la funzione conta solo comande `prep` nella stessa lane;
  - supporta `excludeOrderId`;
  - usa dipendenze iniettate per lane key, normalizzazione workflow e sanitize ordine.
- `cassa-frontend/backend/server.js`:
  - rimossa la funzione duplicata dal monolite;
  - il blocco `PREPARATION_QUEUE_FULL` usa il modulo estratto con le stesse dipendenze server.
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`:
  - copre progress item, conteggio lane, esclusione id, fallback sicuro senza dipendenze e demotion di prep vuote.

Metriche:

- `cassa-frontend/backend/server.js`: 28.596 -> 28.585 righe;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 134 righe;
- nuovo test: 160 righe;
- nessuna nuova dipendenza;
- nessuna modifica DB o contratto API.

Test V3 eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 4/4;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 6/6;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- coda preparazione e load balancing restano verdi.

Prossimo step consigliato:

- estrarre una seconda regola pura da `reconcileIntegrationPreparationQueue()` oppure un adapter puro per lane attive;
- evitare ancora spostamento handler/side effect finche' non si ha un modulo domain piu' completo e coperto.

## Ciclo V3 - selettore puro promozione coda preparazione

Data ciclo: 2026-06-07 02:32 CEST.

Obiettivo:

- proseguire la riduzione del monolite senza spostare handler con side effect;
- rendere testabile la scelta della prossima comanda `waiting` da promuovere a `prep`;
- mantenere invariata la mutazione DB dentro `reconcileIntegrationPreparationQueue()`.

Correzioni applicate:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`:
  - aggiunta `selectPreparationQueuePromotionIds()`;
  - la funzione decide gli id da promuovere per ogni lane attiva;
  - non promuove se la lane ha gia' una comanda `prep`;
  - sceglie l'ordine piu' vecchio per `receivedAtMs`, con tie-break su id;
  - ignora lane inattive e ordini non aperti/pagabili tramite dipendenze iniettate.
- `cassa-frontend/backend/server.js`:
  - rimosso dal monolite il blocco `lanesWithPreparation/waitingByLane`;
  - `reconcileIntegrationPreparationQueue()` usa il selettore puro e continua solo ad applicare la promozione.
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`:
  - aggiunti test su promozione oldest-per-lane e blocco lane con prep/inattive.

Metriche:

- `cassa-frontend/backend/server.js`: 28.585 -> 28.553 righe;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 214 righe;
- test modulo: 260 righe;
- nessuna nuova dipendenza;
- nessuna modifica DB o contratto API.

Test V3 eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 6/6;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- coda preparazione/load balancing/security restano verdi.

Prossimo step consigliato:

- estrarre il calcolo delle lane attive oppure le regole `isIntegrationOrderOpenForPreparationQueue` / `isIntegrationOrderQueueLaneActive`;
- tenere ancora nel server la mutazione effettiva di `db.integration.orders` finche' il dominio coda non e' completo.

## Ciclo V3 - regole pure apertura ordine e lane attiva

Data ciclo: 2026-06-07 02:47 CEST.

Obiettivo:

- completare un altro pezzo della decomposizione della coda preparazione;
- spostare fuori dal monolite le regole pure che decidono:
  - se un ordine entra nella coda preparazione;
  - se la lane/postazione dell'ordine e' attiva;
- mantenere nel server le dipendenze reali e la mutazione DB.

Correzioni applicate:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`:
  - aggiunta `isIntegrationOrderOpenForPreparationQueue()`;
  - aggiunta `isIntegrationOrderQueueLaneActive()`;
  - il selettore `selectPreparationQueuePromotionIds()` continua a ricevere adapter iniettati, ora costruiti dal server con le nuove funzioni pure.
- `cassa-frontend/backend/server.js`:
  - rimosse le due funzioni locali equivalenti;
  - `reconcileIntegrationPreparationQueue()` passa closure esplicite con `roundMoney`, `normalizeIntegrationWorkflowStatus`, `integrationOrderQueueStation`, `integrationOrderQueueLaneKey` e `integrationOrderQueueOperatorKey`.
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`:
  - aggiunti test su ordine aperto/non aperto;
  - aggiunti test su lane attiva, operatore diverso e postazione inattiva;
  - aggiornati i fixture del selettore per esplicitare `dueAmount`.

Metriche:

- `cassa-frontend/backend/server.js`: 28.553 -> 28.539 righe;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 259 righe;
- test modulo: 326 righe;
- nessuna nuova dipendenza;
- nessuna modifica DB o contratto API.

Test V3 eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 8/8;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 6/6;
- `npm run check:backend`: OK;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- dominio coda preparazione piu' coeso e testato.

Prossimo step consigliato:

- estrarre un adapter puro per costruire le lane attive a partire dagli station states gia' normalizzati;
- in alternativa iniziare a preparare una factory `createPreparationQueueService()` senza spostare ancora side effect DB.

## Ciclo V3 - builder lane attive coda preparazione

Data ciclo: 2026-06-07 03:41 CEST.

Obiettivo:

- continuare la riduzione conservativa del monolite sulla coda preparazione;
- spostare fuori dal server la costruzione delle lane/postazioni attive usate da `reconcileIntegrationPreparationQueue()`;
- mantenere nel server il recupero reale degli station states e la mutazione DB;
- non toccare V2/current e non riavviare servizi.

Correzioni applicate:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`:
  - aggiunta `buildActivePreparationQueueLaneKeys(stationStates, dependencies)`;
  - la funzione riceve adapter espliciti per `getActiveStations`, normalizzazione nome postazione e chiave operatore;
  - ritorna sempre `{ lanes: Set, stations: Set }`;
  - fallback sicuro a set vuoti se input o adapter non sono validi.
- `cassa-frontend/backend/server.js`:
  - `buildActiveIntegrationOrderQueueLaneKeys(db)` ora prepara gli station states reali e delega la costruzione delle lane al modulo puro;
  - rimangono nel server `SHOW_DEMO_STATIONS`, `getActiveStations()`, normalizzazione e policy runtime.
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`:
  - aggiunti test sul builder delle lane attive;
  - copertura di postazioni reali attive;
  - copertura di demo/fallback esclusi quando non consentiti.

Metriche:

- `cassa-frontend/backend/server.js`: 28.539 -> 28.533 righe;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 293 righe;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`: 420 righe;
- nessuna nuova dipendenza;
- nessuna modifica DB o contratto API.

Test V3 eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 10/10;
- `npm run check:backend`: OK;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- lane attive/load balancing continuano a essere determinate da dati reali, non mock;
- la mutazione effettiva delle comande resta nel server per evitare un salto troppo grande.

Prossimo step consigliato:

- estrarre una piccola funzione pura per costruire il contesto di riconciliazione della coda (`activeQueue`, `orders`, `maxConcurrentPreparing`);
- non spostare ancora `promoteIntegrationOrderToPreparation()` perche' contiene side effect, transizioni workflow e sanitize;
- valutare una factory `createPreparationQueueService()` solo dopo aver isolato anche il contesto di riconciliazione.

## Ciclo V3 - record promozione coda preparazione

Data ciclo: 2026-06-07 03:41 CEST.

Obiettivo:

- continuare con un'estrazione minima e reversibile;
- rimuovere dal monolite la costruzione manuale del record di promozione ordine;
- non cambiare la transizione `waiting -> prep` ne' gli effetti DB.

Correzioni applicate:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`:
  - aggiunta `buildPreparationQueuePromotionRecord(order, dependencies)`;
  - normalizza `orderId`, `station`, `operatorUserId`, `operatorUsername`, `operatorName`;
  - ritorna `null` quando mancano ordine valido, id o adapter postazione.
- `cassa-frontend/backend/server.js`:
  - `reconcileIntegrationPreparationQueue()` usa il nuovo helper dopo `promoteIntegrationOrderToPreparation()`;
  - la promozione effettiva resta nel server.
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`:
  - aggiunto test su record di promozione;
  - aggiunti casi limite per dipendenze mancanti e ordine senza id.

Metriche:

- `cassa-frontend/backend/server.js`: 28.533 -> 28.531 righe;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 309 righe;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`: 458 righe;
- nessuna nuova dipendenza;
- nessuna modifica DB o contratto API.

Test V3 eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 11/11;
- `npm run check:backend`: OK;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- nessun cambio su pagamenti, fiscalita', stampa, sale o contratti API.

Prossimo step consigliato:

- estrarre un builder del contesto di riconciliazione o preparare una factory domain senza side effect;
- prima di muovere `promoteIntegrationOrderToPreparation()`, isolare in modulo dedicato route transition e sanitize oppure mantenerla nel monolite.

## Ciclo V3 - normalizzazione ordini coda preparazione

Data ciclo: 2026-06-07 03:54 CEST.

Obiettivo:

- proseguire la riduzione del monolite con una funzione pura e senza side effect;
- spostare fuori da `reconcileIntegrationPreparationQueue()` la normalizzazione degli ordini della coda;
- mantenere invariata la logica di promozione, scrittura DB, workflow, stampa, pagamenti e fiscalita'.

Correzioni applicate:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`:
  - aggiunta `normalizePreparationQueueOrders(orders, dependencies)`;
  - applica `sanitizeIntegrationOrder` con fallback id deterministico `00001`, `00002`, ecc.;
  - ritorna lista vuota se input o adapter non sono validi.
- `cassa-frontend/backend/server.js`:
  - `reconcileIntegrationPreparationQueue()` delega la normalizzazione al modulo coda preparazione;
  - resta nel server la decisione di scrivere `db.integration.orders`, `lastWriteAt` e la promozione effettiva.
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`:
  - aggiunto test su normalizzazione ordini;
  - coperti id esplicito, fallback id e input non valido.

Metriche:

- `cassa-frontend/backend/server.js`: 28.531 -> 28.530 righe;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 319 righe;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`: 485 righe;
- nessuna nuova dipendenza;
- nessuna modifica DB o contratto API.

Test V3 eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 12/12;
- `npm run check:backend`: OK;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- nessun comportamento runtime modificato intenzionalmente.

Prossimo step consigliato:

- creare un test mirato di dominio per il piano completo di riconciliazione prima di estrarre altre parti da `reconcileIntegrationPreparationQueue()`;
- evitare ancora lo spostamento di `promoteIntegrationOrderToPreparation()` finche' non vengono isolati `sanitizeIntegrationOrder()` e `applyIntegrationWorkflowRouteTransitions()`.

## Ciclo V3 - piano riconciliazione coda preparazione

Data ciclo: 2026-06-07 04:00 CEST.

Obiettivo:

- creare un piano puro di riconciliazione della coda preparazione;
- combinare in un modulo testato normalizzazione ordini e selezione delle promozioni;
- lasciare nel server solo coordinamento DB, applicazione promozione e timestamp.

Correzioni applicate:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`:
  - aggiunta `buildPreparationQueueReconciliationPlan(orders, activeQueue, dependencies)`;
  - ritorna `{ orders, promoteIds }`;
  - usa `normalizePreparationQueueOrders()` e `selectPreparationQueuePromotionIds()`;
  - ritorna piano vuoto con input o dipendenze non valide.
- `cassa-frontend/backend/server.js`:
  - `reconcileIntegrationPreparationQueue()` ora chiede al modulo il piano di riconciliazione;
  - rimangono nel server promozione effettiva, update DB e timestamp.
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`:
  - aggiunti test sul piano completo;
  - fixture `sanitizeIntegrationOrder` aggiornato per preservare `receivedAtMs`, necessario alla scelta cronologica corretta.

Nota test:

- il primo run mirato ha evidenziato che il fixture test non preservava `receivedAtMs`;
- il codice runtime non e' stato cambiato per questo punto;
- corretto il fixture e rieseguito il test mirato con esito OK.

Metriche:

- `cassa-frontend/backend/server.js`: 28.530 -> 28.529 righe;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 339 righe;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`: 540 righe;
- nessuna nuova dipendenza;
- nessuna modifica DB o contratto API.

Test V3 eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 14/14;
- `npm run check:backend`: OK;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- nessun side effect spostato fuori dal server.

Prossimo step consigliato:

- estrarre una funzione pura per applicare un piano di promozione a una lista gia' normalizzata, con `promoteOrder` e `buildPromotionRecord` iniettati;
- procedere solo con test mirato prima, perche' quel passo inizia ad avvicinarsi ai side effect del workflow.

## Ciclo V3 - applicazione piano promozioni coda preparazione

Data ciclo: 2026-06-07 04:05 CEST.

Obiettivo:

- completare il passo successivo della coda preparazione;
- estrarre l'applicazione del piano promozioni in una funzione pura con adapter iniettati;
- lasciare nel server la promozione reale `promoteIntegrationOrderToPreparation()` e la scrittura DB.

Correzioni applicate:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`:
  - aggiunta `applyPreparationQueuePromotionPlan(orders, promoteIds, dependencies)`;
  - riceve `promoteOrder` e `buildPromotionRecord` come adapter;
  - ritorna `{ orders, promoted }`;
  - non muta l'array originale;
  - mantiene l'ordine originale se `promoteOrder` non e' valido o ritorna un valore non valido.
- `cassa-frontend/backend/server.js`:
  - `reconcileIntegrationPreparationQueue()` usa `applyPreparationQueuePromotionPlan()`;
  - `promoteIntegrationOrderToPreparation()` resta nel server e viene passato come adapter;
  - `buildPreparationQueuePromotionRecord()` resta adapterizzato con `integrationOrderQueueStation`.
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`:
  - aggiunti test su promozione valida;
  - aggiunti test su nessun id/adapter mancante;
  - aggiunto test su `promoteOrder` non valido.

Metriche:

- `cassa-frontend/backend/server.js`: 28.529 -> 28.527 righe;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 379 righe;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`: 609 righe;
- nessuna nuova dipendenza;
- nessuna modifica DB o contratto API.

Test V3 eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 17/17;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: primo run KO intermittente su caso 20 `ready pickup targets sender...`, rerun completo OK, 69/69.

Nota su continuity:

- il primo run ha fallito sul timeout escalation pickup verso tutti i camerieri;
- il rerun completo successivo ha passato lo stesso caso 20 e tutta la suite 69/69;
- nessuna modifica al codice notifiche e nessuna riproducibilita' del failure osservata nel rerun;
- tenere d'occhio il test per possibile sensibilita' temporale.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- nessun side effect spostato fuori dal server.

Prossimo step consigliato:

- fermarsi prima di estrarre `promoteIntegrationOrderToPreparation()` finche' `sanitizeIntegrationOrder()` e `applyIntegrationWorkflowRouteTransitions()` restano nel monolite;
- prossimo step sicuro: aggiungere/estrarre helper puro per determinare se il risultato promozioni richiede timestamp DB, oppure passare a un'altra area del monolite meno legata a workflow side effect.

## Ciclo V3 - helper identita lane coda preparazione

Data ciclo: 2026-06-07 04:10 CEST.

Obiettivo:

- spostare fuori dal monolite gli helper puri che calcolano identita di coda preparazione;
- mantenere nel server wrapper locali per compatibilita' interna;
- proteggere load balancing e coda prep con test mirati.

Correzioni applicate:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`:
  - aggiunta `resolveIntegrationOrderQueueStation(order, dependencies)`;
  - aggiunta `buildIntegrationOrderQueueOperatorKey(order, dependencies)`;
  - aggiunta `buildIntegrationStationStateQueueOperatorKey(stationState, dependencies)`;
  - aggiunta `buildIntegrationOrderQueueLaneKey(order, dependencies)`.
- `cassa-frontend/backend/server.js`:
  - le funzioni locali `integrationOrderQueueStation()`, `integrationOrderQueueOperatorKey()`, `integrationStationStateQueueOperatorKey()` e `integrationOrderQueueLaneKey()` ora delegano ai nuovi helper;
  - nessuna chiamata interna e nessun contratto endpoint sono stati modificati.
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`:
  - aggiunta copertura sulla priorita' postazione;
  - aggiunta copertura su fallback postazione primaria;
  - aggiunta copertura su chiave operatore ordine/station-state;
  - aggiunta copertura su composizione lane.

Metriche:

- `cassa-frontend/backend/server.js`: 28.527 -> 28.524 righe;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 445 righe;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`: 700 righe;
- nessuna nuova dipendenza;
- nessuna modifica DB o contratto API.

Test V3 eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 19/19;
- `npm run check:backend`: OK;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 6/6;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- il caso continuity 20, intermittente nello step precedente, e' passato in questo ciclo.

Prossimo step consigliato:

- fermare temporaneamente la coda preparazione prima di estrarre funzioni con side effect;
- scegliere una nuova micro-area pura del monolite, oppure creare prima test mirati per `promoteIntegrationOrderToPreparation()` senza spostarla.

## Ciclo V3 - helper attore promozione preparazione

Data ciclo: 2026-06-07 04:15 CEST.

Obiettivo:

- aggiungere copertura e riduzione su un'ultima porzione pura della promozione in preparazione;
- estrarre la risoluzione di attore, owner e lock user senza spostare workflow transition o sanitize;
- mantenere `promoteIntegrationOrderToPreparation()` nel server.

Correzioni applicate:

- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`:
  - aggiunta `resolvePreparationPromotionActor(order, context, dependencies)`;
  - risolve `actorUserId`, `actorUsername`, `lockedByUserId`, `ownerOperator`, `ownerRole`, `ownerAtMs`;
  - supporta `nowMs` iniettato per test deterministici;
  - preserva `ownerAtMs` esistente se valido.
- `cassa-frontend/backend/server.js`:
  - `promoteIntegrationOrderToPreparation()` usa il nuovo helper;
  - restano nel server `sanitizeIntegrationOrder()` e `applyIntegrationWorkflowRouteTransitions()`.
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`:
  - aggiunti test su priorita' dati assegnati;
  - aggiunti test su fallback context/createdBy;
  - aggiunti test su owner/lock fallback e `ownerAtMs`.

Metriche:

- `cassa-frontend/backend/server.js`: 28.524 -> 28.511 righe;
- `cassa-frontend/backend/modules/orders/order-preparation-queue.js`: 475 righe;
- `cassa-frontend/backend/tests/order-preparation-queue.test.mjs`: 766 righe;
- nessuna nuova dipendenza;
- nessuna modifica DB o contratto API.

Test V3 eseguiti:

- `node --check backend/modules/orders/order-preparation-queue.js && node --check backend/server.js && node --test backend/tests/order-preparation-queue.test.mjs`: OK, 21/21;
- `npm run check:backend`: OK;
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs`: OK, 6/6;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run test:security`: primo run KO intermittente `ECONNREFUSED` su test static server, test singolo OK, rerun suite completa OK, 27/27.

Nota su security:

- il primo KO e' stato errore di connessione al processo statico del test, non una failure di asserzione security;
- il test singolo `static server rejects encoded traversal` e' passato;
- il rerun completo di `npm run test:security` e' passato 27/27.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- `promoteIntegrationOrderToPreparation()` resta nel server come limite anti-regressione.

Prossimo step consigliato:

- spostarsi su un'altra area del monolite con funzioni pure gia' identificabili;
- non proseguire sulla promozione preparazione finche' non si decide come estrarre `sanitizeIntegrationOrder()` e route transitions con test dedicati.

## Ciclo V3 - targeting notifiche pickup mobile

Data ciclo: 2026-06-07 04:22 CEST.

Obiettivo:

- cambiare area dopo aver raggiunto il limite sicuro della coda preparazione;
- estrarre dal monolite funzioni pure su notifiche pickup mobile;
- mantenere invariati ack, persistenza notifiche e routing runtime.

Correzioni applicate:

- `cassa-frontend/backend/modules/notifications/notification-targeting.js`:
  - aggiunta `isMobilePickupNotificationForOrder(notification, options)`;
  - aggiunta `removeMobilePickupNotificationsForOrder(notifications, options)`;
  - le funzioni usano la normalizzazione client app gia' presente nel modulo.
- `cassa-frontend/backend/server.js`:
  - rimossi helper locali equivalenti;
  - importato `removeMobilePickupNotificationsForOrder` dal modulo targeting;
  - nessun cambio sul punto d'uso runtime.
- `cassa-frontend/backend/tests/notification-records.test.mjs`:
  - aggiunti test su match per tipo `bell`;
  - aggiunti test su `order_ready`;
  - aggiunti test su `bell_claimed_by_other` via `sourceNotificationId`;
  - aggiunti test su esclusione app non mobile;
  - aggiunti test su rimozione notifiche correlate mantenendo quelle di altri ordini.

Metriche:

- `cassa-frontend/backend/server.js`: 28.511 -> 28.486 righe;
- `cassa-frontend/backend/modules/notifications/notification-targeting.js`: 145 righe;
- `cassa-frontend/backend/tests/notification-records.test.mjs`: 236 righe;
- nessuna nuova dipendenza;
- nessuna modifica DB o contratto API.

Test V3 eseguiti:

- `node --check backend/modules/notifications/notification-targeting.js && node --check backend/server.js && node --test backend/tests/notification-records.test.mjs`: OK, 5/5;
- `npm run check:backend`: OK;
- `node --test backend/tests/notifications-persistence.e2e.test.mjs backend/tests/notifications-priority.e2e.test.mjs backend/tests/waiters-routing.e2e.test.mjs`: OK, 13/13;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- caso continuity 20 pickup passato.

Prossimo step consigliato:

- continuare sulle notifiche con altri helper puri, ad esempio ricerca della notifica bell pendente o costruzione di metadati, solo se isolabili senza DB write;
- mantenere i test `notifications-*` come gate obbligatorio per ogni step notifiche.

## Ciclo V3 - ricerca bell pendente per dedup notifiche

Data ciclo: 2026-06-07 04:27 CEST.

Obiettivo:

- proseguire nell'area notifiche con un helper puro;
- spostare dal monolite la ricerca della notifica `bell` pendente per ordine;
- mantenere invariata la deduplica `queueBellNotification`.

Correzioni applicate:

- `cassa-frontend/backend/modules/notifications/notification-targeting.js`:
  - aggiunta `findPendingBellNotificationByOrderId(integration, orderIdRaw, dependencies)`;
  - usa `sanitizeIntegrationNotification` iniettato;
  - usa `hasBellClaim` iniettato;
  - cerca dalla notifica piu' recente alla piu' vecchia;
  - ignora notifiche non `bell`, ordini diversi e bell gia claimate.
- `cassa-frontend/backend/server.js`:
  - rimossa funzione locale equivalente;
  - `queueBellNotification()` chiama il nuovo helper passando `sanitizeIntegrationNotification` e `findIntegrationBellClaim`.
- `cassa-frontend/backend/tests/notification-records.test.mjs`:
  - aggiunti test su scelta della bell pendente piu' recente;
  - aggiunti test su bell claimata;
  - aggiunti test su input incompleti e adapter mancanti.

Metriche:

- `cassa-frontend/backend/server.js`: 28.486 -> 28.473 righe;
- `cassa-frontend/backend/modules/notifications/notification-targeting.js`: 171 righe;
- `cassa-frontend/backend/tests/notification-records.test.mjs`: 300 righe;
- nessuna nuova dipendenza;
- nessuna modifica DB o contratto API.

Test V3 eseguiti:

- `node --check backend/modules/notifications/notification-targeting.js && node --check backend/server.js && node --test backend/tests/notification-records.test.mjs`: OK, 7/7;
- `npm run check:backend`: OK;
- `node --test backend/tests/notifications-persistence.e2e.test.mjs backend/tests/notifications-priority.e2e.test.mjs backend/tests/waiters-routing.e2e.test.mjs`: OK, 13/13;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- dedup notifiche bell invariata ma ora testata nel modulo.

Prossimo step consigliato:

- valutare un helper puro per preparare payload/metadati bell solo se si riesce a iniettare clock e resolver senza side effect;
- in alternativa proseguire su un'altra piccola area notifiche gia' modulare.

## Ciclo V3 - soppressione notifiche durante pausa cameriere

Data ciclo: 2026-06-07 04:33 CEST.

Obiettivo:

- continuare la riduzione del monolite su un punto deterministico dell'area notifiche;
- spostare fuori da `server.js` la decisione di sopprimere una notifica verso un cameriere in pausa quando esiste un altro cameriere disponibile;
- mantenere nel server solo le dipendenze operative di lettura DB/sessioni.

Correzioni applicate:

- `cassa-frontend/backend/modules/notifications/notification-targeting.js`:
  - aggiunta `waiterIsPausedForNotifications(waiter)`;
  - aggiunta `notificationTargetsPausedWaiter(notification)`;
  - aggiunta `resolveNotificationRoomId(notification, requester)`;
  - aggiunta `hasOtherAvailableWaiterForNotification(db, notification, requester, dependencies)`;
  - aggiunta `shouldSuppressNotificationForWaiterPause(db, notification, requester, requesterUser, dependencies)`;
  - importato `normalizeIntegrationNotificationType` dal modulo record notifiche.
- `cassa-frontend/backend/server.js`:
  - rimosse le funzioni locali equivalenti;
  - `collectActiveWaitersInRoom()` continua a usare `waiterIsPausedForNotifications()`;
  - `handleIntegrationNotificationsPull()` chiama `shouldSuppressNotificationForWaiterPause()` con dipendenze esplicite:
    - `collectActiveWaitersInRoom`;
    - `collectLoggedInWaiters`;
    - `resolveWaiterPauseState`;
    - `INTEGRATION_WAITER_ACTIVE_WINDOW_MS`.
- `cassa-frontend/backend/tests/notification-records.test.mjs`:
  - aggiunti test sul caso cameriere in pausa con alternativa disponibile;
  - aggiunti test su urgenze/force delivery e assenza di altri camerieri disponibili.

Metriche:

- `cassa-frontend/backend/server.js`: 28.473 -> 28.436 righe;
- `cassa-frontend/backend/modules/notifications/notification-targeting.js`: 232 righe;
- `cassa-frontend/backend/tests/notification-records.test.mjs`: 378 righe;
- nessuna nuova dipendenza;
- nessun cambio DB;
- nessun cambio endpoint;
- nessun riavvio.

Test V3 eseguiti:

- `node --check backend/modules/notifications/notification-targeting.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/notification-records.test.mjs`: OK, 9/9;
- `node --test backend/tests/notifications-persistence.e2e.test.mjs backend/tests/notifications-priority.e2e.test.mjs backend/tests/waiters-routing.e2e.test.mjs`: OK, 13/13;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- logica pausa/notifiche ora piu' testabile e meno dispersa nel monolite.

Prossimo step consigliato:

- evitare di estrarre `prepareBellNotificationPayload()` finche' non si isolano prima resolver e clock;
- proseguire con un altro helper puro oppure scegliere un dominio con side effect gia' coperti da test;
- continuare a usare notification e continuity test come gate per ogni ulteriore modifica in questa zona.

## Ciclo V3 - resolver target bell da sessioni mobile attive

Data ciclo: 2026-06-07 04:39 CEST.

Obiettivo:

- proseguire la riduzione del monolite sulle notifiche;
- spostare fuori da `server.js` la risoluzione del target cameriere da hint testuale e sessioni mobile attive;
- rimuovere una funzione bell per sala non piu' referenziata dal progetto.

Correzioni applicate:

- `cassa-frontend/backend/modules/notifications/notification-targeting.js`:
  - aggiunta `waiterHintMatchesUser(waiterHint, user)`;
  - aggiunta `resolveBellTargetFromActiveSessions(db, waiterHint, options)`;
  - aggiunto parsing timestamp locale al modulo per rendere il resolver autonomo;
  - il resolver accetta `nowMs` e `activeWindowMs` per test deterministici e per evitare logiche temporali nascoste.
- `cassa-frontend/backend/server.js`:
  - rimossa funzione locale `waiterHintMatchesUser`;
  - rimossa funzione locale `resolveBellTargetFromActiveSessions`;
  - rimossa funzione locale non referenziata `resolveBellTargetFromRoomActiveSessions`;
  - `prepareBellNotificationPayload()` ora usa il resolver modulare passando `INTEGRATION_WAITER_ACTIVE_WINDOW_MS`.
- `cassa-frontend/backend/tests/notification-records.test.mjs`:
  - aggiunti test su match per username, nome completo e primo nome;
  - aggiunti test sulla scelta della sessione mobile piu' recente;
  - aggiunti test su sessioni stale, non-mobile e hint vuoto.

Metriche:

- `cassa-frontend/backend/server.js`: 28.436 -> 28.330 righe;
- `cassa-frontend/backend/modules/notifications/notification-targeting.js`: 299 righe;
- `cassa-frontend/backend/tests/notification-records.test.mjs`: 452 righe;
- riduzione netta fase: 106 righe dal monolite;
- nessuna nuova dipendenza;
- nessun cambio DB;
- nessun cambio endpoint;
- nessun riavvio.

Test V3 eseguiti:

- `node --check backend/modules/notifications/notification-targeting.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/notification-records.test.mjs`: OK, 11/11;
- `node --test backend/tests/notifications-persistence.e2e.test.mjs backend/tests/notifications-priority.e2e.test.mjs backend/tests/waiters-routing.e2e.test.mjs`: OK, 13/13;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- target bell da sessioni attive ora coperto da test unitari e protetto da e2e notifiche/continuity.

Prossimo step consigliato:

- valutare se isolare sotto-helper di `prepareBellNotificationPayload()` senza spostare l'handler completo;
- se l'accoppiamento DB diventa troppo alto, cambiare area e proseguire con helper puri gia' identificati;
- mantenere continuity come gate obbligatorio dopo ogni rimozione di funzioni dal monolite.

## Ciclo V3 - escalation notifiche bell mirate

Data ciclo: 2026-06-07 04:44 CEST.

Obiettivo:

- proseguire la riduzione del monolite sull'area notifiche;
- spostare nel modulo notifiche la transizione locale `bell target personale/sala -> bell a tutti`;
- rendere testabile il timeout di escalation senza dipendere da `Date.now()` implicito nel monolite.

Correzioni applicate:

- `cassa-frontend/backend/modules/notifications/notification-targeting.js`:
  - aggiunta `maybeEscalateBellNotification(notification, options)`;
  - supporta `nowMs` per test deterministici;
  - supporta `defaultTargetTimeoutMs` per mantenere `BELL_TARGET_TIMEOUT_MS` fuori dal modulo;
  - preserva `originalWaiter` se presente;
  - rimuove target personali/sala/stazione quando l'escalation scatta;
  - imposta `targetClientApp = "mobile-frontend"` ed `escalatedToAllAtMs`.
- `cassa-frontend/backend/server.js`:
  - rimossa funzione locale `maybeEscalateBellNotification`;
  - `handleIntegrationNotificationsPull()` usa il modulo passando `BELL_TARGET_TIMEOUT_MS`.
- `cassa-frontend/backend/tests/notification-records.test.mjs`:
  - aggiunti test su escalation solo dopo timeout;
  - aggiunti test su bell gia' ackata;
  - aggiunti test su bell senza target e notifiche non bell.

Metriche:

- `cassa-frontend/backend/server.js`: 28.330 -> 28.296 righe;
- `cassa-frontend/backend/modules/notifications/notification-targeting.js`: 348 righe;
- `cassa-frontend/backend/tests/notification-records.test.mjs`: 536 righe;
- riduzione netta fase: 34 righe dal monolite;
- nessuna nuova dipendenza;
- nessun cambio DB;
- nessun cambio endpoint;
- nessun riavvio.

Test V3 eseguiti:

- `node --check backend/modules/notifications/notification-targeting.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/notification-records.test.mjs`: OK, 13/13;
- `node --test backend/tests/notifications-persistence.e2e.test.mjs backend/tests/notifications-priority.e2e.test.mjs backend/tests/waiters-routing.e2e.test.mjs`: OK, 13/13;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- escalation bell ora coperta da test unitari e da continuity caso pickup.

Prossimo step consigliato:

- valutare una pausa tecnica sull'area notifiche: `prepareBellNotificationPayload()` e `resolveBellNotificationContext()` sono piu' accoppiati al DB e alle comande;
- prossimo taglio preferibile: helper puro in altro dominio o ulteriore sotto-helper bell solo se le dipendenze restano esplicite;
- mantenere gate completi per evitare regressioni su chiamate camerieri, pickup e notifica a tutti.

## Ciclo V3 - marker varianti riga ordine

Data ciclo: 2026-06-07 04:53 CEST.

Obiettivo:

- proseguire la riduzione del monolite fuori dall'area notifiche;
- estrarre una funzione pura del dominio righe ordine;
- mantenere invariati prezzi, varianti premium, supplementi e routing postazioni.

Correzioni applicate:

- `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`:
  - creato nuovo modulo domain;
  - spostata `collectIntegrationVariantMarkers(line)`;
  - la funzione conserva il comportamento legacy, incluso il fatto che alcune chiavi come `id`, `name`, `label`, `key`, `value` possono entrare nei marker.
- `cassa-frontend/backend/server.js`:
  - rimossa la funzione locale `collectIntegrationVariantMarkers`;
  - importata la funzione dal nuovo modulo.
- `cassa-frontend/backend/tests/integration-order-line-variants-domain.test.mjs`:
  - aggiunti test su marker diretti e alias legacy;
  - aggiunti test su oggetti annidati, array e flag booleani;
  - aggiunti test su deduplica e valori vuoti.
- `cassa-frontend/backend/tests/listino-time-pricing.e2e.test.mjs`:
  - aggiornato il setup `installListinoPrinterConfig()` con `activities`, `activityRoomBindings` e workstation coerente;
  - il test LISTINO-16 non usa piu' una configurazione legacy incompleta per la stampa preconto;
  - nessun fallback stampanti/RT e' stato reintrodotto.

Metriche:

- `cassa-frontend/backend/server.js`: 28.296 -> 28.254 righe;
- `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`: 42 righe;
- `cassa-frontend/backend/tests/integration-order-line-variants-domain.test.mjs`: 63 righe;
- riduzione netta fase: 42 righe dal monolite;
- nessuna nuova dipendenza;
- nessun cambio DB;
- nessun cambio endpoint;
- nessun riavvio.

Test V3 eseguiti:

- `node --check backend/modules/integration/order-line-variants.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs`: OK, 3/3;
- `node --test --test-name-pattern "LISTINO-16" backend/tests/listino-time-pricing.e2e.test.mjs`: OK, 1/1;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/listino-time-pricing.e2e.test.mjs backend/tests/menu-domain.test.mjs backend/tests/menu-routing-domain.test.mjs`: OK, 42/42;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- logica marker varianti/supplementi ora isolata e testata;
- test listino aggiornato alla gerarchia reale attivita' -> sala -> stampanti, senza fallback.

Prossimo step consigliato:

- proseguire nel dominio righe ordine solo con helper puri;
- evitare per ora estrazioni che richiedono `HttpError`, prezzo runtime o persistenza;
- valutare il prossimo candidato tra helper piccoli di prezzo/riga con dipendenze iniettate.

## Ciclo V3 - delta variante esplicito riga ordine

Data ciclo: 2026-06-07 04:57 CEST.

Obiettivo:

- proseguire la decomposizione del dominio righe ordine;
- spostare dal monolite la lettura del delta variante esplicito;
- mantenere invariati listini a orario, supplementi, varianti premium e routing.

Correzioni applicate:

- `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`:
  - aggiunta `readIntegrationVariantDeltaCandidate(value)`;
  - aggiunta `resolveIntegrationLineExplicitVariantDelta(line)`;
  - aggiunti helper privati per parsing e arrotondamento coerenti con il comportamento legacy.
- `cassa-frontend/backend/server.js`:
  - rimosse le funzioni locali `readIntegrationVariantDeltaCandidate` e `resolveIntegrationLineExplicitVariantDelta`;
  - importate le funzioni dal modulo domain.
- `cassa-frontend/backend/tests/integration-order-line-variants-domain.test.mjs`:
  - aggiunti test su parsing euro/stringhe;
  - aggiunti test su valori nulli/negativi;
  - aggiunti test su delta diretto;
  - aggiunti test su `selectedVariant`, `selected_variant`, `variants` oggetto e array.

Metriche:

- `cassa-frontend/backend/server.js`: 28.254 -> 28.205 righe;
- `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`: 112 righe;
- `cassa-frontend/backend/tests/integration-order-line-variants-domain.test.mjs`: 124 righe;
- riduzione netta fase: 49 righe dal monolite;
- nessuna nuova dipendenza;
- nessun cambio DB;
- nessun cambio endpoint;
- nessun riavvio.

Test V3 eseguiti:

- `node --check backend/modules/integration/order-line-variants.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs`: OK, 6/6;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/listino-time-pricing.e2e.test.mjs backend/tests/menu-domain.test.mjs backend/tests/menu-routing-domain.test.mjs`: OK, 45/45;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- dominio varianti riga ordine ora copre marker e delta esplicito.

Prossimo step consigliato:

- valutare `resolveIntegrationLineSupplementMarkerDelta`, che sembra ancora piccolo e puro;
- procedere solo se i test possono coprire supplemento da note/descrizione e parsing `+N`;
- evitare ancora `assertIntegrationLineVariantSelection` finche' resta accoppiata a `HttpError`.

## Ciclo V3 - supplemento da marker riga ordine

Data ciclo: 2026-06-07 05:12 CEST.

Obiettivo:

- continuare la riduzione del monolite nel dominio righe ordine;
- estrarre la lettura del supplemento testuale `+N` da marker, note e descrizione;
- mantenere invariati supplementi, varianti premium, listino runtime e routing.

Correzioni applicate:

- `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`:
  - aggiunta `resolveIntegrationLineSupplementMarkerDelta(line)`;
  - la funzione usa `collectIntegrationVariantMarkers(line)` piu' `note`, `notes`, `description`;
  - parsing mantenuto su pattern `+ numero`, con virgola o punto decimale;
  - arrotondamento locale coerente con il resto del modulo.
- `cassa-frontend/backend/server.js`:
  - rimossa la funzione locale `resolveIntegrationLineSupplementMarkerDelta`;
  - importata la funzione dal modulo domain.
- `cassa-frontend/backend/tests/integration-order-line-variants-domain.test.mjs`:
  - aggiunti test supplemento da marker variante;
  - aggiunti test supplemento da note e descrizione;
  - aggiunti test per non inventare supplementi senza segno `+`.

Metriche:

- `cassa-frontend/backend/server.js`: 28.205 -> 28.194 righe;
- `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`: 124 righe;
- `cassa-frontend/backend/tests/integration-order-line-variants-domain.test.mjs`: 161 righe;
- riduzione netta fase: 11 righe dal monolite;
- nessuna nuova dipendenza;
- nessun cambio DB;
- nessun cambio endpoint;
- nessun riavvio.

Test V3 eseguiti:

- `node --check backend/modules/integration/order-line-variants.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs`: OK, 9/9;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/listino-time-pricing.e2e.test.mjs backend/tests/menu-domain.test.mjs backend/tests/menu-routing-domain.test.mjs`: OK, 48/48;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- dominio varianti riga ordine ora copre marker, delta esplicito e supplemento marker.

Prossimo step consigliato:

- prossimo candidato possibile: sotto-helper di matching variante menu, ma richiede spostare anche lookup key/normalizzazione o usare dependency injection;
- evitare ancora estrazioni che coinvolgono `HttpError` e validazione obbligatoria premium;
- preferire piccoli helper puri con test domain prima di toccare funzioni prezzo/routing piu' composte.

## Ciclo V3 - applicazione delta variante al prezzo base

Data ciclo: 2026-06-07 05:17 CEST.

Obiettivo:

- proseguire la riduzione del monolite nel dominio righe ordine;
- estrarre la logica che decide se applicare il delta variante al prezzo base;
- mantenere invariato il comportamento legacy: `variantDelta` deve essere gia' numerico in questa funzione.

Correzioni applicate:

- `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`:
  - aggiunta `applyIntegrationVariantDeltaToBasePrice(basePrice, menuBasePrice, variantDelta)`;
  - la funzione non raddoppia un prezzo gia' premium;
  - la funzione aggiunge il delta solo quando il prezzo base corrisponde al prezzo menu;
  - la funzione non inventa importi se base/delta/menu base non sono validi.
- `cassa-frontend/backend/server.js`:
  - rimossa la funzione locale `applyIntegrationVariantDeltaToBasePrice`;
  - importata la funzione dal modulo domain.
- `cassa-frontend/backend/tests/integration-order-line-variants-domain.test.mjs`:
  - aggiunti test su applicazione delta al prezzo base;
  - aggiunti test su prezzo gia' premium;
  - aggiunti test su base/delta invalidi;
  - corretto test per rispettare il comportamento legacy: delta variante stringa con virgola non viene parseato in questa funzione.

Metriche:

- `cassa-frontend/backend/server.js`: 28.194 -> 28.184 righe;
- `cassa-frontend/backend/modules/integration/order-line-variants.domain.js`: 135 righe;
- `cassa-frontend/backend/tests/integration-order-line-variants-domain.test.mjs`: 178 righe;
- riduzione netta fase: 10 righe dal monolite;
- nessuna nuova dipendenza;
- nessun cambio DB;
- nessun cambio endpoint;
- nessun riavvio.

Test V3 eseguiti:

- `node --check backend/modules/integration/order-line-variants.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs`: OK, 12/12;
- `node --test backend/tests/integration-order-line-variants-domain.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/listino-time-pricing.e2e.test.mjs backend/tests/menu-domain.test.mjs backend/tests/menu-routing-domain.test.mjs`: OK, 51/51;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69.

Stato:

- slice completata;
- V2/current non toccata;
- nessun riavvio;
- dominio varianti riga ordine copre ora marker, delta esplicito, supplemento marker e applicazione delta al prezzo base.

Prossimo step consigliato:

- fermarsi prima di funzioni premium con `HttpError`;
- valutare una factory di matching variante menu con lookup helpers iniettati, solo se il guadagno giustifica la complessita';
- possibile alternativa: cambiare area e cercare altri helper puri meno accoppiati.

## Ciclo V3 - dominio prenotazioni multi-tavolo

Data ciclo: 2026-06-07 05:52 CEST.

Ambito:

- V3 soltanto;
- V2/current non modificata;
- nessun riavvio;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o servizi live.

Correzioni applicate:

- creato `cassa-frontend/backend/modules/reservations/reservations.domain.js`;
- spostate dal monolite le funzioni pure:
  - `normalizePosReservationTableIds`;
  - `posReservationAssignedTableIds`;
  - `posReservationIncludesTable`;
- aggiornato `cassa-frontend/backend/server.js` per importare gli helper dal dominio;
- aggiornato `cassa-frontend/backend/modules/reservations/index.js` per riesportare gli helper;
- aggiunto `cassa-frontend/backend/tests/reservations-domain.test.mjs`;
- aggiornato il test statico multi-tavolo per proteggere il nuovo modulo, non la posizione legacy nel monolite.

Comportamento preservato:

- deduplica ID tavolo case-insensitive durante normalizzazione;
- fallback da `assignedTableId`;
- limite 64 caratteri per ID;
- limite 24 tavoli per prenotazione;
- inclusione tavolo con match esatto dopo trim input.

Metriche:

- `cassa-frontend/backend/server.js`: 27.684 -> 27.658 righe;
- riduzione netta ciclo: 26 righe;
- `reservations.domain.js`: 30 righe;
- `reservations-domain.test.mjs`: 43 righe.

Test eseguiti:

- `node --check backend/modules/reservations/reservations.domain.js`: OK;
- `node --check backend/server.js`: OK;
- `node --test backend/tests/reservations-domain.test.mjs backend/tests/reservations-multi-table-static.test.mjs`: OK, 8/8;
- `node --test backend/tests/reservations-status.e2e.test.mjs backend/tests/continuity.e2e.test.mjs`: OK, 71/71;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Rischi residui:

- le funzioni di attivazione prenotazioni e rilascio gruppi tavolo restano nel monolite perche' hanno side effect su DB/layout;
- la prossima estrazione sulle prenotazioni deve restare limitata a distanza/label o altri helper puri.

Prossimo step consigliato:

- estrarre eventualmente `classifyPosReservationDistance`, `posClockFromTimestamp` e `buildPosAvailabilityLabel` con factory/config, ma solo dopo test domain mirati;
- non toccare handler prenotazioni o attivazione automatica senza continuity completa.

## Ciclo V3 - disponibilita prenotazioni

Data ciclo: 2026-06-07 06:02 CEST.

Ambito:

- V3 soltanto;
- V2/current non modificata;
- nessun riavvio;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o servizi live.

Correzioni applicate:

- esteso `cassa-frontend/backend/modules/reservations/reservations.domain.js`;
- aggiunta factory `createPosReservationAvailabilityHelpers`;
- spostate dal monolite le funzioni pure:
  - `classifyPosReservationDistance`;
  - `posClockFromTimestamp`;
  - `findPosNearestReservation`;
  - `buildPosAvailabilityLabel`;
- aggiornato `cassa-frontend/backend/server.js` per creare gli helper con le soglie esistenti;
- aggiornato `cassa-frontend/backend/modules/reservations/index.js`;
- ampliato `cassa-frontend/backend/tests/reservations-domain.test.mjs`.

Comportamento preservato:

- soglie conflitto/danger/warning identiche al server;
- label disponibilita identiche;
- orario formattato come `HH:mm`;
- ricerca nearest reservation filtrata per tavolo e `ignoreReservationId`;
- nessun cambio alle routine che attivano o rilasciano tavoli prenotati.

Metriche:

- `cassa-frontend/backend/server.js`: 27.658 -> 27.626 righe;
- riduzione netta ciclo: 32 righe;
- `reservations.domain.js`: 30 -> 94 righe;
- `reservations-domain.test.mjs`: 43 -> 100 righe.

Test eseguiti:

- `node --check backend/modules/reservations/reservations.domain.js && node --check backend/modules/reservations/index.js && node --check backend/server.js`: OK;
- `node --test backend/tests/reservations-domain.test.mjs backend/tests/reservations-multi-table-static.test.mjs`: OK, 12/12;
- `node --test backend/tests/reservations-status.e2e.test.mjs backend/tests/continuity.e2e.test.mjs`: OK, 71/71;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Rischi residui:

- `normalizePosReservationSaveInput` resta nel monolite perche' accoppiata a `HttpError` e validazioni richiesta;
- attivazione automatica prenotazioni e rilascio gruppi tavolo restano nel monolite per side effect su DB/layout;
- eventuale prossimo step deve mantenere continuity obbligatoria.

Prossimo step consigliato:

- estrarre solo helper puri di stato prenotazione (`shouldActivatePosReservation`, `isPosReservationReleased`) se il perimetro resta piccolo;
- evitare handler e mutazioni DB nel prossimo ciclo.

## Ciclo V3 - stato prenotazioni

Data ciclo: 2026-06-07 06:01 CEST.

Check di allineamento:

- working directory confermata: `/srv/applicazione/v3`;
- V2/current non modificata;
- nessun riavvio;
- memoria V3 allineata alla Fase 5B precedente;
- monolite prima dello step: `cassa-frontend/backend/server.js` a 27.626 righe.

Ambito:

- V3 soltanto;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o servizi live;
- estrazione limitata a helper puri di stato prenotazione.

Correzioni applicate:

- esteso `cassa-frontend/backend/modules/reservations/reservations.domain.js`;
- aggiunta factory `createPosReservationStateHelpers`;
- spostate dal monolite le funzioni pure:
  - `shouldActivatePosReservation`;
  - `isPosReservationReleased`;
- aggiornato `cassa-frontend/backend/server.js` per creare gli helper con:
  - `POS_RESERVATION_BLOCK_WINDOW_MS`;
  - `POS_RESERVATION_LATE_GRACE_MS`;
- aggiornato `cassa-frontend/backend/modules/reservations/index.js`;
- ampliato `cassa-frontend/backend/tests/reservations-domain.test.mjs`.

Comportamento preservato:

- attivazione prenotazione valida entro 30 minuti prima e 30 minuti dopo;
- input orario non numerico non attiva la prenotazione;
- stati terminali riconosciuti:
  - `arrived`;
  - `no_show`;
  - `cancelled`;
  - `released`;
- `releasedAt > 0` continua a rendere la prenotazione rilasciata.

Metriche:

- `cassa-frontend/backend/server.js`: 27.626 -> 27.617 righe;
- riduzione netta ciclo: 9 righe;
- `reservations.domain.js`: 94 -> 125 righe;
- `reservations-domain.test.mjs`: 100 -> 127 righe.

Test eseguiti:

- `node --check backend/modules/reservations/reservations.domain.js && node --check backend/modules/reservations/index.js && node --check backend/server.js`: OK;
- `node --test backend/tests/reservations-domain.test.mjs backend/tests/reservations-multi-table-static.test.mjs`: OK, 14/14;
- `node --test backend/tests/reservations-status.e2e.test.mjs backend/tests/continuity.e2e.test.mjs`: OK, 71/71;
- `npm run check:backend`: OK;
- `npm run test:security`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Rischi residui:

- `normalizePosReservationSaveInput` resta nel monolite perche' e' accoppiata a validazioni richiesta e `HttpError`;
- `activateDuePosReservationsOnLayout` e `releaseActivatedPosReservationTableGroup` restano nel monolite perche' modificano DB/layout/gruppi tavolo;
- prima di estrarre altro sulle prenotazioni servono test state-machine dedicati o una factory domain con dipendenze esplicite.

Prossimo step consigliato:

- fermare le estrazioni pure sulle prenotazioni qui, oppure creare prima test specifici per attivazione/rilascio gruppi tavolo;
- valutare un cambio area verso helper puri di lock tavolo o table-room move;
- mantenere continuity obbligatoria se si toccano tavoli, gruppi o prenotazioni.

## Ciclo V3 - dominio lock tavolo

Data ciclo: 2026-06-07 06:08 CEST.

Ambito:

- V3 soltanto;
- V2/current non modificata;
- nessun riavvio;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o servizi live;
- estrazione limitata al dominio puro/semi-puro dei lock tavolo.

Correzioni applicate:

- creato `cassa-frontend/backend/modules/tables/table-work-lock.domain.js`;
- creato `cassa-frontend/backend/modules/tables/index.js`;
- aggiunta factory `createTableWorkLockHelpers`;
- spostate dal monolite le funzioni:
  - `sanitizeTableWorkLock`;
  - `isTableWorkLockExpired`;
  - `isSameTableLockOwner`;
  - `canOverrideTableWorkLock`;
  - `buildTableWorkLock`;
  - `shouldReuseRecentTableWorkLock`;
- aggiornato `cassa-frontend/backend/server.js` per usare la factory con dipendenze esplicite:
  - `hasPermission`;
  - `isAdminUser`;
  - `nowIso`;
  - `TABLE_LOCK_TTL_MS`;
  - `TABLE_LOCK_HEARTBEAT_WRITE_MIN_INTERVAL_MS`;
- aggiunto `cassa-frontend/backend/tests/table-work-lock-domain.test.mjs`.

Nota di verifica:

- il primo test domain ha evidenziato che `buildTableWorkLock` usava `Date.now()` non iniettabile;
- la factory ora accetta `nowMs`, con default runtime a `Date.now()`;
- questo migliora la testabilita' senza cambiare comportamento runtime.

Metriche:

- `cassa-frontend/backend/server.js`: 27.617 -> 27.558 righe;
- riduzione netta ciclo: 59 righe;
- `table-work-lock.domain.js`: 96 righe;
- `table-work-lock-domain.test.mjs`: 111 righe.

Test eseguiti:

- `node --check backend/modules/tables/table-work-lock.domain.js && node --check backend/modules/tables/index.js && node --check backend/server.js`: OK;
- `node --test backend/tests/table-work-lock-domain.test.mjs backend/tests/tables-locks.e2e.test.mjs`: OK, 10/10;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Rischi residui:

- `acquireOrRefreshTableWorkLock`, `assertActiveTableWorkLock` e `releaseTableWorkLock` restano nel monolite perche' mutano DB, audit e impostazioni tavolo;
- il prossimo step sui lock dovrebbe estrarre service solo con repository/mock e test P0, oppure cambiare area.

Prossimo step consigliato:

- valutare helper puri del table-room move, in particolare record sanitization/response, senza cambiare policy timeout;
- alternativa: creare test state-machine dedicati per table-room move prima di estrarre ulteriori funzioni.

## Ciclo V3 - dominio cambio sala tavolo

Data ciclo: 2026-06-07 06:16 CEST.

Ambito:

- V3 soltanto;
- V2/current non modificata;
- nessun riavvio;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o servizi live;
- estrazione limitata a normalizzazione/risposta/resolve richiesta cambio sala tavolo.

Correzioni applicate:

- creato `cassa-frontend/backend/modules/table-room-move/table-room-move.domain.js`;
- creato `cassa-frontend/backend/modules/table-room-move/index.js`;
- aggiunta costante esplicita `AUTO_APPROVE_TABLE_ROOM_MOVE_ON_TIMEOUT = true`;
- aggiunta factory `createTableRoomMoveHelpers`;
- spostate dal monolite le funzioni:
  - `sanitizePosTableRoomMoveRequestRecord`;
  - `buildPosTableRoomMoveResponse`;
  - `resolvePendingPosTableRoomMoveRequest`;
- aggiornato `cassa-frontend/backend/server.js` per usare la factory con `POS_TABLE_ROOM_MOVE_APPROVAL_TIMEOUT_MS`;
- aggiunto `cassa-frontend/backend/tests/table-room-move-domain.test.mjs`.

Policy documentata/testata:

- il comportamento attuale `pending -> timeout_approved` resta invariato;
- la transizione timeout resta auto-approvata quando il richiedente controlla lo stato dopo scadenza;
- la policy e' ora esplicita con `AUTO_APPROVE_TABLE_ROOM_MOVE_ON_TIMEOUT`.

Metriche:

- `cassa-frontend/backend/server.js`: 27.558 -> 27.467 righe;
- riduzione netta ciclo: 91 righe;
- `table-room-move.domain.js`: 138 righe;
- `table-room-move-domain.test.mjs`: 120 righe.

Test eseguiti:

- `node --check backend/modules/table-room-move/table-room-move.domain.js && node --check backend/modules/table-room-move/index.js && node --check backend/server.js`: OK;
- `node --test backend/tests/table-room-move-domain.test.mjs backend/tests/waiters-routing.e2e.test.mjs`: OK, 12/12;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Rischi residui:

- gli handler HTTP cambio sala tavolo restano nel monolite perche' validano sessione, leggono/scrivono DB e inviano notifiche;
- la policy `timeout_approved` e' ancora business-risk P2, ma ora e' esplicita e coperta da test;
- se si vorra' cambiare verso `expired` o `timeout_rejected`, serve decisione funzionale e test client.

Prossimo step consigliato:

- fermarsi prima degli handler table-room move;
- candidato successivo: helper puri di risposta/notifiche, oppure cambiare area verso domini ordini/state-machine gia' testati;
- mantenere e2e waiters-routing e continuity obbligatori se si toccano notifiche/cambio sala.

## Ciclo V3 - notifiche cambio sala tavolo

Data ciclo: 2026-06-07 06:27 CEST.

Ambito:

- V3 soltanto;
- V2/current non modificata;
- nessun riavvio;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o servizi live;
- estrazione limitata al builder puro dei payload notifica table-room move.

Correzioni applicate:

- esteso `cassa-frontend/backend/modules/table-room-move/table-room-move.domain.js`;
- aggiunta funzione `buildPosTableRoomMoveNotificationPayload`;
- `queuePosTableRoomMoveNotification` resta nel monolite come wrapper side-effect che chiama `queueIntegrationNotification`;
- aggiunti test dedicati in `cassa-frontend/backend/tests/table-room-move-domain.test.mjs`.

Comportamento preservato:

- notifica richiesta:
  - `eventType: table_room_move_request`;
  - target sala destinazione;
  - dati richiedente/tavoli;
- notifica timeout:
  - `eventType: table_room_move_timeout`;
  - testo di spostamento automatico;
- notifica risolta:
  - `table_room_move_approved` o `table_room_move_rejected`;
  - target all'utente/device richiedente.

Metriche:

- `cassa-frontend/backend/server.js`: 27.467 -> 27.415 righe;
- riduzione netta ciclo: 52 righe;
- `table-room-move.domain.js`: 138 -> 197 righe;
- `table-room-move-domain.test.mjs`: 120 -> 171 righe.

Test eseguiti:

- `node --check backend/modules/table-room-move/table-room-move.domain.js && node --check backend/server.js`: OK;
- `node --test backend/tests/table-room-move-domain.test.mjs backend/tests/waiters-routing.e2e.test.mjs`: OK, 15/15;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Rischi residui:

- `queuePosTableRoomMoveNotification` resta nel monolite perche' contiene il side effect di accodamento notifica;
- handler HTTP e stream refresh restano nel monolite;
- se si prosegue sulle notifiche, serve mantenere `waiters-routing.e2e` e `continuity.e2e`.

Prossimo step consigliato:

- fermare per ora table-room move prima degli handler;
- valutare estrazione di helper puri ordini o notifiche generiche gia' coperte da test;
- evitare spostamento di side effect senza service/repository dedicato.

## Ciclo V3 - state machine workflow ordini base

Data ciclo: 2026-06-07 06:35 CEST.

Ambito:

- V3 soltanto;
- V2/current non modificata;
- nessun riavvio;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o servizi live;
- estrazione limitata a rank/regressione/transizione workflow ordini.

Correzioni applicate:

- creato `cassa-frontend/backend/modules/orders/order-state-machine.js`;
- aggiunta factory `createIntegrationWorkflowStateMachine`;
- spostate dal monolite le funzioni:
  - `resolveIntegrationWorkflowRank`;
  - `isIntegrationWorkflowRegression`;
  - `assertIntegrationWorkflowTransitionAllowed`;
- aggiunto helper puro `getIntegrationWorkflowTransitionViolation`;
- `server.js` inietta una factory errore che produce ancora `HttpError(409)`.

Comportamento preservato:

- rank workflow:
  - `waiting = 0`;
  - `prep = 1`;
  - `ready = 2`;
  - `delivered = 3`;
- regressioni note continuano a essere bloccate;
- transizioni sconosciute restano ignorate come prima;
- escape hatch `allowPreparationDemotion` preservata solo per `prep -> waiting`;
- codice errore invariato: `INVALID_ORDER_STATUS_TRANSITION`.

Metriche:

- `cassa-frontend/backend/server.js`: 27.415 -> 27.384 righe;
- riduzione netta ciclo: 31 righe;
- `order-state-machine.js`: 74 righe;
- `order-state-machine.test.mjs`: 78 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-state-machine.js && node --check backend/server.js`: OK;
- `node --test backend/tests/order-state-machine.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 26/26;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Rischi residui:

- `normalizeIntegrationWorkflowStatus` resta nel monolite perche' dipende da progressi item/route e va estratta con test piu' ampi;
- update route/eventi workflow resta nel monolite perche' modifica dati e audit;
- prima di spostare handler ordini serve service/repository dedicato.

Prossimo step consigliato:

- prossimo micro-step possibile: estrarre helper puri di timestamp/progresso route workflow (`hasIntegrationRouteTimestamp`, `hasIntegrationRouteReadyProgress`) se coperti da test;
- in alternativa aggiungere test mirati prima di estrarre `normalizeIntegrationWorkflowStatus`;
- mantenere invariants ordini/pagamenti e continuity obbligatori.

## Ciclo V3 - state machine workflow ordini route progress

Data ciclo: 2026-06-07 12:30 CEST.

Ambito:

- V3 soltanto;
- V2/current non modificata;
- nessun riavvio;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o servizi live;
- estrazione limitata a helper puri di lettura progresso route workflow ordini.

Correzioni applicate:

- aggiornato `cassa-frontend/backend/modules/orders/order-state-machine.js`;
- spostate dal monolite le funzioni:
  - `hasIntegrationRouteTimestamp`;
  - `hasIntegrationRouteReadyProgress`;
- aggiunti test domain per timestamp route e progresso ready/delivered/pickedUp;
- `server.js` ora importa questi helper dal modulo ordini.

Comportamento preservato:

- conta come timestamp valido solo una stringa non vuota;
- `receivedAt` non e' considerato progresso ready;
- il progresso route ready resta vero per:
  - `readyAt`;
  - `deliveredAt`;
  - `pickedUpAt`;
- nessuna modifica ai contratti API o agli stati ordine.

Metriche:

- `cassa-frontend/backend/server.js`: 27.384 -> 27.371 righe;
- riduzione netta ciclo: 13 righe;
- `order-state-machine.js`: 74 -> 93 righe;
- `order-state-machine.test.mjs`: 78 -> 95 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-state-machine.js && node --check backend/server.js`: OK;
- `node --test backend/tests/order-state-machine.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 28/28;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Rischi residui:

- `normalizeIntegrationWorkflowStatus` resta nel monolite perche' contiene normalizzazione + inferenza da item/route progress;
- le mutazioni su route/eventi workflow restano nel monolite;
- prima di estrarre altro workflow serve continuare a proteggere con `orders-flow`, `orders-payments-invariants`, `security` e `continuity`.

Prossimo step consigliato:

- aggiungere test dedicati a `normalizeIntegrationWorkflowStatus` prima di spostarla;
- in alternativa estrarre un altro helper puro gia' ben coperto senza side effect;
- evitare spostamento handler ordini fino a quando state machine e domain non sono completamente isolati.

## Ciclo V3 - state machine workflow ordini normalizzazione

Data ciclo: 2026-06-07 12:36 CEST.

Ambito:

- V3 soltanto;
- V2/current non modificata;
- nessun riavvio;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o servizi live;
- estrazione limitata alla normalizzazione pura dello stato workflow ordini.

Correzioni applicate:

- aggiornato `cassa-frontend/backend/modules/orders/order-state-machine.js`;
- spostate dal monolite le funzioni:
  - `isCancelledIntegrationWorkflowStatus`;
  - `normalizeIntegrationWorkflowStatus`;
- `server.js` ora importa la normalizzazione dal modulo state-machine ordini;
- aggiunti test domain su:
  - alias cancellazione;
  - alias delivered/ready/prep;
  - progressi articoli;
  - progressi route;
  - inferenza terminale da `completedAtMs`.

Comportamento preservato:

- `annullata`, `cancelled`, `voided` restano `cancelled`;
- `pagata`, `paid`, `done`, `consegnato`, `delivered` restano `delivered`;
- `pronta`, `pronto`, `ready`, `da consegnare`, `da_consegnare` restano `ready`;
- un progresso parziale articoli/route o `ownerStation` porta a `prep`;
- tutti gli articoli pronti o tutte le route pronte portano a `ready`;
- `completedAtMs !== null` continua a portare a `delivered`, incluso `0`, per non cambiare semantica in questo ciclo.

Metriche:

- `cassa-frontend/backend/server.js`: 27.371 -> 27.321 righe;
- riduzione netta ciclo: 50 righe;
- `order-state-machine.js`: 93 -> 148 righe;
- `order-state-machine.test.mjs`: 95 -> 160 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-state-machine.js && node --check backend/server.js`: OK;
- `node --test backend/tests/order-state-machine.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 33/33;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Rischi residui:

- l'inferenza `completedAtMs !== null` e' stata preservata, ma va rivalutata in un ciclo dedicato per capire se `undefined` debba davvero implicare delivered;
- le mutazioni di workflow, audit e route restano nel monolite;
- `sanitizeIntegrationOrder` resta nel monolite e usa la state machine estratta, ma contiene ancora molte responsabilita' miste.

Prossimo step consigliato:

- aggiungere test mirati su `sanitizeIntegrationOrder` prima di estrarre ulteriori pezzi;
- valutare estrazione di un piccolo helper puro collegato a ready/completed timestamps;
- evitare modifiche semantiche su `completedAtMs` senza prima verificare i dati reali e i test e2e.

## Ciclo V3 - domain timestamp ordini

Data ciclo: 2026-06-07 12:43 CEST.

Ambito:

- V3 soltanto;
- V2/current non modificata;
- nessun riavvio;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o servizi live;
- estrazione limitata a helper puro di normalizzazione timestamp ordine.

Correzioni applicate:

- creato `cassa-frontend/backend/modules/orders/order-timestamps.js`;
- spostata dal monolite la funzione:
  - `normalizeIntegrationOrderTimestamp`;
- `server.js` ora importa l'helper dal modulo ordini;
- aggiunto `cassa-frontend/backend/tests/order-timestamps.test.mjs`.

Comportamento preservato:

- stringhe data parsabili vengono normalizzate in ISO;
- stringhe non parsabili non vuote vengono preservate trim;
- numeri epoch millisecondi positivi vengono convertiti in ISO;
- stringhe numeriche vengono preservate come stringhe per compatibilita' legacy;
- valori vuoti, zero, negativi, non finiti o null ritornano `null`.

Metriche:

- `cassa-frontend/backend/server.js`: 27.321 -> 27.310 righe;
- riduzione netta ciclo: 11 righe;
- `order-timestamps.js`: 11 righe;
- `order-timestamps.test.mjs`: 33 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-timestamps.js && node --check backend/server.js`: OK;
- `node --test backend/tests/order-timestamps.test.mjs backend/tests/order-state-machine.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 38/38;
- `node --test backend/tests/continuity.e2e.test.mjs`: OK, 69/69;
- `npm run check:backend`: OK;
- `node --test backend/tests/security.test.mjs`: OK, 27/27;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 14/14.

Rischi residui:

- `resolveIntegrationReadyAtMs` resta nel monolite perche' usa `Date.now()` come fallback e richiede test con clock controllato;
- `sanitizeIntegrationOrder` resta ancora grande e va affrontata per sotto-componenti;
- eventuale conversione delle stringhe numeriche in ISO sarebbe una modifica semantica e non e' stata fatta.

Prossimo step consigliato:

- prima di estrarre `resolveIntegrationReadyAtMs`, introdurre test con clock controllato o injection del fallback time;
- in alternativa isolare un helper puro su line signature/lineId se non ha side effect;
- continuare con micro-step e gate completi.

## Ciclo V3 - fiscalita palmari e isolamento porte V3 postazione

Data ciclo: 2026-06-07 15:09 CEST.

Ambito:

- V3 soltanto;
- V2/current non modificata;
- backend V3 riavviato su `5281`;
- nessuna emissione fiscale reale eseguita;
- nessuna modifica manuale al DB.

Correzioni applicate:

- `cassa-frontend/backend/server.js`:
  - `findConfiguredMobileDeviceForFiscal()` ora confronta anche `deviceUuid`/`uuid` salvato in impostazioni, oltre a `deviceId` e `id`;
  - nel flusso `/api/payments/free-split` viene registrato `fiscalEvents.result=mobile_device_fiscal_disabled` quando un palmare richiede fiscalita ma non e' abilitato per quel metodo;
  - la transazione resta contabilizzata, ma la mancata fiscalizzazione per policy palmare non resta piu' silenziosa;
  - preservato il comportamento V3 per chiamate non-mobile senza `deviceUuid`: la policy palmari blocca i device mobile non censiti, non i flussi non-mobile legacy.
- `cassa-frontend/backend/tests/mobile-device-fiscal-policy-static.test.mjs`:
  - aggiunti test statici su blocco palmari non configurati, match `deviceUuid` e route impostazioni protette.
- `cassa-frontend/backend/tests/payments-fiscal.e2e.test.mjs`:
  - aggiunto caso palmare non configurato che paga e non fiscalizza;
  - aggiunto caso palmare abilitato da impostazioni con `deviceId` diverso da `deviceUuid` che fiscalizza correttamente.
- `cassa-frontend/frontend-tests/settings-handhelds-native.test.mjs`:
  - aggiunti test per confermare che `Impostazioni > Palmari` e' una feature nativa del frontend impostazioni V3;
  - verificato che i palmari rilevati partano con fiscalita spenta;
  - verificato che la cassa non carichi bridge separati `cash-mobile-devices-settings.js`.
- `cassa-frontend/frontend-tests/postazione-bridges.test.mjs`:
  - riallineato il test del fallback backend postazione alle porte V3 `5280/5281`;
  - evita regressioni in cui una postazione V3 tenti di aggiornare `API_BASE` verso la V2 `5181`.

Stato runtime V3:

- frontend statici V3: `0.0.0.0:5280`;
- backend V3: `0.0.0.0:5281`;
- backend cwd: `/srv/applicazione/v3/cassa-frontend`;
- `BACKEND_DB_MODE=json`;
- `BACKEND_DB_PATH=/srv/applicazione/v3/cassa-frontend/backend/app-state.json`.

Verifiche live:

- `GET http://127.0.0.1:5281/api/health`: OK HTTP 200;
- `GET http://127.0.0.1:5280/mobile/`: OK HTTP 200;
- `GET http://127.0.0.1:5280/postazione/`: OK HTTP 200;
- `GET http://127.0.0.1:5280/impostazioni/`: OK HTTP 200;
- `GET http://127.0.0.1:5280/monitor/`: OK HTTP 200.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `npm run check:backend`: OK;
- `node --test backend/tests/mobile-device-config-domain.test.mjs backend/tests/mobile-device-fiscal-policy-static.test.mjs backend/tests/payments-fiscal.e2e.test.mjs`: OK, 15/15;
- `node --test --test-name-pattern 'postazione backend bridge aggiorna API_BASE' frontend-tests/postazione-bridges.test.mjs`: OK, 1/1;
- `node --test frontend-tests/mobile-frontendv2-static.test.mjs frontend-tests/postazione-bridges.test.mjs`: OK, 44/44;
- `node --test frontend-tests/settings-handhelds-native.test.mjs frontend-tests/mobile-frontendv2-static.test.mjs frontend-tests/postazione-bridges.test.mjs`: OK, 47/47.

Rischi residui:

- il backend V3 e' avviato in modalita JSON e stampa non abilitata, coerente con l'ambiente V3 di prova rilevato;
- la UI impostazioni V3 e' nativa ma vive ancora in `settings-frontend/dist/assets/settings-app.js`, quindi non esiste sorgente separato TS/React da buildare in questo ramo;
- non e' stata eseguita una suite GUI Playwright completa in questo ciclo, perche' la modifica era mirata a palmari/fiscalita e isolamento porte.

Prossimo step consigliato:

- continuare la riduzione monolite da helper puri, senza toccare ancora i flussi fiscali live;
- aggiungere un test end-to-end V3 con frontend impostazioni reale solo quando serve validare la UI in browser;
- se V3 dovra' essere usata con stampa reale, riavviare esplicitamente con `PRINTING_ENABLED=1` e DB/servizi di destinazione confermati.

## Ciclo V3 - completamento estrazione timestamp ready ordini

Data ciclo: 2026-06-07 15:18 CEST.

Ambito:

- V3 soltanto;
- V2/current non modificata;
- backend V3 riavviato su `5281` a fine ciclo;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o frontend;
- estrazione limitata a helper puro di timestamp ordine.

Motivo:

- `resolveIntegrationReadyAtMs()` era ancora nel monolite;
- la funzione usa `Date.now()` come fallback e quindi andava resa testabile senza cambiare semantica runtime;
- era il prossimo micro-step indicato dopo `normalizeIntegrationOrderTimestamp`.

Correzioni applicate:

- `cassa-frontend/backend/modules/orders/order-timestamps.js`:
  - aggiunto export `resolveIntegrationReadyAtMs(order, options = {})`;
  - preserva `order.readyAtMs` positivo troncato;
  - accetta `options.fallbackNowMs` solo per test/uso deterministico;
  - in runtime, senza fallback esplicito, continua a usare `Date.now()`.
- `cassa-frontend/backend/server.js`:
  - importato `resolveIntegrationReadyAtMs` dal modulo ordini;
  - rimossa la funzione locale dal monolite;
  - call site invariati.
- `cassa-frontend/backend/tests/order-timestamps.test.mjs`:
  - aggiunti test su readyAt positivo;
  - aggiunti test su fallback deterministico;
  - aggiunto test su fallback `Date.now()`.

Metriche:

- `cassa-frontend/backend/server.js`: 27.343 -> 27.335 righe rispetto all'inizio del ciclo;
- riduzione netta ciclo: 8 righe;
- `order-timestamps.js`: 11 -> 23 righe;
- `order-timestamps.test.mjs`: 33 -> 56 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-timestamps.js && node --check backend/server.js`: OK;
- `node --test backend/tests/order-timestamps.test.mjs backend/tests/order-state-machine.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 41/41;
- `npm run check:backend`: OK.

Stato runtime V3:

- backend V3 riavviato;
- nuovo PID backend V3 rilevato su `0.0.0.0:5281`;
- `GET http://127.0.0.1:5281/api/health`: OK HTTP 200;
- V2 resta attiva sulle porte `5180/5181`, V3 resta separata su `5280/5281`.

Rischi residui:

- `sanitizeIntegrationOrder` resta nel monolite;
- restano candidati puri vicini a line signature, line id e snapshot ordine;
- non e' stata eseguita suite GUI perche' il ciclo non ha modificato frontend.

Prossimo step consigliato:

- estrarre un helper puro su line signature/snapshot, partendo da test mirati su `buildIntegrationOrderLineSignature` o `buildIntegrationOrderLineSnapshots`;
- continuare a evitare handler HTTP e side effect finche' i domain helper non sono coperti.

## Ciclo V3 - estrazione helper righe ordine

Data ciclo: 2026-06-07 15:27 CEST.

Ambito:

- V3 soltanto;
- V2/current non modificata;
- backend V3 riavviato su `5281` a fine ciclo;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o frontend;
- estrazione limitata a helper puri sulle righe ordine.

Motivo:

- `buildIntegrationOrderLineSignature()` e `nextIntegrationOrderLineId()` erano ancora nel monolite;
- entrambe sono funzioni pure senza side effect e senza dipendenze da DB/stampa/fiscalita';
- sono propedeutiche a una futura estrazione piu' ampia di snapshot e mutazioni riga.

Correzioni applicate:

- creato `cassa-frontend/backend/modules/orders/order-lines.js`;
- spostate nel nuovo modulo:
  - `buildIntegrationOrderLineSignature`;
  - `nextIntegrationOrderLineId`;
- `cassa-frontend/backend/server.js` ora importa gli helper dal modulo ordini;
- aggiunto `cassa-frontend/backend/tests/order-lines.test.mjs`.

Comportamento preservato:

- la signature riga continua a includere:
  - nome;
  - variante;
  - nota;
  - prezzo unitario applicato;
  - listino al momento;
  - route stations;
- `nextIntegrationOrderLineId()` continua a:
  - cercare il massimo numerico nei `lineId`;
  - ignorare righe senza parte numerica valida;
  - generare `line_0001`, `line_0002`, ecc.

Metriche:

- `cassa-frontend/backend/server.js`: 27.335 -> 27.315 righe rispetto all'inizio del ciclo;
- riduzione netta ciclo: 20 righe;
- `order-lines.js`: 20 righe;
- `order-lines.test.mjs`: 51 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-lines.js && node --check backend/server.js`: OK;
- `node --test backend/tests/order-lines.test.mjs backend/tests/order-timestamps.test.mjs backend/tests/order-state-machine.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs backend/tests/integration-order-line-variants-domain.test.mjs`: OK, 60/60;
- `npm run check:backend`: OK.

Stato runtime V3:

- backend V3 riavviato;
- nuovo PID backend V3 rilevato su `0.0.0.0:5281`;
- `GET http://127.0.0.1:5281/api/health`: OK HTTP 200;
- V2 resta attiva sulle porte `5180/5181`, V3 resta separata su `5280/5281`.

Rischi residui:

- `buildIntegrationOrderLineSnapshots()` resta nel monolite perche' dipende da rounding, clone JSON, normalizzazione stringhe e stazioni;
- le mutazioni riga e gli handler HTTP restano nel monolite;
- non e' stata eseguita suite GUI perche' il ciclo non ha modificato frontend.

Prossimo step consigliato:

- estrarre `buildIntegrationOrderLineSnapshots()` con factory o dipendenze esplicite, solo dopo test piu' completi su allergeni, varianti, route stations e totali;
- in alternativa estrarre prima helper piu' piccolo su `nextIntegrationOrderItemId()`.

## Ciclo V3 - estrazione progress righe ordine e dead-code cleanup

Data ciclo: 2026-06-07 15:32 CEST.

Ambito:

- V3 soltanto;
- V2/current non modificata;
- backend V3 riavviato su `5281` a fine ciclo;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o frontend;
- estrazione limitata a helper puri su progress righe ordine.

Motivo:

- `markIntegrationOrderItemsReady()` e `buildIntegrationItemProgressAuditSnapshot()` erano ancora nel monolite;
- entrambe sono funzioni pure usate nei sync di stato comanda;
- `nextIntegrationOrderItemId()` risultava definita ma non usata in nessun flusso V3.

Correzioni applicate:

- creato `cassa-frontend/backend/modules/orders/order-progress.js`;
- spostate nel nuovo modulo:
  - `markIntegrationOrderItemsReady`;
  - `buildIntegrationItemProgressAuditSnapshot`;
- rimosso dal monolite l'helper inutilizzato `nextIntegrationOrderItemId`;
- `cassa-frontend/backend/server.js` ora importa gli helper progress dal modulo ordini;
- aggiunti:
  - `cassa-frontend/backend/tests/order-progress.test.mjs`;
  - `cassa-frontend/backend/tests/order-dead-code-static.test.mjs`.

Comportamento preservato:

- una riga marcata pronta continua a impostare `done=true`;
- `doneQty` viene portato almeno a `qty` quando `qty > 0`;
- lo snapshot audit continua a includere:
  - `id`;
  - `lineId`;
  - `qty`;
  - `done`;
  - `doneQty`;
  - `voided`.

Metriche:

- `cassa-frontend/backend/server.js`: 27.315 -> 27.286 righe rispetto all'inizio del ciclo;
- riduzione netta ciclo: 29 righe;
- `order-progress.js`: 22 righe;
- `order-progress.test.mjs`: 42 righe;
- `order-dead-code-static.test.mjs`: 9 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-progress.js && node --check backend/server.js`: OK;
- `node --test backend/tests/order-progress.test.mjs backend/tests/order-dead-code-static.test.mjs backend/tests/order-lines.test.mjs backend/tests/order-timestamps.test.mjs backend/tests/order-state-machine.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 50/50;
- `npm run check:backend`: OK.

Stato runtime V3:

- backend V3 riavviato;
- nuovo PID backend V3 rilevato su `0.0.0.0:5281`;
- `GET http://127.0.0.1:5281/api/health`: OK HTTP 200;
- V2 resta attiva sulle porte `5180/5181`, V3 resta separata su `5280/5281`.

Rischi residui:

- `buildIntegrationOrderLineSnapshots()` resta nel monolite ed e' il prossimo candidato naturale ma va estratto con attenzione perche' dipende da rounding, clone JSON, normalizzazione stringhe e stazioni;
- le mutazioni riga e gli handler HTTP restano nel monolite;
- non e' stata eseguita suite GUI perche' il ciclo non ha modificato frontend.

Prossimo step consigliato:

- valutare estrazione di un modulo `order-line-snapshots.js` con dipendenze esplicite/factory;
- prima aggiungere test completi su snapshot righe con varianti, allergeni, route stations, lineTotal e righe voided.

## Ciclo V3 - estrazione snapshot righe ordine

Data ciclo: 2026-06-07 15:39 CEST.

Ambito:

- V3 soltanto;
- V2/current non modificata;
- backend V3 da riavviare su `5281` a fine ciclo;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o frontend;
- estrazione limitata a helper puro sugli snapshot delle righe ordine.

Motivo:

- `buildIntegrationOrderLineSnapshots()` era ancora definita in `cassa-frontend/backend/server.js`;
- la funzione e' centrale per correzioni, resi, storni, stampa e audit delle righe ordine;
- tenerla nel monolite rende piu' difficile testare regressioni su prezzi, allergeni, varianti e route stations.

Correzioni applicate:

- creato `cassa-frontend/backend/modules/orders/order-line-snapshots.js`;
- spostata la logica `buildIntegrationOrderLineSnapshots()` dietro factory `createIntegrationOrderLineSnapshotHelpers()`;
- la factory riceve dipendenze esplicite:
  - `roundMoney`;
  - `cloneJson`;
  - `normalizeStringList`;
  - `normalizeIntegrationStationName`;
- rimosso dal monolite il corpo della funzione originale;
- `cassa-frontend/backend/server.js` mantiene lo stesso nome helper locale, ma ora lo riceve dal modulo ordini;
- aggiunto `cassa-frontend/backend/tests/order-line-snapshots.test.mjs`.

Comportamento preservato:

- righe con lo stesso `lineId` vengono aggregate;
- righe con `voidedAt` o senza `lineId` vengono ignorate;
- `lineTotal` resta prioritario rispetto ai fallback prezzo;
- se `lineTotal` manca, il totale deriva da `unitPriceApplied * qty`;
- se `unitPriceApplied` manca, il fallback usa `listPriceAtTime * qty`;
- `productNameSnapshot` continua a cadere su `name` e poi su `Articolo`;
- varianti, note, allergeni e route stations mantengono la normalizzazione precedente.

Metriche:

- `cassa-frontend/backend/server.js`: 27.286 -> 27.249 righe rispetto all'inizio del ciclo;
- riduzione netta ciclo: 37 righe;
- `order-line-snapshots.js`: 93 righe;
- `order-line-snapshots.test.mjs`: 117 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-line-snapshots.js && node --check backend/server.js`: OK;
- `node --test backend/tests/order-line-snapshots.test.mjs backend/tests/order-progress.test.mjs backend/tests/order-lines.test.mjs backend/tests/order-timestamps.test.mjs backend/tests/order-state-machine.test.mjs`: OK, 34/34;
- `node --test backend/tests/order-line-snapshots.test.mjs backend/tests/order-progress.test.mjs backend/tests/order-lines.test.mjs backend/tests/order-timestamps.test.mjs backend/tests/order-state-machine.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 54/54;
- `npm run check:backend`: OK.

Stato runtime rilevato prima del riavvio:

- V2/current ancora separata su `0.0.0.0:5180` e `0.0.0.0:5181`;
- V3 ancora separata su `0.0.0.0:5280` e `0.0.0.0:5281`.

Stato runtime dopo il riavvio:

- backend V3 riavviato su `0.0.0.0:5281`;
- nuovo PID backend V3: `1287219`;
- `GET http://127.0.0.1:5281/api/health`: OK HTTP 200;
- V2/current resta attiva e non e' stata riavviata.

Rischi residui:

- il monolite contiene ancora gli handler di correzione, reso, storno e stampa che consumano gli snapshot;
- i prossimi step devono continuare a estrarre funzioni pure senza spostare handler HTTP critici;
- non e' stata eseguita suite GUI perche' il ciclo non ha modificato frontend.

Prossimo step consigliato:

- estrarre helper puri collegati alle annotazioni di correzione/stampa, partendo da `buildCorrectionPrintAnnotations()` o da funzioni piu' piccole collegate;
- prima coprire con test regressioni su righe aggiunte, modificate e rimosse.

## Ciclo V3 - estrazione annotazioni stampa correzioni

Data ciclo: 2026-06-07 15:45 CEST.

Ambito:

- V3 soltanto;
- V2/current non modificata;
- backend V3 da riavviare su `5281` a fine ciclo;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o frontend;
- estrazione limitata a helper puro usato dalla stampa comanda corretta/modificata.

Motivo:

- `buildCorrectionPrintAnnotations()` era ancora definita nel monolite;
- la funzione decide come rappresentare in stampa le righe aggiunte, modificate e rimosse;
- e' una zona delicata per resi/modifiche/storni perche' deve restare deterministica e non dipendere da stato runtime.

Correzioni applicate:

- creato `cassa-frontend/backend/modules/orders/order-correction-print.js`;
- spostata `buildCorrectionPrintAnnotations()` nel modulo ordini;
- rimosso dal monolite il corpo della funzione originale;
- `cassa-frontend/backend/server.js` importa il nuovo helper e mantiene invariato il punto di utilizzo;
- aggiunto `cassa-frontend/backend/tests/order-correction-print.test.mjs`.

Comportamento preservato:

- le righe aggiunte vengono indicizzate in `addedByLineId`;
- le righe modificate vengono indicizzate in `changedByLineId`;
- le righe rimosse diventano snapshot stampabili con `correctionStatus: "removed"`;
- le righe rimosse senza `lineId` ricevono fallback deterministico `removed_N`;
- quantita' invalide o negative vengono riportate a `1`;
- nome articolo e productId mantengono i fallback precedenti.

Metriche:

- `cassa-frontend/backend/server.js`: 27.249 -> 27.209 righe rispetto all'inizio del ciclo;
- riduzione netta ciclo: 40 righe;
- `order-correction-print.js`: 40 righe;
- `order-correction-print.test.mjs`: 77 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-correction-print.js && node --check backend/server.js`: OK;
- `node --test backend/tests/order-correction-print.test.mjs backend/tests/order-line-snapshots.test.mjs backend/tests/order-progress.test.mjs backend/tests/order-lines.test.mjs backend/tests/order-timestamps.test.mjs backend/tests/order-state-machine.test.mjs`: OK, 37/37;
- `node --test backend/tests/order-correction-print.test.mjs backend/tests/order-line-snapshots.test.mjs backend/tests/order-progress.test.mjs backend/tests/order-lines.test.mjs backend/tests/order-timestamps.test.mjs backend/tests/order-state-machine.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 57/57;
- `npm run check:backend`: OK.

Stato runtime rilevato prima del riavvio:

- V2/current ancora separata su `0.0.0.0:5180` e `0.0.0.0:5181`;
- V3 ancora separata su `0.0.0.0:5280` e `0.0.0.0:5281`;
- PID backend V3 precedente: `1287219`.

Stato runtime dopo il riavvio:

- backend V3 riavviato su `0.0.0.0:5281`;
- nuovo PID backend V3: `1307087`;
- `GET http://127.0.0.1:5281/api/health`: OK HTTP 200;
- V2/current resta attiva e non e' stata riavviata.

Rischi residui:

- le funzioni di formattazione effettiva stampa comanda/preconto restano nel monolite;
- i prossimi step devono continuare con helper puri prima di toccare handler HTTP o side effect di spool;
- non e' stata eseguita suite GUI perche' il ciclo non ha modificato frontend.

Prossimo step consigliato:

- valutare estrazione di helper puri di label stampa collegati a varianti/supplementi:
  - `extractIntegrationPrintVariantLabel()`;
  - `cleanIntegrationOrderVariantLabelForPrint()`;
  - `isIntegrationSupplementText()`;
  - `cleanIntegrationOrderSupplementLabelForPrint()`;
- prima coprire con test su stringhe, array, oggetti variante, supplementi e note.

## Ciclo V3 - estrazione label stampa varianti e supplementi

Data ciclo: 2026-06-07 15:50 CEST.

Ambito:

- V3 soltanto;
- V2/current non modificata;
- backend V3 da riavviare su `5281` a fine ciclo;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o frontend;
- estrazione limitata a helper puri usati nella stampa di comande/preconti.

Motivo:

- gli helper di label stampa varianti/supplementi erano ancora nel monolite;
- queste funzioni influenzano la leggibilita' di stampa di modifiche, varianti premium, note e supplementi;
- l'estrazione riduce il monolite senza spostare handler o side effect di stampa/spool.

Correzioni applicate:

- creato `cassa-frontend/backend/modules/orders/order-print-labels.js`;
- spostati dietro factory `createIntegrationOrderPrintLabelHelpers()`:
  - `extractIntegrationPrintVariantLabel`;
  - `cleanIntegrationOrderVariantLabelForPrint`;
  - `isIntegrationSupplementText`;
  - `cleanIntegrationOrderSupplementLabelForPrint`;
- la factory riceve dipendenze esplicite:
  - `normalizePrecontoInlineSupplementLabel`;
  - `stripPrecontoSupplementUnitSuffix`;
- rimosse dal monolite le quattro definizioni locali;
- `cassa-frontend/backend/server.js` mantiene gli stessi nomi helper locali, ma ora li riceve dal modulo ordini;
- aggiunto `cassa-frontend/backend/tests/order-print-labels.test.mjs`.

Comportamento preservato:

- varianti stringa, array e oggetto vengono convertite in label compatta separata da ` / `;
- label duplicate dentro oggetti variante vengono ignorate;
- le label sono limitate a 120 caratteri come prima;
- i supplementi vengono riconosciuti tramite prezzo, extra, aggiunta, apericena e menu;
- la pulizia supplementi continua a rimuovere prefissi `nota/commento` solo secondo la semantica storica;
- il primo test scritto e' stato corretto per non introdurre una pulizia piu' aggressiva rispetto al comportamento originale.

Metriche:

- `cassa-frontend/backend/server.js`: 27.209 -> 27.154 righe rispetto all'inizio del ciclo;
- riduzione netta ciclo: 55 righe;
- `order-print-labels.js`: 88 righe;
- `order-print-labels.test.mjs`: 65 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-print-labels.js && node --check backend/server.js`: OK;
- `node --test backend/tests/order-print-labels.test.mjs backend/tests/order-correction-print.test.mjs backend/tests/order-line-snapshots.test.mjs backend/tests/order-progress.test.mjs backend/tests/order-lines.test.mjs backend/tests/order-timestamps.test.mjs backend/tests/order-state-machine.test.mjs`: OK, 43/43;
- `node --test backend/tests/order-print-labels.test.mjs backend/tests/order-correction-print.test.mjs backend/tests/order-line-snapshots.test.mjs backend/tests/order-progress.test.mjs backend/tests/order-lines.test.mjs backend/tests/order-timestamps.test.mjs backend/tests/order-state-machine.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 63/63;
- `npm run check:backend`: OK.

Stato runtime rilevato prima del riavvio:

- V2/current ancora separata su `0.0.0.0:5180` e `0.0.0.0:5181`;
- V3 ancora separata su `0.0.0.0:5280` e `0.0.0.0:5281`;
- PID backend V3 precedente: `1307087`.

Stato runtime dopo il riavvio:

- backend V3 riavviato su `0.0.0.0:5281`;
- nuovo PID backend V3: `1321066`;
- `GET http://127.0.0.1:5281/api/health`: OK HTTP 200;
- V2/current resta attiva e non e' stata riavviata.

Rischi residui:

- la costruzione completa della stampa comanda/preconto resta nel monolite;
- le funzioni pure di branding, layout e rendering ESC/POS sono ancora in parte fuori dal dominio ordini;
- non e' stata eseguita suite GUI perche' il ciclo non ha modificato frontend.

Prossimo step consigliato:

- cercare il prossimo helper puro piccolo legato alla stampa ordine, ad esempio `formatIntegrationWaiterShortLabel()` o un helper di display label;
- evitare per ora di spostare `buildIntegrationPrecontoModel()` perche' tocca molte dipendenze e merita una fase separata con test piu' ampi.

## Ciclo V3 - estrazione label breve cameriere

Data ciclo: 2026-06-07 15:54 CEST.

Ambito:

- V3 soltanto;
- V2/current non modificata;
- backend V3 da riavviare su `5281` a fine ciclo;
- nessuna modifica a DB, pagamenti, fiscalita', stampanti o frontend;
- estrazione limitata a helper puro usato nelle intestazioni stampa ordine/preconto.

Motivo:

- `formatIntegrationWaiterShortLabel()` era ancora definita nel monolite;
- la funzione e' piccola ma usata in piu' stampe per ridurre nome e cognome del cameriere;
- inserirla in `order-print-labels.js` mantiene insieme le label testuali di stampa.

Correzioni applicate:

- aggiunta `formatIntegrationWaiterShortLabel()` dentro `createIntegrationOrderPrintLabelHelpers()`;
- rimosso dal monolite il corpo della funzione locale;
- `cassa-frontend/backend/server.js` continua a usare lo stesso nome helper ottenuto dalla factory;
- esteso `cassa-frontend/backend/tests/order-print-labels.test.mjs`.

Comportamento preservato:

- nome singolo resta invariato;
- nome e cognome diventano `Nome C.`;
- spazi multipli vengono compattati;
- input vuoto o nullo restituisce `Cameriere`.

Metriche:

- `cassa-frontend/backend/server.js`: 27.154 -> 27.145 righe rispetto all'inizio del ciclo;
- riduzione netta ciclo: 9 righe;
- `order-print-labels.js`: 99 righe;
- `order-print-labels.test.mjs`: 72 righe.

Test eseguiti:

- `node --check backend/modules/orders/order-print-labels.js && node --check backend/server.js`: OK;
- `node --test backend/tests/order-print-labels.test.mjs backend/tests/order-correction-print.test.mjs backend/tests/order-line-snapshots.test.mjs backend/tests/order-progress.test.mjs backend/tests/order-lines.test.mjs backend/tests/order-timestamps.test.mjs backend/tests/order-state-machine.test.mjs`: OK, 44/44;
- `node --test backend/tests/order-print-labels.test.mjs backend/tests/order-correction-print.test.mjs backend/tests/order-line-snapshots.test.mjs backend/tests/order-progress.test.mjs backend/tests/order-lines.test.mjs backend/tests/order-timestamps.test.mjs backend/tests/order-state-machine.test.mjs backend/tests/orders-flow.e2e.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK, 64/64;
- `npm run check:backend`: OK.

Stato runtime rilevato prima del riavvio:

- V2/current ancora separata su `0.0.0.0:5180` e `0.0.0.0:5181`;
- V3 ancora separata su `0.0.0.0:5280` e `0.0.0.0:5281`;
- PID backend V3 precedente: `1321066`.

Stato runtime dopo il riavvio:

- backend V3 riavviato su `0.0.0.0:5281`;
- nuovo PID backend V3: `1330431`;
- `GET http://127.0.0.1:5281/api/health`: OK HTTP 200;
- V2/current resta attiva e non e' stata riavviata.

Rischi residui:

- `buildIntegrationPrecontoModel()` e le funzioni principali di rendering stampa restano nel monolite;
- i prossimi step devono continuare con helper puri o preparare un piano di estrazione piu' ampio per il preconto;
- non e' stata eseguita suite GUI perche' il ciclo non ha modificato frontend.

Prossimo step consigliato:

- cercare helper puri di display label vicini alla stampa oppure inventariare le dipendenze di `buildIntegrationPrecontoModel()` prima di estrarlo;
- non spostare ancora handler di stampa o spool.

## Ciclo V3 - live sync palmari fiscali e policy fiscale deterministica

Data ciclo: 2026-06-07 18:59 CEST.

Ambito:

- V3 soltanto;
- V2/current non modificata in questo ciclo;
- nessun riavvio eseguito;
- obiettivo: portare in V3 le correzioni V2 per pilotare il fiscale dai toggle impostazioni palmari senza comportamenti ambigui.

Correzioni applicate:

- `settings-frontend/dist/assets/settings-app.js`:
  - aggiunto `SETTINGS_VERSION_KEY = "pos:settings-version"`;
  - aggiunte `resolveSettingsVersion()` e `publishSettingsVersion()`;
  - `runSave()` pubblica subito la nuova versione dopo ogni salvataggio, incluso `/api/settings/mobile-devices/save`;
- `cassa-frontend/dist/assets/cash-settings-live-sync.js`:
  - il bridge live-sync intercetta anche `/api/settings/mobile-devices/*`;
- `postazione/dist/assets/postazione-settings-live-sync.js`:
  - il bridge live-sync intercetta anche `/api/settings/mobile-devices/*`;
- cache-buster aggiornati in:
  - `settings-frontend/dist/index.html`;
  - `cassa-frontend/dist/index.html`;
  - `postazione/dist/index.html`;
- `cassa-frontend/backend/server.js`:
  - `isMobileDeviceFiscalAllowed()` ora restituisce `false` se il palmare non e' configurato/riconosciuto;
  - rimosso il fallback permissivo per payload senza `deviceUuid`;
- `cassa-frontend/backend/tests/mobile-device-fiscal-policy-static.test.mjs`:
  - aggiornata l'aspettativa statica sulla policy fiscale palmari.

Comportamento atteso:

- lo switch fiscale/elettronico/contanti dei palmari in impostazioni salva su DB e pubblica subito la nuova versione;
- cassa e postazione rilevano anche i salvataggi palmari, non solo menu/pos settings generici;
- un POS da palmare fiscalizza solo se:
  - il palmare e' configurato e riconosciuto tramite `deviceId`, `deviceUuid` o `id`;
  - `fiscalEnabled=true`;
  - `electronicPaymentEnabled=true`;
  - il metodo `pay_card` e' fiscale;
  - esiste una RT API attiva con supporto elettronico;
- palmare sconosciuto o payload senza identificativo non emette fiscale.

Test eseguiti:

- `node --check settings-frontend/dist/assets/settings-app.js`: OK;
- `node --check cassa-frontend/dist/assets/cash-settings-live-sync.js`: OK;
- `node --check postazione/dist/assets/postazione-settings-live-sync.js`: OK;
- `node --check cassa-frontend/backend/server.js`: OK;
- static check custom live-sync/policy fiscale V3: OK;
- `node --test backend/tests/mobile-device-config-domain.test.mjs backend/tests/mobile-device-fiscal-policy-static.test.mjs backend/tests/payments-fiscal.e2e.test.mjs`: OK, 15/15.

Stato runtime:

- nessun servizio riavviato;
- V2/current ancora attiva su `5180/5181`;
- V3 ancora attiva su `5280/5281`;
- la modifica backend V3 su disco richiede un futuro riavvio V3 per entrare nel processo gia' in esecuzione.

Rischi residui:

- i browser gia' aperti sulla pagina impostazioni V3 devono ricaricare la pagina per scaricare il nuovo `settings-app.js`;
- il processo backend V3 attualmente in memoria non vede ancora la modifica backend finche' non verra' riavviato su richiesta esplicita.

## Ciclo V3 - separazione definitiva runtime Papera / POS System

Data ciclo: 2026-06-15 23:49 CEST.

Problema:

- il servizio systemd principale `applicazione-backend.service` stava usando il path `/srv/applicazione/current/cassa-frontend/backend/server.js`;
- quel path oggi e' il backend Papera/Mongo;
- contemporaneamente caricava `/etc/applicazione/applicazione.env`, con variabili POS storiche su `5181` e DB sqlite;
- il risultato era un runtime mescolato: Papera e POS potevano condividere porta, default e diagnosi operative.

Correzione:

- `applicazione-backend.service` ora avvia il POS System V3:
  - `/srv/applicazione/v3/cassa-frontend/backend/server.js`;
  - porta backend `5281`;
  - DB JSON `/srv/applicazione/v3/cassa-frontend/backend/app-state.json`;
  - env dedicato `/etc/applicazione/pos-v3.env`;
- `applicazione-frontends.service` ora serve il frontend V3:
  - `/srv/applicazione/v3/serve-frontends.mjs`;
  - porta frontend `5280`;
  - proxy API `http://127.0.0.1:5281`;
- Papera e' stata isolata su servizi dedicati:
  - `papera-backend.service` su `5181`;
  - `papera-frontends.service` su `5180`;
  - DB Mongo `acchiappa_pos`.

Verifiche:

- `GET http://127.0.0.1:5281/api/health`: `cash-backend`;
- `GET http://127.0.0.1:5181/api/health`: `ACCHIAPPA LA PAPERA`;
- `acchiappa_pos`: 2 utenti Papera, 0 utenti POS `u_*`;
- `app-state.json` V3: nessun `cassa-1` o `papera`;
- porte attive:
  - `5280`: frontend POS V3;
  - `5281`: backend POS V3;
  - `5180`: frontend Papera;
  - `5181`: backend Papera.

Regola anti-regressione:

- non puntare piu' il POS a `/srv/applicazione/current`;
- non usare piu' `/etc/applicazione/applicazione.env` per il POS V3;
- non copiare utenti POS dentro Mongo Papera;
- non trattare `cassa-1` come postazione POS reale.

## Ciclo V3 - chiarimento frontend e DB separati

Data ciclo: 2026-06-16 00:13 CEST.

Chiarimento operativo:

- `ACCHIAPPA LA PAPERA` e' un sistema separato, con frontend/backend separati e Mongo `acchiappa_pos`;
- il POS/palmari e' il sistema V3, con frontend V3 e DB JSON `/srv/applicazione/v3/cassa-frontend/backend/app-state.json`;
- utenti come `giada`, `lorenzo`, `bardo`, `anna`, ecc. appartengono al POS/palmari, non a Mongo Papera.

Stato finale:

- nginx porta `80` serve il POS V3:
  - `/api/` -> `127.0.0.1:5281`;
  - `/mobile/` -> `/srv/applicazione/v3/mobile-frontend/dist`;
  - `/postazione/` -> `/srv/applicazione/v3/postazione/dist`;
  - `/impostazioni/` -> `/srv/applicazione/v3/settings-frontend/dist`;
  - `/monitor/` -> `/srv/applicazione/v3/monitor-frontend/dist`;
- Acchiappa la Papera resta separato:
  - frontend `5180`;
  - backend `5181`;
  - Mongo `acchiappa_pos`;
  - `/papera-api/` su nginx per API Papera se serve;
- Mongo `acchiappa_pos` e' pulito:
  - 2 utenti Papera;
  - 0 utenti POS `u_*`;
  - 8 casse Papera;
- il vecchio DB contaminato e' archiviato come `zz_archive_acchiappa_pos_mixed_20260615221127`.

## Ciclo V3 - CORS mobile POS via nginx porta 80

Data ciclo: 2026-06-16 00:15 CEST.

Sintomo:

- dal mobile POS servito da `http://192.168.1.166/mobile/` compariva `Origine CORS non consentita`;
- il backend POS accettava solo origin con porta `:5280`.

Causa:

- dopo il riallineamento nginx, il frontend POS puo' essere aperto anche senza porta su `http://192.168.1.166`;
- l'origin browser diventa quindi `http://192.168.1.166`, non `http://192.168.1.166:5280`.

Correzione:

- aggiornato `/etc/applicazione/pos-v3.env`;
- `CORS_ALLOWED_ORIGINS` ora include:
  - `http://localhost`;
  - `http://127.0.0.1`;
  - `http://192.168.1.166`;
  - `http://localhost:5280`;
  - `http://127.0.0.1:5280`;
  - `http://192.168.1.166:5280`;
- riavviato solo `applicazione-backend.service`.

Verifiche:

- `Origin: http://192.168.1.166` -> OK;
- `Origin: http://127.0.0.1` -> OK;
- `Origin: http://192.168.1.166:5280` -> OK;
- `Origin: http://127.0.0.1:5280` -> OK.

## Ciclo V3 - stabilizzazione login mobile POS

Data ciclo: 2026-06-16 18:40 CEST.

Sintomo:

- il mobile POS, non Papera, veniva spesso riportato alla schermata di login.

Cause individuate:

- il backend applicava una policy `per_app_user`: un nuovo login dello stesso utente su `mobile-frontend` revocava tutte le altre sessioni mobile dello stesso utente, anche su palmari diversi;
- il frontend mobile controllava `/api/auth/session/status` ogni 3 secondi e faceva logout locale al primo `invalid`;
- il client API globale faceva logout immediato su qualunque `401`, inclusi endpoint auth dove un `401` puo' essere una risposta operativa e non una sessione scaduta, ad esempio cambio PIN con PIN errato.

Correzioni applicate:

- `cassa-frontend/backend/server.js`:
  - per `mobile-frontend`, la policy sessioni ora e' `per user + device`;
  - un nuovo login sullo stesso palmare pulisce il token vecchio dello stesso device;
  - due palmari diversi con lo stesso utente non si revocano piu' a vicenda;
  - la policy 1 postazione = 1 utente resta invariata per `postazione`;
- `mobile-frontend/src/App.tsx`:
  - session check portato a 8 secondi;
  - logout solo dopo 3 invalidazioni consecutive;
  - una risposta valida azzera il contatore;
- `mobile-frontend/src/shared/api/apiClient.ts`:
  - esclusi dal logout globale immediato:
    - `/api/auth/session/status`;
    - `/api/auth/change-pin`;
    - `/api/auth/logout`;
- `mobile-frontend/src/store/authStore.ts`:
  - il gestore globale dei `401` non esegue piu' logout immediato;
  - pubblica solo l'evento locale `mobile:api-unauthorized`;
  - il ciclo di vita sessione resta centralizzato su `/api/auth/session/status`, che invalida il login solo dopo conferme consecutive.

Deploy:

- ricompilato mobile `dist`;
- riavviato solo `applicazione-backend.service`.

Verifiche:

- `node --check cassa-frontend/backend/server.js`: OK;
- `npm run typecheck` mobile: OK;
- `npm run build` mobile: OK;
- `node --test backend/tests/auth-session.e2e.test.mjs`: OK, 9/9;
- `GET http://127.0.0.1/api/health`: OK.
- `GET http://127.0.0.1/mobile/index.html`: serve il bundle V3 `dist/assets/index-DW9v-tc0.js`;
- `GET http://127.0.0.1:5280/mobile/index.html`: serve lo stesso bundle V3 `dist/assets/index-DW9v-tc0.js`.

Rischio residuo:

- se l'utente effettua logout esplicito o la sessione scade davvero lato backend, il mobile uscira' comunque dopo conferma;
- i browser gia' aperti devono ricaricare `/mobile/` per prendere il nuovo bundle `dist/assets/index-DW9v-tc0.js`.

## Ciclo V3 - POS fiscale sempre abilitato per palmari e recupero scontrini

Data ciclo: 2026-06-17 02:15 CEST.

Richiesta:

- il POS deve essere emettibile fiscalmente per tutti i palmari, utenti e device futuri;
- recuperare gli scontrini fiscali POS non emessi dalle 17:00 del 2026-06-16.

Correzione applicata:

- in `cassa-frontend/backend/server.js`, funzione `isMobileDeviceFiscalAllowed()`, il metodo POS / `pay_card` ora ritorna sempre abilitato prima del controllo sul device configurato;
- il gate per i pagamenti POS resta quindi su configurazione RT, stato fiscale e modalita' demo, non sull'anagrafica del palmare;
- il controllo per contanti resta invece vincolato alla configurazione del palmare.

Operazioni eseguite:

- backup DB prima del recupero: `/srv/applicazione/v3/cassa-frontend/backend/backups/app-state-before-pos-fiscal-recovery-20260617-020837.json`;
- verificato servizio fiscale `http://192.168.1.200:8765/api/fiscal/status`: OK, `fiscalApiEnabled=true`, `dryRun=false`;
- riavviato solo `applicazione-backend.service` per caricare la modifica;
- recuperati 12 pagamenti elettronici POS non fiscalizzati nella finestra dalle 17:00 del 2026-06-16;
- importo totale recuperato: EUR 338,30;
- emissione fiscale reale completata per 12/12 pagamenti;
- un blocco temporaneo COM1 durante il recupero e' stato gestito con retry e ritardo maggiore.

Verifiche:

- `node --check /srv/applicazione/v3/cassa-frontend/backend/server.js`: OK;
- `GET http://127.0.0.1/api/health`: OK;
- `GET http://192.168.1.200:8765/api/fiscal/status`: OK;
- verifica DB post-recupero: 12 POS nella finestra, 12 fiscalizzati, 0 mancanti, totale EUR 338,30.

Rischio residuo:

- nessun pagamento POS della finestra indicata risulta ancora non fiscalizzato;
- se il servizio fiscale diventa indisponibile in futuro, resta necessaria la coda/retry fiscale gia' prevista dal flusso applicativo.

## Ciclo V3 - verifica POS fiscale palmari e stampa test riepilogo scarico

Data ciclo: 2026-06-19 01:31 CEST.

Richiesta:

- garantire che ogni palmare e ogni utente, anche futuro, mandi sempre in fiscale i pagamenti POS;
- stampare un tagliando di prova del riepilogo scarico che viene usato quando i palmari chiudono.

Verifica POS fiscale:

- confermata in `cassa-frontend/backend/server.js` la policy di `isMobileDeviceFiscalAllowed()`:
  - `methodType === "POS"` oppure `paymentMethodId === "pay_card"` ritorna `true` prima del controllo device;
  - il POS non dipende quindi da `mobileDevices`, palmare o utente;
  - restano attivi i gate di RT configurata, servizio fiscale e modalita' demo;
  - i contanti restano vincolati alla configurazione palmare.

Test automatici:

- aggiornato `cassa-frontend/backend/tests/mobile-device-fiscal-policy-static.test.mjs` per proteggere esplicitamente la regola POS sempre abilitato;
- `node --test backend/tests/mobile-device-fiscal-policy-static.test.mjs`: OK, 4/4;
- `node --check backend/server.js`: OK;
- `GET http://127.0.0.1/api/health`: OK;
- `GET http://192.168.1.200:8765/api/fiscal/status`: OK, `fiscalApiEnabled=true`, `dryRun=false`.

Stampa test riepilogo scarico:

- eseguita tramite lo stesso endpoint usato dal mobile: `POST /api/integration/print`;
- contesto operativo: `activity_bar` + `room_bar`;
- profilo: `precontoProfile="cash"`, `ignoreWorkstationRouting=true`;
- stampante risolta: `printer_bar_1921681195_9100`, `Stampante preconti e comande Bar 192.168.1.102`;
- job: `print_c51e5be1f3144cb2ab3a90a780e70d63`;
- stato finale spool: `printed`;
- file spool: `/srv/applicazione/v3/cassa-frontend/backend/.print-spool/print_c51e5be1f3144cb2ab3a90a780e70d63.txt`.

Nota:

- la stampa di prova non ha chiuso sessioni, non ha azzerato POS/fondi cassa e non ha modificato pagamenti; ha solo verificato il percorso reale di stampa del riepilogo.

## Ciclo V3 - varianti e supplementi human-readable in comanda/preconto

Data ciclo: 2026-06-19 01:39 CEST.

Richiesta:

- individuare perche' alcune varianti, aggiunte/supplementi e nomi in comanda uscivano non human-readable con underscore;
- fare backup prima di modificare;
- correggere;
- verificare con stampe reali.

Backup:

- creato `/home/amalia/Downloads/v3-pre-human-readable-variants-20260619-013519.zip`;
- include codice V3 e DB `cassa-frontend/backend/app-state.json`;
- esclusi artefatti ricostruibili pesanti dove possibile.

Diagnosi:

- esempio reale trovato: comanda `00181`, tavolo `2`, articolo `Gin Mare`;
- la variante era salvata con dato umano corretto (`label/name = Tonic`) ma anche con campi tecnici (`id = menu_drink_premium_mare_tonic`, `priceDelta = 0`);
- il problema era in `cassa-frontend/backend/modules/orders/order-print-labels.js`;
- `extractIntegrationPrintVariantLabel()` aggiungeva alla label anche tutti i valori dell'oggetto, includendo `id`, `priceDelta` e altri campi tecnici;
- risultato precedente possibile: `Tonic / menu_drink_premium_mare_tonic / 0`.

Fix:

- aggiornata `extractIntegrationPrintVariantLabel()` per:
  - preferire chiavi descrittive (`label`, `name`, `value`, `variantName`, `selectedVariantName`, `displayName`, `title`);
  - ignorare chiavi tecniche (`id`, `productId`, `variantId`, `selectedVariantId`, `priceDelta`, `extraPrice`, `sku`, `code`, ecc.);
  - non stampare numeri tecnici isolati;
  - mantenere invece campi custom descrittivi, ad esempio `Supplemento` e `Variante`;
  - gestire anche array di oggetti variante.

Test automatici:

- aggiornato `cassa-frontend/backend/tests/order-print-labels.test.mjs`;
- `node --test backend/tests/order-print-labels.test.mjs`: OK, 9/9;
- `node --check backend/modules/orders/order-print-labels.js`: OK;
- `node --check backend/server.js`: OK;
- verifica manuale helper: `Tonic`, `Prenotazione`, `Menu Apericena / Tonic`.

Deploy runtime:

- backend V3 ricaricato con nuovo PID `1080966`;
- `GET http://127.0.0.1:5281/api/health`: OK.

Stampe reali:

- preconto reale su comanda `00181`:
  - endpoint: `POST /api/integration/print`;
  - stampante: `printer_bar_1921681195_9100`, `Stampante preconti e comande Bar 192.168.1.102`;
  - job: `print_60953053fc7746a1a008eafad3da2e50`;
  - stato: `printed`;
  - controllo spool: contiene `Tonic`, non contiene `menu_...`, non contiene `priceDelta`.
- comanda reale su comanda `00181`:
  - endpoint: `POST /api/integration/print`;
  - stampante: `printer_bar_1921681195_9100`, `Stampante preconti e comande Bar 192.168.1.102`;
  - job: `print_7c50ffce3b514b4ea0891ecaca8847f2`;
  - stato: `printed`;
  - controllo spool: contiene `Tonic`, non contiene `menu_...`, non contiene `priceDelta`.

Nota:

- non sono stati creati ordini, pagamenti o fiscali;
- sono state fatte solo ristampe tecniche di verifica della comanda `00181`.

## Ciclo V3 - disattivazione fiscale contanti palmari senza restart

Data ciclo: 2026-06-19 21:48 CEST.

Richiesta:

- disattivare l'emissione fiscale per i pagamenti in contanti di tutti i palmari;
- procedere solo se non richiede riavvio.

Analisi:

- la policy backend `isMobileDeviceFiscalAllowed()` legge `posSettings.mobileDevices` dal DB a ogni pagamento;
- il POS resta sempre fiscalizzabile per qualunque palmare (`methodType=POS` oppure `paymentMethodId=pay_card`);
- il contante invece richiede `cashPaymentEnabled === true` sul device configurato;
- quindi la modifica e' applicabile a caldo via impostazioni/DB, senza restart.

Backup:

- creato `/srv/applicazione/v3/cassa-frontend/backend/backups/app-state-before-disable-handheld-cash-fiscal-20260619-214723.json`.

Modifica:

- aggiornati via API impostazioni `POST /api/settings/mobile-devices/save`;
- per tutti i device configurati:
  - `fiscalEnabled` lasciato `true`;
  - `electronicPaymentEnabled` lasciato `true`;
  - `cashPaymentEnabled` impostato `false`;
  - `updatedBy=admin`;
  - settingsVersion aggiornato a `1781898479741`.

Device interessati:

- `dev_1778865853378_2cjmc5cgyke` (`Palmare condiviso`);
- `dev_1780309110686_ojgwswx72sg` (`Palmare Giada`);
- `u_1778319633697_252626525` (`Postazione Roberto`).

Verifiche:

- nessun riavvio effettuato;
- `GET http://127.0.0.1:5281/api/health`: OK;
- DB verificato: tutti i device hanno `cashPaymentEnabled=false`;
- DB verificato: tutti i device mantengono `electronicPaymentEnabled=true`;
- `node --test backend/tests/mobile-device-fiscal-policy-static.test.mjs`: OK, 4/4.

Effetto atteso:

- pagamenti POS/elettronici dai palmari continuano a poter emettere fiscale;
- pagamenti in contanti dai palmari non emettono fiscale.

## Ciclo V3 - riabilitazione fiscale contanti palmari fino alle 03:00

Data ciclo: 2026-06-19 21:57 CEST.

Richiesta:

- riabilitare subito il fiscale contanti per i palmari;
- alle 03:00 riportare automaticamente i palmari in modalita' solo POS.

Backup:

- creato `/srv/applicazione/v3/cassa-frontend/backend/backups/app-state-before-reenable-handheld-cash-fiscal-20260619-215526.json`.

Modifica immediata:

- aggiornata configurazione via API impostazioni `POST /api/settings/mobile-devices/save`;
- per tutti i device configurati:
  - `fiscalEnabled=true`;
  - `electronicPaymentEnabled=true`;
  - `cashPaymentEnabled=true`;
  - `updatedBy=admin`;
  - settingsVersion aggiornato a `1781898938918`.

Device interessati:

- `dev_1778865853378_2cjmc5cgyke` (`Palmare condiviso`);
- `dev_1780309110686_ojgwswx72sg` (`Palmare Giada`);
- `u_1778319633697_252626525` (`Postazione Roberto`).

Schedulazione 03:00:

- creato script `/srv/applicazione/v3/tools/set-handheld-cash-fiscal-mode.mjs`;
- creato wrapper one-shot `/srv/applicazione/v3/tools/disable-handheld-cash-fiscal-once-20260620.sh`;
- registrato crontab:
  - `0 3 20 6 * /srv/applicazione/v3/tools/disable-handheld-cash-fiscal-once-20260620.sh # pos-handheld-cash-fiscal-pos-only-20260620`;
- cron verificato `active`;
- il wrapper esegue lo spegnimento contanti e poi rimuove automaticamente la propria riga dal crontab;
- log previsto: `/srv/applicazione/v3/logs/handheld-cash-fiscal-scheduler.log`.

Verifiche:

- nessun riavvio effettuato;
- `GET http://127.0.0.1:5281/api/health`: OK;
- stato corrente DB: tutti i palmari `cashPaymentEnabled=true` e `electronicPaymentEnabled=true`.

Effetto atteso:

- fino alle 03:00 del 2026-06-20 i palmari possono fiscalizzare sia contanti sia POS;
- dalle 03:00 il job automatico lascia fiscalizzabile solo il POS.

## Ciclo V3 - cancellazione tavolo logica e refresh immediato mobile

Data ciclo: 2026-06-21 21:00 CEST.

Richiesta:

- quando un tavolo viene cancellato da monitor/admin, le comande pagate devono rimanere archiviate;
- le comande non pagate non devono sparire fisicamente dal DB, ma devono essere marcate come cancellate;
- la GUI mobile deve aggiornare subito tavoli/storico dopo il controllo monitor, senza attendere chiusura/riapertura.

Modifiche applicate:

- `backend/modules/status/status.handlers.js`
  - `table_cancel_full` non elimina piu' gli ordini non pagati da `integration.orders`;
  - gli ordini non pagati vengono convertiti in `workflowStatus=cancelled`, `paymentStatus=unpaid`, `paidAmount=0`, `dueAmount=0`;
  - sugli ordini cancellati vengono salvati `tableCancellationId`, `tableCancelledAt`, `tableCancelledByUserId`, `tableCancelledByUsername`, `tableCancellationReason`;
  - i pagamenti completati restano conservati e vengono solo marcati con metadati di cancellazione tavolo;
  - i pagamenti pendenti restano eliminati dal conto operativo del tavolo;
  - `deletedOrderIds` resta vuoto e viene introdotto `cancelledOrderIds`.
- `mobile-frontend/src/pages/home/hooks/useNotificationCenter.ts`
  - gli eventi SSE `refresh` pubblicano anche un evento browser `pos:server-refresh`.
- `mobile-frontend/src/pages/home/tables/TablesWorkspace.tsx`
  - quando arriva `pos:server-refresh` per monitor/tavoli/ordini/layout, vengono invalidati e ricaricati i dati tavoli;
  - in caso di azione monitor vengono ricaricate anche le sale.
- `backend/tests/orders-payments-invariants.test.mjs`
  - aggiunto test che verifica cancellazione tavolo con un ordine pagato e uno non pagato.

Verifiche:

- `node --check backend/modules/status/status.handlers.js`: OK;
- `node --test backend/tests/orders-payments-invariants.test.mjs`: OK, 16/16;
- `npm run check:backend`: OK;
- `npm run test -- src/domain/tables/integrationParsers.test.ts`: OK, 2/2;
- `npm run build` mobile eseguito nel ciclo precedente collegato al refresh: OK;
- bundle mobile servito da V3 verificato: `assets/index-CJ_O3c54.js`.
- backend V3 riavviato manualmente su porta `5281` dopo applicazione patch;
- `GET http://127.0.0.1:5281/api/health`: OK;
- SQLite staging riallineato al JSON attivo con `sync-v3-json-to-sqlite.mjs`;
- checksum sorgente JSON/staging SQLite: `a854e3f52c679133bf1f593880a2af557ff8de2aba583e94d7c9c23f49a45396`.

Invarianti:

- storico pagato preservato;
- storico non pagato preservato come cancellato;
- conto operativo del tavolo azzerato;
- pagamenti completati non vengono duplicati ne' rimossi;
- la GUI mobile riceve un segnale di refresh e non deve dipendere solo dal polling.

## Ciclo V3 - riavvio differito backend ore 02:00

Data ciclo: 2026-06-21 21:03 CEST.

Richiesta:

- non riavviare mentre il sistema e' in uso;
- completare la modifica precedente e programmare il riavvio alle 02:00 di stanotte.

Azioni:

- creato script one-shot `/srv/applicazione/v3/tools/restart-v3-backend-once-20260622-0200.sh`;
- lo script riavvia solo il backend V3 su porta `5281`;
- lo script usa cwd `/srv/applicazione/v3/cassa-frontend`;
- lo script avvia `/usr/local/bin/node backend/server.js` con `NODE_ENV=development` e `PORT=5281`;
- lo script verifica `GET http://127.0.0.1:5281/api/health`;
- a fine esecuzione rimuove da solo la propria riga crontab;
- registrato crontab:
  - `0 2 22 6 * /srv/applicazione/v3/tools/restart-v3-backend-once-20260622-0200.sh # v3-backend-restart-20260622-0200`.

Verifiche:

- `bash -n restart-v3-backend-once-20260622-0200.sh`: OK;
- script eseguibile;
- cron di sistema attivo;
- nessun riavvio eseguito al momento della configurazione.

## Ciclo V3 - fix cancellazione tavolo da mobile admin

Data ciclo: 2026-06-21 21:06 CEST.

Problema segnalato:

- da mobile, dopo login admin, long press su un tavolo, `Cancellazione`, motivazione e conferma sembravano non funzionare;
- il caso non era il monitor desktop, ma il flusso mobile admin.

Diagnosi:

- il mobile chiamava correttamente `POST /api/monitor/control` con `action=table_cancel_full`;
- dopo esito positivo tentava la stampa del ticket di cancellazione;
- se la stampa falliva, la funzione tornava con `printWarning`;
- il workspace mobile mostrava il warning dentro la stessa modale e faceva `return` prima di chiuderla;
- la cache tavoli veniva invalidata con `tablesQueryKey(effectiveRoomId)` senza `effectiveActivityId`, quindi in alcune configurazioni il tavolo restava visivamente non aggiornato.

Modifiche:

- `mobile-frontend/src/pages/home/tables/TablesWorkspace.tsx`
  - dopo cancellazione admin invalida `tablesQueryKey(effectiveRoomId, effectiveActivityId)`;
  - forza `tablesQuery.refetch()` e `roomsQuery.refetch()`;
  - chiude sempre la modale in caso di cancellazione riuscita;
  - se il ticket non stampa, mostra un avviso non bloccante invece di lasciare la cancellazione apparentemente fallita;
  - il popup generico ora ha `aria-label="Avviso"`.

Verifiche:

- nessun riavvio effettuato;
- PID backend V3 invariato: `3741739`;
- PID frontend V3 invariato: `3744505`;
- `npm run test -- src/domain/tables/integrationParsers.test.ts`: OK, 2/2;
- `npm run build` mobile: OK;
- `node --test backend/tests/orders-payments-invariants.test.mjs`: OK, 16/16;
- `GET http://127.0.0.1:5281/api/health`: OK;
- frontend statico V3 serve il nuovo bundle `assets/index-Dw_S6jI2.js`.

Effetto operativo:

- se la cancellazione tavolo riesce, la modale mobile si chiude;
- il tavolo viene ricaricato subito;
- eventuali problemi di stampa del ticket vengono comunicati come warning, ma non annullano l'esito della cancellazione;
- le comande pagate restano archiviate, le non pagate restano marcate come cancellate.

## Ciclo V3 - riavvio immediato e ripristino stampa non fiscale

Data ciclo: 2026-06-21 21:30 CEST.

Richiesta:

- riavviare ora;
- verificare la stampa non fiscale che non stava stampando.

Azioni:

- riavviato il backend V3 tramite `systemctl restart applicazione-backend.service`;
- riavviato il frontend V3 tramite `systemctl restart applicazione-frontends.service`;
- rimosso il cron one-shot delle 02:00 `v3-backend-restart-20260622-0200`, per evitare un secondo riavvio automatico dopo quello immediato;
- verificato che il backend V3 parta con `PRINTING_ENABLED=1` dal file env `/etc/applicazione/pos-v3.env`;
- corretto `backend/server.js` per considerare concluso l'invio TCP 9100 quando `socket.end()` ha flushato i dati, senza attendere indefinitamente la chiusura socket da stampanti che tengono aperta la connessione;
- corretto `backend/modules/reservations/reservations.handlers.js` e `backend/modules/reservations/reservations.routes.js` per rendere `POST /api/pos/reservations/list` read-only: il refresh prenotazioni non deve creare stato, ripulire lock o scrivere il DB;
- ridotto il payload live di `GET /api/integration/orders?station=...&includeDone=1` limitando lo storico `done/paid/delivered` quando la postazione chiede il feed live senza lookup specifici;
- evitato in `reconcileIntegrationPreparationQueue()` il rewrite di `db.integration.orders` quando non ci sono promozioni reali di stato.

Verifiche:

- `node --check /srv/applicazione/v3/cassa-frontend/backend/server.js`: OK;
- `node --check backend/modules/reservations/reservations.handlers.js`: OK;
- `node --check backend/modules/reservations/reservations.routes.js`: OK;
- `node --test backend/tests/reservations-status.e2e.test.mjs`: OK, 2/2;
- `GET http://127.0.0.1:5281/api/health`: OK;
- `GET http://127.0.0.1:5280/`: OK, servizio frontend attivo;
- spool stampa dopo riavvio: `queued=0`, `processing=0`;
- TCP verso la stampante non fiscale `192.168.1.102:9100`: raggiungibile durante la diagnosi.

Stato operativo:

- la stampa non fiscale non risulta piu' bloccata dallo spool;
- i job rimasti in coda sono stati drenati;
- restano alcuni vecchi job in stato `unknown_after_crash`, da trattare come possibile invio gia' avvenuto e ristampa manuale, non come coda bloccante.

Rischi residui:

- il backend puo' ancora mostrare CPU alta quando molti client fanno heartbeat/status, perche' alcuni flussi live (`/api/auth/session/status`, `/api/integration/stations/state`) scrivono ancora il JSON DB completo;
- prossimo intervento consigliato: separare heartbeat, presenza postazioni e stato live volatile dal file `app-state.json`, o almeno aumentare la coalescenza delle scritture;
- e' stata osservata una richiesta mobile a `station=BAR PRINCIPALE`, nome postazione non piu' coerente con la configurazione attuale `BAR-1/BAR-2`: verificare cache/config locale dei device.

## Ciclo V3 - modifica preparata per riduzione scritture heartbeat

Data ciclo: 2026-06-21 21:45 CEST.

Stato rilascio:

- modifica preparata sui sorgenti;
- nessun riavvio effettuato dopo la preparazione;
- servizio attivo ancora con codice caricato prima della modifica;
- la modifica entrera' in funzione solo al prossimo riavvio/deploy esplicito.

Obiettivo:

- ridurre i rallentamenti causati da heartbeat/session status che scrivono troppo spesso il DB JSON completo;
- mantenere comunque live la presenza di mobile e postazioni nel processo backend attivo;
- evitare fix puntuali/hardcoded.

Modifiche preparate:

- `backend/server.js`
  - `touchSessionHeartbeat()` aggiorna sempre `session.lastSeenAt` nella cache in memoria;
  - la funzione ritorna `true` e forza `writeDb()` solo quando cambia un campo persistente o quando e' superato `SESSION_HEARTBEAT_WRITE_MIN_INTERVAL_MS`;
  - `refreshPostazioneStationStateFromSessionHeartbeat()` aggiorna sempre lo stato postazione nella cache in memoria;
  - la persistenza dello stato postazione resta throttled tramite `shouldPersistIntegrationStationHeartbeat()`.
- `backend/tests/auth-session.e2e.test.mjs`
  - aggiunto test per session heartbeat ravvicinato senza rewrite persistente;
  - aggiunto test per heartbeat postazione ravvicinato senza rewrite persistente.

Verifiche eseguite:

- `node --check backend/server.js`: OK;
- `node --check backend/auth/auth.handlers.js`: OK;
- `node --test backend/tests/auth-session.e2e.test.mjs`: OK, 11/11.

Note operative:

- non e' stato toccato il servizio in esecuzione;
- quando si decide di mandarla, serve riavvio backend V3;
- dopo il deploy verificare CPU backend, latenza `POST /api/auth/session/status`, `POST /api/integration/stations/state`, `GET /api/integration/stations/active`;
- se la CPU resta alta, step successivo: separare definitivamente presenza live/heartbeat da `app-state.json`.

## Ciclo V3 - deploy programmato e monitoraggio carico pre-patch

Data ciclo: 2026-06-21 22:08 CEST.

Richiesta:

- mandare la modifica alle `03:00` salvo diversa indicazione;
- continuare monitoraggio per altri 5 minuti;
- valutare possibilita' multicore.

Deploy programmato:

- script one-shot creato: `/srv/applicazione/v3/tools/deploy-heartbeat-write-reduction-20260622-0300.sh`;
- cron registrato:
  - `0 3 22 6 * /srv/applicazione/v3/tools/deploy-heartbeat-write-reduction-20260622-0300.sh # v3-heartbeat-deploy-20260622-0300`;
- lo script esegue:
  - `node --check backend/server.js`;
  - `node --check backend/auth/auth.handlers.js`;
  - `systemctl restart applicazione-backend.service`;
  - health check `GET http://127.0.0.1:5281/api/health`;
  - rimozione automatica della propria riga crontab.

Monitoraggio 5 minuti pre-patch:

- backend V3:
  - CPU media: `50.1%` di 1 core;
  - CPU picco: `119.6%` di 1 core;
  - CPU mediana: `49.2%`;
  - RAM finale: `454.0 MiB`;
  - RAM picco: `665.9 MiB`;
  - file descriptor finali: `25`, picco `31`;
  - connessioni TCP finali: `4`, picco `9`;
  - write I/O totale: `2930.47 MiB`;
  - read I/O totale: `0.00 MiB`;
  - thread: `11`.
- frontend V3:
  - CPU media: `0.0%`;
  - RAM finale: `57.0 MiB`;
  - write I/O: `0.00 MiB`.
- health backend:
  - latenza media: `412.3 ms`;
  - latenza max: `855.7 ms`;
  - mediana: `328.8 ms`;
  - fallimenti: `0/60`.
- macchina:
  - busy medio: `57.7%`;
  - busy max: `89.0%`;
  - iowait medio: `0.21%`;
  - iowait max: `8.48%`;
  - load finale: `2.43 / 3.31 / 3.54`.
- DB JSON:
  - cambi in 5 minuti: `216`;
  - dimensione: `11169853` byte.

Conclusione tecnica:

- il backend non e' solo in attesa: consuma CPU in modo costante quando i client sono attivi;
- la componente dominante osservata e' il ciclo di scrittura/serializzazione dello stato JSON;
- quasi `2.9 GiB` scritti in 5 minuti per un DB da circa `11.17 MB` indicano write amplification elevata;
- la patch heartbeat preparata e programmata e' coerente con il collo di bottiglia osservato.

Nota multicore:

- rendere il backend multicore e' possibile, ma non va fatto prima di separare o disciplinare lo stato condiviso;
- clusterizzare ora piu' processi Node sullo stesso JSON rischia race, cache incoerenti, write amplification maggiore e possibili side effect duplicati;
- stampa, spool e fiscalita' devono restare single-writer o protetti da lock/idempotency forte;
- roadmap consigliata:
  1. applicare patch heartbeat alle `03:00`;
  2. rifare monitoraggio prima/dopo;
  3. spostare presenza live/session heartbeat/postazioni su storage condiviso leggero o tabelle SQLite dedicate;
  4. mantenere spool e fiscale con worker unico/leader lock;
  5. solo dopo abilitare piu' worker API dietro bilanciatore o Node cluster con sessioni/SSE gestite correttamente.

## Ciclo V3 - deploy anticipato patch heartbeat e diagnosi residua

Data ciclo: 2026-06-21 22:45 CEST.

Richiesta:

- eseguire subito il comando previsto alle `03:00`.

Azioni:

- eseguito manualmente `/srv/applicazione/v3/tools/deploy-heartbeat-write-reduction-20260622-0300.sh`;
- backend V3 riavviato;
- health check OK;
- cron one-shot `v3-heartbeat-deploy-20260622-0300` rimosso automaticamente dallo script;
- frontend non riavviato.

Esito deploy:

- PID backend precedente: `3849392`;
- PID backend nuovo: `238916`;
- `GET http://127.0.0.1:5281/api/health`: OK.

Monitoraggio immediato post-deploy:

- primi 30 secondi:
  - CPU media backend: `110.2%`;
  - CPU max backend: `131.9%`;
  - DB changes: `26`;
  - DB size: `11235820` byte.
- dopo assestamento, finestra 60 secondi:
  - CPU media backend: `101.8%`;
  - CPU max backend: `124.0%`;
  - DB changes: `55`;
  - write I/O: `1361.69 MiB`.

Diagnosi residua:

- la patch heartbeat sessione/postazione non e' sufficiente;
- `POST /api/auth/session/status` e soprattutto `POST /api/integration/stations/state` continuano a comparire in `db:mutation` con attese/esecuzioni lunghe;
- `strace` conferma scritture ripetute di `app-state.json.tmp` in blocchi da `524288` byte;
- lo stato attivo contiene una sola postazione reale:
  - `BAR-1`, utente `u_roberto`, device `u_1781282771888_93486825`;
- non risultano comande aperte da riallineare (`openCount=0`), quindi il carico non deriva dal backfill ordini;
- il prossimo fix deve separare nel handler `handleIntegrationStationStateUpsert()` il fast path heartbeat puro dal cambio stato reale.

Fix successivo consigliato:

- se `POST /api/integration/stations/state` arriva da stessa postazione, stesso device, stesso utente, `active=true`, senza pause/transfer/offline e senza cambio impostazioni stampa:
  - aggiornare al massimo la cache in memoria;
  - non eseguire side effect di assegnazione ordini/notifiche;
  - non chiamare `writeDb()`;
  - rispondere con lo stato corrente;
- mantenere invece il percorso mutativo completo per:
  - postazione che passa offline/pausa;
  - cambio operatore/device;
  - trasferimento code;
  - ritorno online dopo stale;
  - cambio preferenze stampa;
  - assegnazione reale di ordini pendenti.

## Ciclo V3 - correzione pagamenti parziali/misti mobile

Data ciclo: 2026-06-21 22:49 CEST.

Problema segnalato:

- dopo sequenze di pagamento miste/parziali il mobile puo' continuare a mostrare un conto aperto ma bloccare il pagamento con residuo non pagabile;
- nel pagamento contanti il campo ricevuto veniva precompilato con l'importo esatto, impedendo il comportamento naturale di inserire il contante ricevuto e calcolare il resto.

Diagnosi:

- il backend mantiene correttamente `paymentStatus`, `paidAmount`, `dueAmount` e `paidArticleUnits`;
- il parser/trasformatore mobile scartava `paidArticleUnits` e non propagava in `DiningTableOrder` i campi finanziari backend;
- il wizard mobile considerava pagabili solo ordini con `state === "served"`, senza usare il residuo backend;
- il pulsante `Riscuoti` della singola comanda passava il totale originale invece del residuo;
- il wizard contanti aveva un effetto che impostava automaticamente `cashReceived = methodAmount`.

Modifiche applicate:

- `mobile-frontend/src/domain/tables/integrationTypes.ts`: aggiunto `paidArticleUnits` a `IntegrationOrder`;
- `mobile-frontend/src/domain/tables/integrationParsers.ts`: parsing/deduplica di `paidArticleUnits`;
- `mobile-frontend/src/domain/tables/integrationOrderTransforms.ts`: preservati `paymentStatus`, `paidAmount`, `dueAmount`, `paidArticleUnits`;
- `mobile-frontend/src/pages/home/tables/components/TablePaymentWizard.tsx`: calcolo pagabilita' basato sul residuo e rimozione autocompilazione contanti;
- `mobile-frontend/src/pages/home/tables/components/TableDetailPanel.tsx`: `Riscuoti` usa il residuo pagabile della comanda.

Test eseguiti:

- `npm run typecheck` in `mobile-frontend`: OK;
- `npx vitest run tests/integrationParsers.test.ts tests/integrationOrderTransforms.test.ts tests/paymentArticleUnits.test.ts tests/paymentBackendPayload.test.ts`: OK, 17 test passati;
- `npm run build` in `mobile-frontend`: OK.

Note operative:

- non e' stato riavviato nessun servizio;
- gli asset aggiornati sono stati generati in `mobile-frontend/dist`;
- per vedere la correzione lato device puo' essere necessario ricaricare il frontend mobile/browser o far riprendere il nuovo bundle servito.

## Ciclo V3 - comande visibili e fast path postazione

Data ciclo: 2026-06-21 22:59 CEST.

Problemi trattati:

- nel dettaglio tavoli/storico, alcune comande pagate non risultavano piu' visibili finche' non veniva ricostruito lo stato;
- la postazione generava scritture e side effect anche su heartbeat equivalenti, contribuendo a code DB e rallentamenti.

Diagnosi comande non visibili:

- `GET /api/integration/orders?includeDone=1&includeTransferred=1&currentSessionOnly=1` tornava vuoto anche con ordini pagati presenti nel DB;
- `buildIntegrationCurrentTableSessions()` trattava `table.settled` come `table.released`;
- il pagamento emette audit `table.settled` con `payload.keptOccupied === true`, cioe' il tavolo resta nella sessione corrente e lo storico ordini deve restare visibile;
- l'esclusione era quindi troppo aggressiva e nascondeva ordini ancora pertinenti alla sessione tavolo.

Fix comande:

- `cassa-frontend/backend/server.js`:
  - in `buildIntegrationCurrentTableSessions()` `table.settled` con `keptOccupied: true` non chiude piu' la sessione corrente;
  - `table.released` continua invece a chiudere la sessione e a nascondere gli ordini della precedente occupazione.

Diagnosi postazione:

- `handleIntegrationStationStateUpsert()` passava nel percorso mutativo completo anche per heartbeat equivalenti;
- `station-states.domain.js` considerava `operatorName` e `operatorRole` nel fingerprint stabile, quindi differenze solo grafiche potevano forzare persistenza e side effect;
- il comportamento desiderato e' che nome/ruolo restino disponibili in UI, ma non obblighino riassegnazioni, backfill o scritture se identita' operatore/device/postazione/stampa non cambiano.

Fix postazione:

- `cassa-frontend/backend/server.js`:
  - aggiunto fast path in `handleIntegrationStationStateUpsert()` per heartbeat attivo della stessa postazione, stesso device e stesso operatore;
  - il fast path evita assegnazione code, notifiche, pruning e `writeDb()` quando non ci sono pause/transfer, sibling attivi o cambi operativi;
  - le transizioni reali offline/pausa/ritorno/cambio device/cambio stampa restano nel percorso mutativo completo.
- `cassa-frontend/backend/modules/integration/station-states.domain.js`:
  - il fingerprint stabile postazione non include piu' `operatorName` e `operatorRole`;
  - restano protetti `station`, `active`, `autoPrintOrders`, `autoPrintPreconto`, identita' utente/device/app e natura reale/demo.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `node --test backend/tests/integration-station-states-domain.test.mjs backend/tests/integration-current-table-session.test.mjs backend/tests/station-pause-transfer.e2e.test.mjs`: OK, 16 test passati.

Deploy e verifica live:

- riavviato `applicazione-backend.service`;
- `GET http://127.0.0.1:5281/api/health`: OK;
- `GET /api/integration/orders?includeDone=1&includeTransferred=1&currentSessionOnly=1`: OK, 7 ordini restituiti (`00283`, `00284`, `00288`, `00303`, `00304`, `00305`, `00307`);
- `GET /api/integration/stations/active`: OK, unica postazione reale attiva `BAR-1` con utente `roberto`;
- log post-riavvio puliti; prima del fix risultavano code lunghe su `POST /api/integration/notifications/ack`, da monitorare nel prossimo ciclo sotto carico reale.

Rischi residui / prossimi controlli:

- verificare sotto traffico reale che `POST /api/integration/stations/state` non generi piu' scritture continue;
- se restano code DB, analizzare `notifications/ack` e stream mobile/postazione come successivo punto caldo;
- mantenere separata la semantica `table.settled keptOccupied` da `table.released`, per evitare regressioni nello storico ordini.

## Ciclo V3 - riduzione riscritture DB JSON

Data ciclo: 2026-06-21 23:24 CEST.

Problema:

- il backend continuava a riscrivere `app-state.json` troppo spesso;
- misurazione iniziale post-fix postazione:
  - `42-45` riscritture/minuto;
  - circa `589-622 MB/minuto` di write I/O;
  - DB circa `11.3 MB`;
  - CPU backend circa `75-107%` durante polling reale.

Diagnosi:

- prima causa: heartbeat sessione/mobile e postazione trascinavano nel JSON aggiornamenti ravvicinati di `lastSeenAt`;
- seconda causa: `stationStates` oscillava tra:
  - solo postazione reale `BAR-1`;
  - postazione reale + placeholder configurati (`BAR-2`, `CHIRINGUITO-1`, `CHIRINGUITO-2`, `MOBILE`, `PIZZA IN RIVA`);
- terza causa minore: migrazione sicurezza aggiornava `meta.lastSecurityMigrationAt` anche quando non rimanevano differenze applicative reali.

Modifiche applicate:

- `cassa-frontend/backend/server.js`:
  - `touchSessionHeartbeat()` ora modifica `session.lastSeenAt` solo quando il heartbeat deve davvero essere persistito;
  - `handleMobileWaiterPauseStatus()` non aggiorna piu' `integration.lastWriteAt` e non pubblica refresh se cambia solo heartbeat;
  - `refreshPostazioneStationStateFromSessionHeartbeat()` non muta `db.integration.stationStates` quando il heartbeat non va persistito;
  - `handleIntegrationStationStates()` usa i placeholder configurati solo per risposta, senza mutare il DB;
  - aggiunta `filterPersistentIntegrationStationStates()` per persistere solo stati reali/demo/attivi e mai placeholder `configuredStation`.
- `cassa-frontend/backend/db/app-state/app-state.repository.js`:
  - aggiunto guardrail di confronto semantico;
  - le scritture JSON vengono saltate se cambiano solo `meta.lastWriteAt`, `meta.lastSecurityMigrationAt` o `integration.lastWriteAt`.
- `cassa-frontend/backend/tests/app-state-repository.test.mjs`:
  - aggiunto test che impedisce future riscritture fisiche per soli timestamp di versione.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `node --test backend/tests/app-state-repository.test.mjs backend/tests/auth-session.e2e.test.mjs backend/tests/integration-station-states-domain.test.mjs backend/tests/station-pause-transfer.e2e.test.mjs`: OK, 31 test passati;
- `node --test backend/tests/app-state-repository.test.mjs backend/tests/auth-session.e2e.test.mjs backend/tests/station-pause-transfer.e2e.test.mjs`: OK, 24 test passati.

Deploy:

- riavviato realmente `applicazione-backend.service` forzando cambio PID;
- PID nuovo verificato: `492717`;
- `GET http://127.0.0.1:5281/api/health`: OK.

Misurazione finale:

- finestra 60 secondi:
  - `dbMtimeChanges`: `4`;
  - write I/O: `45,416,448` byte/minuto;
  - DB stabile: da `11,344,987` a `11,345,043` byte;
  - nessuna oscillazione `stationStates` 1<->6;
  - `stationStates` persistito contiene solo `BAR-1` reale;
  - nessun log `db:mutation` lungo negli ultimi minuti del controllo.

Risultato:

- riscritture ridotte da `42-45/min` a `4/min`;
- write I/O ridotto da circa `589-622 MB/min` a circa `45 MB/min`;
- riduzione stimata write I/O: oltre `92%`;
- le scritture rimaste sono heartbeat persistenti regolari:
  - sessioni ogni circa `60s`;
  - postazione reale ogni circa `45s`.

Rischi residui / prossimi step:

- CPU resta intorno a un core sotto polling reale: non e' piu' principalmente I/O DB, va profilata separatamente su endpoint GET/polling e serializzazione risposte;
- se necessario, prossimo ciclo: cache/ETag o riduzione payload per endpoint caldi (`/api/integration/orders`, layout tavoli, notifiche, menu/stations).

## Ciclo V3 - sale disponibili e storico comande tavolo

Data ciclo: 2026-06-21 23:31 CEST.

Problemi segnalati:

- a volte il mobile non vedeva le sale;
- nel dettaglio tavolo mancavano comande prese/visibili nello storico, soprattutto dopo pagamento o riallineamento layout.

Diagnosi:

- backend live allineato:
  - `/api/integration/layout`: 7 sale, 117 tavoli;
  - sale: `Attesa virtuale`, `Bar`, `Gazebo`, `Pedana`, `Pizza in Riva`, `Spiaggia`, `Terrazza`;
  - utenti: 14, tutti con `enabledRoomIds` e `authorizedRoomIds` completi sulle 7 sale.
- `/api/integration/orders?includeDone=1&includeTransferred=1&currentSessionOnly=1` restituiva correttamente 8 comande correnti:
  - `00283`, `00284`, `00288`, `00303`, `00304`, `00305`, `00307`, `00308`.
- bug mobile identificato:
  - `applyIntegrationOrdersToTables()` scartava le comande `delivered/paid` quando il tavolo risultava `free`;
  - questo era errato perche' il backend aveva gia' filtrato la sessione corrente con `currentSessionOnly=1`;
  - risultato: comande presenti nel backend ma invisibili nello storico tavolo.
- fragilita' sale identificata:
  - cache sale mobile globale `pos_available_rooms_cache_v1`, non per utente;
  - fallback cache solo in DEV;
  - timeout temporaneo su `/api/pos/rooms` poteva lasciare il mobile senza sale invece di usare l'ultima lista reale valida.

Modifiche applicate:

- `mobile-frontend/src/api/tables.ts`:
  - se il tavolo non ha `seatedAt` corrente, il mobile ora mantiene tutte le comande restituite dal backend per quella sessione;
  - resta protetta la nuova sessione: quando il tavolo e' rioccupato, gli ordini piu' vecchi del nuovo `seatedAt` non vengono mostrati.
- `mobile-frontend/src/api/locations.ts`:
  - cache sale reale per utente (`pos_available_rooms_cache_v2:<userId>`);
  - TTL breve di 2 minuti;
  - in caso di backend temporaneamente non disponibile, il mobile puo' usare l'ultima lista sale reale gia' ricevuta per quello stesso utente;
  - nessun fallback statico o mock introdotto.
- `cassa-frontend/backend/modules/pos-rooms/pos-rooms.handlers.js`:
  - fallback difensivo: se le static settings/repository restituiscono zero sale ma `db.posSettings` contiene sale runtime, `/api/pos/rooms` usa il runtime DB.

Test eseguiti:

- `npm run test -- tests/tableSessionHistory.test.ts tests/locationsRoomsCache.test.ts`: OK, 5 test passati;
- `npm run typecheck`: OK;
- `npm run build`: OK, dist mobile aggiornato;
- `node --test backend/tests/integration-current-table-session.test.mjs backend/tests/pos-rooms-handlers.test.mjs`: OK, 3 test passati;
- `node --check backend/modules/pos-rooms/pos-rooms.handlers.js`: OK.

Deploy:

- mobile `dist` rigenerato;
- backend non riavviato in questo ciclo: la protezione dentro `pos-rooms.handlers.js` sara' effettiva al prossimo riavvio del backend.

Rischi residui / prossimi step:

- se il mobile resta aperto con bundle vecchio in cache browser, potrebbe richiedere refresh pagina/app per caricare il nuovo asset;
- il fallback backend sale richiede riavvio servizio per entrare in memoria;
- monitorare se `/api/pos/rooms` ha ancora timeout: se si ripresenta, prossimo step e' profilare `validateSessionContext()` e repository static settings sotto carico.

## Ciclo V3 - lentezza sistema e cache hot backend

Data ciclo: 2026-06-22 CEST.

Problema segnalato:

- sistema molto lento durante uso reale.

Diagnosi:

- servizio backend `applicazione-backend.service` era il principale consumatore CPU;
- client reale `192.168.1.123` / postazione `BAR-1` / utente Roberto generava polling frequente verso:
  - `/api/integration/notifications/pull`;
  - `/api/integration/menu`;
  - `/api/integration/layout`;
  - `/api/integration/stations/active`;
  - `/api/integration/stations/state`;
  - `/api/integration/orders`;
  - `/api/flags`;
  - `/api/integration/waiters`;
- gli heartbeat `POST /api/integration/stations/state` erano serializzati come mutazioni;
- `withDbMutation()` svuotava sempre tutte le cache hot dopo ogni mutazione, anche quando l'heartbeat era `heartbeatOnly` e non scriveva nulla;
- effetto: menu, layout, ordini e stati postazione venivano ricalcolati continuamente invece di usare cache breve.

Modifiche applicate:

- `cassa-frontend/backend/server.js`:
  - `withDbMutation()` accetta `shouldPreserveHotCaches`;
  - il wrapper HTTP passa un predicato basato su `req.__preserveIntegrationHotCaches`;
  - `handleIntegrationStationStateUpsert()` marca gli heartbeat no-op con `req.__preserveIntegrationHotCaches = true`;
  - le cache restano invalidate per vere modifiche: online/offline, pause/trasferimenti, assegnazioni, notifiche o scritture DB.
- `cassa-frontend/dist/assets/cash-menu-availability-bridge.js`:
  - polling disponibilita' menu portato da 3s a 15s.
- `cassa-frontend/dist/assets/cash-settings-live-sync.js`:
  - polling versione impostazioni portato da 3s a 15s.
- `cassa-frontend/backend/tests/integration-hot-cache-invalidation-static.test.mjs`:
  - test statico anti-regressione sul bypass cache per heartbeat no-op.
- `serve-frontends.mjs`:
  - proxy verso backend con `http/https Agent` keep-alive;
  - cache proxy brevissima solo per GET hot non mutativi:
    - `/api/flags`: 1s;
    - `/api/integration/menu`: 2s;
    - `/api/integration/layout`: 1s;
    - `/api/integration/stations/state`: 0,75s;
    - `/api/integration/stations/active`: 0,75s;
    - `/api/integration/waiters`: 0,75s;
  - non vengono cacheati ordini e notifiche per non ritardare il flusso operativo.

Test eseguiti:

- `node --check backend/server.js`: OK;
- `node --test backend/tests/integration-hot-cache-invalidation-static.test.mjs backend/tests/integration-station-states-domain.test.mjs backend/tests/station-pause-transfer.e2e.test.mjs`: OK, 15 test passati;
- `npm run check:backend`: OK;
- `node --check serve-frontends.mjs`: OK;
- `node --test backend/tests/static-proxy.e2e.test.mjs`: OK, 4 test passati.

Deploy:

- backend V3 riavviato con nuovo PID;
- frontends V3 riavviato con nuovo PID;
- i bridge statici alleggeriti saranno caricati dai browser al refresh della postazione.

Misure dopo intervento:

- cache backend effettiva: `/api/integration/layout` e `/api/integration/orders` passano da prima chiamata lenta a cache hit ~1-4ms;
- cache proxy effettiva:
  - primo `/api/integration/menu`: `X-Proxy-Hot-Cache: miss`, poi `hit` ~1-6ms;
  - primo `/api/integration/layout`: `miss`, poi `hit` ~1-3ms;
  - `stations/state`, `waiters`, `flags`: hit ~1-2ms;
- CPU backend scesa indicativamente da 78-90% a 35-40% sotto polling reale;
- nessun log `db:mutation` lento negli ultimi controlli;
- memoria OK, swap non usata.

Rischi residui / prossimi step:

- se un frontend rimane aperto senza refresh, continuera' a usare i vecchi intervalli JS finche' non viene ricaricato;
- resta traffico frequente su ordini/notifiche, volutamente non cacheato in modo aggressivo;
- il carico macchina include un processo VS Code/Electron piu' pesante del backend durante il controllo;
- se serve ulteriore riduzione, prossimo step: deduplica polling ordini lato postazione o passaggio progressivo a stream/SSE per stati live.

## Ciclo V3 - riduzione carico ulteriore e minimo operativo

Data ciclo: 2026-06-22 CEST.

Obiettivo:

- ridurre al minimo il carico senza ritardare comande/notifiche operative e senza cambiare contratti API.

Ulteriore diagnosi:

- `POST /api/auth/session/status` entrava in coda mutazioni anche quando non scriveva nulla;
- quando era no-op, svuotava comunque le cache hot come una mutazione vera;
- il heartbeat sessione persistente era ogni 60 secondi, mentre la presenza operativa usa gia' heartbeat postazione dedicato;
- il proxy vedeva come diverse richieste identiche con cache-buster (`?_=`), quindi la cache proxy non assorbiva abbastanza;
- alcune richieste identiche partivano contemporaneamente da componenti diversi.

Modifiche applicate:

- `cassa-frontend/backend/auth/auth.handlers.js`:
  - `session/status` marca `req.__preserveIntegrationHotCaches = true` quando non scrive DB.
- `cassa-frontend/backend/server.js`:
  - default `SESSION_HEARTBEAT_WRITE_MIN_INTERVAL_MS` portato da 60s a 5 minuti;
  - resta override possibile via env.
- `serve-frontends.mjs`:
  - deduplica in-flight per GET hot:
    - `/api/health`;
    - `/api/flags`;
    - `/api/integration/menu`;
    - `/api/integration/layout`;
    - `/api/integration/stations/state`;
    - `/api/integration/stations/active`;
    - `/api/integration/waiters`;
    - `/api/integration/orders`;
    - `/api/integration/notifications/pull`;
  - normalizzazione chiavi cache rimuovendo cache-buster:
    - `_`, `t`, `ts`, `timestamp`, `cacheBust`, `cachebuster`;
  - TTL proxy non mutativi calibrati:
    - flags 5s;
    - menu 10s;
    - layout 3s;
    - station state/active 1s;
    - waiters 2s;
  - ordini e notifiche restano senza TTL cache lunga: solo deduplica in-flight, quindi niente stato vecchio voluto.
- `backend/tests/integration-hot-cache-invalidation-static.test.mjs`:
  - aggiunto controllo anti-regressione per `session/status` no-op.

Test eseguiti:

- `node --test backend/tests/integration-hot-cache-invalidation-static.test.mjs backend/tests/auth-session.e2e.test.mjs backend/tests/static-proxy.e2e.test.mjs`: OK, 17 test passati;
- `npm run check:backend`: OK;
- `node --check serve-frontends.mjs`: OK.

Deploy:

- backend V3 riavviato, PID aggiornato;
- frontends V3 riavviato, PID aggiornato;
- health backend/proxy OK.

Misure dopo intervento:

- CPU backend durante polling reale scesa progressivamente:
  - prima diagnosi: circa 78-90%;
  - dopo primo cache fix: circa 35-40%;
  - dopo deduplica/cache-buster/session heartbeat: circa 23-25%;
- `TIME_WAIT` verso backend ridotti indicativamente da oltre 500 a circa 275 nella finestra controllata;
- test deduplica ordini: 5 richieste concorrenti a `/api/integration/orders` servite con `X-Proxy-In-Flight: served`;
- test cache-buster: richieste con `_` diverso su menu/layout/flags producono hit proxy.

Rischi residui / prossimi step:

- il carico residuo e' soprattutto polling operativo di ordini/notifiche/stazioni;
- ridurlo ulteriormente richiede intervento lato UI postazione: sostituire polling con stream/SSE o alzare intervalli nel bundle principale minificato;
- evitare cache TTL lunga su ordini/notifiche finche' non si introduce invalidazione/event stream deterministica;
- monitorare durante servizio reale se CPU resta stabile sotto 30%.
## 2026-06-22 - Riepilogo palmari basato su sessione reale fondo cassa

Obiettivo chiarito:

- il riepilogo palmari non deve usare il giorno corrente o una finestra fissa come fonte autoritativa;
- deve coprire l'arco reale che parte dal primo caricamento/fondo cassa di una sessione operativa e termina allo scarico dell'ultimo palmare che aveva fondo cassa attivo;
- la sessione puo' attraversare la mezzanotte, ad esempio apertura il 21 e scarico il 22;
- la stampa automatica deve partire solo quando tutti i palmari con fondo cassa aperto per quella sessione hanno effettuato lo scarico.

Modifiche V3 applicate:

- introdotta collezione persistente `handheldCashSessions` nello stato applicativo;
- aggiunti endpoint autenticati:
  - `POST /api/reports/handheld-session/cash/open`
  - `POST /api/reports/handheld-session/cash/close`
- il mobile registra l'apertura sessione quando viene bloccato il fondo cassa;
- il mobile registra la chiusura sessione dopo la stampa dello scarico cassa;
- `buildHandheldSessionReport()` usa la finestra reale `openedAt` minimo -> `closedAt` massimo quando esistono sessioni fondo cassa;
- il fallback 16:00 -> 02:00 resta solo per compatibilita' e dati storici privi di sessione persistita;
- lo scheduler automatico non stampa piu' a un orario fisso: cerca sessioni chiuse non ancora stampate e usa una `printKey` idempotente legata alla finestra reale.

Test eseguiti:

- `node --test backend/tests/handheld-session-report.test.mjs`: OK, 9/9;
- `node --test backend/tests/handheld-session-report.test.mjs backend/tests/payments-fiscal.e2e.test.mjs`: OK, 16/16;
- `node --test backend/tests/orders-payments-invariants.test.mjs backend/tests/payment-weird-cases.e2e.test.mjs`: OK, 31/31;
- `npm run check:backend`: OK;
- `npm run typecheck` mobile: OK;
- `npm run build` mobile: OK.

Gate non completamente verde:

- `npm run test:backend:release` fallisce sul gate architetturale gia' noto del monolite:
  - `handlePaymentFreeSplit` sopra 750 righe;
  - `handlePayTable` sopra 750 righe.
- il fallimento non e' causato dalla modifica al riepilogo palmari.

Osservazione performance:

- backend V3 campionato intorno al 30% CPU;
- `app-state.json` circa 11 MB;
- processo backend con molti byte scritti dall'avvio, indicazione di carico da riscritture JSON/polling;
- nessun errore applicativo recente nei log backend;
- prossimo intervento consigliato: ridurre write churn separando heartbeat/delivery volatile dal file stato grande o introducendo throttling deterministico e testato.
