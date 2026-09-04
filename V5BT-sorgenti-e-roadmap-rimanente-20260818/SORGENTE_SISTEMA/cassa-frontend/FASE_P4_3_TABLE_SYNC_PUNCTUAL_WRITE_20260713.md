# Fase P4.3 - Write puntuale di table.sync

Data: 2026-07-13

## Stato

Implementazione, test locali e canary A/B 20/50 completati. Il flag resta
default OFF: il risultato autorizza a proseguire P4.3, non a promuovere il
percorso in produzione prima della chiusura degli altri endpoint owner-bound e
dei due load-100 finali.

## Selezione del primo endpoint

L'ordine logico della roadmap parte da prenotazioni create/status. Lo sweep
P3.16 aveva pero' gia' introdotto lane e dirty write dedicati; nell'ultimo
canary 50 i rispettivi app-state write medi erano circa 87 ms e 102 ms.

Il collo di bottiglia owner-bound misurato era invece
`POST /api/integration/layout/table/sync`:

- app-state write `rooms.table.sync.appStateWrite` medio circa 650 ms;
- `roomLane` con attesa ed esecuzione entrambe rilevanti;
- p95 endpoint oltre 2 secondi.

## Modifica

Il percorso comune aggiorna in modo sincrono e puntuale:

1. la sola voce `posSettings.tables` in MySQL;
2. la sola riga `app_state_table_states` nello split SQLite, quando attivo;
3. i soli audit event aggiunti dalla richiesta.

Il repository SQLite ricalcola il checksum globale dai soli identificativi,
hash e indici persistiti. Non rilegge il JSON operativo di tutti i tavoli e non
cancella righe estranee alla selezione.

Il fast path e' abilitato soltanto con:

```text
BACKEND_TABLE_SYNC_APP_STATE_FASTPATH=1
```

Rollback immediato: flag assente oppure `0`.

## Invarianti e fallback

- La tabella relazionale primaria viene confermata prima del mirror puntuale,
  come nel percorso precedente.
- Nessun ACK viene inviato prima della conclusione delle scritture durevoli.
- Errori MySQL/SQLite vengono propagati; non esiste fallback silenzioso dopo
  una scrittura parziale.
- Se la richiesta modifica prenotazioni o gruppi tavolo, il fast path non
  inizia e viene usato il writer completo precedente.
- Se manca un writer puntuale richiesto, il fallback avviene prima di ogni
  scrittura.
- Il percorso resta sincrono: non sono state introdotte code, retry o nuovi
  stati intermedi.

## Telemetria

Contatori:

```text
tableSyncAppStateFastWrites
tableSyncAppStateFastFallbacks
tableSyncAppStateFastFallbackRelatedDomain
tableSyncAppStateFastFallbackTableWriterUnavailable
tableSyncAppStateFastFallbackTableStateWriterUnavailable
tableSyncAppStateFastFallbackAuditWriterUnavailable
```

Breakdown persistente:

```text
tableSyncWrite:mysql.posSettingsTable
tableSyncWrite:sqlite.tableState
tableSyncWrite:mysql.auditEvents
tableSyncWrite:sqlite.auditEvents
tableSyncWrite:total
```

Il runner accetta `LOADTEST_TABLE_SYNC_APP_STATE_FASTPATH=1` e salva il valore
effettivo in `report.json` e `REPORT.md`.

## Canary A/B validi

- 20 OFF: `p4_table_sync_canary20_baseline_20260713_run1`;
- 20 ON: `p4_table_sync_canary20_target_20260713_run2`;
- 50 OFF: `p4_table_sync_canary50_baseline_20260713_run1`;
- 50 ON: `p4_table_sync_canary50_target_20260713_run2`.

| Metrica | 20 OFF | 20 ON | 50 OFF | 50 ON |
| --- | ---: | ---: | ---: | ---: |
| `table.sync` count/fail | 10/0 | 10/0 | 22/0 | 22/0 |
| `table.sync` p50 | 631 ms | 131 ms | 1474 ms | 273 ms |
| `table.sync` p95 | 2467 ms | 1139 ms | 3588 ms | 1216 ms |
| `table.sync` p99 | 2467 ms | 1139 ms | 5465 ms | 1335 ms |
| `roomLane` run medio | 832,8 ms | 87,1 ms | 897,18 ms | 175,23 ms |
| `roomLane` wait medio | 166,5 ms | 274,8 ms | 764,09 ms | 261,95 ms |
| write puntuale totale medio | n/d | 47,5 ms | n/d | 124,32 ms |
| HTTP globale p95 | 860 ms | 740 ms | 1358 ms | 1127 ms |
| HTTP globale p99 | 1705 ms | 1378 ms | 4472 ms | 2949 ms |
| SSE p95 | 254 ms | 259 ms | 272 ms | 262 ms |
| MySQL redo log | 62.161.408 B | 52.184.576 B | 115.874.304 B | 106.926.080 B |

I due target hanno eseguito 32/32 fast write e zero fallback. Tutti i run
validi hanno zero failure, stato relazionale drenato, outbox non pubblicati a
zero, stampe finali fallite a zero e problemi fiscal outbox a zero. I target
hanno completato rispettivamente 240/240 e 600/600 operazioni, 40/40 e 100/100
ordini, 20/20 e 50/50 device al target persistito.

Nel canary 20 il wait medio della lane peggiora, mentre run ed endpoint
migliorano nettamente. A 50 device migliorano sia wait sia run. Questa varianza
resta da ricontrollare nei load-100 finali.

Run esclusi dal confronto formale:

- `p4_table_sync_canary20_baseline_20260713_run2`: timeout Playwright
  ausiliario durante il blackout simulato;
- `p4_table_sync_canary50_target_20260713_run1`: sessione postazione non
  ripristinata dopo il blackout simulato.

In entrambi i casi tavoli, ordini, persistenza e drain erano completi; le
anomalie GUI restano classificate per P4.5.

## Verifiche locali

```text
npm run check:backend
node --test --test-concurrency=1 backend/tests/table-sync-app-state-fastpath.test.mjs
node --test --test-concurrency=1 --test-name-pattern="tableStates" backend/tests/app-state-repository.test.mjs
node --test --test-concurrency=1 backend/tests/runtime-metrics.test.mjs
node --test --test-concurrency=1 --test-name-pattern="P4.3 table sync|room and table writes" backend/tests/route-policy-architecture.test.mjs
node --test --test-concurrency=1 --test-name-pattern="table sync aggiorna" backend/tests/relational-table-move-write-primary.test.mjs
```

Il preflight Phase-P valida le nuove asserzioni Windows. I sette dry-run finali
Raspberry/Linux restano non eseguibili su Windows per assenza del runtime Node
nel contesto Bash, come gia' documentato in P4.2.

Esito finale delle suite interessate: repository app-state, runtime metrics,
fast path, flusso relazionale tavoli, route policy e budget architetturale tutti
verdi. `backend/server.js` resta a 38.799 righe, con 701 righe di margine sul
budget hard 39.500.

## Decisione

**GO condizionato per proseguire P4.3; NO-GO per la promozione del flag.**

Il prossimo intervento deve partire dal successivo endpoint tavoli/sale fuori
soglia, senza ampliare questo fast path ai casi che cambiano prenotazioni o
gruppi. La promozione resta subordinata alla chiusura P4.3-P4.5 e ai due
load-100 consecutivi sul target Linux.
