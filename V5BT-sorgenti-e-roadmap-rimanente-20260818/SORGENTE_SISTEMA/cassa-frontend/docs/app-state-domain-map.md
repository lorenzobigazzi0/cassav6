# App-state domain map — bozza operativa

Questa mappa serve alla migrazione da blob app-state a domini granulari. Ogni handler deve dichiarare i domini toccati; il dirty tracking shadow verifica se la dichiarazione è coerente.

## Domini caldi

| Dominio | Contenuto | Path tipici | Priorità |
|---|---|---|---|
| `integration` | ordini, notifiche operative, sequence, workflow | comande, sync ordini, notifiche cucina/bar | altissima |
| `posSettings` | tavoli, sale, settings POS, layout | tavoli, cambio sala, layout | altissima |
| `payments` | pagamenti e movimenti | ticket, conto tavolo, free split | altissima |
| `paymentContainers` | contenitori/settlement pagamento | pagamenti tavolo | altissima |
| `paymentParts` | parti split pagamento | split/free split | alta |
| `paymentTransactions` | transazioni provider | pagamenti elettronici | alta |
| `paymentProviderTransactions` | provider gateway esterni | pagamenti/cassa automatica | alta |
| `fiscalReceipts` | ricevute fiscali | fiscale/pagamenti | altissima |
| `fiscalEvents` | eventi fiscali | fiscale/pagamenti | altissima |
| `printSpoolJobs` | spool legacy stampa | stampa comande/ricevute | altissima finché legacy |
| `auditEvents` | audit operativo/contabile | quasi tutte le mutazioni | alta |
| `sessions` | sessioni e device | login/stato palmari | alta |
| `tableLocks` | lock lavoro tavoli | occupazione/heartbeat/release | alta |
| `posRoomChangeRequests` | cambio sala | room change | media/alta |
| `posTableRoomMoveRequests` | spostamento tavolo/sala | table move | media/alta |
| `posReservationStates` | prenotazioni/stati | reservations | media |
| `posReservationLocks` | lock prenotazioni | reservations | media |
| `posReservations` | prenotazioni | reservations | media |

## Regola di dichiarazione

Ogni write deve indicare almeno:

```js
await writeDb(db, {
  metricLabel: "orders.create.appStateWrite",
  splitDomains: ["integration", "posSettings", "printSpoolJobs", "auditEvents"],
});
```

Se un handler modifica un dominio non dichiarato, la fase shadow lo segnala in `missingDeclaredDomains`.

## Esempi di scope atteso

| Handler | Domini attesi |
|---|---|
| `orders.create` | `integration`, `posSettings`, `printSpoolJobs`, `auditEvents` |
| `orders.sync` | `integration`, `auditEvents`, `printSpoolJobs` |
| `tables.move` | `posSettings`, `integration`, `auditEvents`, `printSpoolJobs`, `tableLocks` |
| `payments.ticket` | `payments`, `paymentContainers`, `paymentParts`, `paymentTransactions`, `paymentProviderTransactions`, `fiscalReceipts`, `fiscalEvents`, `smartNonFiscal`, `auditEvents` |
| `notifications.ack` | `integration`, `sessions`, `auditEvents` |
| `room.change.request` | `posRoomChangeRequests` |
| `reservations.*` | `posReservationStates`, `posReservationLocks`, `posReservations`, `posSettings`, `integration`, `auditEvents`, `tableLocks` |

## Prossimo consolidamento

Dopo 1-2 baseline in `shadow`, aggiornare questa mappa con i risultati reali del report:

```bash
npm run diag:collect-runtime-metrics
npm run dirty:tracking:analyze
```
