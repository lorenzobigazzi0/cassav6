# B5.7 session key and authenticated heartbeat

Data: 2026-07-21
Aggiornamento locale: 2026-08-03

## Esito corrente

```text
Protocollo direct-control v1: PASS locale
Handshake X25519/HKDF Raspberry: PASS locale
Runtime GATT Raspberry: PASS locale
Runtime Android puro: PASS locale
Integrazione Android GATT: PASS build Lab Palmare/Postazione
Harness fisico redatto: PASS self-test
Validatore campagna 100 sessioni: PASS locale/self-test; gate fisico PENDING
Gate fisico B5.7 Android-Raspberry: PENDING
Gate B5 100 sessioni: PENDING
```

## Incremento

B5.7 estende il solo canale di controllo dopo HELLO e autenticazione
reciproca:

1. scambio X25519 autenticato e legato al transcript;
2. derivazione HKDF-SHA256 di chiavi separate per direzione e conferma;
3. conferma esplicita della chiave prima di qualsiasi attivazione;
4. PING0/PONG0 autenticati per raggiungere `ACTIVE`;
5. heartbeat Raspberry ogni 3 secondi, con chiusura dopo tre miss;
6. `CLOSE/CLOSE_ACK` autenticati e azzeramento di timer e segreti.

Le caratteristiche business restano negate. I flag Android di session key e
heartbeat sono atomici e disattivati per default; il flag Raspberry direct
control e disattivato per default e richiede autenticazione reciproca.

## Robustezza

Il runtime gestisce in modo idempotente il PONG precedente quando una
ritrasmissione e gia in volo, conserva copie difensive dei buffer di risposta
e accoda una sola indicazione mentre Android completa una write. Il client
Android applica un watchdog al silenzio del server, timeout inferiori
all'intervallo heartbeat per la write PONG e reset esplicito dopo `CLOSED`.

Il gate richiede quattro coppie PING/PONG totali: la coppia di attivazione e
tre heartbeat successivi. Solo allora il runner richiede la chiusura normale.

## Verifiche locali

```text
Protocollo shared direct-control: PASS
TypeScript Raspberry: PASS
Suite server/GATT B5.7 mirata: PASS
Harness B5.7 self-test: PASS
Palmare Advanced integrato Lab B5.7: 180/180 PASS; lint 0 errori
Postazione Advanced integrata Lab B5.7: 176/176 PASS; lint 0 errori
Validatore campagna B5: 16/16 PASS
Suite Raspberry completa con build TypeScript: 110/110 PASS
```

Le build Lab abilitate fino a chiave di sessione e heartbeat sono pronte. In
entrambi gli APK `DirectServer` e `PeerLink` restano disattivati. Installazione
ADB, prova radio B5.7 e campagna fisica da 100 sessioni restano necessarie
prima di promuovere B5.7 e il gate B5.

Artefatti Lab:

```text
Palmare-Advanced-v1.0.36-V5BT-B5.7-Lab-debug.apk
Postazione-Advanced-v2.0.22-V5BT-B5.7-Lab-debug.apk
```

## Confine di sicurezza

Il report fisico ammettera soltanto stati e contatori aggregati: nessun
indirizzo, seriale, identificatore di protocollo, chiave, payload o percorso
locale. B5.7 non abilita traffico ordini e non promuove il gate B5 da 100
sessioni.

Procedura: `testing/B5_ANDROID_RASPBERRY_DIRECT_CONTROL.md`.
