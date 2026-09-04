# Fase P0 - Validation preflight

Data: 2026-07-03

## Obiettivo

Preparare la Fase P prima di lanciare run lunghi o hardware reale: profili
load progressivi, endurance 90 minuti, simulatori fiscal/stampante, report PDF
e soglie di accettazione.

## Modifiche

- Corretto `scripts/loadtest-full-capacity.mjs`: il default `NODE_BIN` ora usa
  `process.execPath` invece di un path storico su USB.
- Aggiunto `scripts/phase-p-validation-preflight.mjs`.
- Aggiunto script npm `preflight:phase-p`.
- Aggiunto test `backend/tests/phase-p-validation-preflight.test.mjs`.
- Generato report preflight:
  `cassa-frontend/logs/phase-p-preflight-20260703075754/REPORT.md`.

## Profili preparati

- `load-10`: 10 palmari, 10 postazioni, 1 GUI.
- `load-25`: 25 palmari, 10 postazioni, 2 GUI.
- `load-50`: 50 palmari, 10 postazioni, 3 GUI.
- `load-100`: 100 palmari, 10 postazioni, 5 GUI.
- `endurance-90m-virtual`: 90 minuti, 50.000 azioni, 120 device mobili,
  50 postazioni, 100 client radio.

Tutti i profili P0 puntano a:

- gateway fiscale virtuale `http://127.0.0.1:9290`;
- stampante TCP virtuale `127.0.0.1:9109`.

## Soglie fissate

- notifiche cameriere/comanda pronta p95: 500 ms;
- radio busy feedback: 150 ms;
- battery event p95: 500 ms;
- order create p95: 300 ms;
- payment table p95: 200 ms;
- doppi pagamenti: 0;
- doppie emissioni fiscali: 0;
- print/fiscal pending a drain: 0.

## Verifiche

Sintassi:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/scripts/phase-p-validation-preflight.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/scripts/loadtest-full-capacity.mjs
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --check cassa-frontend/backend/tests/phase-p-validation-preflight.test.mjs
```

Risultato: ok.

Test mirati P0 + guardrail:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test cassa-frontend/backend/tests/phase-p-validation-preflight.test.mjs cassa-frontend/backend/tests/architecture-roadmap-reconciliation.test.mjs cassa-frontend/backend/tests/route-policy-architecture.test.mjs cassa-frontend/backend/tests/architecture-line-budget.test.mjs
```

Risultato: 25/25 pass, durata `duration_ms=4389.254892`.

Preflight eseguito:

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node cassa-frontend/scripts/phase-p-validation-preflight.mjs
```

Risultato: ok, nessun file mancante.

## Note operative

Non e' stato lanciato il load/endurance vero: P0 chiude solo la preparazione
sicura. I prossimi step possono avviare i simulatori e partire da `load-10`.

## Prossimo step

P1 - Smoke virtuale `load-10` con mock fiscal e mock printer attivi.
