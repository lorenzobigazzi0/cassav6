# MIG-003 - raccolta baseline Raspberry

## Stato corrente

Il collector software e coperto da test ed e stato eseguito sul Raspberry reale
il 2026-08-31:

- `192.168.0.67`: ping `4/4`, TCP/22 e TCP/5380 `3/3`;
- `GET /api/health`: HTTP 200, backend attivo e database MySQL operativo;
- autenticazione SSH `admin`: completata con la credenziale fornita
  dall'operatore, senza archiviarla nei report.

L'evidenza di raggiungibilita e in
`SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig003/raspberry-reachability-20260831.json`.

La cattura reale di 301,4 secondi ha prodotto 61 campioni e riporta
`gate.validForMig003: true`. Il riepilogo autorevole e in
`DOCUMENTAZIONE/MIG003_RASPBERRY_BASELINE_20260831.md`.

## Raccolta sul Raspberry

Eseguire con Node 22 o successivo mentre backend Node e MariaDB sono attivi.
Indicare la directory che contiene i due file SQLite reali:

```bash
cd /percorso/workspace/SORGENTE_SISTEMA/cassa-frontend

node scripts/postgresql-migration/mig003-hardware-baseline.mjs \
  --duration-seconds 300 \
  --interval-seconds 5 \
  --data-dir /percorso/runtime/data \
  --output reports/postgresql-migration/mig003/raspberry-production.json
```

Il collector legge soltanto:

- modello, architettura, RAM e load average;
- RSS aggregato di Node, MariaDB e PostgreSQL senza argomenti dei processi;
- dimensione dei file SQLite, WAL e SHM;
- `lsblk`, `findmnt`, temperatura e stato throttling;
- stato `systemd` di MariaDB e PostgreSQL.

Non modifica servizi, database o configurazione. Termina con codice `2` se
l'host non e un Raspberry ARM64 o se una prova obbligatoria e mancante.

## Criterio di chiusura

MIG-003 e `DONE` perche il JSON reale contiene `gate.validForMig003: true`.
Questo non chiude HW-01: MIG-010 richiede inoltre
`pg_test_fsync`, `fio`, confronto SD/SSD e decisione scritta sulla coesistenza
MariaDB/PostgreSQL.
