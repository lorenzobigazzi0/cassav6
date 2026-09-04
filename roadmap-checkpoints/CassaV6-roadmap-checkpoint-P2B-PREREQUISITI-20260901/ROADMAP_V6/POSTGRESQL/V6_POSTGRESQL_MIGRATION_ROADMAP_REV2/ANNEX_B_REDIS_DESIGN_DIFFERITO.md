# Annex B — Redis design (DIFFERITO)

> **Stato: fuori perimetro della migrazione.** Vedi `ANNEX_A_FUORI_PERIMETRO.md`
> sezione A.3 per la motivazione e per i trigger di ripresa. Il contenuto sotto
> resta valido come target per quando esistera piu di un processo Node in
> produzione. Nel frattempo la soluzione adottata e in `06_REALTIME_E_CACHE.md`.

---

## Design originale (conservato)

## Cosa può stare in Redis

- cache catalogo/menu/listino compilato;
- presence di device/postazioni/utenti online;
- heartbeat;
- pub/sub realtime fra processi;
- rate limit distribuito;
- cache di lookup sessione, mantenendo PG autorevole;
- hint/fast-path di lock UX, se PostgreSQL resta l'autorità.

## Cosa NON deve stare solo in Redis

- ordini;
- linee ordine;
- bill;
- pagamenti;
- allocazioni;
- saldo coupon/voucher;
- documenti fiscali;
- audit;
- idempotency result definitivo;
- print/fiscal jobs durabili;
- configurazioni necessarie al reboot.

## Key namespace

```text
cassav6:{env}:cache:catalog:{version}
cassav6:{env}:cache:pricing:{version}:{contextHash}
cassav6:{env}:presence:device:{uuid}
cassav6:{env}:presence:station:{stationId}
cassav6:{env}:session:{tokenHash}
cassav6:{env}:ratelimit:login:{ip}
cassav6:{env}:ratelimit:pin:{userId}
cassav6:{env}:pubsub:realtime
```

Tutte le cache/presence hanno TTL. Usare versioned cache keys invece di invalidazioni massive quando possibile.

## Failover policy

- cache GET fallisce -> query PostgreSQL;
- cache SET fallisce -> log/metric, risposta business continua;
- presence fallisce -> UI degradata, non perdita dati;
- pub/sub fallisce -> gli eventi restano nell'outbox e il client recupera via refresh/resync;
- Redis down durante login/PIN -> fallback locale **con policy conservativa** o fail-closed sulle operazioni sensibili, non rate limit illimitato.

## Persistenza Redis

Poiché non contiene source of truth, non è necessario usare Redis AOF come garanzia dei dati business. La scelta AOF/RDB può essere operativa, ma il design deve superare `FLUSHALL` senza perdita business.

## Client

La V6 ha già un client RESP custom. Per il target multiprocess preferire una libreria mantenuta (`redis` ufficiale o `ioredis`) salvo ragioni documentate per mantenere il client custom. TLS/ACL e reconnect/backoff devono essere testati.
