# 05 — Data model e transazioni (REV2)

> Correzioni rispetto alla REV1: `due_cents` allineato fra documento e DDL,
> strategia di claim dell'outbox resa univoca, aggiunte le sezioni retention e
> business date.

## ID

Per il primo cutover preservare gli ID stringa esistenti (`TEXT`). Non introdurre contemporaneamente conversione totale a UUID. Per nuove entità tecniche è ammesso UUID generato dall'app.

## Denaro

Nel core finanziario usare `BIGINT` centesimi:

- `subtotal_cents`;
- `discount_cents`;
- `tax_cents`;
- `total_cents`;
- `paid_cents`;
- `due_cents`.

`due_cents` è una colonna reale in `sales.bills`, non un valore calcolato al volo:
serve per il vincolo `CHECK` e per gli indici sui bill aperti. L'invariante
`total_cents = paid_cents + due_cents` è garantita nello schema.

## Revision concurrency

Aggregati mutabili (`orders`, `bills`, `table_states`, reservations, config draft) hanno `revision BIGINT`.

Pattern optimistic update:

```sql
UPDATE sales.orders
SET status=$1, revision=revision+1, updated_at=now()
WHERE id=$2 AND revision=$3;
```

0 righe -> `409 CONFLICT`.

## Row lock finanziario

Per pagamento/split:

```sql
BEGIN;
SELECT * FROM sales.bills WHERE id=$1 FOR UPDATE;
-- validate due/paid/status
-- insert payment + allocations
-- update bill/order
-- insert idempotency/audit/outbox
COMMIT;
```

Non bloccare globalmente tutti i pagamenti.

## Allocazioni

Un pagamento può riferirsi a più ordini/bill/righe. Non affidarsi a un singolo `order_id` o a JSON opaco. Usare:

- `payments.payment_order_allocations`;
- `payments.payment_bill_allocations`;
- `payments.payment_line_allocations`.

## External I/O

Mai tenere un row lock mentre si attende POS/Glory/stampante/fiscale. Usare state machine persistita:

`PENDING -> WAITING_PROVIDER -> SETTLED/FAILED/CANCELLED`.

Le transizioni monetarie definitive sono atomiche; i retry usano idempotency key/provider ref unique.

## Outbox

L'evento che deve innescare fiscale/stampa/realtime viene inserito nello stesso commit della mutazione business.

### Strategia di claim: una sola, non due

La REV1 definiva sia le colonne `lease_owner`/`lease_until` sia un esempio con
`FOR UPDATE SKIP LOCKED` che le ignorava. Sono due meccanismi diversi e vanno
scelti, non sommati.

**Scelta adottata: lease + `SKIP LOCKED`.** `SKIP LOCKED` evita che due worker
selezionino la stessa riga; il lease sopravvive al crash del worker e permette il
recupero senza tenere una transazione aperta durante l'I/O esterno (che il
principio 4 vieta).

Claim:

```sql
UPDATE messaging.event_outbox
SET lease_owner = $1,
    lease_until = now() + interval '60 seconds',
    attempt_count = attempt_count + 1
WHERE id IN (
  SELECT id
  FROM messaging.event_outbox
  WHERE processed_at IS NULL
    AND available_at <= now()
    AND (lease_until IS NULL OR lease_until < now())
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 50
)
RETURNING id, aggregate_type, aggregate_id, event_type, payload;
```

La transazione di claim si chiude **prima** dell'I/O esterno. Al termine, il
worker marca `processed_at` oppure rilascia il lease e imposta un nuovo
`available_at` con backoff.

Un job il cui `lease_until` è scaduto viene ripreso da un altro worker: per questo
tutti i consumatori devono essere idempotenti, e il fiscale in particolare deve
usare `fiscal.operations.idempotency_key` (unique per provider).

Stessa strategia, identica, per `operations.print_jobs`.

## Retention

Su un dispositivo piccolo le tabelle append-only crescono senza limite e
diventano il primo problema operativo dopo il cutover. Vanno trattate nello
schema, non con uno script che qualcuno ricorderà di lanciare:
`postgres/060_retention_partitioning.sql`.

Tabelle interessate: `audit.events`, `sales.order_events`,
`operations.order_fulfillment_events`, `operations.device_status_events`,
`messaging.event_outbox` (righe processate), `operations.print_jobs` (completati),
`operations.print_attempts`, `messaging.idempotency_keys` (scadute).

Regola: **niente retention sui documenti fiscali e sui pagamenti.** Quelli si
conservano per obbligo, non per utilità operativa. Le finestre di retention degli
altri domini vanno decise con `RET-01` (`12_OPEN_DECISIONS.md`).

## Business date e mezzanotte

`sales.solar_closures.business_date` esiste ma nulla definisce come si deriva. Per
un POS ristorativo italiano il confine non è la mezzanotte civile: un ordine delle
01:30 può appartenere alla giornata precedente.

Da definire prima di P5, una volta, in un solo punto:

- l'ora di stacco della giornata commerciale (es. 05:00 locali);
- il fuso di riferimento e il comportamento sui cambi di ora legale;
- se `business_date` è derivata dalla sessione di vendita aperta o dall'orologio;
- quale delle due prevale se una sessione resta aperta oltre lo stacco.

Tutti i report finanziari, la chiusura giornaliera e la riconciliazione fiscale
dipendono da questa definizione. Se resta implicita, due report daranno numeri
diversi per lo stesso giorno.

## Snapshot ordine

Ogni linea conserva almeno product id + nome snapshot + unit price + tax + variant/modifier snapshot + pricing source/version. Una modifica futura al catalogo non altera lo storico.
