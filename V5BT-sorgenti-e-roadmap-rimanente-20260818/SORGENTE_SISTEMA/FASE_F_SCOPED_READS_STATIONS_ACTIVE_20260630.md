# Fase F - Scoped Reads Stazioni Active

Data: 2026-06-30

## Obiettivo

Completare il primo blocco della Fase F sulle letture stazioni, migrando anche `GET /api/integration/stations/active` al percorso scoped.

## Implementato

- `GET /api/integration/stations/active` usa ora lo stesso snapshot scoped gia' introdotto per `stations/state`.
- Con `SCOPED_READS=1` e MySQL domain split attivo, l'endpoint legge solo:
  - `integration.stationStates`
  - `posSettings`
- Se lo snapshot scoped non trova postazioni attive, torna al path completo per preservare il side-effect operativo:
  - `maybeQueueNoActiveStationsNotification`
  - publish `station_availability_alert`
- Le richieste con postazioni attive evitano quindi il `readDb()` completo dello stato applicativo.

## Verifiche

Da rieseguire dopo restart:

- syntax check `server.js`
- route architecture gate
- live `GET /api/integration/stations/state`
- live `GET /api/integration/stations/active`

## Prossimo step consigliato

Avviare lo scoped read di `GET /api/integration/orders` solo per il sotto-caso realmente read-only:

- senza `station`
- senza `currentSessionOnly`
- senza `includeDone`

Le richieste da postazione con `station` devono restare sul path completo finche' non viene separata la riconciliazione code/assegnazioni.
