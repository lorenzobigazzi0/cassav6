# V5BT Owner Batching Canary - 2026-08-06

## Scopo

Confrontare il profilo owner auto-print qualificabile a `25` ms con il solo
canary ammesso a `100` ms, usando 25 Palmari e 5 Postazioni simulati, 300
azioni, cadenza mobile di 3 secondi e comande ogni 7-8 secondi.

## Verifica Software

- Suite integrata: `241/241 PASS`.
- Attribution schema: `1`.
- Raccolta runtime: `6/6` worker, zero fallimenti.
- Categorie: `proxyOwner`, `appStateMysql`, `printSpool`, `stationState` tutte
  `COMPLETE` in entrambe le catture.
- Hardware fisico usato: no.

## Esiti

| Profilo | Classe | Azioni | Errori business | P95 azioni | P95 comande | Esito |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 100 ms | NON_GATE / NON_PROMOTABLE | 300/300 | 0 | 4166 ms | 3771 ms | FAIL P95 azioni |
| 25 ms | QUALIFYING_PROFILE | 300/300 | 0 | 13684 ms | 10309 ms | FAIL P95 e cadenze |

Il run a `25` ms ha incontrato contesa station-state fino a `12747` ms durante
la finestra attiva e non e un confronto pulito del batching. Il canary a `100`
ms fallisce comunque il proprio limite assoluto di `3000` ms, quindi non puo
essere promosso.

## Decisione

Mantenere il valore ufficiale a `25` ms. Il prossimo canary deve isolare il
marker condiviso MySQL di `integration.stationStates`, restare disattivato per
default e ricadere automaticamente sul writer canonico quando il marker non e
presente.

## Evidenze

```text
SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_micro_300_owner_batch100_202608061447/report.json
SHA-256 0d97470e467c7b64e4094dd56b4b339f9101ca8b4255f8efc9e8a0bb5601fefb

SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_micro_300_owner_batch25_202608061450/report.json
SHA-256 a5d112eecb4a8ffef00b32e7fe1701fb44dede7f34ccb0f303732571a051a028
```

Avanzamento roadmap complessiva: **49%**
