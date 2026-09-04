# Fase P4 - Cache sessione Redis per worker lock tavoli

Data: 2026-07-11

## Obiettivo

Rimuovere il lookup puntuale MySQL della sessione dal percorso caldo delle
mutazioni lock tavolo, senza introdurre una finestra nella quale un token gia
revocato possa essere accettato dopo il logout.

## Implementazione

La cache e condivisa tra processi tramite Redis ed e attivata con:

```text
BACKEND_TABLE_LOCK_WORKER_REDIS_SESSION_CACHE=1
```

Caratteristiche:

- chiave separata per `deviceUuid + tokenHash`, quindi nessuna collisione tra
  sessioni/app diverse sullo stesso device;
- login e session status pubblicano il record completo solo dal percorso
  autorevole;
- il worker lock legge Redis, ma non ripopola la cache dopo un miss;
- miss, Redis vuoto o errore di lettura ricadono sul lookup MySQL autorevole;
- logout e revoche da nuovo login cancellano Redis prima della rimozione MySQL;
- se Redis non conferma la cancellazione, la revoca risponde 503 e la sessione
  autorevole resta attiva: non viene mai restituito un falso logout riuscito;
- la rimozione utenti invalida le relative sessioni Redis e usa
  `sessionsSync.deleteMissing=true` per eliminare anche le righe MySQL;
- le sessioni eliminate dal limite massimo di login vengono ora incluse nella
  cancellazione MySQL puntuale.

Rollback immediato:

```text
BACKEND_TABLE_LOCK_WORKER_REDIS_SESSION_CACHE=0
```

Con il flag a zero il worker torna al lookup sessione MySQL precedente. Le
scritture, i lock e la source of truth non cambiano.

## Correzione aggiuntiva

Il test di sicurezza ha rilevato che il route guard multi-processo bloccava i
preflight HTTP `OPTIONS` con 503 prima del gestore CORS. `OPTIONS` ora raggiunge
il solo gestore preflight; tutte le route applicative restano protette dal
guard.

## Test automatici

- suite finale locale rilevante: 236/236;
- suite ARM mirata pre-attivazione: 37/37;
- budget `backend/server.js`: 38.798 righe, margine M5 701;
- test unitari dedicati: cache per token, delete batch, fallback MySQL,
  ordinamento logout, revoca login e ACK heartbeat dopo write Redis;
- riuso immediato del token dopo logout: 401;
- cache Redis rimossa manualmente durante sessione attiva: acquire e release
  riusciti via MySQL; il worker non ha ripubblicato la cache.

## Canary LAN

Tre run, ciascuno con 56 tavoli, 3 round, concorrenza 50 e 504 mutazioni:

| Run | Acquire p95 | Heartbeat p95 | Release p95 | Errori |
| --- | ---: | ---: | ---: | ---: |
| 1 | 394 ms | 138 ms | 130 ms | 0 |
| 2 | 307 ms | 141 ms | 138 ms | 0 |
| 3 | 279 ms | 113 ms | 106 ms | 0 |

Totale: 1.512/1.512 mutazioni riuscite e instradate al worker lock.

Telemetria auth dopo i tre run:

- cache hit: 1.512;
- cache miss: 0;
- query sessione MySQL: 0;
- errori Redis: 0;
- lookup Redis medio: 5,53 ms (prima MySQL circa 14-16 ms);
- riduzione del costo auth diretto: circa 60-65%.

Il p95 complessivo resta variabile per la contesa delle transazioni lock
MySQL. La mediana dei tre p95 e 307/138/130 ms; rispetto all'ultimo singolo run
ibrido 338/125/132 ms il beneficio e netto su acquire, neutro su release e
coperto dal rumore del pool su heartbeat. Il risultato strutturale e che il
pool non riceve piu una query sessione per ogni mutazione.

## Contesa cross-process

Canary reale con due processi distinti su 5285 e 5286:

- 280/280 gare con esattamente un 200 e un 409;
- doppio 200: 0;
- doppio 409: 0;
- errori release: 0;
- p50 67 ms, p95 130 ms, p99 240 ms, max 243 ms.

Il worker temporaneo 5286 e stato arrestato al termine.

## Deploy

- release: `/opt/cassav4/releases/20260711-p4-redis-session-cache-042830`;
- link attivo: `/opt/cassav4/current`;
- owner, realtime, API 5283/5284, worker lock, frontend, batteria e Redis attivi;
- stampa reale, fiscale reale e cassa automatica reale disabilitati;
- chiavi auth di test residue: 0;
- unita fallite: 0;
- errori applicativi nel journal post-deploy: 0.

## Prossimo collo

L'autenticazione non compete piu con il CAS per una query sessione, ma ogni
mutazione lock continua a usare una nuova connessione RESP Redis e il pool
MySQL dedicato resta il costo dominante. Il prossimo step deve misurare un
client Redis persistente/pipelined oppure separare ulteriormente acquire dalle
mutazioni heartbeat/release, senza modificare gli invarianti CAS gia verdi.
