-- RET-01: approvazione delle finestre di retention proposte da MIG-026.
--
-- La decisione approva i valori, NON attiva nulla: le otto policy restano
-- `enabled = false`. Lo schema tiene i due passi separati apposta
-- (`retention_policies_approval_required`): una policy diventa operativa solo
-- con una UPDATE esplicita e successiva, quando la tabella esiste davvero e
-- esiste uno scheduler che la invoca fuori dagli orari di servizio.
--
-- Sei delle otto policy riguardano tabelle non ancora create; delle due gia
-- presenti nessuna ha righe eliminabili oggi sul DEV.
--
-- REGOLA NON NEGOZIABILE, invariata: nessuna retention su payments.* e
-- fiscal.*. Quelle cinque righe restano `legally_required`, `strategy = 'none'`
-- e immutabili per trigger: questa migration non le tocca.
--
-- Seconda parte della decisione, registrata qui per tracciabilita e vincolante
-- per le fasi P4-P10: le tabelle append-only ad alto volume nascono gia
-- partizionate per mese sulla colonna temporale, anche quando la retention
-- resta disabilitata. Convertire una tabella gia popolata su questo hardware
-- costa molto piu che crearla partizionata e non usare le partizioni.

UPDATE app_meta.retention_policies
SET
  decision_ref = 'RET-01:APPROVED-2026-09-02',
  approved_at = COALESCE(approved_at, now()),
  updated_at = now(),
  notes = CASE target
    WHEN 'audit.events' THEN
      'RET-01 approvata: 1095 giorni, drop partizione. Audit operativo su tabella gia partizionata per mese.'
    WHEN 'sales.order_events' THEN
      'RET-01 approvata: 730 giorni, drop partizione. Il dato di vendita resta in orders/order_lines. Tabella non ancora creata.'
    WHEN 'operations.order_fulfillment_events' THEN
      'RET-01 approvata: 365 giorni, drop partizione. Metriche di preparazione. Tabella non ancora creata.'
    WHEN 'operations.device_status_events' THEN
      'RET-01 approvata: 90 giorni, drop partizione. Telemetria device, alto volume e basso valore storico. Tabella non ancora creata.'
    WHEN 'operations.print_attempts' THEN
      'RET-01 approvata: 180 giorni, delete a lotti. Diagnostica stampa. Tabella non ancora creata.'
    WHEN 'messaging.event_outbox' THEN
      'RET-01 approvata: 30 giorni, delete a lotti, soltanto righe con processed_at valorizzato.'
    WHEN 'operations.print_jobs' THEN
      'RET-01 approvata: 90 giorni, delete a lotti, soltanto job completati. Tabella non ancora creata.'
    WHEN 'messaging.idempotency_keys' THEN
      'RET-01 approvata: 30 giorni oltre expires_at, delete a lotti, soltanto record terminali.'
    ELSE notes
  END
WHERE legally_required = false
  AND strategy <> 'none'
  AND decision_ref ~* 'TODO';

-- Postcondizione difensiva: la migration non deve avere attivato nulla ne avere
-- toccato le policy protette.
DO $$
DECLARE
  abilitate integer;
  approvate integer;
  protette integer;
BEGIN
  SELECT count(*) INTO abilitate
  FROM app_meta.retention_policies
  WHERE enabled;
  IF abilitate <> 0 THEN
    RAISE EXCEPTION 'RET-01: nessuna policy deve risultare abilitata, trovate %', abilitate
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO approvate
  FROM app_meta.retention_policies
  WHERE legally_required = false
    AND approved_at IS NOT NULL
    AND decision_ref !~* 'TODO';
  IF approvate <> 8 THEN
    RAISE EXCEPTION 'RET-01: attese 8 policy approvate, trovate %', approvate
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO protette
  FROM app_meta.retention_policies
  WHERE legally_required
    AND strategy = 'none'
    AND retention_days IS NULL
    AND decision_ref = 'LEGAL:NO_RETENTION';
  IF protette <> 5 THEN
    RAISE EXCEPTION 'RET-01: attese 5 policy legalmente protette, trovate %', protette
      USING ERRCODE = '55000';
  END IF;
END
$$;

COMMENT ON TABLE app_meta.retention_policies
  IS 'MIG-026 / RET-01: finestre approvate il 2026-09-02 e tutte disabilitate; l''attivazione resta una UPDATE esplicita per policy. payments.* e fiscal.* non hanno retention.';
