# Fase P2 - Scala virtuale load-25

Data: 2026-07-03

## Esito

P2 completata con esito positivo.

Run finale:

`logs/loadtest-phaseP_load-25-p2-fixed/REPORT.md`

Profilo:

- 25 palmari API
- 10 postazioni API
- 2 GUI reali Playwright headless
- 50 operazioni per device
- fiscale su mock locale `http://127.0.0.1:9290`
- stampante TCP virtuale su `127.0.0.1:9109`
- stampa fisica disabilitata

## Sintesi run finale

- Durata: 399 s
- Operazioni business: 1850
- Richieste HTTP: 4552
- Errori/anomalie campionate: 0
- RT fiscale: 4 tentativi, 4 successi HTTP 2xx
- Metriche mock fiscale: `statusRequests=7`, `receiptRequests=7`, `reprintRequests=0`
- Coda finale `dbMutation/orderLane`: 0 / 0
- MySQL: 405.8 MB scritti, 94028 righe inserite, 3272 aggiornate

## Correzioni validate in P2

- Retry backend sui deadlock/lock wait MySQL transient della route `POST /api/integration/stations/state`, prima di esporre HTTP 500 al client.
- Retry `writeDb` app-state su deadlock transient confermato anche durante il run.
- Keeper presenza postazioni mantenuto attivo senza generare avvisi "nessuna postazione attiva".
- Il simulatore salta pagamenti/correzioni/storni se l'ordine viene spostato su altro tavolo durante il lock, evitando falsi negativi e rilasciando il lock corretto.

## Metriche operative rilevanti

- `station.heartbeat`: 1018/1018 ok, p95 1332 ms, max 5576 ms, 0 HTTP 500.
- `payment.free_split`: 113/113 ok, p95 14639 ms, max 26851 ms, 409 attesi sotto concorrenza inclusi nel profilo.
- `table.move`: 28/28 ok, p95 194720 ms, max 261886 ms, 409 attesi per tavoli bloccati.
- `reservation.create`: 65/65 ok, p95 17294 ms, p99 53139 ms.

## Note

Nel run finale un deadlock heartbeat e un deadlock app-state sono stati assorbiti dai retry e non sono arrivati al client come errore. Resta da monitorare in P3 la latenza della `room-lane` sui trasferimenti tavolo: il sistema chiude coerente e senza code finali, ma alcuni move validi restano in attesa troppo a lungo quando order/payment/reservation lane sono sotto carico.

Prossimo step: P3 - scala virtuale `load-50`.
