# B5 Offline Evidence Binding - 2026-08-03

## Esito

Il terzo giro offline rende fail-closed il legame tra campagna, risultato
tecnico e futura promozione. Il gate tecnico non pubblica piu un aggregato
isolato: produce una coppia immutabile aggregate/receipt, mentre il promotion
gate richiede e rivalida entrambi.

Nessun hardware e stato contattato. Non sono stati eseguiti ADB, SSH,
Bluetooth, letture UPS, installazioni, deploy o operazioni su servizi reali.
Fixture e test locali non costituiscono evidenza fisica. B5 e B6 restano
`PENDING` e l'avanzamento ufficiale resta **49%**.

Le API business, il server operativo, il database e le build normali delle app
non cambiano.

## Receipt Tecnico Privato

Il contratto esatto e
`contracts/b5-technical-receipt-v1.schema.json`; parser e builder condivisi
sono in `scripts/b5-technical-receipt.mjs`.

Il receipt schema v1 conserva soltanto hash e commitment. Non esporta il
`campaignRunId`, identificatori, indirizzi, path o materiale crittografico. I
suoi binding obbligatori sono:

| Campo | Evidenza impegnata |
| --- | --- |
| `technicalAggregateSha256` | byte esatti dell'aggregato tecnico |
| `collectorStateSha256` | byte esatti dello state collector v2 |
| `campaignAuthorizationSha256` | byte esatti dell'autorizzazione B0-B4 |
| `certificationMatrixSha256` | byte esatti della matrice certificata |
| `androidAttestationSha256` | byte esatti dell'attestazione Android |
| `raspberryAttestationSha256` | byte esatti dell'attestazione Raspberry |
| `campaignIdCommitmentSha256` | campagna privata |
| `collectionCommitmentSha256` | raccolta finalizzata |
| `attemptLedgerHeadSha256` | testa della hash-chain dei tentativi |
| `prerequisiteEvidenceBundleSha256` | bundle B0-B4 autorizzato |
| `operatorCommitmentSha256` | operatore autorizzato |

Il receipt dichiara soltanto `b5TechnicalGate: PASS`,
`b5HundredSessionGate: PENDING_REVIEW` e `b6: PENDING`.

## Pubblicazione Tecnica

`raspberry/scripts/run-b5-hundred-session-gate.mjs` richiede ora anche:

```text
--technical-receipt PRIVATE-RECEIPT.json
```

`--output` e `--technical-receipt` devono essere path distinti, nuovi e nella
stessa directory privata. Il gate prepara i due documenti con permessi `0600`,
li pubblica come coppia e fa rollback degli artefatti parziali se il secondo
link non puo essere creato. Un file gia presente non viene sovrascritto.

L'aggregato resta redatto e non contiene i commitment privati. Il receipt ne
impegna i byte esatti e conserva separatamente i binding necessari alla
promozione.

## Promozione Fail-Closed

`raspberry/scripts/run-b5-promotion-gate.mjs` richiede sempre:

```text
--technical-aggregate PRIVATE-TECHNICAL.json
--technical-receipt PRIVATE-RECEIPT.json
--campaign-state PRIVATE-COLLECTOR.json
--campaign-authorization PRIVATE-AUTHORIZATION.json
--review-attestation PRIVATE-REVIEW.json
--output PRIVATE-PROMOTION.json
```

Il parser dell'aggregato tecnico accetta solo il set esatto di campi e di
strutture annidate. Campi extra, mancanti, valori non canonici o sezioni
parziali vengono rifiutati. La promozione ricalcola gli hash sui byte ricevuti,
rivalida receipt, state, autorizzazione e matrice e impedisce che un aggregato
valido di una campagna venga sostituito in un'altra.

Receipt assente, alterato o non coerente lascia
`b5HundredSessionGate: PENDING`. La review indipendente resta un passaggio
successivo e distinto; soltanto una promozione completa puo produrre PASS B5.
B6 resta comunque `PENDING`.

## Copertura Completa Dei Tentativi

Il gate usa la finestra del ledger
`attemptLedger.coverageFromMs..coverageUntilMs`. Entrambe le attestazioni
devono iniziare non dopo il primo tentativo e terminare non prima dell'ultimo.
La verifica include quindi timeout, sospensioni e riprese, anche quando si
trovano prima del primo o dopo l'ultimo record `COMMITTED`.

L'autorizzazione B0-B4 deve essere stata emessa prima del primo tentativo. Il
monitor Android accettato per la campagna ufficiale deve attestare esattamente
il ruolo `handheld` e il package Palmare certificato.

Una regressione del clock scoperta dal supervisor durante `--resume` produce
`INVALIDATED`; il ledger non viene riattivato.

## Monitor E Recovery

Android e Raspberry calcolano il calendario come
`ceil(durationMs / pollMs) + 1` e clampano l'ultima scadenza a `durationMs`.
Una durata non divisibile per il poll conserva quindi sia il campione iniziale
sia quello al termine esatto della finestra.

Ogni monitor pubblica due artefatti:

- risultato completo privato;
- attestazione redatta.

La coppia e protetta da un journal privato schema v1 con path
`<private-output>.publication-v1.journal.json`. Il journal lega monitor,
campagna, destinazioni, documenti e SHA-256. Dopo un'interruzione, la stessa CLI
recupera i file mancanti, rivalida entrambi e rimuove il journal solo a commit
completo. Symlink, hardlink, digest discordanti, path cambiati o file esistenti
senza journal falliscono chiusi.

## Verifica Offline Eseguita

Le suite mirate coprono:

- sostituzione cross-campaign di aggregate e receipt;
- receipt assente, alterato, incompleto o non coerente;
- parser aggregato con campi extra o mancanti;
- rollback e divieto di overwrite della coppia tecnica;
- tentativi fuori dalla precedente finestra dei soli commit;
- ruolo Android diverso da `handheld` e autorizzazione tardiva;
- durata monitor non divisibile, clamp finale e conteggio dei campioni;
- crash tra le due pubblicazioni, recovery e journal alterato;
- regressione clock durante `--resume`.

Risultati consolidati:

```text
Suite Raspberry + TypeScript: 196/196 PASS
Gate tecnico B5:               33/33 PASS
Promotion gate B5:             12/12 PASS
Supervisor B5:                 18/18 PASS
Monitor Android:               21/21 PASS
Monitor Raspberry:             19/19 PASS
Blocco mirato terzo giro:     103/103 PASS
Suite shared:                 128/128 PASS
Scripts roadmap:     111 PASS, 2 SKIP, 0 failure
Contratti JSON:                20/20 PASS
Advertiser Python:              7/7 PASS
Workspace:                     27/27 PASS
```

I due SKIP riguardano soltanto il log storico B4 dichiarato come evidenza
esterna assente. Nessun risultato sintetico puo aumentare la percentuale
ufficiale o promuovere B5.

## Ripresa Fisica

Alla riconnessione si applica il runbook aggiornato: inventario read-only,
ripristino dei gate B0-B4, autorizzazione precedente al primo tentativo, due
monitor continui, supervisor e finalizzazione `100/100`. Il gate tecnico deve
produrre aggregate e receipt nella stessa directory privata; la review usa
quella coppia immutata. B6 rimane chiusa fino alla promozione formale di B5.
