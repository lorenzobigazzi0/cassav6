# B5.7 - Rehearsal Web GUI Loopback Non-Gate

## Scopo

Questo rehearsal verifica sul Palmare web grafico il solo ciclo applicativo
`ACTIVE`, quattro `PING/PONG`, `CLOSE/CLOSE_ACK` e cleanup. Usa una macchina a
stati HTTP esclusivamente loopback e non simula Bluetooth o GATT.

Non e il pilot fisico B5.7, non soddisfa prerequisiti B0-B4, non crea sessioni
ufficiali e non autorizza la campagna B5.

## Prerequisiti

- banco B4 web `ACTIVE` con otto contesti, pagine e sessioni distinte;
- ledger fisico schema `2`, regolare `0600`, un link e due record;
- fingerprint del ledger invariato;
- frontend e backend isolati su loopback;
- nessun processo di raccolta fisica o campagna B5 in corso.

## Comandi

Da `SORGENTE_SISTEMA/cassa-frontend`:

```bash
node scripts/run-v6-b4-web-gui-lab.mjs --status
node scripts/run-v6-b4-web-gui-lab.mjs --pilot
node --test scripts/v6-b5-web-pilot.test.mjs \
  scripts/run-v6-b4-web-gui-lab.test.mjs
```

`--pilot` usa il Palmare web dello slot logico `3`. Richiesta e risultato sono
file privati `0600`, atomici e non sovrascrivibili nel run corrente. Un
risultato gia pubblicato viene soltanto validato e restituito.

## Contratto Pass

Il solo esito positivo e `NON_GATE_PASS` e richiede:

```text
trasporto = LOOPBACK_HTTP_SIMULATION
ACTIVE = true
PING/PONG = 4/4
CLOSE_ACK = 1
errori = 0
connessioni dopo cleanup = 0
timer dopo cleanup = 0
sessione browser preservata = true
sessioni B5 ufficiali = 0
```

Qualunque contatore non valido, errore, cleanup incompleto o perdita della
sessione produce `NON_GATE_FAIL`. Il report pubblico non contiene endpoint,
account, token, UUID browser, PID, percorsi o identificatori fisici.

## Separazione Dai Gate

Il rehearsal non usa ADB, SSH, Bluetooth, GATT, Raspberry o UPS; non legge le
evidenze fisiche, non scrive il ledger B4 o gli state B5 e non esegue alcun
promotore. Lo stato resta:

```text
B4 = PENDING, 2/10 hardware fisici
B5 = PENDING, 0/100 sessioni ufficiali
B6 = BLOCKED
```

Il pilot fisico della campagna resta disciplinato da
`testing/B5_PHYSICAL_CAMPAIGN_RUNBOOK.md` e potra iniziare soltanto dopo i
prerequisiti fisici previsti.

Avanzamento roadmap complessiva: **49%**
