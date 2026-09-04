# CASSAv4 - Roadmap di completamento P4-P7

Data snapshot: 2026-07-13

## Scopo

Questo documento accompagna il sorgente destinato al refactor e descrive lo
stato reale del programma di validazione, il lavoro ancora aperto e i gate da
superare prima del rilascio commerciale.

La roadmap v5 originale resta il riferimento per le soglie. Le indicazioni
qui sotto ne aggiornano lo stato sulla base dei test eseguiti fino al
2026-07-12 sul Raspberry target.

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
default OFF. Test locali verdi; canary A/B 20/50 e load-100 ancora da eseguire,
quindi P4.2 resta aperta. Dettagli in
`cassa-frontend/FASE_P4_2_ORDER_CREATE_PARALLEL_EXTERNAL_REFRESH_20260713.md`.

Prossimo intervento raccomandato dall'ultimo A/B:

1. Aggiungere telemetria specifica per separare nel percorso create:
   app-state read, refresh lock tavolo, refresh stati postazione, auth,
   write-primary, outbox e risposta.
2. Dietro nuovo flag default OFF, parallelizzare solo i refresh indipendenti
   di lock tavolo e stati postazione dopo la lettura app-state.
3. Conservare timeout, fallback e semantica di errore distinti per le due
   letture; un fallimento non deve produrre uno snapshot parzialmente valido.
4. Non aumentare il numero dei worker: il confronto 2 contro 4 ha peggiorato
   p95, SSE e pressione Redis/MySQL.
5. Eseguire test unitari, E2E cross-processo e A/B canary 50 prima di load-100.

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

Prerequisito: P4 verde su due run consecutivi.

Profilo minimo:

- durata reale almeno 90 minuti;
- 50.000 azioni;
- 120 device mobili;
- 50 postazioni;
- 100 client radio/SSE;
- stampanti, fiscale, cassa automatica e batteria esclusivamente simulati;
- almeno 3 mobile e 1 postazione pilotati dal frontend reale.

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
