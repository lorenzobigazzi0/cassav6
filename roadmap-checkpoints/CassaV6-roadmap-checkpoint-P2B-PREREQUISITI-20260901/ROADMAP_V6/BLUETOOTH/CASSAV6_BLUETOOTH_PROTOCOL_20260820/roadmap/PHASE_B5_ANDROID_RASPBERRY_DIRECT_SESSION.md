# B5 — Sessione Android ↔ Raspberry

```text
Core lifecycle B5.1: PASS locale
GATT server Raspberry B5.2: PASS locale e ARM64
Smoke fisico Raspberry B5.3: PASS
Runtime GATT Android B5.4: PASS locale; PASS fisico su un Palmare
HELLO Android-Raspberry B5.5: PASS locale; PASS fisico su un Palmare
Mutual auth Android-Raspberry B5.6: PASS locale/ARM64; PASS fisico su due Palmari
Session key e heartbeat B5.7: PASS locale/build Lab; gate fisico PENDING
Gate B4: PENDING, 2/10 fisici; 8 simulati NON_GATE contano 0
Gate B5 100 sessioni: PENDING
```

Ruoli fissi iniziali:

```text
Android = GATT client/central
Raspberry = GATT server/peripheral
```

Sequenza:

```text
discovery
connect GATT
service discovery
MTU negotiation
HELLO
mutual auth
session key
heartbeat
PING/PONG
clean close
```

## B5.1 - Core condiviso

Il primo incremento e implementato in:

```text
shared/session/direct-session-v1.mjs
```

Definisce una macchina a stati fail-closed, senza I/O e senza timer nascosti.
Il client Android esegue service discovery; il server Raspberry non la
simula. Entrambi richiedono MTU, HELLO, autenticazione, session key e
heartbeat prima dello stato `ACTIVE`.

Il contratto congela:

- sessionId casuale da 128 bit, base64url canonico non padded da 22 caratteri;
- MTU da 23 a 517, preferito 247;
- chiusura dopo tre heartbeat mancati;
- snapshot privo di identita, sessionId, chiavi e payload;
- terminalita di `CLOSED` e `FAILED` fino a reset esplicito.

Sono passati 19 test mirati e il validatore dei contratti. Questo risultato non
apre GATT e non promuove B4 o B5. Dettagli in
`reports/B5_1_DIRECT_SESSION_CORE_20260720.md`.

## B5.2 - GATT server Raspberry

Il port `DbusNextGattServerPort` registra su `GattManager1` l'albero definito
da `GattApplication`. Il profilo contiene il servizio e le sette
caratteristiche congelate nel registro UUID. Ogni accesso dati resta
`NotAuthorized`, perche il binding a una sessione autenticata non appartiene
a questo incremento.

La registrazione richiede `CASSA_BT_GATT_SERVER_ENABLED=1`, disattivato per
default. Sono coperti rollback, stop idempotente e recovery dopo perdita
dell'owner BlueZ. La suite package corrente passa 54/54 localmente; i 12 test
GATT mirati passano anche sul Raspberry ARM64.

## B5.3 - Smoke fisico GATT Raspberry

BlueZ ha accettato l'applicazione con 9 interfacce esportate, 8 managed object,
una match rule e sette caratteristiche. Il contatore fisico conferma una
richiesta `GetManagedObjects` da BlueZ. Lo stop ha eseguito una sola
unregister e ha riportato bus, export e match rule a zero. L'adapter e rimasto
acceso, discovery e rimasta disattivata e il test non ha avviato advertising.

La prova ha inoltre verificato sul target Linux i 103 test condivisi. Questo
PASS certifica il solo lifecycle del server GATT fail-closed: non apre una
sessione e non promuove il gate B5. Evidenza e procedura sono in
`reports/B5_3_RASPBERRY_GATT_PHYSICAL_20260720.md` e
`testing/B5_RASPBERRY_GATT_PHYSICAL_SMOKE.md`.

## B5.4 - Client GATT Android

Palmare Advanced e Postazione Advanced includono lo stesso client GATT
Android dietro `cassaBluetoothGattClient=false` per default. Il client viene
abilitato soltanto con Lab, agent, identita e discovery gia attivi; i flag
`DirectServer` e `PeerLink` continuano a bloccare il runtime se richiesti.

La selezione del candidato ammette soltanto una nuova osservazione di un
Raspberry che dichiara `serverReachable=true` e capability `GATT_SERVER`.
Il lifecycle esplicito e:

```text
IDLE
CONNECTING
DISCOVERING_SERVICES
NEGOTIATING_MTU
READY
FAILED
CLOSED
```

`READY` significa soltanto trasporto verificato. Il client controlla il
servizio primario, le sette UUID e le capability esatte, quindi negozia un
MTU valido tra 23 e 517. Non esegue read, write, subscribe, HELLO,
autenticazione o binding al core sessione. `CLOSED` e terminale; `FAILED`
puo ripartire soltanto tramite reset esplicito provocato da un nuovo
candidato.

Le suite finali passano 138/138 test sul Palmare e 132/132 sulla Postazione;
lint e build Lab passano su entrambe. Una prova fisica tra Palmare API 36 e
Raspberry ARM64/BlueZ 5.82 ha raggiunto `READY`, validato il profilo e
negoziato MTU 517 con un solo tentativo, zero failure e zero sessioni.
Postazione e secondo Palmare non erano eleggibili per la prova perche
l'identita B1 era `IDENTITY_NOT_READY`; il comportamento fail-closed e
corretto ma non vale come copertura fisica B5.4.

Dettagli e procedura sono in
`reports/B5_4_ANDROID_GATT_CLIENT_20260720.md`,
`reports/physical/v6-b5-4-android-gatt-client-20260720.json` e
`testing/B5_ANDROID_GATT_CLIENT.md`.

## B5.5 - HELLO Android-Raspberry

Android e Raspberry condividono il contratto HELLO v1 da 51 byte. Dopo
profilo e MTU, Android scrive la richiesta e legge la risposta legata alla
stessa connessione BlueZ. Entrambi raggiungono `HELLO_EXCHANGED` senza creare
una sessione autenticata.

Le suite finali passano 145/145 sul Palmare e 139/139 sulla Postazione; lint
e build Lab passano su entrambe. La prova fisica pulita su Palmare API 36 e
Raspberry ARM64/BlueZ 5.82 ha prodotto un write, un read, un exchange, zero
failure e zero sessioni autenticate su entrambi i lati. Lo stop ha rimosso
binding, export, match rule e bus.

Solo HELLO e aperta; le altre caratteristiche restano fail-closed. Dettagli
e procedura sono in
`reports/B5_5_ANDROID_RASPBERRY_HELLO_20260720.md` e
`testing/B5_ANDROID_RASPBERRY_HELLO.md`.

## B5.6 - Autenticazione reciproca Android-Raspberry

Dopo HELLO, Android sottoscrive `controlTx`, invia su `controlRx` la prova
Ed25519 legata al transcript e attende la prova HMAC del Raspberry. Il finish
Android completa la stessa catena soltanto se identita enrollata, HELLO,
binding e ordine dei messaggi sono coerenti. Il server usa il registry V6 in
sola lettura durante il gate e rifiuta replay, revoche, mismatch, duplicati e
timeout.

Le suite mirate passano localmente e sul Raspberry ARM64. Il 2026-07-21 due
prove radio sequenziali, una per ciascun Palmare Advanced, hanno raggiunto
`AUTHENTICATED` con una sola autenticazione per prova e zero failure. Dopo
ciascuno stop il conteggio autenticato e tornato a zero e tutte le risorse
BlueZ del gate sono state rilasciate. Le caratteristiche business sono
rimaste fail-closed e i report fisici pubblicati contengono soltanto stati e
contatori aggregati.

Il PASS B5.6 non equivale allo stato `ACTIVE`: non sono ancora presenti chiave
di sessione, heartbeat o traffico business. Dettagli in
`reports/B5_6_MUTUAL_AUTH_20260721.md` e
`testing/B5_ANDROID_RASPBERRY_MUTUAL_AUTH.md`.

## B5.7 - Chiave di sessione e heartbeat autenticato

B5.7 implementa lo scambio X25519 autenticato, la derivazione HKDF con chiavi
separate per direzione, la conferma della chiave, PING0/PONG0, heartbeat ogni
3 secondi e CLOSE/CLOSE_ACK autenticati. Quattro coppie PING/PONG totali sono
necessarie nel gate: attivazione piu tre heartbeat successivi.

Le suite locali shared, Raspberry e Android passano; il runner fisico redatto
e il validatore della campagna da 100 sessioni superano i self-test. Il
collector schema v2 invoca direttamente runner e advertising, assegna gli
slot `001`..`100`, genera un `bootId` CSPRNG privato per cattura e usa
stato/journal/evidenze `0600`. Migra soltanto state legacy vuoti e genera il
manifest a raccolta completa. Lock kernel separati proteggono stato e
adattatore; abort e deadline coprono anche D-Bus e cleanup. Gli artefatti
pre-commit vengono scartati e lo slot viene ripetuto. Non accetta report
esterni o runner alternativi e non puo promuovere il gate. Il monitor ADB
lega l'intera campagna a build, utente, processo, reporter e sessione
autenticata; il gate finale richiede state, manifest e attestation della
stessa campagna. Le build
Lab integrate di entrambe le app passano con tutti i flag fino all'heartbeat,
mentre `DirectServer` e `PeerLink` restano disattivati. Il gate radio reale
resta `PENDING`. Il traffico business resta chiuso e il gate B5 da 100
sessioni non e promosso. Dettagli in
`reports/B5_7_DIRECT_CONTROL_20260721.md` e
`testing/B5_ANDROID_RASPBERRY_DIRECT_CONTROL.md`.

## Prossimo incremento

Rivalidare B0-B4 sul banco reale. Durante l'attesa dei dieci hardware B4 e
ammesso un solo pilot B5.7 diagnostico con state separato. Dopo PASS B0-B4,
avviare monitor e state ufficiali, raccogliere 100 record committed
sequenziali, finalizzare e sottoporre aggregate e checksum a revisione umana
indipendente. B6 resta `PENDING` fino alla promozione formale di B5.
