# Database Cassa V5BT

Il seed operativo ufficiale e:

```text
cassav5bt_production_seed_20260719.sql.gz
```

E una copia transazionale a caldo dello schema MariaDB `cassav4` realmente
attivo sul Raspberry `192.168.1.79`. La V4 e rimasta online durante
l'acquisizione.

## Verifiche

- SHA-256:
  `9c1bcdd6095c669440a524987dc173874edd6186f64571eb98788f957ec613f8`
- archivio gzip integro;
- nessuna direttiva `CREATE DATABASE` o `USE cassav4`;
- 480 tabelle, tutte InnoDB;
- import reale completato su MySQL 8.0.46 in un server temporaneo isolato;
- `mysqlcheck`: 480/480 tabelle `OK`;
- 121.187 righe, nessun errore JSON nei domini applicativi controllati.

Il rapporto completo e in
`DATABASE_PRODUCTION_SEED_VALIDATION_20260719.md`.

## Provisioning Isolato

Eseguire una sola volta, come utente desktop normale:

```bash
./database/provision-cassa-v5bt.sh
```

Per verificare soltanto gli input, senza creare segreti o richiedere `sudo`:

```bash
CASSAV5BT_PROVISION_PREFLIGHT_ONLY=1 ./database/provision-cassa-v5bt.sh
```

Lo script richiede `sudo` esclusivamente per le operazioni amministrative
MySQL e:

1. verifica dump e copie SQLite con SHA-256;
2. crea lo schema `cassa_v5bt`;
3. importa le 480 tabelle di produzione;
4. copia i due database SQLite in `.runtime/cassav5bt/data`;
5. crea un marker soltanto dopo il completamento;
6. genera segreti locali in `.runtime/cassav5bt/v5bt.env` con modo `0600`;
7. crea `cassa_v5bt_app@127.0.0.1`, distinto da `cassa_app`;
8. concede al nuovo utente privilegi soltanto sullo schema V5BT.

Non esegue `DROP DATABASE`, non importa mai in `cassa` o `cassav4` e blocca
uno schema parzialmente popolato o privo del marker corretto.

`start-v5bt.sh` accetta soltanto lo schema marcato con l'impronta del seed,
verifica tutte le 480 tabelle e richiede entrambe le copie SQLite prima di
avviare servizi.

## Snapshot Locale Storico

`cassa_local_v46_snapshot_20260719.sql.gz` conserva il precedente snapshot
del database desktop `cassa` (1.356 tabelle). Non rappresenta la produzione
Raspberry e non e usato dal provisioning V5BT.
