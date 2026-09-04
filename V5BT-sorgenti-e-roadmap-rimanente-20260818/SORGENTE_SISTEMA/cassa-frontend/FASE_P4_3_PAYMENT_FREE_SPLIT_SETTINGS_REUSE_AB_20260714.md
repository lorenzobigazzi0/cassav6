# CASSAv4 - P4.3 riuso impostazioni POS payment.free_split

Data: 2026-07-14

Target: Raspberry `192.168.1.79`, release
`20260714-p4-payment-stateless-050858`, quattro core disponibili.

## Decisione

- Profilo CPU ARM e identificazione del costo: **GO**.
- Riuso del contesto POS sanificato, sotto flag e con rollback: **GO tecnico**.
- Correttezza locale/ARM e canary A/B 20: **GO**.
- Gate `payment.free_split` p95 <200 ms: **NO-GO**.
- Canary 50 e promozione live: **non eseguiti**, flag lasciato default OFF.

## Profilo CPU

Run: `p43_domain_profile20_20260714_01`, 20 palmari, 4 postazioni,
3 GUI mobile, 1 GUI postazione, 2 API worker e 1 worker lock. Stampa reale,
fiscale reale e cassa automatica reale esclusi.

Nel sottoalbero `handlePaymentFreeSplit` sono stati rilevati 2.225 campioni.
I costi sincroni principali sono risultati:

- ordinamento e normalizzazione configurazioni palmari: 210 campioni;
- ricostruzione/ordinamento tavoli e aree POS: 162 campioni;
- `sanitizePosSettings`: 80 campioni diretti;
- costruzione layout tavoli: 74 campioni;
- sanificazione ordini e tavoli: 73 e 65 campioni.

Il percorso richiamava piu volte la normalizzazione completa delle stesse
impostazioni all'interno della singola richiesta.

Artefatti: `reports/p4_payment_stateless_mirror_20260714/domain-profile20/`.

## Implementazione

Nuovo flag di rollback, default OFF:

```text
BACKEND_PAYMENT_FREE_SPLIT_SETTINGS_REUSE=0
```

Quando attivo, l'handler sanifica le impostazioni POS una volta e passa quel
contesto alle funzioni di validazione, readiness, aggiornamento ordine, live
stats e financial sync. Senza flag ogni funzione usa il percorso precedente.

Sono state aggiunte metriche:

- `domain.settingsSanitize`;
- `domain.tableFinancialSync.initial`;
- `domain.authoritativeValidate`;
- `domain.readiness.preflight` e `domain.readiness.final`;
- `domain.applyIntegrationPayment`;
- `domain.tableFinancialSync.final`.

## Test

- Gate architetturali locali e ARM: **139/139**.
- Mirror, telemetria, relazionale, report auth e budget: **29/29** locali.
- Stesse suite piu E2E pagamento su ARM: **44/44**.
- Casi E2E pagamento con flag OFF: **15/15**.
- Casi E2E pagamento con flag ON, locale e ARM: **15/15** per ambiente.
- Budget `backend/server.js`: 38.794 righe `wc`, almeno 705 righe di margine
  rispetto al limite 39.500 usato dal gate.

## Canary A/B 20

Run:

- OFF: `p43_settings_reuse20_off_20260714_01`;
- ON: `p43_settings_reuse20_on_20260714_01`.

Configurazione comune: 20 palmari, 4 postazioni, 3 GUI mobile, 1 GUI
postazione, 20 SSE, 2 API worker, 1 worker lock, 6 sonde free-split, 20 ordini
e 200 altre azioni. Tutto l'I/O reale e' escluso.

| Metrica | OFF | ON | Variazione |
| --- | ---: | ---: | ---: |
| Failure | 0 | 0 | invariato |
| Sonda free-split HTTP 200 | 6/6 | 6/6 | invariato |
| Sonda p50 | 112 ms | 136 ms | +21,4% |
| Sonda p95/max | 587/587 ms | 329/329 ms | -44,0% |
| HTTP globale p50 | 40 ms | 37 ms | -7,5% |
| HTTP globale p95 | 587 ms | 417 ms | -29,0% |
| HTTP globale p99 | 1.533 ms | 928 ms | -39,5% |
| HTTP globale p99.9 | 3.337 ms | 1.339 ms | -59,9% |
| Realtime p95 | 257 ms | 254 ms | -1,2% |
| `domain.prepare` medio | 93,14 ms | 87,17 ms | -6,4% |
| Workflow completato medio | 151,14 ms | 140,67 ms | -6,9% |
| Validazione autorevole media | 6,60 ms | 2,64 ms | -60,0% |
| Financial sync iniziale medio | 17,28 ms | 12,60 ms | -27,1% |
| Financial sync finale medio | 16,71 ms | 10,83 ms | -35,2% |
| Mirror ordini medio | 73,29 ms | 69,33 ms | -5,4% |

Entrambi i run chiudono 20/20 ordini, 200/200 altre azioni, drain relazionale
completo, outbox vuoto, zero duplicati e zero mirror pending/failed. Il ramo ON
chiude 6/6 mirror stateless senza retry, fallback o claim legacy.

Artefatti:
`reports/p4_payment_stateless_mirror_20260714/settings-reuse-ab20/`.

## Esito e prossimo passo

Il riuso elimina lavoro CPU duplicato e migliora il tail del canary, ma il
p95 sonda resta 329 ms e il `domain.prepare` massimo non migliora in modo
stabile. Il flag non viene promosso e non si scala a 50.

Prossimo sottostep P4.3:

1. unire in una transazione batch il mirror `integration.orders`,
   `integration.lastWriteAt` e station index;
2. eliminare il conflitto transitorio osservato nell'indice postazioni;
3. ripetere A/B 20 con il riuso impostazioni combinato;
4. passare a 50 solo dopo p95 <200 ms in due run consecutivi.
