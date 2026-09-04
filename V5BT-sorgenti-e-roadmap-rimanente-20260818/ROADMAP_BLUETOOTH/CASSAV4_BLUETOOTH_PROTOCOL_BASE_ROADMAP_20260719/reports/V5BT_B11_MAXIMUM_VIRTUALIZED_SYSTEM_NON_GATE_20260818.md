# V5BT B11 - Maximum Virtualized System Non-Gate

Data: 2026-08-18, Europe/Rome.

## Classificazione

```text
schemaVersion: 2
mode: MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE
evidenceClass: NON_GATE_EVIDENCE
verdict: NON_GATE_PASS
gateImpact: NONE
promotionAllowed: false
b11Gate: PENDING
officialProgressPercent: 49
```

Questo report documenta una simulazione deterministica interamente offline. Non
ha usato ADB, SSH, radio Bluetooth, servizi o periferiche reali. Ogni attore e
virtualizzato; gli attori fisici conteggiati sono zero. Il risultato non
sostituisce B4, B5, B6 o il pilot fisico B11.

## Attori E Topologia

| Ruolo | Numero | Dominio |
| --- | ---: | --- |
| Palmare | 10 | Android/Bluetooth virtuale |
| Postazione | 3 | Android/Bluetooth virtuale |
| Raspberry | 1 | Bluetooth virtuale |
| Cassa automatica | 1 | periferica applicativa virtuale |
| Registratore fiscale RT | 1 | periferica applicativa virtuale |
| Totale | 16 | tutti virtualizzati |

I 13 Android formano 78 coppie. Ogni Android ha inoltre un link col Raspberry,
per altri 13 collegamenti: 91 link utili complessivi. Cassa automatica e RT non
sono nodi Bluetooth.

## Risultato

| Misura | Esito |
| --- | ---: |
| Connect/disconnect | `9100/9100` |
| Elezioni ruolo Android | `156` |
| Arbitrati duplicati Android | `78` |
| Frame affidabili | `130948` |
| Sessioni frammentate | `4550` |
| Retry | `1300` |
| Duplicati osservati | `1656` |
| History persistita | `18200` |
| Peer persistiti | `182` |
| Azioni applicative | `2600/2600` |
| Comande Palmare | `800` |
| Transazioni cassa automatica | `100/100` |
| Transazioni RT | `100/100` |
| Messaggi business inoltrati su Bluetooth | `0` |
| Soak virtuale | `7200000 ms` |
| Sessioni/outbox/artefatti residui | `0/0/0` |

Il piano business resta `LAN_HTTP_SSE`. Le due periferiche virtuali esercitano
replay idempotente, conflitto su replay mutato, indisponibilita e recupero. Non
vengono esportati token, UUID, endpoint, chiavi idempotenza o identificatori
operativi.

## Evidenza E Verifica

Il report macchina e
`reports/V5BT_B11_MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE_20260818.json`.

```text
reportDigest: 6b527f1003329004628dc79abad1db2d2ca607a68551f7030e699abda7ef8f37
fileSha256: a439a52f1d7b2405359509f7c715a5f68ea7f673b0d86ea1b468f7c02ae0629a
fileMode: 0600
fileNlink: 1
```

Verifiche eseguite:

- focus B11 e helper: `17/17 PASS`;
- suite Raspberry Node 24: `318/318 PASS`, zero failure/cancel/skip/todo;
- validazione avversaria del report: `5/5 PASS`;
- helper business e topologia: `5/5 PASS`;
- contratti JSON: `29` validi;
- test archivio sorgenti: `4/4 PASS`.

Il validatore runtime chiude il set di campi a ogni livello, ricalcola il digest
e rifiuta accessi reali, attori fisici, periferiche reali, leak, teardown
incompleto e tentativi di promozione anche con digest ricalcolato. I gate B4 e
B5 non importano ne accettano questo report.

## Compatibilita Storica

Il soak schema 1 da 10 nodi generici, 45 coppie e `4500/4500` resta separato e
riproducibile. Il suo digest e invariato:
`2527641f52ad15459ede6debe628c9dd392b53e774ca39179c59dc95b3adb3a1`.

Lo stato ufficiale non e stato modificato: B4 resta `2/10`, B5 `0/100`, B6
`PENDING/BLOCKED`, B11 fisico `PENDING` e avanzamento complessivo `49%`.
