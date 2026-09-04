# B4.4 Physical Collection Progress

Data: 2026-07-20

## Decisione

- Collector progressivo: PASS software
- Prima acquisizione fisica: PASS
- Dispositivi fisici distinti registrati: 1/10
- Dispositivi ancora necessari: 9
- Gate autorevole B4: PENDING
- B5: non iniziata

Un solo Palmare Advanced fisico e stato registrato. Due alias osservati e un
retry della stessa coppia report/log non aumentano il conteggio.

## Prima acquisizione

```text
node kind: handheld
Android API: 36
durata a parete: 90119 ms
durata lifecycle: 89983.494227 ms
osservazioni accettate: 255
osservazioni rifiutate: 0
RSSI: -64 dBm
passaggi di pruning: 90
stream scaduti rimossi: 1
errori scanner/D-Bus/payload/sequenza: 0
```

Il preflight ha verificato un solo target ADB autorizzato, package Palmare
Advanced, modello hardware, API, BLE, adapter, launcher, build Lab
debuggabile e i tre permessi Nearby Devices. Lo stato Android era `READY`,
`radioActive=true`, advertising attivo e senza errori.

La prima invocazione ha restituito `RECORDED`; la ripetizione con lo stesso
hardware e gli stessi byte ha restituito `ALREADY_RECORDED`. Il ledger e
rimasto a un solo record.

## Integrita e privacy

Report B4.3:

```text
dcf0e14a10c4c7cee162a4d8e4d0a054673eb6a41e38a4e5a7f7027b66835ab9
```

Log B4.3:

```text
2212112f0ca8a892746685e250aa81d32c9b1150f3f228e973e2b46c5f9fd885
```

Stato, chiave HMAC, digest hardware e log raw restano nella directory privata
esterna al pacchetto. Il report pubblico non contiene seriali ADB/hardware,
NodeId, alias, MAC, payload o chiave HMAC.

## Cleanup

Al termine sul Raspberry:

```text
Powered: yes
Discovering: no
ActiveInstances: 0
processi runner/nodo temporanei: 0
```

I due file temporanei sotto `/tmp` sono stati rimossi dopo la copia e la
verifica hash. Nessuna unit systemd e stata installata o abilitata.

## Validazione

```text
collector progressivo: 17/17 PASS
runner B4.3 + B4.4 mirati: 25/25 PASS
suite nodo Raspberry: 39/39 PASS
harness ADB su Linux ARM64: 17/17 PASS
validator pacchetto: PASS
retry fisico idempotente: PASS
preflight device gia acquisito: NOT_ELIGIBLE, ledger invariato
```

## Prossimo incremento fisico

Collegare un solo Android Advanced diverso, assicurare che sia enrollato nel
registry B1 e che sia l'unico advertiser V1 controllato, quindi ripetere il
run B4.3 da 90 secondi e `--record`. Il gate resta `PENDING` fino a `10/10` e
alla successiva verifica autorevole Raspberry.
