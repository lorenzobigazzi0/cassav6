-- DRAFT TARGET PostgreSQL — REV2 2026-08-31
-- Retention e partizionamento delle tabelle append-only.
--
-- Motivazione: su un dispositivo con storage limitato le tabelle append-only sono
-- il primo problema operativo dopo il cutover. La REV1 non le trattava.
--
-- REGOLA NON NEGOZIABILE: nessuna retention su payments.*, fiscal.documents e
-- fiscal.operations. Quelli si conservano per obbligo, non per utilita operativa.
--
-- Le finestre sotto sono un punto di partenza da confermare con RET-01
-- (12_OPEN_DECISIONS.md). Non applicarle senza aver deciso.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Partizionamento per mese delle tabelle ad alto volume
-- ---------------------------------------------------------------------------
-- Nota: il partizionamento va introdotto ALLA CREAZIONE. Su tabelle gia popolate
-- richiede una migrazione dedicata. Se al momento di P2 non e chiaro il volume
-- reale, meglio creare gia partizionato e non usarlo, che convertire dopo.
--
-- Esempio per audit.events (adattare le altre allo stesso schema):
--
--   CREATE TABLE audit.events (...) PARTITION BY RANGE (occurred_at);
--   CREATE TABLE audit.events_2026_09 PARTITION OF audit.events
--     FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
--
-- Il drop di una partizione vecchia e istantaneo e non produce bloat, a differenza
-- di un DELETE massivo che su questo hardware e doloroso.

CREATE TABLE IF NOT EXISTS app_meta.retention_policies (
  target text PRIMARY KEY,
  retention_days integer NOT NULL CHECK(retention_days > 0),
  strategy text NOT NULL CHECK(strategy IN ('drop_partition','delete_batched','none')),
  legally_required boolean NOT NULL DEFAULT false,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Valori proposti. NON sono decisi: vedi RET-01.
INSERT INTO app_meta.retention_policies(target, retention_days, strategy, legally_required, notes) VALUES
  ('audit.events',                      1095, 'drop_partition', false, 'audit operativo; verificare requisiti interni prima di ridurre'),
  ('sales.order_events',                 730, 'drop_partition', false, 'storia ordine; il dato di vendita resta in orders/order_lines'),
  ('operations.order_fulfillment_events',365, 'drop_partition', false, 'metriche di preparazione'),
  ('operations.device_status_events',     90, 'drop_partition', false, 'telemetria device, alto volume basso valore storico'),
  ('operations.print_attempts',          180, 'delete_batched',  false, 'diagnostica stampa'),
  ('messaging.event_outbox',              30, 'delete_batched',  false, 'solo righe con processed_at NOT NULL'),
  ('operations.print_jobs',               90, 'delete_batched',  false, 'solo righe con completed_at NOT NULL'),
  ('messaging.idempotency_keys',          30, 'delete_batched',  false, 'solo righe con expires_at < now()'),
  ('payments.payments',                    0, 'none',            true,  'MAI: obbligo di conservazione'),
  ('payments.provider_transactions',       0, 'none',            true,  'MAI: tracciabilita provider'),
  ('payments.cash_movements',              0, 'none',            true,  'MAI: quadratura di cassa'),
  ('fiscal.documents',                     0, 'none',            true,  'MAI: obbligo fiscale'),
  ('fiscal.operations',                    0, 'none',            true,  'MAI: obbligo fiscale')
ON CONFLICT (target) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Pulizia batch per le tabelle non partizionate
-- ---------------------------------------------------------------------------
-- Batch piccoli: su questo hardware un DELETE massivo blocca e gonfia il WAL.
-- Da schedulare fuori dagli orari di servizio.

CREATE OR REPLACE FUNCTION app_meta.purge_processed_outbox(p_days integer, p_batch integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE removed integer;
BEGIN
  DELETE FROM messaging.event_outbox
  WHERE id IN (
    SELECT id FROM messaging.event_outbox
    WHERE processed_at IS NOT NULL
      AND processed_at < now() - make_interval(days => p_days)
    LIMIT p_batch
  );
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

CREATE OR REPLACE FUNCTION app_meta.purge_expired_idempotency(p_batch integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE removed integer;
BEGIN
  DELETE FROM messaging.idempotency_keys
  WHERE (scope, key) IN (
    SELECT scope, key FROM messaging.idempotency_keys
    WHERE expires_at IS NOT NULL AND expires_at < now()
    LIMIT p_batch
  );
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Monitoraggio della crescita
-- ---------------------------------------------------------------------------
-- Da campionare periodicamente e archiviare: la dimensione delle tabelle e un
-- indicatore anticipato dei problemi operativi su questo hardware.

CREATE OR REPLACE VIEW app_meta.v_table_growth AS
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
  pg_total_relation_size(c.oid) AS total_bytes,
  c.reltuples::bigint AS approx_rows
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p')
  AND n.nspname IN ('audit','sales','payments','fiscal','operations','messaging','catalog','commerce','identity','configuration','reservations','crm')
ORDER BY pg_total_relation_size(c.oid) DESC;

COMMIT;
