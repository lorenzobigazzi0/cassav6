# Annex A — Fuori perimetro della migrazione

Tre blocchi presenti nella REV1 escono dal programma di migrazione. Non sono
cancellati: sono progetti separati, con decisioni proprie e gate propri.

Il criterio e uno solo: **una migrazione sposta dati esistenti; non progetta
semantica di business nuova.** Dove il sorgente non contiene il dominio, non c'e
niente da migrare, c'e da costruire.

---

## A.1 — Dominio ricette e inventario (era P4b / MIG-045)

### Cosa resta nella migrazione

**Solo la preservazione lossless delle label**: gli `ingredients`/`ingredienti`
attuali sono `string[]` e vanno copiati in `catalog.product_ingredient_labels`
senza interpretazione. Questo e migrazione, resta in P4.

Regole invariate: nessuna quantita creata, nessuna giacenza creata, gli allergeni
non sono sinonimo di ingredienti.

### Cosa esce

Le tabelle `inventory.units / ingredients / recipes / recipe_versions /
recipe_components / product_recipe_links` restano nella DDL di riferimento come
target, ma **non vengono popolate ne usate** durante la migrazione.

### Perche

`REC-01` chiede di decidere: ricetta informativa o anche costo e scarico
magazzino, sotto-ricette, quantita per porzione o per batch, unit conversion,
resa e scarto. Sono cinque decisioni di prodotto che determinano un modello
diverso ciascuna. Prenderle mentre si cambia motore di persistenza significa che
un errore di modellazione e un errore di migrazione diventano indistinguibili.

### Come riprenderlo

Progetto autonomo, dopo il cutover, su PostgreSQL gia primario. A quel punto le
label preservate sono l'input per il popolamento assistito, e il costo di
sbagliare il modello e una migration in piu, non un cutover a rischio.

---

## A.2 — Motore promozioni automatiche (era P4c / MIG-046)

### Cosa resta nella migrazione

**Coupon, voucher e benefit** (`MIG-047`): `commercialBenefitCampaigns`,
`Coupons`, `Applications`, `Redemptions` esistono nel sorgente, hanno dati reali,
e vanno migrati con i vincoli anti doppia redemption **nello schema**. Questo e
migrazione, resta in perimetro (ora P4b).

### Cosa esce

`commerce.promotions / promotion_conditions / promotion_actions / promotion_scopes
/ promotion_usage`. Restano nella DDL di riferimento, non vengono popolate.

### Perche

Il doc 01 lo dice esplicitamente: nel sorgente **non emerge un motore generico di
promozioni automatiche**. `PRO-01` chiede di decidere stacking (cumulabili o
best-discount), priorita, exclusivity group, ordine di applicazione rispetto a
coupon e override manuali, condizioni, usage limit e customer identity.

Sono le regole che determinano quanto paga il cliente. Vanno progettate con test
scritti prima, contro casi reali, non dentro una fase di migrazione.

La separazione concettuale della REV1 (offerta vendibile != listino != promozione
automatica != coupon riscattabile) e corretta e va **mantenuta come vincolo di
design** per quando il progetto partira. Il rischio che quella separazione previene
e reale: unificare tutto in "una cosa che applica uno sconto" e l'errore che poi
non si corregge.

### Come riprenderlo

Progetto autonomo, dopo il cutover. Prerequisito: `PRO-01` chiusa per iscritto con
esempi numerici, non con principi.

---

## A.3 — Redis (era P1/P9 / MIG-013, MIG-090..093)

### Cosa resta nella migrazione

Niente. Vedi `06_REALTIME_E_CACHE.md` per la soluzione adottata al posto di Redis.

### Perche

Il profilo standard e monoprocesso: `BACKEND_API_WORKER_ENABLED=0`,
`BACKEND_REALTIME_GATEWAY_ENABLED=0`. Redis risolve cache condivisa, pub/sub e
presence **fra processi**. Con un processo solo:

- la cache condivisa e una `Map` in memoria;
- il pub/sub fra processi non serve;
- la presence e gia in memoria e gia si ricostruisce;
- il rate limit distribuito non ha niente da distribuire.

Il doc 06 della REV1 dichiarava che il design deve sopravvivere a `FLUSHALL` senza
perdita business. E l'argomento definitivo: un componente che per costruzione non
puo contenere niente di indispensabile, su un deployment che non ha il problema
che quel componente risolve, aggiunge solo superficie. Nello specifico: un daemon
sul Raspberry, memoria sottratta a PostgreSQL, ACL/TLS da configurare e testare, un
client da sostituire (oggi c'e un RESP custom), reconnect/backoff da validare, e
quattro task di programma.

### Quando riprenderlo

Quando esiste davvero un secondo processo. Il trigger e uno di questi:

- `BACKEND_API_WORKER_ENABLED=1` in produzione;
- `BACKEND_REALTIME_GATEWAY_ENABLED=1` in produzione;
- piu di un'istanza Node su host diversi.

A quel punto il design del doc 06 REV1 e ancora valido e va ripreso quasi
integralmente: namespace delle chiavi, TTL, versioned cache keys, failover policy
e il divieto di mettere in Redis ordini, pagamenti, saldi coupon, fiscale, audit,
idempotenza e job durabili. Quel documento e conservato come
`ANNEX_B_REDIS_DESIGN_DIFFERITO.md`.

### Cosa NON fare nel frattempo

Non introdurre Redis "solo per la cache del catalogo" durante la migrazione. E il
modo in cui diventa una dipendenza permanente senza mai passare un gate.
