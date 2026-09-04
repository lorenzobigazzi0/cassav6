# 09 — Cutover e rollback

## Pre-cutover GO

- tutti i task P0-P13 critici chiusi;
- backup legacy verificato;
- backup PostgreSQL verificato con restore;
- importer dry-run pulito;
- reconciliation 0 mismatch critici;
- performance gate superato;
- crash matrix superata;
- hardware fiscale/POS/Glory/stampa provato;
- rollback drill eseguito davvero.

## Cutover

1. maintenance mode;
2. bloccare nuove mutazioni;
3. snapshot/checkpoint legacy;
4. final delta import;
5. reconciliation finale;
6. switch config a PostgreSQL primary;
7. avvio API/workers/realtime;
8. smoke: login, menu, tavolo, ordine, pagamento test controllato, fiscal/print test dove consentito;
9. riaprire traffico;
10. monitorare backlog/locks/errors/latency.

## Rollback

Il rollback deve essere possibile solo finché il legacy può essere riportato a uno stato coerente senza perdere write accettati da PostgreSQL. Per questo la finestra deve essere breve e definita.

Se serve rollback dopo write reali su PostgreSQL, non basta “riaccendere MariaDB”: serve un reverse delta verificato oppure ripristinare operatività su PostgreSQL. Definire questa policy prima del GO.

## Burn-in

Durante il burn-in non cancellare ancora i backup/fonti legacy. Congelarle read-only. Solo dopo stabilità e firma del gate di decommission eseguire la rimozione fisica.
