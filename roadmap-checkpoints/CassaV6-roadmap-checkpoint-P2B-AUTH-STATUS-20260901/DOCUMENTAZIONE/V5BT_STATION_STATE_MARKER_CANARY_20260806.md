# V5BT Station-State Marker Canary - 2026-08-06

## Scopo

Verificare se la rimozione fail-safe del marker condiviso
`integration.stationStates` dalle sole scritture parziali riduce la contesa
MySQL nel profilo da 25 Palmari e 5 Postazioni simulate. Nessun hardware
fisico e stato usato.

## Contratto

- Flag backend: `BACKEND_STATION_STATE_MARKER_LOCK_SKIP=1`.
- Override launcher ammesso: solo
  `LOADTEST_V5BT_DIAGNOSTIC_STATION_STATE_MARKER_LOCK_SKIP=1`.
- Default e deploy systemd ufficiale: `0`.
- Profilo ON: sempre `NON_GATE/NON_PROMOTABLE`.
- Il marker viene omesso sia dal `FOR UPDATE` sia dall'upsert soltanto quando
  e canonico: `obj_array`, posizione attesa, JSON `[]` e SHA-256 coerente.
- Marker assente o corrotto: fallback transazionale completo e
  autoriparante.
- Metriche redatte e stabili: `probe`, `applied`, `canonicalFallback`.
- Gate schema `1`: esercizio obbligatorio, contabilita dei rami, zero fallback
  e zero errori/rollback nel canary.

## Verifica

- Suite integrata: `318/318 PASS`.
- Test MySQL reale: un lock su `station_a` non blocca `station_b`; lo stesso
  ID resta serializzato.
- Bootstrap simultaneo senza marker: un solo marker, entrambe le entry, zero
  deadlock non gestiti.
- Coperti anche flag OFF, marker mancante/corrotto, writer diretto e bulk,
  rollback, idratazione e full replace.

## Confronto

| Profilo | Classe | Azioni | Errori business | Marker probe/applicati/fallback | State read P95/max | Azioni P95 | Comande P95 | Esito |
| --- | --- | ---: | ---: | --- | --- | ---: | ---: | --- |
| ON | NON_GATE / NON_PROMOTABLE | 300/300 | 0 | 81 / 81 / 0 | 100 / 197 ms | 3183 ms | 2032 ms | FAIL P95 azioni |
| OFF | QUALIFYING_PROFILE | 300/300 | 0 | 0 / 0 / 0 | 250 / 342 ms | 1793 ms | 1535 ms | PASS |

Entrambe le catture hanno attribution `COMPLETE`, drain relazionale, cleanup,
auto-print owner e zero residui. L'ON riduce il tempo del lock puntuale
station-state, ma nel confronto end-to-end aumenta il P95 azioni di `1390`
ms e supera il limite assoluto di `3000` ms.

## Decisione

Canary respinto. Il profilo ufficiale resta OFF e nessuno smoke da `1200`
viene autorizzato da questa variante. Il codice resta disponibile dietro flag
per ulteriori diagnosi, senza modifica del deploy operativo.

## Evidenze

```text
SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_micro_300_station_marker_skip_202608061514/report.json
SHA-256 9d28b201082fd551d21b6ba707e2b7514e4e6b08d6edfff4308bff7c8c20b04a

SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_micro_300_station_marker_off_202608061517/report.json
SHA-256 eacbd22630ff7bde64d1ecf7e85cbbc814e764d393443ce89f80e6f3996e1fef
```

Avanzamento roadmap complessiva: **49%**
