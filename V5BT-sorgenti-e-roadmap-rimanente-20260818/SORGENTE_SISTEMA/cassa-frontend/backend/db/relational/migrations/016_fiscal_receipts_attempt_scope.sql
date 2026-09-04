ALTER TABLE fiscal_receipts
  ADD COLUMN attempt_scope TEXT NOT NULL DEFAULT 'issue';

UPDATE fiscal_receipts
SET attempt_scope = 'legacy_' || rowid
WHERE payment_transaction_id IS NOT NULL
  AND rowid NOT IN (
    SELECT MIN(rowid)
    FROM fiscal_receipts
    WHERE payment_transaction_id IS NOT NULL
    GROUP BY payment_transaction_id, attempt_scope
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_fiscal_receipts_payment_attempt_scope
  ON fiscal_receipts(payment_transaction_id, attempt_scope)
  WHERE payment_transaction_id IS NOT NULL;
