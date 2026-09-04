ALTER TABLE audit.events
  ADD CONSTRAINT audit_events_aggregate_pair_coherent
  CHECK ((aggregate_type IS NULL) = (aggregate_id IS NULL))
  NOT VALID;

ALTER TABLE audit.events
  VALIDATE CONSTRAINT audit_events_aggregate_pair_coherent;

ALTER TABLE audit.events
  ADD CONSTRAINT audit_events_payload_object
  CHECK (jsonb_typeof(payload) = 'object')
  NOT VALID;

ALTER TABLE audit.events
  VALIDATE CONSTRAINT audit_events_payload_object;

CREATE OR REPLACE FUNCTION audit.reject_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, audit
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'audit.events is append-only';
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION audit.reject_event_mutation() FROM PUBLIC;

CREATE TRIGGER audit_events_reject_update_delete
  BEFORE UPDATE OR DELETE ON audit.events
  FOR EACH ROW
  EXECUTE FUNCTION audit.reject_event_mutation();

CREATE TRIGGER audit_events_reject_truncate
  BEFORE TRUNCATE ON audit.events
  FOR EACH STATEMENT
  EXECUTE FUNCTION audit.reject_event_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON audit.events FROM cassav6_runtime;
GRANT SELECT, INSERT ON audit.events TO cassav6_runtime;

COMMENT ON FUNCTION audit.reject_event_mutation()
  IS 'MIG-024: rifiuta mutazioni distruttive degli audit; la retention richiede una futura policy esplicita.';

COMMENT ON CONSTRAINT audit_events_aggregate_pair_coherent
  ON audit.events
  IS 'MIG-024: tipo e id aggregato sono entrambi valorizzati oppure entrambi assenti.';

COMMENT ON CONSTRAINT audit_events_payload_object
  ON audit.events
  IS 'MIG-024: il payload audit canonico e sempre un oggetto JSON.';

