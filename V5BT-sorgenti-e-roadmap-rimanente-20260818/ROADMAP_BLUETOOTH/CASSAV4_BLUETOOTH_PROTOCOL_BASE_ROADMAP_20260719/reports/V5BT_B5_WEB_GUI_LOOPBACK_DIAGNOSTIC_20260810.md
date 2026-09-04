# V5BT B5.7 - Rehearsal Web GUI Loopback Non-Gate

Data: 2026-08-10

## Risultato

Il rehearsal e stato eseguito su uno degli otto Palmare Chrome autenticati del
banco grafico isolato:

- verdetto: `NON_GATE_PASS`;
- trasporto: `LOOPBACK_HTTP_SIMULATION`;
- stato `ACTIVE`: raggiunto;
- `PING/PONG`: `4/4`;
- `CLOSE_ACK`: `1`;
- errori: `0`;
- connessioni e timer dopo cleanup: `0/0`;
- sessione grafica autenticata: preservata;
- sessioni ufficiali B5 registrate: `0`;
- accessi ADB, SSH, Bluetooth, GATT, Raspberry e UPS: nessuno.

Il primo tentativo di implementazione con trasporto WebSocket e terminato
`NON_GATE_FAIL` per timeout. Il risultato e stato conservato privatamente e
non sovrascritto. Il successivo run, separato e basato sulla macchina a stati
HTTP loopback, ha prodotto il PASS sopra riportato.

## Verifica Sintetica Separata

Sono stati rieseguiti con successo i quattro self-test canonici B5:

- direct-control smoke: `PASS`;
- collector da cento sessioni sintetiche: `PASS`;
- supervisor con cento commit sintetici: `PASS`;
- gate tecnico da cento sessioni sintetiche: `PASS`.

Questi self-test verificano i contratti software senza radio fisica. Non sono
correlati al traffico del browser e non producono evidenze, state o promozioni
ufficiali. Le suite del rehearsal e del launcher chiudono `19/19 PASS`.

## Integrita E Gate

Il ledger fisico e rimasto byte-identico, regolare `0600`, con un solo link e
due record. Il banco resta `ACTIVE` con `8/8` Palmare web. Runtime, richieste,
risultati e screenshot sono privati; il supervisor applica `umask 0077`.

Il rehearsal ha impatto gate `NONE`: B4 resta `PENDING` a `2/10`, B5 resta
`PENDING` a `0/100`, B6 resta `BLOCKED`. Il pilot fisico B5.7 e la campagna
ufficiale non sono autorizzati.

Avanzamento roadmap complessiva: **49%**
