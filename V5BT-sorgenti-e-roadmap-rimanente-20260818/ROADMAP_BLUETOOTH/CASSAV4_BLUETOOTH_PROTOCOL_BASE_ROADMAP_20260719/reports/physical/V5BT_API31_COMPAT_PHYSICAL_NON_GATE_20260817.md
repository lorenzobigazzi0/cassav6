# V5BT - Postazione API 31 compat fisica non-gate

Data: 2026-08-17

## Esito

- Classe evidenza: `NON_GATE_EVIDENCE`
- Verdetto aggregato: `NON_GATE_FAIL`
- Gate ufficiali: invariati
- Avanzamento ufficiale: `49%`

Il verdetto fail-closed dipende dall'assenza di una sessione GATT completa.
Discovery, coesistenza e continuita passate non vengono trasformate in un PASS
di protocollo.

## Build e installazione

- Package affiancato: `com.sentrapa.postazione.advanced.partial`
- Versione: `2.0.23-api31compat`
- Version code: `25`
- SHA-256 APK:
  `c117dad07b1bbff88315770fccc4eba6d13d70ddb200300b901693e1ea636575`
- Installazione: aggiornamento conservativo con `adb install -r`
- Dati, preferenze e identita: preservati
- Enrollment finale: `READY`

Non sono stati eseguiti uninstall, cancellazione dati, cambio utente o nuova
enrollment.

## Discovery API 31

La configurazione iniziale con filtro controller ServiceData avviava scan e
advertising senza errori, ma non riceveva risultati. A parita di tablet e
sorgenti radio, il fallback riservato all'API 31 non-gate ha rimosso il filtro
controller e applicato la whitelist V5BT in software.

Risultato finale:

| Misura | Valore |
| --- | ---: |
| Callback grezze | 2.471 |
| Match UUID V5BT | 9 |
| Payload V1 validi | 9 |
| Osservazioni accettate | 9 |
| Finestre scan-advertise concorrenti | 36 |
| P95 discovery | 5.735 ms |
| Errori scan | 0 |
| Errori advertising | 0 |

Il confronto conferma il filtro ServiceData del firmware Samsung come causa
dello zero iniziale. La ricezione durante advertising concorrente esclude una
limitazione di coesistenza nel perimetro osservato. Il fallback resta escluso
dalle build certificate API 33 o successive.

## Wi-Fi e background

- richieste HTTPS durante attivita BLE: `5/5` valide;
- durata background: `31,253 s` (`durationMs=31253`);
- campioni background: `7/7` stabili;
- gap massimo: `5,228 s` (`maxGapMs=5228`);
- cambio processo o reporter: nessuno osservato.

## GATT

| Passaggio | Risultato |
| --- | --- |
| Cattura precedente, connessione/profilo/MTU | `1/1/1` |
| Cattura precedente, scrittura HELLO | `HELLO_WRITE_FAILED` |
| Retest APK finale, tentativi/connessioni/errori | `9/6/9` |
| Sessione autenticata | `NOT_PROVEN` |
| `gattClientRuntime` | `FAIL` |
| `gattServerRuntime` | `NOT_RUN` |

La cattura precedente usava gli stessi sorgenti Bluetooth dell'APK finale e
differiva soltanto per la successiva correzione del reporter batteria. Lo
stimulus Raspberry esponeva intenzionalmente soltanto il profilo GATT. Il
retest sull'APK finale non ha raggiunto una sessione stabile. Nessuna delle due
catture dimostra autenticazione reciproca, chiave di sessione, PING/PONG o
chiusura pulita; il tratto GATT non puo essere promosso.

## Raspberry e staging

- smoke GATT Raspberry: `PASS` sul perimetro profile-only;
- cleanup dello smoke: `PASS`;
- monitor Raspberry retry 5: `PASS`, `227` campioni, `464,501 s`
  (`durationMs=464501`), gap massimo `5,992 s` (`maxGapMs=5992`);
- monitor staging retry 4: `20` campioni, `33,660 s` (`durationMs=33660`), gap
  massimo `3,019 s` (`maxGapMs=3019`);
- restart, health e hash fault staging: `0`;
- boot, clock, servizi e restart count operativi: invariati.

I servizi operativi non sono stati fermati o riavviati.

## Batteria e trasporto

Il reporter e configurato a `120.000 ms`. Il fix ancora la pianificazione al
completamento della notifica precedente. La misura finale ha osservato `3`
notifiche in `270.090 ms`; i due intervalli sono `120.074 ms` e `121.517 ms`.
Il controllo `batteryCadence` e `PASS`.

La variante `partial` generica conserva il traffico cleartext disabilitato.
Soltanto `api31Compat` consente il trasporto HTTP locale derivato dal portale
HTTPS verso il servizio batteria sulla porta `8865`. Frontend, API business e
radio non acquisiscono fallback HTTP.

## Validazione

Il report strutturato redatto e
`v5bt-api31-compat-physical-non-gate-20260817.json`. Contiene `14` controlli
`PASS`, `gattClientRuntime FAIL`, `gattServerRuntime NOT_RUN` e verdetto
`NON_GATE_FAIL`. La suite completa chiude `485/485 PASS`; il runner del report
chiude `17/17 PASS`.

## Redazione e limiti

Il report non contiene seriali Android, indirizzi di rete, MAC, hostname, PID,
account, token, percorsi privati o identita enrollate. Le evidenze complete
restano nell'area privata con permessi restrittivi.

Questa prova non sostituisce la Postazione certificata richiesta dai gate
formali, non incrementa B4, non autorizza B5 e non apre B6.

Avanzamento roadmap complessiva: **49%**
