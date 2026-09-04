# Applicazione roadmap PostgreSQL V6 - workspace D:

## Input

- `V6.0.0.6.zip`
  - SHA-256: `8FDC73B116FD1C697A127CC10E1104BCF7046121522F4C65FB8177F7F1506361`
- `V6_POSTGRESQL_MIGRATION_ROADMAP_REV2.zip`
  - SHA-256: `6AA37ACC12F423A9B021B9419F21D405C091D132C6304CDF47102D481AEDD992`

La verifica di overlay ha confrontato tutti i 4.169 file dello ZIP V6.0.0.6
con la workspace attiva: erano gia identici. Nessun file e stato sovrascritto o
aggiunto. Il manifest di rollback e in
`D:\sistemacassav6\.rollback\before-v6.0.0.6-20260831-101935`.

## Modifiche applicate

- roadmap REV2 installato sotto `ROADMAP_V6/POSTGRESQL`;
- inventario legacy MIG-001 rigenerabile;
- golden dataset MIG-002 versionato con checksum;
- collector read-only MIG-003 aggiunto e testato;
- MIG-003 eseguito sul Raspberry reale per 301,4 secondi e chiuso con evidenza valida;
- PostgreSQL 17 predisposto sul Raspberry in modalita DEV su microSD con
  checksum e durabilita attivi;
- MIG-011 completata con pool opt-in, health e metriche senza attivare percorsi
  dati PostgreSQL;
- MIG-012 completata con migration runner idempotente, checksum immutabili,
  advisory lock e rollback verificati su database temporaneo Raspberry;
- stato e prove della migrazione aggiornati senza percentuali arbitrarie.

## Confini preservati

- nessun read/write path e stato commutato a PostgreSQL;
- nessun servizio o database reale e stato modificato;
- Redis resta fuori perimetro come richiesto dalla REV2;
- gli importi del golden dataset sono verificati in centesimi interi;
- P1 puo procedere esclusivamente in modalita sviluppo su microSD, secondo
  `DOCUMENTAZIONE/HW01_SD_DEVELOPMENT_DECISION_20260831.md`.

La baseline risorse reale e completa. Su decisione operativa del 2026-08-31,
l'assenza di SSD/NVMe non blocca sviluppo e test funzionali: PostgreSQL puo
essere preparato sulla microSD con configurazione conservativa e garanzie di
durabilita attive. HW-01 resta invece aperta per produzione, prove finali sullo
storage definitivo e cutover.
