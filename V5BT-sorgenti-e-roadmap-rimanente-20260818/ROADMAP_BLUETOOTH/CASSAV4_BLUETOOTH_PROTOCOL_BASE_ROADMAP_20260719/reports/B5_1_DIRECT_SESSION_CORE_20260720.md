# B5.1 Direct Session Core

Data: 2026-07-20

## Decisione

- Contratto lifecycle Android-Raspberry: PASS locale
- Core deterministico condiviso: PASS locale
- Runtime GATT Android: non iniziato
- Runtime GATT Raspberry: non iniziato
- Gate fisico B4: PENDING, 1/10
- Gate fisico B5: PENDING

## Implementazione

Il riferimento eseguibile e:

```text
shared/session/direct-session-v1.mjs
```

Il core possiede stati, transizioni, idempotenza, binding di protocollo,
sessionId e MTU, heartbeat e chiusura. Mantiene separati i percorsi:

```text
Android client:    connect -> service discovery -> MTU
Raspberry server:  connect ----------------------> MTU
```

Entrambi devono poi completare HELLO, autenticazione, session key e heartbeat
prima di raggiungere `ACTIVE`.

Il contratto usa un sessionId casuale da 128 bit in base64url canonico non
padded, limiti MTU 23/517, MTU preferito 247 e chiusura dopo tre heartbeat
mancati.
Gli stessi valori sono congelati in `contracts/PROTOCOL_TEST_VECTORS.json` e
verificati contro tutti gli schemi wire che contengono `sessionId`.

## Sicurezza e privacy

Il core non implementa o simula crittografia. `AUTH_VERIFIED` e una barriera
applicativa che in un incremento successivo sara posseduta esclusivamente
dall'adapter Ed25519/X25519/HKDF/AEAD e dal registry B1.

Lo snapshot non contiene sessionId, identita, transport handle, materiale
crittografico o payload. Eventi con campi non dichiarati vengono rifiutati
prima di entrare nello stato.

## Verifica

```text
node --test shared/session/direct-session-v1.test.mjs
19 test passati, 0 falliti

node scripts/validate-contracts.mjs --root .
ok=true, directSession.vectorPassed=true

node scripts/validate-roadmap-package.mjs --root .
ok=true, missing=0, isolationErrors=0

node --test shared/protocol/advertisement-v1.test.mjs \
  shared/discovery/peer-directory-v1.test.mjs \
  shared/discovery/scan-window-policy-v1.test.mjs \
  shared/provisioning/enrollment-transport-v1.test.mjs \
  shared/session/direct-session-v1.test.mjs
80 test passati, 0 falliti

cd raspberry
npm run check
TypeScript PASS

npm test
39 test passati, 0 falliti
```

Sono coperti happy path per entrambi i ruoli, ordine errato, replay
incompatibile, canonicalita base64url, limiti MTU, protocol version, session
binding, PING/PONG, heartbeat timeout, chiusura, reset, redazione e clock
regression.

La suite condivisa che include anche `device-registry-v1.test.mjs` produce su
Windows 80 PASS e 20 FAIL per il `fsync` della directory dopo il rename. E un
vincolo noto e intenzionalmente fail-closed del registro durabile, non una
regressione B5.1; la suite registry e certificata sul target Raspberry Linux.

## Confine runtime

`raspberry/src/index.ts` e `raspberry/src/node/BluezNode.ts` non importano il
core B5, `GattApplication`, `CassaGattService` o `SessionManager`. Nessuna
risorsa GATT viene quindi aperta da questo incremento e le build Android
restano B3 con i flag sessione disattivati.

Il prossimo incremento software B5.2 dovra implementare il port GATT server
BlueZ dietro un nuovo flag fail-closed, senza ancora aggiungere handshake o
messaggi business.
