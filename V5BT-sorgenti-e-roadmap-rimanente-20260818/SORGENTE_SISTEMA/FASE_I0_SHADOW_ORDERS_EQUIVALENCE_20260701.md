# Fase I0 - Shadow orders equivalence

Data: 2026-07-01

## Obiettivo

Verificare automaticamente che lo shadow relazionale degli ordini resti equivalente all'app-state prima di proseguire con la fase read-primary degli ordini.

## Implementazione

- Aggiunto il gate runtime `assertRelationalEquivalence(appState, db, domains)` in `cassa-frontend/backend/db/relational/index.js`.
- Aggiunta normalizzazione domini per `RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS`, con alias come `order`, `orders`, `table`, `tablesBills` e `all`.
- Il runtime relazionale esegue il confronto dopo il sync app-state -> relational quando e' configurato uno di questi env:
  - `BACKEND_RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS`
  - `RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS`
  - `BACKEND_RELATIONAL_EQUIVALENCE_DOMAINS`
- Per I0 il valore previsto e': `RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS=orders`.
- In caso di mismatch il gate solleva errore con row count e checksum app-state/relazionale.

## Test aggiunti

- `runtime shadow I0 verifica equivalenza orders dopo sync`
- `assertRelationalEquivalence blocca orders non equivalente`

## Verifica eseguita

Comandi eseguiti con `/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node`:

- `node --check cassa-frontend/backend/db/relational/index.js`
- `node --check cassa-frontend/backend/tests/relational-orders.test.mjs`
- `node --check cassa-frontend/backend/tests/relational-equivalence.test.mjs`
- `node --test cassa-frontend/backend/tests/relational-orders.test.mjs` -> 14 pass
- `node --test cassa-frontend/backend/tests/relational-equivalence.test.mjs` -> 11 pass
- `node --test cassa-frontend/backend/tests/orders-payments-invariants.test.mjs` -> 16 pass
- `node --test cassa-frontend/backend/tests/relational-shadow.test.mjs` -> 53 pass
- `node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs` -> 1 pass

## Esito

Fase I0 completata. Lo shadow ordini ora puo' essere controllato automaticamente dopo ogni sync runtime abilitando `RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS=orders`.

Prossimo step roadmap: Fase I1, letture read-only/storiche degli ordini da relazionale con fallback app-state e test di rollback.
