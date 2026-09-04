# Fase P3.18 - Tavoli/Sale Read-Primary Reconcile

Data: 2026-07-08
Target deploy: Raspberry `192.168.0.67`
Runtime: stampa, fiscale e cassa automatica reale disattivati

## Obiettivo

Preparare il passaggio dei read Tavoli/Sale verso il relazionale senza collegare ancora il layout completo a `table_states`.

P3.17 aveva chiuso la correttezza delle mutazioni ma aveva lasciato `ROOM_LANE_CONCURRENCY=1`, perche' `posSettings` resta un dominio condiviso ampio. Prima di leggere di piu' dal relazionale era necessario verificare che `table_states` fosse equivalente al layout corrente.

## Bug Trovato

Le scoped reads erano gia' attive da relazionale:

- `SCOPED_READS=1`
- `BACKEND_RELATIONAL_TABLES_READ_PRIMARY=1`
- `/api/tables/:id` e `/api/rooms/:roomId/tables` rispondevano con `meta.source=relational`

Pero' `table_states` relazionale era stale rispetto al layout idratato da app-state split.

Canary iniziale:

```text
Run: tables_read_primary_equivalence_p3_18_r1_20260708
Verdict: FAIL
layoutTables: 56
relationalTables: 56
errors: 35
warnings: 27
scopedSamplesOk: 9/9
```

Le differenze principali erano:

- `occupancyState`: 27 errori;
- `amountDueCents`: 8 errori;
- `covers`: 27 warning.

La causa operativa era che `BACKEND_RELATIONAL_SHADOW_SYNC_ENABLED=0` evita la shadow sync completa, mentre il target usa anche `BACKEND_APP_STATE_SPLIT_TABLE_STATES=externalized`.

## Correzioni

- Aggiunto `scripts/tables-read-primary-equivalence-canary.mjs`.
- Aggiunto flag esplicito:

```env
BACKEND_RELATIONAL_TABLES_STARTUP_RECONCILE=1
```

- Il backend owner, all'avvio, esegue `syncTablesBillsFromAppState(relationalRuntime.db, initialAppState, { nowIso })` dopo la `readDb()` idratata e prima della shadow sync generica.
- Il reconcile gira solo sull'owner e solo se il flag e' attivo.
- Aggiornato `deploy/raspberry-final/cassav4.env.example`.
- Aggiunto test sorgente:

```text
backend/tests/route-policy-architecture.test.mjs
P3.18 riconcilia table_states relazionale all'avvio prima delle scoped reads
```

## Verifiche

Log startup backend:

```text
[relational:tables] startup reconcile completato: 56 righe
```

Test mirato su Raspberry:

```text
/usr/local/bin/node --test --test-name-pattern="P3.18" backend/tests/route-policy-architecture.test.mjs
pass: 1/1
```

Canary finale:

```text
Run: tables_read_primary_equivalence_p3_18_r2_20260708
Verdict: PASS
layoutTables: 56
relationalTables: 56
errors: 0
warnings: 0
scopedSamplesOk: 9/9
durationMs: 407.75
```

Health finale:

```text
/api/health ok, database mysql
```

## Decisione

P3.18 e' PASS come prerequisito read-primary Tavoli/Sale.

Non ho ancora collegato `/api/integration/layout` direttamente al relazionale: il layout usa ancora `readDb()` + `posSettings` + overlay finanziario. Ora pero' `table_states` e' riallineato a ogni startup owner e le scoped reads relazionali non partono piu' stale.

## Prossimo Step Consigliato

Procedere con un canary/flag di layout read-primary parziale:

1. costruire overlay Tavoli/Sale partendo dal layout app-state ma sostituendo i soli campi operativi da `table_states` relazionale;
2. mantenere fallback immediato al layout legacy se manca una riga o compare mismatch;
3. misurare p95 di `/api/integration/layout` prima/dopo;
4. solo dopo valutare `ROOM_LANE_CONCURRENCY > 1` o lane per chiave tavolo/sala.

