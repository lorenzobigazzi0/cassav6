# Fase P4 - Profilo pool MySQL del worker lock tavoli

Data: 2026-07-11

## Obiettivo

Separare il costo di attesa del pool MySQL dalla durata della transazione dei
lock tavolo e scegliere il limite connessioni del solo worker dedicato sul
target ARM, senza modificare owner, API worker, realtime o I/O hardware.

## Telemetria aggiunta

Il repository `mysql-table-locks.repository.js` registra ora le fasi:

- `connection.wait` e `connection.hold`;
- `attempt.total` e `retry.backoff`;
- `transaction.begin`, `transaction.total` e `transaction.commit`;
- `namedLock.acquire`, `row.selectForUpdate`, `callback` e `row.write`;
- `mutation.total`.

Le metriche non alterano il protocollo CAS e sono coperte da test automatici,
incluso il percorso con deadlock e retry.

## Metodo A/B ARM

Per ogni profilo e stato avviato un processo nuovo sul porto 5286, con:

- 50 richieste concorrenti;
- 56 tavoli;
- 1 round di warm-up e 3 round misurati;
- 168 acquire, 168 heartbeat e 168 release misurati;
- Redis persistente con pool 4;
- stampa, fiscale e cassa automatica reali disabilitati.

Il valore effettivo e stato verificato in `/proc/<pid>/environ` prima di ogni
run. Un primo run etichettato pool 8 e stato scartato: gli `EnvironmentFile`
imponevano ancora pool 6. I risultati sotto provengono solo dai processi
verificati rispettivamente con limite 6, 8 e 12.

## Risultati end-to-end

Tutte le 1.512 operazioni misurate nei tre profili sono riuscite.

| Pool | Acquire p50/p95/p99 | Heartbeat p50/p95/p99 | Release p50/p95/p99 | Errori |
| ---: | ---: | ---: | ---: | ---: |
| 6 | 85 / 168 / 174 ms | 64 / 103 / 107 ms | 60 / 88 / 92 ms | 0 |
| 8 | 83 / 151 / 157 ms | 63 / 102 / 110 ms | 62 / 87 / 92 ms | 0 |
| 12 | 106 / 308 / 315 ms | 64 / 110 / 114 ms | 66 / 114 / 116 ms | 0 |

Pool 8 rispetto a pool 6:

- acquire p95: **-10,1%**;
- attesa media connessione: **-12,9%**;
- retry: **-48,8%**;
- heartbeat e release sostanzialmente neutrali.

Pool 12 non supera il gate: acquire p95 sale a 308 ms e il massimo raggiunge
657 ms.

## Fasi MySQL

Metriche cumulative, warm-up incluso, su 672 mutazioni per profilo:

| Pool | Wait medio | Hold medio | Mutation medio | Transaction medio | Retry | Errori |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 6 | 31,91 ms | 9,92 ms | 47,21 ms | 8,74 ms | 43 | 0 |
| 8 | 27,80 ms | 11,87 ms | 42,43 ms | 10,15 ms | 22 | 0 |
| 12 | 22,95 ms | 18,73 ms | 56,87 ms | 17,54 ms | 99 | 0 |

Pool 12 riduce l'attesa per ottenere una connessione, ma aumenta la contesa
InnoDB: i retry crescono da 22 a 99, il tempo di hold sale a 18,73 ms e il
vantaggio del pool piu largo viene perso nella transazione e nel backoff.

## Deploy

Configurazione scelta per il solo `cassav4-table-lock-worker.service`:

```text
BACKEND_MYSQL_CONNECTION_LIMIT=8
```

Rollback immediato:

```text
BACKEND_MYSQL_CONNECTION_LIMIT=6
sudo systemctl restart cassav4-table-lock-worker.service
```

Canary post-deploy sul porto operativo 5285:

- 504/504 operazioni riuscite;
- acquire p50/p95/p99: 89/150/155 ms;
- heartbeat p50/p95/p99: 79/141/146 ms;
- release p50/p95/p99: 67/99/108 ms;
- 672 mutazioni, 21 retry, 0 errori;
- Redis: pool 4, 4 socket aperte, 0 reconnect e 0 fallback MySQL sessione.

Il maggiore rumore dell'heartbeat post-deploy non produce errori, code residue
o fallback. Tutte le altre unita applicative sono rimaste attive.

## Verifica

- suite mirata locale: 24/24;
- suite mirata ARM: 24/24;
- test funzionale ARM: 1.512/1.512 operazioni A/B e 504/504 post-deploy;
- servizi canary e porto 5286 rimossi al termine;
- stampa reale, fiscale reale e cassa automatica reale restano disabilitati.

## Prossimo collo

Il pool non e piu il solo limite. I retry aumentano rapidamente quando cresce
la concorrenza MySQL, anche se il canary usa tavoli distinti. La prossima
ipotesi da verificare e la contesa sui gap InnoDB causata dal ciclo
`DELETE` alla release e nuovo `INSERT` al successivo acquire.

Il prossimo step deve confrontare, sotto flag e con rollback, il modello
attuale con righe persistenti/tombstone che trasformino il nuovo acquire in un
update della chiave primaria gia esistente. Il gate resta: un solo vincitore
CAS, zero lock fantasma dopo restart, zero errori e riduzione misurabile di
retry e p95.
