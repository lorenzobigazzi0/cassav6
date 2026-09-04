# B8 - Durabilita locale minima

## Stato

Store Node e Android allineati allo schema `3`, con verdetto software
`PASS_OFFLINE` e nessun blocker residuo. La conferma Android e inclusa nelle
due matrici full `340/340 PASS`; il gate fisico resta dipendente dalla
sessione diretta certificata.

## Dati Persistenti

Il contratto comprende:

```text
bluetooth_outbox
bluetooth_inbox_dedup
known_peers
session_history
last_server_advertisement
route publisher sequence
```

Un messaggio `durable=true` puo essere confermato alla GUI soltanto dopo il
commit locale. Lo store applica transazioni e limiti canonici e conserva le
informazioni minime necessarie al recovery.

## Binding Al Peer

Outbox, ACK e inbox dedup sono indicizzati anche dal `peerTrustId`. Al
reconnect il runtime puo ripristinare soltanto record appartenenti al peer
autenticato corrente. Il caso A invia, cade la sessione e si collega B non puo
consegnare a B la coda di A.

La migrazione da schema `2` a schema `3`:

- aggiunge il binding al peer e la sequenza route;
- accetta uno store vuoto o dati attribuibili in modo canonico;
- rifiuta righe affidabili legacy che non possono essere assegnate a un peer;
- non cancella o rietichetta silenziosamente dati ambigui.

## Recovery E Monotonicita

La suite copre commit, restore, ACK, dedup, reconnect, rollback, migrazione e
isolamento A-verso-B. La sequenza route viene aggiornata nella stessa
transazione logica e non puo regredire. Clock o schema non validi lasciano il
runtime bloccato.

## Criterio Fisico

La prova reale deve interrompere e ristabilire una sessione, osservare il
restore sul peer corretto, verificare che un secondo peer non riceva la coda e
confermare cleanup e store integro dopo restart processo. Fino a quella
cattura B8 resta software non-gate e l'avanzamento ufficiale resta 49%.
