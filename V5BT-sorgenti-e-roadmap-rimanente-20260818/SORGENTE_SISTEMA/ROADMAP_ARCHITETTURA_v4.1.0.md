# Roadmap architetturale Sistema Cassa v4.1.0

Data: 2026-06-29

Documento vivo per guidare l'evoluzione architetturale del sistema senza
riscritture rischiose. L'obiettivo e' passare da un monolite operativo molto
ricco a un "modular monolith" robusto, misurabile e pronto a separare alcuni
servizi solo quando il dominio sara' abbastanza stabile.

Aggiornamento Fase O: 2026-07-03.

Questa roadmap resta il documento di governance architetturale. Il filone
esecutivo `ROADMAP_REALTIME_CASSAV4_v4.md` e' stato riconciliato qui: le fasi
K/L/M/N hanno gia' completato o assorbito buona parte dei lavori che in questo
documento erano elencati come Fase 2, Fase 3 e Fase 4. Da questo punto non si
aprono duplicati: i prossimi lavori operativi ripartono da Fase P della roadmap
realtime e questa roadmap architetturale conserva stato, decisioni e criteri.

## Stato attuale sintetico

Sorgente analizzato:

- baseline 2026-06-29: `cassa-frontend/backend/server.js` circa 38.359 righe.
- stato riconciliato 2026-07-03: `cassa-frontend/backend/server.js` 38.773
  righe, sotto budget corrente 39.500 ma ancora sopra il criterio di revisione
  ADR da 15.000 righe.
- Moduli backend gia' presenti: auth, settings, menu, orders, payments,
  automatic-cash, commercial-benefits, radio, notifications, reservations,
  reports, sales-sessions, tables e altri.
- Test backend presenti al 2026-07-03: 134 file `.mjs`.
- Frontend principali: cassa, mobile, postazione, impostazioni, monitor,
  reservation, battery-dashboard.
- Mobile frontend: gia' orientato a sorgente React con policy su API client,
  storage adapter e bridge retirement.
- Persistenza: stato misto tra app-state, SQLite/MySQL split, repository
  puntuali e domini ancora serializzati.
- Integrazioni critiche: stampanti comande/preconti, fiscal gateway, cassa
  automatica, POS, radio, batteria palmari, WebView Android.

### Stato riconciliato da ROADMAP_REALTIME_CASSAV4_v4

Completato o assorbito nel filone realtime:

- Fase 2, parte backbone: migrazione `010_realtime_backbone.sql`,
  `idempotency_keys`, `event_outbox`, repository realtime backbone, drain outbox
  e test `realtime-backbone`/`realtime-event-outbox`.
- Fase 2, parte domini puntuali: ordini, pagamenti/fiscale, prenotazioni,
  table locks, room/table move e print spool hanno repository o split dedicati
  con test mirati; restano fuori dal completamento globale settings, cassa
  automatica, radio e altri domini non inclusi nel perimetro K/L/M/N.
- Fase 3, parte pagamenti/fiscale: write-primary canary per ticket, tavolo,
  free split, fiscal command e fiscal receipts; idempotenza e outbox sui
  percorsi fiscali testati; resta da completare la cassa automatica come
  dominio architetturale pieno.
- Fase 4, parte ordini: state machine ordine, write-primary canary
  create/sync/cancel/correct/comp/events e guardrail di transizione; restano i
  lavori piu' ampi su tavoli/postazioni/load balancing non chiusi da N.
- Fase 4, parte state machine trasversali: pagamenti, ordini e stampa sono ora
  formalizzati con file dedicati, test tabellari e flag canary
  `PAYMENT_STATE_MACHINE_ENABLED`, `ORDER_STATE_MACHINE_ENABLED`,
  `PRINT_STATE_MACHINE_ENABLED`.

Documenti di evidenza nel ramo:

- `cassa-frontend/FASE_N1_PAYMENT_STATE_MACHINE_20260703.md`
- `cassa-frontend/FASE_N2_ORDER_STATE_MACHINE_20260703.md`
- `cassa-frontend/FASE_N3_PRINT_STATE_MACHINE_20260703.md`
- `cassa-frontend/FASE_M4_RUNTIME_METRICS_DASHBOARD_20260702.md`
- `cassa-frontend/FASE_M5_SERVER_MARGIN_REVIEW_20260703.md`
- `cassa-frontend/FASE_M6_PRINT_SPOOL_RETENTION_REVIEW_20260703.md`
- `docs/architecture/ADR-0002-modular-monolith-revision-20260703.md`

## Visione target

Il target non e' spezzare tutto in microservizi subito. Il target corretto per
questa fase e':

- backend modulare con domini chiari e contratti API stabili;
- DB come sorgente autorevole per dati operativi, non app-state largo;
- code indipendenti per domini indipendenti;
- state machine esplicite per ordini, pagamenti, fiscale, cassa automatica,
  radio, stampa e postazioni;
- realtime event-driven per notifiche, batteria, radio e stati postazione;
- adapter isolati per tutti i dispositivi esterni;
- simulatori ufficiali per fiscal, cassa automatica, POS e stampanti;
- frontend source-first, con design system coerente e API client condivisi;
- test di carico, caos e GUI inclusi nel ciclo release.

## Principi non negoziabili

1. Nessun cambio API senza test di compatibilita'.
2. Nessun pagamento duplicato, anche con retry o riconnessione.
3. Nessuna emissione fiscale duplicata.
4. Nessun fallback silenzioso su stampante, RT, gateway o postazione.
5. Nessun ordine pagato deve tornare aperto o non pagato per sync stale.
6. Ogni macchina a stati deve avere transizioni valide, idempotenza e audit.
7. Ogni gateway esterno deve avere adapter reale, adapter simulato e timeout
   dichiarati.
8. Nessuna configurazione operativa hardcoded nel codice applicativo.
9. Le feature nuove devono entrare dietro moduli/domain service, non dentro
   `server.js`.
10. Ogni fase deve avere gate automatici prima di diventare base release.

## Macro-aree di lavoro

### 1. Struttura repository e release

Problema:

- il workspace contiene estrazioni storiche, runtime, backup e sorgenti attivi;
- alcuni asset compilati convivono con sorgenti;
- il packaging rischia di portarsi dietro DB, log o runtime non desiderati.

Target:

- una root release pulita;
- cartelle runtime fuori dal source package;
- manifest release automatico;
- script unico per backup, zip, checksum e verifica contenuti;
- convenzione chiara per versione, APK, sorgente Android e frontend.

Azioni:

- creare `docs/architecture/` per ADR, roadmap, diagrammi e decisioni;
- introdurre `scripts/release-package.mjs` come procedura unica;
- aggiungere gate che fallisce se zip contiene `node_modules`, DB runtime,
  `.print-spool`, log o chiavi/certificati privati;
- separare `runtime-data/` da `source/`.

### 2. Persistenza e DB

Problema:

- alcune operazioni frequenti riscrivono ancora domini larghi;
- parte dello stato e' spezzata in MySQL, parte resta app-state;
- sotto carico i domini serializzati possono creare backlog.

Target:

- schema DB autorevole per ordini, pagamenti, movimenti, configurazioni,
  postazioni, notifiche, radio, battery events, cassa automatica e spool;
- migrazioni versionate;
- repository per dominio;
- outbox transazionale per eventi da pubblicare;
- read model leggero per frontend realtime.

Azioni:

- censire ogni campo ancora letto/scritto da app-state largo;
- creare matrice `dominio -> tabella -> repository -> route -> test`;
- completare split puntuale per `integration.orders`, station states,
  notifications e print spool;
- introdurre una tabella `event_outbox` per eventi realtime e side effect;
- introdurre una tabella `idempotency_keys` condivisa per pagamenti, ordini,
  fiscalita', cassa automatica e stampa;
- rendere le migrazioni parte del bootstrap e del gate release.

Gate:

- nessun write largo per heartbeat, batteria, radio idle o station heartbeat;
- p95 lock tavolo sotto 300 ms;
- p95 battery event sotto 300 ms;
- p95 notifica cameriere/comanda pronta sotto 500 ms in LAN;
- nessun deadlock non gestito nei test di concorrenza.

### 3. Domini e moduli backend

Problema:

- `server.js` resta troppo grande;
- alcuni moduli hanno route ma non possiedono ancora tutta la logica;
- funzioni critiche di pagamento, fiscale, ordini e integrazione sono ancora
  accoppiate.

Target:

```text
backend/
  core/
  db/
  modules/
    orders/
    payments/
    fiscal-pos/
    automatic-cash/
    print-spool/
    radio/
    notifications/
    stations/
    settings/
    commercial-benefits/
  adapters/
    fiscal/
    automatic-cash/
    printer/
    pos/
    android/
  realtime/
  observability/
```

Azioni prioritarie:

- estrarre prima funzioni pure, poi service, poi handler HTTP;
- completare `modules/print-spool` e `modules/fiscal-pos`;
- completare `modules/payments` con service transazionale e state machine;
- completare `modules/orders` con state machine ordine e repository puntuale;
- spostare radio/notifiche in moduli con event broker condiviso;
- aggiungere test statico che impedisce nuove route mutative non dichiarate.

Gate:

- ogni modulo espone `routes`, `handlers`, `domain`, `service` quando serve;
- nessun modulo importa `server.js`;
- ogni handler mutativo dichiara idempotenza o motivo di esclusione;
- ogni route POST read-only dichiara esplicitamente il motivo.

### 4. State machine e concorrenza

Problema:

- il sistema gestisce flussi delicati: ordini, pagamenti, fiscale, cassa
  automatica, spostamenti tavolo, radio e scarichi;
- alcune transizioni sono protette da logica distribuita nei handler;
- i retry da rete o gateway possono creare stati intermedi difficili.

Target:

- state machine pure e testate per ogni dominio critico;
- transizioni atomiche con lock logico o transazione DB;
- retry idempotenti;
- resume delle procedure da parte di owner/admin;
- audit completo ma non bloccante.

State machine da formalizzare:

- ordine: draft, emitted, queued, preparing, ready, delivered, partially paid,
  paid, cancelled, corrected, compensated;
- pagamento: created, pending provider, authorized, settled, fiscal queued,
  fiscal ok, fiscal ko retryable, fiscal ko expired, reversed;
- cassa automatica: requested, gateway accepted, cash inserted, change ready,
  user confirm, ticket queued, completed, cancelled, failed, resumable;
- stampa: queued, claimed, sent, confirmed, failed retryable, failed final;
- radio: idle, requested, blocked busy, transmitting, ending, cooldown;
- postazione: offline, online, active, paused, draining, unavailable.

Azioni:

- creare file `*-state-machine.js` per ogni dominio;
- aggiungere test tabellari per transizioni valide/non valide;
- introdurre lock per risorsa: `tableId`, `orderId`, `paymentId`,
  `gatewaySessionId`, `printerId`, `channelId`;
- standardizzare `requestId`/`idempotencyKey` in tutte le mutazioni.

### 5. Realtime, radio, notifiche e batteria

Problema:

- notifiche e radio devono essere quasi realtime;
- batteria deve aggiornarsi su evento, non per polling pesante;
- radio/audio non deve lasciare output o rumore quando non trasmette;
- piu' canali e piu' device richiedono arbitraggio rapido.

Target:

- event bus backend unico;
- canali WebSocket/SSE con subscribe per dominio;
- snapshot iniziale + eventi incrementali;
- radio signaling separato da audio;
- batteria event-driven da WebView/Android verso backend;
- backpressure e dedupe eventi.

Azioni:

- creare `backend/realtime/event-bus.js`;
- creare `backend/realtime/subscriptions.js`;
- usare outbox DB per eventi persistenti e memoria per eventi transient;
- route/eventi per:
  - `notifications.waiter_call`
  - `notifications.order_ready`
  - `battery.changed`
  - `station.online_changed`
  - `radio.channel_busy`
  - `radio.tx_started`
  - `radio.tx_ended`
- togliere polling completo dove basta patch event;
- bloccare TX radio gia' al touch/long-press se canale occupato;
- chiudere sempre AudioContext/stream quando non serve.

Gate:

- notifica pronta/cameriere p95 sotto 500 ms;
- radio busy feedback sotto 150 ms;
- aggiornamento batteria su cambio percentuale/carica sotto 500 ms;
- nessun audio output attivo in idle dopo 5 secondi.

### 6. Gateway esterni e dispositivi

Problema:

- fiscal, cassa automatica, POS e stampanti sono dispositivi con latenza,
  timeout, errori e stati propri;
- serve poter testare senza hardware reale;
- alcuni errori oggi possono essere mostrati con messaggi troppo generici.

Target:

- adapter per ogni device;
- simulatore ufficiale per ogni device;
- health check separato da operazione;
- error mapping user-friendly;
- stato gateway persistente e auditabile;
- riconciliazione post-disconnessione.

Azioni:

- creare `adapters/fiscal`, `adapters/automatic-cash`, `adapters/printer`,
  `adapters/pos`;
- introdurre contract test per ogni adapter;
- simulatore cassa automatica con importi in centesimi, non float;
- simulatori stampante/fiscale in test di carico;
- distinguere errori:
  - QR gia' usato/non valido;
  - gateway non raggiungibile;
  - gateway occupato;
  - gateway ha completato ma ticket non stampato;
  - operazione cancellata localmente.

Gate:

- nessun test P1 usa hardware reale di default;
- tutti i gateway hanno `timeoutMs`, retry policy e circuit breaker;
- report scarico/fondo cassa non inventa categorie non tracciate.

### 7. Frontend e design system

Problema:

- alcuni frontend sono sorgenti, altri sono dist statici o asset custom;
- UI e modali sono cresciute con fix rapidi;
- API endpoint raw possono restare sparsi nei componenti.

Target:

- mobile, cassa, postazione, impostazioni e monitor con ownership sorgente;
- design tokens condivisi;
- componenti comuni per modal, confirm/cancel, close button, small button,
  card, status pill, payment method row;
- API client per dominio;
- storage adapter unico per preferenze utente/device.

Azioni:

- creare `shared-ui` minimale o convenzione CSS condivisa;
- inventario modali e pulsanti per uniformare close/confirm/cancel;
- rimuovere textarea resizable con classe condivisa;
- spostare endpoint raw in domain client;
- salvare preferenze per utente/device con schema chiaro;
- settings reale per configurazioni globali, mobile solo preferenze utente.

Gate:

- visual regression su mobile/cassa/impostazioni/postazione;
- nessuna modale senza close coerente;
- nessun endpoint raw nuovo nei componenti;
- dark/light mode verificati per componenti critici.

### 8. Osservabilita', load test e qualita'

Problema:

- sono gia' presenti script di mega test, ma serve renderli parte stabile del
  ciclo release;
- bisogna confrontare drift tra inizio e fine run;
- servono metriche per backlog, code, DB, latenza gateway e realtime.

Target:

- dashboard metriche locali;
- report automatico JSON + PDF;
- test breve, medio, full e endurance;
- soglie dichiarate per merge/release;
- simulazione device ripetibile.

Metriche minime:

- p50/p95/p99 per route principali;
- backlog code per dominio;
- durata transazioni DB;
- deadlock/retry;
- memoria/CPU backend;
- latenza evento realtime;
- latenza gateway;
- drift tra primi e ultimi 5% eventi;
- code stampa/fiscale aperte, retry e fallimenti.

Azioni:

- standardizzare output di `mega-sim-*` e `endurance-sim-*`;
- aggiungere `scripts/architecture-health-report.mjs`;
- aggiungere report PDF unico per endurance;
- creare dataset scenario P0/P1/P2;
- aggiungere test chaos: backend slow, gateway offline, reconnessione device,
  stampa simulata offline/online, fiscale ko/retry.

Gate release:

- smoke 10 device;
- medium 50 device + 10 postazioni;
- full 100 device + 50 postazioni simulati;
- endurance minimo 90 minuti prima di release importante;
- zero regressioni P0/P1.

### 9. Sicurezza e configurazione

Problema:

- molte route devono restare disponibili in LAN ma non devono diventare
  mutazioni pubbliche accidentali;
- configurazioni gateway/IP/porte cambiano spesso;
- serve evitare segreti nel repository.

Target:

- configurazione centralizzata e validata;
- profili ambiente: dev, lan, staging, production;
- secret fuori dal source;
- route policy bloccante;
- audit security automatico.

Azioni:

- consolidare `core/config.js`;
- creare schema env/config con validazione;
- introdurre `/api/configuration/effective` solo per admin;
- mantenere gate `architecture-security`;
- aggiungere test su mutazioni pubbliche, max body size e permessi.

Gate:

- nessun IP operativo hardcoded fuori config/DB;
- nessuna password o token in zip source;
- ogni route mutativa ha policy esplicita.

## Fasi operative

### Fase 0 - Baseline v4.1.0

Durata stimata: 1-2 giorni.

Deliverable:

- metriche aggiornate monolite/moduli/test;
- mappa route e handler;
- mappa DB e domini;
- lista device/gateway configurati;
- report debiti P0/P1.

Comandi/gate:

```bash
cd cassa-frontend
npm run check:backend
npm run audit:architecture-security
npm run gate:architecture-security
node --test backend/tests/route-policy-architecture.test.mjs
node --test backend/tests/security-architecture.test.mjs
```

### Fase 1 - Guardrail e packaging

Durata stimata: 2-4 giorni.

Deliverable:

- script package unico;
- gate zip pulito;
- ADR iniziali in `docs/architecture`;
- controllo no runtime DB/log in release;
- checklist release v4.1.x.

### Fase 2 - Persistenza puntuale e outbox

Durata stimata: 1-2 settimane.

Stato riconciliato 2026-07-03:

- completata per backbone realtime, `idempotency_keys`, `event_outbox`,
  pagamenti/fiscale write-primary e ordini write-primary canary;
- parziale per gli altri domini elencati nel target originale;
- il lavoro residuo non va duplicato qui: viene portato nella validazione P e
  nei backlog successivi solo se emerso da test/endurance.

Deliverable:

- matrice domini/tabelle/repository;
- outbox eventi;
- idempotency table condivisa;
- fast path definitivi per batteria, station heartbeat e notifiche;
- riduzione write app-state largo.

### Fase 3 - Pagamenti, fiscale e cassa automatica

Durata stimata: 2-3 settimane.

Stato riconciliato 2026-07-03:

- pagamenti e fiscale: completati per il perimetro K della roadmap realtime,
  con write-primary canary, idempotenza, outbox, retry fiscale e boundary di
  ottimismo fiscale testati;
- cassa automatica: non marcata completata da questa riconciliazione; restano
  adapter/procedura/reportistica da validare nei test P o in backlog dedicato;
- nessuna nuova fase parallela viene aperta qui.

Deliverable:

- state machine pagamenti;
- service fiscal POS;
- service automatic cash;
- adapter/simulatore cassa automatica;
- report scarico/fondo cassa coerente;
- resume procedura owner/admin;
- test doppio pagamento, retry fiscale, annulla/riprendi.

### Fase 4 - Ordini, tavoli, postazioni e load balancing

Durata stimata: 2-3 settimane.

Stato riconciliato 2026-07-03:

- ordini: completati per state machine e write-primary canary principali;
- tavoli, postazioni e load balancing: non marcati completati in blocco; restano
  soggetti a verifica nella validazione P e nei test di caos/concorrenza.

Deliverable:

- state machine ordini;
- repository order per `orderId`;
- table move/room move service;
- station state service;
- load balancer con cause diagnostiche;
- test su sposta/unisci/dividi/acorpa/annulla/storno/sostituzione.

### Fase 5 - Realtime radio/notifiche/batteria

Durata stimata: 1-2 settimane.

Deliverable:

- event bus unico;
- subscribe snapshot + patch;
- radio busy preflight;
- AudioContext lifecycle testato;
- battery event ingest;
- notifiche waiter/order-ready con p95 misurato.

### Fase 6 - Frontend source-first e design system

Durata stimata: 2-4 settimane.

Deliverable:

- componenti comuni modali/pulsanti/card;
- API client per dominio;
- storage adapter per preferenze utente/device;
- settings globali separati da preferenze mobile;
- visual regression per light/dark mode.

### Fase 7 - Endurance e readiness produzione

Durata stimata: continuativa.

Deliverable:

- run 90 minuti ripetibile;
- report PDF;
- drift analysis;
- simulazione 100 device + 50 postazioni;
- simulatori device/gateway di default;
- checklist go/no-go.

## Primo backlog consigliato

Stato riconciliato 2026-07-03:

1. Creare `docs/architecture/ADR-0001-modular-monolith.md` - completato.
2. Creare script metriche `architecture-health-report.mjs` - sostituito nel
   filone realtime da dashboard runtime e report M4.
3. Generare mappa route/handler e salvarla in JSON - coperto dai gate
   route-policy/architettura, da aggiornare solo se serve un export JSON.
4. Censire tutti i write larghi su app-state - parziale, continuare solo sui
   domini non migrati.
5. Definire schema `idempotency_keys` - completato con migrazione 010.
6. Definire schema `event_outbox` - completato con migrazione 010.
7. Estrarre `print-spool` e `fiscal-pos` come prossimi moduli P0 - parziale,
   moduli presenti e ampliati; handler ancora in parte nel monolite.
8. Formalizzare state machine `payments` e `automatic-cash` - pagamenti
   completati; cassa automatica resta da fare.
9. Creare adapter simulati ufficiali per printer/fiscal/automatic cash/POS -
   parziale, da validare in Fase P.
10. Aggiungere gate packaging per evitare DB/log/runtime nello zip - gia'
    gestito nei flussi di packaging, da consolidare se si riapre release.

## Soglie iniziali

Le soglie vanno confermate con i prossimi test reali, ma il target iniziale e':

- login mobile p95 sotto 1s in LAN;
- lock tavolo p95 sotto 300 ms;
- order create corto p95 sotto 800 ms;
- order sync ready/delivered p95 sotto 1.5s;
- pagamento senza stampa reale p95 sotto 1s;
- notifica cameriere/comanda pronta p95 sotto 500 ms;
- battery event p95 sotto 500 ms;
- radio busy feedback sotto 150 ms;
- zero doppie emissioni fiscali;
- zero doppi pagamenti;
- zero fallback stampante/RT/gateway non configurato.

## Decisione architetturale iniziale

Per v4.1.x il sistema deve restare un modular monolith con DB autorevole e
adapter esterni isolati. La separazione in servizi indipendenti va rimandata
finche' non saranno stabili:

- confini dei domini;
- schema DB;
- state machine;
- event outbox;
- simulatori;
- test di carico.

Questo permette di migliorare affidabilita' e prestazioni subito, senza
aggiungere complessita' di rete tra servizi in una fase in cui i flussi POS
sono ancora in forte evoluzione.
