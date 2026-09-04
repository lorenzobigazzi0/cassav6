# Prompt Codex — Phase B11

Implementa esclusivamente la fase B11 descritta nella roadmap. Mantieni feature
flag OFF per default, produci test, metriche, rollback e report. Il test massimo
usa il profilo schema 3 `mixed-physical`: esattamente 10 Palmari, 2 fisici e 8
virtuali; 3 Postazioni, 1 fisica e 2 virtuali; 1 Raspberry fisico; 1 cassa
automatica e 1 registratore RT virtuali.

Non sostituire mai uno dei quattro target fisici con un simulatore. Il
contratto eseguibile schema 3 e `MIXED_NON_GATE_INCOMPLETE`-only: non
implementare ne accettare un ramo di verdetto positivo. Presenza/readiness
4/4, `600/600` cicli sui sei link real-real con HELLO, autenticazione, dati
bidirezionali e cleanup, `600/600` azioni fisiche incluse 160 comande, monitor
continui 4/4 e soak wall-clock di almeno `7200000 ms` sono criteri per una
futura versione del contratto/harness.

Non abilitare quella versione finche non esistono manifest e receipt fisici
verificabili e byte-bound, evidenze per ciascuno dei 6 link e dei 4 attori,
timestamp verificabili e provenance live. Mantieni separata l'attribuzione dei
`4000` cicli cross-domain e `4500` virtual-only software.
Mantieni le azioni business fisiche su `LAN_HTTP_SSE` e il business Bluetooth
a zero. Nel v3 corrente `WAIVED_NON_GATE` e soltanto metadato per una policy
futura e non soddisfa readiness. L'inventario certifica l'APK con SHA-256
byte-esatto e deriva la copertura signer dallo stesso binding: un signer
ignorato lascia l'APK non certificato e il verdetto `INCOMPLETE`. Non
aggiungere una probe signer separata in questa versione.

Pubblica soltanto `MIXED_NON_GATE_INCOMPLETE` e lascia i workload non eseguiti
a `NOT_RUN`. Lo
stato corrente ha `2/4` attori fisici osservati: i due Palmari; Postazione e
Raspberry risultano `0/1`. Lo schema 2 tutto virtuale resta
una regressione storica immutata, non evidenza per gli slot fisici.

Pagamenti e fiscale sono ammessi soltanto come mock deterministici del workload
NON-GATE; non introdurre pagamenti/fiscale offline di prodotto, multi-hop o
ESP32. Non promuovere gate, non cambiare lo stato ufficiale e non usare la
simulazione come evidenza fisica.
