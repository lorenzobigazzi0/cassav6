# Fase P5.1 - Checkpoint durevoli delle latenze

Data: 2026-07-16

## Obiettivo

Conservare campioni e percentili HTTP/azione durante P5 anche quando il run
viene interrotto prima della generazione di `report.json`.

## Implementazione

- `scripts/p5-latency-checkpoint.mjs` scrive batch incrementali append-only in
  `p5-latency-checkpoints.jsonl`.
- Ogni checkpoint contiene i nuovi campioni e il riepilogo cumulativo
  P50/P95/P98/P99/P99.9/max.
- Il flush avviene ogni 30 secondi nel run completo, a ogni progress report e
  durante la chiusura del profilo o del processo.
- I cursori avanzano solo dopo una append riuscita: un errore temporaneo non
  perde ne duplica i campioni al tentativo successivo.
- Il launcher verifica la presenza del JSONL prima di certificare il run.
- Il launcher usa correttamente la sessione grafica e `npm` su Windows.

## Validazione

- `npm run test:p5:scheduler`: 14/14 test passati.
- `npm run test:p5:endurance:dry-run`: passato su Windows con Chrome.
- `npm run test:p5:endurance:smoke`: passato, 200/200 azioni, 0 failure,
  20/20 client realtime e drain relazionale completato.
- Checkpoint smoke: 574 campioni HTTP e 200 campioni azione, tutti unici.
- Report smoke:
  `logs/loadtest-p5_20x5_25k_20260716093351/report.json`.

## Stato del gate

P5.1 e chiusa. P5 complessiva resta rossa: prima di un nuovo full run bisogna
ridurre le attese della lane `mutation` e classificare i deadlock MySQL rilevati
nel campione parziale da 20.135 azioni.

## Prossimo task

P5.2: estrarre dal run parziale la distribuzione `mutation` per label/route e
correlare ogni attesa lunga con retry/deadlock MySQL, senza modificare ancora la
concorrenza delle lane.
