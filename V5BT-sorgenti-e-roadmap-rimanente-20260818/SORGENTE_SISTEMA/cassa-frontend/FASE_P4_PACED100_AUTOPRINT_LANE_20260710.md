# Fase P4 - paced 100 device e isolamento auto-print

Data: 2026-07-10

## Obiettivo

Verificare la capacita' multiprocesso con 100 palmari e 10 postazioni, mantenendo
un intervallo di 10 secondi tra le azioni di ogni palmare. Il run usa solo stampa
TCP e fiscale virtuali su loopback; cassa automatica e periferiche reali restano
disabilitate.

## Profilo eseguito

- 100 palmari, 10 postazioni e 100 stream SSE
- 20 creazioni ordine e 10 azioni aggiuntive pianificate per palmare
- 3.000 business operation avviate in una finestra attiva di 301.875ms
- timeout client 9.000ms, nessun retry applicativo del generatore
- 1 owner, 2 API worker e 1 gateway realtime

## Risultati del run unico

Latenza HTTP globale:

| P50 | P95 | P98 | P99 | P99.9 | Max |
|---:|---:|---:|---:|---:|---:|
| 1.237ms | 8.341ms | 8.911ms | 9.266ms | 11.756ms | 11.782ms |

Ordini:

- 2.000 tentativi, 274 confermati entro il timeout client
- 1.254 ordini persistiti nel relazionale
- 100/100 device presenti nel relazionale, 12-13 ordini persistiti per device
- 0 duplicati e stato persistito coerente
- `order.create`: P50 6.797ms, P95 8.628ms, P99 8.838ms

Realtime e code durevoli:

- 100/100 SSE connessi, zero errori stream o parsing
- 1.380.510 consegne, SSE P50 190ms, P95 568ms, P99 988ms
- 13.815 eventi outbox, zero non pubblicati al termine
- 2.508 job di stampa virtuale confermati, zero pending e zero `failed_final`
- drain completato in 9.407ms

## Diagnosi scheduler

Il load balancer ha distribuito esattamente 1.000 create a ciascun API worker.
Entrambi hanno raggiunto sei task order concorrenti, ma hanno lasciato la corsia
ordini ferma con coda non vuota nella maggior parte dei campioni:

| Worker | Campioni fermi | Fermi con db queue | Max order queue | Max db queue |
|---|---:|---:|---:|---:|
| 40328 | 4.352 / 5.000 | 3.971 | 405 | 35 |
| 40329 | 4.336 / 5.000 | 3.955 | 395 | 37 |

La corsia `stationStateLane` non ha ricevuto task sui due API worker durante il
run. Il blocco misurato non era quindi causato dagli heartbeat, ma dai task
`async auto-print` inseriti nella coda globale con priorita' 4. La policy della
order lane considera quella priorita' bloccante e impediva il refill degli slot.

## Correzione

- L'auto-print asincrono passa ora da `printLane`, con chiave per ordine.
- Se la print lane non e' abilitata, resta il fallback identico su
  `withDbMutation`.
- Il profilo multiprocesso abilita esplicitamente `LANE_PRINT=1` e
  `PRINT_LANE_ENABLED=1`, senza dipendere dall'ambiente del processo padre.
- Il gate L4 della presence lane ora copre anche il controllo station/order;
  il comportamento di default resta invariato.
- `backend/server.js` resta a 38.799 / 39.500 righe.

## Verifica

- sintassi backend e harness: OK
- architettura, policy, preflight e lane: 142/142 verdi
- E2E ordini, SQL print spool e state machine stampa: 22/22 verdi
- backup target:
  `/opt/cassav4/backups/p4-order-presence-refill-20260710-185830`
- backup target:
  `/opt/cassav4/backups/p4-autoprint-lane-20260710-190531`

## Stato

La correzione e' distribuita ma il delta prestazionale non e' ancora misurato:
non e' stato ripetuto il carico da cinque minuti. Il prossimo gate e' un solo
confronto controllato con lo stesso profilo, quando esplicitamente autorizzato.
Le evidenze grezze del run restano in
`/opt/cassav4/current/logs/loadtest-p4_paced100_5min_20260710/`.
