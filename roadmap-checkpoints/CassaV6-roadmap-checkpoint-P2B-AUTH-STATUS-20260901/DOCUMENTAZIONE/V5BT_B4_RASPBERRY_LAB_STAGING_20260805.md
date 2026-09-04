# V5BT B4 Raspberry Lab Staging

Data verifica: 2026-08-05

## Scopo

Questo documento descrive lo staging isolato del runtime B4 sul Raspberry.
Non costituisce evidenza B4, non autorizza prove radio e non promuove alcun
gate. Il servizio principale V5BT e `bluetooth.service` non devono essere
fermati, riavviati o riconfigurati durante la preparazione.

## Inventario Read-only

- architettura Raspberry: ARM64;
- runtime Node disponibile: `24.15.0`;
- servizio principale V5BT: attivo, zero restart osservati;
- `bluetooth.service`: attivo, zero restart osservati;
- adapter: non in discovery e senza advertiser attivi;
- nessun runner B4 o nodo Lab temporaneo in esecuzione;
- nessuna unita systemd riferisce il percorso Lab versionato.

Il vecchio albero Bluetooth non e un runtime B4 allineato: mancano almeno il
runtime compilato `dist`, il lockfile, i due runner B4 e la matrice di
certificazione condivisa. Non deve essere aggiornato in-place e non deve essere
usato per produrre nuove evidenze.

## Release Corrente Inerte

E stata applicata la convenzione Lab versionata gia documentata:

```text
/opt/cassav5bt-bluetooth-lab/releases/20260805-b4-readiness-matrix3-r2
```

Proprieta dello staging:

- owner `root:root`;
- release e directory antenate con permessi `0700`;
- directory interne `0700` e file `0600`;
- `168` file sorgente/runtime piu `SHA256SUMS`;
- SHA-256 del manifest: `9b1911ae938b637221361940e8d0ecba019bbdf1e4e0bac8b263c7957fc4c7b1`;
- confronto byte-per-byte del manifest locale e remoto: `PASS`;
- verifica `sha256sum --status -c SHA256SUMS`: `PASS`;
- matrice di certificazione schema `3`, binding SHA-256
  `45712f686dd521fc739929a985d7a56ccc44ef6264023db3014cf8dce2da66e7`:
  `PASS`;
- zero symlink, hardlink o entry non regolari;
- nessun `node_modules`, unita systemd, report, evidenza, registry runtime,
  chiave, certificato o log privato;
- nessun link `current`, servizio o processo e stato creato o attivato.

L'allowlist contiene contratti e configurazioni pubbliche, matrice certificata,
sorgenti condivisi, sorgenti e `dist` Raspberry, i soli runner e test B4,
lockfile e runbook B4. Il manifest e interno alla release e non contiene dati
del dispositivo.

## Release Superata

La prima fotografia resta conservata senza modifiche nel percorso:

```text
/opt/cassav5bt-bluetooth-lab/releases/20260805-b4-readiness
```

Il suo manifest conserva SHA-256
`05754c62c117b741bba5dfeda83811ac3fe9faee7355ed0552327890d030c642`,
ma la release e `SUPERSEDED`: precede la matrice schema `3`, il relativo
verifier/consumer e il collector B4 schema `2`. Non deve essere usata per
preflight, test, runner o evidenze. Non deve essere aggiornata, sovrascritta o
rimossa per costruire la release successiva.

## Procedura Di Ripresa

Questa sequenza deve essere eseguita soltanto quando la fase fisica e stata
autorizzata.

1. Acquisire nuovamente in sola lettura stato, PID logico, contatore restart e
   timestamp monotoni del servizio principale e di `bluetooth.service`.
2. Verificare che il percorso termini esattamente in
   `20260805-b4-readiness-matrix3-r2`, sia ancora `root:root`, `0700`, non sia
   un symlink e non sia referenziato da alcuna unita. Rifiutare esplicitamente
   la release `20260805-b4-readiness` superata.
3. Verificare da dentro la release `SHA256SUMS` con `sha256sum --status -c`.
4. Confrontare il manifest della release con quello prodotto dalla stessa
   allowlist del workspace. Un solo mismatch invalida lo staging: creare una
   release nuova, senza sovrascrivere questa.
5. Materializzare eventuali dipendenze soltanto dentro la release e da
   `package-lock.json`, con lifecycle script disabilitati. Non riusare o
   copiare `node_modules` dal vecchio albero.
6. Eseguire controlli TypeScript e test offline nella release. Non eseguire i
   runner fisici durante questo preflight.
7. Ricontrollare servizi e adapter: stessi processi logici, zero restart,
   `Discovering: no` e zero advertiser attivi.
8. Avviare B4.3 soltanto dopo i prerequisiti formali e con monitor continui gia
   attivi. Conservare log ed evidenze fuori dalla release, in una directory
   privata dedicata.
9. Non inizializzare o ricostruire il vecchio ledger. La nuova raccolta deve
   partire da uno stato privato `0/10` e acquisire ogni hardware una sola volta.
10. A fine cattura verificare cleanup completo prima di consegnare report e log
    al collector. B4.3 non promuove B4 e B4.4 resta chiusa fino a dieci hardware
    distinti validi.

## Divieti Operativi

- nessun `systemctl start`, `stop`, `restart`, `enable` o `daemon-reload`;
- nessun collegamento simbolico o alias `current` verso la release;
- nessuna modifica al vecchio albero Bluetooth;
- nessuna copia del registry o delle chiavi dentro la release;
- nessun riuso o ricostruzione delle evidenze storiche mancanti;
- nessun runner B4 prima dell'autorizzazione della fase fisica.

## Stato Gate

La preparazione dello staging e una misura di readiness e non e evidenza
fisica. B4 resta `PENDING`; B5 e B6 restano chiusi. L'avanzamento ufficiale
della roadmap non cambia.
