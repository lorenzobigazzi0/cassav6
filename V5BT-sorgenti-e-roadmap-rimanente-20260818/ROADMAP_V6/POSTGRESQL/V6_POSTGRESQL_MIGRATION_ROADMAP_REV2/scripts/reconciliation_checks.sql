-- REV2 2026-08-31 — Invarianti PostgreSQL post-import.
--
-- ATTENZIONE, LIMITE DI QUESTO FILE:
-- questi controlli verificano SOLO lo stato interno di PostgreSQL. Non dicono
-- nulla su quanto e stato importato correttamente dal legacy.
--
-- La riconciliazione vera (conteggi e somme legacy vs PostgreSQL) e in
-- scripts/reconcile_legacy_vs_pg.mjs ed e OBBLIGATORIA. Questo file non la
-- sostituisce.
--
-- Nella REV1 questo script conteneva controlli gia garantiti da FK, CHECK e
-- UNIQUE nella DDL: potevano soltanto restituire 0 e producevano falsa sicurezza.
-- Quei controlli sono stati rimossi o convertiti in verifiche di CONFIGURAZIONE
-- (il vincolo esiste?) invece che di DATO (il vincolo e violato?).

\echo '=== 1. I vincoli attesi esistono davvero? ==='
-- Se un vincolo manca, i controlli sui dati che dipendono da lui sono inutili.
SELECT expected.conname,
       CASE WHEN c.conname IS NULL THEN 'MANCANTE' ELSE 'presente' END AS stato
FROM (VALUES
  ('bills_no_overpayment'),
  ('bills_balance'),
  ('coupon_remaining_within_face'),
  ('payment_settled_coherent'),
  ('cash_session_closed_coherent')
) AS expected(conname)
LEFT JOIN pg_constraint c ON c.conname = expected.conname
ORDER BY 2, 1;

\echo '=== 2. Indici unici critici ==='
SELECT expected.idxname,
       CASE WHEN i.indexname IS NULL THEN 'MANCANTE' ELSE 'presente' END AS stato
FROM (VALUES
  ('provider_transaction_ref_unique'),
  ('fiscal_operation_idempotency_unique'),
  ('benefit_application_active_unique'),
  ('products_sku_unique'),
  ('products_barcode_unique')
) AS expected(idxname)
LEFT JOIN pg_indexes i ON i.indexname = expected.idxname
ORDER BY 2, 1;

\echo '=== 3. Invarianti NON coperte da vincoli di schema ==='
-- Questi possono davvero essere diversi da zero: valgono la pena di essere eseguiti.

\echo '-- 3.1 bill il cui paid non corrisponde alla somma delle allocazioni'
SELECT b.id, b.paid_cents, COALESCE(SUM(a.amount_cents), 0) AS allocated_cents
FROM sales.bills b
LEFT JOIN payments.payment_bill_allocations a ON a.bill_id = b.id
GROUP BY b.id, b.paid_cents
HAVING b.paid_cents <> COALESCE(SUM(a.amount_cents), 0);

\echo '-- 3.2 pagamento la cui somma delle allocazioni supera l importo'
SELECT p.id, p.amount_cents,
       COALESCE(SUM(o.amount_cents), 0) AS order_alloc,
       COALESCE(SUM(bl.amount_cents), 0) AS bill_alloc
FROM payments.payments p
LEFT JOIN payments.payment_order_allocations o ON o.payment_id = p.id
LEFT JOIN payments.payment_bill_allocations bl ON bl.payment_id = p.id
GROUP BY p.id, p.amount_cents
HAVING GREATEST(COALESCE(SUM(o.amount_cents),0), COALESCE(SUM(bl.amount_cents),0)) > p.amount_cents;

\echo '-- 3.3 coupon il cui residuo non corrisponde a face - somma redemption'
SELECT c.id, c.face_value_cents, c.remaining_cents,
       COALESCE(SUM(r.amount_cents), 0) AS redeemed_cents
FROM commerce.benefit_coupons c
LEFT JOIN commerce.benefit_redemptions r ON r.coupon_id = c.id
GROUP BY c.id, c.face_value_cents, c.remaining_cents
HAVING c.remaining_cents <> c.face_value_cents - COALESCE(SUM(r.amount_cents), 0);

\echo '-- 3.4 righe ordine il cui snapshot di pricing e vuoto (storico non ricostruibile)'
SELECT count(*) AS lines_without_pricing_snapshot
FROM sales.order_lines
WHERE pricing_snapshot = '{}'::jsonb OR product_name_snapshot IS NULL OR product_name_snapshot = '';

\echo '-- 3.5 documenti fiscali senza operazione valida'
SELECT count(*) AS fiscal_documents_without_operation
FROM fiscal.documents d
LEFT JOIN fiscal.operations o ON o.document_id = d.id
WHERE o.id IS NULL AND d.status NOT IN ('draft','pending');

\echo '-- 3.6 pagamenti SETTLED senza documento fiscale, dove atteso'
-- Adattare la condizione al contratto reale prima di usarla come gate.
SELECT count(*) AS settled_payments_without_fiscal_document
FROM payments.payments p
LEFT JOIN fiscal.documents d ON d.payment_id = p.id
WHERE p.status = 'SETTLED' AND d.id IS NULL;

\echo '-- 3.7 ordini che referenziano una sessione di vendita inesistente'
SELECT count(*) AS orders_with_dangling_sale_session
FROM sales.orders o
LEFT JOIN sales.sale_sessions s ON s.id = o.sale_session_id
WHERE o.sale_session_id IS NOT NULL AND s.id IS NULL;

\echo '-- 3.8 outbox in backlog o bloccato'
SELECT count(*) FILTER (WHERE processed_at IS NULL) AS pending,
       count(*) FILTER (WHERE processed_at IS NULL AND attempt_count > 5) AS stuck,
       min(created_at) FILTER (WHERE processed_at IS NULL) AS oldest_pending
FROM messaging.event_outbox;

\echo '=== 4. Totali per confronto manuale con il legacy ==='
-- Questi numeri vanno CONFRONTATI con la sorgente, non letti da soli.
-- reconcile_legacy_vs_pg.mjs lo fa automaticamente.
SELECT 'users' AS entity, count(*) AS n, NULL::bigint AS amount_cents FROM identity.users
UNION ALL SELECT 'products', count(*), NULL FROM catalog.products
UNION ALL SELECT 'orders', count(*), NULL FROM sales.orders
UNION ALL SELECT 'order_lines', count(*), NULL FROM sales.order_lines
UNION ALL SELECT 'payments', count(*), sum(amount_cents) FROM payments.payments
UNION ALL SELECT 'payments_settled', count(*), sum(amount_cents) FROM payments.payments WHERE status = 'SETTLED'
UNION ALL SELECT 'fiscal_documents', count(*), sum(amount_cents) FROM fiscal.documents
UNION ALL SELECT 'benefit_redemptions', count(*), sum(amount_cents) FROM commerce.benefit_redemptions
ORDER BY 1;
