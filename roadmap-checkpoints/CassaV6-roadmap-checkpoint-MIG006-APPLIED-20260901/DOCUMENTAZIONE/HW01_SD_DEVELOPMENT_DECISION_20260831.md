# HW-01 - decisione operativa per sviluppo su microSD

Data: 2026-08-31

## Decisione

Lo sviluppo della migrazione PostgreSQL V6 puo proseguire sul Raspberry usando
la microSD disponibile. L'assenza temporanea di SSD/NVMe non e un blocco per
sviluppo, integrazione e test funzionali.

La decisione non autorizza il cutover in produzione e non costituisce prova di
durabilita o prestazioni equivalenti a un SSD/NVMe. Quando il nuovo storage sara
disponibile, HW-01 dovra essere rivalutata sul device definitivo prima della
promozione in produzione.

## Vincoli di sicurezza

- MariaDB, SQLite e l'applicazione corrente restano il percorso attivo.
- PostgreSQL viene introdotto inizialmente come infrastruttura di sviluppo,
  disabilitata per default nel backend.
- `fsync`, `full_page_writes` e `synchronous_commit` restano attivi; la microSD
  non viene compensata disattivando le garanzie di durabilita.
- Configurazione e pool devono essere conservativi per i 4 GiB di RAM del
  Raspberry e per la coesistenza con MariaDB.
- Nessun benchmark di scrittura aggressivo viene eseguito sulla microSD che
  ospita il sistema attivo.
- Nessun dato reale viene migrato e nessun read/write path viene commutato senza
  backup, verifica e autorizzazione esplicita del relativo gate.
- Le credenziali PostgreSQL non devono essere salvate nel repository.

## Evidenza hardware corrente

- host: Raspberry Pi 5, Debian 13 arm64;
- storage: solo `/dev/mmcblk0p2`, ext4, root filesystem;
- spazio rilevato prima del provisioning: 41 GiB disponibili su 58 GiB;
- memoria rilevata prima del provisioning: circa 2,9 GiB disponibili su 4 GiB;
- PostgreSQL non installato al momento della verifica;
- MariaDB attivo nella baseline MIG-003.

## Stato del gate

- `HW-01-DEV`: accettata con i vincoli sopra; P1 puo procedere in modalita
  sviluppo.
- `HW-01-PROD`: aperta; blocca test finali di durabilita, promozione e cutover.

