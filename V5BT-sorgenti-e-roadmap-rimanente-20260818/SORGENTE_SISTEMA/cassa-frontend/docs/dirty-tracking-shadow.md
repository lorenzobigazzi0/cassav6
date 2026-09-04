# Fase 01 — Dirty tracking shadow / write amplification guard

Questa fase introduce un rollout sicuro per il dirty tracking dell'app-state. L'obiettivo non è ancora rendere il dirty tracking autoritativo in produzione, ma misurare quali domini vengono davvero modificati da ogni `writeDb` e confrontarli con i domini dichiarati dagli handler.

## Modalità supportate

`APP_STATE_DIRTY_TRACKING` e `APP_STATE_DIRTY_TRACKING_MODE` supportano ora queste modalità:

| Modalità | Effetto |
|---|---|
| `off` / `0` | Dirty tracking disattivo. |
| `shadow` | Osserva domini modificati vs dichiarati, registra metriche, non cambia la persistenza. |
| `warn` | Come shadow, ma logga warning se un dominio modificato non è dichiarato. |
| `write` / `1` | Mantiene il comportamento legacy del fast-path per domini esternalizzati, senza blocco coverage. |
| `enforce` | Usa il fast-path e blocca mismatch dopo una baseline valida. |

Per la roadmap near-real-time il profilo consigliato è:

```env
APP_STATE_DIRTY_TRACKING=shadow
APP_STATE_DIRTY_TRACKING_MODE=shadow
```

Passare a `warn` solo dopo baseline, e a `enforce` solo dopo STOP/REVIEW.

## Cosa viene misurato

Per ogni write con dirty tracking attivo vengono raccolti:

- `declaredDomains`: domini dichiarati da `splitDomains` / `domains`;
- `changedDomains`: domini effettivamente cambiati rispetto alla baseline comparabile in memoria;
- `missingDeclaredDomains`: domini cambiati ma non dichiarati;
- `overDeclaredDomains`: domini dichiarati ma non cambiati;
- `fullyExternalized`: true se tutti i domini dichiarati sono esternalizzati;
- `persistedFastPath`: true se il fast-path di persistenza è stato usato;
- `comparableBytes` e `durationMs`.

Questi dati finiscono nello snapshot runtime metrics sotto:

```text
snapshot.appState.dirtyTracking
snapshot.counters.appStateDirtyTrackingObservations
snapshot.counters.appStateDirtyTrackingMissing
snapshot.counters.writeDbFullStateFallback
```

## Comandi utili

Raccogliere uno snapshot runtime:

```bash
npm run diag:collect-runtime-metrics
```

Analizzare il dirty tracking:

```bash
npm run dirty:tracking:analyze
```

Eseguire i test della fase:

```bash
npm run test:phase1
```

## Gate per passare a `warn`

Prima di passare a `warn`, verificare:

```text
missingDeclarations note e spiegate
nessun handler caldo con domini mancanti critici
full-state fallback misurato per route
baseline salvata in reports/
```

## Gate per passare a `enforce`

Prima di passare a `enforce`, verificare:

```text
missingDeclarations = 0 sui path caldi
writeDbFullStateFallback = 0 sui path caldi già migrati
load test 25/50 palmari senza mismatch nuovi
rollback pronto con APP_STATE_DIRTY_TRACKING=shadow oppure 0
```

## Nota di sicurezza

In `shadow` e `warn` la semantica business non cambia: la scrittura full-state resta disponibile. In `enforce`, invece, un handler con domini non dichiarati può essere bloccato. Per questo `enforce` non va usato come primo rollout.
