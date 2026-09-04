# V5BT B4 - Due Fisici E Otto Simulati Non-Gate

Data: 2026-08-06

## Obiettivo

Verificare offline il flusso logico B4 a dieci slot usando i due record fisici
gia acquisiti e otto dispositivi sintetici, senza alterare o promuovere il gate
fisico.

## Risultato

- verdetto esercizio: `NON_GATE_PASS`;
- evidenza: `NON_GATE_EVIDENCE`;
- record fisici letti in sola lettura: `2`;
- slot simulati soltanto in memoria: `8`, dal `3` al `10`;
- ordine, unicita e hash-chain privata: `PASS`;
- dispositivi simulati conteggiati verso B4: `0`;
- state fisico prima e dopo: identico byte per byte, regolare, `0600`, un link;
- lock condiviso col collector durante lettura, simulazione e pubblicazione;
- output privato: directory separata `0700`, file `0600`, un link, no-overwrite;
- pubblicazione: schema esatto, atomica, crash-durable e rollback verificato;
- identificatori, percorsi, hash e timestamp fisici nel report: assenti.

## Stato Gate

Il ledger autorevole resta `2/10`. B4 e B5 restano `PENDING`, B6 resta
`BLOCKED`. Il pilot diagnostico B5.7 e la campagna ufficiale B5 non sono
autorizzati: mancano il PASS formale B0-B3 con la Postazione certificata e il
completamento fisico B4.

La simulazione non genera manifest, non legge le evidenze degli slot, non
esegue il gate Raspberry e non sostituisce gli otto hardware ancora necessari.

## Verifica

- test runner ibrido: `7/7 PASS`;
- self-test runner: `PASS`, impatto gate `NONE`;
- suite B4 mirata: `89 PASS + 2 SKIP` storici;
- monitor continui B4: `35/35 PASS`;
- suite B5 offline: `159/159 PASS`;
- build certificate e parita sorgenti condivisi: `10/10 PASS`.
- manifest bidirezionale: `PASS`, zero file mancanti o inattesi;
- validatore pacchetto: zero errori manifest e zero errori di isolamento.
- review indipendente dopo due cicli di hardening: nessun finding residuo.

Avanzamento roadmap complessiva: **49%**
