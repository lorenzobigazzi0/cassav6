# Playbook — Audit proattivo write-amplification di secondo livello

> File di supporto a `ROADMAP_REALTIME_CASSAV4_v5_FASE_P.md`. Formalizza come procedura riusabile il pattern
> scoperto ed eseguito con successo in Fase P3 sul dominio ordini (`ORDER_WORKFLOW_METRICS` →
> `ORDER_AUDIT_FASTPATH` → `ORDER_NOTIFICATIONS_FASTPATH` → `ORDER_FULFILLMENT_FASTPATH` →
> `ORDER_INDEX_FASTPATH`), da applicare **proattivamente** ad altri domini prima che lo riveli il load-100,
> invece che reattivamente sotto carico come e' successo per ordini a load-50.

---

## 1. La classe di problema, in una frase

La Fase A (`APP_STATE_DIRTY_TRACKING`) ha eliminato la write-amplification **a livello di stato intero**
(clone+stringify di tutto l'app-state ad ogni mutazione, da MB a KB). P3 ha scoperto che lo stesso pattern
si ripete **dentro un singolo dominio**: quando un dominio ha un sotto-array (storico, indice, notifiche,
audit collegato), una mutazione che tocca un solo elemento puo' comunque risincronizzare l'intero sotto-array
invece del solo elemento cambiato. E' invisibile finche' il dominio non e' sotto carico sufficiente a rendere
quel costo dominante — motivo per cui e' emerso solo ora per gli ordini, a load-50, dopo che tutto il resto
(coda, scheduling, blob intero) era gia' stato risolto.

**Non e' un errore di chi ha scritto il codice originale** — e' la forma naturale in cui degrada un sistema che
e' partito da "un blob JSON intero" e sta migrando a "domini separati": il dominio si separa prima a livello
grosso (es. `integration.orders` come tabella propria), e i sotto-array dentro quel dominio restano a
grana grossa (full-rewrite) finche' qualcuno non se ne accorge sotto carico.

## 2. Come si e' manifestato per ordini (riferimento)

| Sotto-costo | Sintomo | Fix applicato | Guadagno misurato |
|---|---|---|---:|
| `auditRecent` | Riscriveva sempre una finestra fissa di 64 eventi audit | Sync per ID espliciti (`auditEventIds` passati da create/sync) | avg -73% (648→174ms) |
| `integration.notifications` | Riscriveva l'intero array anche per una notifica nuova | Sync per ID (`syncOrderNotificationsFastPath`), full-sync solo fallback | latenza notifiche quasi azzerata |
| `orderFulfillmentHistory` | Risincronizzava tutto lo storico per un solo evento `ready`/`delivered` | Sync dell'evento singolo (`syncOrderFulfillmentHistoryFastPath`) | costo isolato eliminato |
| indice `order_station` | Delete+insert incondizionato ad ogni sync, anche se la postazione non cambiava | Confronto change-aware, riscrive solo se l'indice e' davvero diverso | query -98,6% (56.332→767), tempo medio -71,7% |
| `waiter-pause/status` | Finiva ripetutamente nella coda sbagliata (notification-lane) | Instradamento corretto | 103-108 enqueue ridondanti → 0 |
| `posSettings` (sotto-campo `.tables`) | Full-sync durante ogni update finanziario tavolo | Sync puntuale del solo sotto-campo | rimosso dal costo ordine |

**Pattern comune:** in ognuno di questi casi esisteva gia' l'informazione per fare un update mirato (un ID, un
evento, una chiave), ma il codice usava il path piu' semplice (full resync) perche' all'epoca in cui era stato
scritto il volume non lo rendeva un problema visibile.

## 3. Procedura (4 passi, stessa sequenza usata in P3)

### Passo 1 — Strumentare per label, non genericamente

Prima di ipotizzare dove sia il costo, misurarlo. Riusare lo stesso schema di `ORDER_WORKFLOW_METRICS`:
- `operations.runMsByLabel` per il tempo totale per tipo di mutazione.
- `appState.writeRunMsByLabel` per separare le scritture app-state per dominio/sotto-dominio.
- Per ogni sotto-array del dominio in esame, un label esplicito (es. per prenotazioni:
  `reservations.create.appStateWrite`, `reservations.lockHistory.syncMs` se esiste uno storico lock).

**Non procedere al passo 2 senza numeri.** E' la differenza tra questo playbook e un refactoring speculativo.

### Passo 2 — Isolare il sotto-costo dominante

Con un mini-load (25 e' sufficiente per questo passo, non serve 50) sul dominio in esame, leggere le tabelle
runtime e identificare quale label pesa di piu' in proporzione al totale. Come in P3, aspettarsi che il primo
sotto-costo dominante, una volta risolto, ne riveli un secondo — non fermarsi al primo fix pensando che basti.

### Passo 3 — Fix mirato: sync per ID/chiave invece di full-rewrite

Pattern di fix, sempre lo stesso quattro volte in P3:
- Se l'evento che genera la mutazione conosce gia' l'ID del record cambiato (quasi sempre vero: un lock ha un
  id, una notifica ha un id, un evento storico ha un id), passare quell'ID esplicito al sync invece di
  ricalcolare/riscrivere l'intero sotto-array.
- Mantenere il full-rewrite come **fallback esplicito** per i casi in cui l'ID non e' determinabile (coerente
  con quanto gia' fatto: "mantenuto fallback full sync per casi non identificabili").
- Un test dedicato per ciascun fix: "nessun rewrite se cambia solo X", "rewrite quando cambia davvero Y" —
  stesso schema del test aggiunto in `ORDER_INDEX_FASTPATH`.

### Passo 4 — Rimisurare e decidere se continuare

Confrontare prima/dopo con lo stesso mini-load. Se il guadagno e' significativo ma il dominio resta sopra
soglia, tornare al passo 2 (prossimo sotto-costo). Se il guadagno e' marginale, il costo probabilmente non e'
piu' nella write-amplification di questo dominio — fermarsi qui per questo dominio ed eventualmente investigare
altrove (overhead transazionale, contesa lock, come successo per ordini in `TRANSACTION_METRICS`/`ROLLBACK_CAUSES`).

---

## 4. Domini candidati, in ordine di priorita' per questo audit

L'ordine e' guidato da due segnali: dove si sono gia' osservate le latenze peggiori (P2), e quanto e' probabile
strutturalmente che il dominio abbia sotto-array soggetti allo stesso pattern.

### 4.1 — Prenotazioni (`posReservationStates`, `posReservationLocks`) — priorita' alta

**Perche' per prima:** `reservation.create` aveva p95 17.294ms e p99 53.139ms gia' a **25 palmari** (P2), prima
ancora di arrivare a 50 — il segnale piu' forte di tutti i domini non-ordine. E' anche il dominio con la storia
piu' complessa di lock/stati (J0-J7), quindi il candidato piu' probabile ad avere sotto-strutture (storico
lock, storico stato) trattate a grana grossa.

**Cosa cercare:** un eventuale storico/log delle transizioni di stato prenotazione (se esiste, verificarne il
pattern di sync); il meccanismo di lock acquire/release (J2/J3) sotto burst — un lock e' per natura ad alta
frequenza di scrittura-rilascio, il candidato ideale per lo stesso tipo di full-rewrite invisibile.

### 4.2 — Tavoli/Sale (`tableLocks`, `posRoomChangeRequests`) — priorita' alta

**Perche':** `table.move` aveva p95 194.720ms a 25 palmari — il numero peggiore in assoluto osservato in tutto
il programma, anche se in gran parte gia' spiegato e attenuato dal fix `ROOM_LANE_PRESSURE_PRIORITY_DEPTH`
(schedulazione, non write-amplification). Vale comunque la pena verificare se, **oltre** al problema di
scheduling gia' risolto, esiste anche una componente di write-amplification analoga a quella di ordini — i due
problemi possono coesistere, come e' successo per ordini stessi (scheduling risolto in L, write-amplification
di secondo livello trovata solo dopo in P3).

**Cosa cercare:** `posRoomChangeRequests`/`table-room-move` hanno un ciclo di vita a piu' stadi (request →
pending → resolve, J10-J14) — ogni transizione potrebbe risincronizzare piu' del necessario.

### 4.3 — Pagamenti/Fiscale (`paymentContainers`, `paymentParts`, `paymentTransactions`, `fiscalReceipts`) — priorita' media-alta

**Perche' non massima nonostante la delicatezza:** `payment.free_split` aveva p95 14.639ms a 25 palmari — alto
ma meno estremo di tavoli/prenotazioni. E' pero' il dominio con piu' outbox/idempotency collegati (K4-K7,
K-PRE.3), quindi un eventuale fastpath qui va scritto con la stessa cautela gia' usata in K6/K7 (concorrenza
reale, non solo sequenziale, come da `concurrency-harness.mjs` gia' disponibile da K-PRE.2).

**Cosa cercare:** `payment_parts` sotto split libero (piu' righe per uno stesso container) e' strutturalmente
simile a `orderFulfillmentHistory` (piu' elementi che si accumulano nel tempo su un aggregato) — stesso
sospetto di full-rewrite quando se ne aggiunge uno.

### 4.4 — Notifiche/Stato postazione (`stationStateLane`, notifiche generiche) — priorita' bassa

**Perche' bassa:** il caso specifico di `waiter-pause/status` e' gia' stato trovato e risolto durante il lavoro
su ordini (era un effetto collaterale del fastpath ordini, non un problema nativo di questo dominio). La Fase
F (scoped reads, giugno) aveva gia' lavorato a fondo su questo dominio prima ancora che iniziasse il filone K-P,
quindi il rischio residuo e' stimato piu' basso — ma vale un controllo rapido (passo 1-2 del playbook, senza
necessariamente arrivare al passo 3) per conferma, non per assunzione.

---

## 5. Quando fermarsi

Questo playbook non ha un punto di completamento assoluto — e' una pratica, non un progetto con fine definita.
Criterio pratico per questo ciclo (prima di P4):
- Passo 1-2 eseguiti su tutti e quattro i domini di §4.
- Passo 3-4 (fix) eseguiti dove il passo 2 ha rivelato un costo dominante chiaro (analogo ai fastpath ordini).
- Dove il passo 2 non rivela nulla di dominante, si registra il risultato negativo (e' informazione utile:
  "verificato, non e' li' il collo") e si passa al dominio successivo — non si forza un fix dove non serve.

Il segnale per fermarsi del tutto, per ora, e' arrivare a P4 (load-100) con questi quattro domini gia'
verificati almeno al passo 2: se emergono ancora sotto-costi nuovi a 100 che non erano visibili a 25-50, quello
diventa lavoro di P4 stesso con lo stesso playbook, non un fallimento di questo ciclo.

---

## Appendice — Checklist rapida per singolo dominio

```text
[ ] Passo 1: label runtime aggiunti per il dominio (operations.runMsByLabel, appState.writeRunMsByLabel)
[ ] Passo 1: mini-load 25 eseguito con le nuove metriche attive
[ ] Passo 2: sotto-costo dominante identificato (nome label + % del totale) OPPURE
[ ] Passo 2: nessun sotto-costo dominante trovato (registrare come verificato-negativo)
[ ] Passo 3: fix scritto (sync per ID/chiave, fallback full-sync esplicito mantenuto)
[ ] Passo 3: test "nessun rewrite se non serve" + "rewrite quando serve davvero" aggiunti
[ ] Passo 4: mini-load 25 ripetuto, numeri prima/dopo documentati
[ ] Passo 4: se guadagno marginale, fermarsi qui per questo dominio e annotare il motivo
```

Da compilare una volta per ciascuno dei quattro domini di §4, come documento `FASE_P3_SWEEP_<DOMINIO>.md`
nello stesso stile degli altri documenti FASE gia' prodotti, cosi' resta tracciabile con lo stesso standard.
