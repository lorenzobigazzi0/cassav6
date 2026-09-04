\pset format unaligned
\pset fieldsep '|'
\pset tuples_only on

SELECT 'REGISTRY', version, checksum
FROM app_meta.schema_migrations
ORDER BY version;

SELECT
  'POLICIES',
  count(*),
  count(*) FILTER (WHERE enabled),
  count(*) FILTER (WHERE legally_required),
  count(*) FILTER (WHERE NOT legally_required AND decision_ref = 'RET-01:TODO')
FROM app_meta.retention_policies;

SELECT 'VIEW', viewname
FROM pg_views
WHERE schemaname = 'app_meta'
  AND viewname IN ('v_table_growth', 'v_retention_candidates')
ORDER BY viewname;

SELECT 'TRIGGER', tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'app_meta.retention_policies'::regclass
  AND NOT tgisinternal
ORDER BY tgname;

SELECT
  'PRIVILEGES',
  has_table_privilege('cassav6_app', 'app_meta.retention_policies', 'SELECT'),
  has_table_privilege('cassav6_app', 'app_meta.retention_policies', 'UPDATE'),
  has_table_privilege('cassav6_app', 'app_meta.v_table_growth', 'SELECT'),
  has_function_privilege('cassav6_app', 'app_meta.purge_processed_outbox(integer, boolean)', 'EXECUTE'),
  has_function_privilege('cassav6_app', 'app_meta.purge_expired_idempotency(integer, boolean)', 'EXECUTE');

SELECT
  'FOUNDATION_COUNTS',
  (SELECT count(*) FROM audit.events),
  (SELECT count(*) FROM messaging.idempotency_keys),
  (SELECT count(*) FROM messaging.command_inbox),
  (SELECT count(*) FROM messaging.event_outbox);
