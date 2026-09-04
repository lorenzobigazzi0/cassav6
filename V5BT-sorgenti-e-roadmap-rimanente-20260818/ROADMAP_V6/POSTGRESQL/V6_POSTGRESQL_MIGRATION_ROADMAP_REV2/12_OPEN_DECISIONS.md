# 12 — Decisioni da chiudere (REV2)

Ogni decisione dichiara **prima di quale fase** va chiusa. Non bloccano l'avvio
di P0-P2b.

## Decisioni nuove nella REV2

### HW-01 — Storage e coesistenza dei motori (prima di P1) — BLOCCANTE

- Il Raspberry ha un SSD/NVMe su USB3 disponibile per il cluster PostgreSQL, o va
  acquistato?
- MariaDB resta accesa durante tutta la transizione o viene fermata dopo l'import?
- Il budget di memoria regge entrambi i motori contemporaneamente?
- Qual è la finestra di manutenzione massima accettabile, e il restore misurato ci
  sta dentro?

Senza questa decisione i target di `08` non sono raggiungibili e `fsync=on` su SD
rende il piano non eseguibile. Vedi `13_HARDWARE_CAPACITY.md`.

### SEQ-01 — Sequenziamento con Commerciale V2 (prima di P4) — BLOCCANTE

Opzione A (Commerciale V2 prima, su storage attuale), B (congelare a `off` e
migrare), o C (parallelo, sconsigliata). Vedi `16_PROGRAM_SEQUENCING.md`.

Da questa decisione dipendono `MIG-040`..`MIG-044` e la definizione stessa di
"prodotto canonico" nella riconciliazione.

### CONC-01 — Ambizione del cambio di concorrenza (prima di P6b)

- Si rimuovono tutte le lane o si conserva un admission control leggero sugli
  aggregati più contesi?
- Qual è la regressione prestazionale accettabile, per iscritto, prima di iniziare?

Decidere dopo la baseline P6b.1 significa decidere guardando il risultato, che è
il modo in cui una regressione viene accettata perché è già successa. Vedi
`15_CONCURRENCY_MODEL.md`.

### RET-01 — Finestre di retention (prima di P11) — DECISA il 2026-09-02

Valori proposti **confermati senza modifiche**. Riferimento decisione:
`RET-01:APPROVED-2026-09-02`, registrato in
`backend/db/postgresql/migrations/007_ret01_retention_approval.sql`.

| target | finestra | strategia |
|---|---:|---|
| `audit.events` | 1095 gg | drop partizione |
| `sales.order_events` | 730 gg | drop partizione |
| `operations.order_fulfillment_events` | 365 gg | drop partizione |
| `operations.print_attempts` | 180 gg | delete a lotti |
| `operations.print_jobs` | 90 gg, solo completati | delete a lotti |
| `operations.device_status_events` | 90 gg | drop partizione |
| `messaging.event_outbox` | 30 gg, solo processate | delete a lotti |
| `messaging.idempotency_keys` | 30 gg oltre `expires_at` | delete a lotti |
| `payments.*`, `fiscal.*` | **mai** | `none`, legalmente protette |

Vincolo non negoziabile invariato: nessuna retention su pagamenti, movimenti di
cassa e documenti fiscali.

Seconda parte della decisione: **le tabelle ad alto volume nascono già
partizionate** per mese sulla colonna temporale, anche quando la retention resta
disabilitata. Vale per tutte le append-only introdotte in P4-P10.

**Approvazione non è attivazione.** Le otto policy restano `enabled = false`:
lo schema tiene i due passi separati e ciascuna si abilita con una UPDATE
esplicita, quando la tabella esiste e c'è uno scheduler che la invoca fuori
dagli orari di servizio.

### BIZ-01 — Business date e stacco giornaliero (prima di P5)

Ora di stacco della giornata commerciale, fuso di riferimento, comportamento sui
cambi di ora legale, e cosa prevale se una sessione di vendita resta aperta oltre
lo stacco. Vedi `05_DATA_MODEL_AND_TRANSACTIONS.md`.

Tutti i report finanziari e la chiusura giornaliera dipendono da questa
definizione. Se resta implicita, due report daranno numeri diversi per lo stesso
giorno.

### FMT-01 — Formato degli importi legacy (prima di P12)

Verificare come sono conservati gli importi nel legacy e definire la regola unica
di conversione a centesimi interi, applicata in un solo punto dell'importer.
Vedi `07_DATA_MIGRATION_RECONCILIATION.md`.

## Decisioni della REV1 ancora aperte

### COM-01 — Versioning commerciale (prima di P4)

Versionare anche il product master o solo catalog/listino/offers? Non mantenere
`menuItems` e `commercial_products` come due verità. Intreccio con `SEQ-01`.

### CASH-01 — Glory e contanti (prima di P7)

Quando nasce un payment intent, quando il contante è considerato irrevocabilmente
accettato, come si riconcilia un timeout ambiguo del device.

### FIS-01 — Fiscale (prima di P8)

Idempotency key provider/fiscale e policy di retry/void per evitare doppia
emissione.

### ROL-01 — Rollback dopo cutover (prima di P14)

Se la finestra di rollback consente write reali su PostgreSQL e, in tal caso, come
produrre un reverse delta verso il legacy. La scelta più sicura resta una finestra
breve con legacy congelato e rollback prima di write non reversibili.

## Decisioni spostate ai progetti separati

Non bloccano più questa roadmap. Vanno chiuse prima di avviare i rispettivi
progetti, non prima di una fase di migrazione.

### REC-01 — Semantica ricette → `ANNEX_A_FUORI_PERIMETRO.md` A.1

Ricetta informativa o anche costo e scarico magazzino; sotto-ricette e
semilavorati; quantità per porzione o per batch; unit conversion; resa e scarto.

### PRO-01 — Promozioni automatiche → `ANNEX_A_FUORI_PERIMETRO.md` A.2

Stacking (cumulabili o best-discount); priorità ed exclusivity group; ordine di
applicazione rispetto a coupon e override manuali; condizioni; usage limit e
customer identity.

Requisito per la chiusura: **esempi numerici**, non principi. "Le promozioni non
sono cumulabili" non è una specifica finché non c'è uno scontrino di esempio con
due promozioni valide e il totale atteso.

### RED-01 — Reintroduzione di Redis → `ANNEX_A_FUORI_PERIMETRO.md` A.3

Da riaprire quando si verifica uno dei trigger: `BACKEND_API_WORKER_ENABLED=1` in
produzione, `BACKEND_REALTIME_GATEWAY_ENABLED=1` in produzione, o più di
un'istanza Node su host diversi.
