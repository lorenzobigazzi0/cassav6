# B7 - Canale affidabile

## Stato

Baseline software `PASS_OFFLINE` su Node e su entrambe le app Android, senza
blocker residui. Le suite sono `NON_GATE_EVIDENCE`; la validazione fisica
dipende da B6 e resta aperta.

## Contratto V1

Il canale affidabile implementa:

- header e tipi frame v1;
- `messageId` canonico e binding della sessione;
- frammentazione con indice/conteggio e fallback MTU;
- AES-256-GCM con chiavi separate per direzione;
- ACK e stato di completamento per messaggio;
- retry con backoff esponenziale e jitter;
- deduplica persistente per peer e `messageId`;
- TTL, limite payload e codici di close/error;
- consegna at-least-once sul link con effetto once dopo deduplica.

I frame route e shadow condividono lo stesso trasporto affidabile, ma il
router B10 rifiuta i frame business.

## DATA E ACK GATT

Il binding GATT usa una matrice esplicita:

| Direzione logica | Endpoint GATT |
| --- | --- |
| client verso server | write request su `DATA_RX` |
| server verso client, DATA | notify su `DATA_TX` |
| server verso client, ACK | indicate su `ACK_TX` |

Il bridge verifica che tipo frame, characteristic e ruolo coincidano. Una
callback errata, subscription assente o publisher non pronto produce un
errore fail-closed. Teardown e reconnect azzerano il data plane prima di
accettare un nuovo contesto.

DATA, ACK e i relativi CCCD condividono una deadline di setup. Timeout o
callback stale impediscono `port-ready`. Se restore o tick falliscono, la
lease attiva viene revocata e il teardown e fatale; se lo scheduler rifiuta il
task, il runtime non puo dichiararsi `RUNNING`.

## Lifecycle E Segreti

`close()` attende la coda affidabile, impedisce nuovi invii e libera timer e
payload. Gli errori durante ACK, publish o restore non devono lasciare copie
del plaintext o chiavi utilizzabili. Il contesto affidabile e legato al
`peerTrustId` prodotto dalla sessione autenticata.

## Verifica Richiesta

La matrice software finale copre in entrambe le app:

- DATA in entrambe le direzioni e ACK correlato;
- frammentazione su MTU ridotta;
- timeout, retry e duplicato;
- close mentre la coda e attiva;
- callback fallita e cleanup;
- reconnect sullo stesso peer e su un peer differente.

Esito corrente Android: Palmare debug e Postazione debug chiudono entrambi 59
classi e `340/340 PASS`, zero failure, errori o skip, inclusi compile Kotlin e
controllo del core condiviso.

La successiva prova fisica deve ripetere queste condizioni su GATT reale. Un
PASS di codec o simulazione non promuove B7 e non cambia il 49% ufficiale.
