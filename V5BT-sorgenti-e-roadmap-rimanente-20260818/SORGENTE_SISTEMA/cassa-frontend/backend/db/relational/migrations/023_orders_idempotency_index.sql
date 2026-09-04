ALTER TABLE orders ADD COLUMN idempotency_key TEXT;
ALTER TABLE orders ADD COLUMN created_by_user_id TEXT;
ALTER TABLE orders ADD COLUMN created_by_device_uuid TEXT;

UPDATE orders
SET
  idempotency_key = CASE
    WHEN json_valid(raw_json) THEN NULLIF(TRIM(CAST(json_extract(raw_json, '$.idempotencyKey') AS TEXT)), '')
    ELSE NULL
  END,
  created_by_user_id = CASE
    WHEN json_valid(raw_json) THEN NULLIF(TRIM(CAST(json_extract(raw_json, '$.createdByUserId') AS TEXT)), '')
    ELSE NULL
  END,
  created_by_device_uuid = CASE
    WHEN json_valid(raw_json) THEN NULLIF(TRIM(CAST(json_extract(raw_json, '$.createdByDeviceUuid') AS TEXT)), '')
    ELSE NULL
  END;

CREATE INDEX IF NOT EXISTS idx_orders_idempotency_scope
  ON orders(idempotency_key, created_by_user_id, created_by_device_uuid);
