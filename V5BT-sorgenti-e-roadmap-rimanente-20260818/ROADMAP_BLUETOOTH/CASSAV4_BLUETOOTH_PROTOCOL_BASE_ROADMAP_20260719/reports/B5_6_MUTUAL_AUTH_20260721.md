# B5.6 mutual authentication

Data: 2026-07-21

## Esito corrente

```text
Contratto mutual-auth v1: PASS locale
Registry crypto e revoca: PASS locale e ARM64
Handshake Raspberry: PASS locale e ARM64
GATT controlRx/controlTx: PASS locale e ARM64
Harness fisico redatto: PASS self-test ARM64
Runtime Android end-to-end: PASS fisico su due Palmari
Gate fisico B5.6 Android-Raspberry: PASS su due Palmari
Gate B5 100 sessioni: PENDING
```

## Incremento

B5.6 apre soltanto il percorso di controllo necessario dopo HELLO:

1. firma Ed25519 Android legata ai due HELLO e al certificateId enrollato;
2. verifica del device autorizzato nel registry V5BT;
3. prova HMAC Raspberry derivata dall'alias key non esportabile;
4. finish HMAC Android sullo stesso transcript;
5. transizione esplicita ad `AUTHENTICATED`.

Replay, identita revocate, certificate mismatch, ordine errato e MTU minore
di 101 falliscono chiusi. Le caratteristiche business restano negate.

## Harness Raspberry

Il runner aggiunto e:

```text
raspberry/scripts/run-b5-mutual-auth-smoke.mjs
```

Richiede un registry V5BT assoluto, lo valida prima di aprire la radio e
accetta esattamente un HELLO e una mutual auth completa. Il report conserva
solo contatori e stati; non include registry path, identificatori, indirizzi,
chiavi o payload. Lo stop deve azzerare sessione autenticata, export, match
rule e bus.

Sul Raspberry ARM64 lo staging versionato ha superato:

```text
20/20 test GATT, HELLO, handshake e harness B5.6
24/24 test protocollo mutual-auth e registry
TypeScript noEmit: PASS
Harness self-test: PASS
```

I servizi Cassa V4 e `bluetooth.service` sono rimasti attivi durante i test
offline. Nessuna unit persistente B5.6 e stata abilitata.

Lo staging ARM64 verificato e in
`/opt/cassav5bt-bluetooth-lab/releases/20260721-b5-6`. Il relativo archivio
runtime, senza `node_modules` o cache, ha SHA-256
`f6c22f9f0ced9a783212ebde3d6cf8f82b5b5bf63d55b90e6ff56a6dec58a6a5`;
l'hash coincide tra la copia locale e quella caricata nello staging utente del
Raspberry.

## Esito fisico

Il 2026-07-21 sono state eseguite due prove radio sequenziali, ciascuna con un
solo Palmare Advanced attivo come client. Entrambe hanno prodotto `PASS` e
hanno osservato:

- stato finale `AUTHENTICATED` prima dello stop;
- un HELLO, una prova client verificata, una prova server emessa e un finish
  verificato;
- esattamente una sessione autenticata prima del cleanup e zero dopo;
- zero failure;
- caratteristiche business ancora fail-closed;
- unregister e rilascio completo delle risorse BlueZ del gate.

Le due evidenze redatte sono:

```text
reports/physical/v5bt-b5-6-phone-a-20260721.json
reports/physical/v5bt-b5-6-phone-b-20260721.json
reports/physical/v5bt-b5-6-enrollment-discovery-two-palmari-20260721.json
```

I report contengono soltanto metadati del target, stati, check e contatori
necessari al verdetto. Non contengono identificatori di dispositivo, indirizzi
radio, identificatori di protocollo, materiale crittografico o payload. I
servizi V4 sono rimasti invariati durante entrambe le prove.

## Confine di sicurezza

Questo incremento non implementa session key, heartbeat, `ACTIVE`, frame
cifrati o traffico ordini. Il gate B5 da 100 open/close non puo essere
promosso da B5.6 e resta `PENDING`.

La procedura fisica e in
`testing/B5_ANDROID_RASPBERRY_MUTUAL_AUTH.md`. Il prossimo incremento e B5.7:
derivazione della chiave di sessione e heartbeat prima di `ACTIVE`.
