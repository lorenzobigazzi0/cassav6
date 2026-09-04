# Fase P4 - Auth API worker e lock pagamento cross-processo

Data: 2026-07-12

## Obiettivo

Ridurre il costo di autenticazione sui processi API e correggere il pagamento
cross-processo che restituiva `428 TABLE_LOCK_REQUIRED` nonostante il lock
fosse attivo nel worker dedicato. Tutte le prove usano solo fiscale e
stampante TCP virtuali su loopback; cassa automatica e I/O hardware reali sono
disabilitati.

## Implementazione

- Fast path auth degli API worker dietro
  `BACKEND_API_WORKER_REQUEST_AUTH_FASTPATH=1` e cache Redis sessione dietro
  `BACKEND_API_WORKER_REDIS_SESSION_CACHE=1`.
- Lookup sessione Redis/MySQL indicizzato senza idratare l'intera lista delle
  sessioni; fallback legacy conservato in caso di errore MySQL.
- Refresh puntuale del lock MySQL richiesto dai pagamenti e riuso del contesto
  auth gia validato dal boundary API.
- Correzione della cache `sanitizePosSettings`: il refresh lock ora crea una
  nuova snapshot di `posSettings` prima di applicare `workLock`. La precedente
  mutazione in-place lasciava nella WeakMap una vista stale senza lock; per
  questo l'assert vedeva `null` mentre heartbeat e MySQL vedevano il lock
  corretto.
- Telemetria per hit/miss/assegnazione del refresh lock puntuale.
- Runner Raspberry irrobustito: i mock sono processi tracciati direttamente,
  hanno TERM con KILL di fallback e le porte di test vengono controllate prima
  di fermare i servizi live.

Rollback dei fast path auth:

```text
BACKEND_API_WORKER_REQUEST_AUTH_FASTPATH=0
BACKEND_API_WORKER_REDIS_SESSION_CACHE=0
```

## Verifica funzionale

- Suite pagamenti, invarianti, fiscale, write-primary e architettura ARM:
  **168/168 verdi**.
- Runtime metrics ARM: **8/8 verdi**.
- Preflight/runner P4 ARM: **12/12 verdi**.
- Canary diagnostico prima del fix cache: 3 pagamenti e 3 retry, tutti `428`;
  MySQL registrava 18 hit e 18 assegnazioni lock, zero miss.
- Canary dopo il fix: pagamento `200` al primo tentativo, nessun retry e zero
  failure.
- Canary 50 device: 54/54 create, 3/3 pagamenti `200`, 50/50 SSE, zero
  failure/duplicati e tutte le code drenate.

## A/B auth 50 device

| Profilo | Create p50 | Create p95 | Errori |
| --- | ---: | ---: | ---: |
| Fast auth OFF | 941 ms | 2.588 ms | 0 |
| Fast auth ON | 602 ms | 2.555 ms | 0 |

Il fast path elimina l'idratazione sessioni dal percorso autenticato e riduce
il p50 del 36%; il p95 resta dominato dalla coda dell'order lane.

## Load100 completo

Profilo: 100 palmari, 10 postazioni, 5 GUI, 100 SSE, 10 operazioni per device,
2 API worker, 1 owner, 1 realtime gateway e 1 table-lock worker.

| Metrica | Baseline tombstone | Dopo fix | Variazione |
| --- | ---: | ---: | ---: |
| Durata | 107.869 ms | 97.655 ms | -9,5% |
| HTTP globale p95 | 10.204 ms | 8.143 ms | -20,2% |
| HTTP globale p99 | 45.931 ms | 25.878 ms | -43,7% |
| Create p50 | 3.808 ms | 4.296 ms | +12,8% |
| Create p95 | 10.691 ms | 7.956 ms | -25,6% |
| SSE p95 | 1.414 ms | 1.080 ms | -23,6% |
| Failure | 7 | 0 | -100% |

Correttezza finale:

- 201/201 create riuscite;
- 100/100 stream SSE, zero errori di connessione/parse;
- nessun `428 TABLE_LOCK_REQUIRED` nei pagamenti;
- zero payment duplicate e zero fiscal duplicate;
- outbox, stampa e fiscale completamente drenati;
- table-lock canary cross-worker verde;
- mock `9109/9290` chiusi e tutti i sette servizi live ripristinati.

## Collo residuo

Il gate P4 resta rosso per latenza. Nei due API worker:

- `orderCreateInternal:readDb` medio: 870-1.042 ms;
- write-primary relazionale create medio: 11-17 ms;
- order lane wait p95: fino a 5-10 secondi nei bucket;
- CPU media API worker: circa 42-46 tick/s, quindi il target non esaurisce i
  quattro core ma serializza troppo lavoro nelle due lane.

Il prossimo A/B deve confrontare 2 contro 4 API worker sullo stesso profilo e,
in parallelo solo dopo la misura, rendere puntuali le idratazioni di lock e
stato postazioni nel percorso create. Il gate resta `order.create p95 <300ms`
con zero regressioni di coerenza.

## Evidenze

- Baseline: `logs/loadtest-p4_tombstone_load100_r1_20260712/`
- Canary fix: `logs/loadtest-p4_payment_lock_fix_canary_20260712/`
- Canary 50: `logs/loadtest-p4_auth_payment_fix_canary50_20260712/`
- Load100: `logs/loadtest-p4_auth_payment_fix_load100_r1_20260712/`
