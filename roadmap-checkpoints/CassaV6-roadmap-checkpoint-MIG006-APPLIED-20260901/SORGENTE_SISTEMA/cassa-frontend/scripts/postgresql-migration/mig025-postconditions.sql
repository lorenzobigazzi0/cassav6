\pset format unaligned
\pset fieldsep '|'
\pset tuples_only on

SELECT 'REGISTRY', version, checksum
FROM app_meta.schema_migrations
ORDER BY version;

SELECT 'CONSTRAINT', conname, convalidated
FROM pg_constraint
WHERE conrelid = 'messaging.idempotency_keys'::regclass
  AND conname LIKE 'idempotency_keys_%'
ORDER BY conname;

SELECT 'TRIGGER', tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'messaging.idempotency_keys'::regclass
  AND NOT tgisinternal
ORDER BY tgname;

SELECT
  'PRIVILEGES',
  has_table_privilege('cassav6_app', 'messaging.idempotency_keys', 'SELECT'),
  has_table_privilege('cassav6_app', 'messaging.idempotency_keys', 'INSERT'),
  has_table_privilege('cassav6_app', 'messaging.idempotency_keys', 'UPDATE'),
  has_table_privilege('cassav6_app', 'messaging.idempotency_keys', 'DELETE'),
  has_table_privilege('cassav6_app', 'messaging.idempotency_keys', 'TRUNCATE');

SELECT 'COLUMN', column_name, is_nullable, data_type
FROM information_schema.columns
WHERE table_schema = 'messaging'
  AND table_name = 'idempotency_keys'
  AND column_name IN ('request_hash', 'expires_at', 'completed_at')
ORDER BY column_name;

SELECT
  'FOUNDATION_COUNTS',
  (SELECT count(*) FROM audit.events),
  (SELECT count(*) FROM messaging.idempotency_keys),
  (SELECT count(*) FROM messaging.command_inbox),
  (SELECT count(*) FROM messaging.event_outbox);
