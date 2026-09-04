# 11 — Guida di esecuzione (REV2)

> Aggiunta rispetto alla REV1: non tutti i task sono adatti all'esecuzione
> assistita. La sezione "Task non delegabili" definisce quali vanno progettati a
> mano, con test scritti prima.

## Obiettivo

Implementare la migrazione totale della V6 a PostgreSQL + Redis senza cambiare comportamento business non richiesto e senza ridurre le garanzie di durabilità.

## Metodo

Lavorare **un task `MIG-*` alla volta** da `tasks/MIGRATION_TASKS.csv`.

Per ogni task:

1. leggere i moduli/test coinvolti;
2. documentare source of truth prima/dopo;
3. aggiungere migration PG;
4. implementare repository/service;
5. aggiungere test unit/e2e;
6. aggiungere reconciliation se il dominio ha dati preesistenti;
7. eseguire test pertinenti + release gate compatibile;
8. non rimuovere il fallback legacy finché il gate del dominio non è verde;
9. una volta cutover del dominio, impedire nuove scritture legacy su quel dominio;
10. aggiornare `MIGRATION_STATUS.md` con evidenze, non percentuali arbitrarie.

## Task non delegabili

I task con rischio `critico` che toccano denaro, obblighi fiscali o concorrenza
**non** vengono generati e poi verificati: vengono progettati a mano, con i test
scritti **prima** dell'implementazione, e l'assistenza si limita al codice di
supporto.

Sono:

- `MIG-021` transaction helper e retry;
- `MIG-023` outbox e claim con lease;
- `MIG-025` idempotency store;
- `MIG-047` redemption coupon anti doppia riscossione;
- tutti i task `P6b` (modello di concorrenza);
- `MIG-071`, `MIG-072`, `MIG-073`, `MIG-074` (pagamenti, provider, contanti, Glory);
- `MIG-080` (fiscale).

Motivo: sono i punti in cui un'implementazione plausibile ma sbagliata supera la
review, supera i test scritti dopo, e si manifesta come denaro mancante o come
documento fiscale duplicato. La verifica a posteriori di codice generato e piu
debole della progettazione a priori proprio dove serve di piu.

Per questi task l'ordine e: invariante scritta in italiano -> test che la viola ->
implementazione -> test verde -> test di concorrenza -> misura.

## Contesto di lavoro

Fino al completamento di P2b (`14_SERVER_DECOMPOSITION.md`), `server.js` e un
file da 1,4 MB che non entra in nessun contesto utile. Qualunque lavoro assistito
su quel file, prima di P2b, opera su una frazione arbitraria del codice.
**P2b e prerequisito anche per questo motivo.**

## Regole di sicurezza

- nessuna mutazione critica ACK prima del COMMIT;
- niente external I/O dentro tx lunghe;
- niente Redis, punto: e fuori perimetro (`ANNEX_A_FUORI_PERIMETRO.md` A.3);
- niente float per importi monetari nuovi;
- niente query full-state per rispondere a endpoint scoped;
- niente `SELECT *` su hot path senza motivazione;
- niente lock globale se è possibile row/aggregate locking;
- nessuna cancellazione di dati legacy senza backup/reconciliation.

## Regole commerciali

- non unificare semanticamente `offer`, `promotion`, `coupon/voucher` solo perché “applicano uno sconto”;
- non perdere variants/allergens/tags/routing/schedules;
- preservare pricing trace/snapshot sugli ordini;
- gli ingredienti legacy sono label, non ricette strutturate;
- non inventare quantità di ricetta.

## Commit consigliati

Commit piccoli per schema/repository/read path/write path/tests/cutover. Evitare commit monolitici che cambiano simultaneamente persistence engine, business rules e UI.
