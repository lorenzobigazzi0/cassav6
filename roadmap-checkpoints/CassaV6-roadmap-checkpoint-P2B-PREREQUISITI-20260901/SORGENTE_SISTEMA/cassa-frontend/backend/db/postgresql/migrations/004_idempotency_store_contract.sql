ALTER TABLE messaging.idempotency_keys
  ADD COLUMN completed_at timestamptz;

ALTER TABLE messaging.idempotency_keys
  ADD CONSTRAINT idempotency_keys_scope_format
  CHECK (
    char_length(scope) BETWEEN 1 AND 128
    AND scope ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  )
  NOT VALID;

ALTER TABLE messaging.idempotency_keys
  VALIDATE CONSTRAINT idempotency_keys_scope_format;

ALTER TABLE messaging.idempotency_keys
  ADD CONSTRAINT idempotency_keys_key_format
  CHECK (
    char_length(key) BETWEEN 1 AND 191
    AND key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  )
  NOT VALID;

ALTER TABLE messaging.idempotency_keys
  VALIDATE CONSTRAINT idempotency_keys_key_format;

ALTER TABLE messaging.idempotency_keys
  ADD CONSTRAINT idempotency_keys_request_hash_format
  CHECK (
    request_hash IS NOT NULL
    AND request_hash ~ '^[0-9a-f]{64}$'
  )
  NOT VALID;

ALTER TABLE messaging.idempotency_keys
  VALIDATE CONSTRAINT idempotency_keys_request_hash_format;

ALTER TABLE messaging.idempotency_keys
  ALTER COLUMN request_hash SET NOT NULL;

ALTER TABLE messaging.idempotency_keys
  ADD CONSTRAINT idempotency_keys_status_valid
  CHECK (status IN ('processing', 'completed', 'failed'))
  NOT VALID;

ALTER TABLE messaging.idempotency_keys
  VALIDATE CONSTRAINT idempotency_keys_status_valid;

ALTER TABLE messaging.idempotency_keys
  ADD CONSTRAINT idempotency_keys_expiry_valid
  CHECK (expires_at IS NOT NULL AND expires_at > created_at)
  NOT VALID;

ALTER TABLE messaging.idempotency_keys
  VALIDATE CONSTRAINT idempotency_keys_expiry_valid;

ALTER TABLE messaging.idempotency_keys
  ALTER COLUMN expires_at SET NOT NULL;

ALTER TABLE messaging.idempotency_keys
  ADD CONSTRAINT idempotency_keys_state_coherent
  CHECK (
    (
      status = 'processing'
      AND response_code IS NULL
      AND response_json IS NULL
      AND completed_at IS NULL
    )
    OR
    (
      status IN ('completed', 'failed')
      AND response_code BETWEEN 100 AND 599
      AND completed_at IS NOT NULL
    )
  )
  NOT VALID;

ALTER TABLE messaging.idempotency_keys
  VALIDATE CONSTRAINT idempotency_keys_state_coherent;

CREATE OR REPLACE FUNCTION messaging.enforce_idempotency_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, messaging
AS $function$
BEGIN
  IF OLD.status <> 'processing' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'messaging.idempotency_keys terminal record is immutable';
  END IF;

  IF NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.key IS DISTINCT FROM OLD.key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'messaging.idempotency_keys identity is immutable';
  END IF;

  IF NEW.status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'messaging.idempotency_keys transition must be terminal';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION messaging.require_terminal_idempotency_at_commit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, messaging
AS $function$
DECLARE
  current_status text;
BEGIN
  SELECT status
  INTO current_status
  FROM messaging.idempotency_keys
  WHERE scope = NEW.scope AND key = NEW.key;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF current_status = 'processing' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'messaging.idempotency_keys processing state cannot be committed';
  END IF;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION messaging.enforce_idempotency_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION messaging.require_terminal_idempotency_at_commit() FROM PUBLIC;

CREATE TRIGGER idempotency_keys_enforce_transition
  BEFORE UPDATE ON messaging.idempotency_keys
  FOR EACH ROW
  EXECUTE FUNCTION messaging.enforce_idempotency_transition();

CREATE CONSTRAINT TRIGGER idempotency_keys_require_terminal
  AFTER INSERT OR UPDATE ON messaging.idempotency_keys
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION messaging.require_terminal_idempotency_at_commit();

REVOKE DELETE, TRUNCATE ON messaging.idempotency_keys FROM cassav6_runtime;
GRANT SELECT, INSERT, UPDATE ON messaging.idempotency_keys TO cassav6_runtime;

COMMENT ON FUNCTION messaging.enforce_idempotency_transition()
  IS 'MIG-025: consente soltanto processing -> completed/failed e rende immutabili i record terminali.';

COMMENT ON FUNCTION messaging.require_terminal_idempotency_at_commit()
  IS 'MIG-025: impedisce claim processing orfani; claim, business write e risposta devono condividere il commit.';

COMMENT ON COLUMN messaging.idempotency_keys.completed_at
  IS 'Clock PostgreSQL della transizione terminale MIG-025.';
