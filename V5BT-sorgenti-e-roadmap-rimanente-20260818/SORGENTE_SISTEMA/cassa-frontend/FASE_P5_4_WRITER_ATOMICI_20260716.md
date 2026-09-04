# Fase P5.4 - Writer puntuali e consistenza tavolo/ordine

Data: 2026-07-16.

Stato: canary 20x5 da 2.500 azioni verde. Il full da 25.000 azioni e'
autorizzato come prossimo gate, ma non e' ancora stato eseguito.

## Obiettivo

Chiudere i due blocchi emersi nella P5.3:

- eliminare le persistenze full-state dal percorso ad alto volume;
- rendere CPU e RSS osservabili anche sul runner Windows.

Durante la verifica e' stata inoltre corretta una race tra spostamento tavolo,
lettura puntuale della comanda e operazioni successive sullo stesso ordine.

## Implementazione

Il fondo cassa usa ora un writer atomico MySQL che salva in un'unica
transazione soltanto i record modificati e i relativi eventi audit. Il writer:

- ordina i lock con la stessa regola canonica degli altri writer multi-riga;
- accetta una connessione esterna per evitare commit separati dell'audit;
- espone contatori per commit, fallback, errori e rollback;
- mantiene il percorso precedente dietro flag come rollback operativo.

Le mutation P5 ad alto volume gia' coperte sono state portate sui writer
puntuali. Nel canary finale le 585 chiamate `writeDb` osservate hanno prodotto:

- persistenze full-state: 0;
- no-op comparabili: 0;
- mutation assorbite dai domini esternalizzati: 585.

Il cambio tavolo ora persiste nello stesso commit SQLite relazionale:

- stato del tavolo sorgente e destinazione;
- ubicazione delle comande spostate;
- revisioni CAS di tavoli e ordini.

Se manca una comanda relazionale o una revisione non coincide, l'intera
transazione viene annullata. La lettura puntuale `orderId` riconcilia inoltre
la posizione operativa piu' recente anche quando il read-model relazionale ha
una revisione workflow superiore. Il sync pagamento conserva la posizione
piu' recente e `paidArticleUnits`.

Il generatore P5 rilegge infine la comanda dopo avere acquisito il lock per
annullamento. Un cambio tavolo concorrente viene registrato come skip
recuperabile; qualunque altro 4xx/5xx resta una failure. I report di errore
includono ora `orderId`, `tableId` e revisione attesa.

## Regressioni automatiche

Verifiche mirate tavolo/ordine/pagamento:

```text
node --test backend/tests/relational-payment-order-sync.test.mjs backend/tests/relational-table-move-write-primary.test.mjs backend/tests/relational-table-move-writer.test.mjs backend/tests/relational-orders.test.mjs backend/tests/scoped-orders-read.test.mjs backend/tests/payment-free-split-stateless-mirror.test.mjs
```

Esito: 56/56 verdi.

Suite architetturale estesa, inclusi MySQL split, runtime profile, metriche,
route policy, letture scoped e contratto P5: 285/285 verdi.

Contratto finale del runner, scheduler e diagnostica: 29/29 verdi.

## Run diagnostici

Canary `p5_20x5_canary_2500_20260716142527`:

- 2.500 azioni completate;
- quattro 400 `payment.free_split.article_refresh_retry`;
- causa: ubicazione comanda obsoleta nel read-model relazionale dopo un cambio
  tavolo;
- correzione: commit relazionale tavoli+ordini e riconciliazione puntuale.

Canary `p5_20x5_canary_2500_20260716150526`:

- i quattro errori `free_split` non si sono ripresentati;
- una sola failure `order.cancel` per cambio tavolo tra refresh e lock;
- causa confinata al generatore, mentre il backend ha rifiutato correttamente
  la richiesta stale;
- correzione: seconda lettura dopo il lock e skip esplicito tracciato.

Smoke finale `p5_20x5_smoke_200_20260716152314`:

- 200/200 azioni, zero failure;
- drain completo;
- zero retry e deadlock;
- gate contention verde.

## Canary certificante

Run: `p5_20x5_canary_2500_20260716152556`.

Correttezza:

- 2.500/2.500 azioni avviate e completate;
- zero failure HTTP, azioni o GUI;
- massimo 3 start/s e nessuna violazione della finestra mobile;
- 20/20 client realtime e radio connessi;
- outbox, spool stampa/fiscale e payment mirror drenati;
- zero duplicati e code finali a zero.

Writer atomico:

- 75 raccolte fondo cassa atomiche;
- 75 selezioni MySQL completate;
- zero fallback, errori e rollback;
- zero chiamate al vecchio `counter.collect.appStateWrite`.

Latenze:

- HTTP P50 16 ms, P95 143 ms, P99 328 ms, massimo 912 ms;
- azione P50 52 ms, P95 286 ms, P99 621 ms;
- drift azione primo/ultimo decile: P95 +7,66%, P99 -4,38%;
- drift steady: P95 +4,95%, P99 -21,10%;
- realtime delivery P95 254 ms, P99 269 ms, massimo 1.366 ms.

Contesa:

- 18.050 richieste diagnostiche;
- zero retry MySQL, deadlock, starvation e righe diagnostiche invalide;
- attesa massima mutation 369 ms, lane 65 ms;
- 39 attese lock InnoDB, 1.427 ms complessivi;
- gate contention verde.

Processi Windows:

- api owner: RSS max 335 MB, CPU max 65,27%, media 19,99%;
- api worker: RSS max 288/303 MB, CPU max 43,62/62,44%;
- table-lock worker: RSS max 114 MB, CPU media 1,23%;
- realtime gateway: RSS max 113 MB, CPU media 0,71%.

La telemetria CPU/RSS proviene ora dalle runtime metrics dei processi e non
dipende da `/proc`, quindi la lacuna Windows della P5.3 e' chiusa.

## Nota contatori MySQL

Durante il canary finale `Innodb_data_written` si e' azzerato senza restart del
server. Il report reset-aware ha marcato la chiave e ha lasciato il delta byte
non disponibile, invece di produrre un valore negativo o falso. Righe, attese
lock e dimensione finale delle tabelle restano valide; le tabelle load hanno
chiuso a 8,23 MB.

## Decisione del gate

- Correttezza funzionale canary: **GO**.
- Writer puntuali e assenza full-state persistito: **GO**.
- Deadlock/retry/starvation: **GO**.
- Drain e consistenza relazionale: **GO**.
- CPU/RSS Windows: **GO**.
- Full endurance 25.000: **DA ESEGUIRE**.
- P5 complessiva: **aperta fino al full**.

## Prossimo passo

Eseguire il profilo full 20x5 da 25.000 azioni senza modificare il contratto.
P5 puo' essere chiusa soltanto con exit code 0, drain completo, nessun
duplicato, nessuna crescita non giustificata e confronto stabile tra primo e
ultimo tratto del run.

## Artefatti

- `logs/loadtest-p5_20x5_canary_2500_20260716152556/report.json`;
- `logs/loadtest-p5_20x5_canary_2500_20260716152556/REPORT.md`;
- `logs/loadtest-p5_20x5_canary_2500_20260716152556/P5_ENDURANCE_REPORT.pdf`;
- `logs/loadtest-p5_20x5_canary_2500_20260716152556/p5-contention-report.json`;
- `logs/loadtest-p5_20x5_canary_2500_20260716152556/P5_CONTENTION_REPORT.md`;
- `logs/loadtest-p5_20x5_canary_2500_20260716152556/p5-latency-checkpoints.jsonl`.
