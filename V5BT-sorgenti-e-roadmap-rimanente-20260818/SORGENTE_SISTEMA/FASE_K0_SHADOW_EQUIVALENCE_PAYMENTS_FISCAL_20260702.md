# FASE K0 - Shadow equivalence payments/fiscal

Data: 2026-07-02

## Obiettivo

Avviare la roadmap `ROADMAP_REALTIME_CASSAV4_v4.md` dalla Fase K, chiudendo K0: equivalenza shadow relazionale per pagamenti/fiscale prima di qualunque promozione write-primary.

## Interventi

- Aggiunti alias di equivalenza `fiscal`, `fiscale`, `fiscalreceipt`, `fiscalreceipts`, `receipt`, `receipts` verso il dominio relazionale `payments`.
- Aggiunto fixture K0 multi-bill/multi-metodo/parziale:
  - tavolo con due bill;
  - pagamento parziale da 45,00 EUR totali, 30,00 EUR pagati, 15,00 EUR residui;
  - una parte contanti e una parte carta;
  - due transazioni e due ricevute fiscali collegate.
- Aggiunti test K0 per:
  - normalizzazione alias `payments,fiscal`;
  - equivalenza shadow dopo sync payments;
  - blocco esplicito su mismatch fiscale;
  - runtime shadow con `RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS=payments,fiscal`.

## File modificati

- `cassa-frontend/backend/db/relational/index.js`
- `cassa-frontend/backend/tests/relational-payments.test.mjs`

## Verifiche eseguite

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/db/relational/index.js
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check backend/tests/relational-payments.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-payments.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/relational-equivalence.test.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test backend/tests/architecture-line-budget.test.mjs
```

Esiti:

- `relational-payments.test.mjs`: 16/16 verdi.
- `relational-equivalence.test.mjs`: 12/12 verdi.
- `architecture-line-budget.test.mjs`: 1/1 verde.
- `backend/server.js`: 37.943 righe, sotto budget.

## DoD K0

- Equivalenza payments/fiscal attivabile via `RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS=payments,fiscal`.
- Equivalenza verificata su scenario split/parziale e non solo pagamento intero.
- Mismatch fiscale intercettato da `assertRelationalEquivalence`.
- Nessun impatto sui flussi operativi: solo alias e test shadow.

## Esito

K0 completata.

STOP/REVIEW K0 rispettato. Il prossimo step della roadmap e' K1, read-primary relazionale per riepiloghi/report, da avviare solo al prossimo via.
