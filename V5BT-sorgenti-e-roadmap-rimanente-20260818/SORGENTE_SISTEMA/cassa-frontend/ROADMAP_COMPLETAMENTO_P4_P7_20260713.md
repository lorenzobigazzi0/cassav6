# CASSAv4 - Roadmap di completamento P4-P7

Data snapshot: 2026-07-14

## Scopo

Questo documento accompagna il sorgente destinato al refactor e descrive lo
stato reale del programma di validazione, il lavoro ancora aperto e i gate da
superare prima del rilascio commerciale.

La roadmap v5 originale resta il riferimento per le soglie. Le indicazioni
qui sotto ne aggiornano lo stato sulla base dei test eseguiti fino al
2026-07-14 sul Raspberry target.

## Stato sintetico

- P3: chiusa, gate intermedio verde.
- P4: correttezza multiprocesso verde, prestazioni load-100 rosse.
- P5: non eseguita nella durata richiesta di 90 minuti.
- P6: non eseguita come campagna chaos completa.
- P7: non avviata; dipende da P4, P5 e P6 verdi.

Stima complessiva della roadmap A-P: 83-85%. Il codice funzionale e piu
avanti della validazione commerciale: il residuo e concentrato nei gate di
prestazione, endurance, recovery e rilascio.

## Topologia target verificata

- frontend HTTPS e proxy: `0.0.0.0:5280`;
- backend owner: `127.0.0.1:5281`;
- realtime/SSE: `127.0.0.1:5282`;
- API worker: `127.0.0.1:5283` e `127.0.0.1:5284`;
- worker lock tavoli: `127.0.0.1:5285`;
- MariaDB, SQLite relazionale, Redis e MQTT disponibili;
- quattro core Raspberry disponibili allo scheduler;
- worker lock con pool MySQL 8, pool Redis 4 e tombstone lock attive.

Per tutti i test P4-P6 devono restare attivi i guardrail:

```text
PRINTING_ENABLED=0 oppure stampante mock loopback
POS_FISCAL_API_BASE_URL=http://127.0.0.1:9290
AUTOMATIC_CASH_GATEWAY_BASE_URL=http://127.0.0.1:9190
AUTOMATIC_CASH_REAL_ENABLED=0
I/O non-loopback vietato dal runner
```

Nessun test di carico deve usare stampante, fiscale o cassa automatica reali.

## Ultimo test P4 disponibile

Test: `realistic_preflight14_20260712_1700`.

Configurazione:

- 20 palmari API, 4 postazioni API;
- 3 frontend mobile reali Playwright e 1 frontend postazione reale;
- 20 client SSE e 20 client radio;
- fiscale, quattro stampanti, cassa automatica e batteria simulati;
- due API worker e un worker lock tavoli dedicato;
- durata 162 secondi, 240 operazioni business e 1.065 richieste HTTP.

Risultati principali:

| Metrica | Risultato |
| --- | ---: |
| HTTP p50/p95/p98/p99/p99.9/max | 31/292/430/582/1319/1471 ms |
| SSE connessi | 20/20 |
| SSE lag p50/p95/p99/p99.9 | 128/249/268/438 ms |
| Comande confermate | 40/40 |
| Altre azioni | 200/200 |
| `order.create` p50/p95 | 67/165 ms |
| `payment.free_split` p50/p95 | 66/297 ms |
| `notification.waiter` p50/p95 | 173/1019 ms |
| `layout.get` p50/p95 | 172/717 ms |
| Errori HTTP inattesi | 0 |
| Outbox/print/fiscale al drain | 0/0/0 |

Correttezza e recovery migliorate rispetto al preflight precedente:

- riconnessione mobile 3/3;
- riconnessione postazione 1/1;
- login postazione e pulizia auth storage 1/1;
- zero anomalie registrate nel campione finale;
- zero HTTP 4xx/5xx nelle quattro GUI reali.

Restano da classificare prima del gate finale:

- correzione prezzo/varianti/note: 6/7 esiti accettati;
- reso con o senza sostituzione: 5/8 esiti accettati;
- 250 messaggi console nella GUI postazione, pur con zero HTTP 4xx/5xx;
- notifica cameriere p95 1.019 ms, oltre il gate di 500 ms;
- pagamento free split p95 297 ms, oltre il gate di 200 ms.

I file integrali del test sono allegati al pacchetto in
`P4_P7_HANDOVER/test-p4-latest-realistic-preflight14/`.

## Ultimo gate load-100

Il run `p4_targeted_lock_load100_r2_20260712` usa 100 palmari, 10 postazioni,
5 GUI reali e 100 SSE. Ha concluso senza errori applicativi, duplicati o code
residue, ma non supera il gate prestazionale:

| Metrica | Risultato | Gate |
| --- | ---: | ---: |
| HTTP p50/p95/p99/p99.9 | 400/7998/20518/29395 ms | n/d |
| `order.create` p95 | 8941 ms | <300 ms |
| SSE p95 | 1085 ms | <500 ms |
| doppi pagamenti/fiscali | 0/0 | 0/0 |
| outbox/print/fiscale al drain | 0/0/0 | 0/0/0 |

Il lookup lock puntuale ha ridotto il volume delle query ma non i round trip e
non e stato promosso nel runtime. Il flag
`BACKEND_ORDER_CREATE_TARGETED_LOCK_REFRESH` deve restare OFF finche un nuovo
A/B non dimostra un miglioramento stabile.

I file del gate sono allegati in
`P4_P7_HANDOVER/test-p4-gate-load100-r2/`.

## P4 - Lavoro ancora aperto

### P4.1 - Congelare baseline e guardrail

1. Verificare che il target usi due API worker, non quattro.
2. Verificare tombstone, pool MySQL 8 e pool Redis 4.
3. Verificare simulatori loopback e blocco I/O non-loopback.
4. Salvare configurazione effettiva, hash del release e metriche iniziali.
5. Eseguire smoke 20 device prima di ogni A/B.

DoD: baseline ripetibile, servizi live ripristinati dopo il runner e nessuna
richiesta a hardware reale.

### P4.2 - Ridurre i round trip nel percorso create

Stato codice al 2026-07-13: telemetria create-specifica e refresh paralleli
sono implementati dietro `BACKEND_ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH=1`,
default OFF. Test locali e canary A/B 20/50 sono completati: il p95 create
migliora in entrambi e correttezza/drain restano verdi; la coda p99 va ancora
verificata. I load-100 restano bloccati dalle attivita P4.3-P4.5. Dettagli in
`cassa-frontend/FASE_P4_2_ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH_20260713.md`.

Prossimo intervento raccomandato dall'ultimo A/B:

1. Conservare il flag parallelo default OFF fino al gate load-100.
2. Avviare P4.3 dagli endpoint owner-bound fuori soglia, senza duplicare regole
   di dominio tra route e worker.
3. Classificare gli errori console prodotti dai blackout GUI simulati.
4. Eseguire i due load-100 soltanto dopo P4.3-P4.5, includendo il controllo p99
   create e il monitor RSS/CPU sul target Linux.

DoD: riduzione stabile del p95 create su due canary senza errori, duplicati,
lock fantasma o incremento del p95 SSE.

### P4.3 - Ridurre le scritture condivise owner-bound

Il load-100 mostra code lunghe anche fuori dagli ordini. Applicare il
`PLAYBOOK_DOMAIN_WRITE_AUDIT.md` in quest'ordine:

1. prenotazioni create/status;
2. tavoli, cambio sala e spostamenti;
3. waiter pause/start/stop;
4. pagamenti free split;
5. notifiche cameriere/comanda pronta.

Stato al 2026-07-13: l'audit prenotazioni conferma che create/status usano gia'
lane e dirty write P3.16 e non sono il costo dominante dell'ultimo canary. Il
primo endpoint tavoli, `POST /api/integration/layout/table/sync`, dispone ora
di write puntuale sincrono dietro `BACKEND_TABLE_SYNC_APP_STATE_FASTPATH=1`,
default OFF, con fallback completo prima di ogni write quando cambiano
prenotazioni/gruppi. I canary A/B 20/50 sono verdi: a 50 device il p95 scende
da 3588 a 1216 ms e il p99 da 5465 a 1335 ms, con 22/22 fast write, zero
fallback, zero failure e drain completo. Dettagli in
`cassa-frontend/FASE_P4_3_TABLE_SYNC_PUNCTUAL_WRITE_20260713.md`.

Il secondo endpoint selezionato e'
`POST /api/integration/layout/table/room-move/request`. La write puntuale e'
implementata dietro `BACKEND_TABLE_ROOM_MOVE_REQUEST_APP_STATE_FASTPATH=1`,
default OFF, con guard sul prune e fallback completo prima di ogni write. I
canary confermano correttezza, 7/7 fast write e zero fallback nei target, ma il
gate prestazionale non e' superato: a 50 device il p95 passa da 1555 a 2939 ms
per maggiore wait nella room lane, pur con run medio in calo da 50,43 a
44,57 ms. Il flag non va promosso. Dettagli in
`cassa-frontend/FASE_P4_3_TABLE_ROOM_MOVE_REQUEST_PUNCTUAL_WRITE_20260713.md`.

La misura separata dei rami direct e pending di
`POST /api/pos/room-change/request` e' completata. I canary 20/50 con 12 probe
sono verdi e mostrano che il costo dominante e' il wait nella room lane: a 50
device 514,32 ms medi per direct e 829,62 ms per pending. Il repository
relazionale pending pesa invece 0,85 ms medi. Non viene introdotta una write
puntuale room-change. Dettagli in
`cassa-frontend/FASE_P4_3_ROOM_CHANGE_BRANCH_MEASUREMENT_20260713.md`.

L'A/B della concorrenza keyed room lane 1/2 e' completato. I guardrail
confermano la serializzazione per stessa chiave utente, sala o tavolo e tutti i
canary sono funzionalmente verdi. Il gate prestazionale fallisce: a 20 device
peggiorano p95/p99 globali; a 50 device pending p95 passa da 2722 a 9848 ms e
il wait massimo da 2753 a 9621 ms. Concurrency 2 non viene promossa; fallback
backend e runner stabile sono allineati a 1. Dettagli in
`cassa-frontend/FASE_P4_3_ROOM_LANE_CONCURRENCY_AB_20260713.md`.

La misura di `POST /api/pos/room-change/approve` e' completata. Nei canary
validi 20/50 il PIN sincrono pesa 169-182 ms medi, il mirror app-state 80-165
ms e il delete relazionale 0,83-1,33 ms. Il PIN usa `scryptSync` dentro la room
lane; il writer puntuale corrente non puo invece eliminare richiesta e
aggiornare sessione/utente in una sola transazione. Dettagli in
`cassa-frontend/FASE_P4_3_ROOM_CHANGE_APPROVE_MEASUREMENT_20260713.md`.

L'A/B del PIN asincrono pre-lane e' completato dietro
`BACKEND_POS_ROOM_CHANGE_APPROVE_ASYNC_PIN_PRELANE=1`, default OFF. La prova e'
request-scoped, non serializzabile e viene accettata dentro la lane solo dopo
la rivalidazione di id, username, hash PIN e ruolo. I canary 20/50 sono
funzionalmente verdi. Il p95 approve passa da 1028 a 698 ms a 20 device e da
2334 a 1375 ms a 50; a 50 migliorano anche p95/p99 globali da 1487/4260 a
1270/2580 ms. L'event loop non resta piu' bloccato da scrypt, ma il benchmark
mostra circa 20-25% di CPU totale in piu'; il flag non viene promosso a default
ON prima del load-100 e della misura sul target Linux. Dettagli in
`cassa-frontend/FASE_P4_3_ROOM_CHANGE_APPROVE_ASYNC_PIN_PRELANE_AB_20260713.md`.

L'audit del writer atomico `room-change/approve` e' completato con esito NO-GO:
la pending e' posseduta da SQLite, mentre sessione, utente e mirror pending sono
scritti in transazioni MySQL autonome. Comporre i repository esistenti non
produrrebbe un singolo commit. Durante l'audit e' stata corretta la dichiarazione
dirty della route includendo `users`, necessaria per persistere
`lastSelectedRoom*`. Per ottenere atomicita reale occorre prima migrare la
pending a MySQL e introdurre repository connection-bound; non viene aggiunto un
fast path prematuro. Dettagli in
`cassa-frontend/FASE_P4_3_ROOM_CHANGE_APPROVE_ATOMIC_WRITER_AUDIT_20260713.md`.

Room-change e' quindi chiuso per questo passaggio.

L'audit `waiter pause/start/stop` e' completato. Il canary ha corretto una
divergenza multi-processo instradando anche `status` all'owner e ha confermato
idempotenza concorrente 6/6, recovery dopo restart e fan-out SSE sotto 500 ms.
Il sync puntuale della sola sessione e del solo audit e' disponibile dietro
`BACKEND_WAITER_PAUSE_SESSION_AUDIT_FASTPATH=1`, default OFF: a 50 device il
costo medio write scende da 417,9 a 188,9 ms sullo start e da 302,6 a 120,4 ms
sullo stop, senza errori waiter e con drain completo. Un precedente tentativo
bulk dei campi integration e' stato respinto per conflitti MySQL e rimosso dalla
soluzione. Dettagli in
`cassa-frontend/FASE_P4_3_WAITER_PAUSE_WRITE_AUDIT_20260714.md`.

Il mirror durevole di `payment.free_split` e' implementato e validato sotto
flag default OFF. Il job idempotente viene inserito nella stessa transazione
relazionale del pagamento, poi consumato post-commit con lease, retry, reclaim
startup e drain. Il payload e' compatto e gli upsert dei record economici sono
puntuali. Lo skip `posSettings.tables` e' consentito solo con read-primary
tavoli/layout e `tableStates` externalized. Test locale e ARM: 165/165.

I canary 20/50 completano 8/8 e 15/15 mirror, senza duplicati o residui; a 50
compare un deadlock transitorio recuperato. Il p95 sonda passa da 830 a 495 ms
a 20 e da 6.026 a 3.237 ms a 50, ma resta sopra il gate di 200 ms. A 50 la
payment lane wait pesa 1.574,73 ms medi, domain prepare 452,40 ms e il commit
relazionale solo 20,27 ms. Il consumer usa ancora `readDb`, muta il `dbCache`
owner e compete nella payment lane: i flag non vanno promossi. Dettagli in
`cassa-frontend/FASE_P4_3_PAYMENT_FREE_SPLIT_DURABLE_MIRROR_20260714.md`.

Aggiornamento 2026-07-14: il consumer stateless e' completato. Non usa
`readDb`, `dbCache` o payment lane; costruisce snapshot posizionali minimi da
payload e ordini relazionali e persiste per ID. Anche il falso 401 dei report
e' risolto riusando il contesto auth middleware. Test locale e ARM: 174/174.

Il canary finale 50 chiude con zero failure, 13/13 mirror completati, zero
fallback/legacy/residui e un retry MySQL recuperato. La sonda free-split e'
216/1.860 ms p50/p95; rispetto al durable migliora dell'83,4%/42,5%, ma resta
sopra il gate p95 di 200 ms. Il nuovo breakdown indica `domain.prepare`
309,46 ms medi e upsert mirror ordini 282,57 ms medi. Dettagli in
`cassa-frontend/FASE_P4_3_PAYMENT_FREE_SPLIT_STATELESS_MIRROR_20260714.md`.

Aggiornamento 2026-07-14: il profilo CPU ARM ha individuato normalizzazioni POS
ripetute nel `domain.prepare`. Il riuso del contesto sanificato e' implementato
dietro `BACKEND_PAYMENT_FREE_SPLIT_SETTINGS_REUSE=1`, default OFF. Test locali
e ARM sono verdi anche col flag attivo. Nell'A/B 20 il p95 sonda scende da 587
a 329 ms, il p95 globale da 587 a 417 ms e `domain.prepare` medio da 93,14 a
87,17 ms, senza failure, duplicati o residui. Il gate 200 ms resta rosso, quindi
non e' stato eseguito il canary 50 e il flag non e' promosso. Dettagli in
`cassa-frontend/FASE_P4_3_PAYMENT_FREE_SPLIT_SETTINGS_REUSE_AB_20260714.md`.

Prossimo intervento P4.3: batch atomico di `integration.orders`,
`integration.lastWriteAt` e station index del mirror, poi nuovo A/B 20. Passare
a 50 solo dopo due run consecutivi con p95 sonda <200 ms. Non aumentare la
concorrenza lane e non spostare la route su un payment worker prima del gate.

Per ogni dominio:

- misurare wait e run separatamente;
- evitare rewrite full-domain per modifiche puntuali;
- usare write-primary o dirty split gia disponibili;
- non spostare l'ACK prima della scrittura durevole;
- aggiungere idempotenza e crash recovery se si introduce async work;
- mantenere un flag di rollback singolo.

DoD: nessun dominio produce app-state write p95 sopra il proprio budget e le
code tornano a zero senza retry crescente.

### P4.4 - Chiusura notifiche e realtime

1. Separare tempo publish, commit outbox, pickup gateway e delivery SSE.
2. Verificare che il fan-out non serializzi lo stesso payload per client.
3. Verificare fallback target: se il mittente non e online, consegna a un
   utente online senza duplicare l'evento.
4. Verificare ritiro ordine: ACK di un palmare cancella la notifica sugli altri.
5. Ripetere waiter call e comanda pronta con 20, 50 e 100 SSE.

DoD: notifiche e comanda pronta p95 <500 ms su due load-100 consecutivi.

### P4.5 - Chiusura funzionale degli edge case

1. Riprodurre separatamente i casi falliti di correzione e reso.
2. Distinguere rifiuti business attesi da errori del prodotto o del runner.
3. Confermare che il reso senza sostituzione resti nella comanda corrente,
   senza nuova comanda vuota e senza impatto economico residuo.
4. Analizzare e classificare i messaggi console della postazione; zero errori
   non attesi e nessuna XHR sincrona sul main thread.
5. Ripetere logout, blackout di rete e relogin della postazione.

DoD: copertura scenario senza fail non classificati e frontend reale senza
errori console applicativi.

### P4.6 - Gate load-100 finale

Progressione obbligatoria:

1. canary 20;
2. canary 50;
3. load-100 A;
4. restart pulito;
5. load-100 B.

Entrambi i load-100 devono rispettare:

- notifiche/comanda pronta p95 <500 ms;
- radio busy <150 ms;
- battery event p95 <500 ms;
- order create p95 <300 ms;
- payment table p95 <200 ms;
- doppi pagamenti e doppie emissioni fiscali: 0;
- print, fiscal, outbox e lock attivi al drain: 0;
- nessun drift peggiorativo significativo tra A e B.

P5 resta bloccata finche questo gate non e verde.

## P5 - Endurance 90 minuti

Aggiornamento 2026-07-16: su richiesta operativa e stato preparato il profilo
sostitutivo 20 palmari + 5 postazioni, 1.000 azioni per device e massimo 3
avvii/s globali. Harness, sicurezza I/O e reportistica sono descritti in
`P5_ENDURANCE_20X5_25K_TEST_PLAN_20260716.md`. Questo aggiornamento prepara il
test ma non chiude il gate: il run completo deve ancora essere eseguito.

Aggiornamento P5.1 2026-07-16: il precedente run e stato interrotto a 20.135
azioni su 25.000 e ha evidenziato drift prestazionale e attese lunghe sulla lane
`mutation`. Prima del nuovo full run e stata aggiunta la persistenza append-only
dei campioni di latenza in `p5-latency-checkpoints.jsonl`, con flush periodico e
su arresto. Lo smoke di regressione ha completato 200/200 azioni senza failure,
con 574 campioni HTTP e 200 campioni azione persistiti senza duplicati. Dettagli
in `FASE_P5_1_DURABLE_LATENCY_CHECKPOINTS_20260716.md`.

Aggiornamento P5.2 2026-07-16: sono stati corretti starvation della coda
generica, perdita del contesto richiesta durante le mutation differite e ordine
non canonico dei lock negli upsert MySQL multi-riga. Il runner ora persiste una
baseline separata per ogni processo e genera automaticamente il report di
contesa. Lo smoke conclusivo ha completato 200/200 azioni senza failure, con
attesa mutation massima 92 ms, 0 retry MySQL e 0 deadlock. Dettagli in
`FASE_P5_2_MUTATION_CONTENTION_20260716.md`. P5 resta aperta fino alla prova
sostenuta e al run completo da 25.000 azioni.

Aggiornamento P5.3 2026-07-16: il canary sostenuto
`p5_20x5_canary_2500_20260716104351` ha completato 2.500/2.500 azioni senza
failure, retry o deadlock, con drain completo e gate contention verde. Il
primo tentativo ha permesso di correggere un'inversione reale dei lock
`integration/lastWriteAt`/`sequence` e target non autorizzati nel generatore.
Il gate endurance resta pero' rosso: tutte le 951 richieste con `writeDb` hanno
usato il full-state fallback e il P95 HTTP cresce del 48,82% tra primo e ultimo
decile. Inoltre il monitor CPU/RSS basato su `/proc` non produce dati validi su
Windows. Dettagli e prossimo passo P5.4 in
`FASE_P5_3_SUSTAINED_CANARY_20260716.md`. Non avviare il full 25.000 prima di
eliminare il drift delle scritture e completare la telemetria multipiattaforma.

Aggiornamento P5.4 2026-07-16: writer puntuali e raccolta fondo cassa atomica
sono stati promossi nel profilo canary con rollback disponibile. Il cambio
tavolo aggiorna ora tavoli e ubicazione ordine nello stesso commit relazionale;
le letture puntuali e il sync pagamento conservano la posizione operativa piu'
recente. Il canary `p5_20x5_canary_2500_20260716152556` ha completato
2.500/2.500 azioni senza failure, retry o deadlock, con 75 scritture atomiche,
zero fallback/rollback, zero persistenze full-state, HTTP P95 143 ms e drift
P95 +7,66%. CPU/RSS sono validi anche su Windows tramite runtime metrics. Il
full da 25.000 azioni e' autorizzato come prossimo gate ma non e' ancora stato
eseguito. Dettagli in `FASE_P5_4_WRITER_ATOMICI_20260716.md`.

Prerequisito: P4 verde su due run consecutivi.

Profilo sostitutivo autorevole:

- 25.000 azioni, 1.000 per ciascun device;
- 20 device mobili e 5 postazioni;
- massimo 3 avvii di azione al secondo globali;
- 20 client radio/SSE;
- stampanti, fiscale, cassa automatica e batteria esclusivamente simulati;
- 2 mobile e 1 postazione pilotati dal frontend reale.

Azioni da coprire durante l'intera finestra:

- ordini, modifiche, resi, annullamenti, storni e trasferimenti;
- sposta, unisci e dividi tavoli, cambio sala e lock pagamento;
- pagamenti articolo, romano, totale, importo libero e cassa automatica mock;
- prenotazioni complete e gestione intolleranze;
- notifiche, chiamate cameriere e radio su canali concorrenti;
- fondi cassa, deposito, cambio e scarico simulati;
- stampa comanda/preconto/fiscale solo su simulatori.

Campionamento ogni 5 secondi:

- RSS e heap per processo;
- CPU tick/sec ed event-loop lag;
- pool MySQL: wait, hold, active e pending;
- connessioni e reconnect Redis/MQTT;
- profondita lane, command inbox, event outbox e print/fiscal spool;
- dimensione database, WAL e tabelle split;
- p50/p95/p99/p99.9 per finestre temporali.

In aggiunta, campioni HTTP e azione sono persistiti ogni 30 secondi nel file
JSONL append-only, cosi un arresto anticipato conserva percentili e dati grezzi.

Confrontare primi e ultimi 10 minuti per misurare drift. Al termine eseguire
drain, checksum/coerenza e restart recovery.

DoD:

- nessuna crescita monotona non giustificata di memoria, pool o code;
- nessun degrado progressivo delle latenze P4;
- zero duplicati e zero stato incoerente persistente;
- outbox, stampa, fiscale e lock drenati;
- riconnessione coerente di almeno 10 utenti e 2 postazioni;
- report Markdown, JSON e PDF con percentili e drift.

## P6 - Chaos testing

Prerequisito: P5 verde.

Eseguire uno scenario per volta, poi una combinazione controllata:

1. backend rallentato durante burst;
2. kill e restart di un API worker durante create/payment;
3. restart owner con flush asincrono pendente;
4. Redis offline/online e perdita cache sessioni;
5. MQTT offline/online durante notifiche;
6. gateway realtime restart con SSE connessi;
7. blackout rete mobile e postazione, poi riconnessione;
8. fiscale mock offline durante pagamento e recupero `PENDING_FISCAL`;
9. stampante mock intermittente, reclaim e ristampa idempotente;
10. cassa automatica mock offline durante incasso/cambio/fondo cassa;
11. MariaDB restart controllato e recovery pool;
12. doppio incasso e doppia emissione deliberati in concorrenza;
13. crash tra commit relazionale e mirror app-state;
14. riavvio completo Raspberry e ripresa servizi al boot.

Per ogni scenario salvare timeline, richieste, errori, stato DB prima/dopo,
recovery time e backlog massimo.

DoD:

- nessun doppio incasso o doppia emissione;
- nessun ACK prima della durabilita prevista;
- nessun lock fantasma o comanda persa;
- recovery automatico o stato esplicito riprendibile;
- code drenate dopo il ritorno del servizio;
- errori utente coerenti con la causa reale.

## P7 - Go/No-Go finale

Prerequisiti: P4, P5 e P6 verdi.

Checklist tecnica:

1. rieseguire equivalenza shadow sui domini migrati;
2. verificare backup completo e ripristino su ambiente pulito;
3. verificare rollback release tramite symlink e restart servizi;
4. verificare avvio automatico dopo reboot;
5. controllare CORS, certificato LAN, URL relativi e discovery mobile;
6. controllare utenti, permessi, configurazioni per-utente e audit;
7. controllare migrazioni MariaDB/SQLite da installazione vuota;
8. congelare dipendenze, hash release e configurazione systemd;
9. eliminare segreti, database, log e APK dal pacchetto sorgente;
10. produrre runbook installazione, recovery, backup e rollback;
11. aggiornare ADR-0002 con i numeri finali;
12. decidere quando ritirare l'app-state fallback.

Validazione hardware reale, solo con autorizzazione esplicita e dopo i test
virtuali:

- una stampante comande/preconto;
- fiscale reale con transazione controllata e annullamento verificato;
- cassa automatica reale con un incasso, resto, fondo e scarico controllati;
- almeno tre palmari e una postazione reali.

Decisione finale:

- GO solo se tutti i gate sono verdi e le anomalie residue sono classificate,
  accettate e documentate;
- NO-GO se resta un rischio di doppio incasso, perdita comanda, emissione
  fiscale incoerente, recovery non deterministica o latenza fuori soglia.

## Ordine operativo immediato

1. Implementare telemetria e A/B dei refresh paralleli nel create.
2. Riprodurre correzioni/resi e classificare la console postazione.
3. Ridurre waiter notification e payment free-split sotto soglia.
4. Eseguire due load-100 consecutivi.
5. Solo dopo P4 verde, avviare P5, P6 e infine P7.

## Artefatti inclusi nel pacchetto

- sorgente backend e di tutti i frontend web;
- test unitari, E2E, runner di carico e simulatori;
- deploy Raspberry e configurazioni senza segreti;
- roadmap v5 originale;
- questo aggiornamento P4-P7;
- ultimo preflight realistico P4, report Markdown e JSON;
- ultimo gate load-100 P4, report Markdown e JSON.

La parte Android/APK e intenzionalmente esclusa.
