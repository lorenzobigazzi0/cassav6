# Fase P3.16 - Sweep prenotazioni

Data: 2026-07-08
Target: Raspberry `192.168.0.67`
Servizi: backend owner `5281`, api worker `5283/5284`, frontend HTTPS `5280`
I/O reale: disattivato (`PRINTING_ENABLED=0`, fiscale worker off, cassa automatica off)

## Obiettivo

Applicare il playbook `PLAYBOOK_DOMAIN_WRITE_AUDIT.md` al dominio prenotazioni
prima di aprire P4/load-100, verificando:

- latenza dei flussi `create/list/availability/lock/update/status/delete`;
- costo `reservationLane`;
- costo `reservations.*.appStateWrite`;
- assenza di errori funzionali sotto mini-load 25 device.

## Implementazione

Aggiunto:

- `scripts/reservations-write-audit-canary.mjs`

Il canary crea 25 sessioni mobile, genera lifecycle completi di prenotazione,
misura runtime metrics, produce `result.json` e `REPORT.md`, e usa finestre
temporali derivate dal `runId` per non autocontaminare i rerun.

## Evidenza iniziale

Run shadow pulito: `reservations_write_audit_p3_16_r3_20260708`

- esito funzionale: 225/225 richieste OK;
- durata: 102.896 ms;
- `reservation.create` p95: 5.900 ms;
- `reservation.delete` p95: 7.017 ms;
- `reservationLane` p95: bucket 10.000 ms;
- `reservations.*.appStateWrite` p95: bucket 1.000 ms;
- `writeDbFullStateFallback`: presente su tutto il dominio, coerente col profilo `shadow`.

Tentativo solo tuning lane a 4: `reservations_write_audit_p3_16_r4_20260708`

- non sufficiente;
- durata: 103.511 ms;
- `reservation.status.cancelled` p95: 11.115 ms;
- conclusione: aumentare la concorrenza senza togliere il full-state peggiora la contesa.

## Fix operativo

Portato il target e il profilo deploy a:

```env
APP_STATE_DIRTY_TRACKING=write
APP_STATE_DIRTY_TRACKING_MODE=write
RESERVATION_LANE_CONCURRENCY=4
```

Motivo: `write` usa il fast-path dei domini esternalizzati senza attivare il blocco
`enforce`. Il rollback resta una singola variabile: tornare a
`APP_STATE_DIRTY_TRACKING_MODE=shadow`.

## Verifica finale

Run finale: `reservations_write_audit_p3_16_r6_write_20260708`

- verdetto: PASS;
- durata: 38.561 ms;
- errori HTTP: 0;
- `writeDbDirtyExternalized`: 225;
- `writeDbFullStateFallback`: 0;
- `reservation.create` p95: 3.337 ms;
- `reservation.update` p95: 3.809 ms;
- `reservation.status.cancelled` p95: 3.883 ms;
- `reservation.delete` p95: 3.142 ms;
- `reservationLane` p95: bucket 5.000 ms, con max reali sotto 3.5 s;
- `reservations.*.appStateWrite` p95: bucket 1.000 ms, max 633 ms.

## Note residue

Il dirty tracking continua a riportare missing labels su alcuni path
(`reservations.create`, `reservations.lock`, `reservations.update`), ma in
modalita `write` non blocca e il run funzionale resta coerente. Questi mismatch
sono da trattare prima di un eventuale passaggio futuro a `enforce`, non bloccano
P4.

## Stato

Dominio prenotazioni chiuso per P3.16: Passo 1-2 eseguiti, fix operativo
applicato, Passo 4 verificato con canary PASS.
