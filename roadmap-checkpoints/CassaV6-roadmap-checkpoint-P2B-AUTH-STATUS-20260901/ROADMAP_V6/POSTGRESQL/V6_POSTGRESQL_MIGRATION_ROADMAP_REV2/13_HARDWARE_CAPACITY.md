# 13 — Capacity planning hardware (gate prima di P1)

La REV1 citava il Raspberry una sola volta, in una nota sul pool. Su questo
deployment l'hardware non e un parametro di tuning: e un vincolo che puo
invalidare l'intera architettura target.

## Contesto reale

- Server di produzione: Raspberry ARM64 (`192.168.1.79`).
- Database attuale: MariaDB, schema di produzione con 480 tabelle InnoDB
  (seed `cassav5bt_production_seed_20260719.sql.gz`, ~121k righe).
- Piu due file SQLite (`backend-relational.sqlite`, `app-state-split.sqlite`).
- Carico target dichiarato: 20 palmari + 5 postazioni.
- Profilo standard monoprocesso: `BACKEND_API_WORKER_ENABLED=0`,
  `BACKEND_REALTIME_GATEWAY_ENABLED=0`.

Durante la transizione avresti in esecuzione **contemporaneamente**: MariaDB,
due SQLite, PostgreSQL, Node, piu Redis se non differito.

## HW-GATE-01 — Storage (bloccante)

`08_TEST_PERFORMANCE_DURABILITY.md` richiede correttamente `fsync=on`,
`full_page_writes=on` e `synchronous_commit=on` per le transazioni finanziarie.
Su scheda microSD questo produce due effetti:

1. latenza di commit dominata dal flush, con p95 fuori target gia a basso carico;
2. usura accelerata della scheda, perche ogni COMMIT finanziario forza scrittura
   fisica; il WAL amplifica.

**Requisito**: PostgreSQL (data directory **e** WAL) su SSD/NVMe collegato via
USB3, non su microSD. Se il Pi fa boot da SD, l'SD puo restare come boot device
ma non puo ospitare il cluster.

**Verifica di gate**:

- `pg_test_fsync` sul device scelto, risultato archiviato;
- `fio` con profilo random write 8k sync, risultato archiviato;
- confronto esplicito SD vs SSD sullo stesso Pi.

Se il gate non passa, **non si procede a P1**. Le alternative sono cambiare
storage o cambiare host, non abbassare le garanzie di durabilita.

## HW-GATE-02 — Memoria e coesistenza

Dichiarare la RAM effettiva del dispositivo e costruire il budget:

```text
RAM totale                                   R
- OS + servizi base                          ~
- Node (heap + RSS misurato in baseline P0)  ~
- MariaDB durante la transizione             ~
- PostgreSQL: shared_buffers + work_mem*conn ~
= margine residuo                            deve restare > 20%
```

Punto di partenza per PostgreSQL su un dispositivo piccolo, da validare, non da
copiare:

- `shared_buffers` = 15-25% della RAM;
- `work_mem` basso (4-16 MB) perche moltiplicato per connessione e per nodo di sort;
- `effective_cache_size` realistico, non ottimistico;
- `max_connections` **dimensionato sul pool reale**, non a 100 di default;
- `wal_compression=on` per ridurre I/O su storage lento;
- `checkpoint_timeout` alto e `max_wal_size` adeguato per evitare checkpoint continui.

**Decisione da prendere**: MariaDB resta accesa durante la transizione o viene
fermata dopo l'import? Se resta accesa, il budget deve reggere entrambi i motori
contemporaneamente. Vedi `HW-01` in `12_OPEN_DECISIONS.md`.

## HW-GATE-03 — Pool di connessioni

Il pool non e un numero da aumentare quando le cose vanno piano. Formula:

```text
connessioni totali = (processi API x poolMax) + worker background + tool
```

Su un dispositivo a pochi core, un pool grande peggiora PostgreSQL invece di
migliorarlo. Misurare **queue wait del pool** e non solo la latenza di query:
se il wait cresce mentre la latenza di query resta piatta, il collo di bottiglia
e la CPU o il disco, non il pool.

## HW-GATE-04 — Termica e alimentazione

Su Pi in ambiente ristorativo il throttling termico e reale. Da misurare durante
il load test di P13, non dopo:

- `vcgencmd measure_temp` campionato durante il carico;
- eventi di throttling (`vcgencmd get_throttled`) archiviati con il report;
- alimentazione adeguata all'SSD USB3 sotto carico.

Un load test superato con Pi a 20 gradi e senza SSD sotto carico non e evidenza.

## HW-GATE-05 — Backup e restore sul dispositivo reale

`MIG-012` richiede backup e restore testati. Il test deve avvenire **sull'hardware
di produzione o su hardware identico**, con il dataset reale, e deve misurare il
tempo di restore. Un restore che richiede piu tempo della finestra di manutenzione
prevista rende il rollback teorico.

## Cosa cambia nei target prestazionali

I target di `08_TEST_PERFORMANCE_DURABILITY.md` restano validi come obiettivo, ma
vanno dichiarati **con l'hardware a cui si riferiscono**. Un p95 misurato su
desktop x86 non e trasferibile su ARM64 con storage USB. Ogni numero archiviato
deve riportare: host, storage, versione PostgreSQL, dataset, concorrenza.
