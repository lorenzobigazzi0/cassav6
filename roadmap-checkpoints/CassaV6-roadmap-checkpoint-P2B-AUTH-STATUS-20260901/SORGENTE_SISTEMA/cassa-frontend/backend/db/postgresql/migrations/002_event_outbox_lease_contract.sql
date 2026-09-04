ALTER TABLE messaging.event_outbox
  ADD CONSTRAINT event_outbox_lease_pair_coherent
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL))
  NOT VALID;

ALTER TABLE messaging.event_outbox
  VALIDATE CONSTRAINT event_outbox_lease_pair_coherent;

ALTER TABLE messaging.event_outbox
  ADD CONSTRAINT event_outbox_processed_without_lease
  CHECK (
    processed_at IS NULL
    OR (lease_owner IS NULL AND lease_until IS NULL)
  )
  NOT VALID;

ALTER TABLE messaging.event_outbox
  VALIDATE CONSTRAINT event_outbox_processed_without_lease;

COMMENT ON CONSTRAINT event_outbox_lease_pair_coherent
  ON messaging.event_outbox
  IS 'MIG-023: lease owner e scadenza sono assegnati e rimossi atomicamente.';

COMMENT ON CONSTRAINT event_outbox_processed_without_lease
  ON messaging.event_outbox
  IS 'MIG-023: un evento processato e terminale e non conserva un lease.';

