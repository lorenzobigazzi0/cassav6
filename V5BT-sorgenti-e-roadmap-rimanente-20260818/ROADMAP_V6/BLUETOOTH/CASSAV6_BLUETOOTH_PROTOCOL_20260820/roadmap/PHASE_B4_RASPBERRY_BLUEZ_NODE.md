# B4 — Nodo Raspberry BlueZ

Processo separato:

```text
cassav6-bluetooth-node
```

Responsabilità:

- scan degli advertisement Android;
- peer registry volatile;
- BLE advertise server role;
- GATT service;
- autenticazione device;
- bridge futuro verso backend;
- metriche D-Bus/BlueZ.

Il processo non contiene business logic POS.

## Stato implementativo al 2026-07-20

B4.1, core lifecycle e discovery, e implementato:

- configurazione fail-closed, con feature disabilitata e dry-run attivo per
  default;
- macchina a stati unica del processo;
- porta BlueZ iniettata e testabile;
- scanner che accetta soltanto il Service Data UUID v1;
- riuso del `PeerDirectoryV1` canonico B2;
- pruning periodico posseduto dal lifecycle;
- metriche esplicite per osservazioni, errori, peer e cleanup;
- test deterministico di 10 peer consecutivi e zero listener/timer residui.

B4.2, binding scanner D-Bus, e implementato:

- risoluzione esatta di `/org/bluez/hci0` tramite `ObjectManager`;
- verifica fail-closed di `Adapter1.Powered`;
- filtro discovery BlueZ `Transport=le` + `DuplicateData=true`;
- una sola subscription bus-wide per `InterfacesAdded`,
  `InterfacesRemoved` e `PropertiesChanged`;
- normalizzazione e copia difensiva di RSSI e ServiceData;
- filtro UUID locale autorevole; BlueZ 5.82 non inoltra in modo affidabile
  advertisement con UUID presente soltanto in `ServiceData` quando si usa il
  filtro discovery `UUIDs`;
- recovery serializzato e backoff deterministico dopo restart di BlueZ;
- stop idempotente e cleanup verificato di sessione e match rule;
- metriche D-Bus senza indirizzi Bluetooth o payload.

B4.3, callback ServiceData fisica, e implementato e verificato:

- runner fail-closed da 90 secondi con report redatto e hash del log sorgente;
- un Palmare Advanced fisico `handheld` osservato end-to-end;
- 259 osservazioni accettate, zero rifiuti e zero errori;
- RSSI, manutenzione e rimozione reale di uno stream scaduto misurati;
- cleanup finale con discovery, D-Bus, match rule, cache e retry a zero;
- 25 test del nodo passati.

B4.4, harness del gate a 10 device, e implementato:

- collector progressivo workstation con stato atomico, lock, deduplica HMAC
  dell'hardware e staging privato delle coppie B4.3;
- preflight ADB non mutante che rifiuta hardware gia acquisito prima del run
  Raspberry da 90 secondi;
- collector incapace per contratto di promuovere B4, anche a raccolta 10/10;
- manifest privato esatto con collector report e 10 coppie report/log B4.3;
- rivalidazione completa di ogni log e legame SHA-256 col report;
- corrispondenza obbligatoria degli stessi hash nei due livelli;
- correlazione alias -> identita soltanto in memoria tramite registry B1;
- rifiuto di identita duplicate, revocate, ambigue o non autorizzate;
- controllo di acquisizioni sequenziali non sovrapposte e cleanup per slot;
- report finale redatto senza NodeId, alias, MAC, seriali, path o payload;
- 17 test del collector e 14 test del gate autorevole passati localmente;
- suite completa del nodo: 39/39 PASS sia localmente sia su ARM64.

## Stato gate al 2026-08-06

Il gate B4 resta `PENDING`: il ledger autorevole corrente contiene `2/10`
dispositivi fisici distinti e richiede altri otto hardware controllati.
Rotazioni degli alias non vengono conteggiate come dispositivi. Gli otto slot
simulati dal runner offline restano `NON_GATE_EVIDENCE`, contano `0` verso il
gate e non sono persistiti nel ledger.

Advertiser Raspberry, GATT, autenticazione, sessioni e bridge backend non
vengono anticipati da questa simulazione. Il gate autorevole verra eseguito
soltanto dopo dieci acquisizioni fisiche monitorate valide e distinte.
