# V5BT LastWrite Coalesce Canary - 2026-08-07

## Scopo

Verificare se il coalescing asincrono di `integration.lastWriteAt` per gli
heartbeat station-state riduce la contesa MySQL nel profilo V5BT con 25
Palmari e 5 Postazioni simulate. Il confronto usa due micro da `300`
operazioni. Nessun hardware fisico e stato usato.

## Contratto Fail-Safe

- Flag backend: `BACKEND_STATION_STATE_LAST_WRITE_COALESCE=1`.
- Default e deploy operativo ufficiale: `0`; il flag resta OFF.
- Profilo ON: sempre `NON_GATE/NON_PROMOTABLE`.
- La coda sceglie il `MAX` tra marker e timestamp station-state e conserva il
  massimo anche con enqueue fuori ordine o durante un flush in corso.
- Un errore reinserisce il massimo pendente senza perdita; il recovery di
  avvio ripara soltanto un marker piu vecchio del massimo station-state.
- Timestamp invalidi o futuri vengono rifiutati. Gli eventi presenza,
  login/logout e le notifiche restano fuori dal coalescing.
- Il writer e transazionale e non puo regredire un marker gia piu recente.
- `SIGINT` e `SIGTERM` drenano la coda prima di chiudere i repository.

## Metriche E Verifiche

Il contratto diagnostico espone contatori `enqueued`, `coalesced`, `covered`,
`batches`, `flushed`, `retries`, `errors`, `invalid`, `future`,
`clockRegression`, `recoveryWrites` e `recoveryNoops`; espone inoltre i gauge
`pending`, `running` e `oldestAgeMs`. L'audit schema `1` richiede contabilita
coerente, persistenza monotona e coda completamente drenata.

Verifiche disponibili al momento della sigillatura:

- focused: `172/172 PASS`;
- contratti: `100/100 PASS`;
- gate: `7/7 PASS`;
- full suite backend, rerun isolato: `1906/1906 PASS`; la prima esecuzione
  aveva chiuso `1905/1906` con un solo errore non riprodotto.

## Confronto A/B

| Profilo | Classe | Azioni | P95 azioni | P95 comande | Coda | Coalesced | Batch | Lock wait | Tempo lock | Esito |
| --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| OFF | `QUALIFYING_PROFILE` | 300/300 | 5853 ms | 3652 ms | 0/0 | 0 | 0 | 135 | 74012 ms | FAIL P95 azioni |
| ON | `NON_GATE/NON_PROMOTABLE` | 300/300 | 9323 ms | 8448 ms | 91/91 | 71 | 20 | 124 | 120055 ms | FAIL P95 azioni e comande |

Entrambi i run completano la quota senza errori business. Nel profilo ON
l'audit coda e `PASS`: `91` enqueue vengono tutti flushati, `71` sono
coalescati in `20` batch, senza retry, errori, timestamp invalidi, regressioni
clock o residui. La riduzione da `135` a `124` lock wait non compensa
l'aumento del tempo lock complessivo da `74012` a `120055` ms e il netto
peggioramento delle latenze end-to-end.

## Decisione

La variante e respinta per prestazioni. Il flag resta OFF e non viene
autorizzato uno smoke da `1200`. La correttezza della coda consente di
conservare il codice solo come strumento diagnostico, senza promozione nel
profilo operativo.

Il prossimo passo offline e un canary `NOWAIT` fail-fast con reschedule
esplicito, seguito da confronto A/B/A. Non ripetere lo smoke prima di un micro
interamente verde.

## Evidenze Sigillate

```text
SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_micro_300_lastwrite_off_20260807/
SHA-256 manifest 9a79262eec9bbeaa947ee067552cfa620768495c4d2480bf63f0cf1bbe68fedb

SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_micro_300_lastwrite_on_retry_20260807/
SHA-256 manifest b3faeae2868dabf08bedc0a31dcc0d918d4f3e718b5b293504affae349140c57
```

Nessun hardware usato. B4 resta `2/10`, B5 resta `PENDING` e B6 resta
`BLOCKED`.

Avanzamento roadmap complessiva: **49%**
