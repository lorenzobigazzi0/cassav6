# 03 — Roadmap totale (REV2)

La sequenza machine-readable e in `tasks/MIGRATION_TASKS.csv`.

## Come leggere le stime

Ogni fase riporta un ordine di grandezza in **giornate-uomo**, con queste
premesse esplicite:

- assume **uno sviluppatore che conosce gia il codice**; un nuovo arrivato va
  moltiplicato;
- assume che il sistema **resti in produzione** durante il lavoro, quindi include
  il costo di non poter rompere;
- **non** include il collaudo su hardware fisico con palmari e postazioni, che va
  pianificato a parte;
- e un ordine di grandezza per decidere il perimetro, **non un impegno**.

Le fasi con range molto ampio sono quelle dove il range e l'informazione: se
P2b costa 30 o 70 giornate dipende da quanto e intrecciato il monolite, e non e
sapibile prima dell'inventario P2b.1.

## Stato terminale di ogni fase

Ogni fase dichiara cosa succede **se il programma si ferma li**. Questa e la
colonna che mancava nella REV1 e che decide se una fase e sicura da iniziare.

Legenda: `MEGLIO` / `UGUALE` / `PEGGIO` rispetto allo stato attuale.

---

## P0 — Baseline e inventario

- congelare test funzionali e performance;
- creare golden dataset realistico (ordini, pagamenti, menu, prenotazioni, benefit);
- archiviare risultati load test **con hardware dichiarato**;
- rigenerare inventario `readDb`/`writeDb`;
- classificare ogni storage come authoritative / derived / volatile;
- misurare RSS Node, footprint MariaDB, spazio SQLite sul dispositivo reale.

**Gate**: nessuna migrazione inizia senza baseline ripetibile.

**Stato terminale: MEGLIO.** Anche fermandosi qui hai un golden dataset e una
baseline misurata, utili a qualunque lavoro futuro.

**Stima**: 8-15 gg.

---

## P1 — Infrastruttura PostgreSQL

- **gate hardware** di `13_HARDWARE_CAPACITY.md` superato prima di tutto il resto;
- PostgreSQL con utente app senza privilegi DDL, utente migration separato;
- backup e **restore testato sul dispositivo reale, con tempo misurato**;
- `fsync`, `full_page_writes`, `synchronous_commit` attivi e verificati.

Redis non fa parte di questa fase: vedi `ANNEX_A_FUORI_PERIMETRO.md` A.3.

**Gate**: il backend si connette a PostgreSQL; restore verificato entro la
finestra di manutenzione prevista.

**Stato terminale: UGUALE.** PostgreSQL installato e inutilizzato non peggiora
niente, occupa risorse.

**Stima**: 5-10 gg (esclusa eventuale sostituzione dello storage).

---

## P2 — Foundation persistence

- migration runner con `schema_migrations` e checksum;
- transaction helper con retry su deadlock/serialization failure;
- contratto repository;
- audit append-only;
- idempotency store;
- command inbox;
- transactional event outbox;
- worker claim con lease e `FOR UPDATE SKIP LOCKED`.

**Gate**: infrastruttura testata con **crash fra write e publish**.

**Stato terminale: UGUALE.** Infrastruttura pronta, nessun dominio migrato.

**Stima**: 12-20 gg.

---

## P2b — Decomposizione di `server.js` (PREREQUISITO)

Fase nuova. Dettaglio completo in `14_SERVER_DECOMPOSITION.md`.

- inventario dei confini di route -> dominio;
- estrazione delle route senza logica;
- reader scoped per dominio (implementazione ancora app-state);
- writer scoped per dominio (implementazione ancora app-state);
- isolamento del residuo condiviso.

**Regola**: zero cambi di comportamento, zero cambi di database.

**Gate**: nessun handler di dominio chiama `readDb`/`writeDb` direttamente;
`server.js` sotto le 10.000 righe; suite invariata e verde.

**Stato terminale: MEGLIO.** Anche senza migrare nulla, il codice diventa
manutenibile e testabile. E l'unica fase che vale da sola.

**Stima**: 30-70 gg. Il range e l'informazione.

---

## P3 — Identity e configurazione

Utenti, gruppi, ruoli, permessi, sessioni, settings, attivita, aree, workstation,
device, stampanti, dispositivi fiscali, terminali di pagamento, preferenze radio.

**Gate**: zero read/write app-state per identity e configurazione migrate.

**Stato terminale: MEGLIO se completo, PEGGIO se parziale.** Identity a meta
significa due posti dove cercare un utente. Questa fase va finita o annullata,
non sospesa.

**Stima**: 15-25 gg.

---

## P4 — Catalogo, menu e commerciale

Prima di iniziare: chiudere `SEQ-01` (vedi `16_PROGRAM_SEQUENCING.md`) e `COM-01`.

- prodotti, varianti, allergeni, tag, routing, SKU, barcode;
- cataloghi, categorie, gruppi, entries;
- listini, schedule, assignment, scope e precedenza;
- offers/combo, choice group, opzioni, supplementi, tax allocation;
- **unificazione di `menuItems` e `commercial_products` in un solo product master**;
- **preservazione lossless delle ingredient labels** in
  `catalog.product_ingredient_labels`, senza interpretazione.

Il dominio ricette strutturato esce dal perimetro: `ANNEX_A_FUORI_PERIMETRO.md` A.1.

**Gate**: pricing e catalog resolution equivalenti sui golden test, incluse
finestre overnight e giorni della settimana.

**Stato terminale: PEGGIO se parziale.** Due definizioni di prodotto e il
peggior stato possibile del sistema.

**Stima**: 25-40 gg.

---

## P4b — Coupon, voucher e benefit

Migrazione di `commercialBenefitCampaigns`, `Coupons`, `Applications`,
`Redemptions`, con residual policy, acquisizione via code/QR/NFC, usage limit e
stati `reserved/released/redeemed/expired`.

Il vincolo anti doppia redemption sta **nello schema** (`CHECK` su
`remaining_cents`, transazione con row lock), non solo nel codice.

Il motore promozioni automatiche esce dal perimetro: `ANNEX_A_FUORI_PERIMETRO.md` A.2.

**Gate**: doppia redemption impossibile sotto test di concorrenza; residui e
limiti equivalenti al legacy.

**Stato terminale: MEGLIO se completo.**

**Stima**: 10-15 gg.

---

## P5 — Sale, tavoli, sessioni di vendita e prenotazioni

PostgreSQL autorevole per rooms, tables, group, table state, work lock, sale
session, template, chiusure solari, prenotazioni, lock prenotazione, richieste di
spostamento sala/tavolo.

**Gate**: nessuna ownership autorevole in RAM; test multi-tavolo e di conflitto verdi.

**Stato terminale: MEGLIO se completo.**

**Stima**: 20-30 gg.

---

## P6 — Ordini

Creazione, sync, righe, varianti, correction, comp, storno, replacement, transfer,
room move, fulfillment, snapshot di pricing, revision concurrency.

**Le lane restano attive in questa fase.** La loro rimozione e P6b.

**Gate**: tutti i test ordine verdi con il path app-state disabilitato.

**Stato terminale: MEGLIO se completo, PEGGIO se parziale.**

**Stima**: 30-45 gg.

---

## P6b — Modello di concorrenza (FASE NUOVA, gate proprio)

Dettaglio completo in `15_CONCURRENCY_MODEL.md`.

- baseline della concorrenza attuale su hardware reale;
- mappa lane -> invariante -> aggregato -> sostituzione;
- sostituzione per aggregato, con test scritti prima;
- rimozione della backpressure globale per ultima.

**Gate**: re-baseline entro il 110% dei tempi precedenti, oppure regressione
accettata per iscritto; ogni lane rimossa ha la sua riga nella mappa.

**Stato terminale: PEGGIO se parziale.** Lane rimosse a meta senza row lock
completi significa perdita silenziosa di aggiornamenti. Questa fase e atomica.

**Stima**: 15-25 gg.

---

## P7 — Pagamenti, provider e contanti

Bill, allocazioni complete order/bill/line, payment container, parts,
transactions, provider transaction con reference unique, cash session, movements,
denominations, macchina a stati Glory.

I task critici di questa fase sono **progettati a mano, con test scritti prima**
(vedi `11_CODEX_EXECUTION_GUIDE.md`).

**Gate**: doppio retry non genera doppio incasso; fase DB del pagamento completa
prima dell'ACK; due pagamenti simultanei sullo stesso bill non producono
overpayment.

**Stato terminale: PEGGIO se parziale.**

**Stima**: 30-45 gg.

---

## P8 — Fiscale e stampa

Code persistenti in PostgreSQL, worker con lease e `SKIP LOCKED`, I/O hardware
sempre fuori dalle transazioni business.

Prima di iniziare: `FIS-01` chiusa.

**Gate**: restart e retry non producono doppia emissione; job persistito prima
dell'ACK.

**Stato terminale: PEGGIO se parziale.** Il fiscale non ammette stati intermedi.

**Stima**: 20-30 gg.

---

## P9 — Realtime e cache

In-process cache versionata, presence con TTL, fanout SSE, rate limit con
persistenza del conteggio tentativi. Dettaglio in `06_REALTIME_E_CACHE.md`.

**Gate**: suite funzionale verde **con cache disabilitata**; protezione brute
force attiva dopo riavvio del processo.

**Stato terminale: MEGLIO.**

**Stima**: 8-12 gg.

---

## P10 — Domini secondari

Smart customers, smart non fiscal, notifiche, waiter pause, deferred call, radio,
mobile battery, device state.

**Stato terminale: MEGLIO se completo.**

**Stima**: 15-25 gg.

---

## P11 — Report e analytics

Tutti i report finanziari leggono PostgreSQL o read model derivati da PostgreSQL.
Nessun report legge app-state.

**Stato terminale: MEGLIO se completo.**

**Stima**: 12-20 gg.

---

## P12 — Import storico e verifica shadow

Importer MariaDB/app-state e SQLite verso PostgreSQL, dry-run ripetibile,
riconciliazione **contro la sorgente legacy** (counts, sums, hash, invarianti) con
`scripts/reconcile_legacy_vs_pg.mjs`.

Shadow read comparison ammesso. Dual-write permanente no.

**Gate**: 0 mismatch critici, divergenze shadow a 0 nel burn-in.

**Stato terminale: UGUALE.**

**Stima**: 20-30 gg.

---

## P13 — Hardening e load test

Crash matrix completa, reboot, PostgreSQL restart, worker crash, outbox backlog,
retry fiscale e stampa, concorrenza, carico con 20 palmari e 5 postazioni,
temperatura e throttling misurati.

**Stato terminale: UGUALE.**

**Stima**: 15-25 gg.

---

## P14 — Cutover

Maintenance, snapshot, delta import, riconciliazione finale, switch a PostgreSQL
primary, smoke, monitoraggio. Rollback drill eseguito davvero prima del GO.

Prima di iniziare: `ROL-01` chiusa.

**Stima**: 5-10 gg piu la finestra.

---

## P15 — Decommission

Rimozione di `readDb`/`writeDb`, repository app-state, mirror di dominio, split DB,
SQLite, `node:sqlite`, `mysql2`, servizio MariaDB, feature flag di transizione.
Definition of Done in `10_LEGACY_DECOMMISSION.md`.

**Stato terminale: MEGLIO.** E l'unica fase che rimuove complessita.

**Stima**: 10-15 gg.

---

## Totale indicativo

**305-530 giornate-uomo** per il programma completo, escluso il collaudo fisico e
esclusi i progetti dell'Annex A.

I range per fase sopra sono indicativi; il dettaglio autorevole e per task in
`tasks/MIGRATION_TASKS.csv`, che riporta anche quali task sono delegabili a
esecuzione assistita e quali no (37 su 72 non lo sono).

Se questo numero non e compatibile con le risorse disponibili, la conversazione da
fare **non e** "come lo facciamo in meno tempo" ma "quale sottoinsieme prendiamo".

## Sottoinsieme minimo consigliato

Se il programma completo non e sostenibile, questo e l'ordine che massimizza il
valore per giornata spesa e che lascia il sistema in uno stato coerente a ogni
interruzione:

1. **P0** — baseline e golden dataset. Vale comunque.
2. **P2b** — decomposizione di `server.js`. Vale anche senza migrare niente.
3. **P1 + P2** — PostgreSQL e foundation.
4. **P7 end-to-end**, incluso P6 limitato a quello che i pagamenti richiedono.
   Un solo dominio portato fino alla rimozione delle scritture legacy, per
   validare l'intero pattern su hardware reale prima di impegnarsi sul resto.

Perche i pagamenti come primo dominio completo: e dove i vincoli di database
pagano di piu, dove i test esistenti sono piu densi, e dove un errore si vede
subito invece di sedimentare.

Dopo quel primo dominio si sa quanto costa davvero un dominio, e la stima delle
fasi restanti smette di essere un ordine di grandezza.

## Regola di esecuzione (invariata)

Niente riscrittura big-bang. Un bounded context alla volta. Ogni contesto che
passa a PostgreSQL smette **definitivamente** di scrivere su app-state. Il
dual-read/shadow e ammesso temporaneamente per verifica; il dual-write permanente no.
