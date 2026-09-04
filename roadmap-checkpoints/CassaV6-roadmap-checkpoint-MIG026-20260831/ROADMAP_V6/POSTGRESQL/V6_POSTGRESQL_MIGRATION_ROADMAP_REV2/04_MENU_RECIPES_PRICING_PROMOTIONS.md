# 04 — Menu, pricing, offerte, coupon (REV2)

> **Cambio di perimetro rispetto alla REV1.** Restano in migrazione: product
> master, cataloghi, listini, offers/combo, coupon/voucher/benefit, e la
> preservazione lossless delle ingredient labels. Escono: il dominio ricette
> strutturato e il motore promozioni automatiche, che sono progetti separati
> (`ANNEX_A_FUORI_PERIMETRO.md`). Le sezioni 5 e 6 sono conservate come
> specifica di quei progetti, non come lavoro di questa roadmap.
>
> Prima di iniziare questa fase va chiusa `SEQ-01` (`16_PROGRAM_SEQUENCING.md`):
> Commerciale V2 e questa migrazione non possono correre in parallelo.

Questa area deve essere trattata come un bounded context critico perché determina il prezzo che poi entra in ordine e pagamento.

## 1. Product master unico

Oggi coesistono `menuItems` legacy e `commercial_products` V2. Il target deve avere **una sola identità canonica del prodotto**. Conservare:

- nome/descrizione;
- SKU/barcode;
- enabled/availability;
- aliquota/codice IVA;
- immagine;
- unità;
- reparto;
- workstation/station routing;
- tags;
- allergens;
- variants e delta;
- ingredient labels legacy.

Gli ordini non devono referenziare il catalogo “live” per ricostruire il prezzo storico: salvano snapshot.

## 2. Menu/cataloghi

Preservare il modello V2:

`catalog -> categories -> groups -> entries -> sellable(product|offer)`.

Gli assignment devono mantenere scope e precedenza:

`global < channel < activity < room < workstation < role < user_group < user`.

Le finestre overnight e i weekdays devono avere golden tests.

## 3. Listini

Mantenere:

- listino base;
- inheritance/overlay;
- entry per product/offer/variant/offer_option;
- availability;
- schedule;
- assignment per contesto;
- currency;
- published version.

Non calcolare prezzi dal frontend: il backend risolve il prezzo autorevole e restituisce `pricing_trace`/snapshot auditabile.

## 4. Offers / combo

Le offers sono sellable compositi e non sono la stessa cosa delle promozioni. Preservare:

- `fixed`;
- `sum_components`;
- included items;
- choice groups con min/max/included selections;
- repeat policy;
- options con product e supplement;
- tax allocation strategy.

## 5. Ricette — FUORI PERIMETRO (specifica per progetto separato)

> In migrazione si esegue **soltanto** la "Migrazione lossless" sotto. Il
> "Modello nuovo" e target documentato, non lavoro di questa roadmap. Vedi
> `ANNEX_A_FUORI_PERIMETRO.md` A.1 e la decisione `REC-01`.


### Stato sorgente

Il codice gestisce `ingredients` come testo. Non è stata trovata una distinta base strutturata.

### Migrazione lossless

Per ogni prodotto attuale:

1. copiare `ingredients[]` in `catalog.product_ingredient_labels`;
2. non creare automaticamente quantità;
3. non creare giacenze;
4. non usare allergeni come sinonimo di ingredienti.

### Modello nuovo

- `inventory.units`;
- `inventory.ingredients`;
- `inventory.recipes`;
- `inventory.recipe_versions`;
- `inventory.recipe_components`;
- `inventory.product_recipe_links`.

Un component può referenziare un ingrediente o, se deciso, una sotto-ricetta. Quantità e unità sono obbligatorie solo quando l'utente struttura realmente la ricetta.

Questo modello prepara un futuro magazzino/cost accounting senza obbligare la V6 a inventare stock inesistente.

## 6. Promozioni automatiche — FUORI PERIMETRO (specifica per progetto separato)

> Non esiste nel sorgente e non c'e niente da migrare. La sezione resta come
> vincolo di design per il progetto futuro: in particolare la separazione fra
> offerta vendibile, listino, promozione automatica e coupon riscattabile va
> mantenuta. Vedi `ANNEX_A_FUORI_PERIMETRO.md` A.2 e la decisione `PRO-01`.


Il sorgente ha Commercial Benefits, ma non emerge un motore generico completo equivalente a tutte le promozioni automatiche. Il target deve rendere esplicite le regole se la UI le prevede:

- condizioni: articoli/categorie/importo/covers/orario/giorno/canale/sala/utente;
- azioni: percentuale, fisso, prezzo target, buy-X-get-Y, item gratuito;
- scope e schedule;
- priorità;
- cumulabilità/exclusivity group;
- max usage globale/per cliente/per sessione;
- audit/versioning.

**Decisione obbligatoria prima dell'implementazione:** definire la semantica di stacking quando più promozioni sono valide.

## 7. Coupon/voucher/benefit — IN PERIMETRO (fase P4b)

> Questo dominio esiste nel sorgente con dati reali e va migrato. E l'unica parte
> commerciale "promozionale" dentro il perimetro.


Preservare separatamente:

- fixed discount;
- percentage discount;
- value voucher;
- residual policy (`forfeit_remaining`, `keep_balance`, `no_partial_use`);
- code/QR/NFC acquisition;
- validità;
- max usage/unlimited;
- reserved/released/redeemed/expired.

La redemption deve avvenire in transazione con row lock e **constraint di schema**:
`CHECK(remaining_cents >= 0)`, `CHECK(remaining_cents <= face_value_cents)` e
l'indice unico parziale `benefit_application_active_unique` che ammette al piu una
prenotazione attiva per coupon. Il gate "doppia redemption impossibile" non puo
dipendere solo dal codice applicativo: se dipende dal codice, un percorso
dimenticato lo aggira.

## 8. Pubblicazione commerciale

Mantenere draft/published/archive. Suggerimento: prodotti possono avere identity stabile; catalog/listino/offers/promotions hanno `config_version_id` o una published revision. Il passaggio di versione pubblicata deve essere atomico e la cache deve usare chiavi versionate, ad esempio:

`commerce:compiled:{publishedVersionId}`

La cache e in-process (vedi `06_REALTIME_E_CACHE.md`). Il versionamento serve
proprio a evitare l'invalidazione coordinata, che e il problema che Redis
risolverebbe e che a questa scala non si presenta.
