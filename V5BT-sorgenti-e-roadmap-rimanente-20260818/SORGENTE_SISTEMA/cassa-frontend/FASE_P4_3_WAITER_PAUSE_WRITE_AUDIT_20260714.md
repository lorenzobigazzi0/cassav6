# Fase P4.3 - Waiter pause write audit

Data: 2026-07-14  
Target: Raspberry `192.168.1.79`, quattro core applicativi  
I/O: stampa disabilitata; fiscale, cassa automatica e batteria su mock loopback

## Esito

Il dominio `waiter pause/start/stop` e' chiuso con esito GO per il sync puntuale
di sessione e audit. Il flag di rollback unico e':

```text
BACKEND_WAITER_PAUSE_SESSION_AUDIT_FASTPATH=1
```

Il flag resta OFF nel codice e viene attivato soltanto nel profilo di deploy
validato. L'ACK continua ad arrivare dopo tutte le scritture durevoli.

## Ownership e percorso

| Fase | Owner | Persistenza/azione |
| --- | --- | --- |
| `start` / `stop` | `api-owner` | waiter lane keyed per utente |
| `status` | `api-owner` | lettura coerente dello stato owner |
| stato pausa | MySQL app-state domains | `waiterPauses`, `waiterDeferredCalls`, `lastWriteAt` |
| heartbeat sessione | MySQL sessions split | sync della sola sessione cambiata |
| audit | MySQL + SQLite audit split | sync del solo evento appena aggiunto |
| fan-out | realtime gateway | publish solo dopo le write durevoli |

Il canary iniziale ha trovato una divergenza reale: `start/stop` erano owner-bound,
mentre `status` veniva bilanciato sugli API worker e poteva leggere una cache
stale. Tutte e tre le route sono ora instradate all'owner; il proxy e il process
guard hanno test dedicati.

## Correzioni di correttezza

- Duplicati concorrenti `start` e `stop` sono no-op prima di heartbeat, audit,
  write e publish.
- `stopWaiterPause` non usa piu' un riferimento sostituito dalla
  normalizzazione della collection.
- Sei richieste concorrenti, restart dopo start e restart dopo stop sono coperti
  da E2E.
- Il report unisce metriche owner e worker invece di scartare le label owner.
- Il lag SSE e' separato per `waiter_pause_started` e
  `waiter_pause_stopped`, con conteggio eventi corretto.
- Lo spool `failed_final` non rende rosso un test quando la stampa e'
  esplicitamente disabilitata.

## A/B Raspberry

Profilo comune: 20 o 50 palmari, 4 postazioni, 3 GUI mobile + 1 GUI postazione,
20/50 SSE, 2 API worker, 1 table-lock worker, 6 probe concorrenti, durata
nominale 60 secondi, 1 ordine + 10 azioni per palmare.

| Run | HTTP p50/p95/p99 | Probe | Start write avg/max | Stop write avg/max | SSE start/stop p95 | Esito waiter |
| --- | --- | ---: | --- | --- | --- | --- |
| control 20 | 40/548/1148 ms | 6/6 | 141,6/766 ms | 96,1/368 ms | 240/267 ms | verde |
| fastpath 20 | 36/400/723 ms | 6/6 | 70,6/430 ms | 71,1/352 ms | 255/243 ms | verde |
| control 50 | 70/1828/6764 ms | 6/6 | 417,9/2089 ms | 302,6/1128 ms | 279/276 ms | verde |
| fastpath 50 | 60/1633/5334 ms | 6/6 | 188,9/751 ms | 120,4/926 ms | 325/269 ms | verde |

Miglioramento del costo write:

- 20 device: start `-50,1%`, stop `-26,0%`.
- 50 device: start `-54,8%`, stop `-60,2%`.
- `state.sessionAuditFast` pesa 6-14 ms a 20 e 29-37 ms a 50.
- Nessun evento waiter duplicato, nessun conflitto MySQL, outbox a zero e drain
  completo nei due run GO.

Il run fastpath 50 contiene quattro failure esterne al dominio: due `401` su
`/api/reports/sales`, un `401` su `orders/sync` e una navigazione Playwright che
ha distrutto l'execution context. I 6/6 probe waiter, le 500/500 altre azioni,
le 50/50 comande e il drain sono completi. Queste failure restano aperte per il
runner/auth multi-sessione e non vengono conteggiate come verde globale P4.

## Esperimento bulk respinto

E' stato provato, senza promozione, il raggruppamento dei tre campi
`integration` in una singola transazione. A 20 device il costo non migliorava;
a 50 device ha prodotto tre errori MySQL `Record has changed`, 4/6 probe e write
peggiori. Il codice bulk non fa parte della soluzione finale.

## Test

- Writer unit: fastpath, flag OFF, fallback esplicito, errore durevole senza
  secondo writer.
- Idempotenza e crash recovery E2E.
- Routing proxy/process topology owner-bound.
- Telemetria, aggregazione owner+worker e report SSE.
- Suite mirata sul Raspberry: 185 test verdi prima del canary.
- Budget `server.js`: 38.798/39.500, margine 702 righe.

## Evidenze

I report completi sono in:

```text
reports/p4_waiter_pause_20260714/control20/
reports/p4_waiter_pause_20260714/control50/
reports/p4_waiter_pause_20260714/bulk20-no-go/
reports/p4_waiter_pause_20260714/bulk50-no-go/
reports/p4_waiter_pause_20260714/sessionaudit20/
reports/p4_waiter_pause_20260714/sessionaudit50/
```

Prossimo dominio P4.3: `payment.free_split`, applicando lo stesso audit di lane,
write durevole, idempotenza e A/B 20/50.
