# P5 Endurance 20x5 - Piano eseguibile

Data preparazione: 2026-07-16.

Stato: harness, test di contratto, smoke e canary P5.4 certificati. Il run
completo da 25.000 azioni non e' ancora stato eseguito e P5 non deve essere
marcata verde prima dei risultati completi.

Il canary P5.4 da 2.500 azioni ha eliminato le persistenze full-state, ridotto
il drift P95 al +7,66% e reso CPU/RSS osservabili su Windows. Il full e' ora
autorizzato come prossimo gate. Analisi:
`FASE_P5_4_WRITER_ATOMICI_20260716.md`.

## Verifica smoke certificata

Run: `p5_20x5_25k_20260716040510`.

- 20 palmari, 5 postazioni, 2 GUI mobile e 1 GUI postazione reali.
- 200/200 azioni completate, 0 fallimenti.
- Massimo osservato: 3 start/s sia a finestra fissa sia mobile; gap minimo
  333,56 ms, nessuna violazione.
- GUI: 0 risposte 4xx/5xx inattese e 0 errori console inattesi; logout/login,
  reload, blackout e pressioni prolungate completati.
- HTTP: P50 90 ms, P95 1.711 ms, P99 6.242 ms, P99.9 16.578 ms. Le latenze
  azione includono intenzionalmente logout e blackout e non sono una baseline
  endpoint.
- Realtime delivery: P50 165 ms, P95 290 ms, P99 382 ms, P99.9 788 ms.
- 20/20 client realtime e radio connessi; 0 errori radio.
- Cinque stampanti TCP mock raggiunte: 101 connessioni e 138.310 byte totali.
- Drain relazionale completato; outbox, spool stampa/fiscale e mirror pagamenti
  senza residui o errori finali.
- PDF A4, 3 pagine: `logs/loadtest-p5_20x5_25k_20260716040510/P5_ENDURANCE_REPORT.pdf`.
- SHA-256 PDF: `4921b632b9da164faa795e6d7a011321e8c0062fd18690ebf5898bff246a3e41`.

Durante la messa a punto lo smoke ha rilevato e fatto correggere la doppia
validazione delle sessioni `rooms`/`reservations` sulla cache locale dei worker
multiprocesso. Gli handler riusano ora il contesto autenticato condiviso dal
router; sono presenti test di regressione dedicati.

## Verifica contesa P5.2

Run: `p5_20x5_25k_20260716100527`.

- 200/200 azioni completate, 0 failure e drain relazionale completato.
- HTTP P50 22 ms, P95 174 ms, P99 313 ms, massimo 379 ms.
- 1.702 richieste diagnostiche correlate tra cinque processi.
- Attesa massima coda mutation generica 92 ms; lane specializzate massimo 1 ms.
- 0 retry MySQL, 0 righe deadlock, 0 deadlock InnoDB.
- 5 attese lock InnoDB, 161 ms complessivi.
- 0 promozioni anti-starvation, perche nessun task ha raggiunto la soglia di
  5 secondi.

Le latenze azione di circa 10 secondi corrispondono ai blackout/reconnect GUI
intenzionali e non a code DB. Analisi completa in
`FASE_P5_2_MUTATION_CONTENTION_20260716.md`.

## Verifica canary sostenuta P5.3

Run: `p5_20x5_canary_2500_20260716104351`.

- 2.500/2.500 azioni completate, 0 failure.
- 20/20 client realtime e radio connessi.
- HTTP P50 17 ms, P95 234 ms, P99 469 ms.
- Realtime delivery P95 253 ms, P99 268 ms.
- 0 retry MySQL, 0 deadlock, 0 promozioni starvation.
- Attesa massima mutation 394 ms, lane 250 ms.
- Outbox, spool e mirror drenati; duplicati pagamento/fiscale 0.
- Gate contention verde.
- Gate endurance rosso: HTTP P95 +48,82% tra primo e ultimo decile e 951/951
  richieste `writeDb` con full-state fallback.
- CPU/RSS processo non disponibili sul runner Windows corrente, perche il
  sampler usa `/proc`.

## Verifica canary P5.4

Run: `p5_20x5_canary_2500_20260716152556`.

- 2.500/2.500 azioni completate, zero failure.
- HTTP P50 16 ms, P95 143 ms, P99 328 ms.
- Drift azione P95 +7,66%; drift steady P95 +4,95%.
- 75/75 raccolte fondo cassa su writer atomico, zero fallback/errori/rollback.
- 585 mutation `writeDb` tutte assorbite dai domini esternalizzati e zero
  persistenze full-state.
- Zero retry, deadlock e starvation; attesa massima mutation 369 ms, lane 65
  ms; gate contention verde.
- Outbox, spool e mirror drenati; code finali a zero.
- CPU/RSS Windows valide tramite runtime metrics dei processi.
- Full 25.000 autorizzato ma non ancora eseguito.

## Contratto del run

- 20 palmari e 5 postazioni, tutti autenticati e mantenuti online.
- 1.000 azioni applicative per ciascun device: 25.000 totali.
- Massimo 3 avvii di azione applicativa al secondo sull'intero sistema.
- Durata minima teorica degli avvii: 8.349.667 ms, circa 2h 19m 10s.
- Gli start sono separati da almeno 334 ms: il margine di 1 ms elimina il
  rischio di quattro azioni in una finestra mobile causato dal jitter del timer.
- Una sola azione applicativa attiva per device.
- Se il sistema rallenta, il calendario viene traslato: non vengono generate
  raffiche di recupero.
- 20 client SSE e 20 client radio. Heartbeat, frame audio e traffico realtime
  tecnico non incrementano il contatore delle 25.000 azioni business.
- 50 comande ordinarie per palmare, oltre alle comande create dagli scenari
  fiscali, di concorrenza e recovery.

## GUI reali

- Due palmari sono pilotati in finestre Chrome reali, con viewport touch.
- Una postazione e pilotata in una finestra Chrome reale.
- Le interazioni GUI entrano nella quota di 1.000 azioni del relativo device.
- Ogni GUI esegue click reali, tap touch, ricerca, navigazione, apertura/chiusura
  modali, scroll, reload e pressioni reali di almeno 2.100 ms.
- La postazione esegue logout, resta disconnessa 10 minuti, tiene premuto AVVIA,
  effettua login dalla UI e verifica la nuova sessione.
- Le GUI simulano anche un blackout di rete di 60 secondi e la successiva
  riacquisizione della sessione.
- Screenshot automatici: avvio, prima pressione prolungata e fine run per ogni
  GUI, nella cartella `gui-evidence` del run.

## Periferiche isolate

- Cinque stampanti TCP mock su `127.0.0.1:19109-19113`.
- Un provider fiscale mock su `127.0.0.1:19290`.
- Una cassa automatica mock su `127.0.0.1:19190`.
- Servizio batteria a eventi mock su `127.0.0.1:19790`.
- `LOADTEST_ALLOW_NON_LOOPBACK_IO=0`: qualunque destinazione reale/non-loopback
  blocca il test prima dell'avvio.

## Copertura

Il profilo usa il catalogo funzionale gia presente nel runner P4/P5 e aggiunge
milestone deterministiche. Comprende:

- comande, varianti, aggiunte, note e commenti;
- modifica prezzo/quantita, reso con e senza sostituzione, storno e annullamento;
- preparazione, pronta, consegna e trasferimento tra postazioni;
- tavoli: occupa/libera, anagrafica, sposta, unisci/dividi e cambio sala;
- autorizzazioni negate e conflitti concorrenti;
- pagamenti totale, articolo, romano, importo libero, contanti, POS e cassa
  automatica con resto;
- doppio pagamento, fiscale/non fiscale, ristampa e rettifiche amministrative;
- banco, preferiti, ricerca dal primo carattere, impostazioni e storico;
- prenotazioni create/modificate/arrivate/no-show/cancellate e intolleranze;
- fondi cassa per ogni palmare, cambio, deposito/scarico e report finale;
- chiamate cameriere, comanda pronta, SSE, radio concorrente e canale occupato;
- pausa singola/totale delle postazioni, logout/relogin e blackout rete;
- stampa comanda/preconto su cinque code mock e fiscale sul solo provider mock.

## Metriche e gate

- Percentili P50, P95, P98, P99, P99.9 e massimo, globali e per operazione.
- Drift tra primo e ultimo 10% sia per azioni sia per richieste HTTP.
- Dieci finestre temporali con gli stessi percentili.
- CPU, RSS, tick/sec, MySQL, Redis, lane, outbox, spool stampa/fiscale, lock,
  realtime delivery e dimensione DB.
- Quota verde solo con 25.000 azioni avviate/completate, 1.000 per device e
  nessuna finestra oltre 3 avvii al secondo.
- Al termine: drain relazionale, code a zero, controllo duplicati/coerenza e
  scarico fondi cassa.

## Comandi

Preflight senza avviare servizi:

```bash
PATH=/home/sentrapa/.local/node-v24.15.0-linux-x64/bin:$PATH \
  npm --prefix cassa-frontend run test:p5:endurance:dry-run
```

Smoke ridotto con lo stesso cablaggio e 8 azioni per device:

```bash
PATH=/home/sentrapa/.local/node-v24.15.0-linux-x64/bin:$PATH \
  npm --prefix cassa-frontend run test:p5:endurance:smoke
```

Canary sostenuto con 100 azioni per device:

```bash
PATH=/home/sentrapa/.local/node-v24.15.0-linux-x64/bin:$PATH \
  npm --prefix cassa-frontend run test:p5:endurance:canary
```

Run completo con tre finestre Chrome visibili:

```bash
PATH=/home/sentrapa/.local/node-v24.15.0-linux-x64/bin:$PATH \
  npm --prefix cassa-frontend run test:p5:endurance
```

Su Linux il run completo rifiuta l'avvio senza `DISPLAY`/`WAYLAND_DISPLAY`. Su
Windows e macOS usa la sessione grafica nativa. In ogni piattaforma richiede
Chrome/Chromium e rifiuta configurazioni diverse da 20x5/25.000/3 al secondo.

## Artefatti

Ogni esecuzione crea `logs/loadtest-<run-id>/` con:

- `report.json`;
- `REPORT.md`;
- `P5_ENDURANCE_REPORT.pdf`;
- `events.jsonl`;
- `p5-latency-checkpoints.jsonl`, aggiornato durante il run e su arresto;
- `backend-baseline.jsonl` e una baseline separata per ogni worker;
- `p5-contention-report.json`;
- `P5_CONTENTION_REPORT.md`;
- log di backend, frontend e simulatori;
- database SQLite isolati del run;
- screenshot nella directory `gui-evidence/`.
