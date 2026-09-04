# Fase P3 - Order station index batch e load pulito

Data: 2026-07-03

## Obiettivo

Chiudere il collo residuo emerso nella diagnostica P3: i rollback MySQL degli
ordini avvenivano nello stage `integration.orders.entries.orderStationIndex`.

## Modifiche

- Le metriche runtime conservano sempre le label diagnostiche P3
  `error`, `errorStage`, `rollback` e `outcome`, anche oltre il limite top
  operations.
- Lo split MySQL degli ordini registra lo stage esatto del rollback con
  `errorStage.<step>.<cause>`.
- L'indice ordini/postazioni salta il `DELETE` quando una nuova comanda non ha
  righe indice precedenti.
- Gli insert dell'indice ordini/postazioni sono ordinati e inviati in batch
  invece che con una query per riga.
- Lo stress test classifica come skip attesi le race concorrenti gia' gestite
  dal backend per correzione/storno su tavolo o riga cambiati durante il run.

## Evidenza pre-fix

Run: `logs/loadtest-phaseP_load-50-p3-errorstage-pinned/report.json`

- Business ops: 1260
- Durata: 342770 ms
- Failure: 2
- Retry ordine nel backend: 159
- Occorrenze `Deadlock found`: 163
- Rollback ordini: 161
- Stage rollback: `integration.orders.entries.errorStage.orderStationIndex.transientDbError`
- `integration.orders.index.insertRows`: 56332 campioni
- `integration.orders.index.total`: media 82.31 ms, max 975 ms

## Evidenza post-fix

Run finale: `logs/loadtest-phaseP_load-50-p3-clean-final/report.json`

- Business ops: 1260
- Durata: 232217 ms
- Failure: 0
- RT fiscale virtuale: 4 tentativi, 4 successi
- Traffico HTTP stimato: request 1.18 MB, response 36.54 MB
- Bytes InnoDB scritti: 246.91 MB
- Righe inserite/aggiornate/eliminate: 35892 / 20804 / 31935
- Code finali `dbMutation/orderLane`: 0 / 0
- Rollback ordini: 0
- Label `integration.orders.entries.error*`: assenti
- `integration.orders.index.insertRows`: 767 campioni
- `integration.orders.index.total`: media 23.32 ms, max 464 ms
- `orderWorkflow:orders.create.appStateWrite`: media 433.6 ms
- `orderWorkflow:orders.sync.appStateWrite`: media 661.7 ms

## Delta

- Durata run: 342.8s -> 232.2s, circa -32%.
- Query/campioni insert indice: 56332 -> 767, circa -98.6%.
- Tempo medio `index.total`: 82.31 ms -> 23.32 ms, circa -71.7%.
- Scrittura InnoDB: 379.14 MB -> 246.91 MB, circa -34.9%.
- Failure applicative: 2 -> 0.
- Rollback ordini P3: 161 -> 0.

## Test

- `node --check cassa-frontend/scripts/loadtest-full-capacity.mjs`: OK
- `node --check cassa-frontend/backend/db/app-state/mysql-domains-split.repository.js`: OK
- `node --check cassa-frontend/backend/tests/app-state-repository.test.mjs`: OK
- Test mirati app-state/runtime/guardrail: 74/74 pass
- Test P3 ampia app-state/runtime/guardrail/budget/write-primary/notifiche/load
  balancer/scheduler: 109/109 pass

## Residuo

Nel run finale restano 2 retry recuperati della write app-state generale:

- `Hook pre-write app-state fallito: Deadlock found when trying to get lock`
- `Write app-state MySQL in retry dopo errore transient (1/3)`

Non producono failure utente e non sono piu' dentro lo stage ordini
`orderStationIndex`. Il prossimo collo architetturale e' ridurre le write
full-domain residue o separare ulteriormente le pre-write app-state generali.
