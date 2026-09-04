# CASSAv4 - P4.3 audit payment.free_split

Data: 2026-07-14

Aggiornamento: il successivo mirror durevole post-commit e i canary aggiornati
sono documentati in
`FASE_P4_3_PAYMENT_FREE_SPLIT_DURABLE_MIRROR_20260714.md`. Questo file resta il
baseline pre-intervento.

Target: Raspberry `192.168.1.79`, quattro core disponibili, release
`20260714-p4-payment-free-split-audit-032319`.

## Esito

- Correttezza, idempotenza, durabilita e drain: **GO**.
- Gate prestazionale a 20 device: **rosso** rispetto al budget p95 di 200 ms.
- Gate prestazionale a 50 device: **rosso**.
- Spostamento dell'ACK prima del commit relazionale: **NO-GO**.
- Promozione di un nuovo fast path non durevole: **NO-GO**.

Le sei sonde dedicate hanno concluso con HTTP 200 in entrambi i canary e non
sono comparsi pagamenti duplicati, outbox residue o code relazionali non
scaricate. A 50 device il p95 della sonda sale pero a 6.026 ms. La telemetria
corretta mostra che il costo dominante non e il commit relazionale, ma la coda
owner-bound e il lavoro applicativo ancora eseguito nel processo owner.

## Confine architetturale verificato

`POST /api/payments/free-split`:

1. resta instradato a `api-owner`;
2. entra nella payment lane keyed per tavolo, con concorrenza globale 2;
3. legge e prepara il dominio sullo stato applicativo dell'owner;
4. registra pagamento, quote, transazioni, ricevute e outbox nel relazionale;
5. considera il commit relazionale il confine di durabilita prima dell'ACK;
6. aggiorna il mirror MySQL/app-state nel percorso di risposta;
7. differisce il mirror solo quando una failure MySQL transitoria e recuperabile;
8. pubblica realtime dopo la scrittura durevole.

La route non e quindi ancora quasi-stateless e non puo essere spostata sugli
API worker senza esternalizzare la preparazione del dominio e il mirror.

## Strumentazione aggiunta

- Telemetria `paymentFreeSplitWorkflow` con tempi separati per parse, read,
  idempotenza, preparazione dominio, commit relazionale, mirror, realtime e
  receipt enqueue.
- Attribuzione di `laneWait`, `dbQueueWait`, `readDbTotal` e `writeDbTotal` alla
  richiesta corretta.
- Breakdown delle write `mysql.orders`, `mysql.lastWriteAt`,
  `mysql.posSettingsTables`, `audit` e `paymentRecords`.
- Contatore `paymentFreeSplitTransientMirrorDeferred`.
- Sei sonde `payment.free_split.probe` su tavoli virtuali dedicati e sulla
  postazione realmente assegnata dal load balancer.
- Report automatico delle metriche workflow e write nel runner full-capacity.

## Correzioni emerse durante l'audit

1. Il probe forzava inizialmente `BAR-1` anche quando l'ordine era assegnato a
   un'altra postazione. Ora usa `assignedStationId` e fallisce esplicitamente
   se una sonda non conclude.
2. Il DB app-state split del deploy puntava dentro il release read-only. Ora
   usa `/var/lib/cassav4/app-state-split.sqlite`; non risultano nuovi
   `SQLITE_READONLY` dopo il riavvio.
3. Payment lane e order lane conservavano il contesto metriche ma non vi
   rientravano quando eseguivano il task accodato. Entrambe ora eseguono il task
   dentro `requestMetricsStorage.run(...)`, con test statici dedicati.
4. I mirror transitori differiti sono ora contati e visibili nel report.
5. Il fixture del test fiscal optimism acquisisce il lock tavolo richiesto dal
   contratto corrente.

## Canary

Entrambi i run hanno usato:

- 4 postazioni API;
- 3 frontend mobile Playwright e 1 frontend postazione Playwright;
- 2 API worker e 1 table-lock worker;
- simulatori loopback per fiscale, cassa automatica e batteria;
- `LOADTEST_PRINTING_ENABLED=0`;
- I/O non-loopback vietato;
- 6 sonde dedicate `payment.free_split`.

| Metrica | 20 device | 50 device |
| --- | ---: | ---: |
| Sonde HTTP 200 | 6/6 | 6/6 |
| Sonda p50/p95/max | 363/830/830 ms | 599/6026/6026 ms |
| HTTP globale p50/p95/p99/p99.9 | 39/553/1030/1883 ms | 76/2264/9013/19019 ms |
| Workflow completato avg/max | 349,14/683 ms | 986,43/2834 ms |
| Payment lane wait avg/max | 0,57/1 ms | 1348,29/5139 ms |
| Domain prepare avg/max | 127,43/190 ms | 448,07/2511 ms |
| Commit relazionale avg/max | 16/56 ms | 11,64/19 ms |
| App-state mirror avg/max | 174,57/390 ms | 451,57/1281 ms |
| writeDb totale avg/max | 76,29/163 ms | 586,29/2479 ms |
| Realtime p50/p95/p99/p99.9 | 135/250/279/318 ms | 169/306/390/552 ms |
| Failure globali | 0 | 2 classificate runner auth |
| Outbox residue / duplicati pagamento | 0/0 | 0/0 |
| Drain relazionale | 152 ms, completo | 278 ms, completo |
| Mirror transitori differiti | contatore non ancora presente | 5 |

Run validi:

- `reports/p4_payment_free_split_20260714/measure20-run2/`;
- `reports/p4_payment_free_split_20260714/measure50-run2/`.

Il primo tentativo a 20 device non e usato nel confronto per il bug di scelta
postazione del probe. Il primo run a 50 device e conservato come evidenza del
bug di attribuzione `AsyncLocalStorage`, ma le sue metriche request-scoped non
sono usate nel verdetto.

## Classificazione anomalie

Le due failure del canary 50 sono `history.payments` HTTP 401 su
`/api/reports/sales`, entrambe instradate a un API worker con sessione del
runner non piu valida. Non sono failure di pagamento e non hanno prodotto
drift relazionale; restano da correggere nel runner/session sync prima del gate
P4 finale.

Con stampa disabilitata il relazionale registra 88 job `failed_final`: il
runner non li considera violazioni quando `LOADTEST_PRINTING_ENABLED=0`, non ha
avviato la farm TCP e il guard I/O ha vietato destinazioni non-loopback. Il
contatore non rappresenta tentativi verso stampanti reali. Il gate di stampa
va ripetuto separatamente con farm TCP virtuale abilitata.

## Diagnosi

Il commit relazionale non e il collo: a 50 device resta sotto 20 ms. Il salto
di latenza nasce da tre costi cumulativi:

1. payment lane owner-bound: 1.348 ms medi di wait, con picco 5.139 ms;
2. preparazione dominio sullo stato mutabile dell'owner: 448 ms medi;
3. mirror app-state ancora sincrono: 452 ms medi.

Aumentare soltanto la concorrenza della lane puo ridurre l'attesa ma aumentare
contesa CPU/MySQL e non elimina la dipendenza dal `dbCache`. Non va promosso
senza un A/B dedicato e senza avere prima reso durevole il lavoro post-commit.

## Prossimo intervento P4.3

1. Definire un record durevole di mirror payment nello stesso confine
   transazionale del pagamento, con chiave idempotente e stato retry/recovery.
2. Consumare il mirror dopo il commit fuori dal percorso di risposta, con
   riconciliazione di startup e backpressure esplicita.
3. Costruire il delta free-split da snapshot relazionale condivisa, evitando la
   mutazione full-state owner-bound.
4. Solo dopo, consentire l'esecuzione su payment worker keyed per tavolo e
   confrontare lane concurrency 2/4 nei canary 20/50.
5. Ripetere il gate con p95 sonda <200 ms, zero duplicati, outbox e mirror
   drenati e recovery verificata dopo `SIGKILL`.

Il passo successivo non e quindi P4.4: prima va chiuso il debito prestazionale
di `payment.free_split` senza indebolire durabilita e consistenza.

## Verifiche

- Suite locale mirata: 152/152 verde.
- Suite ARM mirata prima del riavvio: 152/152 verde.
- Canary 20: correttezza e drain verdi.
- Canary 50: correttezza e drain verdi, prestazioni rosse.
- Servizi live dopo il deploy: owner, due API worker, realtime e table-lock
  worker attivi; `GET /api/health` HTTP 200.
