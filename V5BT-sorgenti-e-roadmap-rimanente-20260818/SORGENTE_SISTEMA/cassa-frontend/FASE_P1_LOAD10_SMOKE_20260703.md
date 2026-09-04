# Fase P1 - Smoke virtuale load-10

Data: 2026-07-03

## Esito

P1 completata con esito positivo.

Run finale:

`logs/loadtest-phaseP_load-10-p1-final/REPORT.md`

Profilo:

- 10 palmari API
- 10 postazioni API
- 1 GUI reale Playwright headless
- 30 operazioni per device
- fiscale su mock locale `http://127.0.0.1:9290`
- stampante TCP virtuale su `127.0.0.1:9109`
- stampa fisica disabilitata

## Sintesi run finale

- Durata: 83 s
- Operazioni business: 630
- Richieste HTTP: 1219
- Errori/anomalie campionate: 0
- RT fiscale: 5 tentativi, 4 successi HTTP 2xx
- Metriche mock fiscale: `statusRequests=4`, `receiptRequests=4`, `reprintRequests=0`
- Coda finale `dbMutation/orderLane`: 0 / 0
- MySQL: 91.62 MB scritti, 13045 righe inserite, 1075 aggiornate

## Correzioni emerse durante P1

- `loadtest-full-capacity.mjs` ora misura anche le metriche reali del mock fiscale tramite `/metrics`.
- Il campione fiscale usa un palmare abilitato alla fiscalita', non il device admin generico.
- Il contatore `rtFiscalSuccess` ora considera successo solo una risposta HTTP 2xx.
- Il simulatore paga con retry controllato se un pagamento incontra un 428 da lock tavolo perso sotto concorrenza.

## Note

Nel run finale un campione fiscale ha ricevuto 409 accettato dal test; il provider mock ha ricevuto 4 emissioni reali su 5 campioni. Non risultano code pendenti a fine run.

Prossimo step: P2 - scala virtuale `load-25`.
