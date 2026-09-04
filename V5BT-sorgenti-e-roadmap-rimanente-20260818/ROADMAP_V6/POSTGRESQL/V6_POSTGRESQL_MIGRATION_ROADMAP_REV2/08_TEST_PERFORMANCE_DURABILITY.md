# 08 — Test, performance e durabilità (REV2)

> Aggiunte rispetto alla REV1: i target valgono solo se accompagnati
> dall'hardware su cui sono stati misurati (`13_HARDWARE_CAPACITY.md`), ed è
> richiesta una re-baseline dopo il cambio di modello di concorrenza
> (`15_CONCURRENCY_MODEL.md`).

## Gate funzionali

Per ogni dominio migrato eseguire i test esistenti più nuovi test PostgreSQL. Non cancellare test legacy prima che il comportamento equivalente sia coperto.

## Crash matrix obbligatoria

- kill Node prima del COMMIT -> nessun cambiamento parziale;
- kill Node subito dopo COMMIT -> dato presente e retry idempotente;
- kill fiscal worker durante job -> job ripreso;
- kill print worker durante job -> lease/retry senza perdita;
- cache in-process disabilitata -> suite funzionale ancora verde, solo più lenta;
- riavvio del processo durante un brute force di PIN -> protezione ancora attiva;
- reboot host -> dati business coerenti;
- network timeout provider dopo settlement ambiguo -> reconciliation provider, non doppio charge;
- due pagamenti simultanei stesso bill -> uno non può causare overpayment.

## Invarianti

- nessun order_line senza order;
- nessuna allocation senza payment e target;
- nessun pagamento `SETTLED` con importo negativo;
- paid/due coerenti;
- redemption coupon non oltre limiti;
- receipt fiscale collegata a operazione valida;
- idempotency `(scope,key)` unique;
- nessun ordine storico ricalcolato con prezzo corrente.

## PostgreSQL durability

In produzione non disabilitare:

- `fsync`;
- `full_page_writes`;
- `synchronous_commit` per le transazioni finanziarie.

Configurare backup e testare il restore. Per requisiti seri, WAL archiving/PITR.

## Performance targets iniziali

**Ogni numero archiviato dichiara host, storage, versione PostgreSQL, dataset e
concorrenza.** Un p95 misurato su desktop x86 non è trasferibile su ARM64 con
storage USB e non vale come evidenza di gate.

Da validare sull'hardware reale e sul carico reale:

- GET operativi p95 < 100 ms;
- order mutation DB phase p95 < 200 ms;
- payment DB phase p95 < 250 ms;
- split complesso DB phase p95 < 350 ms;
- realtime enqueue post-commit p95 < 100 ms.

Hardware esterno escluso dal DB phase.

## Re-baseline dopo P6b

Il cambio del modello di concorrenza (`15_CONCURRENCY_MODEL.md`) invalida la
baseline precedente. Dopo P6b va rieseguita l'intera misura e confrontata con
quella di P6b.1, non con quella di P0. Gate: entro il 110% dei tempi precedenti,
oppure regressione accettata per iscritto con motivazione.

Misurare anche contesa sui row lock (`pg_locks`), attese su lock
(`log_lock_waits = on` durante il test) e frequenza di retry per
serialization/deadlock. Se i retry crescono, il pattern di locking è sbagliato,
non il tuning.

## Test di carico realistico

Il load test deve riprodurre il caso peggiore reale, non quello medio:

- 20 palmari e 5 postazioni simultanei;
- picco di servizio, non media giornaliera;
- stampa e fiscale attivi dove consentito, non simulati;
- temperatura e throttling campionati durante il test (`13_HARDWARE_CAPACITY.md`, HW-GATE-04);
- durata sufficiente a far scattare almeno un checkpoint PostgreSQL e un autovacuum.

Un load test di cinque minuti a freddo non dice niente su un dispositivo che
throttla dopo venti.

## Index review

Ogni hot query deve avere `EXPLAIN (ANALYZE, BUFFERS)` su dataset realistico. Evitare indici “a caso”: misurare orders open by table, bills by state, outbox pending, reservations time/window, catalog pricing keys, provider refs e idempotency.

## Pool

Misurare queue wait del pool. Un pool troppo grande può peggiorare PostgreSQL e il Raspberry. Il pool deve essere dimensionato sulla concorrenza reale e sul numero di processi.
