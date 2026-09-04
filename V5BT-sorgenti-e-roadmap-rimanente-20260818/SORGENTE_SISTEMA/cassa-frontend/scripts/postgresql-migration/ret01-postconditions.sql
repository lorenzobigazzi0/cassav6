\pset format unaligned
\pset fieldsep '|'
\pset tuples_only on

-- RET-01: verifica dopo l'applicazione della migration 007.
-- L'approvazione non attiva nulla: le otto policy proposte restano disabilitate
-- e le cinque legalmente protette non devono essere state toccate.

SELECT 'REGISTRY', version, checksum
FROM app_meta.schema_migrations
ORDER BY version;

SELECT
  'APPROVAZIONE',
  count(*)                                                                        AS totali,
  count(*) FILTER (WHERE enabled)                                                 AS abilitate,
  count(*) FILTER (WHERE NOT legally_required AND approved_at IS NOT NULL
                     AND decision_ref = 'RET-01:APPROVED-2026-09-02')             AS approvate,
  count(*) FILTER (WHERE decision_ref ~* 'TODO')                                  AS ancora_todo,
  count(*) FILTER (WHERE legally_required AND strategy = 'none'
                     AND retention_days IS NULL
                     AND decision_ref = 'LEGAL:NO_RETENTION')                     AS protette
FROM app_meta.retention_policies;

SELECT 'FINESTRA', target, retention_days, strategy, enabled, decision_ref
FROM app_meta.retention_policies
WHERE NOT legally_required
ORDER BY target;

SELECT 'PROTETTA', target, strategy, retention_days, enabled
FROM app_meta.retention_policies
WHERE legally_required
ORDER BY target;

-- Il ruolo runtime continua a non poter modificare le policy.
SELECT
  'PRIVILEGI',
  has_table_privilege('cassav6_runtime', 'app_meta.retention_policies', 'SELECT') AS lettura,
  has_table_privilege('cassav6_runtime', 'app_meta.retention_policies', 'UPDATE') AS scrittura;

-- Audit: la 006 resta in piedi, partizionata e append-only.
SELECT 'AUDIT', relkind, (SELECT count(*) FROM pg_inherits WHERE inhparent = c.oid) AS partizioni
FROM pg_class c
WHERE c.oid = 'audit.events'::regclass;
