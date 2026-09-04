# B11 - Test, soak e pilot

## Stato

Il test massimo richiesto e ora il profilo schema 3 `mixed-physical`, mode
`MAXIMUM_MIXED_PHYSICAL_VIRTUAL_SYSTEM_NON_GATE`. Lo stato corrente e
`MIXED_NON_GATE_INCOMPLETE`: sono osservati `2/4` attori fisici, precisamente
i due Palmari; Postazione e Raspberry risultano entrambi `0/1` nel receipt
redatto. Campagna radio, workload business fisico, monitor continui e
soak fisico sono `NOT_RUN`.

Gli harness software schema 1 e schema 2 restano baseline storiche
riproducibili. Lo schema 2 `MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE` conserva il
proprio `NON_GATE_PASS`, ma non puo soddisfare o sostituire gli slot fisici
dello schema 3. B11 formale resta `PENDING` finche non vengono completati i
gate precedenti e il pilot fisico.

## Profilo Massimo Misto Schema 3

La composizione e fissa e non ammette sostituzioni virtuali per i quattro
target fisici:

```text
10 Palmari: 2 fisici + 8 virtuali
3 Postazioni: 1 fisica + 2 virtuali
1 Raspberry fisico
1 cassa automatica virtuale
1 registratore fiscale RT virtuale
16 attori totali: 4 fisici + 12 virtuali
14 nodi Bluetooth logici
91 link logici: 6 real-real + 40 cross-domain + 45 virtual-only
100 cicli per link, 9100 cicli richiesti
```

I 40 link cross-domain e i 45 link virtual-only forniscono rispettivamente
`4000` e `4500` cicli attribuiti al modello software. I `600` cicli sui sei
link real-real sono attribuibili esclusivamente alla campagna fisica: i cicli
surrogati dello schema 2 sono esclusi. La stessa separazione vale per il
workload: delle `2600` azioni modellate, `2000` restano attribuite al dominio
virtuale e le `600` azioni dei target fisici, incluse 160 comande Palmare,
devono provenire da evidenza fisica separata.

Il contratto eseguibile schema 3 e deliberatamente
`MIXED_NON_GATE_INCOMPLETE`-only e non puo emettere un verdetto positivo.
Una futura versione del contratto e dell'harness potra introdurre un esito
positivo soltanto dopo avere implementato evidenze fisiche verificabili e
legate ai byte sorgente. I criteri di roadmap per tale revisione futura sono:

- presenza e readiness complete di 2 Palmari, 1 Postazione e 1 Raspberry;
- `600/600` cicli real-real con HELLO, autenticazione, dati bidirezionali e
  cleanup per ogni ciclo;
- `600/600` azioni business fisiche, incluse `160/160` comande Palmare;
- monitor continui su `4/4` attori fisici;
- soak fisico wall-clock di almeno `7200000 ms`;
- commitment distinti per inventario, campagna fisica e simulazione;
- manifest e receipt fisici verificabili e byte-bound;
- evidenza per ciascuno dei 6 link real-real e per ciascuno dei 4 attori;
- timestamp verificabili e provenance esplicita di esecuzione live;
- `4000/4000` cicli cross-domain e `4500/4500` virtual-only attribuiti solo al
  software.

Le 600 azioni fisiche restano sul piano business `LAN_HTTP_SSE`; il business
Bluetooth deve essere zero.

Nel v3 corrente `WAIVED_NON_GATE` e soltanto metadato per una policy futura e
non soddisfa la readiness. L'inventario certifica l'APK tramite SHA-256
byte-esatto e deriva la copertura signer dallo stesso binding: ignorare il
signer lascia quindi l'APK non certificato e il risultato `INCOMPLETE`. Non
viene aggiunta una probe signer separata in questa versione.

Fino a quella revisione, anche valori dichiarati 4/4, 600+600, monitor e soak
non autorizzano un PASS nel compositore corrente. Lo schema 3 conserva
`gateImpact: NONE`, promozione vietata, B11 `PENDING` e avanzamento `49%` e non
vale come pilot formale.

## Baseline Software Storica Schema 2

Il profilo software storico `hybrid` non puo essere ridotto o riconfigurato:

```text
10 Palmari virtuali
3 Postazioni virtuali
1 Raspberry virtuale
1 cassa automatica virtuale
1 registratore fiscale RT virtuale
16 attori totali, tutti virtualizzati
14 nodi Bluetooth: 13 Android + 1 Raspberry
78 coppie Android-Android + 13 link Android-Raspberry
91 link Bluetooth utili
100 connect/disconnect per coppia
9100 cicli complessivi
200 azioni per Android, 2600 azioni complessive
800 comande Palmare
100 transazioni cassa automatica + 100 transazioni RT
7200000 ms di soak virtuale
```

La cassa automatica e il registratore RT partecipano al workload applicativo
`LAN_HTTP_SSE`, non al grafo Bluetooth. Il trasporto di messaggi business su
Bluetooth resta vietato e deve risultare zero. Il Raspberry media il workload
virtuale e partecipa ai tredici link con Android.

Il runner non consulta ADB, SSH, radio, servizi o periferiche reali. Qualunque
componente fisico non collegato viene ignorato soltanto da questo profilo e
sostituito da un attore deterministico in memoria. Il report deve dichiarare
`physicalActors: 0`, tutti gli accessi reali `false`, `gateImpact: NONE`, B11
`PENDING` e avanzamento `49`. Questi vincoli restano obbligatori anche dopo il
ricalcolo del digest.

Il run storico schema 2 ha completato `9100/9100` cicli con verdetto
`NON_GATE_PASS`. Esercita:

- elezione ruoli e arbitraggio connessioni duplicate;
- framing, frammentazione e reassembly;
- retry, duplicati e deduplica;
- background/foreground sintetico;
- recovery durevole dopo reboot logico;
- route advertisement, replay e divieto multi-hop;
- `HEALTH/PING/TEST` shadow e duplicati;
- certificato non valido e cleanup senza leak;
- replay idempotenti, conflitti, fault e recovery della cassa automatica e RT;
- copertura di tutti i dieci Palmari e delle tre Postazioni.

Tempo, nodi e periferiche sono virtuali. Il risultato puo essere soltanto
`NON_GATE_PASS` o `NON_GATE_FAIL`; non puo produrre un PASS di roadmap.

## Soak Storico Riproducibile

Il profilo `soak` schema 1 resta invariato a 10 nodi generici, 45 coppie, 100
cicli per coppia e `4500/4500`. Le sue metriche sono `64.760` frame, `2.250`
messaggi frammentati, `643` retry,
`818` duplicati, `9.000` record history, `90` peer, `7.200` tick e `121`
campioni lungo `7.200.000 ms`. Leak e risorse residue sono entrambi zero. Il
digest storico canonico resta
`2527641f52ad15459ede6debe628c9dd392b53e774ca39179c59dc95b3adb3a1`.

Il profilo storico non e piu il test massimo e non viene riscritto dal profilo
ibrido.

## Lab Fisico Minimo

```text
Raspberry Pi 4/5
2 smartphone Android FULL_NODE
1 tablet Android FULL_NODE certificato
```

La campagna fisica deve comprendere almeno:

- discovery reciproca per 100 cicli;
- connect/disconnect per 100 cicli per coppia;
- movimento e perdita peer;
- app background/foreground e screen off/on;
- reboot Raspberry e Android;
- certificato invalido;
- fragment/reassembly, retry e duplicate frame;
- soak reale di due ore;
- monitor Android e Raspberry continui con cleanup completo.

## Stop E Invalidazione

Crash, ANR, logout, process restart, cambio identita/build, clock regressivo,
gap monitor, restart servizi, evidenza alterata o cleanup incompleto invalidano
il run secondo il gate applicabile. Un test sintetico non puo sanare un evento
fisico mancante o invalido.

## Prerequisiti

B11 parte soltanto dopo la revisione dei gate precedenti. Il ledger fisico B4
e ancora `2/10`, B5 e `0/100` e B6 e `PENDING/BLOCKED`; pertanto il pilot B11
formale non e autorizzato. Avanzamento ufficiale: 49%.
