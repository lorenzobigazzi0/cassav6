# Fase K - chiusura gate finale

Data: 2026-07-02

## Scope roadmap

Gate finale K0-K7 prima dell'apertura della Fase L.

DoD roadmap:

- K0-K7 attivi in canary su una postazione per almeno un turno operativo.
- Mini-load 25/50 con traffico misto ordini, pagamenti e fiscale contro baseline post-J.
- Nessuna regressione sui test esistenti e sui nuovi test K.

## Artefatti K verificati

- `FASE_K3_FISCAL_COMMAND_WRITE_PRIMARY_20260702.md`
- `FASE_K4_PAYMENTS_TICKET_WRITE_PRIMARY_20260702.md`
- `FASE_K5_PAYMENTS_TABLE_WRITE_PRIMARY_20260702.md`
- `FASE_K6_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY_20260702.md`
- `FASE_K7_FISCAL_RECEIPTS_WRITE_PRIMARY_20260702.md`

Flag K principali:

- `BACKEND_RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS=payments` o `RELATIONAL_SHADOW_EQUIVALENCE_DOMAINS=payments`
- `BACKEND_RELATIONAL_PAYMENTS_REPORTS_READS=1`
- `BACKEND_RELATIONAL_FISCAL_COMMAND_WRITE_PRIMARY=1`
- `BACKEND_RELATIONAL_PAYMENTS_TICKET_WRITE_PRIMARY=1`
- `BACKEND_RELATIONAL_PAYMENTS_TABLE_WRITE_PRIMARY=1`
- `BACKEND_RELATIONAL_PAYMENTS_FREE_SPLIT_WRITE_PRIMARY=1`
- `BACKEND_RELATIONAL_FISCAL_RECEIPTS_WRITE_PRIMARY=1`

## Correzione durante gate

Il primo full gate ha evidenziato 3 failure, tutte legate alla nuova migration
016:

- `relational-migration-script.test.mjs`
- `relational-shadow.test.mjs`

I test aspettavano ancora 15 migration mentre il registry relazionale contiene
correttamente la `016_fiscal_receipts_attempt_scope`.

Correzione applicata:

- `backend/tests/relational-shadow.test.mjs`
- `backend/tests/relational-migration-script.test.mjs`

Le aspettative ora derivano da `RELATIONAL_MIGRATIONS`, evitando un nuovo
hardcode del conteggio/lista versioni.

## Test eseguiti

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/relational-shadow.test.mjs backend/tests/relational-migration-script.test.mjs
```

Risultato: 59/59 pass.

Durata: 62.286 ms.

```bash
/home/sentrapa/.local/node-v24.15.0-linux-x64/bin/node --test --test-concurrency=1 backend/tests/*.mjs
```

Primo run: 973/976 pass, 3 failure migration attese obsolete.

Run finale dopo patch: 976/976 pass.

Durata run finale: 799.089 ms, circa 13m19s.

## Copertura rilevante nel full gate

- K0 equivalenza payments/fiscal.
- K1 report pagamenti/fiscale read-model relazionale.
- K2 revision CAS pagamenti.
- K3 fiscal command write-primary.
- K4 ticket banco write-primary.
- K5 pagamento tavolo write-primary.
- K6 free-split write-primary.
- K7 fiscal receipts write-primary con `attempt_scope`.
- Idempotenza pagamenti e fiscal replay.
- Fiscal boundary con RT pending.
- Automatic cash domain e gateway mock.
- Load balancer postazioni.
- Notifiche mobile/camerieri e fallback target online.
- Radio hub, echo e canali paralleli.
- Print spool TCP simulato.
- Lock tavoli, spostamenti tavolo, unione/distacco.
- Reso senza sostituzione sulla comanda corrente.
- Security/route registry/CORS/body limits.

## Esito

Gate tecnico locale: PASS.

Stato test finale: verde, 976/976.

## Residuo operativo prima di Fase L

Non e' stato eseguito in questa sessione un turno canary reale completo ne' un
mini-load live 25/50 contro baseline post-J, perche' richiedono ambiente
operativo controllato, flag canary attivi e misurazione live.

Prima di aprire Fase L in produzione:

1. Attivare K0-K7 su una sola postazione canary.
2. Eseguire un turno operativo completo senza incidenti.
3. Eseguire mini-load 25/50 misto ordini, pagamenti e fiscale usando dispositivi
   e servizi virtuali dove previsto.
4. Confrontare latenza, code e failure rate con baseline post-J.
5. Se il canary resta verde, approvare STOP/REVIEW e aprire Fase L.

## STOP/REVIEW

K e' tecnicamente pronta al passaggio di review: codice e test locali sono
verdi. La promozione a Fase L resta vincolata al canary operativo reale.
