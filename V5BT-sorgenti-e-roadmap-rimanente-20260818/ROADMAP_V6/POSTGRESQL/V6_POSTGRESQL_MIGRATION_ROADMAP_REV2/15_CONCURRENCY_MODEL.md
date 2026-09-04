# 15 — Modello di concorrenza (fase P6b, gate proprio)

## Perche e una fase e non un task

Nella REV1 questo lavoro era `MIG-064`, un task dentro P6 fra altri sette.
E il cambiamento con il maggior potenziale di regressione dell'intero programma.

Lo stato attuale non e accidentale: le lane di dominio, la coda di mutazione e
la fairness (`backend/modules/queue/`: `mutation-lane.js`,
`domain-lane-fairness.js`, `db-mutation-fairness.js`, `lane-routing.js`,
`payment-lane-admission.js`, `singleflight.js`) sono il risultato del lavoro
FASE_B/FASE_F e sono il motivo per cui l'attuale profilo prestazionale regge.

Sostituirle **insieme** al cambio di motore di persistenza significa che, se dopo
il cutover una latenza peggiora, non e attribuibile: puo essere PostgreSQL, puo
essere il row locking, puo essere l'interazione fra i due.

## Collocazione

```text
P6   Ordini in PostgreSQL, lane ANCORA ATTIVE
P6b  Sostituzione lane -> row locking, con re-baseline
P7   Pagamenti
```

Le lane non possono essere rimosse prima di P6 (il row lock ha bisogno di righe),
e non devono essere rimosse dopo P7 (i pagamenti sono il dominio dove un errore di
concorrenza costa denaro). La finestra e esattamente P6b.

## Sequenza

### P6b.1 — Baseline della concorrenza attuale

Prima di toccare qualunque lane, misurare e archiviare, sull'hardware reale
(vedi `13_HARDWARE_CAPACITY.md`):

- throughput mutazioni per dominio;
- p50/p95/p99 per operazione;
- profondita massima della coda per lane sotto carico;
- comportamento con 20 palmari + 5 postazioni simultanei;
- tempo di attesa in lane vs tempo di esecuzione.

Se questi numeri non esistono, P6b non parte. Sono l'unico riferimento contro cui
si potra dire che il nuovo modello e accettabile.

### P6b.2 — Mappa esclusione -> lock

Per ogni lane attuale, dichiarare **cosa protegge davvero**:

```text
lane | invariante protetta | aggregato | sostituzione proposta
```

Le sostituzioni ammesse, in ordine di preferenza:

1. **Constraint DB** (UNIQUE, CHECK, FK). Se l'invariante e esprimibile come
   constraint, non serve nessun lock.
2. **Optimistic concurrency con `revision`**. Per aggregati mutabili dove il
   conflitto e raro e il retry e accettabile.
3. **Row lock `SELECT ... FOR UPDATE`** sull'aggregato. Per sequenze
   leggi-valida-scrivi dove il conflitto e plausibile (bill, cash session).
4. **Advisory lock PostgreSQL**. Solo per coordinamento che non ha una riga
   naturale, con motivazione scritta.

Una lane che non trova posto in questo elenco non e una lane di concorrenza: e
una scelta di scheduling o di backpressure, e va conservata come tale.

**Nota emersa dall'analisi V5BT**: sei lane di dominio risultavano mutuamente
esclusive in modo simmetrico, quindi fornivano priorita di scheduling e non
concorrenza cross-dominio reale. Quelle sono le prime da sciogliere, perche il
loro valore attuale e vicino a zero.

### P6b.3 — Sostituzione per aggregato, non per lane

Procedere un aggregato alla volta (ordine, tavolo, bill, cash session), non una
lane alla volta. Per ognuno:

1. test di concorrenza che **fallisce** con la sostituzione ingenua;
2. implementazione;
3. test verde;
4. misura contro la baseline P6b.1.

Il test scritto prima non e formalita: e l'unico modo per sapere che il row lock
protegge davvero l'invariante che la lane proteggeva.

### P6b.4 — Rimozione della backpressure globale

Solo dopo che tutti gli aggregati sono coperti. La coda globale di mutazione va
rimossa per ultima, perche finche esiste maschera gli errori di locking dei passi
precedenti.

**Gate di uscita P6b**:

- ogni lane rimossa ha una riga nella mappa P6b.2 con la sua sostituzione;
- test di concorrenza per aggregato verdi, inclusi quelli scritti per fallire;
- re-baseline entro il 110% dei tempi P6b.1 su hardware reale, oppure
  regressione accettata per iscritto con motivazione;
- nessuna esclusione globale residua non documentata.

## Invarianti che il nuovo modello deve continuare a garantire

- due pagamenti simultanei sullo stesso bill non producono overpayment;
- due modifiche simultanee allo stesso ordine producono un `409`, non una perdita
  silenziosa;
- l'acquisizione di un lock di lavoro sul tavolo e UX, non autorita: l'autorita
  resta constraint/row lock/revision (principio 7 del doc 02);
- l'allocazione del numero d'ordine resta monotona e senza buchi ammessi solo dove
  gia oggi lo sono;
- la fairness fra postazioni non degenera: nessuna postazione resta in attesa
  indefinita perche un'altra tiene un lock lungo.

## Rischio residuo

Il row locking su PostgreSQL sposta il conflitto dal livello applicativo al
livello database. Su hardware piccolo questo puo produrre attese piu lunghe di
quelle attuali sotto contesa alta, perche la lane oggi fa da coda ordinata mentre
il lock fa da coda non ordinata. Se la baseline P6b.1 mostra contesa reale
significativa, valutare di **conservare** una forma di admission control leggera
davanti agli aggregati piu contesi, invece di rimuoverla per principio.
