# B9 - Route advertisement e server reachability

## Stato

Publisher, codec, ingress, persistenza e advertiser Raspberry hanno verdetto
software `PASS_OFFLINE`: Node `286/286`, Palmare debug e Postazione debug
entrambi 59 classi e `340/340 PASS`, zero failure, errori o skip. La fase
resta osservativa e `NON_GATE_EVIDENCE` finche non viene eseguita sul data
plane fisico certificato.

## Payload

Ogni nodo puo comunicare:

```text
canReachServer
routeKind: WIFI/LAN/BLE_DIRECT/NONE
serverRttBucket
routeAge
queueDepthBucket
batteryBucket
sequence
```

Il publisher mantiene una sequenza monotona persistente nello store schema
`3`. L'ingress conserva l'ultimo valore valido per peer e rifiuta replay,
sequenze regressive, valori fuori range, clock regressivo ed eta non canonica.

Il wire path publisher/sequence/replay/ingress/store/cadence e completo. Sul
Raspberry il provider e dinamico: il runtime interroga l'endpoint health
loopback canonico. Il ServiceData BlueZ v1 conserva il payload discovery e
riceve soltanto il bit `serverReachable`; route `LAN/NONE`, fascia RTT, eta,
queue depth e batteria `UNKNOWN` restano in `RouteAdvertisementV1` sul canale
affidabile. Batteria e UPS Raspberry non sono campionati.

Health assente, stale o regressivo forza `serverReachable=false`. Il budget
operativo end-to-end e `<=4750 ms`, comprensivo di scheduling, timeout probe e
sostituzione D-Bus, entro la SLA fail-closed di 5 s. Una configurazione che
supera il budget viene rifiutata.

L'advertiser mantiene in storage privato la chiave alias (`0600`, parent
`0700`, no symlink/hardlink), ruota l'alias ogni 60 s e usa un `bootId` non
nullo distinto dall'avvio precedente e condiviso con HELLO. La sequenza
discovery avanza modulo 256 soltanto ai cambi semantici. Register/unregister
D-Bus hanno deadline e perdita del proprietario BlueZ, recupero e cleanup
sono gestiti fail-closed. `CASSA_BT_ROUTE_ADVERTISEMENT_ENABLED` resta OFF per
default.

## Limite Del Routing

Questi dati servono a osservare la raggiungibilita e preparare scelte future.
Non esiste inoltro multi-hop, elezione di bridge business o load balancing.
Un nodo non invia comande per conto di un altro nodo in B9.

## Verifica

I golden Node/Kotlin assicurano parita del formato. Store e runtime coprono
sequenza dopo restart, aggiornamento, duplicato, replay e ordine inverso. I
test Node coprono inoltre rotazione alias/boot, wrap `254 -> 255 -> 0 -> 1`,
freshness health, timeout e recovery BlueZ. B11 esercita una route per
ciascuno dei 10 nodi sintetici e verifica il rifiuto del multi-hop.

Il watchdog advertiser Postazione `api31Compat` chiude `7/7 PASS` come test
mirato della deadline. Non costituisce una suite full della variante.

La prova fisica dovra osservare advertise, perdita route, recupero, restart e
persistenza su peer reali e confermare il budget temporale. Questo giro non ha
usato Raspberry, radio, UPS o batteria reali. Fino ad allora B9 non riceve un
PASS formale e la roadmap resta al 49%.
