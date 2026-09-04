CREATE TABLE app_meta.retention_policies (
  target text PRIMARY KEY,
  retention_days integer,
  strategy text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  legally_required boolean NOT NULL DEFAULT false,
  decision_ref text NOT NULL,
  approved_at timestamptz,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retention_policies_target_format CHECK (
    target ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'
  ),
  CONSTRAINT retention_policies_strategy_valid CHECK (
    strategy IN ('drop_partition', 'delete_batched', 'none')
  ),
  CONSTRAINT retention_policies_strategy_coherent CHECK (
    (strategy = 'none' AND retention_days IS NULL AND NOT enabled)
    OR
    (strategy <> 'none' AND retention_days BETWEEN 1 AND 3650)
  ),
  CONSTRAINT retention_policies_approval_required CHECK (
    NOT enabled
    OR (
      approved_at IS NOT NULL
      AND decision_ref !~* 'TODO'
      AND strategy <> 'none'
    )
  ),
  CONSTRAINT retention_policies_legal_hold CHECK (
    NOT legally_required
    OR (strategy = 'none' AND retention_days IS NULL AND NOT enabled)
  ),
  CONSTRAINT retention_policies_protected_namespaces CHECK (
    target !~ '^(payments|fiscal)\.'
    OR legally_required
  )
);

INSERT INTO app_meta.retention_policies(
  target, retention_days, strategy, enabled, legally_required,
  decision_ref, approved_at, notes
) VALUES
  ('audit.events', 1095, 'drop_partition', false, false, 'RET-01:TODO', NULL,
   'Proposta: audit operativo; richiede partizionamento e strategia ID globale.'),
  ('sales.order_events', 730, 'drop_partition', false, false, 'RET-01:TODO', NULL,
   'Proposta futura: storia eventi ordine; tabella non ancora attiva.'),
  ('operations.order_fulfillment_events', 365, 'drop_partition', false, false, 'RET-01:TODO', NULL,
   'Proposta futura: metriche preparazione; tabella non ancora attiva.'),
  ('operations.device_status_events', 90, 'drop_partition', false, false, 'RET-01:TODO', NULL,
   'Proposta futura: telemetria device; tabella non ancora attiva.'),
  ('operations.print_attempts', 180, 'delete_batched', false, false, 'RET-01:TODO', NULL,
   'Proposta futura: diagnostica stampa; tabella non ancora attiva.'),
  ('messaging.event_outbox', 30, 'delete_batched', false, false, 'RET-01:TODO', NULL,
   'Proposta: soltanto righe processate oltre la finestra.'),
  ('operations.print_jobs', 90, 'delete_batched', false, false, 'RET-01:TODO', NULL,
   'Proposta futura: soltanto job completati; tabella non ancora attiva.'),
  ('messaging.idempotency_keys', 30, 'delete_batched', false, false, 'RET-01:TODO', NULL,
   'Proposta: grace period dopo expires_at; soltanto record terminali.'),
  ('payments.payments', NULL, 'none', false, true, 'LEGAL:NO_RETENTION', now(),
   'Nessuna retention: dato finanziario legalmente protetto.'),
  ('payments.provider_transactions', NULL, 'none', false, true, 'LEGAL:NO_RETENTION', now(),
   'Nessuna retention: tracciabilita provider.'),
  ('payments.cash_movements', NULL, 'none', false, true, 'LEGAL:NO_RETENTION', now(),
   'Nessuna retention: quadratura di cassa.'),
  ('fiscal.documents', NULL, 'none', false, true, 'LEGAL:NO_RETENTION', now(),
   'Nessuna retention: documento fiscale.'),
  ('fiscal.operations', NULL, 'none', false, true, 'LEGAL:NO_RETENTION', now(),
   'Nessuna retention: operazione fiscale.');

CREATE OR REPLACE FUNCTION app_meta.enforce_retention_policy_safety()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app_meta
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.legally_required THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'legally required retention policy cannot be deleted';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.legally_required THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'legally required retention policy is immutable';
    END IF;
    NEW.updated_at = now();
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

REVOKE ALL ON FUNCTION app_meta.enforce_retention_policy_safety() FROM PUBLIC;

CREATE TRIGGER retention_policies_enforce_safety
  BEFORE UPDATE OR DELETE ON app_meta.retention_policies
  FOR EACH ROW
  EXECUTE FUNCTION app_meta.enforce_retention_policy_safety();

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

CREATE OR REPLACE FUNCTION app_meta.purge_processed_outbox(
  p_batch integer DEFAULT 1000,
  p_dry_run boolean DEFAULT true
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_meta, messaging
AS $function$
DECLARE
  removed integer;
  policy_days integer;
  policy_enabled boolean;
  policy_strategy text;
BEGIN
  IF p_batch < 1 OR p_batch > 10000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'p_batch must be between 1 and 10000';
  END IF;

  SELECT enabled, retention_days, strategy
  INTO policy_enabled, policy_days, policy_strategy
  FROM app_meta.retention_policies
  WHERE target = 'messaging.event_outbox';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'event outbox retention policy is missing';
  END IF;
  IF NOT policy_enabled THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'event outbox retention policy is disabled';
  END IF;
  IF policy_strategy <> 'delete_batched' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'event outbox retention strategy is not executable';
  END IF;

  IF p_dry_run THEN
    SELECT count(*)::integer INTO removed
    FROM (
      SELECT id
      FROM messaging.event_outbox
      WHERE processed_at IS NOT NULL
        AND processed_at < now() - make_interval(days => policy_days)
      ORDER BY processed_at, id
      LIMIT p_batch
    ) candidate;
    RETURN removed;
  END IF;

  WITH candidates AS (
    SELECT id
    FROM messaging.event_outbox
    WHERE processed_at IS NOT NULL
      AND processed_at < now() - make_interval(days => policy_days)
    ORDER BY processed_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch
  )
  DELETE FROM messaging.event_outbox event
  USING candidates
  WHERE event.id = candidates.id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$function$;

CREATE OR REPLACE FUNCTION app_meta.purge_expired_idempotency(
  p_batch integer DEFAULT 1000,
  p_dry_run boolean DEFAULT true
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_meta, messaging
AS $function$
DECLARE
  removed integer;
  policy_days integer;
  policy_enabled boolean;
  policy_strategy text;
BEGIN
  IF p_batch < 1 OR p_batch > 10000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'p_batch must be between 1 and 10000';
  END IF;

  SELECT enabled, retention_days, strategy
  INTO policy_enabled, policy_days, policy_strategy
  FROM app_meta.retention_policies
  WHERE target = 'messaging.idempotency_keys';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'idempotency retention policy is missing';
  END IF;
  IF NOT policy_enabled THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'idempotency retention policy is disabled';
  END IF;
  IF policy_strategy <> 'delete_batched' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'idempotency retention strategy is not executable';
  END IF;

  IF p_dry_run THEN
    SELECT count(*)::integer INTO removed
    FROM (
      SELECT scope, key
      FROM messaging.idempotency_keys
      WHERE status IN ('completed', 'failed')
        AND expires_at < now() - make_interval(days => policy_days)
      ORDER BY expires_at, scope, key
      LIMIT p_batch
    ) candidate;
    RETURN removed;
  END IF;

  WITH candidates AS (
    SELECT scope, key
    FROM messaging.idempotency_keys
    WHERE status IN ('completed', 'failed')
      AND expires_at < now() - make_interval(days => policy_days)
    ORDER BY expires_at, scope, key
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch
  )
  DELETE FROM messaging.idempotency_keys key
  USING candidates
  WHERE key.scope = candidates.scope AND key.key = candidates.key;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$function$;

REVOKE ALL ON FUNCTION app_meta.purge_processed_outbox(integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_meta.purge_expired_idempotency(integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_meta.purge_processed_outbox(integer, boolean) FROM cassav6_runtime;
REVOKE ALL ON FUNCTION app_meta.purge_expired_idempotency(integer, boolean) FROM cassav6_runtime;

REVOKE ALL ON app_meta.retention_policies FROM PUBLIC;
REVOKE ALL ON app_meta.v_table_growth FROM PUBLIC;
REVOKE ALL ON app_meta.v_retention_candidates FROM PUBLIC;
REVOKE ALL ON app_meta.retention_policies FROM cassav6_runtime;

GRANT USAGE ON SCHEMA app_meta TO cassav6_runtime;
GRANT SELECT ON app_meta.retention_policies TO cassav6_runtime;
GRANT SELECT ON app_meta.v_table_growth TO cassav6_runtime;
GRANT SELECT ON app_meta.v_retention_candidates TO cassav6_runtime;

COMMENT ON TABLE app_meta.retention_policies
  IS 'MIG-026: control plane fail-closed; le proposte restano disabilitate fino alla decisione RET-01.';
COMMENT ON VIEW app_meta.v_table_growth
  IS 'MIG-026: osservabilita dimensioni e crescita relazioni PostgreSQL applicative.';
COMMENT ON VIEW app_meta.v_retention_candidates
  IS 'MIG-026: candidati potenziali; enabled indica se la policy e stata formalmente approvata.';
