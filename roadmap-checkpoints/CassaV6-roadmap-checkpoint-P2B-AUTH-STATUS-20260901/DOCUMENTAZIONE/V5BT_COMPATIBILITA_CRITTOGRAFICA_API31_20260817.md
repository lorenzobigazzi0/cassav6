# V5BT - compatibilita crittografica Android API 31

## Scopo

Il 17 agosto 2026 e stato verificato un tablet Android 12, API 31, per
individuare una suite crittografica V5BT che consenta il funzionamento completo
anche sui dispositivi che non supportano Ed25519 in `AndroidKeyStore`.

Il report e redatto: non contiene seriali ADB, MAC address, hostname, UID, PID,
alias di chiavi o altri identificatori privati.

## Metodo

La prima prova e stata eseguita tramite `app_process`. Ha confermato gli
algoritmi del provider software, ma non e stata usata per giudicare
`AndroidKeyStore`, perche tale provider non viene registrato in quel contesto.

La prova autorevole ha quindi usato un APK diagnostico temporaneo con queste
proprieta:

- package isolato e distinto dalle applicazioni operative;
- nessun permesso Android richiesto;
- nessun accesso ai dati o ai servizi delle applicazioni V5BT;
- alias casuali creati soltanto nel namespace del probe;
- cancellazione degli alias in blocchi `finally`;
- firma e accordo verificati end-to-end, non soltanto enumerati dai provider;
- ricaricamento di ogni chiave persistente da `AndroidKeyStore` prima dell'uso;
- controllo di `PrivateKey.getEncoded()`, `KeyInfo.origin`, livello di sicurezza
  e collocazione in hardware sicuro.

Sequenza operativa redatta:

```text
adb install --no-incremental <probe-apk>
adb shell am start -W -n <probe-package>/<probe-activity>
adb logcat -d -s <probe-tag>
adb uninstall <probe-package>
adb shell pm list packages <partial-package>
adb shell pm list packages <probe-package>
```

Al termine il package diagnostico e il file temporaneo ADB risultavano assenti.
La Postazione Advanced parziale risultava ancora installata e il suo processo
non e stato arrestato o riavviato dalla prova.

## Risultati

| Operazione | Provider | Esito | Proprieta osservate |
| --- | --- | --- | --- |
| EC P-256, firma SHA-256/ECDSA | AndroidKeyStore | PASS | 256 bit, alias ricaricato, privata non esportabile, origine `GENERATED`, livello `TRUSTED_ENVIRONMENT`, hardware sicuro |
| EC P-256, ECDH | AndroidKeyStore | PASS | segreto da 32 byte identico sui due lati, alias ricaricato, privata non esportabile, origine `GENERATED`, livello `SOFTWARE` |
| EC P-256, firma SHA-256/ECDSA | AndroidOpenSSL | PASS | firma e verifica complete |
| EC P-256, ECDH | AndroidOpenSSL | PASS | segreto da 32 byte identico sui due lati |
| Ed25519/EdDSA | AndroidOpenSSL | PASS | SPKI da 44 byte, privata software esportabile |
| Ed25519/EdDSA | AndroidKeyStore | NON SUPPORTATO | algoritmo assente e curva `ed25519` rifiutata |
| X25519/XDH | AndroidOpenSSL | PASS | SPKI da 44 byte, segreto da 32 byte, privata software esportabile |
| X25519/XDH | AndroidKeyStore | NON SUPPORTATO | algoritmo assente e curva `x25519` rifiutata |

Il dispositivo dichiara inoltre le feature Android Bluetooth classico,
Bluetooth LE e Wi-Fi. Questa verifica crittografica non costituisce da sola un
gate radio B0.

## Alternativa compatibile

La soluzione minima e sicura per API 31 e una seconda suite esplicita:

`ECDSA_P256_SHA256_IDENTITY + X25519_EPHEMERAL_SESSION`

L'identita persistente usa P-256 in `AndroidKeyStore`; sul tablet provato la
chiave di firma e hardware-backed e non esportabile. Lo scambio di sessione
mantiene X25519 software, gia effimero nel protocollo corrente: la privata vive
soltanto per la sessione e viene abbandonata al cleanup.

Questa scelta riduce la modifica al solo livello di identita e enrollment. Un
eventuale ECDH P-256 persistente e tecnicamente possibile, ma su questo tablet
e implementato al livello software e cambierebbe inutilmente anche lo scambio
di sessione.

La compatibilita non deve essere un fallback silenzioso. Il contratto dovra:

1. assegnare un identificatore versionato alla suite;
2. registrare algoritmo, suite e SPKI insieme all'identita enrollment;
3. negoziare soltanto suite dichiarate da entrambi i peer;
4. legare la suite scelta a HELLO, transcript, prova di possesso e conferme;
5. rifiutare mismatch, downgrade dopo un errore di autenticazione e firme non
   canoniche;
6. mantenere Ed25519 come suite primaria sui dispositivi che la supportano;
7. produrre gate e report distinti per le due suite.

Il registry e il formato della prova enrollment dovranno quindi accettare SPKI
P-256 e firme ECDSA canoniche oltre agli attuali valori Ed25519. Prima della
promozione serviranno test incrociati API 31/API 33+, rollback conservativo e
nuove evidenze B0-B3; le evidenze correnti non vengono reinterpretate.

## Stato finale

### Contratto diagnostico fisico

Il runner roadmap `scripts/run-api31-compat-non-gate.mjs` distingue il
self-test prephysical dalla modalita `PHYSICAL_DIAGNOSTIC` schema `2`. La
cattura e il report devono essere file privati regolari `0600`, non collegati
e non sovrascrivibili. Il formato fisico ammette solo valori aggregati e non
offre campi per seriali, MAC, identita enrollment, host o percorsi.

Il report espone enrollment v2 `READY`, API/package/versione, contatori
scan/UUID/osservazioni, capability e runtime separati per scan, advertise e
GATT, concorrenza, health Wi-Fi, background/foreground, continuita Android,
Raspberry e staging, piu cadenza batteria configurata a `120000 ms`. Tutti i
controlli e i claim sono derivati dal runner. Anche un esito completo resta
`NON_GATE_EVIDENCE`, con `gateImpact: NONE`, B0-B5 `PENDING`, B6 `BLOCKED` e
avanzamento ufficiale invariato al `49%`.

- Postazione Advanced parziale: installata.
- Package diagnostico: assente.
- File diagnostico sul tablet: assente.
- Applicazioni operative o relativi dati modificati: nessuno.
- Promozione gate prodotta da questa prova: nessuna.

Avanzamento roadmap complessiva: **49%**.
