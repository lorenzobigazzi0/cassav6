# Fase P5.2 - Contesa mutation e deadlock MySQL

Data: 2026-07-16

## Obiettivo

Rendere attribuibili le attese della lane `mutation`, eliminare la starvation
della coda generica e ridurre il rischio di deadlock MySQL prima di ripetere il
run completo P5 da 25.000 azioni.

## Evidenza iniziale

Il run parziale precedente si era fermato a 20.135/25.000 azioni e mostrava:

- 4.942 attese lunghe, con campioni `mutation` fino a 488.330 ms;
- 531 righe di log contenenti deadlock;
- 159 retry MySQL e 14 terzi tentativi;
- drift di throughput pari a -70,36%.

I log grezzi completi di quel run non erano presenti nel pacchetto importato.
La correzione include quindi diagnostica durevole per rendere il prossimo run
analizzabile anche in caso di arresto anticipato.

## Cause corrette

1. La coda generica privilegiava sempre le lane specializzate e non promuoveva
   le operazioni normali rimaste in attesa. Sotto pressione continua una
   scrittura poteva quindi restare affamata senza un limite temporale.
2. `withDbMutation()` conservava il contesto richiesta, ma non lo riattivava
   con `AsyncLocalStorage.run()` al momento dell'esecuzione differita. Route,
   metriche e scope di fallback potevano essere attribuiti al contesto errato.
3. Alcuni upsert multi-riga dei domini app-state non applicavano un ordine di
   lock canonico. Worker diversi potevano acquisire le stesse righe in ordine
   inverso.

## Implementazione

- Scheduler generico con anti-starvation: dopo 5 secondi un task viene promosso
  mantenendo la precedenza delle operazioni realmente urgenti e l'ordine FIFO.
- Ripristino esplicito del contesto richiesta durante l'esecuzione della
  mutation differita.
- Ordinamento deterministico per dominio e `recordId` prima di upsert/delete
  MySQL multi-riga.
- Telemetria di retry MySQL associata a route, request id, stage, scope e codice.
- Baseline JSONL separata per owner, realtime, API worker e table-lock worker,
  con flush durante la chiusura controllata.
- Aggregatore `scripts/p5-contention-report.mjs`, che produce JSON e Markdown
  con percentili per route, retry, promozioni anti-starvation e delta InnoDB.
- Correzione del logout GUI del runner: la conferma viene rilocalizzata dopo
  ogni render, evitando il click su un nodo React gia sostituito.

## Validazione automatica

- Suite mirata repository/scheduler/retry/runtime/contratto: 73/73 test passati.
- `npm run test:p5:scheduler`: 16/16 test passati.
- Runtime metrics e route policy: 148/148 test passati.
- `npm run test:p5:endurance:dry-run`: passato.
- Build reale del frontend postazione eseguita dal runner: passata.

## Smoke P5 conclusivo

Run: `p5_20x5_25k_20260716100527`.

- 20 palmari + 5 postazioni, 200/200 azioni, 0 failure.
- Massimo 3 start/s, senza violazioni della finestra mobile.
- HTTP: P50 22 ms, P95 174 ms, P99 313 ms, massimo 379 ms.
- 20/20 client realtime e radio connessi.
- Drain relazionale completato; outbox non pubblicata: 0.
- 1.702 richieste diagnostiche, 0 righe JSONL non valide.
- Attesa massima coda generica: 92 ms su
  `POST /api/integration/table-groups/save`; le altre route generiche osservate
  non hanno superato 1 ms.
- Attesa massima delle lane specializzate osservata: 1 ms.
- Retry MySQL: 0; righe deadlock: 0; deadlock InnoDB: 0.
- Attese lock InnoDB: 5 per 161 ms complessivi.
- Promozioni anti-starvation: 0, coerente con l'assenza di attese oltre 5 s.

Le azioni GUI da circa 10 secondi sono i blackout/reconnect intenzionali dei
due palmari e della postazione pilotati. Non rappresentano attesa DB: i restanti
22 device hanno un massimo azione inferiore a 486 ms.

Artefatti:

- `logs/loadtest-p5_20x5_25k_20260716100527/report.json`;
- `logs/loadtest-p5_20x5_25k_20260716100527/P5_CONTENTION_REPORT.md`;
- `logs/loadtest-p5_20x5_25k_20260716100527/p5-contention-report.json`;
- `logs/loadtest-p5_20x5_25k_20260716100527/P5_ENDURANCE_REPORT.pdf`;
- cinque file `*-baseline.jsonl` separati per processo.

## Stato del gate

P5.2 e chiusa sullo smoke. P5 complessiva resta rossa finche il comportamento
non viene confermato su una finestra sostenuta e infine sul run completo da
25.000 azioni. Il prossimo passaggio consigliato e un canary intermedio con lo
stesso profilo e diagnostica attiva, prima di impegnare il full endurance.
