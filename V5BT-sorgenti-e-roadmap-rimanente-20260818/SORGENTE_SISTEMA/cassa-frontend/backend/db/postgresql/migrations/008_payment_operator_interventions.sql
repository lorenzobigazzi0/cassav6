CREATE SCHEMA IF NOT EXISTS payments;

CREATE TABLE payments.payment_operator_interventions (
  id text PRIMARY KEY,
  payment_id text NOT NULL,
  owner_user_id text NOT NULL,
  owner_username text NOT NULL,
  admin_user_id text NOT NULL,
  admin_username text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  expected_revision bigint,
  result text NOT NULL,
  audit_event_id text NOT NULL UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  workstation_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  receipt_payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(receipt_payload) = 'object')
);

CREATE INDEX payment_operator_interventions_payment_time_idx
  ON payments.payment_operator_interventions(payment_id, occurred_at DESC);
CREATE INDEX payment_operator_interventions_owner_time_idx
  ON payments.payment_operator_interventions(owner_user_id, occurred_at DESC);
CREATE INDEX payment_operator_interventions_admin_time_idx
  ON payments.payment_operator_interventions(admin_user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS messaging.notifications (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messaging.notification_targets (
  notification_id text NOT NULL REFERENCES messaging.notifications(id),
  user_id text NOT NULL,
  device_uuid text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(notification_id, user_id, device_uuid)
);

CREATE TABLE IF NOT EXISTS messaging.notification_receipts (
  notification_id text NOT NULL,
  user_id text NOT NULL,
  device_uuid text NOT NULL,
  delivered_at timestamptz,
  read_at timestamptz,
  PRIMARY KEY(notification_id, user_id, device_uuid),
  FOREIGN KEY(notification_id, user_id, device_uuid)
    REFERENCES messaging.notification_targets(notification_id, user_id, device_uuid)
);

CREATE OR REPLACE FUNCTION payments.reject_operator_intervention_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, payments
AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'payment operator interventions are append-only';
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION payments.reject_operator_intervention_mutation() FROM PUBLIC;
CREATE TRIGGER payment_operator_interventions_reject_update_delete
  BEFORE UPDATE OR DELETE ON payments.payment_operator_interventions
  FOR EACH ROW EXECUTE FUNCTION payments.reject_operator_intervention_mutation();
CREATE TRIGGER payment_operator_interventions_reject_truncate
  BEFORE TRUNCATE ON payments.payment_operator_interventions
  FOR EACH STATEMENT EXECUTE FUNCTION payments.reject_operator_intervention_mutation();

REVOKE ALL ON SCHEMA payments FROM PUBLIC;
REVOKE ALL ON payments.payment_operator_interventions FROM PUBLIC;
GRANT USAGE ON SCHEMA payments TO cassav6_runtime;
GRANT SELECT, INSERT ON payments.payment_operator_interventions TO cassav6_runtime;
GRANT SELECT, INSERT ON messaging.notifications TO cassav6_runtime;
GRANT SELECT, INSERT ON messaging.notification_targets TO cassav6_runtime;
GRANT SELECT, INSERT, UPDATE ON messaging.notification_receipts TO cassav6_runtime;

COMMENT ON TABLE payments.payment_operator_interventions
  IS 'Journal durevole append-only degli interventi amministrativi su pagamenti di altri operatori; nessuna retention.';
