# Roadmap Near-Real-Time — CASSAv4 — v5 (Fase P: completamento validazione)

> Continuazione diretta dopo la chiusura verificata di K-PRE, K, L, M, N, O (pacchetto
> `CASSAv4-current-P3-20260703-142146`). La struttura pianificata e' completa. Questo documento copre
> **solo** cio' che resta: chiudere P3, poi P4 (load-100), P5 (endurance 90 minuti), P6 (chaos), P7 (go/no-go).
> Va letto insieme a `PLAYBOOK_DOMAIN_WRITE_AUDIT.md` (file di supporto separato), che formalizza come
> pattern riusabile la classe di problema appena scoperta in P3.

---

## 0. Perche' P e' diversa dalle fasi precedenti

K, L, M, N erano pianificabili in anticipo con sotto-fasi fisse (K0...K7, L1...L3) perche' il lavoro era
"portare dominio X a write-primary relazionale", sempre la stessa forma. **P non ha questa forma.** P e' un
ciclo *misura → isola il sotto-costo dominante → fixa → rimisura*, dove ogni passo dipende dal risultato del
run precedente — non e' prevedibile in anticipo quale sotto-costo emergera'. I documenti P3 letti finora lo
confermano: ogni fix ha rivelato il successivo (indice postazione → audit → notifiche → fulfillment history →
waiter-pause → posSettings → overhead transazionale MySQL → deadlock/retry → debounce riconciliazione →
batching indice). Questo documento non prescrive quindi "P3.7, P3.8..." con contenuto fisso, ma un **protocollo
di uscita** per P3 e la sequenza dei macro-passi successivi (P4-P7), che quella si' e' prevedibile.

## 1. Cosa e' stato verificato (recap K→O)

| Fase | Esito verificato |
|---|---|
| K-PRE (14 sotto-fasi) | Complete. **K-PRE.4.1 ha trovato un bug reale**: `payment_completed` pubblicato con fiscale POS ancora `PENDING`/retry su tutti e tre gli endpoint — corretto in K-PRE.4.2 con stato `PENDING_FISCAL` esplicito |
| K0-K7 | Complete, gate finale 976/976 test verdi. `fiscal_receipts.attempt_scope` implementato come da roadmap |
| L1-L3 | Mutex sciolto nell'ordine pianificato (ordini→tavoli/sale→pagamenti), flag `LANE_CROSS_EXCLUSION_*` a default conservativo `1`, metrica `crossDomainConcurrencyFamiliesActive` presente. **Nessun canary reale eseguito in questa fase** — dichiarato esplicitamente in tutti e tre i documenti |
| M1-M6 | Complete |
| N1-N3 | State machine pagamento/ordine/stampa implementate, **default-on** (a differenza del pattern "flag OFF" seguito rigorosamente in K/L — vedi §5.1) |
| O | `ADR-0002` prodotto, roadmap riconciliate, decisione confermata: modular monolith |
| P0 | Preflight completo: profili, soglie di accettazione, simulatori pronti |
| P1 (10 palmari) | Pulito: 0 errori, code vuote |
| P2 (25 palmari) | Funzionalmente corretto ma **latenze non accettabili**: `table.move` p95 194.720 ms (quasi 195s), `payment.free_split` p95 14.639 ms, `reservation.create` p95 17.294 ms |
| P3 (50 palmari) | **In corso, non chiusa.** Vedi §2 |

## 2. Stato dettagliato di P3 al momento dell'export

**Sequenza reale (ordine cronologico dei documenti), con cio' che ognuno ha scoperto:**

1. `LOAD50_DIAGNOSTICA`: order-lane satura, codemedia 33-53s, coda fino a 63. Fix scheduling (`ROOM_LANE_PRESSURE_PRIORITY_DEPTH`, `ORDER_SYNC_FAST_LANE_CONCURRENCY` 4→6/cap 8) — **non sufficiente da solo**.
2. `ORDER_WORKFLOW_METRICS`: strumentazione per-label (`operations.runMsByLabel`, `appState.writeRunMsByLabel`).
3. `LOAD50_FASTPATH`: trovato e corretto `waiter-pause/status` mal instradato (103-108 enqueue ridondanti →0) e `posSettings` risincronizzato per intero durante update finanziari tavolo (ora sync puntuale `.tables`). Riduzione reale ma insufficiente da sola.
4. `ORDER_AUDIT_FASTPATH`: `auditRecent` da full-window-64 a sync per ID espliciti. `orders.create.auditRecent` avg 647.95ms→173.95ms (-73%).
5. `ORDER_NOTIFICATIONS_FASTPATH`: `integration.notifications` da full-rewrite a sync per ID.
6. `ORDER_FULFILLMENT_FASTPATH`: `orderFulfillmentHistory` da full-rewrite a sync dell'evento singolo.
7. `ORDER_INDEX_FASTPATH`: indice `order_station` da delete/insert incondizionato a change-aware.
8. `DOMAIN_SPLIT_METRICS`/`TRANSACTION_METRICS`: isolato l'overhead residuo in `entries.total` (~222-250ms avg) tra `ensure`/`getPool`/`getConnection`/`beginTransaction`/`commit`/`rollback`, nessuno singolarmente dominante (~10-50ms ciascuno) — il costo e' **distribuito**, non concentrato.
9. `ROLLBACK_CAUSES`: **trovati 89 deadlock che diventavano HTTP 500 verso l'utente** sotto burst. Corretto con retry controllato su transient/deadlock limitato alle route order-lane. Anomalie finali 91→0, **ma** durata run 227s→338s e latenze aumentate: il retry assorbe la contesa, non la riduce.
10. `STATION_RECONCILIATION_BACKPRESSURE`: debounce riconciliazione postazione. Attesa massima osservata 287s→**2,2s**.
11. `ORDER_INDEX_BATCH` (piu' recente, 12:20): run "clean-final" — 0 rollback (da 161), 0 failure, code finali 0/0. Restano 2 retry transient non piu' nello stage indice. Nota di chiusura: *"il prossimo collo architetturale e' ridurre le write full-domain residue o separare ulteriormente le pre-write app-state generali"*.

**Sintesi onesta:** la correttezza e' stata riportata a zero anomalie nel run piu' recente. La **latenza** resta sopra soglia (`orders/create`/`orders/sync` appStateWrite avg ancora 400-900ms a seconda del run, contro un target p95 di 300ms) e il **meccanismo di recupero deadlock e' un retry, non un'eliminazione della contesa** — lo dice il documento stesso.

## 3. Principi guida specifici per chiudere P

- **Non dichiarare verde un numero che non lo e'.** Il team ha gia' dimostrato questa disciplina interrompendo run manualmente — questo documento la formalizza come criterio esplicito di uscita (§4), non solo come buona pratica.
- **Distinguere "assorbito" da "eliminato".** Il retry su deadlock (passo 9) e' la scelta giusta per la produzione nel breve termine (nessun errore utente), ma resta un cerotto. Prima di P4 va capito **cosa** genera i 145-147 retry residui — quale scrittura specifica contende con quale — non solo continuare ad assorbirli meglio.
- **La write-amplification di secondo livello non e' un problema di "ordini"**, e' una classe di problema (array JSON risincronizzati per intero quando cambia un solo elemento) che finora e' stata cercata *solo* nel dominio ordini perche' e' quello che ha saturato per primo. Prima di salire a load-100, va cercata proattivamente anche altrove — vedi `PLAYBOOK_DOMAIN_WRITE_AUDIT.md`.
- **Le state machine N1-N3 sono default-on**, diversamente da K/L che erano rigorosamente default-off con canary. Vale la pena una verifica esplicita (§5.1) prima di P4, non perche' ci sia un'evidenza di problema, ma perche' e' l'unica fase recente che ha rotto il pattern "flag off finche' non verificato in canary", ed e' bene saperlo prima di scalare, non scoprirlo durante.

## 4. Criteri di uscita per P3 (gate esplicito prima di aprire P4)

A differenza delle fasi precedenti, qui il criterio di uscita e' numerico e va verificato su **almeno due run consecutivi puliti**, non uno solo (per escludere che "clean-final" sia stato favorevole per varianza, non per il fix):

1. `orders/create` e `orders/sync` p95 (non solo avg) sotto **500ms** come soglia intermedia realistica prima di tentare i 300ms finali (i 300ms restano il target di P0, ma forzarlo come gate di uscita da P3 rischia di produrre un altro ciclo di ottimizzazione locale senza guardare il quadro; 500ms come soglia intermedia permette di aprire P4 e vedere se la concorrenza aggiuntiva di 100 device cambia il quadro, prima di spremere ulteriormente P3).
2. Coda `order-lane` che non resta stabilmente sopra 15-20 sotto burst sostenuto (non zero — un burst temporaneo e' normale — ma deve tornare a scendere, non stazionare a 50-60 come nei run falliti).
3. Zero HTTP 500 per deadlock/lock wait su due run consecutivi.
4. **Causa dei retry transient residui identificata**, non solo assorbita: usare le nuove metriche `error.<cause>`/`rollback.cause.<cause>` (gia' introdotte in `ROLLBACK_CAUSES`) per determinare se i ~145 retry per run sono concentrati su un singolo stage (`commit`, `orderStationIndex`, `upsertChangedRows`) — se si', quello stage e' l'oggetto di un fix mirato finale prima di dichiarare P3 chiusa.
5. Equivalenza shadow (K0/I0/J0) ancora verde con L1+L2+L3 attive insieme sotto carico, non solo staticamente.

**Se dopo un fix mirato sullo stage dominante (punto 4) i numeri non migliorano significativamente**, il sospetto si sposta da "costo di esecuzione" a "contesa strutturale di lock a livello di riga MySQL" — in quel caso il prossimo intervento non e' un altro fastpath, ma rivedere se piu' sync puntuali della stessa mutazione ordine possono essere accorpati in una singola transazione (coalescing, gia' menzionato come possibile prossimo step in piu' di un documento P3).

**STOP/REVIEW — questo gate sostituisce "il prossimo step" implicito dei documenti P3 con una condizione esplicita e verificabile.**

---

## FASE P3 (continuazione) — Chiudere la contesa residua

### P3.13 — Breakdown per stage dei retry residui

**Obiettivo:** usare la classificazione gia' introdotta (`transientDbError`/`revisionConflict`/`duplicate`/
`unknown`, `error.<cause>`, `rollback.cause.<cause>`) per capire se i retry residui sono concentrati.

**Interventi**
- Rilanciare `load-50` (profilo gia' pronto da P0) leggendo esplicitamente le nuove metriche per stage.
- Se dominante e' `commit`: il sospetto e' lock a livello di riga MySQL condiviso tra piu' sync puntuali della
  stessa mutazione ordine — valutare ridurre il numero di statement nella stessa transazione o l'isolation level.
- Se dominante e' `orderStationIndex`: nonostante il fix change-aware (P3 precedente), potrebbe restare
  contesa quando piu' ordini della stessa postazione cambiano insieme — valutare batching multi-riga.
- Se dominante e' `upsertChangedRows`: possibile contesa sulla riga ordine stessa da CAS/revision (I3) sotto
  vero parallelismo L — atteso in una certa misura, ma va quantificato.

**DoD:** causa dominante identificata con percentuale, non solo "presente".

**STOP/REVIEW.**

### P3.14 — Fix mirato sullo stage dominante

**Obiettivo:** dipende dall'esito di P3.13 — non prescrivibile in anticipo, coerente con §0.

**DoD:** due run consecutivi che rispettano tutti e cinque i criteri di §4.

**STOP/REVIEW — chiude P3, sblocca P4.**

---

## FASE P4 — Scala virtuale load-100

**Obiettivo:** primo tentativo alla scala finale (100 palmari, 10 postazioni, 5 GUI), profilo gia' pronto da P0.

**Interventi**
- Eseguire con lo stesso rigore dimostrato in P3: se la coda order-lane (o qualunque altra lane) satura di
  nuovo, **interrompere manualmente** come gia' fatto, non lasciar correre per "vedere il numero finale".
- Applicare prima (non durante) il `PLAYBOOK_DOMAIN_WRITE_AUDIT.md` almeno sui domini a rischio piu' alto
  (tavoli, prenotazioni — sono quelli con la latenza peggiore osservata in P2 prima dei fix L).
- Aspettarsi, per continuita' con il pattern P3, che emerga un nuovo sotto-costo non ancora visibile a 50 —
  non e' un fallimento del lavoro fatto finora, e' la natura del carico crescente su un sistema con questa
  architettura.

**DoD:** tutte le soglie di accettazione P0 rispettate a 100 palmari su almeno due run consecutivi:
notifiche/comanda pronta p95 <500ms, radio busy <150ms, battery event p95 <500ms, order create p95 <300ms,
payment table p95 <200ms, doppi pagamenti 0, doppie emissioni fiscali 0, print/fiscal pending a drain 0.

**STOP/REVIEW.**

---

## FASE P5 — Endurance 90 minuti

**Obiettivo:** il profilo `endurance-90m-virtual` e' gia' pronto da P0 (50.000 azioni, 120 device mobili, 50
postazioni, 100 client radio) ma non ancora eseguito.

**Interventi**
- Eseguire l'endurance solo dopo P4 verde, non in parallelo — un sistema che non regge un run breve a 100 non
  ha senso testarlo per 90 minuti.
- Monitorare specificamente: crescita monotona di `.print-spool` (retention G2 ancora attiva sotto carico
  sostenuto?), crescita di `event_outbox` non pubblicati (drain worker tiene il passo?), memory leak lato
  Node, connessioni MySQL non rilasciate.

**DoD:** 90 minuti senza degrado progressivo delle metriche P4; retention/outbox/pool stabili a fine run.

**STOP/REVIEW.**

---

## FASE P6 — Chaos testing

**Obiettivo:** i test di caos gia' previsti dalla v4 (§Fase P originale) e da `ADR-0001`/`ROADMAP_ARCHITETTURA_v4.1.0.md`.

**Scenari**
- Backend lento (throttling artificiale) durante burst.
- Gateway fiscale virtuale offline durante pagamenti in corso — verificare che `PENDING_FISCAL` (K-PRE.4.2)
  si comporti correttamente sotto carico, non solo nel test unitario.
- Stampante offline/online a intermittenza durante burst comande.
- Riconnessione device (SSE/outbox) a meta' burst.
- **Doppio incasso/doppia emissione tentati deliberatamente in concorrenza reale** su tutti e tre gli endpoint
  pagamento, come test di accettazione finale — non piu' solo unitario (gia' raccomandato in v4 K7).

**DoD:** nessuno scenario produce doppio incasso, doppia emissione, o stato incoerente persistente; degrado
graceful (latenza aumenta, correttezza no).

**STOP/REVIEW.**

---

## FASE P7 — Go/No-Go finale

**Obiettivo:** decisione finale con evidenza salvata, come da v3/v4.

**Checklist**
- Tutte le soglie P0 rispettate a load-100 (P4) e in endurance (P5).
- Chaos (P6) verde su tutti gli scenari.
- Equivalenza shadow ancora verificata sui domini migrati (puo' essere spenta come default dopo, tenuta come
  canary a campione).
- `ADR-0002` (Fase O) aggiornato con i numeri finali reali, non piu' proiezioni.
- Decisione esplicita su quando ritirare l'app-state come fallback sui domini write-primary (I, J, K) —
  non necessariamente subito dopo il go, puo' restare un'ulteriore release come rete di sicurezza.

**STOP/REVIEW finale — chiude l'intero programma A→P.**

---

## 5. Osservazioni aggiuntive da verificare, non bloccanti per P3 ma prima di P4

### 5.1 — Le state machine N1-N3 sono default-on

A differenza di ogni singolo flag introdotto in K e L (rigorosamente default-off, canary, poi promozione),
`PAYMENT_STATE_MACHINE_ENABLED`, `ORDER_STATE_MACHINE_ENABLED`, `PRINT_STATE_MACHINE_ENABLED` sono descritti
come "default-on" nei rispettivi documenti N1/N2/N3. Non e' necessariamente un problema — sono proiezioni/
validazioni sopra la logica esistente, non nuovi effetti collaterali — ma e' una rottura del pattern seguito
ovunque altrove nel programma. **Prima di P4**, vale la pena una verifica esplicita e mirata (non un nuovo giro
di canary completo): un run breve con `PAYMENT_STATE_MACHINE_ENABLED=0` esplicito confrontato con il default,
per confermare che la differenza sia davvero nulla sul comportamento osservabile, cosi' la si', o l'eventuale
gap, e' nota prima di sommarsi alle variabili di P4 invece che dopo.

### 5.2 — `server.js` margine attuale

38.798 righe su budget 39.500 (~700 di margine). Nessuna azione richiesta ora, ma se P3.14/P4 richiedono
ulteriore codice (es. batching/coalescing delle sync puntuali), tenere d'occhio il margine con lo stesso
criterio di K-PRE.1 — estrarre prima di aggiungere se il margine scende sotto ~300 righe.

### 5.3 — `.print-spool` sotto il nuovo regime di concorrenza

La retention (G2) e' stata validata prima di L. Con L attiva e piu' throughput reale atteso in P4/P5, vale la
pena un controllo puntuale che la retention tenga il passo (e' gia' nella checklist P5, qui solo segnalato in
anticipo perche' e' un rischio noto, non nuovo).

---

## Appendice A — Sequenza e dipendenze

```
P3.13 (breakdown per stage) ─> P3.14 (fix mirato) ─> gate §4 (2 run puliti consecutivi)
                                                            │
                                          5.1 (verifica state machine off/on) ── non bloccante, in parallelo
                                                            │
                                                            └─> P4 (load-100)
                                                                 └─> P5 (endurance 90m)
                                                                      └─> P6 (chaos)
                                                                           └─> P7 (go/no-go)
```

## Appendice B — Rischi specifici residui

| Rischio | Impatto | Mitigazione |
|---|---:|---|
| Retry su deadlock diventa la soluzione permanente invece di un ponte | Alto (latenza non scende mai sotto soglia) | Gate §4 punto 4 obbligatorio: causa identificata, non solo assorbita |
| Seconda ondata write-amplification presente anche in tables/reservations/payments, scoperta solo a load-100 | Alto (stesso ciclo di P3 si ripete a scala peggiore) | `PLAYBOOK_DOMAIN_WRITE_AUDIT.md` eseguito su quei domini prima di P4 |
| State machine N default-on nasconde una differenza comportamentale non ancora notata | Medio | Verifica mirata §5.1 prima di P4 |
| Endurance rivela leak/crescita non visibili nei run brevi | Alto se non controllato | P5 monitorato esplicitamente su spool/outbox/pool, non solo sulle metriche P4 |
| Chaos rivela un varco nel confine fiscale sotto condizioni non testate finora (RT offline durante burst, non solo RT pending isolato) | Critico se presente | P6 include esplicitamente questo scenario come voce propria, non generico |

## Appendice C — Metriche/artefatti da portare da P3 a P4 senza perderli

```text
runtime-metrics: operations.runMsByLabel, appState.writeRunMsByLabel
appStateDomainSplit:*.entries.{total,commit,rollback,ensure,getPool,getConnection,stateRead,upsertChangedRows}
appStateDomainSplit:*.error.<cause>, rollback.cause.<cause>, outcome.{committed,rolledBack}
crossDomainConcurrencyFamiliesActive, crossDomainConcurrencyFamiliesActiveMax
ROOM_LANE_PRESSURE_PRIORITY_DEPTH, ORDER_SYNC_FAST_LANE_CONCURRENCY (gia' tuned in P3, non resettare per P4)
```

---

*Prossimo passo: P3.13 (breakdown per stage) e' quasi gratuito — le metriche esistono gia', serve solo
rilanciare load-50 e leggerle. In parallelo, consiglio di avviare il playbook (file separato) sui domini
tavoli/prenotazioni, cosi' quando si apre P4 non si riparte da zero sulla stessa classe di scoperta.*
