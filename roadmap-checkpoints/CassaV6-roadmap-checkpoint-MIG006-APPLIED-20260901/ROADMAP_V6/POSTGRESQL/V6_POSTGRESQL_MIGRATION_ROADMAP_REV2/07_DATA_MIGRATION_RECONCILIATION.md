# 07 — Data migration e reconciliation (REV2)

> Correzione principale rispetto alla REV1: la riconciliazione deve confrontare
> il legacy con PostgreSQL. Lo script della REV1 verificava solo invarianti già
> garantite da FK/CHECK/UNIQUE nella DDL e poteva restituire soltanto zero.

## Fonti legacy

1. MariaDB/app-state;
2. app-state domain/split records;
3. SQLite relational;
4. eventuali file JSON ammessi solo come import storico, non runtime.

## Regola di merge

Per ciascun dominio definire prima del codice:

- source autorevole attuale;
- chiave naturale/id;
- regola revision/timestamp;
- deduplication;
- mapping di stati;
- mapping di null/default;
- retention;
- record orfani e policy.

Non usare una regola generica “vince updated_at” per tutti i domini finanziari.

## Ordine importer

1. identity/configuration;
2. catalog/commerce;
3. rooms/tables/sale sessions;
4. reservations;
5. orders/lines/events;
6. bills;
7. payments/allocations/provider/cash;
8. fiscal/print;
9. CRM/notifications/device history;
10. audit/outbox solo se ha valore storico e non genera side effects.

## Dry run

Ogni import deve poter essere eseguito più volte su DB vuoto e produrre report, senza inviare stampa/fiscale/realtime.

Il dry run va eseguito **sull'hardware reale con il dataset reale**, non su
desktop con un campione: il tempo di import è un input del piano di cutover, e un
import che dura più della finestra di manutenzione rende il piano invalido.

Report minimo:

```text
Users                     legacy=N pg=N
Products                  legacy=N pg=N
Orders                    legacy=N pg=N
Order lines               legacy=N pg=N
Payments                  legacy=N pg=N
Payment gross legacy      X
Payment gross postgres    X
Difference                0
Orphans                    0
Duplicate ids              0
Invalid states             0
```

## Strumenti di riconciliazione: cosa fa cosa

| Strumento | Cosa verifica | Può fallire? |
|---|---|---|
| `scripts/reconcile_legacy_vs_pg.mjs` | conteggi, somme e hash **legacy vs PostgreSQL** | sì, ed è il punto |
| `scripts/reconciliation_checks.sql` | invarianti interne a PostgreSQL non coperte da vincoli di schema, più presenza dei vincoli attesi | sì |

**Regola**: il GO di cutover richiede `reconcile_legacy_vs_pg.mjs` con exit code 0.
I check marcati `INCOMPLETO` (mappatura di dominio non ancora definita) contano
come mismatch critici e bloccano. Un report che passa perché un check non è stato
scritto non è evidenza.

Per ogni entità monetaria il confronto è a **tolleranza zero**. Una differenza di
un centesimo si spiega, non si arrotonda: nella quasi totalità dei casi indica una
conversione float verso centesimi sbagliata, che sistematicamente colpirà anche
altri record.

## Conversione degli importi

Il formato degli importi legacy va verificato prima dell'import. Se sono float o
decimali stringa, la conversione a centesimi interi va fatta con una regola unica,
documentata, applicata in un solo punto dell'importer. Le conversioni sparse sono
il modo tipico in cui una migrazione perde denaro.

Il dry run deve produrre l'elenco dei record la cui conversione ha prodotto
arrotondamento, non solo il totale.

## Ingredienti/ricette

Migrare lossless i label testuali in `catalog.product_ingredient_labels`. Le
tabelle `inventory.*` **restano vuote**: il dominio ricette è fuori perimetro
(`ANNEX_A_FUORI_PERIMETRO.md` A.1). Nessuna euristica crea quantità.

Il check `product_ingredient_labels.count` in `reconcile_legacy_vs_pg.mjs` è
critico e a tolleranza zero: la somma delle lunghezze degli array `ingredients[]`
legacy deve corrispondere esattamente al numero di righe importate.

## Shadow verification

Dopo che un dominio è PG-ready, è ammesso confrontare la risposta PG con quella legacy in background. Non è ammesso mantenere indefinitamente due sistemi che accettano write indipendenti.

## Final delta

Al cutover:

- entrare in maintenance/read-only per le mutazioni;
- acquisire snapshot/checkpoint delle fonti;
- import delta;
- eseguire reconciliation;
- abilitare PG primary;
- smoke test;
- riaprire mutazioni.
