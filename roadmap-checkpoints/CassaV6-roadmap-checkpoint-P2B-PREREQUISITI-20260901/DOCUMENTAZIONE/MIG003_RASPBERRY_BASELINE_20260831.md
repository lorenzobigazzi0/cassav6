# MIG-003 - baseline Raspberry di produzione

## Esito

`DONE`: il collector ha prodotto evidenza valida sul Raspberry reale senza
modificare servizi o database.

- host: `raspberrypi`, Raspberry Pi 5 Model B Rev 1.0, ARM64;
- kernel: Linux real-time;
- Node: v24.15.0;
- durata osservata: 301,4 secondi, 61 campioni;
- RAM totale: 4.245.716.992 byte;
- memoria disponibile minima: 3.192.832.000 byte;
- RSS Node massimo: 59.916.288 byte;
- RSS MariaDB massimo: 205.832.192 byte;
- PostgreSQL: non attivo, come previsto prima di P1;
- temperatura massima: 49,4 gradi Celsius;
- throttling: sempre `throttled=0x0`;
- SQLite: due database reali piu WAL/SHM rilevati.

Evidenza:

- `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig003/raspberry-production-20260831.json`
- SHA-256:
  `e6838b996f48e0bc8f4400bd5e2deca604616c95748f2a780b032be9654a1a67`

## Esito del gate successivo

HW-01 resta `BLOCKED`. `lsblk` e `findmnt` mostrano soltanto:

- `mmcblk0`, trasporto `mmc`, circa 64 GB;
- root filesystem `/` su `/dev/mmcblk0p2`;
- nessun SSD USB3 e nessun NVMe disponibile.

Il roadmap richiede data directory e WAL PostgreSQL su SSD/NVMe. Non sono stati
eseguiti `fio` o `pg_test_fsync` sulla microSD di produzione: aumenterebbero le
scritture senza poter soddisfare il gate, poiche manca il dispositivo di
confronto richiesto.

