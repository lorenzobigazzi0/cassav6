# Step 11A - Lane scheduler

Step 11A consolida le lane gia' presenti e aggiunge una lane opzionale per la
stampa operativa.

## Attivo in questo step

- `notificationLane` per publish/ack notifiche.
- `roomLane`/table paths gia' esistenti per layout e movimenti tavolo.
- `printLane` per `POST /api/integration/print`, dietro flag.

## Flag

```env
LANE_PRINT=1
PRINT_LANE_ENABLED=1
PRINT_SPOOL_SQL_PRIMARY=1
```

Rollback:

```env
LANE_PRINT=0
PRINT_LANE_ENABLED=0
```

## Invarianti

- MySQL resta sorgente di verita.
- La print lane non sostituisce `print_spool` SQL-primary.
- La print lane non abilita Redis lock, MQTT o pagamenti/fiscale asincroni.
- Se `PRINT_SPOOL_SQL_PRIMARY` non e' attivo, la print lane resta spenta e il
  comportamento torna al fallback legacy.

## Osservabilita'

Metriche nuove:

- `printLaneEnqueued`;
- `queues.printLane.waitMsByLabel`;
- `queues.printLane.runMsByLabel`;
- `dashboard.lanes.printDepth`;
- `dashboard.lanes.printRunning`.
