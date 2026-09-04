# MIG-013 - backup, restore e PITR PostgreSQL DEV su microSD

Data: 2026-08-31

## Esito

L'implementazione DEV di MIG-013 e operativa sul Raspberry `192.168.0.67`.
Sono stati verificati dump logico, restore isolato, base backup fisico con
manifest SHA-256, archivio WAL e recupero PITR fino a un restore point nominato.

Il risultato non certifica la produzione: dati PostgreSQL, WAL e backup sono
attualmente sulla stessa microSD. La perdita del dispositivo eliminerebbe sia
il cluster sia la copia locale. La replica su storage indipendente e il nuovo
drill con dataset reale restano gate di produzione.

## Architettura operativa

- gli script sorgente sono in
  `SORGENTE_SISTEMA/cassa-frontend/scripts/postgresql-migration`;
- gli eseguibili installati sul Raspberry sono in
  `/usr/local/libexec/cassav6-postgresql`;
- gli artefatti runtime privati sono sotto
  `/var/backups/cassav6-postgresql` e non entrano nel repository;
- nessuna password e letta o salvata dagli script: le operazioni locali usano
  l'utente di sistema `postgres` e autenticazione `peer`;
- il dump logico usa formato custom, compressione zstd, checksum SHA-256,
  validazione del TOC e pubblicazione atomica;
- il restore logico crea sempre un database temporaneo con prefisso
  `cassav6_restore_verify_` e non puo sovrascrivere `cassav6`;
- il base backup usa formato plain, WAL in streaming, manifest SHA-256 e
  `pg_verifybackup`;
- l'archivio WAL e atomico e rifiuta la sovrascrittura di un segmento esistente
  con contenuto diverso;
- la retention conserva 7 dump logici per database e 2 base backup; i WAL
  precedenti al base backup piu vecchio conservato sono rimossi con
  `pg_archivecleanup`;
- lock `flock` fail-fast impediscono backup concorrenti.

## Pianificazione

Sono attivi due timer `systemd`:

- dump logico giornaliero alle 03:30, con ritardo casuale massimo di 10 minuti;
- base backup la domenica alle 04:15, con ritardo casuale massimo di 15 minuti.

Entrambi i servizi sono stati avviati manualmente dopo l'installazione e hanno
terminato con `Result=success` ed `ExecMainStatus=0`.

## Configurazione PostgreSQL verificata

```text
fsync=on
full_page_writes=on
synchronous_commit=on
wal_level=replica
archive_mode=on
archive_timeout=5min
archive_command=/usr/local/libexec/cassav6-postgresql/archive-postgresql-wal.sh %p %f
```

La configurazione precedente e stata archiviata in:

```text
/var/backups/cassav6-postgresql/pre-mig013-20260831T111818Z
```

## Drill reale sul Raspberry

Dataset controllato: database temporaneo con tabella
`mig013_restore_probe.events`.

Tempi misurati sulla microSD `/dev/mmcblk0p2`, ext4:

- backup logico: 177 ms;
- restore logico: 21 ms;
- base backup fisico: 4.977 ms;
- restore PITR end-to-end: 6.065 ms.

Il base backup conteneva `base_seed`; dopo il backup e stata aggiunta la riga
`before_target`, e stato creato il restore point, poi e stata aggiunta
`after_target`. Il cluster ripristinato conteneva esattamente:

```text
base_seed,before_target
```

La riga `after_target` era assente, quindi il recupero si e fermato al target
richiesto. Il clone e stato promosso, arrestato e rimosso; anche il database
fixture e stato eliminato.

Evidenza versionata:

```text
SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig013/raspberry-dev-sd-20260831.json
SHA-256 b154b91ce0bc501a2435b1b1635ea33ff521baeb747b30cbccb924d8cfe14f22
```

## Verifiche post-drill

- dump `cassav6` eseguito dal servizio e ripristinato su database temporaneo in
  13 ms;
- ultimo base backup schedulato riverificato con `pg_verifybackup`;
- `pg_stat_archiver`: 20 file archiviati, 0 fallimenti al controllo finale;
- nessun database `cassav6_mig013_*` o `cassav6_restore_verify_*` residuo;
- directory `restore-work` vuota;
- schema `app_meta` ancora assente da `cassav6`, quindi MIG-020 non e stata
  anticipata;
- `cassav5bt.service`, MariaDB e PostgreSQL tutti `active`;
- timer logico e fisico entrambi `enabled`;
- spazio root finale: 41 GiB disponibili su 58 GiB;
- backup PostgreSQL locali: circa 164 MiB dopo i drill.

## Comandi ripetibili

```text
sudo bash scripts/postgresql-migration/mig013-backup-tools.test.sh
sudo bash scripts/postgresql-migration/configure-postgresql-backup-dev-sd.sh
sudo bash scripts/postgresql-migration/mig013-backup-restore-smoke.sh
sudo systemctl start cassav6-postgresql-logical-backup.service
sudo systemctl start cassav6-postgresql-base-backup.service
```

## Gate ancora aperti

- copia automatica e verificata su dispositivo indipendente;
- retention dimensionata sul dataset reale e sulla finestra PITR concordata;
- restore con dataset reale e confronto con la finestra di manutenzione;
- nuova misura su storage definitivo quando sara disponibile;
- reboot del Raspberry non eseguito in questo step.

Questi punti non bloccano lo sviluppo su SD autorizzato da HW-01-DEV, ma
impediscono di considerare il backup attuale una protezione da guasto fisico o
di autorizzare cutover e produzione.
