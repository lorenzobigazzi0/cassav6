# Fase P3 - Probe pending terminal sync

Data: 2026-07-03

## Obiettivo

Continuare il Passo 3 della roadmap interinale: ridurre la pressione in
`orderLane` senza introdurre priorita' aggressive. L'ipotesi provata era:
quando arriva un sync terminale status-only (`ready`/`delivered`) su un ordine
che ha gia' una mutazione pendente, far attendere quella mutazione e poi
riprovare il pre-lane no-op, invece di accodare subito un nuovo task.

## Modifica provata

Modifica temporanea poi rimossa:

- tracking delle promise pendenti per chiave ordine in `orderSyncLane`;
- nuovo ramo `tryHandlePendingTerminalOrderSyncLaneNoop`;
- contatori runtime `orderLaneTerminalSyncWaits` e
  `orderLaneTerminalSyncWaitNoops`;
- il ramo era limitato a payload status-only e ripassava comunque da
  `tryHandleTerminalDuplicateOrderSyncPreLane`, quindi non saltava mutazioni
  reali.

## Verifiche tecniche durante la probe

- `node --check` su server, runtime metrics e pre-lane: OK.
- Guardrail mirati: 51/51 pass.
- E2E ordini: 7/7 pass dopo aver rimosso un test concorrente non deterministico
  sul backend JSON.

## Smoke MySQL

Run: `phaseP_interinale_p3_pending_terminal_sync_smoke_20`

- Durata: 37 s.
- Business ops: 180.
- Failure: 0.
- RT fiscale reale: 0 tentativi.
- `orderLaneTerminalSyncWaits`: 4.
- `orderLaneTerminalSyncWaitNoops`: 1.
- `orderLaneEnqueued`: 101.
- `orderLane` wait avg: 514 ms.
- `orderLane` run avg: 380 ms.

Lo smoke ha confermato che il ramo scatta in MySQL.

## Canary 1

Run: `phaseP_interinale_p3_pending_terminal_sync_canary12_50`

- Durata: 99 s.
- Business ops: 720.
- Failure: 0.
- RT fiscale reale: 0 tentativi.
- Retry/deadlock/timeout nei log: 0.
- `orderLaneEnqueued`: 284.
- `orderLaneTerminalSyncWaits`: 16.
- `orderLaneTerminalSyncWaitNoops`: 10.

Confronto con baseline promossa
`phaseP_interinale_p3_ready_status_noop_canary12_50_nogui`:

| Metrica | Baseline | Probe |
|---|---:|---:|
| `orderLaneEnqueued` | 309 | 284 |
| `order.create` p95 | 9150 ms | 9756 ms |
| `order.sync.ready` p95 | 8166 ms | 9791 ms |
| `order.sync.delivered` p95 | 8145 ms | 10068 ms |
| `station.heartbeat` p95 | 1352 ms | 9488 ms |
| `waiter.pause.stop` p95 | 9688 ms | 19094 ms |

## Canary 2

Run: `phaseP_interinale_p3_pending_terminal_sync_canary12_50_b`

- Durata: 102 s.
- Business ops: 720.
- Failure: 0.
- RT fiscale reale: 0 tentativi.
- Retry/deadlock/timeout nei log: 0.
- `orderLaneEnqueued`: 294.
- `orderLaneTerminalSyncWaits`: 15.
- `orderLaneTerminalSyncWaitNoops`: 6.

Confronto con baseline promossa:

| Metrica | Baseline | Probe B |
|---|---:|---:|
| `orderLaneEnqueued` | 309 | 294 |
| `order.create` p95 | 9150 ms | 9842 ms |
| `order.sync.ready` p95 | 8166 ms | 13641 ms |
| `order.sync.delivered` p95 | 8145 ms | 10714 ms |
| `station.heartbeat` p95 | 1352 ms | 3917 ms |
| `waiter.pause.stop` p95 | 9688 ms | 11863 ms |

## Decisione

Probe respinta e rollbackata.

Il ramo riduce davvero alcuni enqueue e intercetta duplicati mentre una
mutazione dello stesso ordine e' pendente, ma non migliora il p95. In due canary
comparabili peggiora `order.sync.ready`/`delivered` e aumenta la latenza
laterale di heartbeat/waiter pause. Il beneficio di pressione non compensa il
costo di far attendere le richieste duplicate nel percorso HTTP.

## Stato finale codice

Ripristinato al comportamento promosso in
`FASE_P3_READY_STATUS_NOOP_20260703.md`:

- pre-lane immediato per duplicati terminali gia' persistiti;
- no-op `ready -> ready` solo con payload status-only;
- nessun tracking promise pendenti in `orderLane`;
- nessun counter `orderLaneTerminalSyncWait*`.

## Prossimo step

Non riprovare il pending-wait in questa forma. Le due direzioni ancora utili:

1. ridurre ulteriormente il lavoro per task ordine, in particolare
   `orders.sync.mysql.orders`;
2. separare fisicamente le operazioni ordine leggere da quelle che scrivono
   fallback/route o comp/correct, senza far attendere l'HTTP su una mutazione
   precedente.

## Artefatti

- `logs/loadtest-phaseP_interinale_p3_pending_terminal_sync_smoke_20/report.json`
- `logs/loadtest-phaseP_interinale_p3_pending_terminal_sync_canary12_50/report.json`
- `logs/loadtest-phaseP_interinale_p3_pending_terminal_sync_canary12_50_b/report.json`
