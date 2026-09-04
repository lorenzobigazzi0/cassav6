# 06 — Realtime, cache e presence senza Redis

Sostituisce il capitolo Redis della REV1, ora in `ANNEX_B_REDIS_DESIGN_DIFFERITO.md`.

## Premessa

Il profilo standard e monoprocesso (`BACKEND_API_WORKER_ENABLED=0`,
`BACKEND_REALTIME_GATEWAY_ENABLED=0`), su un dispositivo con memoria limitata,
con 20 palmari e 5 postazioni. La domanda a cui Redis risponde — coordinare cache,
pub/sub e presence **fra processi** — oggi non si pone.

Il principio non cambia: **PostgreSQL e l'unica source of truth, tutto il resto e
ricostruibile.** Cambia solo dove sta il "resto".

## Cache

### Dove

In-process, `Map` o LRU, dentro il processo Node.

### Chiavi versionate

Stessa regola del design Redis: non invalidare in massa, versionare.

```text
catalog:compiled:{publishedVersionId}
pricing:{publishedVersionId}:{contextHash}
```

Quando `commerce.config_state.published_version_id` cambia, la vecchia chiave
smette semplicemente di essere richiesta e scade. Nessuna invalidazione
esplicita da coordinare.

### Regola invariata

**Le cache si invalidano dopo il COMMIT, mai prima.** Principio 6 del doc 02.

### Fallback

Cache miss o cache corrotta significa query a PostgreSQL. La cache non e mai una
condizione di correttezza, solo di latenza. Deve essere possibile disattivarla con
un flag e vedere il sistema funzionare piu lentamente, non diversamente.

**Test di gate**: suite funzionale verde con cache disabilitata.

## Fanout realtime

### Oggi

SSE dal processo API ai client. Nessun fanout inter-processo necessario.

### Durabilita

Invariata rispetto alla REV1 e non negoziabile: **l'evento che deve innescare
fiscale, stampa o realtime viene inserito nello stesso COMMIT della mutazione
business** (`messaging.event_outbox`). Il fanout e best effort; l'outbox e la
garanzia.

Se il client perde un evento, recupera con refresh/resync. Se il processo muore,
l'outbox e ancora li.

### Quando servira piu di un processo

`LISTEN` / `NOTIFY` di PostgreSQL prima di Redis:

```sql
-- dopo il commit dell'outbox
NOTIFY cassav6_realtime, '{"aggregate":"order","id":"..."}';
```

Vincoli da rispettare se si adotta:

- il payload di `NOTIFY` ha un limite (8000 byte): trasportare **riferimenti**,
  non stato; il consumatore rilegge da PostgreSQL;
- `NOTIFY` e transazionale: viene consegnato al COMMIT, il che e esattamente il
  comportamento voluto;
- la connessione in `LISTEN` e dedicata e non torna nel pool;
- se nessuno ascolta, il messaggio si perde: e accettabile solo perche l'outbox
  resta la fonte durabile.

Questo copre il fanout fra processi sullo stesso PostgreSQL senza aggiungere un
daemon. Redis diventa giustificato quando il fanout deve uscire dal database, non
prima.

## Presence e heartbeat

### Dove

In memoria nel processo, con TTL, come oggi.

### Regola

La presence e **derivata e ricostruibile**. La perdita totale della presence
comporta UI degradata per il tempo del prossimo heartbeat, mai perdita di dati
business.

### Cosa deve invece stare in PostgreSQL

- la **configurazione** dei device, postazioni, stampanti, terminali: durabile;
- gli **eventi** di stato device che hanno valore storico
  (`operations.device_status_events`): durabili, con retention (vedi
  `postgres/060_retention_partitioning.sql`);
- lo **stato di business** della postazione (attiva/in pausa se determina il
  routing degli ordini): durabile in `operations.station_states`.

Il discrimine e: se dopo un reboot il valore deve essere ancora vero, sta in
PostgreSQL. Se dopo un reboot va semplicemente riacquisito, sta in memoria.

## Rate limiting

### Dove

In-process, per IP e per utente.

### Regola di sicurezza invariata

`MIG-093` della REV1 diceva la cosa giusta e resta valida in questa forma: la
perdita del backend di rate limiting **non deve rendere illimitati** login e
verifica PIN. In-process il problema si semplifica, perche il contatore vive
quanto il processo, ma la regola resta:

- riavvio del processo non deve azzerare la protezione contro brute force in
  corso: il conteggio dei tentativi falliti per utente va persistito in
  PostgreSQL (`identity.users` o tabella dedicata), non solo in memoria;
- il contatore volatile per IP e un'ottimizzazione, non la protezione.

**Test di gate**: tentativi ripetuti di PIN errato, riavvio del processo a meta,
la protezione resta attiva.

## Cosa non deve succedere

Non introdurre Redis "solo per la cache" durante la migrazione. Diventa una
dipendenza di produzione senza aver mai attraversato un gate, e il decommission
del doc 10 si trova un componente in piu da giustificare invece che da rimuovere.
