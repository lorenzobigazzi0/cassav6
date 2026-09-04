# Direct session lifecycle v1

## Scope B5.1

Questo incremento definisce soltanto il contratto deterministico della
sessione diretta Android-Raspberry. Non registra un'applicazione GATT, non apre
connessioni e non esegue crittografia.

I ruoli B5 sono fissi:

```text
Android   = android-client
Raspberry = raspberry-server
```

Il client Android deve attraversare:

```text
GATT_CONNECTED
SERVICES_DISCOVERED
MTU_NEGOTIATED
HELLO_ACCEPTED
AUTH_STARTED
AUTH_VERIFIED
SESSION_KEY_ESTABLISHED
HEARTBEAT_STARTED
ACTIVE
```

Il server Raspberry non esegue service discovery e passa direttamente da
`GATT_CONNECTED` a `MTU_NEGOTIATED`. Tutte le altre barriere sono identiche.

## Invarianti

- `sessionId` rappresenta 128 bit casuali codificati in base64url canonico
  senza padding, quindi e lungo 22 caratteri e l'ultimo carattere puo essere
  soltanto `A`, `Q`, `g` o `w`;
- MTU GATT ammesso da 23 a 517, con preferenza 247;
- `ACTIVE` non e raggiungibile prima di HELLO, autenticazione reciproca,
  derivazione della session key e avvio heartbeat;
- l'evento `AUTH_VERIFIED` puo provenire soltanto dal futuro adapter
  crittografico, dopo verifica del registry B1;
- gli eventi accettano solo i campi dichiarati;
- replay incompatibili, PONG non richiesti, binding diversi e transizioni
  fuori ordine portano la sessione in `FAILED`;
- tre heartbeat mancati portano a `CLOSING`;
- il core non crea timer: tick e timeout sono eventi espliciti del futuro
  orchestratore;
- il clock e monotono e iniettabile; una regressione fallisce la sessione;
- una sessione `CLOSED` o `FAILED` non puo riaprirsi senza `RESET`;
- lo snapshot diagnostico non contiene sessionId, NodeId, transportId, chiavi,
  nonce, certificati o payload.

## Confini

Il riferimento eseguibile e:

```text
shared/session/direct-session-v1.mjs
```

I vettori congelati sono in `contracts/PROTOCOL_TEST_VECTORS.json`. Tutti gli
schemi wire che contengono `sessionId` usano lo stesso pattern.

B5.1 non implementa:

- `GattManager1` o caratteristiche BlueZ;
- `BluetoothGatt` Android;
- Ed25519, X25519, HKDF o AEAD;
- frame, ACK, retry o persistenza;
- messaggi business o bridge POS.

Il gate B4 resta `PENDING`. Il gate B5 resta `PENDING` e richiede ancora 100
sessioni Android-Raspberry complete su hardware reale.
