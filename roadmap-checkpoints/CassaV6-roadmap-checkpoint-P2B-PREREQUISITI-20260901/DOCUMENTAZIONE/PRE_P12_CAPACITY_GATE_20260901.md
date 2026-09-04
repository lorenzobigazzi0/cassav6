# Gate capacita prima di P12

Data: 2026-09-01

## Esito

Il gate e definito ma non ancora certificato: P12 non puo iniziare finche
l'importer non viene misurato con il dataset reale e finche il budget disco non
viene compilato con le dimensioni reali sul Raspberry. Lo sviluppo continua su
microSD; nessun SSD e richiesto come prerequisito DEV.

## Budget memoria provvisorio, profilo monoprocesso

Fonte: baseline MIG-003 sul Raspberry Pi 5 da 4 GiB, con Cassa e MariaDB attivi.
`MemAvailable` minimo e usato per non contare la page cache recuperabile come
memoria indisponibile.

| Voce | Budget MiB | Origine |
|---|---:|---|
| RAM fisica | 4.049,0 | misura Raspberry |
| OS, servizi, Cassa e MariaDB gia coesistenti | 1.004,1 | RAM totale - minimo `MemAvailable` |
| PostgreSQL `shared_buffers` | 256,0 | configurazione DEV |
| PostgreSQL `work_mem` | 24,0 | 6 connessioni x 2 MiB x 2 nodi di lavoro |
| PostgreSQL `maintenance_work_mem` | 64,0 | configurazione DEV |
| processi/connessioni PostgreSQL | 128,0 | riserva operativa da sostituire con RSS misurato |
| importer P12 | 512,0 | tetto di ammissione, non misura |
| contingenza operativa | 256,0 | picchi non attribuiti |
| totale impegnato | 2.244,1 | somma delle voci |
| margine residuo | 1.804,9 (44,6%) | deve restare sopra 809,8 MiB (20%) |

Questo calcolo vale soltanto con:

- `BACKEND_API_WORKER_ENABLED=0`;
- `BACKEND_REALTIME_GATEWAY_ENABLED=0`;
- un pool PostgreSQL massimo di 6 connessioni;
- un solo importer;
- MariaDB ancora attiva.

Prima di P12 va eseguito un campionamento simultaneo di Cassa, MariaDB,
PostgreSQL e importer. Il gate fallisce se l'importer supera 512 MiB, se viene
attivato un altro processo con pool proprio o se il margine misurato scende al
20% o meno. Swap e zram non contano come margine.

## Budget disco microSD

L'ultima misura disponibile dichiara 58 GiB totali e 41 GiB liberi. Il margine
minimo del 20% e 11,6 GiB; quindi l'incremento massimo ammissibile rispetto allo
stato misurato e 29,4 GiB.

Il preflight P12 deve compilare, in byte, questa disequazione:

```text
dimensione PostgreSQL dopo import
+ staging temporaneo importer
+ crescita archivio WAL durante import e verifica
+ dump logico conservato
+ base backup conservati simultaneamente
<= 29,4 GiB
```

La dimensione MariaDB reale non va ignorata: e gia compresa nello spazio usato
al momento della misura e deve restare presente per tutta la prova. Se la misura
dei 41 GiB viene ripetuta dopo pulizie o nuovi backup, l'intera disequazione va
ricalcolata dal nuovo `df`, senza riusare 29,4 GiB.

## Evidenze obbligatorie prima di P12

1. `du` di MariaDB, PostgreSQL, archivio WAL, dump logici e base backup;
2. `df` prima dell'import, al picco e dopo la verifica;
3. RSS massimo per Cassa, MariaDB, PostgreSQL e importer;
4. numero reale di processi e connessioni PostgreSQL;
5. margine RAM e disco entrambi maggiori del 20%;
6. dataset identificato da checksum.

I tempi MIG-013 (`restore` 21 ms, PITR 6.065 ms) riguardano
`temporary_mig013_probe`, con `production_certified=false`. Non sono una stima
della finestra di manutenzione e non possono essere usati nel piano di cutover.
