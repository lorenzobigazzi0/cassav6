# Fase P3 - Analisi outlier order-lane

Data: 2026-07-04

## Obiettivo

Seguire il Passo 3 della roadmap interinale P3: verificare se il p95 alto degli ordini dipende da payload pesanti
oppure da un problema di coda/capacita' della `orderLane`.

## Baseline usata

Run di riferimento: `phaseP_interinale_p3_station_state_entry_canary8_50`

- 50 palmari, 12 postazioni, 12 operazioni per device
- concorrenza order-lane 8
- business ops 744
- failure 0
- coda finale `dbMutation/orderLane`: `0 / 0`
- `orderLaneEnqueued`: 318
- costo medio workflow ordini: circa 411ms
- capacita' teorica a concorrenza 8: circa 19,5 op/s

Latenze principali:

- `order.create`: p50 8332ms, p95 11016ms
- `order.sync.delivered`: p50 7103ms, p95 11002ms
- `order.sync.ready`: p50 9372ms, p95 11681ms
- `order.correct`: p50 6450ms, p95 10828ms

## Esito correlazione outlier

La correlazione "ordine pesante => outlier" non e' confermata.

Nel top queue-wait della `orderLane` compaiono payload piccoli e medi insieme:

- `orders/sync lines=1 qty=1 routes=1 wf=ready`: p95 wait 10679ms
- `orders/create lines=2-3 qty=2-3`: p95 wait 10773ms
- `orders/create lines=2-3 qty=6-10`: p95 wait 10831ms
- `orders/sync lines=6-10 qty=6-10 routes=2-3`: p95 wait 10912ms

Quindi il p95 non nasce solo da ordini lunghi, molte righe o molte route. Il pattern e' una coda di burst:
molte operazioni entrano quasi insieme, e anche quelle leggere aspettano dietro al volume complessivo.

## Probe concorrenza 16

Run: `phaseP_interinale_p3_orderlane_capacity16_probe_50`

- concorrenza order-lane 16
- business ops 744
- failure 0
- RT fiscale reale 0
- `orderLaneEnqueued`: 344
- costo medio workflow ordini: circa 703ms
- capacita' teorica calcolata ancora su concorrenza 8: circa 11,4 op/s equivalente

Risultato: peggiora.

- `order.create`: p95 14032ms
- `order.sync.delivered`: p95 12849ms
- `order.sync.ready`: p95 12246ms
- `order.correct`: p95 13864ms
- `station.heartbeat`: p95 23775ms
- `stationState.upsert.appStateWrite`: avg 1059.86ms, max 1755ms

Conclusione: alzare solo la concorrenza non risolve. Aumenta la pressione su MySQL e peggiora anche presence/station-state.

## Probe chiave create idempotency/localOrderId

Ipotesi provata: usare `idempotencyKey/clientOrderId/localOrderId` prima del fallback tavolo per le create, e far generare
al loadtest create mobile-like con idempotency.

Run: `phaseP_interinale_p3_create_idempotency_key_canary8_50`

- concorrenza order-lane 8
- business ops 744
- failure 0
- RT fiscale reale 0
- `orderLaneEnqueued`: 322
- costo medio workflow ordini: circa 449ms
- capacita' teorica a concorrenza 8: circa 17,8 op/s

Risultato: anche questa strada non migliora il gate nel burst sintetico.

- `order.create`: p95 16848ms
- `order.sync.delivered`: p95 16312ms
- `order.sync.ready`: p95 18092ms
- `order.correct`: p95 18413ms

La patch e' stata scartata e non lasciata attiva, perche' peggiorava i numeri del canary.

## Diagnosi aggiornata

Il limite attuale non e':

- fallback station-state: gia' chiuso nello step precedente;
- payload pesante: falsificato dai bucket piccoli in coda;
- concorrenza troppo bassa in modo semplice: a 16 peggiora;
- chiave create troppo larga, almeno nel carico sintetico P3: la prova con idempotency non migliora.

Il limite e' il modello di scrittura ordine sotto burst: il costo per operazione resta centinaia di ms e il burst genera
centinaia di task `orderLane`. Con questo modello, il p95 sotto 500ms non e' raggiungibile solo ritoccando lo scheduler.

## Prossimo passo consigliato

Chiudere il Passo 3 con esito negativo per "lane pesanti" e passare al Passo 5 della roadmap interinale: calcolo
esplicito di capacita' e decisione architetturale.

Direzione tecnica consigliata:

1. non aumentare oltre la concorrenza order-lane;
2. non usare idempotency/localOrderId come fix prestazionale cieco;
3. valutare il passaggio anticipato alla write-primary relazionale per gli ordini, o una create asincrona con ACK rapido
   e commit di dominio separato, per abbattere il costo per operazione sotto decine di ms;
4. mantenere il gate P3 rosso finche' `order.create/order.sync` p95 non scende su due run consecutivi.

## File evidenza

- `logs/loadtest-phaseP_interinale_p3_station_state_entry_canary8_50/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_orderlane_capacity16_probe_50/REPORT.md`
- `logs/loadtest-phaseP_interinale_p3_create_idempotency_key_canary8_50/REPORT.md`
