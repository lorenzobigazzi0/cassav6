# Contenuto pacchetto

## SORGENTE_SISTEMA

Sorgente CASSAv6 `6.0.0.7` aggiornato al checkpoint dei prerequisiti P2b:

- backend Node.js con persistenza MariaDB e foundation PostgreSQL;
- frontend Mobile;
- frontend Cassa;
- frontend Postazione;
- frontend Impostazioni;
- frontend Monitor;
- frontend Prenotazioni;
- dashboard Batteria;
- script di avvio HTTPS LAN.

Sono inclusi la migrazione PostgreSQL per `audit.events` partizionata, il golden
dataset V2, il gate della baseline P2b e le relative evidenze.

Dipendenze installate, cache, log, certificati locali e stato runtime non sono
inclusi.

## Artefatti rigenerabili esclusi

`WEBAPP_COMPILATA`, `dist`, `build`, cache Gradle, APK/AAB e `node_modules`
sono esclusi intenzionalmente: vengono ricreati dalla compilazione.

## APPLICATIVI

### Palmare

- sorgente Android completo;
- sorgente webapp embedded con supporto offline;
- script di build.

### Postazione

- sorgente Android completo;
- sorgente webapp embedded;
- script di build.

## DOCUMENTAZIONE

Handover, stato della roadmap PostgreSQL, capacity gate pre-P12 e report di
validazione.

Consultare prima `LEGGIMI.md`.
