# V5BT - test fisici del 2026-08-17

## Perimetro

La sessione ha usato due Palmare Advanced API 36 con build Lab certificata
`1.0.39` code `40`, una Postazione API 31 con variante affiancata
`api31Compat` non-gate e il Raspberry V5BT operativo. Nessun package e stato
disinstallato, nessun dato applicativo e stato cancellato e nessuna identita e
stata rigenerata.

Le prove con due Palmare sono sempre `NON_GATE_EVIDENCE`: non sostituiscono la
coppia formale Palmare/Postazione e non promuovono B0 o B2.

## Inventario e ripristino

- Entrambi i Palmare risultano con APK, versione, firma, permessi e Android
  user conformi; sessione autenticata, identita distinta, enrollment `READY` e
  binding registry verificato.
- Dopo ogni prova le due app sono state rilanciate. Il controllo finale le
  trova non stopped, con sessioni autenticate e reporter Bluetooth `READY`.
- Il Raspberry e raggiungibile; `cassav5bt.service` e `bluetooth.service` sono
  attivi, BlueZ `5.82` e powered, NTP sincronizzato e permessi registry sicuri.
- L'UPS resta in sola discovery e produce la limitation non bloccante
  `UPS_DISCOVERY_UNAVAILABLE`.
- La Postazione base disponibile usa Android API 31 e build `2.0.19` code `21`
  con firma diversa dalla matrice. Rimane installata e intatta. Le prove
  Bluetooth descritte sotto usano il package affiancato non-gate e non
  sostituiscono i gate V5BT che richiedono API 33 o successiva.

## B0 supplementare

Il runner B0 sui due Palmare ha completato la finestra fisica di 120 secondi.
Per ciascun dispositivo sono passati scan, advertising, GATT server,
scan-advertise concorrenti, coesistenza Wi-Fi/BLE e foreground/background.
Il GATT client non e stato provato perche manca uno stimulus Raspberry B0
corrente e revisionato. Esito: `SUPPLEMENTAL_FAIL`, sei controlli su sette per
dispositivo, continuita Android interamente PASS e nessun impatto sul gate.

## B2, 100 cicli ravvicinati

Profilo: due Palmare, 100 cicli, timeout `15.000 ms`, poll `250 ms`, gap
`500 ms`.

- cicli eseguiti: `100/100`;
- PASS: `61`;
- timeout: `39`, tutti `ANONYMOUS_PEER_PRESENCE_TIMEOUT`;
- p95 dei cicli riusciti: `14.064 ms`;
- p95 lower bound comprendendo i timeout censurati: `15.026 ms`;
- p95 dopo che entrambi i reporter erano `READY`: `10.129 ms`;
- stop anticipato: no;
- evidenza live completa: si;
- verdetto locale: `PENDING`;
- gate B2: `PENDING`.

SHA-256 del report redatto:
`ed69b7237b43230d90a740c114e31e19e8e684cf9eb275beff8c7aef773f3b7c`.
Il file e `0600`, link count `1` e la scansione di redazione non rileva
seriali Android o indirizzi di rete.

## B2, pilot con cooldown

Profilo: 20 cicli, timeout `25.000 ms`, una quiescenza monotona di almeno
`31.000 ms` prima di ogni ciclo.

- quiescenze complete: `20/20`, osservate tra `31.000` e `31.001 ms`;
- cicli PASS: `20/20`;
- timeout ed errori radio: `0`;
- p95 presenza reciproca: `6.737 ms`;
- p95 dopo che entrambi i reporter erano `READY`: `2.247 ms`;
- latenza massima: `17.614 ms`;
- sequenza, evidenza live e cleanup: completi;
- `pilotVerdict`: `PASS`;
- gate B2: `PENDING`, promozione vietata.

SHA-256 del report redatto:
`1e23e4171f37e65631a764c9d84e1b70eca62cfcc84ab6ba4dfaa723acd01e68`.
Il file e `0600`, link count `1` e supera la scansione di redazione.

Il confronto indica che il riciclo radio ravvicinato e il principale fattore
dei timeout. Il cooldown elimina i timeout nel pilot, pur lasciando un singolo
outlier. Questo risultato guida il tuning, ma non sostituisce i 100 cicli
formali Palmare/Postazione.

## Continuita Raspberry

Sono state tentate due catture immutabili. La prima ha raccolto 9 campioni
stabili e la seconda 31; boot, servizi, PID, restart count e clock erano
invariati fino all'ultimo campione. Entrambe sono terminate fail-closed con
`SSH_CAPTURE_FAILED` su una lettura successiva, coerentemente con il link
Wi-Fi intermittente. Non e stata generata alcuna attestazione PASS e i journal
falliti non sono stati sovrascritti.

Prima di una prova formale occorre stabilizzare il collegamento SSH e ottenere
una cattura continua completa. I servizi operativi non sono stati fermati o
riavviati.

## Regressioni software

- B0: `14/14 PASS`, incluso il rifiuto fail-closed di Android API 31.
- B2 self-test schema 7: `151/151 PASS`.
- Monitor Raspberry: `16/16 PASS`, inclusa password tramite ambiente senza
  esposizione in argv, output, journal o attestazione.
- Coerenza build e parita sorgenti Bluetooth: `10/10 PASS`.
- Banner `Configurazione aggiornata`: `3/3 PASS` su ciascuna delle due copie
  frontend; durata massima 1,8 secondi e rimozione dal DOM quando nascosto.

## Postazione API 31 compat non-gate

Il package affiancato `com.sentrapa.postazione.advanced.partial` e stato
aggiornato in-place con `adb install -r` alla variante
`2.0.23-api31compat`, code `25`. SHA-256 dell'APK installato:
`c117dad07b1bbff88315770fccc4eba6d13d70ddb200300b901693e1ea636575`.
Preferenze e identita sono rimaste byte-identiche e l'enrollment e tornato
`READY`; non sono stati usati uninstall, `pm clear` o una nuova enrollment.

### Discovery e coesistenza

Con il filtro controller ServiceData il firmware Samsung API 31 aveva
registrato finestre scan valide ma zero risultati. La stessa prova con il
fallback limitato alla variante API 31, scan non filtrato lato controller e
validazione software fail-closed, ha raccolto sul nuovo APK finale:

- `2.471` callback grezze;
- `9` match dell'UUID V5BT;
- `9` payload V1 validi e accettati;
- `36` finestre scan-advertise concorrenti;
- p95 discovery `5.735 ms`;
- zero errori scan, advertising, payload o coda ingress.

Il confronto a parita di device e sorgenti radio conferma il filtro ServiceData
del firmware come causa dello zero iniziale. La coesistenza scan-advertise e
invece osservata fisicamente. Le build certificate API 33 o successive
mantengono il filtro controller originale.

La coesistenza Wi-Fi/BLE ha completato `5/5` richieste HTTPS valide durante
l'attivita radio. La prova in background finale e durata `31,253 s`
(`durationMs=31253`) e ha raccolto `7/7` campioni stabili, con gap massimo
`5,228 s` (`maxGapMs=5228`) e senza cambio di processo o reporter.

### GATT e continuita Raspberry

Sulla build immediatamente precedente, con sorgenti Bluetooth identici, il
client tablet ha completato connessione, validazione profilo e MTU `1/1/1`,
poi lo smoke profile-only ha prodotto `HELLO_WRITE_FAILED`. Il retest sull'APK
finale ha registrato `9` tentativi, `6` connessioni e `9` errori senza una
sessione stabile. Autenticazione, PING/PONG e chiusura non sono dimostrati: il
controllo finale `gattClientRuntime` e `FAIL`, `gattServerRuntime` e `NOT_RUN`
e il risultato complessivo resta correttamente `NON_GATE_FAIL`.

Lo smoke GATT Raspberry ha chiuso `PASS` sul proprio perimetro e ha completato
il cleanup. Il monitor principale retry 5 ha chiuso `PASS` dopo `464,501 s`
(`durationMs=464501`), `227` campioni e gap massimo `5,992 s`
(`maxGapMs=5992`); boot, clock, PID e restart dei due
servizi sono rimasti invariati. Il monitor dello staging retry 4 ha raccolto
`20` campioni in `33,660 s` (`durationMs=33660`), gap massimo `3,019 s`
(`maxGapMs=3019`), senza fault di restart,
health o hash.

### Trasporto batteria

Il reporter resta configurato a `120.000 ms`. Il fix ancora la pianificazione
al completamento della notifica precedente. La misura finale ha osservato `3`
notifiche in `270.090 ms`, con intervalli `120.074 ms` e `121.517 ms`:
`batteryCadence PASS`.

La variante `partial` generica mantiene il cleartext disabilitato. Soltanto la
variante `api31Compat` consente il trasporto HTTP locale derivato dal portale
HTTPS verso il servizio batteria sulla porta `8865`; frontend, API business e
radio continuano a usare i rispettivi trasporti sicuri senza fallback HTTP.

Il report pubblico redatto e
`reports/physical/V5BT_API31_COMPAT_PHYSICAL_NON_GATE_20260817.md` nel pacchetto
roadmap; il corrispondente report strutturato redatto e
`reports/physical/v5bt-api31-compat-physical-non-gate-20260817.json`. Il
validatore conta `14` controlli `PASS`, `gattClientRuntime FAIL` e
`gattServerRuntime NOT_RUN`. Suite completa `485/485 PASS` e runner report
`17/17 PASS`. Questa evidenza non promuove B0-B5.

## Stato roadmap

B0-B3 formali restano pendenti finche non e disponibile una Postazione V5BT
API 33 o successiva, con build, firma ed enrollment certificabili. B4 resta
`2/10` hardware fisici; i device simulati contano zero. B5 resta `0/100` e B6
resta bloccata.

Avanzamento roadmap complessiva: **49%**.
