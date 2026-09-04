# V5BT B4 Matrix 3 And Ledger Initialization

Data: 2026-08-05

## Scopo

Questo report pubblico redatto documenta la preparazione del prossimo passo
fisico B4. Non contiene seriali ADB, identita di enrollment, indirizzi di
rete, hostname, percorsi privati, chiavi o log grezzi. Non costituisce evidenza
radio e non promuove alcun gate.

## Inventario Read-only

- due Palmare Android sono collegati e autorizzati;
- entrambi eseguono Palmare Advanced `1.0.39` code `40` sul profilo Android
  previsto;
- package, versione, code, APK certificato, firma e stato enrollment sono
  coerenti con la matrice;
- i due Palmare mantengono identita distinte;
- il tablet Postazione certificato non e disponibile;
- nessuna installazione, cancellazione dati o nuova enrollment e stata
  eseguita in questo passo.

## Matrice Certificata

La matrice passa allo schema `3`. Per ogni ruolo vincola package ID, versione,
version code, SHA-256 dell'APK e SHA-256 del singolo certificato di firma. Il
binding canonico della matrice e:

```text
45712f686dd521fc739929a985d7a56ccc44ef6264023db3014cf8dce2da66e7
```

Il verifier offline usa `apksigner`, rifiuta APK con zero o piu di un
certificato e confronta il digest rilevato con il pin della matrice. I runner
B0 e B2 e l'inventario unico consumano lo stesso contratto, senza duplicare i
target.

## Nuovo Stato B4

E stato inizializzato un nuovo ledger privato del collector:

- schema state `2`;
- binding completo alla matrice schema `3`;
- avanzamento `0/10`;
- permessi state `0600` e directory privata `0700`;
- chiave HMAC casuale privata;
- nessun dato storico importato o ricostruito;
- nessun dispositivo registrato.

Il collector rifiuta schema legacy, matrice mutata, binding incompleto,
symlink, hardlink, manomissione e sovrascrittura. La matrice viene verificata
prima e dopo preflight, record e finalizzazione.

Due preflight non mutanti sono stati eseguiti sui Palmare collegati. Entrambi
hanno restituito `ANDROID_EVIDENCE_STALE`, coerentemente con sessioni
disconnesse e reporter non freschi. Lo SHA-256 del ledger e rimasto identico
prima e dopo le verifiche: nessun tentativo e stato contato e nessuna evidenza
fisica e stata creata.

## Staging Raspberry

Una seconda release Lab inerte e stata preparata dopo il consolidamento della
matrice e del collector:

- `168` file allowlist piu `SHA256SUMS`;
- SHA-256 del manifest
  `9b1911ae938b637221361940e8d0ecba019bbdf1e4e0bac8b263c7957fc4c7b1`;
- manifest locale e remoto identici e verifica SHA-256 completa;
- binding matrice uguale al nuovo ledger;
- owner amministrativo, directory `0700` e file `0600`;
- zero symlink, hardlink, file irregolari o contenuti privati;
- nessun processo, servizio, link attivo o test radio creato.

La fotografia precedente e marcata `SUPERSEDED` e non puo essere usata. Il
servizio principale V5BT e `bluetooth.service` sono rimasti attivi, con stessi
processi logici e zero restart osservati.

## Verifica Offline

- test root: `52/52` PASS;
- test Node roadmap: `320` PASS e `2` SKIP storici attesi;
- suite Raspberry: `196/196` PASS;
- verifica build reale: `10/10` PASS;
- collector B4: `27` PASS e `2` SKIP storici attesi;
- self-test collector: PASS.

## Prossimo Passo Autorizzabile

1. Mantenere un Palmare disconnesso e fermo.
2. Eseguire login sul solo Palmare scelto per il primo slot.
3. Attendere reporter `READY` fresco e verificare nuovamente inventario,
   matrice, servizi e monitor in sola lettura.
4. Eseguire B4.3 per almeno `90` secondi con un solo advertiser autenticato.
5. Solo dopo cleanup completo e validazione, registrare il dispositivo nello
   slot `1/10` del nuovo ledger.
6. Ripetere successivamente sul secondo Palmare per lo slot `2/10`, senza
   riacquisire hardware gia contato.

Il tablet Postazione resta necessario per B0-B3 formali. B4 resta `PENDING`
a `0/10`; B5 e B6 restano chiusi. L'avanzamento ufficiale non cambia.
