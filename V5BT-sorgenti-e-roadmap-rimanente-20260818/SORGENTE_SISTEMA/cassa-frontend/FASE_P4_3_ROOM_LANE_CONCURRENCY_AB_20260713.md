# Fase P4.3 - A/B concorrenza keyed room lane

Data: 2026-07-13

## Stato

Override runner, guardrail keyed e canary A/B 20/50 completati.
`ROOM_LANE_CONCURRENCY=2` conserva la correttezza funzionale, ma non supera il
gate prestazionale. La configurazione stabile resta `1` e il fallback del
backend e' stato allineato a questo valore. Il valore `2` resta disponibile
solo tramite override esplicito per ulteriori diagnosi.

## Modifica

Il runner accetta:

```text
LOADTEST_ROOM_LANE_CONCURRENCY=1..4
```

Il valore predefinito del runner e' `1`, viene propagato a owner, realtime
gateway, API worker e table-lock worker tramite `ROOM_LANE_CONCURRENCY`, ed e'
salvato in `report.json` e `REPORT.md`.

`backend/server.js` continua a validare il valore tra 1 e 4. Il fallback in
assenza della variabile passa da `2` a `1`, coerentemente con il profilo che ha
superato il confronto.

Rollback configurazione: impostare esplicitamente
`ROOM_LANE_CONCURRENCY=2`. Non sono state modificate route, payload, persistenza
o regole di dominio.

## Invarianti keyed

I guardrail verificano che:

- due cambi sala dello stesso device condividano `user:<deviceUuid>`;
- due cambi verso la stessa sala condividano `room:<roomId>`;
- due sync dello stesso tavolo condividano `table:<tableId>`;
- richieste con utente e sala distinti non abbiano collisioni artificiali;
- lo scheduler non estragga task con una chiave attiva e registri/rilasci tutte
  le chiavi del task.

La concorrenza non apre quindi operazioni simultanee sullo stesso utente, sala
o tavolo. Il fallimento del gate e' prestazionale, non di integrita.

## Canary A/B

Baseline concurrency 1, gia prodotte con la stessa telemetria e lo stesso
profilo:

- 20: `p4_room_change_branch20_20260713_run2`;
- 50: `p4_room_change_branch50_20260713_run1`.

Target concurrency 2:

- 20: `p4_room_lane_concurrency20_target_20260713_run1`;
- 50: `p4_room_lane_concurrency50_target_20260713_run1`.

Tutti i run usano 12 probe direct/pending, due API worker, un table-lock worker,
GUI reali headless, MySQL, Redis, quattro stampanti virtuali e mock I/O.

| Metrica | 20 C1 | 20 C2 | 50 C1 | 50 C2 |
| --- | ---: | ---: | ---: | ---: |
| business ops riuscite | 240/240 | 240/240 | 600/600 | 600/600 |
| device persistiti | 20/20 | 20/20 | 50/50 | 50/50 |
| probe riusciti | 12/12 | 12/12 | 12/12 | 12/12 |
| direct p50 | 69 ms | 85 ms | 220 ms | 210 ms |
| direct p95 | 307 ms | 698 ms | 2933 ms | 2180 ms |
| direct p99 | 307 ms | 698 ms | 2955 ms | 6407 ms |
| pending p50 | 62 ms | 147 ms | 1040 ms | 630 ms |
| pending p95/p99 | 1292/1292 ms | 1476/1476 ms | 2722/2722 ms | 9848/9848 ms |
| room-change wait medio | 161,09 ms | 235,97 ms | 629,84 ms | 852,11 ms |
| room-change wait max | 1236 ms | 1232 ms | 2753 ms | 9621 ms |
| room-change run medio | 65,33 ms | 90,55 ms | 154,64 ms | 144,22 ms |
| direct write medio | 62,11 ms | 70,26 ms | 159,81 ms | 109,29 ms |
| pending write medio | 47,92 ms | 81,31 ms | 112,54 ms | 139,62 ms |
| HTTP globale p95 | 659 ms | 765 ms | 1538 ms | 1321 ms |
| HTTP globale p99 | 1328 ms | 1771 ms | 3866 ms | 4248 ms |
| SSE p95 | 256 ms | 253 ms | 269 ms | 271 ms |
| MySQL redo | 59.276.288 B | 55.707.136 B | 94.592.512 B | 98.999.296 B |

Tutti i run hanno zero failure, drain relazionale completo, outbox non
pubblicati a zero, stampe fallite a zero e fiscal outbox senza problemi. Nei
target risultano rispettivamente 40/40 e 100/100 ordini creati, oltre a 200/200
e 500/500 altre operazioni completate.

## Analisi

A 20 device concurrency 2 peggiora direct, pending, wait medio, run medio e i
percentili HTTP globali. A 50 device riduce direct p95 e HTTP p95, ma peggiora
la coda lunga: direct p99 raddoppia, pending p95 sale a 9,8 secondi e il wait
massimo raggiunge 9,6 secondi.

La maggiore concorrenza redistribuisce la coda ma introduce contesa sulle
scritture condivise. Il run medio della route cambia poco, mentre wait medio e
tail diventano meno prevedibili. Il risultato non e' stabile nei due carichi e
non soddisfa il gate p95/p99.

## Decisione

**NO-GO per concurrency 2; GO per allineare il fallback stabile a 1.**

Non viene promosso parallelismo aggiuntivo nella room lane. L'override del
runner resta disponibile per ripetere misure controllate, senza creare una
seconda configurazione implicita.

## Intervento successivo completato

La misura di `POST /api/pos/room-change/approve` e' completata e separa:

1. lettura e autorizzazione;
2. rimozione relazionale della richiesta pending;
3. mutazione sessione/utente;
4. mirror app-state;
5. eventuale prune/fallback.

Nei canary validi il PIN pesa 169-182 ms medi, il mirror app-state 80-165 ms e
il delete relazionale 0,83-1,33 ms. Il prossimo intervento e' una prova PIN
asincrona pre-lane con rivalidazione interna, non una write puntuale non
atomica. Dettagli in
`cassa-frontend/FASE_P4_3_ROOM_CHANGE_APPROVE_MEASUREMENT_20260713.md`.

## Verifiche

```text
npm run check:backend
node --test --test-concurrency=1 backend/tests/lane-scheduler-step11.test.mjs
node --test --test-concurrency=1 --test-name-pattern="Fase P loadtest isola" backend/tests/phase-p-validation-preflight.test.mjs
node --test --test-concurrency=1 backend/tests/route-policy-architecture.test.mjs backend/tests/architecture-line-budget.test.mjs
```
