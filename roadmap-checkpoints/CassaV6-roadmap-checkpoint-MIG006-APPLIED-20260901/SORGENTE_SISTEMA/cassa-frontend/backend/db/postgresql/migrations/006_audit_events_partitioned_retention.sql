LOCK TABLE audit.events IN ACCESS EXCLUSIVE MODE;

DO $guard$
DECLARE
  existing_rows bigint;
BEGIN
  SELECT count(*) INTO existing_rows FROM audit.events;
  IF existing_rows <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'audit.events partitioning requires an empty table',
      DETAIL = format('Found %s rows; use an explicit audited data-move plan.', existing_rows);
  END IF;
END;
$guard$;

DROP VIEW app_meta.v_retention_candidates;
DROP VIEW app_meta.v_table_growth;
DROP TABLE audit.events;

CREATE TABLE audit.event_ids (
  id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL
);

CREATE TABLE audit.events (
  id text NOT NULL,
  domain text NOT NULL,
  aggregate_type text,
  aggregate_id text,
  action text NOT NULL,
  actor_user_id text,
  actor_username text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_events_pkey PRIMARY KEY (occurred_at, id),
  CONSTRAINT audit_events_aggregate_pair_coherent
    CHECK ((aggregate_type IS NULL) = (aggregate_id IS NULL)),
  CONSTRAINT audit_events_payload_object
    CHECK (jsonb_typeof(payload) = 'object')
) PARTITION BY RANGE (occurred_at);

CREATE INDEX audit_events_aggregate_time_idx
  ON audit.events(aggregate_type, aggregate_id, occurred_at DESC);
CREATE INDEX audit_events_id_lookup_idx
  ON audit.events(id, occurred_at DESC);
CREATE INDEX audit_events_occurred_at_idx
  ON audit.events(occurred_at DESC);

CREATE OR REPLACE FUNCTION audit.ensure_event_month_partitions(
  p_from date,
  p_through date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit
SET timezone = 'UTC'
AS $function$
DECLARE
  month_start date;
  last_month date;
  next_month date;
  partition_name text;
  created_count integer := 0;
BEGIN
  IF p_from IS NULL OR p_through IS NULL OR p_from > p_through THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid audit partition interval';
  END IF;
  IF p_through > (current_date + interval '24 months')::date THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'audit partitions can be provisioned at most 24 months ahead';
  END IF;

  month_start := date_trunc('month', p_from)::date;
  last_month := date_trunc('month', p_through)::date;
  WHILE month_start <= last_month LOOP
    next_month := (month_start + interval '1 month')::date;
    partition_name := 'events_' || to_char(month_start, 'YYYY_MM');
    IF to_regclass('audit.' || partition_name) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE audit.%I PARTITION OF audit.events FOR VALUES FROM (%L) TO (%L)',
        partition_name,
        month_start::text || ' 00:00:00+00',
        next_month::text || ' 00:00:00+00'
      );
      created_count := created_count + 1;
    END IF;
    month_start := next_month;
  END LOOP;
  RETURN created_count;
END;
$function$;

REVOKE ALL ON FUNCTION audit.ensure_event_month_partitions(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.ensure_event_month_partitions(date, date) FROM cassav6_runtime;

SELECT audit.ensure_event_month_partitions(
  (current_date - interval '1 month')::date,
  (current_date + interval '13 months')::date
);

CREATE TABLE audit.events_default
  PARTITION OF audit.events DEFAULT;

CREATE OR REPLACE FUNCTION audit.register_event_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit
AS $function$
BEGIN
  INSERT INTO audit.event_ids(id, occurred_at)
  VALUES (NEW.id, NEW.occurred_at);
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION audit.register_event_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.register_event_id() FROM cassav6_runtime;

CREATE TRIGGER audit_events_register_global_id
  BEFORE INSERT ON audit.events
  FOR EACH ROW
  EXECUTE FUNCTION audit.register_event_id();

CREATE TRIGGER audit_events_reject_update_delete
  BEFORE UPDATE OR DELETE ON audit.events
  FOR EACH ROW
  EXECUTE FUNCTION audit.reject_event_mutation();

CREATE TRIGGER audit_events_reject_truncate
  BEFORE TRUNCATE ON audit.events
  FOR EACH STATEMENT
  EXECUTE FUNCTION audit.reject_event_mutation();

CREATE TRIGGER audit_event_ids_reject_update_delete
  BEFORE UPDATE OR DELETE ON audit.event_ids
  FOR EACH ROW
  EXECUTE FUNCTION audit.reject_event_mutation();

CREATE TRIGGER audit_event_ids_reject_truncate
  BEFORE TRUNCATE ON audit.event_ids
  FOR EACH STATEMENT
  EXECUTE FUNCTION audit.reject_event_mutation();

REVOKE ALL ON audit.events FROM PUBLIC;
REVOKE ALL ON audit.event_ids FROM PUBLIC;
REVOKE ALL ON audit.events FROM cassav6_runtime;
REVOKE ALL ON audit.event_ids FROM cassav6_runtime;
GRANT SELECT, INSERT ON audit.events TO cassav6_runtime;
GRANT SELECT ON audit.event_ids TO cassav6_runtime;

CREATE OR REPLACE VIEW app_meta.v_table_growth AS
SELECT
  namespace.nspname AS schema_name,
  relation.relname AS table_name,
  CASE relation.relkind
    WHEN 'p' THEN 'partitioned_table'
    ELSE 'table'
  END AS relation_kind,
  pg_total_relation_size(relation.oid) AS total_bytes,
  COALESCE(stats.n_live_tup, relation.reltuples::bigint, 0) AS approx_rows,
  COALESCE(stats.n_dead_tup, 0) AS dead_rows,
  GREATEST(stats.last_analyze, stats.last_autoanalyze) AS last_analyze_at
FROM pg_class relation
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
LEFT JOIN pg_stat_user_tables stats ON stats.relid = relation.oid
WHERE relation.relkind IN ('r', 'p')
  AND namespace.nspname IN (
    'audit', 'sales', 'payments', 'fiscal', 'operations', 'messaging',
    'catalog', 'commerce', 'identity', 'configuration', 'reservations', 'crm'
  );

CREATE OR REPLACE VIEW app_meta.v_retention_candidates AS
SELECT
  policy.target,
  policy.retention_days,
  policy.strategy,
  policy.enabled,
  count(event.id)::bigint AS eligible_rows,
  min(event.occurred_at) AS oldest_eligible_at
FROM app_meta.retention_policies policy
LEFT JOIN audit.events event
  ON event.occurred_at < now() - make_interval(days => policy.retention_days)
WHERE policy.target = 'audit.events'
GROUP BY policy.target, policy.retention_days, policy.strategy, policy.enabled

UNION ALL

SELECT
  policy.target,
  policy.retention_days,
  policy.strategy,
  policy.enabled,
  count(event.id)::bigint AS eligible_rows,
  min(event.processed_at) AS oldest_eligible_at
FROM app_meta.retention_policies policy
LEFT JOIN messaging.event_outbox event
  ON event.processed_at IS NOT NULL
 AND event.processed_at < now() - make_interval(days => policy.retention_days)
WHERE policy.target = 'messaging.event_outbox'
GROUP BY policy.target, policy.retention_days, policy.strategy, policy.enabled

UNION ALL

SELECT
  policy.target,
  policy.retention_days,
  policy.strategy,
  policy.enabled,
  count(key.scope)::bigint AS eligible_rows,
  min(key.expires_at) AS oldest_eligible_at
FROM app_meta.retention_policies policy
LEFT JOIN messaging.idempotency_keys key
  ON key.status IN ('completed', 'failed')
 AND key.expires_at < now() - make_interval(days => policy.retention_days)
WHERE policy.target = 'messaging.idempotency_keys'
GROUP BY policy.target, policy.retention_days, policy.strategy, policy.enabled;

REVOKE ALL ON app_meta.v_table_growth FROM PUBLIC;
REVOKE ALL ON app_meta.v_retention_candidates FROM PUBLIC;
GRANT SELECT ON app_meta.v_table_growth TO cassav6_runtime;
GRANT SELECT ON app_meta.v_retention_candidates TO cassav6_runtime;

UPDATE app_meta.retention_policies
SET notes =
  'Tabella partizionata mensilmente con registro ID globale; policy ancora disabilitata fino a RET-01.'
WHERE target = 'audit.events';

COMMENT ON TABLE audit.events
  IS 'Audit append-only partizionato mensilmente; retention disabilitata fino alla decisione RET-01.';
COMMENT ON TABLE audit.event_ids
  IS 'Registro append-only globale degli ID audit; sopravvive al drop delle partizioni dati.';
COMMENT ON FUNCTION audit.ensure_event_month_partitions(date, date)
  IS 'Crea partizioni mensili audit con massimo 24 mesi di anticipo; esecuzione solo owner.';
COMMENT ON FUNCTION audit.register_event_id()
  IS 'Garantisce unicita globale dell ID audit anche dopo il drop di una partizione.';
