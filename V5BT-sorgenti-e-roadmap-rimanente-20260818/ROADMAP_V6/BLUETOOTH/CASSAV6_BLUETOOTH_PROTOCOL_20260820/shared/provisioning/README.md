# Device registry e one-time enrollment B1

Questa implementazione e una libreria amministrativa locale. Non avvia BlueZ,
scan, advertising, GATT, backend o flussi POS. Le feature Bluetooth e
l'enrollment runtime restano disabilitati per default.

## Materiale registrato

Ogni device autorizzato contiene esclusivamente identita e materiale tecnico:

- `nodeId`: UUID RFC 4122 stabile;
- `certificateId`: UUID del record autorizzativo;
- chiave pubblica Ed25519 oppure EC P-256 in formato SPKI DER/base64;
- `aliasKey`: 32 byte casuali per l'alias rotante;
- endpoint tecnico di enrollment, istanti di enrollment/revoca.

La chiave privata Android non viene accettata dall'API e non viene mai
archiviata. Deve restare nell'Android Keystore. Il registry non contiene utenti,
tavoli, ordini, nomi del locale, pagamenti o altri dati business.
Durante l'enrollment il `nodeId` e la chiave pubblica sono entrambi obbligatori
e devono provenire dalla stessa identita gia creata sul device Android. Il
registry non genera mai un NodeId sostitutivo.

## Garanzie del file

`device-registry-v1.mjs` e il registry misto `device-registry-v2.mjs`
applicano queste garanzie:

1. il registry deve essere un file regolare, non un symlink, con modo esatto
   `0600`;
2. ogni mutazione acquisisce un lock esclusivo creato con `O_EXCL`; prima
   della rimozione confronta `dev`/`ino` del pathname con l'handle ancora
   aperto e non rimuove mai un pathname che non identifica il lock acquisito;
3. il nuovo JSON viene scritto in un file temporaneo `0600`, sincronizzato con
   `fsync`, rinominato atomicamente e seguito da `fsync` della directory;
4. il token monouso e casuale a 256 bit, mentre nel registry rimane soltanto
   `SHA-256(context || token)`;
5. consumo del token e creazione del device avvengono nello stesso commit;
6. `aliasKey` usa base64url senza padding (43 caratteri) ed e restituita
   soltanto dalla prima risposta di enrollment;
7. `inspect()`, `list` e il lookup pubblico oscurano `aliasKey` e hash dei
   token; il runtime puo chiedere la derivazione di un alias senza ottenere la
   chiave;
8. la CLI scrive prima in `OUTPUT.pending`, file regolare `0600` di proprieta
   dell'utente corrente, ne sincronizza contenuto e directory e solo allora
   permette il commit del token/device;
9. dopo il commit crea `OUTPUT` con un hard link che non puo sovrascrivere un
   file esistente, sincronizza la directory, rimuove il link `.pending` solo
   quando quello finale e durevole e sincronizza una seconda volta;
10. token file, output recuperati e QR sono letti con `O_NOFOLLOW`, dimensione
    limitata, proprietario/modo/link count verificati, chiavi esatte e
    serializzazione JSON canonica; la recovery confronta inoltre il token con
    l'hash persistito e l'aliasKey con il record senza esporre questi segreti
    tramite `inspect()`/`list`;
11. l'output JSON amministrativo usa scritture sincrone sui descrittori
    standard, cosi i percorsi brevi di recovery/errore non perdono
    `stdout`/`stderr` alla chiusura del processo Node 22.

Il pathname `OUTPUT` identifica una transazione. Ripetere lo stesso comando
con lo stesso output effettua recovery idempotente: un `.pending` con record
presente nel registry viene promosso senza emettere un secondo token o
riconsumare il token; un `.pending` valido con commit certamente assente viene
rimosso prima di iniziare una nuova transazione; se il registry non e
verificabile, lo stato e `UNCERTAIN` e il segreto viene preservato senza
proseguire. Un `OUTPUT` finale non viene mai sovrascritto o cancellato.

Restano due limiti operativi, quindi questo incremento non chiude da solo il
gate B1. Un `.pending` troncato prima che la callback di persistenza termini
non puo corrispondere a un commit, ma viene comunque preservato per decisione
amministrativa. Inoltre Node.js non espone un'operazione compare-and-unlink:
la verifica `dev`/`ino` riduce la race sul pathname, ma richiede che directory
del registry e degli output siano fidate e non scrivibili da altri attori
durante l'operazione. Serve ancora fault injection con interruzione elettrica
sul filesystem Raspberry di destinazione.

Un lock lasciato da un processo terminato in modo anomalo non viene rimosso
automaticamente. Un lock sostituito dopo l'acquisizione viene lasciato intatto
e produce un errore di cleanup: la rimozione deve essere una decisione
amministrativa dopo aver verificato che nessun processo stia modificando il
registry.

## CLI offline

Inizializzazione:

```bash
node raspberry/scripts/device-registry.mjs init \
  --registry /var/lib/cassav6-bluetooth/devices.json
```

Per migrare atomicamente un registry v1 e abilitare identita P-256, eseguire
esplicitamente l'inizializzazione v2. La migrazione preserva device, alias key,
token e timestamp originali, aggiunge `protocolVersion=1` ai token storici e
rifiuta un orologio regressivo:

```bash
node raspberry/scripts/device-registry.mjs init \
  --registry /var/lib/cassav6-bluetooth/devices.json \
  --protocol-version 2
```

Emissione di un token con scadenza, scritto in un nuovo file `0600`:

```bash
node raspberry/scripts/device-registry.mjs issue-token \
  --registry /var/lib/cassav6-bluetooth/devices.json \
  --endpoint-id raspberry-lab-01 \
  --protocol-version 2 \
  --ttl-seconds 600 \
  --output /secure/enrollment-token.json
```

Enrollment usando esclusivamente la chiave pubblica Android:

```bash
node raspberry/scripts/device-registry.mjs enroll \
  --registry /var/lib/cassav6-bluetooth/devices.json \
  --token-file /secure/enrollment-token.json \
  --node-id 550e8400-e29b-41d4-a716-446655440000 \
  --public-key-file /secure/android-p256-public.pem \
  --output /secure/android-provisioning.json
```

L'ultimo file contiene `nodeId`, `certificateId` e `aliasKey` ed e quindi
sensibile. Va importato dal flusso Keystore futuro e poi gestito secondo la
procedura operativa del laboratorio. Token e aliasKey non sono mai inseriti
negli argomenti del processo o nell'output normale della CLI.

## Trasporto HTTPS nativo locale

`enrollment-transport-v1.mjs` implementa il contratto server del solo
enrollment iniziale. Accetta `POST /v1/enroll` con
`Content-Type: application/json`, limita il body a 4096 byte e rifiuta chiavi
JSON duplicate anche quando una chiave usa escape Unicode. La richiesta deve
contenere esattamente gli otto campi congelati in
`contracts/enrollment-request-v1.schema.json`.

Il device firma con Ed25519 la concatenazione UTF-8 separata da NUL di:

```text
CASSA_V6-BT-ENROLLMENT-PROOF-V1
protocolVersion
enrollmentEndpointId
token
nodeId
publicKeySpkiDerBase64
```

Il server verifica endpoint, token, NodeId, SPKI Ed25519 e firma prima di
invocare il registry. Una risposta persa dopo il commit puo essere recuperata
per 600 secondi soltanto se endpoint, token, NodeId e chiave pubblica
corrispondono esattamente al record gia impegnato. Gli errori del registry
sono ridotti a risposte non enumeranti; le risposte usano
`Cache-Control: no-store`.

`enrollment-transport-v2.mjs` aggiunge `POST /v2/enroll` senza modificare il
contratto v1. Usa token `c6e2_`, SPKI canonico P-256 da 91 byte,
`publicKeyAlgorithm=EC-P256` e
`proofAlgorithm=ECDSA-P256-SHA256-P1363`. La firma e il formato raw
IEEE-P1363 `r || s` da 64 byte e sono accettate soltanto firme low-S. Il
transcript separato da NUL inizia con
`CASSA_V6-BT-ENROLLMENT-PROOF-V2` e prosegue, nell'ordine, con versione,
endpoint, token, NodeId, `publicKeyAlgorithm`, `proofAlgorithm` e SPKI. I due
identificatori di algoritmo sono quindi firmati e non possono essere
sostituiti affidandosi alla sola validazione JSON. Protocollo, token e
algoritmo non possono essere reinterpretati come v1. Il server HTTPS espone entrambi i path con un
unico limite condiviso di quattro enrollment concorrenti.

La richiesta firmata originale contiene tutto cio che serve al recupero. Se
viene catturata integralmente resta bearer-equivalent per la sola risposta gia
impegnata durante quei 600 secondi. Il body, il token e la prova firmata non
devono mai essere loggati, tracciati, conservati da intermediari o copiati in
report. Il recupero non permette un nuovo enrollment e richiede comunque il
binding esatto gia registrato.

Il request handler elabora al massimo quattro enrollment contemporaneamente
(il parametro e validato nell'intervallo 1..32). Quando il limite e occupato
risponde `503` con codice `ENROLLMENT_BUSY`, `Connection: close` e
`Retry-After: 1`, senza leggere o accodare altro lavoro sensibile.

`raspberry/scripts/enrollment-server.mjs` espone il trasporto su HTTPS TLS 1.3
e legge chiave e certificato da file regolari senza seguire symlink. La chiave
privata deve appartenere all'utente del servizio e avere modo esatto `0600`.
Il servizio systemd separato
`raspberry/systemd/cassav6-bluetooth-enrollment.service` imposta
`CASSA_BT_ENROLLMENT_RUNTIME_ENABLED=0`; anche lo script termina senza aprire
socket se il flag non vale esattamente `1`. L'host predefinito e
`127.0.0.1`: l'ascolto LAN richiede una configurazione Lab esplicita.
Il server limita inoltre a 32 le connessioni, usa timeout stretti per header,
request e keep-alive e consente al massimo dieci richieste per socket.
La unit crea `/var/lib/cassav6-bluetooth` tramite
`StateDirectory=cassav6-bluetooth` con modo `0700`; registry e scritture
restano confinati in quello state root V6.
Il preflight rifiuta path V4, symlink intermedi e hard link esterni; il check
`GET /health` restituisce `503 NOT_READY` se il registry privato non e
ispezionabile. La unit impone `MemoryMax=128M`, `CPUQuota=50%`, `TasksMax=64`
e `LimitNOFILE=256`.
I nomi delle variabili, i path TLS e i valori fail-closed sono inventariati in
`configs/raspberry.env.example`; la finestra di recovery e congelata in
`configs/security-policy.json`.

La unit legge il formato systemd reale da
`/etc/cassav6/cassav6-bluetooth-enrollment.env`. L'esempio pronto da
installare e `configs/cassav6-bluetooth-enrollment.env.example`: usa righe
`KEY=VALUE`, registry e state root esclusivamente V6, loopback e runtime
spento. Va installato come file regolare `root:root` con modo `0600`, quindi
verificato prima di un eventuale avvio Lab:

```bash
sudo install -d -o root -g cassav6 -m 0750 /etc/cassav6
sudo install -o root -g root -m 0600 \
  configs/cassav6-bluetooth-enrollment.env.example \
  /etc/cassav6/cassav6-bluetooth-enrollment.env
sudo systemd-analyze verify \
  raspberry/systemd/cassav6-bluetooth-enrollment.service
```

Il prefisso `-` nella direttiva `EnvironmentFile` permette alla unit di
restare avviabile anche quando il file non e ancora installato; in quel caso
il valore incorporato `CASSA_BT_ENROLLMENT_RUNTIME_ENABLED=0` mantiene
l'endpoint spento. L'installazione dell'esempio non abilita il servizio: per
una prova Lab il flag deve essere modificato esplicitamente soltanto dopo aver
installato certificato, chiave e pin SPKI corretti. La chiave TLS resta un
file separato, posseduto dall'utente `cassav6` e con modo esatto `0600`, come
richiesto dal server.

Il token monouso limita replay e finestra temporale ma non sostituisce la
confidenzialita e l'autenticazione TLS. Il certificato reale deve essere
generato e installato per il nome DNS o l'indirizzo IP esatto usato dal client,
con il relativo pin SPKI configurato nelle sole build Lab. Queste operazioni e
la prova end-to-end su dispositivi fisici restano pendenti.

La CLI offline continua a non esporre endpoint HTTP e rimane disponibile come
strumento amministrativo separato.

## Retry Android e stato Lab redatto

Il coordinator Android permette un tentativo di enrollment soltanto da
`ALIAS_KEY_UNPROVISIONED` o `ENROLLMENT_PENDING`. Nel secondo caso, se
l'aliasKey non e ancora presente, il binding canonico NodeId/SPKI deve
corrispondere all'identita corrente: non viene creata una nuova identita per
aggirare uno stato pendente.

La pulizia del QR privato e fail-closed. Se il file in elaborazione non puo
essere eliminato, se l'input non puo essere ripulito o se il QR consumato non
puo essere cancellato prima della rete, il tentativo termina come
`STORAGE_FAILED` e non apre la connessione HTTPS. Lo stato pubblicato nel file
app-private e redatto.

Il banco `scripts/run-b2-android-adb-harness.mjs` trasferisce il QR soltanto su
stdin di `adb exec-out run-as`, applica modo `0600`, valida allowlist di stato
e impedisce che il token entri in argv, stdout, stderr o report. Le istruzioni
operative sono in `testing/B2_ANDROID_ADB_HARNESS.md`; le prove locali e i gate
fisici aperti sono in `reports/B2_ANDROID_ADB_HARNESS_20260720.md`.

Le risposte sensibili iniziali sono congelate in
`contracts/enrollment-response-v1.schema.json` e
`contracts/enrollment-response-v2.schema.json`; i nomi
`aliasKeyEncoding=base64url-unpadded` e `aliasKeyBase64url` sono il contratto
con l'import Android Keystore.

L'entrypoint Raspberry verifica realmente `CASSA_BT_FEATURE_ENABLED=1` prima di
importare o avviare il nodo BlueZ. La unit systemd di esempio imposta `0` e usa
`Restart=on-failure`, quindi il runtime resta fermo finche non viene abilitato
esplicitamente in un file di configurazione. Quando verra abilitato, la stessa
unit monta il filesystem di sistema read-only e applica `ReadOnlyPaths` al
registry: l'enrollment resta un'operazione amministrativa separata dalla radio.

Inventario senza segreti e revoca:

```bash
node raspberry/scripts/device-registry.mjs list \
  --registry /var/lib/cassav6-bluetooth/devices.json

node raspberry/scripts/device-registry.mjs revoke \
  --registry /var/lib/cassav6-bluetooth/devices.json \
  --node-id 550e8400-e29b-41d4-a716-446655440000
```

## Test locale

```bash
node shared/provisioning/device-registry-v1.test.mjs
node --test shared/provisioning/device-registry-v1.test.mjs
node --test shared/provisioning/device-registry-v2.test.mjs
node --test shared/provisioning/enrollment-transport-v1.test.mjs
node --test shared/provisioning/enrollment-transport-v2.test.mjs
node --test raspberry/scripts/enrollment-server.test.mjs
node --test scripts/run-b2-android-adb-harness.test.mjs
node scripts/run-b2-android-adb-harness.mjs --self-test
node scripts/validate-contracts.mjs --root .
```
