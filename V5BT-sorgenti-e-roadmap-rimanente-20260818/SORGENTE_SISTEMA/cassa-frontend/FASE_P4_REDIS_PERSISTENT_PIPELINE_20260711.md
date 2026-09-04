# Fase P4 - Client Redis persistente con pipeline RESP

Data: 2026-07-11

## Obiettivo

Eliminare il costo di apertura TCP per ogni cache hit sessione del worker lock
tavoli, senza aumentare il numero di query MySQL e senza cambiare gli
invarianti di revoca introdotti nello step precedente.

## Implementazione

Nuovi flag:

```text
REDIS_PERSISTENT_CLIENT=1
REDIS_PERSISTENT_POOL_SIZE=4
```

Il client implementa:

- pool lazy di connessioni RESP persistenti;
- pipeline di piu comandi concorrenti sulla stessa socket;
- associazione FIFO tra comandi e risposte Redis;
- handshake AUTH/SELECT singleflight, una volta per connessione;
- `TCP_NODELAY` e socket non bloccanti per lo shutdown del processo;
- timeout comprensivo dell'attesa iniziale;
- rottura e riallineamento dell'intera pipeline se una risposta va in timeout;
- riconnessione lazy al comando successivo;
- metriche per pool, socket aperte, connessioni totali, reconnect, coda e
  comandi.

L'attivazione e limitata al solo `cassav4-table-lock-worker.service`. Owner,
API worker e realtime mantengono il client precedente.

Rollback:

```text
REDIS_PERSISTENT_CLIENT=0
```

Sul Raspberry e sufficiente rimuovere il drop-in
`80-p4-redis-pipeline.conf`, eseguire `systemctl daemon-reload` e riavviare il
solo worker lock. La cache sessioni Redis e il fallback MySQL restano attivi.

## Scelta del protocollo

La prima variante manteneva una sola richiesta in volo per socket. Sul target
ARM non ha superato il gate:

| Pool | Auth medio | Esito |
| ---: | ---: | --- |
| 8 | 16,11 ms | NO-GO |
| 16 | 13,72 ms | NO-GO |
| 32 | 12,91 ms | NO-GO |

Il problema non era il numero assoluto di connessioni, ma la serializzazione in
ondate delle 50 richieste. La pipeline RESP con pool 4 ha rimosso questa coda.

## A/B pulito ARM

Due processi nuovi, stessa release, stesso database, stesso carico; unica
differenza `REDIS_PERSISTENT_CLIENT`.

Telemetria cumulativa per 1.008 cache hit per lato:

| Profilo | Auth medio | Socket | Errori | Query sessione MySQL |
| --- | ---: | ---: | ---: | ---: |
| Legacy connect-per-command | 14,68 ms | per richiesta | 0 | 0 |
| Pipeline persistente | 7,20 ms | 4 | 0 | 0 |

Riduzione auth diretta: **-50,9%**.

P95 end-to-end dei due run da 504 mutazioni:

| Profilo | Run | Acquire | Heartbeat | Release |
| --- | ---: | ---: | ---: | ---: |
| Legacy | 1 | 416 ms | 131 ms | 111 ms |
| Pipeline | 1 | 236 ms | 118 ms | 136 ms |
| Legacy | 2 | 193 ms | 164 ms | 95 ms |
| Pipeline | 2 | 171 ms | 90 ms | 95 ms |

La release resta sensibile alla variabilita del pool MySQL, ma pipeline vince
in entrambi i run su acquire e heartbeat; release e neutra nel secondo run e
rumorosa nel primo.

## Reconnect reale

Redis e stato riavviato mentre il worker pipeline era attivo. Il canary
successivo ha prodotto:

- 504/504 mutazioni riuscite;
- 4 connessioni originarie + 4 nuove;
- `reconnects=4` esatti;
- errori Redis: 0;
- fallback/query sessione MySQL: 0.

Il cumulativo dopo tre run era 1.512 hit, auth medio 6,90 ms.

## Concorrenza CAS

Canary tra worker legacy e worker pipeline:

- 280/280 gare con un solo vincitore;
- doppio 200: 0;
- doppio 409: 0;
- errori release: 0;
- p50 69 ms, p95 216 ms, p99 238 ms, max 249 ms.

## Deploy finale

Release:

```text
/opt/cassav4/releases/20260711-p4-redis-persistent-173820
```

Canary post-deploy a caldo:

- 504/504 mutazioni riuscite;
- auth medio 4,54 ms;
- cache hit 504, miss 0, errori 0;
- query sessione MySQL 0;
- pool 4, socket aperte 4, connessioni totali 4, reconnect 0;
- acquire p95 243 ms;
- heartbeat p95 119 ms;
- release p95 110 ms.

Test:

- suite finale locale: 239/239;
- suite finale ARM: 181/181;
- test dedicati a riuso socket, AUTH/SELECT, chiusura remota, timeout di tre
  comandi pipelined e reconnessione con protocollo riallineato;
- `backend/server.js` invariato a 38.798 righe, margine M5 701.

Tutti i servizi restano attivi. Stampa reale, fiscale reale e cassa automatica
reale restano disabilitati.

## Prossimo collo

L'auth Redis non e piu il costo dominante. Il prossimo step deve profilare le
fasi MySQL del lock (`connection.acquire`, `SELECT FOR UPDATE`, named lock e
commit) su run alternati, per separare contesa del pool, costo CAS e rumore del
proxy prima di modificare ancora il protocollo di lock.
