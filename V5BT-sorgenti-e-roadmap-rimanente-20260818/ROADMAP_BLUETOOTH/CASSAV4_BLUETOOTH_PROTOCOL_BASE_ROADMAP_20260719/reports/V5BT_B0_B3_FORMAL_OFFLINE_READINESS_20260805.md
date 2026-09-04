# V5BT B0-B3 Formal Offline Readiness

Data: 2026-08-05

## Decisione

Il banco offline e pronto per la ricertificazione formale B0-B3. Nessun gate
fisico e stato promosso: il tablet Postazione certificato non era visibile e
non e stato eseguito alcun aggiornamento Android.

## Inventario Read-Only

- due Palmare autorizzati, Advanced `1.0.39` code `40`, hash certificato e
  enrollment `READY`;
- nessuna Postazione collegata;
- Raspberry raggiungibile, servizio V5BT e Bluetooth attivi, BlueZ `5.82` e
  NTP sincronizzato;
- registry e permessi sensibili coerenti;
- protocollo dati UPS ancora non rilevabile.

Postazione Advanced `2.0.23` code `25` e pronta, integra e coerente con
matrice, Gradle, checksum, firma e sorgenti. Prima dell'installazione il
certificato dell'APK presente sul tablet deve coincidere con quello del target.
Un mismatch impone lo stop senza uninstall, `pm clear`, downgrade o nuova
enrollment.

## B0 Formale

Il nuovo runner formale e separato dal diagnostico a due Palmare. Richiede
seriali distinti e vincola:

- Palmare `SM-A165F` e Postazione `SM-T503`;
- package, versione, code, SHA-256 e matrice certificata;
- scan, advertising, client GATT, server GATT, concorrenza scan/advertise,
  coesistenza Wi-Fi/BLE e foreground/background;
- continuita di versione, utente Android, processo, reporter, sessione,
  clock, polling e servizio, senza crash, ANR o force-stop.

Qualsiasi controllo assente o non PASS produce soltanto
`NON_GATE_EVIDENCE/PENDING`. Il dry-run non accede ad ADB.

## B2 E B3

B2 formale usa ora lo schema `7`: esattamente `100` finestre monotone, una
prima di ogni ciclo, ciascuna con durata osservata e richiesta di almeno
`31.000` ms. Una finestra mancante, breve o incoerente produce
`FORMAL_QUIESCENCE_EVIDENCE_INCOMPLETE`. Il pilot da `20` cicli resta separato
e non promuovibile.

Il runbook B3 e allineato alle build correnti, include il controllo firma
pre-installazione e conserva la durata fisica inderogabile di `3.600` secondi.
Il dry-run B3 e offline e lascia il gate `PENDING`.

## B4

Il riepilogo storico `1/10` non e riprendibile senza stato, chiave ed evidenze
private originali. Non e stato ricostruito o sovrascritto. Una futura
raccolta ripartira in uno stato privato distinto da `0/10`, dopo allineamento
del runtime Lab Raspberry e con un solo advertiser autenticato alla volta.

## Verifica

```text
root:                         49/49 PASS
roadmap Node:                315 PASS, 2 SKIP storici attesi
Raspberry + TypeScript:      196/196 PASS
B0 formale + matrice:         51/51 PASS
B2 self-test schema 7:       151/151 PASS
B3 self-test:                 41/41 PASS
contratti:                    22/22 PASS
```

B0-B5 restano `PENDING`, B6 resta chiusa e l'avanzamento ufficiale resta
**49%**.
