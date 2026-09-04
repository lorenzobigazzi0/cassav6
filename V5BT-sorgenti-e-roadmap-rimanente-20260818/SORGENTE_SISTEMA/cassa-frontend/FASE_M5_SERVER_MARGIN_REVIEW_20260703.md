# Fase M5 - verifica margine server.js prima di N

Data: 2026-07-03

## Obiettivo

Verificare se l'estrazione K-PRE.1 di pagamenti/fiscale ha lasciato margine
sufficiente su `backend/server.js` per aprire le fasi successive, in particolare
N, oppure se serve un'ulteriore estrazione modulare immediata.

## Dati rilevati

- Budget precedente del test architetturale: 40.500 righe.
- `wc -l backend/server.js`: 38.695 righe.
- Conteggio con lo stesso metodo del test: 38.696 righe.
- Margine sul budget precedente: 1.804 righe.
- Baseline v4.1.0 documentata: 38.359 righe.
- K-PRE.1.5 documentava 37.932 righe e 2.568 righe di margine.
- Dopo K/L/M il file e' cresciuto, ma resta sotto soglia.

## Decisione

PASS con guardrail piu' stretto.

Non viene aperta ora un'estrazione handler ordini completa: sarebbe una
modifica piu' rischiosa del valore di M5 e si sovrapporrebbe con la Fase N, che
deve introdurre state machine esplicite e puo' spostare la logica nei moduli
senza gonfiare il monolite.

Pero' il budget precedente era troppo largo per impedire regressioni casuali.
M5 quindi restringe il gate:

- `SERVER_LINE_BUDGET`: da `40_500` a `39_500`.
- Margine residuo reale: circa 804 righe con il metodo del test.
- Nuovo guardrail statico M5 in `route-policy-architecture.test.mjs`.

## Modifiche

- `backend/tests/architecture-line-budget.test.mjs`
  - Abbassato `SERVER_LINE_BUDGET` a `39_500`.

- `backend/tests/route-policy-architecture.test.mjs`
  - Aggiunto guardrail `Fase M5 stringe il margine server.js prima delle state machine`.
  - Il test verifica:
    - budget M5 a `39_500`;
    - `server.js` sotto budget;
    - almeno 700 righe di margine residuo;
    - presenza di `modules/orders/order-state-machine.js` come destinazione per
      le state machine ordine della Fase N.

## Invarianti mantenuti

- Nessun comportamento runtime modificato.
- Nessuna route cambiata.
- Nessun handler spostato in questa fase.
- Il prossimo lavoro di dominio deve andare in `backend/modules/`, non in nuove
  funzioni dentro `server.js`, salvo wiring minimo.

## Test eseguiti

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/server.js
```

Risultato: ok.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/architecture-line-budget.test.mjs cassa-frontend/backend/tests/route-policy-architecture.test.mjs
```

Risultato: 18/18 pass.

## Verifica operativa consigliata

Durante N:

- aggiungere o completare state machine in `backend/modules/<domain>/`;
- lasciare in `server.js` solo import, wiring e chiamate alle factory;
- rieseguire sempre `architecture-line-budget.test.mjs`;
- se il margine scende sotto 700 righe, fermarsi e fare una nuova estrazione
  handler/service prima di continuare.

## STOP/REVIEW

M5 e' chiusa. Il prossimo passo della Fase M e' M6: rivedere la retention di
`.print-spool` alla luce del traffico reale post-K.
