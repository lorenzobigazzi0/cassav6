# 02 — Architettura target (REV2)

> Rispetto alla REV1, Redis esce dal diagramma di riferimento e dal percorso
> critico. I principi non negoziabili restano invariati, con due aggiunte (11 e 12).

```text
Client (cassa/palmare/postazione/settings)
            |
         HTTP/SSE
            |
          Node                <-- stateless rispetto ai dati business
       (monoprocesso oggi)
       cache in-process
            |
       PostgreSQL             <-- unica source of truth
            |
    transactional outbox
            |
     workers claim con
   lease + SKIP LOCKED
    |       |        |
 fiscal   print   realtime
                     |
                    SSE
```

Quando esistera piu di un processo Node, il fanout passa da `LISTEN/NOTIFY`
PostgreSQL (vedi `06_REALTIME_E_CACHE.md`); Redis entra solo se il fanout deve
uscire dal database (`ANNEX_B_REDIS_DESIGN_DIFFERITO.md`).

## Principi non negoziabili

1. PostgreSQL è autorevole per ogni dato business o di sicurezza.
2. Ogni stato non-PostgreSQL è ricostruibile; la sua perdita totale non comporta perdita di ordini/pagamenti/fiscale/audit. Vale per la cache in-process oggi e per Redis se e quando verrà introdotto.
3. Nessuna risposta `2xx` per una mutazione critica prima del COMMIT.
4. I/O esterni (POS, Glory, fiscale, stampanti, HTTP provider) non rimangono dentro transazioni DB lunghe.
5. Outbox, audit e idempotenza che proteggono una mutazione sono scritti nella stessa transazione del dato business.
6. Le cache vengono invalidate **dopo** il commit.
7. Lock UX (es. tavolo “in uso”) non sostituisce constraint/row lock/revision DB.
8. Importi monetari in centesimi interi (`BIGINT`) nel core finanziario.
9. IDs legacy vengono inizialmente preservati come `TEXT`: non cambiare engine DB e identity model nello stesso cutover.
10. Ordini e documenti finanziari conservano snapshot di nome/prezzo/tasse/varianti per non cambiare storicamente quando il catalogo viene modificato.

11. Nessun componente entra in produzione senza aver attraversato un gate. Un componente aggiunto "solo per la cache" o "solo temporaneamente" è un componente permanente.
12. Ogni numero di performance archiviato dichiara l'hardware su cui è stato misurato. Un p95 senza host, storage e dataset non è evidenza.

## Schemi PostgreSQL consigliati

- `app_meta`: migration e metadata tecnici.
- `identity`: utenti, ruoli, permessi, sessioni.
- `configuration`: settings e dispositivi configurati.
- `catalog`: prodotti, menu/cataloghi, varianti, allergeni.
- `inventory`: ingredienti e ricette strutturate (schema creato, **non popolato** durante la migrazione — vedi `ANNEX_A_FUORI_PERIMETRO.md` A.1).
- `commerce`: listini, offers, coupon/voucher/benefit. Le tabelle `promotions*` sono create ma **non popolate** durante la migrazione (`ANNEX_A_FUORI_PERIMETRO.md` A.2).
- `sales`: sale, tavoli, sessioni di vendita, ordini, bill.
- `payments`: pagamenti, allocazioni, provider, contanti.
- `fiscal`: documenti e operazioni fiscali.
- `reservations`: prenotazioni e cambi tavolo/sala.
- `operations`: postazioni, preparazione, stampa e device events.
- `messaging`: outbox, command inbox, idempotenza, notifiche.
- `crm`: smart customers/pass/access.
- `audit`: audit append-only.

## Connessioni

Usare `pg`/node-postgres con pool. Il numero totale di connessioni deve essere dimensionato come `workers × poolMax + workers background`, non aumentato arbitrariamente. Evitare ORM che nasconda locking/transaction semantics nei domini finanziari; un query builder è accettabile, SQL esplicito nei repository è preferibile per hot path e transazioni critiche.
