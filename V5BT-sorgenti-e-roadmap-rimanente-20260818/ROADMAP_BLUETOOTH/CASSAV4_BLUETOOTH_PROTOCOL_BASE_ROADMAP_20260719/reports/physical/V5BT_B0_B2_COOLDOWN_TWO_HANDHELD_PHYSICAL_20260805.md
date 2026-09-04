# V5BT - Giro fisico B0/B2 cooldown del 2026-08-05

## Classificazione

Questo documento e un report pubblico redatto. Non contiene seriali Android,
indirizzi di rete, utenti, PID, identita di enrollment, hostname o percorsi
privati. Le catture su due Palmare sono evidenze supplementari e diagnostiche:
non sostituiscono la coppia formale Palmare/Postazione e non promuovono alcun
gate.

## Build e verifica offline

La matrice certificata usata dal giro e:

| Ruolo | Versione | Code | SHA-256 |
| --- | --- | ---: | --- |
| Palmare Advanced | `1.0.39` | `40` | `d0af2fd9341d5e50b49a4cd68fe4e2a0f70f6d28ef7c0acc1361191b5afffa65` |
| Postazione Advanced | `2.0.23` | `25` | `3d55fa75e40e33134c8824b8c36a60d00622ea62528c67db3b74208fbcf868a5` |

Palmare Advanced chiude la suite Android `212/212`; Postazione Advanced
chiude `196/196`. Entrambe le analisi lint terminano con zero errori. La build
Palmare e stata installata conservativamente sui due dispositivi disponibili.
La build Postazione e stata compilata e certificata offline, ma non installata
perche il tablet previsto non era presente.

Il consolidamento finale chiude test root `49/49`, roadmap Node `300 PASS` con
`2 SKIP` storici attesi, suite Raspberry `196/196`, self-test B2 `140/140` e
le due suite Android `212/212` e `196/196`.

L'inventario post-installazione conferma build, hash, permessi, enrollment
`READY`, binding registry e servizi operativi. Rimane `INCOMPLETE` soltanto per
`UPS_DISCOVERY_UNAVAILABLE`: il protocollo UPS reale non era interrogabile e
non e stato ipotizzato un driver.

## B0 supplementare

La cattura e durata `120` secondi. Entrambi i Palmare hanno completato `6/7`
controlli:

| Controllo | Palmare 1 | Palmare 2 |
| --- | --- | --- |
| Scan | PASS | PASS |
| Advertising | PASS | PASS |
| GATT server open/close | PASS | PASS |
| Scan e advertising concorrenti | PASS | PASS |
| Coesistenza Wi-Fi/BLE | PASS | PASS |
| Foreground/background | PASS | PASS |
| GATT client | NOT_PROVEN | NOT_PROVEN |

La continuita di versione, utente Android, processo, reporter, sessione,
clock, polling e servizio e `PASS` su entrambi; non sono stati osservati crash
o ANR. Il client GATT formale non e provato senza la Postazione certificata.
L'esito resta `SUPPLEMENTAL_FAIL / NON_GATE_EVIDENCE` e B0 resta `PENDING`.

## B2 cooldown pilot

Il pilot dedicato ha completato esattamente `20/20` cicli con `20` quiescenze
monotone complete, una iniziale e diciannove tra cicli. Ogni quiescenza e
iniziata dopo lo stop verificato di entrambi i processi ed e durata almeno
`31.000` ms.

| Misura | Risultato | Requisito |
| --- | ---: | ---: |
| Cicli PASS | `20/20` | `20/20` |
| Timeout | `0` | `0` |
| Errori scan/advertising/payload/ingress | `0` | `0` |
| Latenza minima | `3.486` ms | informativa |
| Latenza massima | `5.832` ms | informativa |
| p95 presenza anonima | `5.825` ms | massimo `8.000` ms |
| p95 dopo readiness di entrambi | `1.940` ms | informativa |

Il verdetto locale del pilot e `PASS`, ma il contratto lo classifica sempre
`NON_GATE_EVIDENCE`, vieta la promozione e mantiene B2 `PENDING`. Il test
formale resta quello da `100` cicli sulla coppia Palmare/Postazione.

## Continuita Raspberry

Il monitor redatto chiude `PASS` con:

- `758` campioni in `1.517.378` ms;
- gap massimo osservato `3.720` ms;
- boot e clock stabili;
- servizio principale e Bluetooth continui;
- zero restart e copertura polling completa.

Il servizio principale non e stato fermato o riavviato durante le prove.

## Logout finale

Dopo il pilot entrambi i Palmare sono stati disconnessi e osservati per `135`
secondi. La finestra ha registrato zero stato auth, servizi nativi target,
notifiche Advanced, tag rilevanti dei processi target, crash, ANR e waiter
server. Non sono state ricevute notifiche o attivita applicative dopo logout.

## Stato gate e prossimo passo

- B0, B1, B2 e B3 restano `PENDING`.
- Il ledger B4 non e stato modificato, ricostruito o sovrascritto.
- B5 resta chiuso fino al PASS autentico di B0-B4.
- B6 resta chiuso fino alla promozione formale di B5.
- L'avanzamento roadmap ufficiale resta **49%**.

Il prossimo passo fisico e attendere il tablet Postazione certificato, ripetere
l'inventario read-only e procedere in ordine con B0 formale, B1, B2 formale da
`100` cicli e B3 da `3.600` secondi. Le evidenze di questo report restano
diagnostiche e non saranno riclassificate retroattivamente.

## Evidenze pubbliche correlate

- `v5bt-b0-b2-cooldown-postinstall-inventory-redacted-20260805.json`
- `v5bt-b0-two-handheld-v1039-redacted-20260805.json`
- `v5bt-b2-two-handheld-cooldown-pilot-v1039-20260805.json`
- `v5bt-raspberry-continuity-b0-b2-cooldown-retry1-20260805.json`
