# B5 hundred-session gate preparation

Data: 2026-08-03

## Esito

```text
Build Lab Palmare B5.7: PASS
Build Lab Postazione B5.7: PASS
Validatore 100 sessioni: PASS locale
Collector riprendibile: PASS locale
Monitor ADB continuo: PASS locale
Self-test validatore: PASS, gate fisico PENDING
Gate fisico B5.7: PENDING
Gate B5 100 sessioni: PENDING
B6: NON AVVIATA
```

## Build Android

Entrambe le app sono state compilate con Lab, diagnostica, identita,
discovery, failover, client GATT, HELLO, mutual auth, chiave di sessione e
heartbeat attivi. `DirectServer` e `PeerLink` sono rimasti disattivati.

```text
Palmare Advanced 1.0.36 code 37: 180/180 test, lint 0 errori
Postazione Advanced 2.0.22 code 24: 176/176 test, lint 0 errori
```

Artefatti e checksum sono registrati in `artifacts/` alla root V5BT.

## Validatore campagna

`raspberry/scripts/run-b5-hundred-session-gate.mjs` consuma il manifest con
gli slot esatti `001`..`100`, lo state collector schema v2 e l'attestazione
Android. Ogni slot deve puntare a un report B5.7 fisico, redatto, univoco e
ordinato. State, digest, metadati, commitment e finestra monitor devono
appartenere alla stessa campagna.

L'output espone solo totali aggregati. Non include commitment, UUID, record ID,
dettagli per sessione, path, identificatori, indirizzi, payload o materiale
crittografico. Il self-test usa esclusivamente fixture sintetiche e non puo
promuovere il gate fisico.

## Collector della campagna

`raspberry/scripts/collect-b5-direct-control-session.mjs` gestisce gli slot
`001`..`100` senza accettare JSON esterni o runner sostitutivi. Ogni
`--capture` invoca direttamente il runner B5.7 e l'advertiser transitorio,
controlla che i servizi restino invariati e registra il report soltanto dopo
una chiusura fisica valida.

Ogni invocazione riserva nello state privato un `bootId` CSPRNG tra 1 e 255,
diverso dal precedente e condiviso esclusivamente tra runner e advertiser.
Stati legacy vuoti vengono migrati atomicamente; stati legacy con record sono
rifiutati. `--preflight` non usa la radio e non muta lo state.

Stato, lock, journal, evidenze e manifest sono privati. Le scritture usano
file temporaneo, `fsync` e rename; lock kernel distinti proteggono lo stato e
l'adattatore fisico. Il journal elimina gli artefatti pre-commit di una
transazione interrotta, mentre un commit gia presente viene soltanto
rivalidato e ripulito. L'output opzionale viene prevalidato prima di ogni
commit e il `fsync` della directory e obbligatorio. Stato e
finalizzazione rivalidano tutti i file staged, i digest, il target, l'ordine
temporale e le finestre non sovrapposte. Il collector non emette mai il PASS
del gate e B6 resta `PENDING`.

Il report redatto non costituisce da solo un'attestazione hardware
crittografica. Il collector elimina l'import manuale e lega ogni slot alla
propria invocazione del runner, ma la revisione finale deve comunque verificare
che la campagna sia stata eseguita sul Raspberry controllato.

## Monitor Android

`scripts/run-b5-android-continuity-monitor.mjs` cattura una baseline privata e
osserva l'intera campagna con ADB a seriale fisso. Verifica package, versione,
SHA-256 APK, Android user, UID, PID, foreground service, reporter GATT/Agent,
lifecycle Agent, sessione autenticata e nuovi crash, ANR o reason 10.

Il risultato esportabile e una attestazione redatta legata a
`sha256(campaignRunId)`. Non contiene seriale, account, PID, UID, path, body dei
reporter o materiale di enrollment. Un gap, logout, restart, cambio target o
interruzione del monitor impedisce il PASS.

## Verifiche

```text
Protocollo direct-control: 12/12 PASS
Suite B5.7 Raspberry/GATT mirata: 23/23 PASS
Test validatore 100 sessioni: 28/28 PASS
Test collector: 26/26 PASS
Test monitor Android: 17/17 PASS
Test hook, abort, deadline e cleanup runner fisico: 18/18 PASS
Suite Raspberry completa con build TypeScript: 156/156 PASS
Validatore contratti: 17/17 PASS
Advertiser Python: 7/7 PASS
Matrice certificazione: 3/3 PASS
Inventario manifest bidirezionale: 4/4 PASS
```

## Blocco fisico

Raspberry e device Android sono disconnessi. Non sono stati eseguiti deploy,
installazioni o prove radio. Alla riconnessione si eseguono inventario
read-only, B0-B3 e rivalidazione B4. Durante l'attesa dei dieci hardware B4 e
consentito un solo pilot diagnostico con state separato; non conta nella
campagna. Soltanto dopo PASS B0-B4 si inizializzano monitor e state ufficiali
per i 100 record committed. B6 resta fuori scope fino al PASS e alla revisione
indipendente di B5.
