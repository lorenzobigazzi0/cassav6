# PostgreSQL migration P0 - baseline workspace D: 2026-08-31

## Identita

- Workspace: `D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818`
- Sorgente verificata: `V6.0.0.6.zip`
- SHA-256 sorgente: `8FDC73B116FD1C697A127CC10E1104BCF7046121522F4C65FB8177F7F1506361`
- Verifica overlay: 4.169 file identici, 0 sovrascritti, 0 aggiunti.

## Check superati

| Comando | Risultato |
|---|---|
| `npm run test:migration:pg:p0` | PASS - 4/4 |
| `npm run migration:pg:p0` | PASS - inventario e golden dataset rigenerati |
| `npm run test:migration:pg:mig003` | PASS - 5/5 |
| `npm run check:backend` | PASS |
| `npm run test:phase0` | PASS - 6/6 |
| `npm run test:phase0-tools` | PASS - 16/16 |
| `npm run preflight:source` | PASS |
| `npm test` (`settings-frontend`) | PASS - 2/2 |
| `npm run build` (`settings-frontend`) | PASS |
| `npm run build` (`postazione`) | PASS con warning Vite sugli asset statici runtime |
| `npm run typecheck` (`mobile-frontend`) | PASS |
| `npm run build` (`mobile-frontend`) | PASS - 470 moduli trasformati |

## Check non verdi

| Comando | Risultato |
|---|---|
| `npm run test:frontend` (`cassa-frontend`) | FAIL - 72/92 pass. I test residui cercano soprattutto `WEBAPP_COMPILATA` e i vecchi asset monolitici `settings-app.js/css`; due asserzioni statiche non seguono i moduli estratti. |
| `npm test` (`mobile-frontend`) | FAIL - 639/642 pass. Falliscono il budget LOC di cinque componenti e due asserzioni statiche obsolete. |

La suite backend completa e la baseline prestazionale sul Raspberry non sono
state chiuse in questo passaggio. MIG-000 resta quindi `IN_PROGRESS`.

## Artefatti P0

- `legacy-storage-inventory.csv`: 228 occorrenze runtime `readDb` in 35 file;
  91 occorrenze runtime `writeDb` in 20 file.
- `golden-dataset.json`: menu, ordine, pagamento, prenotazione e benefit.
- SHA-256 golden dataset:
  `36f9a1f627664926439e0dba94fdb4b6e46293c8e6d05d1e63d42d12ed176180`.

