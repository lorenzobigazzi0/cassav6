# V6 direct session core v1

`direct-session-v1.mjs` e la fonte eseguibile del lifecycle B5 condiviso.

Il modulo:

- separa il percorso client Android da quello server Raspberry;
- applica la sequenza GATT, HELLO, autenticazione, key establishment,
  heartbeat e chiusura;
- usa eventi espliciti e un clock monotono iniettabile;
- fallisce chiuso su replay o transizioni incompatibili;
- espone snapshot redatti.

Non contiene I/O Bluetooth o primitive crittografiche. In particolare,
`AUTH_VERIFIED` non verifica una firma: e un evento privilegiato che il futuro
adapter di handshake potra emettere solo dopo la verifica Ed25519 e del
registry B1.

Verifica:

```bash
node --test shared/session/direct-session-v1.test.mjs
node scripts/validate-contracts.mjs --root .
```
