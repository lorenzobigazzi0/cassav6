# MIG-026 - retention e partizionamento append-only

Data: 2026-08-31

## Stato della decisione RET-01

La roadmap propone finestre di retention, ma `12_OPEN_DECISIONS.md` ordina di
non applicarle prima della conferma RET-01. La scelta ha effetti distruttivi e
puo coinvolgere requisiti operativi o legali non derivabili dal codice.

Questo sotto-step realizza il control plane DEV non distruttivo e lascia MIG-026
`IN_PROGRESS` finche RET-01 non viene approvata. Il partizionamento audit e
stato applicato al DEV, ma nessun job automatico e nessuna cancellazione sono
attivi.

## Problemi rilevati nel draft REV2

1. `retention_days` usa `CHECK(retention_days > 0)`, ma le cinque policy
   legalmente protette inseriscono il valore `0`: il file non e applicabile.
2. Le policy proposte sono inserite senza stato di approvazione o enablement.
3. Le funzioni accettano giorni arbitrari dal chiamante invece di leggere la
   policy approvata.
4. Le funzioni hanno implicitamente `EXECUTE` per `PUBLIC` e non dichiarano un
   confine owner-only.
5. Il `DELETE` non usa batch ordinati con `SKIP LOCKED`.
6. Il partizionamento mensile di `audit.events` non e direttamente compatibile
   con la primary key globale `id`: PostgreSQL richiede che ogni vincolo unique
   di una tabella partizionata includa la chiave di partizione.
7. Convertire ora audit/outbox/idempotency senza risolvere l'identita globale
   indebolirebbe invarianti gia protette da MIG-023/024/025.

## Source of truth e confini

- `app_meta.retention_policies` conserva proposte e approvazioni;
- tutte le proposte operative nascono `enabled=false` e
  `decision_ref='RET-01:TODO'`;
- pagamenti, movimenti di cassa e fiscale sono `legally_required=true`, senza
  finestra e con strategia `none` non attivabile;
- il ruolo runtime dispone soltanto di letture su policy e viste;
- le funzioni purge sono owner-only, `SECURITY DEFINER`, con search path fisso e
  rifiutano policy disabilitate;
- `backend/db/postgresql/retention.repository.js` espone soltanto osservabilita;
- nessuna route o scheduler runtime viene aggiunto.

## Invarianti progettate prima del codice

1. RET-01 non approvata implica zero cancellazioni possibili tramite le funzioni.
2. Una policy si abilita solo con `approved_at` e decision reference non `TODO`.
3. Target `payments.*` e `fiscal.*` possono essere soltanto protetti,
   `strategy=none`, senza retention e disabilitati.
4. Le righe protette non possono essere modificate o eliminate nemmeno per
   errore da un owner ordinario.
5. Runtime: `SELECT` sulle viste, nessun `INSERT/UPDATE/DELETE` sulle policy e
   nessun `EXECUTE` sulle funzioni purge.
6. Purge outbox: soltanto righe processate oltre la finestra approvata.
7. Purge idempotency: soltanto terminali oltre `expires_at` piu il grace period
   approvato; mai record `processing`.
8. Batch bounded 1..10000, ordinati e claimati con `FOR UPDATE SKIP LOCKED`.
9. Dry-run e il default e non modifica righe.
10. Audit resta append-only e partizionato; `audit.event_ids` preserva
    l'unicita globale degli ID anche quando in futuro saranno eliminate
    partizioni approvate da RET-01.
11. `v_table_growth` espone byte/righe/dead tuple senza introdurre un secondo
    source of truth.
12. Nessun pagamento, movimento di cassa o documento/operazione fiscale compare
    in una query `DELETE`.

## Policy proposte, non attive

- audit: 1095 giorni, futura partizione mensile;
- order events: 730 giorni, futura partizione mensile;
- fulfillment: 365 giorni, futura partizione mensile;
- device status: 90 giorni, futura partizione mensile;
- print attempts: 180 giorni, purge batch;
- outbox processata: 30 giorni, purge batch;
- print job completati: 90 giorni, purge batch;
- idempotency: 30 giorni di grace dopo `expires_at`, purge batch;
- pagamenti, provider, cassa e fiscale: nessuna retention.

## Strategia test-first

1. test del repository read-only e mapping delle viste;
2. test statico di policy, privilegi, trigger e funzioni owner-only;
3. smoke reale con policy tutte disabilitate sul database temporaneo;
4. prova owner su database temporaneo: dry-run, batch, righe protette e guard;
5. applicazione idempotente al DEV principale solo del control plane disabilitato;
6. verifica che le tabelle foundation e i servizi restino invariati.

Lo sviluppo resta interamente su microSD. SSD e cutover produzione non sono
prerequisiti per questo control plane.

## Implementazione

- aggiunta la migration `005_retention_control_plane`;
- create 13 policy: 8 proposte disabilitate e 5 legalmente protette;
- aggiunto il trigger che rende immutabili le policy protette;
- aggiunte `app_meta.v_table_growth` e
  `app_meta.v_retention_candidates`;
- aggiunte purge owner-only per outbox processata e idempotency terminale, con
  dry-run di default e guard RET-01;
- aggiunto repository PostgreSQL esclusivamente read-only;
- aggiunti smoke Raspberry, wrapper DEV e verifica post-condizioni.
- aggiunta la migration `006_audit_events_partitioned_retention`: partizioni
  mensili, partizione default e registro append-only globale `audit.event_ids`.

La fase rossa test-first ha prodotto 0 test superati su 5. Dopo
l'implementazione la suite mirata e passata 5/5 e la suite completa MIG-026
17/17.

## Verifica reale Raspberry/microSD

Lo smoke e stato eseguito su Raspberry `aarch64`, PostgreSQL 17.11 e filesystem
`ext4` sul device `/dev/mmcblk0p2`, usando il database temporaneo
`cassav6_mig026_20260831a`:

- 13 policy caricate, 8 proposte, 5 protette, 0 abilitate;
- viste crescita/candidati interrogabili dal runtime;
- runtime: policy `SELECT=true`, `UPDATE=false`, viste `SELECT=true`, funzioni
  purge `EXECUTE=false`;
- tentativi runtime di modifica/esecuzione rifiutati con `42501`;
- owner con policy disabilitata rifiutato con `55000`;
- modifica owner di una policy legalmente protetta rifiutata con `55000`;
- nel solo database temporaneo, due policy abilitate con decision reference di
  smoke: dry-run 1, cancellazione 1, seconda passata 0 per outbox e idempotency;
- due righe recenti/non terminali per dominio sono state preservate;
- policy ripristinate a `RET-01:TODO`, dati di prova rimossi e 0 candidati
  residui;
- durata totale smoke: 54,66 ms.

## Applicazione al database DEV

La migration `005` e stata applicata una volta a `cassav6` e saltata alla
seconda esecuzione. Checksum registry:

`cfca4fecc4556d33d78404b18e025c2681fe71520bcab74c33aef7e5864963d2`

Post-condizioni: 13 policy, 0 abilitate, 5 protette, 8 `RET-01:TODO`; entrambe
le viste e il trigger risultano attivi; il runtime non puo eseguire le purge;
le quattro tabelle foundation sono vuote e i servizi PostgreSQL/Cassa attivi.

Gate finali locali:

- suite MIG-026: 17/17;
- policy route: 144/144;
- repository boundary: 341 file runtime, 47 handler, 67 owner persistence e 0
  violazioni;
- audit architettura/sicurezza: 0 finding bloccanti;
- gate architettura/sicurezza, check backend e preflight sorgente: superati.

I nove warning sul monolite `backend/server.js` restano debito architetturale
gia noto.

Evidenza machine-readable:

- `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig026/raspberry-dev-sd-20260831.json`;
- SHA-256 `e6be10c6d9d6f2c047defa22764b046815f8e1b708fef332373b4b9a4a3ccc34`.

## Applicazione migration 006 al Raspberry DEV

Il 2026-09-01 la migration `006_audit_events_partitioned_retention` e stata
applicata al database `cassav6` sul Raspberry, interamente su microSD
`/dev/mmcblk0p2` (`ext4`). Prima della DDL sono stati verificati 0 eventi, creati
un backup logico fresco con restore di prova e un clone database a servizio
fermo.

Verifiche concluse:

- pacchetto staging SHA-256
  `460dc38fd8343f49e4c56e06791800ddc320ab89d9b96ed9b7ae31cfb3fb5617`;
- prova su database temporaneo: 6 migration applicate, seconda passata 6/6
  skipped, esercizio runtime e retention verdi;
- backup logico SHA-256
  `5eadd04bbbe0411b59a1a67dc40e643ada383bd2c5e40a8c0348eee26a81c1b2`,
  restore isolato riuscito in 767 ms con `audit.events = 0`;
- applicazione reale: prima passata 1 applied/5 skipped, seconda passata
  0 applied/6 skipped;
- registry `001`..`006` con checksum 006
  `62ef451f235fdba7c44cdc29f577a71e4234f4c6897f52fc5c15ec01c27218ad`;
- `audit.events` relkind `p`, 16 partizioni foglia, partizione default presente,
  `audit.events = 0` e `audit.event_ids = 0`;
- runtime con `SELECT`/`INSERT` su audit, senza
  `UPDATE`/`DELETE`/`TRUNCATE` e senza esecuzione della manutenzione partizioni;
- policy `audit.events`: `drop_partition`, 1095 giorni, `enabled=false`,
  `RET-01:TODO`;
- PostgreSQL e Cassa attivi; health HTTPS 5380 e HTTP 5381 entrambe 200.

Durante la prima finestra un errore nel solo harness post-check ha attivato il
rollback automatico. Il clone e stato ripristinato e verificato a 5 migration,
tabella non partizionata e 0 righe; la Cassa e tornata 200/200. La finestra e
stata quindi ripetuta con harness corretto e tutti i gate sono passati. Restano
conservati backup, database migrato in quarantena e clone finale
`cassav6_rollback_mig006_20260901h`.

Evidenza aggiornata:

- `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/mig026/raspberry-dev-sd-partitioned-20260901.json`;
- SHA-256 `91838c7cf3b84ad4d7c34f9b9464182f8ed0d7e0be85ead162b6d3f785f54096`.

## Decisione e lavoro rimanente

Aggiornamento 2026-09-01: la migration
`006_audit_events_partitioned_retention` risolve il vincolo strutturale di
`audit.events` mentre la tabella e ancora vuota. Usa partizioni mensili, una
partizione default e `audit.event_ids` come registro append-only per
l'unicita globale. La conversione e fail-closed: con una sola riga esistente
si ferma con SQLSTATE `55000` e richiede un piano dati esplicito. La suite
locale audit/retention/foundation/runner e verde 21/21.

L'applicazione al Raspberry DEV e completata e verificata. Il database resta
classificato `DEV_ONLY`: backup e clone risiedono sulla stessa microSD e non
proteggono da un guasto fisico del supporto. L'SSD non e un prerequisito per lo
sviluppo, ma storage indipendente e capacity gate rimangono necessari prima del
cutover produzione.

Il control plane DEV e completo e fail-closed. MIG-026 resta `IN_PROGRESS`, non
`DONE`, perche la Definition of Done richiede RET-01 chiusa e policy applicate.
Prima dell'attivazione serve ancora la conferma delle finestre proposte:

1. finestre proposte accettate o corrette.

Fino ad allora non esiste alcun job automatico e nessun dato viene cancellato.
