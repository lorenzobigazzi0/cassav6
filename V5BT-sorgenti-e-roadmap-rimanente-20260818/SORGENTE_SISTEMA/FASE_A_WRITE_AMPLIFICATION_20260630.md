# Fase A - Write Amplification

Data: 2026-06-30
Sorgente: `estratto/v4.0.2-20260629-181421/sistema-cassa-v4.0.2-source`

## Scopo

Seguire la Fase A della roadmap `ROADMAP_REALTIME_CASSAV4.md`: ridurre il costo di `writeDb` per operazioni piccole, evitando serializzazione/confronto dello stato intero quando i domini modificati sono gia' esternalizzati.

## Modifiche

- Aggiunto dirty tracking app-state dietro flag `APP_STATE_DIRTY_TRACKING=1`.
- Se una write dichiara solo domini pienamente esternalizzati, `writeDb` esegue i sync split e salta primary write/confronto completo.
- Aggiunto default dirty tracking per `writeDb(db)` senza hint solo quando tutti i domini iniziali persistenti, escluso `meta`, sono esternalizzati.
- Aggiunto contatore runtime `writeDbDirtyExternalized`.
- Estesi gli script di load/endurance per attivare e riportare il contatore.
- Abilitato il flag nello script Linux di restart.

## Verifica

Test:

- `node --check cassa-frontend/backend/server.js`
- `node --check cassa-frontend/backend/db/app-state/app-state.repository.js`
- `node --check cassa-frontend/backend/modules/runtime-metrics.js`
- `node --test cassa-frontend/backend/tests/app-state-repository.test.mjs` -> 29/29 pass
- `node --test cassa-frontend/backend/tests/runtime-metrics.test.mjs cassa-frontend/backend/tests/relational-payments.test.mjs cassa-frontend/backend/tests/relational-orders.test.mjs cassa-frontend/backend/tests/route-policy-architecture.test.mjs` -> 33/33 pass

Mini-load 25 palmari / 5 postazioni:

| Run | Esito | writeDb | dirty externalized | noop persisted | writeComparable p95 | Durata | Failure |
| --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| `baseline25_2026063002` | baseline | 185 | 0 | 185 | `<=4194304B` | 61s | 0 |
| `phaseA1b_25_2026063001` | hint parziale | 188 | 124 | 64 | `<=4194304B` | 52s | 0 |
| `phaseA2_25_2026063001` | default validato | 200 | 200 | 0 | `<=1024B` | 49s | 0 |

Report:

- `logs/loadtest-phaseA2_25_2026063001/REPORT.md`
- `logs/loadtest-phaseA2_25_2026063001/report.json`

## Esito

Definition of Done principale raggiunta: il p95 dei byte comparabili per scrittura passa da bucket MB a bucket KB sul mini-load 25, senza failure e con test mirati verdi.

## Residuo

Le attese `dbMutation wait` restano alte per route come station state, prenotazioni, spostamenti sala/tavolo e pause cameriere: il tempo di esecuzione interno e' basso, ma la coda globale rimane seriale. Questo e' coerente con le fasi successive della roadmap: prima C/D/E per togliere lavoro percepito/refetch/stampa dal path caldo, poi B per spezzare la coda globale.
