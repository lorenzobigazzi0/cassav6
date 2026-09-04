# Fase P4 - Fast path richieste table-lock worker

Data: 2026-07-11

## Obiettivo

Ridurre il costo per richiesta del worker lock dedicato senza cambiare la CAS
MySQL, i controlli sala, la scadenza sessione o i permessi di force-release.

## Profilo baseline

Canary ripetibile: 56 tavoli, 3 round, concorrenza 50, per ogni tavolo
`acquire -> heartbeat -> release`; 504 richieste totali, nessun ordine,
pagamento, output fiscale o stampa.

| Operazione | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: |
| Acquire | 212ms | 535ms | 590ms | 744ms |
| Heartbeat | 185ms | 317ms | 353ms | 355ms |
| Release | 174ms | 281ms | 296ms | 297ms |

Il refresh dell'intera tabella sessioni costava in media 31,64ms per richiesta.
Il fast path MySQL ricopiava inoltre il lock dentro `db.posSettings`, facendo
saltare la cache del sanitizer e lasciando possibile una serializzazione
comparabile di circa 20 MB durante la pulizia del mirror incorporato.

## Implementazione

- flag unico `BACKEND_TABLE_LOCK_WORKER_REQUEST_FASTPATH=1`, default OFF;
- attivazione solo sul ruolo `table-lock-worker` e solo con sessioni e lock
  MySQL condivisi;
- lookup sessione puntuale indicizzato per `token_hash + device_uuid`;
- validazione invariata di token, device, TTL, idle timeout e utente;
- errore repository in fallback al percorso completo; sessione assente resta
  un `401` autorevole e non usa dati cache;
- indice riusabile `tableId -> table/room/settings`, invalidato al cambio
  identita impostazioni o versione app-state;
- il lock autorevole resta in MySQL: il worker non muta piu `db.posSettings`
  e non esegue `writeDb` dalle quattro route lock;
- metriche per hit/miss/fallback auth, hit/miss indice e tempi lookup/build;
- canary dedicato in `scripts/table-lock-worker-canary.mjs`, con cleanup in
  `finally`.

Rollback immediato:

```text
BACKEND_TABLE_LOCK_WORKER_REQUEST_FASTPATH=0
```

## Risultato sul Raspberry

Target: `192.168.1.79`, release:
`/opt/cassav4/releases/20260711-p4-lock-fastpath-033244`.

| Operazione | p50 prima/dopo | p95 prima/dopo | p99 prima/dopo | Delta p95 |
| --- | ---: | ---: | ---: | ---: |
| Acquire | 212/123ms | 535/398ms | 590/408ms | -25,6% |
| Heartbeat | 185/116ms | 317/180ms | 353/184ms | -43,2% |
| Release | 174/98ms | 281/174ms | 296/193ms | -38,1% |

- durata canary: 5,1s -> 3,5s, circa -31%;
- 504/504 richieste riuscite e instradate a `table-lock-worker`;
- auth puntuale: 504 hit, 0 miss, 0 fallback;
- indice tavoli: 1 build da 6ms e 503 hit;
- lookup auth MySQL: media 14,69ms;
- `refreshSessions`: media 31,64ms -> 0ms;
- writeDb attribuito alle route lock: 0;
- lock del canary rimasti al termine: 0;
- warning nei journal dopo deploy: 0.

Smoke fail-closed live:

- device errato: 401;
- acquire valido: 200;
- release valida: 200;
- logout: 200;
- token riusato dopo logout: 401.

## Verifiche

- test mirati fast-auth/repository/cache/runtime: 19/19;
- compatibilita lock/proxy/topologia a flag OFF: 158/158 funzionali;
- route policy, sicurezza e margine M5 finali: 130/130;
- deploy statico e test mirati finali: 10/10 locali;
- test ARM nella release, `--test-isolation=none`: 11/11;
- `backend/server.js`: 38.799 righe `wc`, margine M5 700;
- checksum dei 10 file distribuiti: identici locale/remoto;
- HTTPS mobile: 200;
- tutti i servizi owner/realtime/API/lock/frontend/battery: active;
- stampa, fiscale e cassa automatica reali: disabilitati; carte: mock.

## Stato e prossimo collo

Il fast path richieste lock e' verde per correttezza, rollback e miglioramento.
Il p95 client acquire resta 398ms, mentre il massimo route interno osservato e'
283ms: il prossimo profilo deve separare attesa pool MySQL, transazione
`SELECT FOR UPDATE`/CAS e overhead TLS/proxy frontend. P4 complessivo resta
rosso finche order create, layout e station state non rispettano i gate
assoluti del full canary.

Follow-up completato in `FASE_P4_TABLE_LOCK_MYSQL_HYBRID_20260711.md`:
pool 6 confermato, acquire protetto da named lock, heartbeat/release su
transazione pura. Nel canary LAN il p95 finale e' 338/125/132ms e la contesa
cross-process chiude 280/280 gare senza doppio vincitore.
