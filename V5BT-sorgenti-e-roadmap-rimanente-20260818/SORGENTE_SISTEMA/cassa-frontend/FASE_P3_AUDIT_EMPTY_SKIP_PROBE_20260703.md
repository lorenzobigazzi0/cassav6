# Fase P3 - Probe skip audit vuoto

Data: 2026-07-03

## Obiettivo

Ridurre il lavoro per singola task ordine evitando il fallback `auditRecent`
quando una mutazione `writeIntegrationOrderSyncDb` non ha prodotto nuovi audit
event espliciti.

## Stato Passo 2 roadmap

La roadmap interinale indicava `mysql-audit-events-split.repository.js` come
file non agganciato. Nel runtime attuale il repository e' gia' importato,
istanziato e usato da `syncOrderAuditEventsFastPath`, con supporto
`syncEntriesFromAppState`.

Quindi il Passo 2 non richiede wiring aggiuntivo in questo snapshot; resta da
misurare ogni micro-ottimizzazione prima di promuoverla.

## Modifica provata

Modifica temporanea poi rimossa:

- `syncOrderAuditEventsFastPath(db, auditEventIds, { skipWhenEmpty: true })`
- ritorno immediato quando `auditEventIds` e' vuoto, solo nel writer ordini

## Smoke

Run: `phaseP_interinale_p3_audit_empty_skip_smoke_20`

- Palmari API: 20
- Postazioni API: 10
- Operazioni per device: 20
- Failure: 0
- `order.create` p95: 4078 ms
- `order.sync.ready` p95: 4778 ms
- `order.sync.delivered` p95: 4584 ms
- `order.correct` p95: 4237 ms
- `order.comp` p95: 3754 ms

Smoke positivo ma non sufficiente per promozione.

## Canary

Run: `phaseP_interinale_p3_audit_empty_skip_canary8_50`

- Palmari API: 50
- Postazioni API: 10
- Operazioni per device: 20
- Failure: 0
- `order.create` p95: 20217 ms
- `order.sync.ready` p95: 18924 ms
- `order.sync.delivered` p95: 19727 ms
- `order.correct` p95: 20750 ms
- `order.comp` p95: 18521 ms
- `payment.free_split` p95: 10762 ms
- `reservation.create` p95: 10257 ms
- `station.heartbeat` p95: 1888 ms

Baseline di confronto: `phaseP_interinale_p3_order_bucket_cache_canary_50`

- `order.create` p95: 14678 ms
- `order.sync.ready` p95: 14890 ms
- `order.sync.delivered` p95: 14817 ms
- `order.correct` p95: 14231 ms
- `order.comp` p95: 13215 ms

## Decisione

Probe respinta e rollbackata.

Il canary resta corretto funzionalmente, ma peggiora il p95 del percorso ordini
rispetto al baseline. Il fallback `auditRecent` non e' il collo dominante in
questa forma; probabilmente il costo residuo e' nella coda/lock o nel lavoro
ordine/posSettings, non nel caso audit vuoto.

## Stato runtime

Ripristinato:

- `syncOrderAuditEventsFastPath(db, auditEventIds = [])`
- `writeIntegrationOrderSyncDb` chiama `syncOrderAuditEventsFastPath(db, options.auditEventIds)`

## Verifiche

- `node --check cassa-frontend/backend/server.js`: OK
- `node --test cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/app-state-repository.test.mjs`: OK durante la probe, 80/80
- dopo rollback runtime: rieseguire almeno `route-policy-architecture.test.mjs`

## Prossimo step consigliato

Continuare su P3 senza riprovare skip audit vuoto.

La strada piu' promettente resta una di queste:

1. coalescing/no-op sicuro per sync duplicate sullo stesso ordine;
2. misurazione piu' fine della coda `order-lane` separando wait/run per
   `workflowStatus` richiesto;
3. riduzione puntuale del costo `posSettingsTables`/table state solo per i
   tavoli toccati, ma senza ripetere la probe table-state entries gia' respinta.

