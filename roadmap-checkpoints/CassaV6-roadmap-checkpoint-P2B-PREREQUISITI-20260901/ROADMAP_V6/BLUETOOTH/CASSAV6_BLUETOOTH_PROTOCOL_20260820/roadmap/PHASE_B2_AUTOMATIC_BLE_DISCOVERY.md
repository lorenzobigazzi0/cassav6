# B2 — Discovery BLE automatica

Ogni nodo FULL_NODE esegue scan e advertise a finestre.

## Advertisement compatto

```text
Service Data 128-bit UUID, senza lista UUID duplicata
protocol version: 3 bit
node kind: 2 bit
rotating alias: 48 bit
boot id short: 8 bit
capability bitmap: 7 bit + 1 bit riservato
server reachability flag: 1 bit
advertisement sequence: 8 bit
```

Il payload e sempre di 10 byte; con Flags e overhead Service Data l'AdvData
primario occupa esattamente 31 byte. AdvData non indica l'intera PDU Link Layer.
Lo scan response non e richiesto. Il formato normativo e in
`architecture/DISCOVERY_PROTOCOL.md`.

## Policy

- scan aggressivo solo durante failover/discovery;
- scan lento in stato stabile;
- nessun loop continuo;
- advertisement update rate limitato;
- peer expiry soft-state.

## Core shared V6

Il core offline di riferimento e in `shared/discovery/` e riceve il payload
Service Data da 10 byte gia estratto dall'adapter. Usa obbligatoriamente il
decoder B1 condiviso.

La directory usa come chiave solo `(rotatingAlias, bootId)`. Un advertisement
non prova mai NodeId, identita stabile, autenticazione o autorizzazione.
Alias/boot diversi sono stream indipendenti e possono coesistere.

Le regole normative sono:

```text
RSSI minimo                       -88 dBm, incluso
fresh                             age < 5000 ms
aging                             5000 <= age <= 15000 ms
expired                           age > 15000 ms
capacita                          massimo 1024 stream
pruning globale                  al massimo ogni 1000 ms
tentativi nuovi stream anonimi   massimo 2048 ogni 10000 ms, scarti inclusi
sostituzione sotto pressione     aging oppure nuovo RSSI >= vecchio + 6 dB
duplicato identico                refresh lastSeen e RSSI
stessa sequenza, semantica diversa conflitto senza refresh
newer                             sostituisce e aggiorna lastSeen/RSSI
older o ambiguous                 scarto senza refresh
```

Il clock deve essere monotono e iniettabile. Prima di rifiutare un nuovo stream
per capacita vengono rimossi gli stream scaduti. I limiti di churn e la
sostituzione controllata contengono il consumo locale pre-auth, senza attribuire
all'advertisement anonimo alcuna proprieta anti-DoS o di autenticazione.

La policy finestre v1 e:

```text
stable                            3000 ms ogni 30000 ms
failover                          8000 ms ogni 10000 ms
```

La finestra deve essere sempre piu corta del periodo. Il passaggio a failover
apre immediatamente una nuova finestra; l'integrazione di piattaforma deve
tradurre le decisioni pure in start/stop senza scan continuo. Se una callback
ritardata attraversa un intero intervallo di stop, il core emette `restart` e
l'adapter deve eseguire stop seguito da start.

## Stato gate

Il core shared, i test delle soglie e la simulazione deterministica offline da
100 cicli costituiscono evidenza locale. Il gate B2 di discovery reciproca p95
entro 8 secondi resta `PENDING` fino alla misura su dispositivi fisici
certificati. Le feature Bluetooth restano `OFF` per default.

I due target fisici sono vincolati alla baseline condivisa
`configs/advanced-certification-targets.json`. Il gate verifica package,
versione e SHA-256 del singolo APK installato e fallisce prima della misura se
la matrice o l'artefatto non corrispondono.
