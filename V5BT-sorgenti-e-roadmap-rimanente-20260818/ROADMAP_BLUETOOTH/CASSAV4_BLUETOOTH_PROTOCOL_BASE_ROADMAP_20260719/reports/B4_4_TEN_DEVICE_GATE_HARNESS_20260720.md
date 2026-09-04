# B4.4 Ten-Device Gate Harness

Data: 2026-07-20

## Decisione

- Harness autorevole per 10 device fisici distinti: IMPLEMENTATO
- Test mirati del runner autorevole: 14/14 PASS
- Test mirati del collector progressivo: 17/17 PASS
- Suite completa nodo Raspberry locale e ARM64: 39/39 PASS
- Gate fisico B4 con 10 dispositivi reali: PENDING
- B5 sessione diretta GATT: non iniziata

Non e stato creato un report fisico B4.4: al momento e disponibile un solo
Palmare Android controllato e dieci rotazioni alias dello stesso telefono non
sono dieci device.

## Evidenza fisica corrente

Il collector privato contiene una sola acquisizione valida:

- progresso: 1/10 device fisici distinti;
- 255 osservazioni accettate;
- lifecycle osservato: 89983 ms;
- finestra wall-clock: 90119 ms;
- una sola identita B1 attiva disponibile sul Raspberry;
- retry della stessa evidenza verificato come idempotente.
- preflight reale sullo stesso hardware: `NOT_ELIGIBLE`, senza mutare stato.

Questi dati non promuovono il gate: il collector resta non autorevole e il
runner finale non e stato eseguito su un manifest completo.

## Implementazione

Il runner e:

```text
raspberry/scripts/run-b4-ten-device-gate.mjs
```

Il collector progressivo e:

```text
scripts/collect-b4-physical-device.mjs
```

Il runner non puo promuovere B4 senza il report finale del collector e senza
che i dieci hash report/log coincidano in entrambi i livelli di verifica.

Consuma un manifest privato con dieci coppie report/log B4.3. Per ogni slot:

1. riapre report e log come file regolari owner-only;
2. ricalcola lo SHA-256 del log;
3. esegue nuovamente `evaluateNodeLog(...)`;
4. confronta integralmente il report salvato con il risultato ricalcolato;
5. ricava gli alias finali esclusivamente in memoria;
6. usa `DeviceRegistryV1.deriveRotatingAliasForNode(...)` per risolvere una
   sola identita attiva.

L'aggregatore rifiuta:

- meno o piu di dieci acquisizioni;
- slot disordinati, path traversal, file duplicati o evidenze riutilizzate;
- acquisizioni sovrapposte;
- alias non autorizzati, ambigui o appartenenti a piu device;
- due slot riconducibili allo stesso NodeId;
- evidenze B4.3 troppo brevi, manomesse o senza cleanup.

## Confine privacy

Il NodeId serve soltanto come chiave privata temporanea per il controllo di
unicita. Il report B4.4 conserva:

- numero slot;
- hash di report e log;
- durata e metriche aggregate;
- node kind Android;
- esito di identita risolta e cleanup.

Non conserva NodeId, alias, aliasKey, MAC, bootId, seriale, percorso del
registry, percorsi delle evidenze o payload. Una seconda barriera ricorsiva
rifiuta il report se trova campi o valori privati.

## Gate

Il self-test verifica solo il comportamento del runner e dichiara
esplicitamente:

```text
physicalEvidenceConsumed = false
privateRegistryAccessed = false
b4GatePromoted = false
b5Started = false
```

B4 resta `PENDING` fino alla raccolta fisica di dieci device Android distinti.
