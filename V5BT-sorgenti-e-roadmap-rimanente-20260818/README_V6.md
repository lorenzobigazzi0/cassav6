# Cassa V6

Baseline iniziale e roadmap eseguibile della release target `6.0.0`.

Data dello stato: **2026-08-20**  
Avanzamento ufficiale V6: **0%**  
Promozione: **non autorizzata**

## Regola di lettura

La directory contiene una baseline V6 costruita dalla sorgente V5BT congelata e
dall'implementazione Commerciale V2. La presenza del codice e i controlli del
bootstrap dimostrano soltanto che l'importazione candidata e coerente con gli
input dichiarati. Non dimostrano che una fase sia verificata sulla release V6.

Lo stato `CANDIDATE_IMPORTED_NOT_VERIFIED` vale quindi zero. Anche test, report,
gate e percentuali V5BT sono riferimenti storici e valgono zero nel calcolo V6.
Una fase accredita il proprio peso soltanto quando e
`VERIFIED_COMPLETE` e contiene riferimenti a evidenze V6 verificabili.

Gli identificatori operativi V6 risultano applicati ma non verificati. Il file
`V6_BOOTSTRAP_PROVENANCE.md` descrive correttamente il bootstrap precedente, nel
quale gli identificatori erano ancora ereditati da V5BT.

## File autorevoli

In ordine di precedenza per lo stato corrente:

1. `ROADMAP_V6/configs/current-roadmap-status.json`
2. `ROADMAP_V6/contracts/current-roadmap-status-v1.schema.json`
3. `ROADMAP_V6/scripts/validate-current-roadmap-status.mjs`
4. `DOCUMENTAZIONE/ROADMAP_V6_20260820.md`
5. `HANDOFF_V6_20260820.md`
6. `V6_BOOTSTRAP_PROVENANCE.md`

I documenti e i report V5BT inclusi nella baseline restano consultabili come
storia e specifica di regressione. Non prevalgono sullo stato V6 e non vanno
riscritti.

## Stato sintetico

| Fase | Peso | Stato iniziale | Credito |
| --- | ---: | --- | ---: |
| V6-P0 - Baseline, Impostazioni e contratti | 10% | `IN_PROGRESS` | 0% |
| V6-P1 - Schema e repository Commerciale V2 | 12% | `CANDIDATE_IMPORTED_NOT_VERIFIED` | 0% |
| V6-P2 - Compilatore e motore prezzi | 15% | `CANDIDATE_IMPORTED_NOT_VERIFIED` | 0% |
| V6-P3 - Articoli e cataloghi | 10% | `CANDIDATE_IMPORTED_NOT_VERIFIED` | 0% |
| V6-P4 - Listini, assegnazioni e simulatore | 12% | `CANDIDATE_IMPORTED_NOT_VERIFIED` | 0% |
| V6-P5 - Menu e offerte composte | 10% | `CANDIDATE_IMPORTED_NOT_VERIFIED` | 0% |
| V6-P6 - Integrazione runtime completa | 15% | `CANDIDATE_IMPORTED_NOT_VERIFIED` | 0% |
| V6-P7 - Migrazione e rimozione eccezioni | 8% | `PENDING` | 0% |
| V6-P8 - Collaudo, canary e rilascio | 8% | `PENDING` | 0% |

Somma dei pesi: **100%**. Non esiste credito parziale implicito.

## Verifica dello stato

Sul sistema corrente Node e disponibile fuori dalla baseline:

```bash
$HOME/.local/node-v24.15.0-linux-x64/bin/node \
  ROADMAP_V6/scripts/validate-current-roadmap-status.mjs

$HOME/.local/node-v24.15.0-linux-x64/bin/node --test \
  ROADMAP_V6/tests/current-roadmap-status.test.mjs
```

In un ambiente con Node 22 o successivo nel `PATH` e sufficiente usare `node`.
Il runtime non deve essere copiato dentro il pacchetto V6.

## Vincoli di attivazione

- Commerciale V2 resta `off` per default.
- Il passaggio obbligatorio e `off -> bootstrap -> shadow -> canary -> primary`.
- Il backend resta l'unica autorita sul prezzo.
- Prezzo, pagamento, stampa, fiscalita e report devono usare lo snapshot
  immutabile accettato sulla riga ordine.
- Nessun fallback silenzioso e ammesso in `primary strict`.
- La promozione richiede tutte le nove fasi `VERIFIED_COMPLETE`, progresso 100%,
  evidenza di autorizzazione e nessun blocker.

Il dettaglio operativo e le Definition of Done sono nella roadmap V6.
