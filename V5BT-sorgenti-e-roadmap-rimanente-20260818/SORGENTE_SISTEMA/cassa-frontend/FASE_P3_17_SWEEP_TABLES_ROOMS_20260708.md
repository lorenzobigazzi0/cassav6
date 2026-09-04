# Fase P3.17 - Sweep Tavoli/Sale

Data: 2026-07-08
Target deploy: Raspberry `192.168.0.67`
Runtime: stampa, fiscale e cassa automatica reale disattivati

## Obiettivo

Validare i percorsi Tavoli/Sale sotto il profilo multi-processo:

- lock tavolo acquire/heartbeat/release;
- sync stato tavolo;
- spostamento tavolo;
- richiesta cambio sala;
- richiesta spostamento tavolo tra sale;
- dirty tracking app-state in modalita write senza fallback full-state.

## Bug Trovati

1. Il canary iniziale riusava tavoli di destinazione in parallelo e generava `409 TABLE_LOCKED` artificiali.
2. `table/sync` aggiornava app-state ma non riallineava `table_states` relazionale mentre `BACKEND_RELATIONAL_TABLE_MOVE_WRITE_PRIMARY=1` era attivo.
3. Con `ROOM_LANE_CONCURRENCY=2`, scritture concorrenti su `posSettings` potevano produrre conflitti di revisione o stato tavolo perso anche su tavoli distinti.

## Correzioni

- Aggiunto `scripts/tables-rooms-write-audit-canary.mjs`.
- Il canary ora:
  - esclude sempre l'attesa virtuale;
  - usa coppie tavoli disgiunte per fase;
  - divide il test in fasi sync, move e room-change;
  - ripulisce source e target dopo ogni move, anche in caso di errore.
- `handleIntegrationLayoutTableSync` ora:
  - incrementa la revisione tavolo;
  - scrive `table_states` relazionale quando `BACKEND_RELATIONAL_TABLE_MOVE_WRITE_PRIMARY=1` oppure `BACKEND_RELATIONAL_TABLE_SYNC_WRITE_PRIMARY=1`.
- Aggiunto test e2e:
  - `backend/tests/relational-table-move-write-primary.test.mjs`
  - caso nuovo: sync tavolo prima del move write-primary senza conflitto revisione.
- Config deploy:
  - `ROOM_LANE_CONCURRENCY=1` in `/etc/cassav4/cassav4.env`;
  - aggiornato `deploy/raspberry-final/cassav4.env.example`.

## Verifiche

Test mirato su Raspberry:

```text
/usr/local/bin/node --test backend/tests/relational-table-move-write-primary.test.mjs
pass: 2/2
```

Canary seriale:

```text
ROOM_AUDIT_RUN_ID=tables_rooms_write_audit_p3_17_serial_20260708
verdict: PASS
```

Canary concorrente finale:

```text
ROOM_AUDIT_RUN_ID=tables_rooms_write_audit_p3_17_r4_20260708
verdict: PASS
effectiveDevices: 8
durationMs: 20003.89
```

Metriche principali r4:

- `table.move`: 8/8 OK, p95 3759 ms, max 3759 ms.
- `table.sync.free`: 40/40 OK, p95 2565.44 ms.
- `table.sync.seated`: 8/8 OK, p95 1622.13 ms.
- `room.change.request`: 8/8 OK, p95 1236.19 ms.
- `table.room_move.request`: 8/8 OK, p95 1099.21 ms.
- `writeDbFullStateFallback`: 0.
- `writeDbDirtyExternalized`: 72/72.

## Decisione

P3.17 e' PASS per correttezza.

La `roomLane` resta volutamente seriale (`ROOM_LANE_CONCURRENCY=1`) perche' `posSettings` e' ancora un dominio condiviso ampio. Aumentare la concorrenza prima di esternalizzare/shardare davvero gli stati tavolo riapre conflitti di revisione e lost update.

Il p95 wait della lane arriva al limite del gate (`5000 ms`) sotto canary concorrente; questo e' accettabile per chiudere la fase di correttezza, ma va trattato come debito di performance.

## Prossimo Step Consigliato

Procedere con la roadmap verso l'esternalizzazione reale degli stati tavolo/sala:

1. separare `table_states`, `table_locks`, richieste cambio sala e richieste table-room-move dal dominio monolitico `posSettings`;
2. rendere i read Tavoli/Sale primari dal relazionale dove il flag e' gia' attivo;
3. introdurre una lane per chiave tavolo o sala, invece della lane globale `rooms`;
4. solo dopo, rivalutare `ROOM_LANE_CONCURRENCY > 1`.

