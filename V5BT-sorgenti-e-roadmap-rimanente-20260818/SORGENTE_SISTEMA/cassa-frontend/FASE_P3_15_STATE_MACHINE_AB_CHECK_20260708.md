# Fase P3.15 - State machine A/B check

Data locale: 2026-07-08
Target: Raspberry finale `192.168.1.79`
Frontend/API: `https://192.168.1.79:5280/`

## Scopo

Verifica esplicita prima di P4: le macchine a stati N1/N2/N3 devono essere default-on
senza differenze osservabili rispetto ai flag forzati off sui flussi legacy:

- ordine mobile -> postazione attiva
- workflow `prep -> ready -> delivered`
- pagamento cash non fiscale
- readback ordine pagato da worker API
- richiesta stampa preconto con stampa reale disabilitata

## Modifiche fatte

- Aggiunto `scripts/state-machine-ab-canary.mjs`.
- Corretto `GET /api/integration/orders` in `backend/server.js`: le richieste con
  `fresh=...` o `_=...` bypassano la fast cache e non la riscrivono.

Il bug trovato durante il canary era una risposta stale dalla cache veloce:
il pagamento era completato su owner, ma il polling `GET /api/integration/orders?fresh=...`
sul worker poteva continuare a vedere `paymentStatus=unpaid` fino a una mutazione
successiva. Dopo il fix il readback pagato torna al primo tentativo.

## Sicurezza I/O reale

Confermate sul target:

```text
PRINTING_ENABLED=0
BACKEND_FISCAL_OUTBOX_WORKER_ENABLED=0
AUTOMATIC_CASH_GATEWAY_ENABLED=0
CASSAV4_TEST_DISABLE_REAL_IO=1
FISCAL_REAL_IO_DISABLED=1
```

Nessun flag N1/N2/N3 e rimasto forzato in `/etc/cassav4/cassav4.env`, quindi il
target e tornato default-on.

## Evidenze canary

### default-on strict postfix

Report:
`/var/log/cassav4/p351_state_machine_default_on_strict_postfix_20260708_011524/state-machine-ab-canary-state_machine_ab_default-on-strict-postfix_20260707T231525`

- gate: PASS
- ordine: `00614`
- create: `665.94 ms`
- ready: `471 ms`
- delivered: `341.87 ms`
- payment: `1075.15 ms`
- paid readback: `1` tentativo, `122.22 ms`
- print disabled: true
- finale ordine: `workflowStatus=delivered`, `paymentStatus=paid`, `paidAmount=1.3`, `dueAmount=0`, `revision=4`

### forced-off strict postfix rerun

Report:
`/var/log/cassav4/p351_state_machine_forced_off_strict_postfix_rerun_20260708_011618/state-machine-ab-canary-state_machine_ab_forced-off-strict-postfix-rerun_20260707T231619`

- gate: PASS
- ordine: `00615`
- create: `601.58 ms`
- ready: `556.09 ms`
- delivered: `361.05 ms`
- payment: `1104.19 ms`
- paid readback: `1` tentativo, `124.99 ms`
- print disabled: true
- finale ordine: `workflowStatus=delivered`, `paymentStatus=paid`, `paidAmount=1.3`, `dueAmount=0`, `revision=4`

### default-on restored strict postfix

Report:
`/var/log/cassav4/p351_state_machine_default_on_restored_strict_postfix_20260708_011704/state-machine-ab-canary-state_machine_ab_default-on-restored-strict-postfix_20260707T231705`

- gate: PASS
- ordine: `00616`
- create: `668.13 ms`
- ready: `448.69 ms`
- delivered: `359.75 ms`
- payment: `1046.3 ms`
- paid readback: `1` tentativo, `131.29 ms`
- print disabled: true
- finale ordine: `workflowStatus=delivered`, `paymentStatus=paid`, `paidAmount=1.3`, `dueAmount=0`, `revision=4`

Nota: un run forced-off precedente e fallito con `502 Backend non raggiungibile`
per warmup immediatamente dopo restart. E stato escluso dal gate e rilanciato
dopo health OK.

## Test eseguiti

Sul target:

```text
/usr/local/bin/node --check backend/server.js
/usr/local/bin/node --check scripts/state-machine-ab-canary.mjs
/usr/local/bin/node --test backend/tests/payment-state-machine.test.mjs backend/tests/order-state-machine.test.mjs backend/tests/print-state-machine.test.mjs
```

Risultato test state machine: `27/27` pass.

Servizi finali:

```text
cassav4-backend: active
cassav4-api-worker@5283: active
cassav4-api-worker@5284: active
cassav4-frontend: active
cassav4-realtime: active
```

## Esito

P3.15 chiusa: default-on N1/N2/N3 non introduce differenze osservabili sui
flussi legacy testati. Il target resta default-on e pronto per il prossimo step
P4 load-100.
